const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
function load(source, name, context) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  vm.runInNewContext(source.slice(start, start + 1 + next), context);
}
function setup(fetch) {
  const c = { appStoreConnectFetch: fetch,
    jsonApiRows: b => Array.isArray(b.data) ? b.data : [b.data],
    relationshipData: (row, key) => row.relationships?.[key]?.data ? [row.relationships[key].data] : [],
    findIncluded: (b, type, id) => b.included?.find(x => x.type === type && x.id === id),
  };
  load(main, 'enrichReviewSubmissionVersionBuilds', c); return c;
}
test('submission build comes from its own version relationship, with one read per distinct version', async () => {
  const calls = [];
  const c = setup(async url => {
    calls.push(url);
    const id = url.includes('/old?') ? 'old' : 'current';
    return { body: { data: { id, relationships: { build: { data: { type: 'builds', id: `build-${id}` } } } }, included: [{ type: 'builds', id: `build-${id}`, attributes: { version: id === 'old' ? '1011' : '1012' } }] } };
  });
  const input = [{ version: { id: 'old', versionString: '1.0.1' } }, { version: { id: 'current', versionString: '1.0.1' } }, { version: { id: 'current', versionString: '1.0.1' } }, { type: 'inAppPurchaseVersion' }];
  const rows = await c.enrichReviewSubmissionVersionBuilds(input);
  assert.equal(rows[0].version.buildVersion, '1011');
  assert.equal(rows[1].version.buildVersion, '1012');
  assert.equal(rows[2].version.buildVersion, '1012');
  assert.equal(calls.length, 2);
  assert.equal(input[0].version.buildVersion, undefined);
  assert.equal(rows[3], input[3]);
});
test('a failed or mismatched version read does not borrow a different build number', async () => {
  for (const fetch of [async () => { throw new Error('offline'); }, async () => ({ body: { data: { id: 'foreign' } } })]) {
    const rows = await setup(fetch).enrichReviewSubmissionVersionBuilds([{ version: { id: 'current' } }]);
    assert.equal(rows[0].version.buildVersion, undefined);
    assert.equal(rows[0].version.buildVersionError, '构建号暂不可用');
  }
});
