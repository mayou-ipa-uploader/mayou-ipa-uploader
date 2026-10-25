"use strict";

// Runs with Electron's bundled Node runtime on both macOS and Windows.
// Every Apple command uses the application's bundled Transporter and Java.
const { spawn } = require("node:child_process");
const { randomBytes, createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspectIPA } = require("./ipa-upload-state");
const binaryPlist = require("bplist-parser");
const xmlPlist = require("plist");

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FAILURE = /UPLOAD FAILED|VALIDATION FAILED|verification failed|failed to upload (?:package|archive)|ExitFailure|this bundle is invalid|ERROR ITMS-|\bERROR:\s|\b(?:iris-code|code)\s*:\s*90\d{3}\b/i;

function appleError(output) {
  const lines = String(output || "").trim().split(/\r?\n/);
  const start = lines.findIndex(line => FAILURE.test(line) || /NSLocalizedFailureReason|NSLocalizedDescription|Error Domain=/.test(line));
  return lines.slice(start < 0 ? 0 : start).join("\n") || "苹果上传组件未提供详细错误";
}

function deliveryConfirmed(output) {
  if (/\b0 packages? (?:was|were) (?:uploaded successfully|successfully uploaded)\b|UPLOAD SUCCEEDED with 0 packages?/i.test(output)) return false;
  return /\b[1-9]\d* packages? (?:was|were) (?:uploaded successfully|successfully uploaded)\b|\bUPLOAD SUCCEEDED\b|\bNo errors uploading\b|\bdelivery succeeded\b/i.test(output);
}

function duplicateDelivery(output) {
  return /the software asset has already been uploaded|asset (?:has )?already (?:been )?uploaded/i.test(output);
}

function uploadReceipt(output, metadata, checksumMD5) {
  const scopes = [...String(output).matchAll(/^MSY_UPLOAD_VERSION_SCOPE=(\S+)\s*$/gm)].map(match => match[1]);
  const ids = [...new Set([...String(output).matchAll(/^MSY_UPLOAD_BUILD_ID=([A-Za-z0-9-]+)\s*$/gm)].map(match => match[1]))];
  if (!scopes.length || scopes.some(version => version !== metadata.version) || ids.length !== 1) {
    throw new Error("未取得与本次版本绑定的苹果构建回执，不能确认上传成功。请更新完整的软件后重试");
  }
  if (duplicateDelivery(output)) {
    const hashes = [...String(output).matchAll(/sourceFileChecksum:\s*([A-Fa-f0-9]{32})/g)].map(match => match[1].toLowerCase());
    if (!hashes.length || hashes.some(hash => hash !== checksumMD5.toLowerCase())) {
      throw new Error(`当前版本（${metadata.version}，Build ${metadata.build}）的 IPA 已经上传了，如需要重新上传请修改版本号（versionCode），再进行上传任务。`);
    }
  }
  return { receiptBuildId: ids[0], versionBound: true };
}

function parseProviders(output) {
  const providers = new Set();
  const patterns = [
    /(?:Provider\s+Short\s+Name|providerShortName|shortName)\s*[:=]\s*([A-Za-z0-9_.-]+)/gi,
    /<(?:providerShortName|shortName|itc_provider)>\s*([^<\s]+)\s*<\//gi,
  ];
  for (const pattern of patterns) for (const match of output.matchAll(pattern)) providers.add(match[1]);
  let table = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (/provider listing/i.test(line)) { table = true; continue; }
    if (!table || /short name/i.test(line) || /^[\[<{]/.test(line)) continue;
    const match = line.match(/^\d+\s+.+?\s+([A-Za-z0-9_.-]{2,})\s*$/);
    if (match && !/^(?:name|short|provider)$/i.test(match[1])) providers.add(match[1]);
  }
  return [...providers];
}

function proxyEnvironment(base, proxy) {
  const env = { ...base };
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) delete env[key];
  if (!proxy?.enabled) return env;
  const host = String(proxy.host || "").trim();
  const port = String(proxy.port || "");
  const type = String(proxy.type || "http").toLowerCase();
  if (!host || !/^\d+$/.test(port) || +port < 1 || +port > 65535 || !["http", "socks5"].includes(type)) throw new Error("账户上传代理配置不完整或类型不支持");
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ""}@` : "";
  const url = `${type}://${auth}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  for (const key of type === "http" ? ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] : ["all_proxy", "ALL_PROXY"]) env[key] = url;
  return env;
}

function transporterCommand(toolPath, args, env, platform = process.platform) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(toolPath)) return { command: toolPath, args, env };
  // Expand arguments once from the environment, with delayed expansion off.
  // File names containing %, &, ! or spaces never become command text.
  const childEnv = { ...env };
  const prefix = `IPAUPLOAD_ARG_${randomBytes(8).toString("hex").toUpperCase()}`;
  const tokens = [toolPath, ...args].map((arg, index) => {
    if (/["\r\n\0]/.test(arg)) throw new Error("Windows 上传参数包含不支持的字符");
    const key = `${prefix}_${index}`;
    childEnv[key] = arg;
    return `"%${key}%"`;
  });
  return { command: env.COMSPEC || "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${tokens.join(" ")}"`], env: childEnv, windowsVerbatimArguments: true };
}

function runCommand({ command, args, env, windowsVerbatimArguments, timeoutMs, onLine = () => {}, spawnProcess = spawn }) {
  return new Promise(resolve => {
    let logs = "";
    let bytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let settled = false;
    let timer;
    let killTimer;
    let child;
    const stop = () => {
      if (!child.pid) { child.kill(); return; }
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
        if (!killTimer) killTimer = setTimeout(() => {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, 3000);
        killTimer?.unref?.();
      }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ logs, timedOut, outputLimit, ...result });
    };
    try { child = spawnProcess(command, args, { env, windowsVerbatimArguments, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }); }
    catch (error) { finish({ code: null, error: error.message }); return; }
    const readers = [];
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      const consume = text => {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) onLine(line.trim());
      };
      stream.on("data", chunk => {
        if (settled || outputLimit) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) { outputLimit = true; stop(); return; }
        const text = decoder.write(chunk);
        logs += text;
        consume(text);
      });
      readers.push(() => { consume(decoder.end()); if (buffer.trim()) onLine(buffer.trim()); });
      stream.on("error", error => { stop(); finish({ code: null, error: error.message }); });
    }
    child.on("error", error => finish({ code: null, error: error.message }));
    child.on("close", (code, signal) => { for (const flush of readers) flush(); finish({ code, signal }); });
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref?.();
  });
}

function commandFailure(result, stage) {
  if (result.timedOut) return { ok: false, uncertain: true, error: `${stage}超时，未取得苹果最终确认。请查询处理结果后再决定是否重试。` };
  if (result.outputLimit) return { ok: false, uncertain: true, error: `${stage}日志超过读取上限，无法确认最终结果。` };
  if (result.error) return { ok: false, error: `${stage}执行失败：${result.error}` };
  if (result.code !== 0 || FAILURE.test(result.logs)) return { ok: false, error: appleError(result.logs) };
  return null;
}

// A private copy ensures Apple's validation and upload see the same bytes,
// even if the user replaces the selected file while the task is running.
async function prepareIPA(config, env) {
  const folder = await fs.promises.mkdtemp(path.join(env.TMPDIR || env.TEMP || os.tmpdir(), "ipa-upload-"));
  const cleanup = () => fs.promises.rm(folder, { recursive: true, force: true });
  try {
    const before = await fs.promises.stat(config.ipaPath);
    if (!before.isFile()) throw new Error("请选择有效的 IPA 文件");
    const snapshot = path.join(folder, "app.ipa");
    await fs.promises.copyFile(config.ipaPath, snapshot, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(snapshot, 0o600);
    const after = await fs.promises.stat(config.ipaPath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error("IPA 文件在读取期间发生变化，请重新选择文件");
    const metadata = await inspectIPA(snapshot);
    if (config.metadata && ["bundleId", "version", "build", "platform"].some(key => config.metadata[key] !== metadata[key])) throw new Error("IPA 文件信息已经变化，请重新选择后上传");
    const hash = createHash("md5");
    for await (const chunk of fs.createReadStream(snapshot)) hash.update(chunk);
    let assetDescription = "";
    if (config.assetDescriptionPath && !config.validateOnly) {
      const descriptionStat = await fs.promises.stat(config.assetDescriptionPath);
      if (!descriptionStat.isFile() || descriptionStat.size > 32 * 1024 * 1024) throw new Error("AppStoreInfo.plist 无效或超过 32 MB");
      assetDescription = path.join(folder, "AppStoreInfo.plist");
      await fs.promises.copyFile(config.assetDescriptionPath, assetDescription);
      await fs.promises.chmod(assetDescription, 0o600);
      const bytes = await fs.promises.readFile(assetDescription);
      const description = bytes.subarray(0, 8).toString() === "bplist00" ? binaryPlist.parseBuffer(bytes)[0] : xmlPlist.parse(bytes.toString("utf8"));
      const bundle = description?.["product-metadata"]?.packages?.[0]?.bundles?.[0];
      if (!bundle || bundle["bundle-identifier"] !== metadata.bundleId || String(bundle.CFBundleShortVersionString) !== metadata.version || String(bundle.CFBundleVersion) !== metadata.build) {
        throw new Error("AppStoreInfo.plist 与所选 IPA 的 Bundle ID、版本号或 Build 不一致，请选择同次导出的文件");
      }
    }
    return { snapshot, metadata, assetDescription, checksumMD5: hash.digest("hex"), cleanup };
  } catch (error) { await cleanup(); throw error; }
}

function publicAppleLog(output) {
  // Apple's debug dumps contain session tokens and internal request bodies.
  // Retain informational output and complete, original ERROR sections.
  return String(output || "").split(/\r?\n/).filter(line => !/<[^>]+>\s+(?:DEBUG|DBG-X):/.test(line)).join("\n")
    .replace(/\b(assetToken|SessionId|SharedSecret|access_token|refresh_token|Authorization)\s*[:=][^\r\n]*/gi, "$1: [已隐藏]");
}

async function runUpload(config, { run = runCommand, env = process.env, platform = process.platform, emit = () => {} } = {}) {
  emit({ type: "stage", stage: "inspection" });
  emit({ type: "event", level: "info", message: "正在读取 IPA 的 Bundle ID、版本号和 Build，版本格式由苹果校验。" });
  const prepared = await prepareIPA(config, env);
  try {
    if (config.validateOnly) return { ok: true, validatedOnly: true, deliveryConfirmed: false, metadata: prepared.metadata };
    if (platform === "win32" && !prepared.assetDescription) throw new Error("Windows 上传需要与 IPA 同次导出的 AppStoreInfo.plist，请在软件中选择该文件后上传（无需在 Windows 安装 Xcode）");
    if (!env[config.passwordEnv]) throw new Error("缺少 App 专用密码");
    emit({ type: "stage", stage: "provider" });
    const childEnv = proxyEnvironment(env, config.proxy);
    const guardPath = path.resolve(path.dirname(config.transporterPath), "../lib/mayou-upload-guard.jar");
    if (!fs.existsSync(guardPath)) throw new Error("软件内置的上传版本校验组件缺失，请重新安装完整的软件");
    childEnv.IPAUPLOAD_EXPECTED_VERSION = prepared.metadata.version;
    childEnv.JAVA_TOOL_OPTIONS = `${childEnv.JAVA_TOOL_OPTIONS || ""} "-javaagent:${guardPath.replace(/([\\"])/g, "\\$1")}"`.trim();
    const auth = ["-u", config.appleId, "-p", "@env:" + config.passwordEnv];
    const command = async (args, timeoutMs, quiet = false) => {
      const spec = transporterCommand(config.transporterPath, platform === "win32" ? [...args, "-WONoPause", "true"] : args, childEnv, platform);
      const result = await run({ ...spec, timeoutMs, onLine: line => {
        const safe = publicAppleLog(line);
        if (!quiet && safe) emit({ type: "event", level: FAILURE.test(safe) ? "error" : /\bWARN(?:ING)?\b/i.test(safe) ? "warning" : "info", message: safe });
      } });
      return { ...result, logs: publicAppleLog(result.logs) };
    };
    let providers = config.ascProvider ? [config.ascProvider] : [];
    if (!providers.length) {
      emit({ type: "event", level: "info", message: "正在查询当前 Apple ID 的苹果上传团队。" });
      const result = await command(["-m", "provider", ...auth, "-account_type", "itunes_connect", "-v", "informational"], 120000, true);
      const failure = commandFailure(result, "上传团队查询");
      if (failure) return failure;
      providers = parseProviders(result.logs);
      if (!providers.length) return { ok: false, error: "苹果未返回可识别的上传团队，无法选择上传目标" };
    }
    if (providers.length !== 1) return { ok: false, providerChoices: providers, error: "当前 Apple ID 有多个上传团队，请选择所属团队后再上传：" + providers.join("、") };
    const provider = providers[0];
    emit({ type: "stage", stage: "upload" });
    emit({ type: "event", level: "info", message: "IPA 信息已读取。正在使用软件内置的苹果组件进行正式校验及上传，上传团队：" + provider + "。" });
    // Current Apple services reject legacy .itmsp IPA verification (1046).
    // The supported upload command validates the asset and returns real errors.
    const result = await command(["-m", "upload", "-assetFile", prepared.snapshot, ...(prepared.assetDescription ? ["-assetDescription", prepared.assetDescription] : []), ...auth, "-asc_provider", provider, "-t", "HTTP", "-v", "informational"], 3600000);
    const failure = commandFailure(result, "IPA 上传");
    if (failure) return failure;
    if (!deliveryConfirmed(result.logs)) return { ok: false, uncertain: true, error: "上传进程已退出，但未取得苹果文件提交回执。请查询苹果处理结果后再决定是否重试。" };
    let receipt;
    try { receipt = uploadReceipt(result.logs, prepared.metadata, prepared.checksumMD5); }
    catch (error) { return { ok: false, uncertain: true, error: error.message }; }
    const duplicate = duplicateDelivery(result.logs);
    emit({ type: "event", level: duplicate ? "warning" : "info", message: duplicate ? "苹果提示该文件此前已经上传，本次未确认生成新构建。仍需核对苹果构建处理结果。" : "已取得苹果文件提交回执；还需核对后续构建处理结果。" });
    return { ok: true, deliveryConfirmed: true, duplicateDelivery: duplicate, provider, metadata: prepared.metadata, ...receipt };
  } finally { await prepared.cleanup(); }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new Error("上传参数过大");
  }
  const config = JSON.parse(input);
  const childEnv = config.validateOnly ? process.env : proxyEnvironment(process.env, config.proxy);
  const secrets = [process.env[config.passwordEnv], config.proxy?.password, config.proxy?.password && encodeURIComponent(config.proxy.password), ...["http_proxy", "https_proxy", "all_proxy"].map(key => childEnv[key])].filter(Boolean);
  const redact = text => secrets.reduce((value, secret) => value.split(secret).join("[已隐藏]"), String(text));
  const send = event => process.stdout.write(JSON.stringify({ ...event, ...(event.message !== undefined ? { message: redact(event.message) } : {}), ...(event.error !== undefined ? { error: redact(event.error) } : {}) }) + "\n");
  try {
    const result = await runUpload(config, { emit: send });
    send({ type: "finish", ...result });
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    send({ type: "event", level: "error", message: error.message });
    send({ type: "finish", ok: false, error: error.message });
    process.exitCode = 1;
  }
}

module.exports = { appleError, deliveryConfirmed, duplicateDelivery, uploadReceipt, parseProviders, proxyEnvironment, transporterCommand, runCommand, prepareIPA, publicAppleLog, runUpload };
if (require.main === module) main().catch(() => { process.stdout.write(JSON.stringify({ type: "finish", ok: false, error: "上传参数无法读取" }) + "\n"); process.exitCode = 1; });
