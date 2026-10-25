"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { build } = require("plist");
const { appleError, deliveryConfirmed, uploadReceipt, parseProviders, proxyEnvironment, transporterCommand, runCommand, runUpload } = require("../src/ipa-upload-worker");

const error90060 = fs.readFileSync(path.join(__dirname, "fixtures/apple-framework-version-error.log"), "utf8");
const config = { appleId: "member@example.com", passwordEnv: "IPAUPLOAD_TEST_PASSWORD", transporterPath: path.join(__dirname, "../vendor/itms/bin/iTMSTransporter"), proxy: { enabled: false } };
const env = { IPAUPLOAD_TEST_PASSWORD: "abcd-efgh-ijkl-mnop", JAVA_HOME: "/bundle/vendor/itms/java", ITMS_TRANSPORTER_JAVA_HOME: "/bundle/vendor/itms/java" };
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const createZip = vm.runInNewContext(main.slice(main.indexOf("function crc32("), main.indexOf("function createZipFromDirectory(")) + "; createZip", { Buffer });
function sourceIPA(t, invalid = false) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ipa-worker-test-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const ipaPath = path.join(folder, "测试 100% & !.ipa");
  const entries = [{ name: "Payload/App.app/Info.plist", content: build({ CFBundleIdentifier: "com.example.test", CFBundleShortVersionString: "1.0.3", CFBundleVersion: "1" }) }];
  if (invalid) entries.push({ name: "Payload/App.app/Frameworks/AlicomCaptcha4.framework/Info.plist", content: build({ CFBundleShortVersionString: "1.8.3.2" }) });
  fs.writeFileSync(ipaPath, createZip(entries));
  return { ...config, ipaPath };
}
function pipeline(t, { invalid = false, providers = "Provider listing:\n1 Example TEAM12345", providerResult, upload = { code: 0, logs: "MSY_UPLOAD_VERSION_SCOPE=1.0.3\nMSY_UPLOAD_BUILD_ID=BUILD-123\n1 package was uploaded successfully:" }, beforeUpload } = {}) {
  const calls = [], events = [];
  const settings = sourceIPA(t, invalid);
  const run = async spec => {
    calls.push(spec);
    const mode = spec.args[spec.args.indexOf("-m") + 1];
    assert.ok(["provider", "upload"].includes(mode), "Apple no longer supports standalone IPA verification");
    if (mode === "upload") {
      assert.ok(spec.args.includes("-assetFile"));
      assert.equal(spec.args[spec.args.indexOf("-t") + 1], "HTTP");
      assert.ok(!spec.args.includes("-f"));
      await beforeUpload?.(spec, settings);
    }
    const result = mode === "provider" ? providerResult || { code: 0, logs: providers } : upload;
    for (const line of String(result.logs || "").split("\n")) spec.onLine(line);
    return result;
  };
  return { config: settings, calls, events, options: { run, env, platform: "darwin", emit: event => events.push(event) } };
}

test("Apple 90060 retains the original framework, value, code and underlying error even after a zero exit", async t => {
  const error = appleError(error90060);
  for (const value of ["90060", "AlicomCaptcha4.framework", "1.8.3.2", "(-19241)", "ExitFailure (31)"]) assert.ok(error.includes(value));
  for (const code of [0, 31]) {
    const fixture = pipeline(t, { upload: { code, logs: error90060 } });
    const result = await runUpload(fixture.config, fixture.options);
    assert.equal(result.ok, false);
    assert.match(result.error, /90060/);
    assert.equal(result.deliveryConfirmed, undefined);
  }
});

test("nested four-component Framework versions reach Apple unchanged and display Apple's rejection", async t => {
  const fixture = pipeline(t, {
    invalid: true,
    upload: { code: 31, logs: error90060 },
    beforeUpload: (spec, settings) => {
      const snapshot = spec.args[spec.args.indexOf("-assetFile") + 1];
      assert.deepEqual(fs.readFileSync(snapshot), fs.readFileSync(settings.ipaPath));
    },
  });
  const result = await runUpload(fixture.config, fixture.options);
  assert.deepEqual(fixture.calls.map(call => call.args[1]), ["provider", "upload"]);
  assert.equal(result.ok, false);
  assert.equal(result.error, appleError(error90060));
});

test("supported upload arguments require a positive Apple delivery receipt and use only bundled components", async t => {
  const fixture = pipeline(t);
  const result = await runUpload(fixture.config, fixture.options);
  assert.deepEqual(fixture.calls.map(call => call.args[1]), ["provider", "upload"]);
  assert.deepEqual(fixture.events.filter(event => event.type === "stage").map(event => event.stage), ["inspection", "provider", "upload"]);
  assert.equal(result.deliveryConfirmed, true);
  assert.equal(result.provider, "TEAM12345");
  for (const call of fixture.calls) {
    assert.equal(call.command, config.transporterPath);
    assert.equal(call.env.ITMS_TRANSPORTER_JAVA_HOME, env.ITMS_TRANSPORTER_JAVA_HOME);
    assert.ok(!call.args.includes(env.IPAUPLOAD_TEST_PASSWORD));
    assert.ok(call.args.includes("@env:IPAUPLOAD_TEST_PASSWORD"));
  }
});

test("metadata-only reads four-component Framework packages without credentials or claiming validation", async t => {
  const fixture = pipeline(t, { invalid: true });
  const result = await runUpload({ ...fixture.config, validateOnly: true, transporterPath: "missing" }, { ...fixture.options, env: {} });
  assert.equal(result.validatedOnly, true);
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(fixture.calls.length, 0);
  assert.ok(!fixture.events.some(event => /苹果.*通过/.test(event.message)));
});

test("Windows requires matching exported metadata before contacting Apple and supplies its private copy", async t => {
  const fixture = pipeline(t, { invalid: true });
  const options = { ...fixture.options, platform: "win32" };
  await assert.rejects(runUpload(fixture.config, options), /AppStoreInfo.plist/);
  assert.equal(fixture.calls.length, 0);
  const description = path.join(path.dirname(fixture.config.ipaPath), "AppStoreInfo.plist");
  const bundle = { "bundle-identifier": "com.example.test", CFBundleShortVersionString: "1.0.3", CFBundleVersion: "2", "platform-display-name": "iOS" };
  const write = () => fs.writeFileSync(description, build({ "product-metadata": { packages: [{ bundles: [bundle] }] } }));
  write();
  await assert.rejects(runUpload({ ...fixture.config, assetDescriptionPath: description }, options), /不一致/);
  assert.equal(fixture.calls.length, 0);
  bundle.CFBundleVersion = "1"; write();
  const result = await runUpload({ ...fixture.config, assetDescriptionPath: description }, options);
  assert.equal(result.ok, true);
  const call = fixture.calls.at(-1);
  assert.ok(call.args.includes("-assetDescription"));
  const copied = call.args[call.args.indexOf("-assetDescription") + 1];
  assert.notEqual(copied, description);
  assert.equal(fs.existsSync(copied), false);
  assert.equal(fs.existsSync(description), true);
});

test("uploading uses the inspected private snapshot even when the original file is replaced; it cleans up afterwards", async t => {
  let snapshot;
  const fixture = pipeline(t, { beforeUpload: (spec, settings) => {
    snapshot = spec.args[spec.args.indexOf("-assetFile") + 1];
    const original = fs.readFileSync(settings.ipaPath);
    fs.writeFileSync(settings.ipaPath, "replaced by another app");
    assert.deepEqual(fs.readFileSync(snapshot), original);
    assert.notEqual(snapshot, settings.ipaPath);
  } });
  assert.equal((await runUpload(fixture.config, fixture.options)).ok, true);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  assert.equal(fs.readFileSync(fixture.config.ipaPath, "utf8"), "replaced by another app");
});

test("a metadata change after selection prevents an upload", async t => {
  const fixture = pipeline(t);
  await assert.rejects(runUpload({ ...fixture.config, metadata: { bundleId: "com.other.app" } }, fixture.options), /信息已经变化/);
  assert.equal(fixture.calls.length, 0);
});

test("an error after a positive upload receipt overrides that receipt", async t => {
  const fixture = pipeline(t, { upload: { code: 0, logs: `1 package was uploaded successfully:\n${error90060}` } });
  const result = await runUpload(fixture.config, fixture.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /90060/);
});

test("Apple's real already-uploaded warning is preserved as duplicate delivery, without claiming a new build", async t => {
  const upload = { code: 0, logs: "" };
  const fixture = pipeline(t, { upload, beforeUpload: (_spec, settings) => {
    const hash = require("node:crypto").createHash("md5").update(fs.readFileSync(settings.ipaPath)).digest("hex");
    upload.logs = `MSY_UPLOAD_VERSION_SCOPE=1.0.3\nMSY_UPLOAD_BUILD_ID=BUILD-123\nWARN: The software asset has already been uploaded.\nsourceFileChecksum: ${hash}\n1 package was uploaded successfully:`;
  } });
  const result = await runUpload(fixture.config, fixture.options);
  assert.equal(result.duplicateDelivery, true);
  assert.equal(result.deliveryConfirmed, true);
  assert.ok(fixture.events.some(event => event.level === "warning" && /未确认生成新构建/.test(event.message)));
});

test("zero exit, HTTP 200 and zero uploaded packages cannot be reported as success", async t => {
  for (const logs of ["HTTP 200", "Process exited 0", "0 packages were uploaded successfully:"]) {
    const fixture = pipeline(t, { upload: { code: 0, logs } });
    const result = await runUpload(fixture.config, fixture.options);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(deliveryConfirmed(logs), false);
  }
});

test("a receipt for the old IPA or a missing version guard cannot confirm this upload", () => {
  const header = "MSY_UPLOAD_VERSION_SCOPE=1.0.3\nMSY_UPLOAD_BUILD_ID=NEW-BUILD\n";
  assert.throws(() => uploadReceipt("1 package was uploaded successfully", { version: "1.0.3" }, "abc"), /版本绑定/);
  assert.throws(() => uploadReceipt(header.replace("1.0.3", "1.0.2"), { version: "1.0.3" }, "abc"), /版本绑定/);
  const old = header + "WARN: The software asset has already been uploaded.\nsourceFileChecksum: 0C13E4B94830DC667487DB31CEAE05F2\n1 package was uploaded successfully:";
  assert.throws(() => uploadReceipt(old, { version: "1.0.3", build: "2" }, "e4a70f6342d7e2d52bd75f042a8c5fbc"), { message: "当前版本（1.0.3，Build 2）的 IPA 已经上传了，如需要重新上传请修改版本号（versionCode），再进行上传任务。" });
});

test("authentication failures stop before submitting any IPA", async t => {
  const fixture = pipeline(t, { providerResult: { code: 1, logs: "ERROR ITMS-90000 Authentication failed" } });
  const result = await runUpload(fixture.config, fixture.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /Authentication failed/);
  assert.deepEqual(fixture.calls.map(call => call.args[1]), ["provider"]);
});

test("multiple teams require explicit selection and never trigger trial uploads", async t => {
  const fixture = pipeline(t, { providers: "Provider listing:\n1 First ONE\n2 Second TWO" });
  const result = await runUpload(fixture.config, fixture.options);
  assert.equal(result.ok, false);
  assert.deepEqual(result.providerChoices, ["ONE", "TWO"]);
  assert.equal(fixture.calls.length, 1);
  const selected = pipeline(t);
  assert.equal((await runUpload({ ...selected.config, ascProvider: "TWO" }, selected.options)).provider, "TWO");
  assert.deepEqual(selected.calls.map(call => call.args[1]), ["upload"]);
});

test("debug session dumps stay out of IPC logs and errors, without losing Apple's actual error", async t => {
  const logs = `[2026-10-05] <main> DBG-X: SessionId = secret-session\n[2026-10-05] <main> DEBUG: Token = secret-token\n${error90060}`;
  const fixture = pipeline(t, { upload: { code: 31, logs } });
  const result = await runUpload(fixture.config, fixture.options);
  assert.match(result.error, /90060/);
  assert.ok(!JSON.stringify([result, fixture.events]).includes("secret-session"));
  assert.ok(!JSON.stringify([result, fixture.events]).includes("secret-token"));
});

test("provider lists in Apple's text and XML formats produce unique short names", () => {
  assert.deepEqual(parseProviders("Provider Short Name: FIRST\n<providerShortName>SECOND</providerShortName>\nshortName=FIRST"), ["FIRST", "SECOND"]);
});

test("HTTP and SOCKS proxies stay account-specific and clear inherited proxies", () => {
  const base = { ...env, HTTP_PROXY: "http://wrong", ALL_PROXY: "socks5://wrong", NO_PROXY: "*" };
  assert.equal(proxyEnvironment(base, { enabled: false }).HTTP_PROXY, undefined);
  const http = proxyEnvironment(base, { enabled: true, type: "http", host: "127.0.0.1", port: "8080", username: "u@x", password: "p:s" });
  assert.equal(http.HTTPS_PROXY, "http://u%40x:p%3As@127.0.0.1:8080");
  assert.equal(http.ALL_PROXY, undefined);
  const socks = proxyEnvironment(base, { enabled: true, type: "socks5", host: "::1", port: "1080" });
  assert.equal(socks.ALL_PROXY, "socks5://[::1]:1080");
  assert.equal(socks.HTTP_PROXY, undefined);
  assert.equal(base.HTTP_PROXY, "http://wrong");
});

test("Windows launchers preserve literal paths without using system Python or Java", () => {
  const target = "C:\\Program Files\\证书管理\\vendor\\itms\\bin\\iTMSTransporter.cmd";
  const ipa = "C:\\测试包\\100% & ! test.ipa";
  const spec = transporterCommand(target, ["-m", "upload", "-assetFile", ipa, "-p", "@env:IPAUPLOAD_TEST_PASSWORD"], env, "win32");
  assert.equal(spec.command, "cmd.exe");
  assert.equal(spec.args[1], "/v:off");
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.ok(!spec.args.join(" ").includes(ipa));
  assert.ok(Object.values(spec.env).includes(ipa));
  assert.ok(Object.values(spec.env).includes(target));
  assert.equal(spec.env.ITMS_TRANSPORTER_JAVA_HOME, env.ITMS_TRANSPORTER_JAVA_HOME);
  assert.throws(() => transporterCommand(target, ['bad"argument'], env, "win32"), /不支持的字符/);
  assert.equal(transporterCommand("C:\\bundle\\iTMSTransporter.exe", ["-m", "upload"], env, "win32").command, "C:\\bundle\\iTMSTransporter.exe");
});

test("real subprocess output captures fragmented UTF-8, stderr and an unterminated last line", async () => {
  const lines = [];
  const script = "const text=Buffer.from('出错：90060\\n');process.stderr.write(text.subarray(0,1));setTimeout(()=>{process.stderr.write(text.subarray(1));process.stdout.write('Last line');},20);";
  const result = await runCommand({ command: process.execPath, args: ["-e", script], env: process.env, timeoutMs: 2000, onLine: line => lines.push(line) });
  assert.equal(result.code, 0);
  assert.ok(lines.includes("出错：90060"));
  assert.ok(lines.includes("Last line"));
});

test("a real subprocess timeout keeps the upload unconfirmed", async t => {
  const timeout = await runCommand({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: process.env, timeoutMs: 50 });
  assert.equal(timeout.timedOut, true);
  const fixture = pipeline(t, { upload: timeout });
  assert.equal((await runUpload(fixture.config, fixture.options)).uncertain, true);
});

async function workerFixture(t, scenario, validateOnly = false, workerRuntime = process.execPath) {
  const settings = sourceIPA(t);
  const folder = path.dirname(settings.ipaPath);
  const tool = path.join(folder, "bin", "fixture-transporter");
  fs.mkdirSync(path.dirname(tool));
  fs.mkdirSync(path.join(folder, "lib"));
  fs.copyFileSync(path.join(__dirname, "../vendor/itms/lib/mayou-upload-guard.jar"), path.join(folder, "lib/mayou-upload-guard.jar"));
  fs.writeFileSync(tool, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const mode=args[args.indexOf('-m')+1];fs.appendFileSync(process.env.IPAUPLOAD_FIXTURE_CALLS,mode+'\\n');if(mode==='provider')console.log('Provider listing:\\n1 Example TEAM12345');else if(mode!=='upload'||!args.includes('-assetFile')||args.includes('-f')){console.error('ERROR: Unsupported IPA command');process.exitCode=1;}else if(process.env.IPAUPLOAD_FIXTURE_SCENARIO==='reject'){process.stderr.write(fs.readFileSync(process.env.IPAUPLOAD_FIXTURE_ERROR));process.exitCode=31;}else {console.log('MSY_UPLOAD_VERSION_SCOPE=1.0.3');console.log('MSY_UPLOAD_BUILD_ID=BUILD-123');console.log('1 package was uploaded successfully:');if(process.env.IPAUPLOAD_FIXTURE_SCENARIO==='late-error'){process.stderr.write(fs.readFileSync(process.env.IPAUPLOAD_FIXTURE_ERROR));process.exitCode=31;}}if(process.env.IPAUPLOAD_FIXTURE_SCENARIO==='secret')console.log(process.env.IPAUPLOAD_TEST_PASSWORD+' '+process.env.ALL_PROXY);`, { mode: 0o755 });
  const callsFile = path.join(folder, "calls.txt");
  const child = spawn(workerRuntime, [path.join(__dirname, "../src/ipa-upload-worker.js")], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", IPAUPLOAD_FIXTURE_SCENARIO: scenario, IPAUPLOAD_FIXTURE_CALLS: callsFile, IPAUPLOAD_FIXTURE_ERROR: path.join(__dirname, "fixtures/apple-framework-version-error.log") }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.end(JSON.stringify({ ...settings, transporterPath: tool, validateOnly, ...(scenario === "secret" ? { proxy: { enabled: true, type: "socks5", host: "127.0.0.1", port: "1080", username: "test", password: 'a:b"c' } } : {}) }));
  const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  return { code, error, output, events: output.trim().split("\n").map(line => JSON.parse(line)), calls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [] };
}

test("actual worker subprocess distinguishes Apple 90060, a delivery receipt and a late error", async t => {
  const rejected = await workerFixture(t, "reject");
  assert.equal(rejected.code, 1);
  assert.deepEqual(rejected.calls, ["provider", "upload"]);
  assert.match(rejected.events.at(-1).error, /90060/);
  const submitted = await workerFixture(t, "submit");
  assert.equal(submitted.code, 0);
  assert.equal(submitted.events.at(-1).deliveryConfirmed, true);
  const late = await workerFixture(t, "late-error");
  assert.equal(late.events.at(-1).ok, false);
  assert.match(late.events.at(-1).error, /90060/);
});

test("worker IPC redacts app passwords and encoded proxy credentials", async t => {
  const result = await workerFixture(t, "secret");
  assert.equal(result.code, 0);
  assert.ok(!result.output.includes(env.IPAUPLOAD_TEST_PASSWORD));
  assert.ok(!result.output.includes('a:b"c'));
  assert.ok(!result.output.includes(encodeURIComponent('a:b"c')));
  assert.ok(result.output.includes("[已隐藏]"));
});

const electronRuntime = process.platform === "darwin" ? path.join(__dirname, "../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron") : path.join(__dirname, "../node_modules/electron/dist/electron.exe");
test("the production worker runs in Electron's bundled runtime without any Apple commands in check-only mode", { skip: process.platform !== "darwin" || !fs.existsSync(electronRuntime) }, async t => {
  const result = await workerFixture(t, "submit", true, electronRuntime);
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(result.calls, []);
  assert.equal(result.events.at(-1).validatedOnly, true);
});
