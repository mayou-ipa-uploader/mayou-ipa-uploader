"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");
const { build } = require("plist");
const { inspectIPA, hasAppleDeliveryConfirmation, queryAppleBuildState, uploadPresentation } = require("../src/ipa-upload-state");

const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const metadata = { bundleId: "com.example.demo", version: "1.0.3", build: "7", platform: "IOS" };
const startedAt = "2026-10-05T06:00:00Z";
const uploadedDate = "2026-10-05T06:02:00Z";
const zipCode = main.slice(main.indexOf("function crc32("), main.indexOf("function createZipFromDirectory("));
const createZip = vm.runInNewContext(`${zipCode}; createZip`, { Buffer });
const binaryInfo = Buffer.from("YnBsaXN0MDDVAQIDBAUGBwgJCl8QEkNGQnVuZGxlSWRlbnRpZmllclxDRkJ1bmRsZU5hbWVfEBpDRkJ1bmRsZVNob3J0VmVyc2lvblN0cmluZ18QD0NGQnVuZGxlVmVyc2lvbl5EVFBsYXRmb3JtTmFtZV8QEGNvbS5leGFtcGxlLmRlbW9XRXhhbXBsZVUxLjAuM1E3WGlwaG9uZW9zCBMoNVJkc4aOlJYAAAAAAAABAQAAAAAAAAALAAAAAAAAAAAAAAAAAAAAnw==", "base64");

async function temporaryIPA(t, files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ipa-state-test-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const target = path.join(folder, "example.ipa");
  fs.writeFileSync(target, createZip(files));
  return target;
}

test("IPA metadata is read from binary or XML Info.plist without extracting the full archive", async t => {
  for (const content of [binaryInfo, build({ CFBundleIdentifier: metadata.bundleId, CFBundleShortVersionString: metadata.version, CFBundleVersion: metadata.build, CFBundleName: "Example" })]) {
    const file = await temporaryIPA(t, [{ name: "Payload/Example.app/Info.plist", content }]);
    assert.deepEqual(await inspectIPA(file), { ...metadata, name: "Example" });
  }
});

test("four-component Framework versions do not prevent reading upload identity", async t => {
  const file = await temporaryIPA(t, [
    { name: "Payload/Example.app/Info.plist", content: binaryInfo },
    { name: "Payload/Example.app/Frameworks/Captcha.framework/Info.plist", content: build({ CFBundleShortVersionString: "1.8.3.2" }) },
  ]);
  assert.deepEqual(await inspectIPA(file), { ...metadata, name: "Example" });
});

test("main-app version format is also left to Apple while retaining receipt identity", async t => {
  const file = await temporaryIPA(t, [{ name: "Payload/Example.app/Info.plist", content: build({ CFBundleIdentifier: metadata.bundleId, CFBundleShortVersionString: "1.0.3.4", CFBundleVersion: metadata.build }) }]);
  assert.equal((await inspectIPA(file)).version, "1.0.3.4");
});

test("missing main-app metadata cannot be used to confirm an arbitrary build", async t => {
  const file = await temporaryIPA(t, [{ name: "Payload/Example.app/Info.plist", content: build({ CFBundleIdentifier: metadata.bundleId }) }]);
  await assert.rejects(inspectIPA(file), /缺少 Bundle ID、版本号或 Build/);
});

test("delivery confirmation requires the actual Apple package summary, not generic success or a zero package count", () => {
  for (const text of ["1 package was uploaded successfully:", "1 package was successfully uploaded", "UPLOAD SUCCEEDED with 1 package", "No errors uploading 'example.ipa'."]) {
    assert.equal(hasAppleDeliveryConfirmation([{ message: text }]), true);
  }
  for (const text of ["Process exited 0", "HTTP 200 success", "uploaded successfully to an internal cache", "0 packages were uploaded successfully", "UPLOAD SUCCEEDED with 0 packages"]) {
    assert.equal(hasAppleDeliveryConfirmation([{ message: text }]), false);
  }
});

function buildBody({ processingState = "VALID", internalBuildState = "READY_FOR_BETA_TESTING", version = metadata.version, build = metadata.build, date = uploadedDate, appId = "APP", platform = "IOS" } = {}) {
  return {
    data: [{ type: "builds", id: "BUILD", attributes: { version: build, uploadedDate: date, processingState }, relationships: { app: { data: { type: "apps", id: appId } }, preReleaseVersion: { data: { type: "preReleaseVersions", id: "VERSION" } }, buildBetaDetail: { data: { type: "buildBetaDetails", id: "BETA" } } } }],
    included: [
      { type: "preReleaseVersions", id: "VERSION", attributes: { version, platform } },
      { type: "buildBetaDetails", id: "BETA", attributes: { internalBuildState, externalBuildState: "WAITING_FOR_BETA_REVIEW" } },
    ],
  };
}

function uploadBody(state, errors = []) {
  return { data: [{ type: "buildUploads", id: "UPLOAD", attributes: { cfBundleShortVersionString: metadata.version, cfBundleVersion: metadata.build, platform: "IOS", uploadedDate, state: { state, errors } } }] };
}

function queryFetch({ builds = { data: [] }, uploads = { data: [] }, bundleId = metadata.bundleId, buildError, uploadError } = {}) {
  const requests = [];
  const fetch = async requestPath => {
    const url = new URL(requestPath, "https://appstoreconnect.apple.com");
    requests.push(url);
    if (url.pathname === "/iris/v1/apps") return { body: { data: [{ type: "apps", id: "APP", attributes: { name: "Example App", bundleId } }] } };
    if (url.pathname === "/iris/v1/builds") {
      if (buildError) throw buildError;
      return { body: builds };
    }
    assert.equal(url.pathname, "/iris/v1/apps/APP/buildUploads");
    if (uploadError) throw uploadError;
    return { body: uploads };
  };
  return { fetch, requests };
}

async function query(options) {
  const context = queryFetch(options);
  return { state: await queryAppleBuildState({ metadata, startedAt }, context.fetch), requests: context.requests };
}

test("only an exact Apple app, version and Build can become a confirmed TestFlight state", async () => {
  const { state, requests } = await query({ builds: buildBody() });
  assert.equal(state.phase, "valid");
  assert.equal(state.buildId, "BUILD");
  assert.equal(state.app.id, "APP");
  assert.equal(uploadPresentation({ status: "submitted", appleState: state }).text, "TestFlight 内部测试可用");
  assert.equal(requests[0].searchParams.get("filter[bundleId]"), metadata.bundleId);
  assert.equal(requests[1].searchParams.get("filter[version]"), metadata.build);
  assert.equal(requests[1].searchParams.get("filter[preReleaseVersion.version]"), metadata.version);
  assert.equal(requests[1].searchParams.get("filter[processingState]"), null);
  assert.equal(requests[1].searchParams.get("filter[isAppStoreCandidate]"), null);
});

test("old, mismatched app/version/Build/platform and undated builds cannot confirm a new upload", async () => {
  for (const mismatch of [{ date: "2026-10-04T06:00:00Z" }, { date: "" }, { appId: "OTHER" }, { version: "1.0.2" }, { build: "6" }, { platform: "TV_OS" }]) {
    const { state } = await query({ builds: buildBody(mismatch) });
    assert.equal(state.phase, "waiting");
    assert.equal(uploadPresentation({ status: "submitted", deliveryConfirmed: true, appleState: state }).level, "warning");
  }
});

test("a later upload from another tool is never attributed to this task's Apple receipt", async () => {
  const { fetch } = queryFetch({ builds: buildBody(), uploads: uploadBody("COMPLETE") });
  const state = await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "OUR-BUILD" }, fetch);
  assert.equal(state.phase, "waiting");
  assert.equal(state.buildId, undefined);
  const matching = await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "BUILD" }, fetch);
  assert.equal(matching.phase, "valid");
});

test("receipt-bound processing and failure are visible before Apple creates a build", async () => {
  for (const receiptState of ["PROCESSING", "COMPLETE", "FAILED"]) {
    const uploads = uploadBody(receiptState, receiptState === "FAILED" ? [{ code: "90060", description: "Invalid framework version" }] : []);
    uploads.data[0].relationships = { build: { data: null } };
    const { fetch } = queryFetch({ uploads });
    const state = await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "UPLOAD" }, fetch);
    assert.equal(state.phase, receiptState === "FAILED" ? "failed" : "processing");
    assert.equal(state.uploadId, "UPLOAD");
    if (receiptState === "FAILED") assert.deepEqual(state.errors, ["90060: Invalid framework version"]);
  }
});

test("only the build linked by the matching upload receipt can confirm processing", async () => {
  const uploads = uploadBody("COMPLETE");
  uploads.data[0].relationships = { build: { data: { type: "builds", id: "BUILD" } } };
  const { fetch } = queryFetch({ builds: buildBody(), uploads });
  const state = await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "UPLOAD" }, fetch);
  assert.equal(state.phase, "valid");
  assert.equal(state.buildId, "BUILD");
  assert.equal(state.uploadId, "UPLOAD");
  uploads.data[0].relationships.build.data.id = "OTHER-BUILD";
  assert.equal((await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "UPLOAD" }, fetch)).phase, "processing");
});

test("an upload ID match still requires the selected version, Build and platform", async () => {
  for (const mismatch of [{ cfBundleShortVersionString: "1.0.2" }, { cfBundleVersion: "6" }, { platform: "TV_OS" }]) {
    const uploads = uploadBody("COMPLETE");
    Object.assign(uploads.data[0].attributes, mismatch);
    uploads.data[0].relationships = { build: { data: { type: "builds", id: "BUILD" } } };
    const { fetch } = queryFetch({ builds: buildBody(), uploads });
    const state = await queryAppleBuildState({ metadata, startedAt, expectedBuildId: "UPLOAD" }, fetch);
    assert.equal(state.phase, "waiting");
  }
});

test("a package belonging to a different app is not silently matched to the currently viewed app", async () => {
  const { state, requests } = await query({ bundleId: "com.example.other", builds: buildBody() });
  assert.equal(state.phase, "unknown");
  assert.match(state.reason, /com\.example\.demo/);
  assert.equal(requests.length, 1);
});

test("Apple asynchronous validation failures expose the real upload error and code", async () => {
  const { state } = await query({ uploads: uploadBody("FAILED", [{ code: "ITMS-90060", description: "Invalid CFBundleShortVersionString 1.8.3.2" }]) });
  assert.equal(state.phase, "failed");
  assert.deepEqual(state.errors, ["ITMS-90060: Invalid CFBundleShortVersionString 1.8.3.2"]);
  assert.equal(uploadPresentation({ status: "submitted", appleState: state }).text, "苹果处理失败");
});

test("an upload receipt that says COMPLETE still waits for an actual processed build", async () => {
  for (const receiptState of ["PROCESSING", "COMPLETE"]) {
    const { state } = await query({ uploads: uploadBody(receiptState) });
    assert.equal(state.phase, "processing");
    assert.equal(uploadPresentation({ status: "submitted", appleState: state }).text, "苹果处理中");
  }
});

test("FAILED and INVALID builds are not excluded by a filter for valid App Store candidates", async () => {
  for (const processingState of ["FAILED", "INVALID"]) {
    const { state } = await query({ builds: buildBody({ processingState }) });
    assert.equal(state.phase, "failed");
  }
});

test("a valid build needing export compliance is not presented as ready to test", async () => {
  const { state } = await query({ builds: buildBody({ internalBuildState: "MISSING_EXPORT_COMPLIANCE" }) });
  assert.equal(state.phase, "valid");
  assert.deepEqual(uploadPresentation({ status: "submitted", appleState: state }), { text: "需补充出口合规", level: "warning" });
});

test("VALID binary processing does not stop polling when TestFlight or export compliance is still processing", async () => {
  for (const internalBuildState of ["PROCESSING", "IN_EXPORT_COMPLIANCE_REVIEW"]) {
    const { state } = await query({ builds: buildBody({ internalBuildState }) });
    assert.equal(state.phase, "processing");
    assert.notEqual(uploadPresentation({ status: "submitted", appleState: state }).level, "success");
  }
});

test("unsupported or malformed upload receipts do not hide a build confirmed by Apple", async () => {
  for (const options of [{ uploadError: Object.assign(new Error("Not found"), { status: 404 }) }, { uploads: { text: "invalid response" } }]) {
    const { state } = await query({ builds: buildBody(), ...options });
    assert.equal(state.phase, "valid");
    assert.equal(state.queryWarnings.length, 1);
  }
});

test("login and network failures stay unconfirmed and never become upload success", async () => {
  const { state } = await query({ buildError: new Error("Apple HTTP 401"), uploadError: new Error("Apple timeout") });
  assert.equal(state.phase, "query_error");
  assert.match(state.reason, /401/);
  assert.match(state.reason, /timeout/);
  assert.equal(uploadPresentation({ status: "submitted", appleState: state }).text, "处理结果未确认");
});

test("manual lookups can find older uploads without uploading the file again", async () => {
  const context = queryFetch({ builds: buildBody({ date: "2026-10-04T06:00:00Z" }) });
  const state = await queryAppleBuildState({ metadata, startedAt: "" }, context.fetch);
  assert.equal(state.phase, "valid");
});

function monitorContext(query) {
  const timers = new Map();
  const context = {
    uploadTasks: new Map(), uploadStartReservations: new Set(),
    uploadPresentation, queryAppleBuildState: query,
    appleDeveloperContextGeneration: 1, appleDeveloperAccountKey: "account-a", appleDeveloperLaunchAppleId: "member@example.com",
    appleDeveloperContextIsCurrent: (generation, key) => context.appleDeveloperContextGeneration === generation && context.appleDeveloperAccountKey === key,
    appleDeveloperPartitionForAccount: key => `partition:${key}`,
    readSelectedAppleDeveloperTeam: () => ({ id: "team-a" }),
    session: { fromPartition: () => ({}) },
    appStoreConnectFetch: async (_request, options) => { assert.equal(options.skipSessionRefresh, true); return { body: { data: [] } }; },
    AbortSignal,
    setTimeout: callback => { const id = {}; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    timers,
  };
  const code = main.slice(main.indexOf("function createUploadTask("), main.indexOf("function bundledTransporterJavaHome("));
  vm.runInNewContext(code, context);
  const taskId = context.createUploadTask("example.ipa");
  Object.assign(context.uploadTasks.get(taskId), { status: "submitted", metadata, appleId: "member@example.com", deliveryConfirmed: true, monitorUntil: Date.now() + 1800000 });
  return { context, taskId, task: context.uploadTasks.get(taskId) };
}

test("status polling coalesces slow Apple requests and remains active after file submission", async () => {
  let finish;
  let calls = 0;
  const { context, taskId } = monitorContext(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = context.refreshUploadAppleState(taskId);
  const second = context.refreshUploadAppleState(taskId);
  assert.equal(calls, 1);
  assert.equal(context.publicUploadTask(taskId).monitorActive, true);
  assert.equal(context.publicUploadTask(taskId).statusText, "文件已提交，待苹果确认");
  finish({ phase: "valid", internalBuildState: "READY_FOR_BETA_TESTING", app: { id: "APP", name: "Example" } });
  await Promise.all([first, second]);
  assert.equal(context.publicUploadTask(taskId).status, "success");
  assert.equal(context.publicUploadTask(taskId).monitorActive, false);
  assert.equal(context.timers.size, 0);
});

test("Apple-query timeout does not convert a submitted file into a confirmed success or upload failure", async () => {
  const { context, taskId } = monitorContext(() => new Promise(() => {}));
  const pending = context.refreshUploadAppleState(taskId);
  [...context.timers.values()][0]();
  await pending;
  const task = context.publicUploadTask(taskId);
  assert.equal(task.status, "submitted");
  assert.equal(task.statusText, "处理结果未确认");
  assert.match(task.appleState.reason, /查询超时/);
});

test("account changes discard a late successful response and a different Apple ID is never queried", async () => {
  let finish;
  const { context, taskId } = monitorContext(() => new Promise(resolve => { finish = resolve; }));
  const pending = context.refreshUploadAppleState(taskId);
  context.appleDeveloperContextGeneration++;
  finish({ phase: "valid" });
  await pending;
  assert.equal(context.publicUploadTask(taskId).statusText, "处理结果未确认");
  context.appleDeveloperLaunchAppleId = "other@example.com";
  context.queryAppleBuildState = () => { throw new Error("must not query the wrong account"); };
  await context.refreshUploadAppleState(taskId, { force: true });
  assert.match(context.publicUploadTask(taskId).appleState.reason, /账号与上传 Apple ID 不一致/);
});

test("automatic monitoring pauses without inventing a failure and manual query restarts it", async () => {
  const { context, taskId, task } = monitorContext(async () => ({ phase: "processing" }));
  task.appleState = { phase: "processing" };
  task.monitorUntil = Date.now() - 1;
  await context.refreshUploadAppleState(taskId);
  assert.equal(context.publicUploadTask(taskId).monitorActive, false);
  assert.equal(context.publicUploadTask(taskId).statusText, "处理结果未确认");
  await context.refreshUploadAppleState(taskId, { force: true });
  assert.equal(context.publicUploadTask(taskId).monitorActive, true);
  assert.equal(context.publicUploadTask(taskId).statusText, "苹果处理中");
});

function uploadProcessContext() {
  const { context } = monitorContext(() => new Promise(() => {}));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  let spawnCount = 0;
  const spawnCalls = [];
  const workerConfigs = [];
  child.stdin.end = input => workerConfigs.push(JSON.parse(input));
  const handlers = {};
  Object.assign(context, {
    ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; } },
    fs: { existsSync: () => true }, path, process: { env: {}, platform: "darwin", execPath: "bundled-electron" }, __dirname: path.join(__dirname, "../src"),
    inspectIPA: async () => metadata,
    uploaderCommand: () => ({ command: "mock-uploader", args: [], bundled: false }),
    transporterStatus: () => ({ available: true, path: "mock-transporter" }),
    transporterAccountEnvironment: () => ({}), projectRootDir: () => "/tmp",
    readAppleDeveloperUploadProxy: () => ({ enabled: false }),
    hasAppleDeliveryConfirmation,
    StringDecoder, Buffer,
    spawn: (...args) => { spawnCount++; spawnCalls.push(args); return child; },
  });
  const code = main.slice(main.indexOf('ipcMain.handle("upload-start",'), main.indexOf('ipcMain.handle("deepseek-upload-analyze",'));
  vm.runInNewContext(code, context);
  return { context, handlers, child, spawnCalls, workerConfigs, spawnCount: () => spawnCount };
}

test("a zero exit and worker ok flag are insufficient without Apple's delivery confirmation", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: true }) + "\n");
  child.emit("close", 0);
  assert.equal(context.publicUploadTask(taskId).status, "error");
  assert.match(context.publicUploadTask(taskId).error, /未返回与本次版本绑定的 Apple 构建回执/);
});

test("the actual upload-process completion becomes submitted and waits for Apple instead of returning success", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  child.stdout.emit("data", JSON.stringify({ type: "event", level: "success", message: "1 package was uploaded successfully:" }) + "\n");
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: true, deliveryConfirmed: true, versionBound: true, receiptBuildId: "BUILD" }) + "\n");
  child.emit("close", 0);
  const task = context.publicUploadTask(taskId);
  assert.equal(task.status, "submitted");
  assert.equal(task.deliveryConfirmed, true);
  assert.equal(task.monitorActive, true);
  assert.equal(task.statusText, "文件已提交，待苹果确认");
  assert.equal(JSON.stringify(task).includes("fixture-password"), false);
  [...context.timers.values()].forEach(callback => callback());
  await context.uploadTasks.get(taskId).appleQueryPromise;
});

test("preflight rejection prevents the uploader process from being started", async () => {
  const { context, handlers, spawnCount } = uploadProcessContext();
  context.inspectIPA = async () => { throw new Error("Invalid Framework 1.8.3.2"); };
  const result = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  assert.match(result.error, /Invalid Framework/);
  assert.equal(spawnCount(), 0);
});

test("the main process uses the app's runtime and passes credentials only through the environment", async () => {
  const { handlers, spawnCalls, workerConfigs } = uploadProcessContext();
  await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  const [command, args, options] = spawnCalls[0];
  assert.equal(command, "bundled-electron");
  assert.match(args[0], /ipa-upload-worker\.js$/);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(JSON.stringify(args).includes("fixture-password"), false);
  assert.equal(JSON.stringify(workerConfigs[0]).includes("fixture-password"), false);
  assert.equal(options.env[workerConfigs[0].passwordEnv], "fixture-password");
});

test("Windows runtime selection always uses the application's bundled Java, even with external Java configured", () => {
  const context = { path: path.win32, fs: { existsSync: file => file === "C:\\Certificate Manager\\vendor\\itms\\windows\\java\\bin\\java.exe", mkdirSync() {} },
    crypto: require("node:crypto"), app: { getPath: () => "C:\\User Data\\Certificate Manager" },
    process: { platform: "win32", env: { JAVA_HOME: "C:\\External Java", ITMS_TRANSPORTER_JAVA_HOME: "C:\\External Java", IPAUPLOADER_ALLOW_EXTERNAL_JAVA: "1" } },
    spawnSync: file => { assert.equal(file, "C:\\Certificate Manager\\vendor\\itms\\windows\\java\\bin\\java.exe"); return { stderr: 'java version "21.0.9"' }; } };
  const code = main.slice(main.indexOf("function bundledTransporterJavaHome("), main.indexOf('ipcMain.handle("load-proxies",'));
  vm.runInNewContext(code, context);
  const environment = context.transporterAccountEnvironment("member@example.com", "C:\\Certificate Manager\\vendor\\itms\\windows\\bin\\iTMSTransporter.cmd");
  assert.equal(environment.JAVA_HOME, "C:\\Certificate Manager\\vendor\\itms\\windows\\java");
  assert.equal(environment.ITMS_TRANSPORTER_JAVA_HOME, environment.JAVA_HOME);
  assert.match(environment.APPDATA, /transporter-accounts/);
  assert.equal(context.transporterJavaHome("C:\\Incomplete\\bin\\iTMSTransporter.cmd"), "");
});

test("validation-only completion never becomes submitted, upload success or TestFlight monitoring", async () => {
  const { context, handlers, child, workerConfigs } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password", validateOnly: true });
  assert.equal(workerConfigs[0].validateOnly, true);
  assert.equal(context.publicUploadTask(taskId).statusText, "正在读取 IPA 信息");
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: true, validatedOnly: true, deliveryConfirmed: false }) + "\n");
  child.emit("close", 0);
  const task = context.publicUploadTask(taskId);
  assert.equal(task.status, "validated");
  assert.equal(task.statusText, "IPA 信息已读取，尚未上传");
  assert.equal(task.monitorActive, false);
  assert.equal(task.deliveryConfirmed, false);
});

test("Apple error details from the worker survive the main IPC boundary", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  const error = "ERROR: This bundle is invalid. AlicomCaptcha4.framework CFBundleShortVersionString 1.8.3.2 (90060)";
  child.stdout.emit("data", JSON.stringify({ type: "stage", stage: "upload" }) + "\n");
  child.stdout.emit("data", JSON.stringify({ type: "event", level: "error", message: error }) + "\n");
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: false, error }) + "\n");
  child.emit("close", 31);
  assert.equal(context.publicUploadTask(taskId).statusText, "上传失败");
  assert.equal(context.publicUploadTask(taskId).error, error);
});

test("a duplicate Apple asset receipt remains unconfirmed until an exact current build is found", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  child.stdout.emit("data", JSON.stringify({ type: "event", message: "1 package was uploaded successfully:" }) + "\n");
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: true, deliveryConfirmed: true, versionBound: true, receiptBuildId: "BUILD", duplicateDelivery: true }) + "\n");
  child.emit("close", 0);
  const task = context.publicUploadTask(taskId);
  assert.equal(task.duplicateDelivery, true);
  assert.equal(task.status, "submitted");
  assert.equal(task.statusText, "苹果提示文件已存在，待核对构建");
  assert.equal(task.statusLevel, "warning");
  [...context.timers.values()].forEach(callback => callback());
  await context.uploadTasks.get(taskId).appleQueryPromise;
});

test("fragmented Chinese Apple errors retain the full error through a zero-exit IPC completion", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  const error = "ERROR: 苹果拒绝包：Framework 版本 1.8.3.2 (90060)\nNSUnderlyingError (-19241)";
  const short = JSON.stringify({ type: "event", level: "error", message: "ERROR: 苹果拒绝" }) + "\n";
  const text = Buffer.from(short + JSON.stringify({ type: "finish", ok: false, error }) + "\n");
  const i = text.indexOf(Buffer.from("苹"));
  child.stdout.emit("data", text.subarray(0, i + 1));
  child.stdout.emit("data", text.subarray(i + 1));
  child.emit("close", 0);
  assert.equal(context.publicUploadTask(taskId).error, error);
});

test("IPA checks work without a password, installed Java, Apple tools or a usable proxy", async () => {
  const { context, handlers, child } = uploadProcessContext();
  context.transporterStatus = () => ({ available: false, path: "" });
  context.transporterAccountEnvironment = () => { throw new Error("must not require Java for an IPA check"); };
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", validateOnly: true, proxy: { enabled: true } });
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: true, validatedOnly: true }) + "\n");
  child.emit("close", 0);
  assert.equal(context.publicUploadTask(taskId).status, "validated");
});

test("an uncertain worker result is shown as unconfirmed rather than an Apple rejection", async () => {
  const { context, handlers, child } = uploadProcessContext();
  const { taskId } = await handlers["upload-start"](null, { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" });
  child.stdout.emit("data", JSON.stringify({ type: "stage", stage: "upload" }) + "\n");
  child.stdout.emit("data", JSON.stringify({ type: "finish", ok: false, uncertain: true, error: "查询最终回执超时" }) + "\n");
  child.emit("close", 1);
  assert.equal(context.publicUploadTask(taskId).statusText, "上传结果未确认");
  assert.equal(context.publicUploadTask(taskId).statusLevel, "warning");
});

test("concurrent requests and a running task cannot start another upload for the same Apple ID", async () => {
  const { context, handlers, spawnCount, child } = uploadProcessContext();
  let release;
  context.inspectIPA = () => new Promise(resolve => { release = resolve; });
  const payload = { ipaPath: "sample.ipa", appleId: "member@example.com", password: "fixture-password" };
  const first = handlers["upload-start"](null, payload);
  assert.match((await handlers["upload-start"](null, payload)).error, /已有校验或上传任务/);
  release(metadata);
  await first;
  assert.equal(spawnCount(), 1);
  assert.match((await handlers["upload-start"](null, payload)).error, /已有校验或上传任务/);
  child.emit("close", 1);
});

test("manual Apple-state lookup creates no upload process and never claims file delivery without evidence", async () => {
  const { context, handlers, spawnCount } = uploadProcessContext();
  const { taskId } = await handlers["upload-check-apple-state"](null, { ipaPath: "sample.ipa", appleId: "member@example.com" });
  const task = context.publicUploadTask(taskId);
  assert.equal(task.deliveryConfirmed, false);
  assert.equal(task.statusText, "正在查询苹果状态");
  assert.equal(spawnCount(), 0);
  [...context.timers.values()].forEach(callback => callback());
  await context.uploadTasks.get(taskId).appleQueryPromise;
});

test("manual Apple-state queries append results without clearing or duplicating upload logs", async () => {
  for (const previousTaskId of ["FAILED-UPLOAD", "", "LOOKUP"]) {
    const uploadLine = { level: "error", message: "当前版本的 IPA 已经上传了", time: "10:30:36" };
    const queryLine = { level: "info", message: "仅查询苹果处理结果，不重新上传", time: "10:34:32" };
    const resultLine = { level: "warning", message: "需补充出口合规", time: "10:34:34" };
    const log = [uploadLine];
    if (previousTaskId === "LOOKUP") log.push(queryLine);
    let queries = 0;
    const nodes = {
      "ipa-upload-log": { replaceChildren: () => { log.length = 0; } },
      "ipa-upload-check-apple": {},
      "ipa-upload-apple-id": { value: "member@example.com" },
      "ipa-upload-task-state": { textContent: "", style: {} },
    };
    const context = {
      activeIPAUploadTaskId: previousTaskId, selectedIPAUploadPath: "sample.ipa",
      ipaUploadTaskRunning: false, ipaUploadStartPending: false, ipaUploadPollInFlight: false,
      renderedIPAUploadEventCount: previousTaskId === "LOOKUP" ? 1 : 4,
      ipaUploadLastTaskEvents: [], ipaUploadPollTimer: null,
      window: { uploader: {
        checkAppleState: async payload => {
          assert.equal(payload.taskId, queries++ === 0 ? previousTaskId : "LOOKUP");
          return { taskId: "LOOKUP", metadata };
        },
        status: async taskId => {
          assert.equal(taskId, "LOOKUP");
          return { status: "success", statusText: "需补充出口合规", statusLevel: "warning", events: [queryLine, resultLine], monitorActive: false };
        },
      } },
      el: id => nodes[id], appendIPAUploadLog: (level, message, time) => log.push({ level, message, time }),
      setBusy() {}, startIPAUploadPolling() {}, renderIPAUploadAppleFeedback() {},
      clearIPAUploadFailureState() {}, setIPAUploadStartState() {}, clearInterval() {},
    };
    const checkCode = renderer.slice(renderer.indexOf("async function checkIPAUploadAppleState()"), renderer.indexOf("function appendIPAUploadLog("));
    const pollCode = renderer.slice(renderer.indexOf("async function pollIPAUploadFromCertificateManager()"), renderer.indexOf("function automationLog("));
    vm.runInNewContext(checkCode + pollCode, context);
    await context.checkIPAUploadAppleState();
    assert.equal(log[0], uploadLine);
    await context.pollIPAUploadFromCertificateManager();
    await context.checkIPAUploadAppleState();
    await context.pollIPAUploadFromCertificateManager();
    assert.deepEqual(log, [uploadLine, queryLine, resultLine]);
  }
});

test("the renderer continues polling Apple after submission and stops only after the build result is terminal", async () => {
  const nodes = { "ipa-upload-task-state": { textContent: "", style: {} } };
  let clears = 0;
  const context = {
    activeIPAUploadTaskId: "TASK", ipaUploadPollInFlight: false, ipaUploadPollTimer: "timer", ipaUploadTaskRunning: true,
    renderedIPAUploadEventCount: 0, ipaUploadLastTaskEvents: [], ipaUploadStartPending: false,
    window: { uploader: { status: async () => ({ status: "submitted", statusText: "文件已提交，待苹果确认", statusLevel: "warning", events: [], monitorActive: true }) } },
    el: id => nodes[id], appendIPAUploadLog() {}, renderIPAUploadAppleFeedback() {},
    setIPAUploadFailureState() {}, clearIPAUploadFailureState() {}, setIPAUploadStartState() {}, setIPAUploadAIState() {},
    clearInterval: () => { clears++; },
  };
  const code = renderer.slice(renderer.indexOf("async function pollIPAUploadFromCertificateManager()"), renderer.indexOf("function automationLog("));
  vm.runInNewContext(code, context);
  await context.pollIPAUploadFromCertificateManager();
  assert.equal(clears, 0);
  assert.equal(nodes["ipa-upload-task-state"].textContent, "文件已提交，待苹果确认");
  assert.equal(context.ipaUploadTaskRunning, false);
  context.window.uploader.status = async () => ({ status: "success", statusText: "TestFlight 内部测试可用", statusLevel: "success", events: [], monitorActive: false });
  await context.pollIPAUploadFromCertificateManager();
  assert.equal(clears, 1);
  assert.equal(nodes["ipa-upload-task-state"].textContent, "TestFlight 内部测试可用");
});
