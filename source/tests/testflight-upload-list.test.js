const test = require("node:test");
const assert = require("node:assert/strict");
const { mount } = require("../src/testflight-ui");
const { createTestFlightService } = require("../src/testflight-service");
const fixtures = require("./fixtures/testflight-har.json");

const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const page = (build, next = "") => ({ items: [{ id: `upload-${build}`, buildId: `build-${build}`, cfBundleVersion: build, cfBundleShortVersionString: "1.0.0", state: { state: "COMPLETE" }, uploadedDate: "2026-10-06T02:11:58Z" }], next });

// Exercise the mounted renderer and its event handlers, without Electron or any
// Apple writes. Only the DOM surface used by these list interactions is needed.
function screen(uploads) {
  const calls = [], events = {};
  const main = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML: (_, html) => { main.innerHTML = html + main.innerHTML; } };
  const side = {};
  const root = { isConnected: true, querySelector: selector => selector === ".tf-main" ? main : side, contains: () => true, addEventListener: (event, handler) => { events[event] = handler; } };
  mount({ root, app: { id: "dynamic-app" }, versions: [{ platform: "IOS" }, { platform: "MAC_OS" }], api: async payload => {
    calls.push(payload);
    let data;
    if (payload.action === "overview") data = { versions: { items: [], next: "" }, groups: [] };
    else if (payload.action === "uploads") data = await uploads(payload);
    else if (payload.action === "feedback") data = { items: [], next: "" };
    else throw new Error(`Unexpected request: ${payload.action}`);
    return { success: true, data, contextToken: "test-account" };
  } });
  return { calls, main, refresh: () => root.tfRefresh(), click: async (action, extra = {}) => {
    const button = { dataset: { tfAction: action, ...extra }, closest: () => null };
    await events.click({ target: { closest: () => button } });
    await flush();
  } };
}

test("展开上传记录后刷新及再次点击 iOS 都重新请求，列表不会停在加载中", async () => {
  let count = 0;
  const ui = screen(async () => page(String(++count)));
  await flush();
  await ui.click("toggle-uploads");
  assert.match(ui.main.innerHTML, /1\.0\.0 \(1\)<\/span><\/button>/);
  await ui.refresh(); await flush();
  assert.match(ui.main.innerHTML, /1\.0\.0 \(2\)<\/span><\/button>/);
  await ui.click("platform", { platform: "IOS" });
  assert.match(ui.main.innerHTML, /1\.0\.0 \(3\)<\/span><\/button>/);
  assert.doesNotMatch(ui.main.innerHTML, /tf-loading/);
  assert.equal(ui.calls.filter(row => row.action === "uploads").length, 3);
});

test("请求中反复折叠展开不会重复请求，完成后显示真实记录", async () => {
  const pending = deferred(), ui = screen(() => pending.promise);
  await flush(); await ui.click("toggle-uploads");
  await ui.click("toggle-uploads"); await ui.click("toggle-uploads");
  assert.equal(ui.calls.filter(row => row.action === "uploads").length, 1);
  pending.resolve(page("103")); await flush();
  assert.match(ui.main.innerHTML, /1\.0\.0 \(103\)<\/span><\/button>/);
});

test("刷新和平台切换后迟到的旧响应不能覆盖新列表", async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const ui = screen(() => ++count === 1 ? first.promise : count === 2 ? second.promise : Promise.resolve(page("mac-build")));
  await flush(); await ui.click("toggle-uploads");
  await ui.refresh(); await flush();
  second.resolve(page("new-build")); await flush();
  await ui.click("platform", { platform: "MAC_OS" });
  first.resolve(page("stale-build")); await flush();
  assert.match(ui.main.innerHTML, /1\.0\.0 \(mac-build\)<\/span><\/button>/);
  assert.doesNotMatch(ui.main.innerHTML, /stale-build|new-build|tf-loading/);
  assert.equal(ui.calls.filter(row => row.action === "uploads").at(-1).platform, "MAC_OS");
});

test("上传列表失败显示原错误并可独立重试，空响应显示空列表", async () => {
  let count = 0;
  const ui = screen(async () => { if (++count === 1) throw new Error("Apple 403: permission denied"); return { items: [], next: "" }; });
  await flush(); await ui.click("toggle-uploads");
  assert.match(ui.main.innerHTML, /Apple 403: permission denied/);
  assert.doesNotMatch(ui.main.innerHTML, /tf-loading/);
  await ui.click("retry-uploads");
  assert.match(ui.main.innerHTML, /暂无构建版本上传记录/);
  assert.equal(ui.calls.filter(row => row.action === "overview").length, 1);
});

test("读取超时退出转圈，重试后迟到响应也不能覆盖新数据", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred(); let count = 0;
  const ui = screen(() => ++count === 1 ? pending.promise : Promise.resolve(page("fresh")));
  await flush(); await ui.click("toggle-uploads");
  t.mock.timers.tick(45001); await flush();
  assert.match(ui.main.innerHTML, /读取 Apple 数据超时/);
  assert.doesNotMatch(ui.main.innerHTML, /tf-loading/);
  await ui.click("retry-uploads");
  pending.resolve(page("too-late")); await flush();
  assert.match(ui.main.innerHTML, /1\.0\.0 \(fresh\)<\/span><\/button>/);
  assert.doesNotMatch(ui.main.innerHTML, /too-late/);
});

test("分页失败保留已加载记录，重试沿用 Apple next 且重叠记录不重复", async () => {
  let count = 0;
  const ui = screen(async payload => {
    if (++count === 1) return page("103", "apple-next-url");
    assert.equal(payload.next, "apple-next-url");
    if (count === 2) throw new Error("Apple 500");
    return { items: [...page("103").items, ...page("101").items], next: "" };
  });
  await flush(); await ui.click("toggle-uploads"); await ui.click("more-uploads");
  assert.match(ui.main.innerHTML, /1\.0\.0 \(103\)<\/span><\/button>/);
  assert.match(ui.main.innerHTML, /Apple 500/);
  await ui.click("retry-uploads");
  assert.equal(ui.main.innerHTML.match(/1\.0\.0 \(103\)<\/span><\/button>/g).length, 1);
  assert.match(ui.main.innerHTML, /1\.0\.0 \(101\)<\/span><\/button>/);
});

test("在其他页刷新后回到构建列表，已展开上传区域也会重新读取", async () => {
  let count = 0;
  const ui = screen(async () => page(String(++count)));
  await flush(); await ui.click("toggle-uploads");
  await ui.click("nav", { view: "screenshot" }); await ui.refresh();
  await ui.click("back-builds");
  assert.match(ui.main.innerHTML, /1\.0\.0 \(2\)<\/span><\/button>/);
  assert.doesNotMatch(ui.main.innerHTML, /tf-loading/);
});

test("未实现的分析和其他入口明确显示正在开发", async () => {
  const ui = screen(async () => page("103")); await flush();
  await ui.click("analytics"); assert.match(ui.main.innerHTML, /分析功能正在开发/);
  await ui.click("unimplemented"); assert.match(ui.main.innerHTML, /该功能正在开发/);
});

for (const [account, fixture] of Object.entries(fixtures)) test(`${account} 上传列表保留 HAR 的全部参数和真实字段`, async () => {
  let captured;
  const service = createTestFlightService(async path => { captured = new URL(path, "https://appstoreconnect.apple.com"); return { body: fixture.buildUploads }; });
  const data = await service.run("uploads", { appId: `app-${account}`, platform: "MAC_OS" });
  assert.equal(captured.pathname, `/iris/v1/apps/app-${account}/buildUploads`);
  assert.deepEqual(Object.fromEntries(captured.searchParams), { include: "build", "fields[builds]": "", "filter[platform]": "MAC_OS", "filter[state]": "PROCESSING,FAILED,COMPLETE", sort: "-uploadedDate", limit: "10" });
  assert.equal(data.items.length, fixture.buildUploads.data.length);
  for (const [index, row] of fixture.buildUploads.data.entries()) {
    for (const [key, value] of Object.entries(row.attributes)) assert.deepEqual(data.items[index][key], value);
  }
  const next = new URL(captured); next.searchParams.set("cursor", "next-cursor"); next.searchParams.set("filter[state]", "COMPLETE,FAILED,PROCESSING");
  await service.run("uploads", { appId: `app-${account}`, platform: "MAC_OS", next: next.href });
  assert.equal(captured.searchParams.get("cursor"), "next-cursor");
});

test("损坏的上传列表响应不能被伪装成空记录或成功", async () => {
  const service = createTestFlightService(async () => ({ body: { data: null } }));
  await assert.rejects(service.run("uploads", { appId: "app" }), /未返回有效的上传记录列表/);
});

test("状态筛选和日期排序传递到苹果接口，分页不能偷偷切换筛选条件", async () => {
  let captured;
  const service = createTestFlightService(async path => { captured = new URL(path, "https://appstoreconnect.apple.com"); return { body: { data: [] } }; });
  const query = { appId: "app-a", states: ["FAILED", "PROCESSING"], sort: "uploadedDate" };
  await service.run("uploads", query);
  assert.equal(captured.searchParams.get("filter[state]"), "FAILED,PROCESSING");
  assert.equal(captured.searchParams.get("sort"), "uploadedDate");
  const next = new URL(captured); next.searchParams.set("cursor", "next");
  await service.run("uploads", { ...query, next: next.href });
  next.searchParams.set("filter[state]", "COMPLETE");
  await assert.rejects(service.run("uploads", { ...query, next: next.href }), /分页参数/);
  await assert.rejects(service.run("uploads", { appId: "app-a", states: [] }), /有效的上传状态/);
  await assert.rejects(service.run("uploads", { appId: "app-a", states: ["UNKNOWN"] }), /有效的上传状态/);
  await assert.rejects(service.run("uploads", { appId: "app-a", sort: "createdDate" }), /排序无效/);
});

test("点击创建日期切换真实请求排序并从第一页重新读取", async () => {
  const ui = screen(async () => page("103", "next-page"));
  await flush(); await ui.click("toggle-uploads"); await ui.click("sort-uploads");
  let requests = ui.calls.filter(row => row.action === "uploads");
  assert.equal(requests.at(-1).sort, "uploadedDate");
  assert.equal(requests.at(-1).next, "");
  assert.match(ui.main.innerHTML, /aria-sort="ascending"/);
  await ui.click("sort-uploads");
  requests = ui.calls.filter(row => row.action === "uploads");
  assert.equal(requests.at(-1).sort, "-uploadedDate");
  assert.match(ui.main.innerHTML, /aria-sort="descending"/);
});


test("未知侧栏入口显示开发中占位，不发请求、不遗留加载动画", async () => {
  const ui = screen(async () => page("103")); await flush();
  const before = ui.calls.length;
  await ui.click("nav", { view: "future-feature" });
  assert.match(ui.main.innerHTML, /正在开发/);
  assert.doesNotMatch(ui.main.innerHTML, /tf-loading/);
  assert.equal(ui.calls.length, before);
});

test("上传记录每页十条，查看更多逐页追加到二十条及最后一页", async () => {
  const pages = [10, 10, 3]; let index = 0;
  const ui = screen(async payload => {
    assert.equal(payload.next, index ? `apple-cursor-${index}` : "");
    const offset = index * 10, length = pages[index++];
    return { items: Array.from({ length }, (_, n) => page(String(offset + n)).items[0]), next: index < 3 ? `apple-cursor-${index}` : "" };
  });
  await flush(); await ui.click("toggle-uploads");
  assert.equal((ui.main.innerHTML.match(/data-tf-action="build"/g) || []).length, 10);
  assert.match(ui.main.innerHTML, /查看更多/);
  await ui.click("more-uploads");
  assert.equal((ui.main.innerHTML.match(/data-tf-action="build"/g) || []).length, 20);
  await ui.click("more-uploads");
  assert.equal((ui.main.innerHTML.match(/data-tf-action="build"/g) || []).length, 23);
  assert.doesNotMatch(ui.main.innerHTML, /查看更多/);
});
