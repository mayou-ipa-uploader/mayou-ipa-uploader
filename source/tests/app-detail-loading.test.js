const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/certificate-manager.js'), 'utf8');
function load(source, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map(name => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, name);
    const end = source.slice(start + 1).search(/\n(?:async )?function /);
    return source.slice(start, end < 0 ? source.length : start + 1 + end);
  }).join('\n'), context);
  return context;
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);
function backend(fetchOverride) {
  const calls = [];
  const version = { id: 'real-version', platform: 'IOS', versionString: '2.0', state: 'WAITING_FOR_REVIEW' };
  const row = { id: 'real-app', relationships: { displayableVersions: { data: [{ id: version.id }] } } };
  const jsonApiRows = body => Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
  const context = {
    APP_STORE_CONNECT_GLOBAL_CACHE_MS: 1000,
    appStoreConnectFetch: async url => {
      calls.push(url);
      const overridden = fetchOverride?.(url); if (overridden) return overridden;
      if (url.startsWith('/iris/v1/apps/real-app?')) return { body: { data: row, included: [{ type: 'appStoreVersions', ...version }] } };
      if (url.startsWith('/iris/v1/appStoreVersions/')) return { body: { data: version } };
      if (url.startsWith('/iris/v1/appStoreVersionLocalizations?')) return { body: { data: [{ id: 'locale', description: 'Actual Apple description' }] } };
      return { body: { data: [] } };
    },
    normalizeAppStoreApps: () => [{ id: 'real-app' }], normalizeAppIcpNumberDetail: () => ({}),
    relationshipData: (row, key) => row?.relationships?.[key]?.data || [],
    findIncluded: (body, type, id) => body.included?.find(row => row.type === type && row.id === id),
    jsonApiRows, jsonApiIncluded: body => body.included || [],
    sortAppStoreVersions: rows => rows, normalizeAppStoreVersion: row => row,
    normalizeAppBundle: row => row, normalizeVersionLocalization: row => row,
    normalizeAppInfo: row => row, normalizeAppCategory: row => row, normalizeBuild: row => row,
    normalizeScreenshotSet: row => row, normalizePreviewSet: row => row,
    normalizeReviewDetail: row => row, normalizeReviewSubmissions: () => [],
    appStoreConnectCachedValue: (_key, _ttl, loader) => loader(),
    loadAppStoreConnectL10nMap: async () => ({}),
    loadAppStoreConnectVersionHistory: async () => ({ history: [{ version: { id: 'older', platform: 'IOS', versionString: '1.0', state: 'READY_FOR_SALE' } }] }),
    loadAppStoreConnectPrivacyDetail: async () => { calls.push('privacy'); return {}; },
    loadAppStoreConnectPricingDetail: async () => { calls.push('pricing'); return {}; },
    loadAppStoreConnectAvailabilityDetail: async () => { calls.push('availability'); return {}; },
    loadAppStoreConnectPricingPageSettings: async () => { calls.push('pricingSettings'); return {}; },
    loadAppStoreConnectIAPSubmissionStatus: async () => ({}),
    loadAppStoreVersionReviewWarning: async () => null,
  };
  return { context: load(main, ['appStoreAppInfoIsEditable', 'selectAppStoreAppInfo', 'loadAppStoreConnectAppDetail'], context), calls };
}

test('首屏完成所需版本、截图、审核及历史数据，不请求未打开页面的定价和隐私', async () => {
  const { context, calls } = backend();
  const detail = await context.loadAppStoreConnectAppDetail('real-app', '', { mode: 'release' });
  assert.equal(detail.selectedVersion.state, 'WAITING_FOR_REVIEW');
  assert.equal(detail.localizations[0].description, 'Actual Apple description');
  assert.equal(detail.history[0].version.versionString, '1.0');
  assert.equal(detail.mediaLoading, false);
  assert.equal(detail.partial, true);
  assert.ok(detail.loadedPanes.includes('release'));
  assert.ok(calls.some(url => url.includes('appScreenshotSets?')));
  assert.ok(calls.some(url => url.includes('reviewSubmissions?')));
  assert.ok(!calls.some(url => ['privacy', 'pricing', 'availability', 'pricingSettings'].includes(url)));
});

test('完整详情的独立读取并行启动，无须等版本接口后才读取销售数据', async () => {
  const wait = deferred();
  const { context, calls } = backend(url => url.startsWith('/iris/v1/appStoreVersions/') ? wait.promise : null);
  const pending = context.loadAppStoreConnectAppDetail('real-app');
  await flush();
  assert.ok(calls.includes('pricing'));
  assert.ok(calls.includes('availability'));
  assert.ok(calls.includes('privacy'));
  wait.resolve({ body: { data: { id: 'real-version' } } });
  assert.equal((await pending).partial, false);
});

test('版本必需接口失败时返回错误，避免把未读到的内容当作空字段', async () => {
  const { context } = backend(url => url.startsWith('/iris/v1/appStoreVersionLocalizations?') ? Promise.reject(new Error('Apple unavailable')) : null);
  await assert.rejects(context.loadAppStoreConnectAppDetail('real-app', '', { mode: 'release' }), /Apple unavailable/);
});

function frontend(api) {
  const calls = [], renders = [], content = { innerHTML: '' };
  const context = {
    APP_STORE_DETAIL_CACHE_TTL_MS: 300000, appStoreDetailCache: new Map(), appStoreDetailPending: new Map(),
    appStoreDetailRequestSeq: 0, currentAppStoreApp: { id: 'app-a' }, currentAppStoreDetail: null,
    currentReviewSubmissionDetail: null, currentReviewSubmissionLoadingId: '',
    el: () => content, escapeHTML: text => text,
    updateAppStoreDetailLoadingStatus: () => {}, closeAppStoreDetailLoading: () => { context.closed++; }, closed: 0,
    autoSyncReviewGuidanceForApp: () => {}, renderAppStoreDetailLoadingVersion: () => {},
    applyLoadedAppStoreDetail: (_app, detail, pane) => { renders.push({ detail, pane }); context.currentAppStoreDetail = detail; },
    window: { appleDeveloper: { appStoreAppDetail: async payload => { calls.push(payload); return api(payload); } } },
  };
  load(renderer, ['appStoreDetailCacheKey', 'appStoreDetailPendingKey', 'getCachedAppStoreDetail', 'cacheAppStoreDetail', 'fetchAppStoreDetail', 'loadAppStoreDetail'], context);
  return { context, calls, renders };
}
const released = { app: { id: 'app-a' }, selectedVersion: { id: 'v1' }, partial: true, loadedPanes: ['release'], mediaLoading: false };

test('首次进入只请求版本页；不再发起第二次完整读取或后台覆盖', async () => {
  const { context, calls, renders } = frontend(async () => ({ success: true, detail: released }));
  await context.loadAppStoreDetail({ id: 'app-a' }, 'release', '', { initial: true });
  await flush();
  assert.deepEqual(calls.map(row => row.mode), ['release']);
  assert.equal(context.closed, 1);
  assert.equal(renders.length, 1);
  await context.loadAppStoreDetail({ id: 'app-a' });
  assert.equal(calls.length, 1, 'cached release page');
});

test('版本页缓存不能冒充完整资料；进入其他页面才获取完整数据', async () => {
  const { context, calls } = frontend(async payload => ({ success: true, detail: payload.mode === 'release' ? released : { ...released, partial: false } }));
  await context.loadAppStoreDetail({ id: 'app-a' });
  await context.loadAppStoreDetail({ id: 'app-a' }, 'pricing');
  assert.deepEqual(calls.map(row => row.mode), ['release', 'full']);
  assert.equal(context.currentAppStoreDetail.partial, false);
});

test('导航或账户变化后迟到的详情响应不能覆盖当前页面', async () => {
  for (const switchAccount of [false, true]) {
    const wait = deferred(); const { context, renders } = frontend(() => wait.promise);
    const pending = context.loadAppStoreDetail({ id: 'app-a' });
    context.appStoreDetailRequestSeq++;
    if (switchAccount) context.currentAppStoreApp = { id: 'app-b' };
    wait.resolve({ success: true, detail: released }); await pending;
    assert.equal(renders.length, 0);
    assert.equal(context.appStoreDetailCache.size, 0);
  }
});

test('同一页面的并发读取复用同一请求', async () => {
  const wait = deferred(); const { context, calls } = frontend(() => wait.promise);
  const a = context.fetchAppStoreDetail({ id: 'app-a' }, '', false, { mode: 'release' });
  const b = context.fetchAppStoreDetail({ id: 'app-a' }, '', false, { mode: 'release' });
  wait.resolve({ success: true, detail: released }); await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(context.appStoreDetailPending.size, 0);
});
