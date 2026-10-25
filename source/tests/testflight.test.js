const test = require("node:test");
const assert = require("node:assert/strict");
const { createTestFlightService, normalizeBuild, pagePath } = require("../src/testflight-service");
const { buildStatus, shell } = require("../src/testflight-ui");
const { isUpdateVersion } = require("../src/app-version-rules");
const fixture = require("./fixtures/testflight-har.json");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("首次上架不以版本号或 TestFlight 构建数量判断更新", () => {
  const selectedVersion = { id: "first", platform: "IOS", versionString: "8.6.2", state: "WAITING_FOR_REVIEW" };
  assert.equal(isUpdateVersion({ selectedVersion, versions: [selectedVersion], builds: fixture.initial.builds.data, history: [{ version: selectedVersion, changes: [{ state: "REJECTED" }] }] }), false);
  assert.equal(isUpdateVersion({ selectedVersion, versions: [selectedVersion, { id: "mac", platform: "MAC_OS", versionString: "1.0", state: "READY_FOR_SALE" }] }), false);
});
test("同平台存在更早正式发布的版本时显示更新内容", () => {
  const selectedVersion = { id: "next", platform: "IOS", versionString: "1.0.3" };
  assert.equal(isUpdateVersion({ selectedVersion, versions: [{ id: "old", platform: "IOS", versionString: "1.0.2", state: "READY_FOR_SALE" }] }), true);
  assert.equal(isUpdateVersion({ selectedVersion, history: [{ version: { id: "old", platform: "IOS", versionString: "1.0.2", state: "OTHER" }, changes: [{ state: "READY_FOR_SALE" }] }] }), true);
  assert.equal(isUpdateVersion({ selectedVersion, versions: [{ id: "future", platform: "IOS", versionString: "1.0.10", state: "READY_FOR_SALE" }] }), false);
  assert.equal(isUpdateVersion({ selectedVersion, versions: [{ id: "rejected", platform: "IOS", versionString: "1.0.1", state: "REJECTED" }] }), false);
});
test("首次上架保存 payload 完全省略 whatsNew，更新时包含用户输入", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const start = source.indexOf("function appStoreVersionPayload(");
  const end = source.indexOf("\nfunction ", start + 1);
  const detail = { selectedVersion: { id: "new", platform: "IOS", versionString: "4.0" }, localizations: [], versions: [] };
  const context = { currentAppStoreDetail: detail, currentAppStoreApp: { id: "app" }, activeAppStoreLocalization: () => ({}), appStoreFieldValue: (key, fallback) => key === "localization.whatsNew" ? "本次改进" : fallback, findAppCategory: () => null, parseAppStoreJSONField: () => null, window: { AppVersionRules: { isUpdateVersion } } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  assert.equal(Object.hasOwn(context.appStoreVersionPayload().localization, "whatsNew"), false);
  detail.versions.push({ id: "old", platform: "IOS", versionString: "3.0", state: "READY_FOR_SALE" });
  assert.equal(context.appStoreVersionPayload().localization.whatsNew, "本次改进");
});
for (const [name, data] of Object.entries(fixture)) {
  test(`使用 ${name} 账户真实抓包解析动态版本、构建和上传状态`, async () => {
    const requests = [];
    const service = createTestFlightService(async requestPath => {
      requests.push(new URL(requestPath, "https://appstoreconnect.apple.com"));
      const resource = requestPath.split("?")[0].split("/").at(-1);
      return { body: resource === "betaGroups" ? { data: [] } : data[resource] };
    });
    const appId = name === "initial" ? "6816638042" : "6813386708";
    const overview = await service.run("overview", { appId });
    const version = overview.versions.items[0];
    assert.equal(version.id, data.preReleaseVersions.data[0].id);
    const builds = await service.run("builds", { appId, versionId: version.id });
    assert.equal(builds.items[0].version, data.builds.data[0].attributes.version);
    assert.equal(builds.items[0].preReleaseVersion.id, version.id);
    assert.equal(requests.find(url => url.pathname.endsWith("/builds")).searchParams.get("filter[preReleaseVersion]"), version.id);
    assert.ok(requests.filter(url => url.searchParams.has("filter[app]")).every(url => url.searchParams.get("filter[app]") === appId));
    const uploads = await service.run("uploads", { appId });
    assert.equal(uploads.items[0].state.state, "COMPLETE");
    assert.equal(uploads.items[0].buildId, data.buildUploads.data[0].relationships.build.data.id);
    assert.equal(requests.find(url => url.pathname.endsWith("/buildUploads")).pathname, `/iris/v1/apps/${appId}/buildUploads`);
  });
}
test("按苹果测试状态展示准备提交与缺少合规证明，处理完成不等于正在测试", () => {
  const initial = normalizeBuild(fixture.initial.builds.data[0], fixture.initial.builds);
  assert.equal(buildStatus(initial, Date.parse("2026-10-06")).text, "准备提交");
  const needsEncryption = { processingState: "VALID", betaDetail: { externalBuildState: "MISSING_EXPORT_COMPLIANCE" } };
  assert.equal(buildStatus(needsEncryption).encryption, true);
  assert.equal(buildStatus({ ...initial, expired: true }).text, "已过期");
  assert.equal(buildStatus({ processingState: "FAILED" }).text, "处理失败");
  assert.equal(buildStatus({ processingState: "PROCESSING" }).text, "正在处理");
});
test("分页只能沿用当前账户 App 和当前接口参数", () => {
  const base = "/iris/v1/builds?filter%5Bapp%5D=app-a&filter%5BpreReleaseVersion%5D=version-a&limit=10";
  assert.match(pagePath(base, `${base}&cursor=next`), /cursor=next/);
  assert.throws(() => pagePath(base, `https://example.org${base}`), /分页地址/);
  assert.throws(() => pagePath(base, base.replace("app-a", "app-b")), /分页参数/);
  assert.throws(() => pagePath(base, "/iris/v1/users?limit=10"), /分页地址/);
});
test("读取失败不会伪造空构建；群组错误单独返回", async () => {
  const service = createTestFlightService(async path => {
    if (path.split("?")[0].endsWith("/betaGroups")) throw new Error("Apple groups 403");
    if (path.split("?")[0].endsWith("/preReleaseVersions")) return { body: fixture.initial.preReleaseVersions };
    throw new Error("Apple builds 500");
  });
  assert.equal((await service.run("overview", { appId: "app-a" })).groupsError, "Apple groups 403");
  await assert.rejects(service.run("builds", { appId: "app-a", versionId: "v" }), /Apple builds 500/);
});
function buildResource(appId = "app-a", buildId = "build-a") {
  return { data: { type: "builds", id: buildId, attributes: { version: "101" }, relationships: { app: { data: { type: "apps", id: appId } }, betaBuildLocalizations: { data: [] } } } };
}
test("只向选中构建保存合规答案，错误账户构建不会写入", async () => {
  const writes = [];
  const service = createTestFlightService(async (path, options = {}) => {
    if (options.method) { writes.push([path, options]); return { body: {} }; }
    return { body: buildResource() };
  });
  await service.run("saveEncryption", { appId: "app-a", buildId: "build-a", usesNonExemptEncryption: false });
  assert.equal(writes[0][0], "/iris/v1/builds/build-a");
  assert.deepEqual(JSON.parse(writes[0][1].body).data.attributes, { usesNonExemptEncryption: false });
  await assert.rejects(service.run("saveEncryption", { appId: "other-app", buildId: "build-a", usesNonExemptEncryption: false }), /不匹配/);
  assert.equal(writes.length, 1);
});
test("保存测试内容只修改 betaBuildLocalizations，不触碰正式审核", async () => {
  const writes = [];
  const service = createTestFlightService(async (path, options = {}) => {
    if (options.method) { writes.push({ path, ...options }); return { body: {} }; }
    return { body: buildResource() };
  });
  await service.run("saveBuildInfo", { appId: "app-a", buildId: "build-a", locale: "zh-Hans", whatsNew: "请测试登录" });
  assert.equal(writes[0].path, "/iris/v1/betaBuildLocalizations");
  assert.deepEqual(JSON.parse(writes[0].body).data.relationships.build.data, { type: "builds", id: "build-a" });
  await assert.rejects(service.run("saveBuildInfo", { appId: "app-a", buildId: "build-a", localizationId: "other", locale: "zh-Hans" }), /不匹配/);
  assert.equal(writes.length, 1);
});
test("创建群组必须等待苹果响应，使用实际 App ID", async () => {
  let resolve, sent;
  const response = new Promise(done => { resolve = done; });
  const service = createTestFlightService(async (path, options) => { sent = JSON.parse(options.body); return response; });
  let finished = false;
  const promise = service.run("createGroup", { appId: "dynamic-app", name: "内部测试组", internal: true, automatic: true }).then(result => { finished = true; return result; });
  await new Promise(setImmediate); assert.equal(finished, false);
  assert.equal(sent.data.relationships.app.data.id, "dynamic-app");
  resolve({ body: { data: { id: "returned-group", attributes: sent.data.attributes } } });
  assert.equal((await promise).id, "returned-group");
});
test("群组读取失败、跨 App 群组和苹果拒绝添加都不会报告成功", async () => {
  const service = createTestFlightService(async (path, options) => {
    if (options?.method) throw new Error("Apple refused group update");
    return { body: { data: [{ type: "betaGroups", id: "group-a", attributes: { name: "A", isInternalGroup: true } }] } };
  });
  await assert.rejects(service.run("saveGroup", { appId: "app-a", groupId: "other", name: "B" }), /不属于/);
  await assert.rejects(service.run("saveGroup", { appId: "app-a", groupId: "group-a", name: "B" }), /Apple refused/);
});
test("批量测试员部分失败时展示苹果错误，不提示全部成功", async () => {
  const service = createTestFlightService(async (path, options) => {
    if (options?.method) return { body: { data: { attributes: { betaTesters: [{ email: "tester@example.com", assignmentResult: "FAILED", errors: [{ detail: "Tester limit exceeded" }] }] } } } };
    return { body: { data: [{ type: "betaGroups", id: "group-a", attributes: { isInternalGroup: false } }] } };
  });
  await assert.rejects(service.run("addTesters", { appId: "app-a", groupId: "group-a", testers: [{ email: "tester@example.com" }] }), /Tester limit exceeded/);
});
test("测试信息部分写入失败必须返回错误，不触碰审核提交接口", async () => {
  const paths = [];
  const service = createTestFlightService(async (path, options = {}) => {
    if (options.method) { paths.push(path); if (path.includes("betaAppReviewDetails")) throw new Error("Apple review metadata rejected"); return { body: {} }; }
    if (path.includes("betaAppLocalizations")) return { body: { data: [{ id: "local-a", attributes: { locale: "zh-Hans", description: "旧简介" } }] } };
    if (path.includes("betaAppReviewDetails")) return { body: { data: [{ id: "review-a", attributes: { notes: "旧备注" } }] } };
    return { body: { data: [] } };
  });
  await assert.rejects(service.run("saveInfo", { appId: "app-a", localization: { id: "local-a", locale: "zh-Hans", description: "新简介" }, review: { id: "review-a", notes: "新备注" } }), /Apple review metadata rejected/);
  assert.deepEqual(paths, ["/iris/v1/betaAppLocalizations/local-a", "/iris/v1/betaAppReviewDetails/review-a"]);
});
test("空指标保持无数据；零值保留；反馈查询按实际 App 隔离", async () => {
  const calls = [];
  const service = createTestFlightService(async path => { calls.push(path); return { body: path.includes("metrics/") ? { data: [{ id: "metric-a", attributes: { installCount: 0, sessionCount: 7 } }] } : path.includes("betaFeedback") ? { data: [] } : buildResource() }; });
  assert.equal((await service.run("metrics", { appId: "app-a", buildId: "build-a" }))[0].installCount, 0);
  assert.equal((await service.run("feedback", { appId: "app-a", kind: "crash" })).total, 0);
  assert.ok(calls.some(path => path.startsWith("/iris/v1/apps/app-a/betaFeedbackCrashSubmissions?")));
});
test("未知操作和路径注入被拒绝，TestFlight 没有取消或撤回正式审核操作", async () => {
  const service = createTestFlightService(async () => { throw new Error("unexpected network"); });
  await assert.rejects(service.run("cancelReview", { appId: "app-a" }), /不支持/);
  await assert.rejects(service.run("overview", { appId: "../users" }), /资源 ID/);
  const html = shell({ id: "app-a", name: '<img onerror="alert(1)">' });
  assert.ok(html.includes("&lt;img")); assert.ok(!html.includes('<img onerror='));
  assert.ok(html.includes('aria-current="page">TestFlight'));
});
