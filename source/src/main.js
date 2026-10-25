const { app, BrowserWindow, Menu, session, ipcMain, clipboard, shell, dialog, nativeImage, webContents: electronWebContents } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const crypto = require("node:crypto");
const net = require("node:net");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { execFile, execFileSync, spawn, spawnSync } = require("node:child_process");
const forge = require("node-forge");
const QRCode = require("qrcode");
const { PNG } = require("pngjs");
const isoCountries = require("i18n-iso-countries");
isoCountries.registerLocale(require("i18n-iso-countries/langs/zh.json"));
const { AppleAuthClient } = require("./apple-auth-client");
const { inspectIPA, hasAppleDeliveryConfirmation, queryAppleBuildState, uploadPresentation } = require("./ipa-upload-state");
const { createTestFlightService } = require("./testflight-service");
const { createReviewAttachmentService } = require("./app-review-attachments");
const { StringDecoder } = require("node:string_decoder");

const IS_SYNC_TEST_VARIANT = fs.existsSync(path.join(__dirname, "..", ".sync-test-variant"));
const SYSTEM_SETTINGS_ENABLED = IS_SYNC_TEST_VARIANT;
const DAEMON_HOST = "127.0.0.1";
const DEFAULT_TEST_AUTH_BASE_URL = process.env.IPAUPLOADER_TEST_AUTH_BASE_URL || certificateManagerConfiguredBaseURL("development") || "http://localhost:5051";
const DEFAULT_PRODUCTION_AUTH_BASE_URL = process.env.IPAUPLOADER_PRODUCTION_AUTH_BASE_URL || process.env.IPAUPLOADER_AUTH_BASE_URL || certificateManagerConfiguredBaseURL("production") || "https://similarity.msykeji.com";
const DEFAULT_AUTH_BASE_URL = IS_SYNC_TEST_VARIANT ? DEFAULT_TEST_AUTH_BASE_URL : DEFAULT_PRODUCTION_AUTH_BASE_URL;
const DAEMON_START_PORT = IS_SYNC_TEST_VARIANT ? 55346 : 54346;
const BROWSER_APP_NAME = "码友浏览器";
const APP_ICON = path.join(__dirname, "assets", "icons", "certificate-manager-logo.png");
const SOURCE_APP_ICON_PNG = path.join(__dirname, "..", "assets", "app-icons", "CertificateManagerIcon.png");
const IS_BROWSER_HELPER = process.argv.includes("--browser-helper");
const HELPER_ENV_ID = getArgValue("--env-id");
const OPEN_CDP_PORT = Number(getArgValue("--open-cdp-port") || process.env.IPAUPLOADER_OPEN_CDP_PORT || 0);
const OPEN_ENVIRONMENT_ID = getArgValue("--open-environment-id") || process.env.IPAUPLOADER_OPEN_ENVIRONMENT_ID || "";
const CERTIFICATE_MANAGER_APP_NAMES = new Set(["码友证书管理", "Apple证书管理", "Apple Certificate Manager"]);
const CERTIFICATE_MANAGER_STANDALONE_MARKER = path.join(__dirname, "..", ".certificate-manager-standalone");
const CERTIFICATE_MANAGER_CONTEXT_PATH = getArgValue("--certificate-manager-context");
const CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION = 1;
const CERTIFICATE_MANAGER_REQUIRED_VERSION = process.env.IPAUPLOADER_CERT_MANAGER_VERSION || "0.1.131";
const DEFAULT_P12_PASSWORD = "123456";
let DAEMON = process.env.IPAUPLOADER_DAEMON_URL || "";
const DEBUG_BASE_PORT = 9222;
let activeDebugPort = 0;
const browserWindows = new Map(); // envId -> BrowserWindow
const browserHelperProcesses = new Map(); // envId -> ChildProcess
const openingBrowserIds = new Set();
const snapshotUploadTasks = new Map(); // envId -> Promise
const fingerprintsByEnvironmentId = new Map();
const fingerprintsByUserAgent = new Map();
const webviewEnvironmentIds = new Map(); // webContents.id -> envId
const environmentIdsBySession = new Map(); // Electron Session -> envId
const uploadTasks = new Map();
const uploadStartReservations = new Set();
let daemonProcess = null;
let authLocalServiceProcess = null;
let authLocalServiceStarting = null;
let quittingAfterBrowserSync = false;
let browserShutdownSyncPromise = null;
const localProxyTunnels = new Map(); // envId -> { server, port }
const localProxyErrors = new Map(); // envId -> last tunnel error
const historyStores = new Map();

function certificateManagerConfiguredBaseURL(mode = "production") {
  const candidates = [
    path.join(__dirname, "..", "apple-certificate-manager.config.json"),
    path.join(process.cwd(), "apple-certificate-manager.config.json"),
  ];
  const normalizedMode = mode === "development" ? "development" : "production";
  for (const candidate of candidates) {
    try {
      const config = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const url = String(config?.domains?.[normalizedMode] || "").trim().replace(/\/+$/, "");
      if (/^https?:\/\//i.test(url)) return url;
    } catch {}
  }
  return "";
}

function applyEnvironmentCommandLineSwitches() {
  const webrtcMode = String(process.env.IPAUPLOADER_WEBRTC_MODE || "hide").toLowerCase();
  const uiLanguage = String(process.env.IPAUPLOADER_UI_LANGUAGE || "").trim();
  if (uiLanguage) app.commandLine.appendSwitch("lang", uiLanguage);
  if (webrtcMode === "hide") {
    app.commandLine.appendSwitch("webrtc-ip-handling-policy", "disable_non_proxied_udp");
    app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  } else if (webrtcMode === "replace") {
    app.commandLine.appendSwitch("webrtc-ip-handling-policy", "disable_non_proxied_udp");
    app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  } else if (webrtcMode === "block") {
    app.commandLine.appendSwitch("webrtc-ip-handling-policy", "disable_non_proxied_udp");
    app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  }
  if (process.env.IPAUPLOADER_ALLOW_INSECURE_HTTPS === "1") {
    app.commandLine.appendSwitch("ignore-certificate-errors");
    app.commandLine.appendSwitch("allow-insecure-localhost");
  }
}

applyEnvironmentCommandLineSwitches();
if (IS_BROWSER_HELPER) {
  process.on("SIGTERM", () => {
    const windows = BrowserWindow.getAllWindows().filter(win => win && !win.isDestroyed() && win._envId);
    if (!windows.length) {
      app.quit();
      return;
    }
    windows.forEach(win => win.close());
    setTimeout(() => app.quit(), 5000);
  });
}
let historyWindow = null;
let lastFocusedBrowserWindow = null;
const bookmarkStores = new Map();
let mainWindow = null;
let bookmarkManagerWindow = null;
let certificateManagerWindow = null;
let developerAccountManagerWindow = null;
const authPageWindows = new Map();
let certificateManagerStatusTimer = null;
let certificateManagerBrowserBound = !!CERTIFICATE_MANAGER_CONTEXT_PATH;
let certificateManagerLaunchId = "";
let certificateManagerLaunchContextPromise = Promise.resolve();
const certificateManagerInstanceId = crypto.randomUUID();
let desktopConfigCache = null;
let desktopConfigCacheAt = 0;
let appStoreConnectL10nCache = null;
const APP_STORE_CONNECT_SHORT_CACHE_MS = 2 * 60 * 1000;
const APP_STORE_CONNECT_GLOBAL_CACHE_MS = 15 * 60 * 1000;
const appStoreConnectValueCache = new Map();
let appleDeveloperLaunchAppleId = "";
let appleDeveloperLaunchPassword = "";
let appleDeveloperP12Password = DEFAULT_P12_PASSWORD;
let appleDeveloperOwnerKey = "";
let appleDeveloperAuthUserId = "";
let appleDeveloperRecordId = "";
let appleDeveloperCertificateEnvironment = null;
let appleDeveloperAuthenticated = false;
let appleDeveloperNetwork = null;
let appleDeveloperLaunchNetwork = { enabled: false, mode: "direct" };
let appleDeveloperProxyCredentials = null;
let appleAuthClient = null;
let appleDeveloperNetworkRestoreAttempted = false;
let appleDeveloperNetworkRestoreError = null;
let appleDeveloperNetworkRestorePromise = null;
let appleDeveloperNetworkRestoreAccountKey = "";
let appleDeveloperSessionInfo = null;
let appleDeveloperCookiesRestoreAttempted = false;
let appleDeveloperSelectedTeam = null;
let appleDeveloperAccountKey = "legacy";
let appleDeveloperSessionRefreshPromise = null;
let appleDeveloperSessionRefreshAccountKey = "";
let appleDeveloperLoginInFlight = false;
let appleDeveloperLoginCompletionPromise = null;
let appStoreConnectSessionRefreshPromise = null;
let appStoreConnectSessionRefreshAccountKey = "";
let appStoreConnectForceFullLoginRequired = false;
// App Store Connect starts returning transient 401/5xx responses when the
// browser session receives a burst of requests (the App page can fan out to
// dozens of resources). Keep a small shared queue so all callers, including
// the home overview and detail panes, use the same request cadence.
const APP_STORE_CONNECT_REQUEST_CONCURRENCY = 1;
const APP_STORE_CONNECT_REQUEST_INTERVAL_MS = 120;
const appStoreConnectRequestQueue = [];
let appStoreConnectActiveRequests = 0;
let appStoreConnectLastRequestAt = 0;
let appStoreConnectQueueTimer = null;
let appStoreConnectRequestQueuePaused = false;
const appStoreConnectIdleWaiters = [];
let appStoreConnectLegalEntityMfa = null;
let appStoreConnectBusinessAgreementMfa = null;
let appStoreConnectBankMfa = null;
let appStoreConnectBusinessStatusPromise = null;
let appleDeveloperStatusPromise = null;
let appleDeveloperStatusAccountKey = "";
let appleDeveloperContextGeneration = 0;
let appleDeveloperUserAgent = "";

function drainAppStoreConnectRequestQueue() {
  if (appStoreConnectRequestQueuePaused || appStoreConnectQueueTimer) return;
  while (appStoreConnectActiveRequests < APP_STORE_CONNECT_REQUEST_CONCURRENCY && appStoreConnectRequestQueue.length) {
    const wait = Math.max(0, APP_STORE_CONNECT_REQUEST_INTERVAL_MS - (Date.now() - appStoreConnectLastRequestAt));
    if (wait > 0) {
      appStoreConnectQueueTimer = setTimeout(() => {
        appStoreConnectQueueTimer = null;
        drainAppStoreConnectRequestQueue();
      }, wait);
      return;
    }
    const item = appStoreConnectRequestQueue.shift();
    appStoreConnectActiveRequests += 1;
    appStoreConnectLastRequestAt = Date.now();
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        appStoreConnectActiveRequests -= 1;
        if (appStoreConnectActiveRequests === 0) {
          appStoreConnectIdleWaiters.splice(0).forEach(resolve => resolve());
        }
        drainAppStoreConnectRequestQueue();
      });
  }
}

function enqueueAppStoreConnectRequest(task, priority = false) {
  return new Promise((resolve, reject) => {
    const item = { task, resolve, reject, priority };
    const index = priority ? appStoreConnectRequestQueue.findIndex(queued => !queued.priority) : -1;
    if (index < 0) appStoreConnectRequestQueue.push(item);
    else appStoreConnectRequestQueue.splice(index, 0, item);
    drainAppStoreConnectRequestQueue();
  });
}

async function pauseAppStoreConnectRequestQueue() {
  appStoreConnectRequestQueuePaused = true;
  if (appStoreConnectQueueTimer) {
    clearTimeout(appStoreConnectQueueTimer);
    appStoreConnectQueueTimer = null;
  }
  if (appStoreConnectActiveRequests > 0) {
    await new Promise(resolve => appStoreConnectIdleWaiters.push(resolve));
  }
}

function resumeAppStoreConnectRequestQueue() {
  appStoreConnectRequestQueuePaused = false;
  drainAppStoreConnectRequestQueue();
}

function isCertificateManagerStandalone() {
  return process.env.IPAUPLOADER_CERT_MANAGER_ONLY === "1" || !!CERTIFICATE_MANAGER_CONTEXT_PATH || CERTIFICATE_MANAGER_APP_NAMES.has(app.getName()) || fs.existsSync(CERTIFICATE_MANAGER_STANDALONE_MARKER);
}
function isCertificateManagerBrowserBound() {
  return certificateManagerBrowserBound;
}
function isCertificateManagerIndependent() {
  return isCertificateManagerStandalone() && !isCertificateManagerBrowserBound();
}
// Keep the Apple Developer browser session across application restarts. Browser
// launches and independent launches intentionally use the same Apple login
// partition scheme; launch context only preselects the account/proxy.
function appleDeveloperPartitionForAccount(accountKey = appleDeveloperAccountKey) {
  return `persist:apple-developer-${String(accountKey || "legacy").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function appleAccountPartitionForAccount(accountKey = appleDeveloperAccountKey) {
  return `persist:apple-account-${String(accountKey || "legacy").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function appleDeveloperPartition() {
  return appleDeveloperPartitionForAccount();
}

function appleDeveloperRequestUserAgent() {
  const ses = session.fromPartition(appleDeveloperPartition());
  const current = String(ses.getUserAgent() || appleDeveloperUserAgent || "");
  if (current && /^[\u0000-\u00ff]*$/.test(current)) return current;
  return ensureAppleDeveloperUserAgent(ses);
}

function appleDeveloperAccountStorageDir(accountKey = appleDeveloperAccountKey) {
  return path.join(certificateManagerDataDir(), "apple-developer-accounts", String(accountKey || "legacy").replace(/[^A-Za-z0-9_-]/g, ""));
}

function appleDeveloperUserAgentPath(accountKey = appleDeveloperAccountKey) {
  return path.join(appleDeveloperAccountStorageDir(accountKey), "user-agent.txt");
}

function persistentPartitionDataDir(partitionName) {
  const name = String(partitionName || "").replace(/^persist:/, "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!name) throw new Error("持久化会话名称无效");
  return path.join(app.getPath("userData"), "Partitions", name);
}

async function clearPersistentSessionData(partitionName) {
  const targetSession = session.fromPartition(partitionName);
  const warnings = [];
  const run = async (label, operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      warnings.push(`${label}: ${error.message || error}`);
      return false;
    }
  };

  await run("close-connections", () => targetSession.closeAllConnections());
  let browsingDataCleared = false;
  if (typeof targetSession.clearData === "function") {
    browsingDataCleared = await run("browsing-data", () => targetSession.clearData());
  }
  const storageDataCleared = await run("storage-data", () => targetSession.clearStorageData());
  const httpCacheCleared = await run("http-cache", () => targetSession.clearCache());
  let codeCacheCleared = typeof targetSession.clearCodeCaches !== "function";
  if (typeof targetSession.clearCodeCaches === "function") {
    codeCacheCleared = await run("code-cache", () => targetSession.clearCodeCaches({}));
  }
  if (typeof targetSession.clearAuthCache === "function") {
    await run("auth-cache", () => targetSession.clearAuthCache());
  }
  if (typeof targetSession.clearHostResolverCache === "function") {
    await run("host-cache", () => targetSession.clearHostResolverCache());
  }
  if (typeof targetSession.clearSharedDictionaryCache === "function") {
    await run("shared-dictionary", () => targetSession.clearSharedDictionaryCache());
  }

  targetSession.flushStorageData();
  await run("cookie-flush", () => targetSession.cookies.flushStore());
  let remainingCookies = await targetSession.cookies.get({});
  if (remainingCookies.length) {
    await Promise.all(remainingCookies.map(cookie => {
      const host = String(cookie.domain || "").replace(/^\./, "");
      if (!host || !cookie.name) return Promise.resolve();
      return targetSession.cookies.remove(
        `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
        cookie.name,
      ).catch(error => warnings.push(`cookie-${cookie.name}: ${error.message || error}`));
    }));
    await run("cookie-flush", () => targetSession.cookies.flushStore());
    remainingCookies = await targetSession.cookies.get({});
  }
  await run("close-connections", () => targetSession.closeAllConnections());
  if (remainingCookies.length) throw new Error(`仍有 ${remainingCookies.length} 个 Cookie 未删除`);
  if (warnings.length) console.warn(`clear ${partitionName} warnings:`, warnings.join("; "));
  return {
    browsingDataCleared: browsingDataCleared || (storageDataCleared && httpCacheCleared),
    codeCacheCleared,
  };
}

async function clearDeveloperAccountCaches(accountKey, appleId = "") {
  const key = String(accountKey || "legacy").replace(/[^A-Za-z0-9_-]/g, "");
  const partitions = [
    appleDeveloperPartitionForAccount(key),
    appleAccountPartitionForAccount(key),
  ];
  const cleanupResults = new Map();
  for (const partitionName of partitions) {
    cleanupResults.set(partitionName, await clearPersistentSessionData(partitionName));
  }

  fs.rmSync(appleDeveloperAccountStorageDir(key), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const transporterKey = crypto.createHash("sha256").update(String(appleId || "").trim().toLowerCase(), "utf8").digest("hex");
  fs.rmSync(path.join(app.getPath("userData"), "transporter-accounts", transporterKey), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  for (const partitionName of partitions) {
    try {
      fs.rmSync(persistentPartitionDataDir(partitionName), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      // The Electron network service can retain a Windows file handle until
      // process exit. Its data is already cleared by clearPersistentSessionData.
      const result = cleanupResults.get(partitionName);
      if (!result?.browsingDataCleared || !result?.codeCacheCleared) {
        throw new Error(`账户缓存清理未完成: ${error.message}`);
      }
      console.warn(`remove ${partitionName} directory failed:`, error.message);
    }
  }
  clearAppStoreConnectValueCache();
}

function deleteCertificateManagerAccountEnvironment(ownerKey, accountKey) {
  const owner = String(ownerKey || "").trim();
  const key = String(accountKey || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!owner || !key) return;
  withCertificateManagerEnvironmentsDatabase(db => {
    db.prepare("DELETE FROM certificate_environments WHERE owner_key=? AND account_key=?").run(owner, key);
  });
}

function invalidateAppleDeveloperRuntimeForAccountSwitch() {
  appleDeveloperContextGeneration += 1;
  appleAuthClient = null;
  appleDeveloperSelectedTeam = null;
  appleDeveloperSessionInfo = null;
  appleDeveloperAuthenticated = false;
  appleDeveloperSessionRefreshPromise = null;
  appleDeveloperSessionRefreshAccountKey = "";
  appStoreConnectSessionRefreshPromise = null;
  appStoreConnectSessionRefreshAccountKey = "";
  appStoreConnectForceFullLoginRequired = false;
  appStoreConnectLegalEntityMfa = null;
  appStoreConnectBusinessAgreementMfa = null;
  appStoreConnectBankMfa = null;
  appleDeveloperStatusPromise = null;
  appleDeveloperStatusAccountKey = "";
  appStoreConnectBusinessStatusPromise = null;
}

function appleDeveloperContextIsCurrent(generation, accountKey) {
  return generation === appleDeveloperContextGeneration && accountKey === appleDeveloperAccountKey;
}

function tagAppleAuthClient(client) {
  client.accountKey = appleDeveloperAccountKey;
  client.contextGeneration = appleDeveloperContextGeneration;
  return client;
}

function appleAuthClientIsCurrent(client) {
  return !!client && appleDeveloperContextIsCurrent(client.contextGeneration, client.accountKey);
}

function appleDeveloperSecondFactorPending() {
  return !!(!appleDeveloperAuthenticated && appleAuthClientIsCurrent(appleAuthClient) && appleAuthClient?.secondFactorAuthInitialized);
}

async function waitForAppleContextRefreshes(includeLogin = false) {
  const pending = [appleDeveloperNetworkRestorePromise, appleDeveloperSessionRefreshPromise, appStoreConnectSessionRefreshPromise, appleDeveloperStatusPromise].filter(Boolean);
  if (includeLogin && appleDeveloperLoginCompletionPromise) pending.push(appleDeveloperLoginCompletionPromise);
  if (pending.length) await Promise.allSettled(pending);
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateAppleDeveloperUserAgent() {
  const major = String(process.versions.chrome || "148").split(".")[0] || "148";
  const macVersions = ["10_15_7", "11_7_10", "12_7_6", "13_6_9", "14_6_1"];
  const version = `${major}.0.${randomInt(7200, 7799)}.${randomInt(80, 299)}`;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X ${macVersions[randomInt(0, macVersions.length - 1)]}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

function readAppleDeveloperUserAgent() {
  try {
    const value = fs.readFileSync(appleDeveloperUserAgentPath(), "utf8").trim();
    return value && /^[\u0000-\u00ff]*$/.test(value) ? value : "";
  } catch {
    return "";
  }
}

function saveAppleDeveloperUserAgent(value) {
  appleDeveloperUserAgent = String(value || "").trim();
  if (!appleDeveloperUserAgent) return;
  fs.mkdirSync(appleDeveloperAccountStorageDir(), { recursive: true });
  fs.writeFileSync(appleDeveloperUserAgentPath(), appleDeveloperUserAgent, { mode: 0o600 });
}

function ensureAppleDeveloperUserAgent(ses, { rotate = false } = {}) {
  const targetSession = ses || session.fromPartition(appleDeveloperPartition());
  let value = rotate ? "" : (appleDeveloperUserAgent || readAppleDeveloperUserAgent());
  if (!value || !/^[\u0000-\u00ff]*$/.test(value)) value = generateAppleDeveloperUserAgent();
  targetSession.setUserAgent(value);
  saveAppleDeveloperUserAgent(value);
  return value;
}
let downloadEntries = [];
let downloadsLoaded = false;
let activeBrowserSerialBadge = "";
const browserSerialOverlayIcons = new Map();
let roundedLogoIcon = null;
let bundleAppIcon = null;

// When the app is launched from a terminal that later exits, stdout/stderr can
// become a broken pipe. Node may surface that as an uncaught exception from
// console.log/console.error, so keep logging from taking down the UI process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", err => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
}

app.on("login", (event, webContents, _request, authInfo, callback) => {
  const isAppleDeveloperSession = webContents?.session === session.fromPartition(appleDeveloperPartition());
  if (authInfo?.isProxy && isAppleDeveloperSession) {
    event.preventDefault();
    const credentials = appleDeveloperProxyCredentials;
    if (credentials && String(authInfo.host || "") === credentials.host) {
      callback(credentials.username, credentials.password);
    } else {
      callback("", "");
    }
    return;
  }
  const credentials = appleDeveloperProxyCredentials;
  if (!credentials || !authInfo?.isProxy || String(authInfo.host || "") !== credentials.host) return;
  event.preventDefault();
  callback(credentials.username, credentials.password);
});

process.on("uncaughtException", err => {
  if (err && err.code === "EPIPE") return;
  throw err;
});

for (const method of ["log", "warn", "error", "info", "debug"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    try {
      original(...args);
    } catch (err) {
      if (err && err.code === "EPIPE") return;
      throw err;
    }
  };
}

function resolvedAppName() {
  if (IS_BROWSER_HELPER) return IS_SYNC_TEST_VARIANT ? `${BROWSER_APP_NAME}内核测试` : BROWSER_APP_NAME;
  if (isCertificateManagerStandalone()) return "码友证书管理";
  return IS_SYNC_TEST_VARIANT ? `${BROWSER_APP_NAME}测试` : BROWSER_APP_NAME;
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

function getArgValueFromList(args, name) {
  const values = Array.isArray(args) ? args : [];
  const prefix = `${name}=`;
  const inline = values.find(arg => typeof arg === "string" && arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : "";
}

app.setName(resolvedAppName());
if (process.platform === "win32") {
  app.setAppUserModelId(IS_BROWSER_HELPER ? "com.ipauploader.browser" : "com.ipauploader.manager");
}
const HAS_SINGLE_INSTANCE_LOCK = IS_BROWSER_HELPER ? true : app.requestSingleInstanceLock({
  mode: isCertificateManagerStandalone() ? "certificate-manager" : "browser-manager",
});
if (!HAS_SINGLE_INSTANCE_LOCK) {
  app.quit();
}
app.on("second-instance", (_event, commandLine) => {
  if (IS_BROWSER_HELPER) return;
  if (isCertificateManagerStandalone()) {
    const contextPath = getArgValueFromList(commandLine, "--certificate-manager-context");
    if (contextPath) {
      certificateManagerLaunchContextPromise = certificateManagerLaunchContextPromise
        .then(() => acceptCertificateManagerLaunchContext(contextPath, { reloadWindow: true }))
        .catch(error => console.warn("accept second certificate-manager launch failed:", error.message));
    } else if (!focusWindow(certificateManagerWindow)) {
      openCertificateManagerWindow(null);
    }
    return;
  }
  if (!focusWindow(mainWindow)) createWindow();
  const requestedEnvId = getArgValueFromList(commandLine, "--open-environment-id");
  const requestedDebugPort = Number(getArgValueFromList(commandLine, "--open-cdp-port") || 0);
  if (requestedEnvId) {
    openBrowserHelperProcess(requestedEnvId).catch(error => {
      console.warn("open requested browser environment from second instance failed:", error.message);
    });
  } else if (requestedDebugPort) {
    openBrowserEnvironmentByDebugPort(requestedDebugPort).catch(error => {
      console.warn("[main] open by cdp port from second instance failed:", error && error.message ? error.message : error);
    });
  }
});

function getArgValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function daemonSourceDir() {
  return path.resolve(__dirname, "..", "daemon");
}

function daemonExecutableName() {
  return process.platform === "win32" ? "ipauploader-daemon.exe" : "ipauploader-daemon";
}

function daemonExecutableCandidates() {
  const name = daemonExecutableName();
  const candidates = [
    process.env.IPAUPLOADER_DAEMON_BIN,
    path.join(process.resourcesPath || "", name),
    path.join(process.resourcesPath || "", "bin", name),
    path.join(process.resourcesPath || "", "daemon", name),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "daemon", name),
    path.join(process.resourcesPath || "", "app.asar.unpacked", "bin", name),
    path.resolve(__dirname, "..", "bin", name),
    path.resolve(__dirname, "..", "daemon", name),
    path.resolve(__dirname, "..", "daemon", "bin", name),
  ].filter(Boolean);
  return Array.from(new Set(candidates));
}

function findDaemonExecutable() {
  for (const candidate of daemonExecutableCandidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Ignore inaccessible candidates.
    }
  }
  return "";
}

function daemonAddrFromURL(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return `${DAEMON_HOST}:${DAEMON_START_PORT}`;
  }
}

function setDaemonURL(url) {
  DAEMON = url;
  process.env.IPAUPLOADER_DAEMON_URL = url;
  process.env.IPAUPLOADER_DAEMON_ADDR = daemonAddrFromURL(url);
}

function isPortAvailable(port, host = DAEMON_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findDaemonURL() {
  if (DAEMON) return DAEMON;
  if (IS_BROWSER_HELPER) {
    setDaemonURL(`http://${DAEMON_HOST}:${DAEMON_START_PORT}`);
    return DAEMON;
  }
  for (let port = DAEMON_START_PORT; port < DAEMON_START_PORT + 100; port += 1) {
    if (await isPortAvailable(port)) {
      setDaemonURL(`http://${DAEMON_HOST}:${port}`);
      return DAEMON;
    }
  }
  throw new Error("No available local daemon port");
}

async function isDaemonReady() {
  try {
    await findDaemonURL();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const resp = await fetch(`${DAEMON}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(timeoutMs = 7000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDaemonReady()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function readJSONResponse(resp, fallbackLabel = "请求失败") {
  const text = await resp.text();
  if (!resp.ok) {
    const message = text.trim() || `${fallbackLabel}: HTTP ${resp.status}`;
    throw new Error(`${fallbackLabel}: HTTP ${resp.status} ${message}`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${fallbackLabel}: 返回内容不是 JSON (${text.slice(0, 80)})`);
  }
}

async function ensureDaemonStarted() {
  await findDaemonURL();
  if (IS_BROWSER_HELPER || await isDaemonReady()) return true;

  const daemonBin = findDaemonExecutable();
  if (daemonBin) {
    console.log("[daemon] starting bundled executable:", daemonBin);
    daemonProcess = spawn(daemonBin, [], {
      cwd: path.dirname(daemonBin),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        IPAUPLOADER_DAEMON_URL: DAEMON,
        IPAUPLOADER_DAEMON_ADDR: daemonAddrFromURL(DAEMON),
        IPAUPLOADER_DAEMON_DATA_DIR: daemonDataDir(),
      },
    });
    daemonProcess.stdout.on("data", data => console.log("[daemon]", String(data).trim()));
    daemonProcess.stderr.on("data", data => console.warn("[daemon]", String(data).trim()));
    daemonProcess.on("error", (error) => {
      console.warn("[daemon] bundled executable failed:", error.message);
      daemonProcess = null;
    });
    daemonProcess.on("exit", (code, signal) => {
      console.warn("[daemon] exited", { code, signal });
      daemonProcess = null;
    });
    return waitForDaemon();
  }

  if (app.isPackaged) {
    console.warn("[daemon] bundled executable not found. Checked:", daemonExecutableCandidates());
    return false;
  }

  const cwd = daemonSourceDir();
  if (!fs.existsSync(path.join(cwd, "go.mod"))) {
    console.warn("daemon source not found:", cwd);
    return false;
  }
  console.warn("[daemon] bundled executable not found; falling back to `go run .` for development");
  daemonProcess = spawn("go", ["run", "."], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      IPAUPLOADER_DAEMON_URL: DAEMON,
      IPAUPLOADER_DAEMON_ADDR: daemonAddrFromURL(DAEMON),
      IPAUPLOADER_DAEMON_DATA_DIR: daemonDataDir(),
    },
  });
  daemonProcess.stdout.on("data", data => console.log("[daemon]", String(data).trim()));
  daemonProcess.stderr.on("data", data => console.warn("[daemon]", String(data).trim()));
  daemonProcess.on("error", (error) => {
    console.warn("[daemon] start failed:", error.message);
    daemonProcess = null;
  });
  daemonProcess.on("exit", (code, signal) => {
    console.warn("[daemon] exited", { code, signal });
    daemonProcess = null;
  });
  return waitForDaemon();
}

function stopManagedDaemon() {
  if (!daemonProcess || daemonProcess.killed) return;
  daemonProcess.kill();
  daemonProcess = null;
}

function socketRead(socket, size, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => cleanup(new Error("socket read timeout")), timeoutMs);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= size) {
        const head = buffer.subarray(0, size);
        const rest = buffer.subarray(size);
        cleanup(null, head);
        if (rest.length) socket.unshift(rest);
      }
    };
    const onError = (error) => cleanup(error);
    const onClose = () => cleanup(new Error("socket closed"));
    function cleanup(error, data) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(data);
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function socketWrite(socket, data) {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => error ? reject(error) : resolve());
  });
}

async function readSocks5(socket, size, stage, timeoutMs = 3000) {
  try {
    return await socketRead(socket, size, timeoutMs);
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`);
  }
}

async function drainSocks5ReplyTail(socket, size) {
  try {
    await socketRead(socket, size, 250);
  } catch {
    // Some proxy providers return a successful CONNECT header but omit or delay
    // the bound-address tail. curl tolerates this, so keep the tunnel compatible.
  }
}

async function socks5Dial(proxy, targetHost, targetPort) {
  const socket = net.createConnection({
    host: proxy.host,
    port: Number(proxy.port),
    timeout: 8000,
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("timeout", () => reject(new Error("socks5 connect timeout")));
    socket.once("error", reject);
  });

  const username = String(proxy.username || "");
  const password = String(proxy.password || "");
  if (username || password) {
    await socketWrite(socket, Buffer.from([0x05, 0x01, 0x02]));
    const methodResp = await readSocks5(socket, 2, "SOCKS5 握手超时");
    if (methodResp[0] !== 0x05 || methodResp[1] !== 0x02) {
      socket.destroy();
      throw new Error(`socks5 auth method rejected (${methodResp[0]}, ${methodResp[1]})`);
    }
    const userBuf = Buffer.from(username);
    const passBuf = Buffer.from(password);
    if (userBuf.length > 255 || passBuf.length > 255) {
      socket.destroy();
      throw new Error("socks5 username/password too long");
    }
    await socketWrite(socket, Buffer.concat([
      Buffer.from([0x01, userBuf.length]),
      userBuf,
      Buffer.from([passBuf.length]),
      passBuf,
    ]));
    const authResp = await readSocks5(socket, 2, "SOCKS5 认证响应超时");
    if (authResp[1] !== 0x00) {
      socket.destroy();
      throw new Error("socks5 authentication failed");
    }
  } else {
    await socketWrite(socket, Buffer.from([0x05, 0x01, 0x00]));
    const methodResp = await readSocks5(socket, 2, "SOCKS5 握手超时");
    if (methodResp[0] !== 0x05 || methodResp[1] !== 0x00) {
      socket.destroy();
      throw new Error(`socks5 no-auth method rejected (${methodResp[0]}, ${methodResp[1]})`);
    }
  }

  const hostBuf = Buffer.from(String(targetHost));
  if (hostBuf.length > 255) {
    socket.destroy();
    throw new Error("target host too long");
  }
  const port = Number(targetPort);
  const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
  await socketWrite(socket, Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    portBuf,
  ]));

  const connectHead = await readSocks5(socket, 4, `SOCKS5 连接目标 ${targetHost}:${targetPort} 超时`, 4000);
  if (connectHead[1] !== 0x00) {
    socket.destroy();
    throw new Error(`socks5 connect failed, code=${connectHead[1]}`);
  }
  if (connectHead[3] === 0x01) await drainSocks5ReplyTail(socket, 6);
  else if (connectHead[3] === 0x03) {
    try {
      const len = (await socketRead(socket, 1, 250))[0];
      await drainSocks5ReplyTail(socket, len + 2);
    } catch {
      // See drainSocks5ReplyTail: CONNECT already succeeded.
    }
  } else if (connectHead[3] === 0x04) await drainSocks5ReplyTail(socket, 18);

  socket.setTimeout(0);
  return socket;
}

function parseHTTPProxyTarget(method, target) {
  if (method === "CONNECT") {
    const parsed = new URL(`http://${target}`);
    return { host: parsed.hostname, port: Number(parsed.port || 443), pathOnly: "", scheme: "https" };
  }
  const parsed = new URL(target.includes("://") ? target : `http://${target}`);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    pathOnly: `${parsed.pathname || "/"}${parsed.search || ""}`,
    scheme: parsed.protocol.replace(":", ""),
  };
}

async function handleLocalTunnelConnection(envId, clientConn, proxy) {
  let targetConn = null;
  try {
    const chunks = [];
    let total = 0;
    while (total < 1024 * 1024) {
      const chunk = await new Promise((resolve, reject) => {
        clientConn.once("data", resolve);
        clientConn.once("error", reject);
        clientConn.once("close", () => reject(new Error("client closed")));
      });
      chunks.push(chunk);
      total += chunk.length;
      if (Buffer.concat(chunks, total).includes(Buffer.from("\r\n\r\n"))) break;
    }
    const raw = Buffer.concat(chunks, total);
    const headerEnd = raw.indexOf("\r\n\r\n");
    if (headerEnd < 0) throw new Error("invalid http proxy request");
    const headerBlock = raw.subarray(0, headerEnd + 4).toString("latin1");
    const bodyBlock = raw.subarray(headerEnd + 4);
    const [firstLine, ...restLines] = headerBlock.split("\r\n");
    const [methodRaw, target] = firstLine.split(/\s+/);
    const method = String(methodRaw || "").toUpperCase();
    const info = parseHTTPProxyTarget(method, target);
    targetConn = await socks5Dial(proxy, info.host, info.port);

    if (method === "CONNECT") {
      clientConn.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } else {
      const rewritten = `${method} ${info.pathOnly || "/"} HTTP/1.1\r\n${restLines.join("\r\n")}`;
      targetConn.write(Buffer.concat([Buffer.from(rewritten, "latin1"), bodyBlock]));
    }
    clientConn.pipe(targetConn);
    targetConn.pipe(clientConn);
  } catch (error) {
    if (envId) localProxyErrors.set(envId, error.message);
    console.warn("[proxy] local tunnel request failed:", error.message);
    try { clientConn.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {}
    clientConn.destroy();
    if (targetConn) targetConn.destroy();
  }
}

function startLocalProxyTunnel(envId, proxy) {
  stopLocalProxyTunnel(envId);
  localProxyErrors.delete(envId);
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientConn) => {
      handleLocalTunnelConnection(envId, clientConn, proxy).catch(() => clientConn.destroy());
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      localProxyTunnels.set(envId, { server, port });
      resolve({ port });
    });
  });
}

function stopLocalProxyTunnel(envId) {
  const tunnel = localProxyTunnels.get(envId);
  localProxyErrors.delete(envId);
  if (!tunnel) return;
  localProxyTunnels.delete(envId);
  try { tunnel.server.close(); } catch {}
}

function sharedUserDataDir() {
  return path.join(app.getPath("appData"), IS_SYNC_TEST_VARIANT ? "IPAUploader Sync Test" : "IPAUploader");
}

// The certificate manager keeps its own local account/environment data when it
// is running as the certificate-manager app, regardless of who launched it.
function certificateManagerDataDir() {
  if (!isCertificateManagerStandalone()) return sharedUserDataDir();
  return path.join(app.getPath("appData"), IS_SYNC_TEST_VARIANT ? "码友证书管理 Sync Test" : "码友证书管理");
}

function certificateManagerDiagnosticLogPath() {
  return path.join(certificateManagerDataDir(), "logs", "apple-developer.log");
}

function maskDiagnosticAppleId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const [name, domain] = text.split("@");
  if (!domain) return text.length <= 4 ? "***" : `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${name.slice(0, 2)}***@${domain}`;
}

function logAppleDeveloperDiagnostic(eventName, payload = {}) {
  try {
    const target = certificateManagerDiagnosticLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify({
      at: new Date().toISOString(),
      event: eventName,
      accountKey: appleDeveloperAccountKey,
      appleId: maskDiagnosticAppleId(appleDeveloperLaunchAppleId),
      network: appleDeveloperNetwork ? {
        enabled: appleDeveloperNetwork.enabled === true,
        mode: appleDeveloperNetwork.mode || "",
        ip: appleDeveloperNetwork.ip || "",
        country: appleDeveloperNetwork.country || "",
        region: appleDeveloperNetwork.region || "",
        city: appleDeveloperNetwork.city || "",
        isp: appleDeveloperNetwork.isp || "",
      } : null,
      ...payload,
    })}\n`, { mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}
  } catch {}
}

async function loadAppleDeveloperBootstrapPage(ses) {
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const entryURL = "https://developer.apple.com/login/?return=%2Fcn%2F";
  let win = null;
  let timer;
  let status = 0;
  const isAppleURL = value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password &&
        ["developer.apple.com", "idmsa.apple.com", "account.apple.com", "appleid.apple.com"].includes(url.hostname);
    } catch { return false; }
  };
  try {
    if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
    win = new BrowserWindow({
      show: false,
      width: 980,
      height: 760,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.setUserAgent(ses.getUserAgent());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const eventName of ["will-navigate", "will-redirect"]) {
      win.webContents.on(eventName, (event, url) => { if (!isAppleURL(url)) event.preventDefault(); });
    }
    win.webContents.on("did-navigate", (_event, _url, code) => { status = code; });
    await Promise.race([
      win.loadURL(entryURL),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Apple 登录页加载超时，请稍后重试")), 30000); }),
    ]);
    if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
    if (win.isDestroyed()) throw new Error("Apple 登录页窗口已关闭，请重新登录");
    const url = win.webContents.getURL();
    if (!isAppleURL(url)) throw new Error("Apple 登录页返回了无效的跳转地址");
    const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
    if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
    logAppleDeveloperDiagnostic("auth-bootstrap-native-page", {
      status, host: new URL(url).hostname, path: new URL(url).pathname,
      hasLoginParameters: html.includes("embed_login_boot_args"),
    });
    return { url, status, ok: status >= 200 && status < 300, redirected: url !== entryURL, html };
  } finally {
    clearTimeout(timer);
    if (win && !win.isDestroyed()) win.destroy();
  }
}

function createAppleDeveloperAuthClient(ses, clientFingerprint, options = {}) {
  return tagAppleAuthClient(new AppleAuthClient(ses, {
    clientFingerprint,
    useDeveloperLoginEntry: options.useDeveloperLoginEntry === true,
    developerLoginPageLoader: () => loadAppleDeveloperBootstrapPage(ses),
    logger: (eventName, payload) => logAppleDeveloperDiagnostic(`auth-${eventName}`, payload),
  }));
}

function standaloneLoginHistoryPath() {
  return path.join(certificateManagerDataDir(), "apple-login-history.json");
}

function readStandaloneLoginHistory() {
  if (!isCertificateManagerIndependent()) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(standaloneLoginHistoryPath(), "utf8"));
    if (!Array.isArray(rows)) return [];
    const sanitized = rows.filter(row => row && row.appleId).map(({ password, ...row }) => row);
    if (sanitized.length !== rows.length || rows.some(row => row && Object.prototype.hasOwnProperty.call(row, "password"))) {
      try { writeStandaloneLoginHistory(sanitized); } catch {}
    }
    return sanitized;
  } catch { return []; }
}

function writeStandaloneLoginHistory(rows) {
  const target = standaloneLoginHistoryPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(rows, null, 2), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
}

function removeStandaloneLoginHistory(appleId) {
  if (!isCertificateManagerIndependent()) return;
  const normalized = String(appleId || "").trim().toLowerCase();
  writeStandaloneLoginHistory(readStandaloneLoginHistory().filter(row => String(row.appleId || "").trim().toLowerCase() !== normalized));
}

function recordStandaloneLoginSuccess(appleId) {
  clearAppStoreConnectValueCache();
  try { fs.rmSync(path.join(app.getPath("temp"), "mayou-iap-review-previews"), { recursive: true, force: true }); } catch {}
  if (!isCertificateManagerIndependent()) return;
  const normalized = String(appleId || "").trim().toLowerCase();
  const previous = readStandaloneLoginHistory().filter(row => String(row.appleId).toLowerCase() !== normalized);
  previous.unshift({
    appleId: normalized,
    accountId: appleDeveloperRecordId,
    ownerKey: appleDeveloperOwnerKey,
    userId: appleDeveloperAuthUserId,
    lastIp: String(appleDeveloperNetwork?.ip || ""),
    proxyEnabled: appleDeveloperNetwork?.enabled === true,
    country: String(appleDeveloperNetwork?.country || ""),
    region: String(appleDeveloperNetwork?.region || ""),
    city: String(appleDeveloperNetwork?.city || ""),
    lastLoginAt: new Date().toISOString(),
  });
  writeStandaloneLoginHistory(previous.slice(0, 20));
}

function selectStandaloneLoginHistory(appleId) {
  const row = readStandaloneLoginHistory().find(item => String(item.appleId).toLowerCase() === String(appleId || "").trim().toLowerCase());
  if (!row) return null;
  const previousAccountKey = appleDeveloperAccountKey;
  ensureStandaloneDeveloperAccount(row.appleId);
  if (appleDeveloperAccountKey !== previousAccountKey) {
    // Every account owns a different persistent Electron partition and proxy
    // profile. Never carry the previous account's restored-network flags into
    // the newly selected partition.
    stopLocalProxyTunnel(APPLE_AUTH_TUNNEL_ID);
    invalidateAppleDeveloperRuntimeForAccountSwitch();
    appleDeveloperNetwork = null;
    appleDeveloperProxyCredentials = null;
    appleDeveloperNetworkRestoreAttempted = false;
    appleDeveloperNetworkRestoreError = null;
    appleDeveloperCookiesRestoreAttempted = false;
    appleDeveloperUserAgent = readAppleDeveloperUserAgent();
  }
  return row;
}

function restoreIndependentDeveloperAccount() {
  if (!isCertificateManagerIndependent()) return null;
  if (appleDeveloperRecordId && appleDeveloperLaunchAppleId) return {
    id: appleDeveloperRecordId,
    appleId: appleDeveloperLaunchAppleId,
  };
  const last = readStandaloneLoginHistory()[0];
  if (last?.appleId) {
    const selected = selectStandaloneLoginHistory(last.appleId);
    if (selected && appleDeveloperRecordId) return selected;
  }
  // Login history from older versions can be incomplete. Prefer the cached
  // desktop user and retain boss:1 only as a legacy migration source.
  const identity = independentCertificateManagerIdentity();
  migrateDeveloperAccountsJSON();
  const row = withDeveloperAccountsDatabase(db => db.prepare(
    `SELECT * FROM developer_accounts
     WHERE owner_key IN (?, 'boss:1') AND deleted_at=''
     ORDER BY CASE WHEN owner_key=? THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
  ).get(identity.key, identity.key));
  if (!row?.apple_id) return null;
  return ensureStandaloneDeveloperAccount(row.apple_id);
}

function serverConfigPath() {
  return path.join(sharedUserDataDir(), "server-config.json");
}

function normalizeServerURL(value, fallback = "") {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return fallback;
  try {
    const parsed = new URL(text);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : fallback;
  } catch {
    return fallback;
  }
}

function readServerConfig() {
  const defaults = {
    mode: IS_SYNC_TEST_VARIANT ? "test" : "production",
    testURL: DEFAULT_TEST_AUTH_BASE_URL,
    productionURL: DEFAULT_PRODUCTION_AUTH_BASE_URL,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(serverConfigPath(), "utf8"));
    return {
      mode: SYSTEM_SETTINGS_ENABLED && saved.mode === "test" ? "test" : "production",
      testURL: normalizeServerURL(saved.testURL, defaults.testURL),
      productionURL: normalizeServerURL(saved.productionURL, defaults.productionURL),
    };
  } catch {
    return defaults;
  }
}

function currentAuthBaseURL(config = readServerConfig()) {
  return config.mode === "test" && SYSTEM_SETTINGS_ENABLED ? config.testURL : config.productionURL;
}

function authBaseURLCandidates(baseURL = currentAuthBaseURL()) {
  const primary = String(baseURL || "").replace(/\/+$/, "");
  const candidates = primary ? [primary] : [];
  try {
    const parsed = new URL(primary);
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      const fallback = parsed.toString().replace(/\/+$/, "");
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }
  } catch {}
  return candidates;
}

function isLocalAuthBaseURL(baseURL = currentAuthBaseURL()) {
  try {
    const parsed = new URL(String(baseURL || ""));
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && String(parsed.port || "") === "5051";
  } catch {
    return false;
  }
}

function localAuthServiceDirectory() {
  const candidates = [
    process.env.IPA_SIMILARITY_DIR,
  ].filter(Boolean);
  return candidates.find(dir => fs.existsSync(path.join(dir, "start_local_service.py"))) || "";
}

async function waitForLocalAuthServer(timeoutMs = 9000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const baseURL of authBaseURLCandidates("http://localhost:5051")) {
      try {
        const response = await session.defaultSession.fetch(baseURL, { method: "HEAD", signal: AbortSignal.timeout(900) });
        if (response.ok) return true;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return false;
}

async function ensureLocalAuthServerStarted() {
  if (!isLocalAuthBaseURL()) return false;
  if (await waitForLocalAuthServer(1000)) return true;
  if (authLocalServiceStarting) return authLocalServiceStarting;
  authLocalServiceStarting = (async () => {
    const cwd = localAuthServiceDirectory();
    if (!cwd) return false;
    const command = "APP_ENV=local exec /Library/Frameworks/Python.framework/Versions/3.14/bin/python3.14 start_local_service.py >> logs/app_5051.log 2>&1";
    authLocalServiceProcess = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, APP_ENV: "local" },
    });
    authLocalServiceProcess.unref();
    return waitForLocalAuthServer();
  })().finally(() => { authLocalServiceStarting = null; });
  return authLocalServiceStarting;
}

async function authServerFetch(requestPath, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const baseURL of authBaseURLCandidates()) {
      try {
        const headers = { ...(options.headers || {}) };
        if (appleDeveloperOwnerKey) headers["X-Desktop-Owner-Key"] = appleDeveloperOwnerKey;
        if (appleDeveloperAuthUserId) headers["X-Desktop-User-Id"] = appleDeveloperAuthUserId;
        return await session.defaultSession.fetch(`${baseURL}${requestPath}`, {
          credentials: "include",
          ...options,
          headers,
        });
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt || !await ensureLocalAuthServerStarted()) break;
  }
  throw lastError || new Error("无法连接服务器");
}

async function loadDesktopConfig(options = {}) {
  const maxAgeMs = Number(options.maxAgeMs || 5 * 60 * 1000);
  if (!options.force && desktopConfigCache && Date.now() - desktopConfigCacheAt < maxAgeMs) return desktopConfigCache;
  const response = await authServerFetch("/api/desktop-config", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(Number(options.timeoutMs || 12000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) throw new Error(body?.error || `桌面配置读取失败 (${response.status})`);
  desktopConfigCache = body || {};
  desktopConfigCacheAt = Date.now();
  return desktopConfigCache;
}

function writeServerConfig(config) {
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  fs.writeFileSync(serverConfigPath(), JSON.stringify(config, null, 2));
}

function environmentFilePath() {
  return path.join(sharedUserDataDir(), readServerConfig().mode === "test" ? "environments-test.json" : "environments.json");
}

function browserSerialStatePath() {
  return path.join(sharedUserDataDir(), "browser-serial-state.json");
}

function cloudSyncStatePath() {
  return path.join(sharedUserDataDir(), readServerConfig().mode === "test" ? "browser-cloud-state-test.json" : "browser-cloud-state.json");
}

function readCloudSyncOwnerId() {
  try {
    return String(JSON.parse(fs.readFileSync(cloudSyncStatePath(), "utf8")).ownerUserId || "");
  } catch {
    return "";
  }
}

function writeCloudSyncOwnerId(ownerUserId) {
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  fs.writeFileSync(cloudSyncStatePath(), JSON.stringify({ ownerUserId: String(ownerUserId || "") }, null, 2));
}

function readBrowserSerialState() {
  try {
    const raw = fs.readFileSync(browserSerialStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBrowserSerialState(state) {
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  fs.writeFileSync(browserSerialStatePath(), JSON.stringify(state || {}, null, 2));
}

function highestSerialFromRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
    const value = Number(row && row.serialNum || 0);
    return Number.isInteger(value) && value > max ? value : max;
  }, 0);
}

function usedDebugPorts(rows = []) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map(row => Number(row && row.debugPort || 0))
      .filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535)
  );
}

async function allocateEnvironmentDebugPort(existingRows = []) {
  const used = usedDebugPorts(existingRows);
  for (let port = 10200; port <= 11050; port += 1) {
    if (used.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  for (let port = 11051; port <= 65535; port += 1) {
    if (used.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("没有可用的 CDP 端口");
}

function highestSerialFromState(state = readBrowserSerialState()) {
  return Math.max(Number(state.highestSerial || 0), Number(state.nextSerial || 0) - 1);
}

function allocateEnvironmentSerial(existingRows = []) {
  const highest = Math.max(highestSerialFromState(), highestSerialFromRows(existingRows));
  const nextSerial = highest + 1;
  writeBrowserSerialState({
    highestSerial: nextSerial,
    nextSerial: nextSerial + 1,
    updatedAt: new Date().toISOString(),
  });
  return String(nextSerial);
}

function ensureEnvironmentSerials(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return { rows: [], changed: false };
  let highest = Math.max(highestSerialFromState(), highestSerialFromRows(rows));
  let changed = false;
  const nextRows = rows.map(row => {
    if (row && row.serialNum) return row;
    highest += 1;
    changed = true;
    return { ...row, serialNum: String(highest) };
  });
  writeBrowserSerialState({
    highestSerial: highest,
    nextSerial: highest + 1,
    updatedAt: new Date().toISOString(),
  });
  return { rows: nextRows, changed };
}

function mergeLocalSerials(rows = [], localRows = readLocalEnvironments()) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map(row => {
    if (row && row.serialNum) return row;
    const local = localRows.find(item => String(item && item.id) === String(row && row.id));
    return local && local.serialNum ? { ...row, serialNum: local.serialNum } : row;
  });
}

function readLocalEnvironments() {
  try {
    const raw = fs.readFileSync(environmentFilePath(), "utf8");
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writeLocalEnvironments(rows) {
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  fs.writeFileSync(environmentFilePath(), JSON.stringify(Array.isArray(rows) ? rows : [], null, 2));
}

function createEnvironmentId() {
  return "env-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 8);
}

function normalizeEnvironment(env, previous = {}) {
  const debugPort = Number(env.debugPort ?? previous.debugPort ?? 0);
  const ipGuard = env.ipGuard || previous.ipGuard || {};
  return {
    ...previous,
    ...env,
    id: previous.id || env.id || createEnvironmentId(),
    serialNum: String(previous.serialNum || env.serialNum || ""),
    name: String(env.name || previous.name || "未命名环境"),
    note: String(env.note || ""),
    homeUrl: String(env.homeUrl ?? previous.homeUrl ?? ""),
    debugPort: Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65535 ? debugPort : 0,
    proxy: env.proxy || previous.proxy || { enabled: false },
    ipGuard: {
      enabled: !!ipGuard.enabled,
      expectedIP: String(ipGuard.expectedIP || "").trim(),
    },
    fingerprint: env.fingerprint || previous.fingerprint || {},
    createdAt: previous.createdAt || env.createdAt || new Date().toISOString(),
  };
}

async function fetchDaemonEnvironments() {
  const resp = await fetch(`${DAEMON}/environments`);
  if (!resp.ok) throw new Error(`Daemon request failed: ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

async function loadEnvironmentRows() {
  // The daemon is a runtime mirror, not the source of truth. In particular, it
  // may still contain the previous server's rows for a short time after a
  // server switch. Reading it here would copy those rows into the newly
  // selected server's local file before cloud sync has a chance to run.
  const baseRows = readLocalEnvironments();
  const ensured = ensureEnvironmentSerials(baseRows);
  if (ensured.changed) writeLocalEnvironments(ensured.rows);
  const rows = await loadCloudEnvironmentRows(ensured.rows);
  // Keep the runtime mirror aligned even when the user is signed out or the
  // selected server is temporarily unavailable.
  await replaceDaemonEnvironments(rows);
  return rows;
}

function logoAppIcon(iconPath = APP_ICON) {
  if (roundedLogoIcon) return roundedLogoIcon;
  if (!fs.existsSync(iconPath)) return nativeImage.createEmpty();
  try {
    const canvasSize = 512;
    const iconInset = 50;
    const iconSize = 412;
    const cornerRadius = 93;
    const resized = nativeImage.createFromPath(iconPath).resize({ width: iconSize, height: iconSize, quality: "best" });
    if (resized.isEmpty()) return nativeImage.createEmpty();
    const source = PNG.sync.read(resized.toPNG());
    const output = new PNG({ width: canvasSize, height: canvasSize, colorType: 6 });
    const half = iconSize / 2;
    const innerHalf = half - cornerRadius;
    for (let y = 0; y < iconSize; y += 1) {
      for (let x = 0; x < iconSize; x += 1) {
        const qx = Math.abs(x + 0.5 - half) - innerHalf;
        const qy = Math.abs(y + 0.5 - half) - innerHalf;
        const distance = Math.min(Math.max(qx, qy), 0)
          + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - cornerRadius;
        const coverage = Math.max(0, Math.min(1, 0.5 - distance));
        if (coverage <= 0) continue;
        const sourceOffset = (y * iconSize + x) * 4;
        const outputOffset = ((y + iconInset) * canvasSize + x + iconInset) * 4;
        output.data[outputOffset] = source.data[sourceOffset];
        output.data[outputOffset + 1] = source.data[sourceOffset + 1];
        output.data[outputOffset + 2] = source.data[sourceOffset + 2];
        output.data[outputOffset + 3] = Math.round(source.data[sourceOffset + 3] * coverage);
      }
    }
    roundedLogoIcon = nativeImage.createFromBuffer(PNG.sync.write(output));
  } catch (error) {
    console.warn("rounded application icon failed:", error.message);
    roundedLogoIcon = nativeImage.createFromPath(iconPath);
  }
  return roundedLogoIcon;
}

function currentAppIcon() {
  const helperIcon = String(process.env.IPAUPLOADER_APP_ICON || "").trim();
  if (bundleAppIcon) return bundleAppIcon;
  if (helperIcon && fs.existsSync(helperIcon) && /\.(?:png|jpe?g|webp)$/i.test(helperIcon)) {
    bundleAppIcon = logoAppIcon(helperIcon);
    if (!bundleAppIcon.isEmpty()) return bundleAppIcon;
  }
  for (const iconPath of [helperIcon, path.join(process.resourcesPath, "AppIcon.icns")]) {
    if (!fs.existsSync(iconPath)) continue;
    try {
      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) continue;
      bundleAppIcon = icon;
      return bundleAppIcon;
    } catch (error) {
      console.warn("application icon load failed:", iconPath, error.message);
    }
  }
  return logoAppIcon(APP_ICON);
}

function applyApplicationDockIcon() {
  if (!app.dock) return;
  try {
    const icon = currentAppIcon();
    if (icon && !icon.isEmpty()) app.dock.setIcon(icon);
  } catch (error) {
    // A cosmetic icon failure must never prevent a browser helper from
    // creating its window.
    console.warn("application dock icon failed:", error.message);
  }
}

function isOpenableURL(url) {
  return typeof url === "string" && url.length > 0 && url !== "about:blank";
}

function sendOpenTab(win, url) {
  if (win && !win.isDestroyed() && isOpenableURL(url)) {
    win.webContents.send("browser-open-tab", url);
  }
}

function getActiveBrowserWindow() {
  if (lastFocusedBrowserWindow && !lastFocusedBrowserWindow.isDestroyed()) return lastFocusedBrowserWindow;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && focused._envId) return focused;
  return BrowserWindow.getAllWindows().find(win => !win.isDestroyed() && win._envId) || null;
}

function getEventBrowserWindow(event) {
  const win = BrowserWindow.fromWebContents(event && event.sender);
  return win && !win.isDestroyed() && win._envId ? win : null;
}

function activeEnvironmentId() {
  const win = getActiveBrowserWindow();
  return win && win._envId ? String(win._envId) : "default";
}

function eventEnvironmentId(event) {
  const win = getEventBrowserWindow(event);
  return win && win._envId ? String(win._envId) : activeEnvironmentId();
}

function setBrowserSerialBadge(serialNum) {
  activeBrowserSerialBadge = serialNum ? String(serialNum) : "";
  if (app.dock) app.dock.setBadge(activeBrowserSerialBadge);
  if (process.platform !== "win32") return;
  const overlay = activeBrowserSerialBadge ? browserSerialOverlayIcon(activeBrowserSerialBadge) : null;
  for (const win of browserWindows.values()) {
    if (!win || win.isDestroyed() || typeof win.setOverlayIcon !== "function") continue;
    const badge = String(win._serialNum || "");
    win.setOverlayIcon(badge ? browserSerialOverlayIcon(badge) : overlay, badge ? `窗口 ${badge}` : "");
  }
}

function browserSerialOverlayIcon(serialNum) {
  const label = String(serialNum || "").replace(/\D/g, "").slice(-3) || "0";
  if (browserSerialOverlayIcons.has(label)) return browserSerialOverlayIcons.get(label);
  const patterns = {
    0: ["11111", "10001", "10011", "10101", "11001", "10001", "11111"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["11110", "00001", "00001", "11110", "10000", "10000", "11111"],
    3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    4: ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
    5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
    6: ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
    7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    9: ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
  };
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
    const offset = ((32 * y) + x) << 2;
    if (((x - 15.5) ** 2) + ((y - 15.5) ** 2) <= 15 ** 2) {
      png.data[offset] = 220;
      png.data[offset + 1] = 38;
      png.data[offset + 2] = 38;
      png.data[offset + 3] = 255;
    }
  }
  const scale = label.length === 1 ? 3 : label.length === 2 ? 2 : 1;
  const totalWidth = (label.length * 5 + label.length - 1) * scale;
  const startX = Math.floor((32 - totalWidth) / 2);
  const startY = Math.floor((32 - 7 * scale) / 2);
  [...label].forEach((digit, index) => {
    const pattern = patterns[digit] || patterns[0];
    pattern.forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel !== "1") return;
      for (let py = 0; py < scale; py += 1) for (let px = 0; px < scale; px += 1) {
        const targetX = startX + index * 6 * scale + x * scale + px;
        const targetY = startY + y * scale + py;
        const offset = ((32 * targetY) + targetX) << 2;
        png.data[offset] = 255;
        png.data[offset + 1] = 255;
        png.data[offset + 2] = 255;
        png.data[offset + 3] = 255;
      }
    }));
  });
  const icon = nativeImage.createFromBuffer(PNG.sync.write(png));
  browserSerialOverlayIcons.set(label, icon);
  return icon;
}

function refreshBrowserSerialBadge() {
  if (!app.dock && process.platform !== "win32") return;
  const windows = Array.from(browserWindows.values()).filter(win => win && !win.isDestroyed());
  const focusedBrowser = windows.find(win => win.isFocused && win.isFocused());
  let target = focusedBrowser || null;
  if (!target && lastFocusedBrowserWindow && !lastFocusedBrowserWindow.isDestroyed()) {
    target = lastFocusedBrowserWindow;
  }
  if (!target) {
    target = windows[windows.length - 1];
  }
  setBrowserSerialBadge(target && target._serialNum ? target._serialNum : "");
}

function openURLFromHistory(url) {
  const win = getActiveBrowserWindow();
  if (win) {
    sendOpenTab(win, url);
    win.focus();
    return;
  }
  createWindow();
}

function openURLInActiveBrowser(url) {
  const win = getActiveBrowserWindow();
  if (win) {
    sendOpenTab(win, url);
    win.focus();
    return true;
  }
  return false;
}

function attachPopupHandler(contents, ownerWindow) {
  if (!contents || contents.isDestroyed() || contents.__openTabHandlerAttached) return;
  contents.__openTabHandlerAttached = true;
  contents.setWindowOpenHandler((details) => {
    try {
      const host = new URL(details.url).hostname.toLowerCase();
      if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) {
        // 小红书登录通常在 popup 中完成。必须让 popup 与当前环境
        // 共用同一个持久化 partition，否则登录 Cookie 会写入默认
        // Session，创作页所在环境仍会收到 401 并再次要求登录。
        const envId = ownerWindow && ownerWindow._envId ? String(ownerWindow._envId) : "";
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined,
            autoHideMenuBar: true,
            webPreferences: envId ? { partition: `persist:env_${envId}` } : undefined,
          },
        };
      }
    } catch (e) {}
    sendOpenTab(ownerWindow || BrowserWindow.fromWebContents(contents), details.url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (childWindow) => {
    if (!childWindow || childWindow.isDestroyed()) return;
    attachContextMenu(childWindow.webContents, ownerWindow || childWindow);
    attachXhsPopupSessionBridge(childWindow, ownerWindow || childWindow);
  });
}

// Electron 某些版本在 webview 的 window.open popup 上不会可靠地应用
// overrideBrowserWindowOptions.partition。小红书登录完成后，Cookie 可能
// 写入 popup 的默认 Session，而创作页仍使用环境 Session，随后接口返回
// 401。仅同步小红书域名 Cookie，避免影响其他站点或环境隔离。
function attachXhsPopupSessionBridge(childWindow, ownerWindow) {
  if (!childWindow || childWindow.isDestroyed() || !ownerWindow) return;
  const envId = ownerWindow._envId ? String(ownerWindow._envId) : "";
  if (!envId) return;
  const targetSession = session.fromPartition(`persist:env_${envId}`);
  const sourceSession = childWindow.webContents.session;
  if (!sourceSession || sourceSession === targetSession) return;
  if (!sourceSession.__xhsPopupBridgePartitions) sourceSession.__xhsPopupBridgePartitions = new Set();
  if (sourceSession.__xhsPopupBridgePartitions.has(envId)) return;
  sourceSession.__xhsPopupBridgePartitions.add(envId);
  const isXhsCookie = (cookie) => /(^|\\.)xiaohongshu\\.com$/i.test(String(cookie.domain || "").replace(/^\\./, ""));
  const syncCookie = async (cookie, removed) => {
    if (!isXhsCookie(cookie)) return;
    try {
      const url = `https://${String(cookie.domain || "").replace(/^\\./, "")}${cookie.path || "/"}`;
      if (removed) {
        await targetSession.cookies.remove(url, cookie.name);
        return;
      }
      const details = {
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
      };
      if (cookie.sameSite) details.sameSite = cookie.sameSite;
      if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
      await targetSession.cookies.set(details);
    } catch (error) {
      console.warn("sync Xiaohongshu popup cookie failed:", error.message);
    }
  };
  const onChanged = (_event, cookie, cause, removed) => {
    syncCookie(cookie, removed).catch(() => {});
  };
  sourceSession.cookies.on("changed", onChanged);
  childWindow.once("closed", () => {
    sourceSession.cookies.removeListener("changed", onChanged);
    sourceSession.__xhsPopupBridgePartitions.delete(envId);
  });
}

const xhsPublishBypass = new Map();
const xhsPendingPublish = new Map();
const xhsSessionTimers = new Map();

function isXhsPublishURL(rawURL) {
  try {
    const parsed = new URL(String(rawURL || ""));
    return parsed.hostname === "creator.xiaohongshu.com" && parsed.pathname.startsWith("/publish/");
  } catch {
    return false;
  }
}

async function hasCompleteXhsSession(contents) {
  if (!contents || contents.isDestroyed()) return false;
  // Current Xiaohongshu web login reliably persists `web_session`, while
  // `id_token` is no longer issued for every account/login flow. Requiring both
  // makes a valid persisted session look logged out after the browser restarts.
  const webSessions = await contents.session.cookies.get({
    url: "https://www.xiaohongshu.com/",
    name: "web_session",
  });
  return webSessions.some(cookie => !!cookie.value);
}

function stopXhsSessionTimer(contents) {
  const timer = xhsSessionTimers.get(contents.id);
  if (timer) clearInterval(timer);
  xhsSessionTimers.delete(contents.id);
}

function waitForXhsMainLogin(contents, ownerWindow) {
  stopXhsSessionTimer(contents);
  const startedAt = Date.now();
  const timer = setInterval(async () => {
    if (!contents || contents.isDestroyed()) {
      stopXhsSessionTimer(contents);
      return;
    }
    if (Date.now() - startedAt > 5 * 60 * 1000) {
      stopXhsSessionTimer(contents);
      return;
    }
    try {
      if (!await hasCompleteXhsSession(contents)) return;
      const publishURL = xhsPendingPublish.get(contents.id);
      xhsPendingPublish.delete(contents.id);
      stopXhsSessionTimer(contents);
      if (!publishURL) return;
      xhsPublishBypass.set(contents.id, publishURL);
      contents.loadURL(publishURL);
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        ownerWindow.webContents.send("browser-toast", "小红书主站登录完成，正在返回发布页面");
      }
    } catch (error) {
      console.warn("check Xiaohongshu main session failed:", error.message);
    }
  }, 1000);
  xhsSessionTimers.set(contents.id, timer);
}

function attachXhsPublishSessionGuard(contents, ownerWindow) {
  if (!contents || contents.isDestroyed() || contents.__xhsPublishGuardAttached) return;
  contents.__xhsPublishGuardAttached = true;
  contents.on("will-navigate", (event, navigationDetails) => {
    const targetURL = typeof navigationDetails === "string" ? navigationDetails : navigationDetails && navigationDetails.url;
    if (!isXhsPublishURL(targetURL)) return;
    if (xhsPublishBypass.get(contents.id) === targetURL) {
      xhsPublishBypass.delete(contents.id);
      return;
    }
    event.preventDefault();
    hasCompleteXhsSession(contents).then(complete => {
      if (!contents || contents.isDestroyed()) return;
      if (complete) {
        xhsPublishBypass.set(contents.id, targetURL);
        contents.loadURL(targetURL);
        return;
      }
      xhsPendingPublish.set(contents.id, targetURL);
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        ownerWindow.webContents.send("browser-toast", "发布前需要先完成小红书主站登录，登录后将自动返回");
      }
      contents.loadURL("https://www.xiaohongshu.com/explore");
      waitForXhsMainLogin(contents, ownerWindow);
    }).catch(error => console.warn("prepare Xiaohongshu publish session failed:", error.message));
  });
  contents.once("destroyed", () => {
    stopXhsSessionTimer(contents);
    xhsPendingPublish.delete(contents.id);
    xhsPublishBypass.delete(contents.id);
  });
}

function installXhsAuthResponseGuard(ses, ownerWindow) {
  if (!ses || ses.__xhsAuthResponseGuardInstalled) return;
  ses.__xhsAuthResponseGuardInstalled = true;
  ses.webRequest.onCompleted(
    { urls: ["*://edith.xiaohongshu.com/api/sns/v1/creator/*"] },
    details => {
      if (Number(details.statusCode || 0) !== 401) return;
      const contents = electronWebContents.fromId(Number(details.webContentsId || 0));
      if (!contents || contents.isDestroyed()) return;
      hasCompleteXhsSession(contents).then(complete => {
        if (complete || contents.isDestroyed()) return;
        const currentURL = contents.getURL();
        const publishURL = isXhsPublishURL(currentURL)
          ? currentURL
          : "https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=article";
        xhsPendingPublish.set(contents.id, publishURL);
        if (ownerWindow && !ownerWindow.isDestroyed()) {
          ownerWindow.webContents.send("browser-toast", "检测到小红书发布身份不完整，请先登录主站");
        }
        contents.loadURL("https://www.xiaohongshu.com/explore");
        waitForXhsMainLogin(contents, ownerWindow);
      }).catch(error => console.warn("handle Xiaohongshu creator 401 failed:", error.message));
    },
  );
}

function buildTextFragmentURL(pageURL, selectionText) {
  if (!isOpenableURL(pageURL) || !selectionText) return "";
  const clean = String(selectionText).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const fragmentText = clean.slice(0, 180);
  return `${pageURL.split("#")[0]}#:~:text=${encodeURIComponent(fragmentText)}`;
}

function openTranslatedText(ownerWindow, text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  const url = `https://translate.google.com/?sl=auto&tl=zh-CN&text=${encodeURIComponent(clean.slice(0, 3000))}&op=translate`;
  sendOpenTab(ownerWindow, url);
}

function openTranslatedPage(ownerWindow, pageURL) {
  if (!isOpenableURL(pageURL)) return;
  const url = `https://translate.google.com/translate?sl=auto&tl=zh-CN&u=${encodeURIComponent(pageURL)}`;
  sendOpenTab(ownerWindow, url);
}

function addBookmarkFromContext(url, title, ownerWindow) {
  const bookmark = addBookmark({ title: title || url, url, groupId: "other" }, ownerWindow && ownerWindow._envId);
  if (bookmark && ownerWindow && !ownerWindow.isDestroyed()) {
    ownerWindow.webContents.send("browser-toast", `已添加标签: ${bookmark.title}`);
  }
}

function attachContextMenu(contents, ownerWindow) {
  if (!contents || contents.isDestroyed() || contents.__contextMenuAttached) return;
  contents.__contextMenuAttached = true;
  contents.on("context-menu", (_event, params) => {
    const linkURL = params.linkURL || params.srcURL || "";
    const pageURL = params.pageURL || (contents.getURL ? contents.getURL() : "");
    const selectedText = String(params.selectionText || "").trim();
    const hasLink = isOpenableURL(linkURL);
    const hasSelection = selectedText.length > 0;
    const canEdit = !!params.isEditable;
    const textFragmentURL = buildTextFragmentURL(pageURL, selectedText);
    const targetWindow = ownerWindow || BrowserWindow.fromWebContents(contents);
    const bookmarkTargetURL = hasLink ? linkURL : pageURL;
    const bookmarkTargetTitle = hasLink
      ? (params.linkText || params.titleText || linkURL)
      : ((contents.getTitle && contents.getTitle()) || params.titleText || pageURL);
    const template = [];

    if (hasLink) {
      template.push(
        { label: "在新标签页中打开链接", click: () => sendOpenTab(targetWindow, linkURL) },
        { label: "在新窗口中打开链接", enabled: false },
        { label: "在拆分视图中打开链接", enabled: false },
        { label: "在隐身窗口中打开链接", enabled: false },
        { type: "separator" },
        { label: "链接存储为…", click: () => contents.downloadURL(linkURL) },
        { label: "复制链接地址", click: () => clipboard.writeText(linkURL) },
        { type: "separator" },
      );
    }

    template.push(
      { label: hasLink ? "将链接添加到标签栏" : "将此页面添加到标签栏", enabled: isOpenableURL(bookmarkTargetURL), click: () => addBookmarkFromContext(bookmarkTargetURL, bookmarkTargetTitle, targetWindow) },
      { type: "separator" },
    );

    if (canEdit) {
      template.push(
        { label: "剪切", role: "cut", enabled: params.editFlags && params.editFlags.canCut },
        { label: "复制", role: "copy", enabled: params.editFlags && params.editFlags.canCopy },
        { label: "粘贴", role: "paste", enabled: params.editFlags && params.editFlags.canPaste },
        { label: "全选", role: "selectAll", enabled: params.editFlags && params.editFlags.canSelectAll },
        { type: "separator" },
      );
    } else {
      template.push({ label: "复制", role: "copy", enabled: hasSelection });
    }

    template.push(
      { label: "复制指向突出显示的内容的链接", enabled: !!textFragmentURL, click: () => clipboard.writeText(textFragmentURL) },
      { label: "使用 Google 搜索 “" + shortMenuLabel(selectedText || params.misspelledWord || "", 18) + "”", enabled: hasSelection, click: () => sendOpenTab(targetWindow, `https://www.google.com/search?q=${encodeURIComponent(selectedText)}`) },
      { label: "打印…", click: () => contents.print({ silent: false, printBackground: true }) },
      { label: hasSelection ? "将所选内容翻译为中文（简体）" : "将此页面翻译为中文（简体）", enabled: hasSelection || isOpenableURL(pageURL), click: () => hasSelection ? openTranslatedText(targetWindow, selectedText) : openTranslatedPage(targetWindow, pageURL) },
      { type: "separator" },
      { label: "同步助手 - 提取并编辑文章", enabled: false },
      { type: "separator" },
      { label: "检查", click: () => contents.inspectElement(params.x, params.y) },
      { type: "separator" },
      {
        label: "语言",
        submenu: [
          { label: "翻译为中文（简体）", enabled: hasSelection || isOpenableURL(pageURL), click: () => hasSelection ? openTranslatedText(targetWindow, selectedText) : openTranslatedPage(targetWindow, pageURL) },
          { label: "首选语言设置", enabled: false },
        ],
      },
      {
        label: "服务",
        submenu: [
          { label: "用系统浏览器打开当前页面", enabled: isOpenableURL(pageURL), click: () => shell.openExternal(pageURL) },
          { label: "复制当前页面地址", enabled: isOpenableURL(pageURL), click: () => clipboard.writeText(pageURL) },
        ],
      },
    );

    Menu.buildFromTemplate(template).popup({ window: targetWindow });
  });
}

function installChineseMenu() {
  Menu.setApplicationMenu(null);
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function shortMenuLabel(value, max = 34) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "未命名页面";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function buildHistoryMenuItems(envId = activeEnvironmentId()) {
  const entries = loadHistory(envId);
  const today = new Date();
  const todayEntries = [];
  const olderEntries = [];
  for (const entry of entries) {
    const visited = new Date(entry.visitedAt);
    if (!Number.isNaN(visited.getTime()) && isSameLocalDay(visited, today)) todayEntries.push(entry);
    else olderEntries.push(entry);
  }

  const visibleEntries = todayEntries.length >= 20
    ? todayEntries.slice(0, 20)
    : todayEntries.concat(olderEntries.slice(0, 20 - todayEntries.length));

  const items = [
    { label: "后退", accelerator: "CmdOrCtrl+[", click: (_item, win) => win?.webContents.send("browser-go-back") },
    { label: "前进", accelerator: "CmdOrCtrl+]", click: (_item, win) => win?.webContents.send("browser-go-forward") },
    { type: "separator" },
  ];

  if (visibleEntries.length === 0) {
    items.push({ label: "暂无历史记录", enabled: false });
  } else {
    items.push({ label: todayEntries.length > 0 ? "今天" : "最近访问过的内容", enabled: false });
    visibleEntries.forEach(entry => {
      items.push({
        label: shortMenuLabel(entry.title || entry.url),
        sublabel: formatHistoryTime(entry.visitedAt),
        click: () => openURLFromHistory(entry.url),
      });
    });
  }

  items.push(
    { type: "separator" },
    { label: "显示全部历史记录", accelerator: "CmdOrCtrl+Y", click: () => showHistoryWindow(envId) },
    { label: "清除历史记录", click: () => clearHistory(envId) },
  );
  return items;
}

function environmentBrowserDataDir(envId) {
  return path.join(app.getPath("userData"), "browser-data", `env_${safeFileName(envId || "default")}`);
}

function bookmarkFilePath(envId) {
  return path.join(environmentBrowserDataDir(envId), "bookmarks.json");
}

function shortcutFilePath(envId) {
  return path.join(environmentBrowserDataDir(envId), "shortcuts.json");
}

function loadShortcuts(envId) {
  try {
    const rows = JSON.parse(fs.readFileSync(shortcutFilePath(envId), "utf8"));
    return Array.isArray(rows) ? rows.filter(item => item && item.url).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function saveShortcuts(envId, items) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(item => item && item.url)
    .slice(0, 24)
    .map(item => ({ title: String(item.title || ""), url: String(item.url), custom: true }));
  fs.mkdirSync(environmentBrowserDataDir(envId), { recursive: true });
  fs.writeFileSync(shortcutFilePath(envId), JSON.stringify(rows, null, 2));
  return rows;
}

function createDefaultBookmarks() {
  return {
    groups: [{ id: "other", name: "其他书签" }],
    bookmarks: []
  };
}

function loadBookmarks(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  if (bookmarkStores.has(key)) return bookmarkStores.get(key);
  let data;
  try {
    const raw = fs.readFileSync(bookmarkFilePath(key), "utf8");
    const parsed = JSON.parse(raw);
    data = {
      groups: Array.isArray(parsed.groups) && parsed.groups.length ? parsed.groups : [{ id: "other", name: "其他书签" }],
      bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
    };
  } catch (e) {
    data = createDefaultBookmarks();
  }
  if (!data.groups.some(g => g.id === "other")) {
    data.groups.push({ id: "other", name: "其他书签" });
  }
  bookmarkStores.set(key, data);
  return data;
}

function saveBookmarks(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  try {
    fs.mkdirSync(environmentBrowserDataDir(key), { recursive: true });
    fs.writeFileSync(bookmarkFilePath(key), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("save bookmarks failed:", e.message);
  }
}

function broadcastBookmarks(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  installChineseMenu();
  const data = loadBookmarks(key);
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed() && String(win._envId || "") === key) win.webContents.send("browser-bookmarks-updated", data);
  });
  if (bookmarkManagerWindow && !bookmarkManagerWindow.isDestroyed() && String(bookmarkManagerWindow._envId || "") === key) {
    bookmarkManagerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBookmarkManagerHTML(data))}`);
  }
}

function addBookmark(entry, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  if (!entry || !isOpenableURL(entry.url)) return null;
  const title = shortMenuLabel(entry.title || entry.url, 80);
  const existing = data.bookmarks.find(b => b.url === entry.url);
  if (existing) {
    existing.title = title;
    existing.groupId = entry.groupId || existing.groupId || "other";
    if (entry.icon) existing.icon = entry.icon;
    existing.updatedAt = new Date().toISOString();
    saveBookmarks(key);
    broadcastBookmarks(key);
    return existing;
  }
  const bookmark = {
    id: "bm-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    title,
    url: entry.url,
    groupId: entry.groupId || "other",
    icon: entry.icon || "",
    createdAt: new Date().toISOString(),
  };
  data.bookmarks.unshift(bookmark);
  saveBookmarks(key);
  broadcastBookmarks(key);
  return bookmark;
}

function updateBookmarkIcon(url, icon, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  if (!isOpenableURL(url) || !isOpenableURL(icon)) return null;
  const bookmark = data.bookmarks.find(b => b.url === url);
  if (!bookmark || bookmark.icon === icon) return bookmark || null;
  bookmark.icon = icon;
  bookmark.updatedAt = new Date().toISOString();
  saveBookmarks(key);
  broadcastBookmarks(key);
  return bookmark;
}

function addBookmarkGroup(name, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  const clean = shortMenuLabel(name, 40);
  if (!clean) return null;
  const group = { id: "grp-" + Date.now() + "-" + Math.random().toString(16).slice(2), name: clean };
  data.groups.push(group);
  saveBookmarks(key);
  broadcastBookmarks(key);
  return group;
}

function deleteBookmark(id, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  data.bookmarks = data.bookmarks.filter(b => b.id !== id);
  saveBookmarks(key);
  broadcastBookmarks(key);
}

function updateBookmark(entry, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  const bookmark = data.bookmarks.find(b => b.id === entry.id);
  if (!bookmark || !isOpenableURL(entry.url)) return null;
  bookmark.title = shortMenuLabel(entry.title || entry.url, 80);
  bookmark.url = entry.url;
  bookmark.groupId = entry.groupId || "other";
  bookmark.icon = entry.icon || bookmark.icon || "";
  bookmark.updatedAt = new Date().toISOString();
  saveBookmarks(key);
  broadcastBookmarks(key);
  return bookmark;
}

function deleteBookmarkGroup(id, envId = activeEnvironmentId()) {
  if (id === "other") return;
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  data.groups = data.groups.filter(g => g.id !== id);
  data.bookmarks.forEach(b => { if (b.groupId === id) b.groupId = "other"; });
  saveBookmarks(key);
  broadcastBookmarks(key);
}

function buildBookmarkMenuItems(envId = activeEnvironmentId()) {
  const data = loadBookmarks(envId);
  const direct = data.bookmarks.filter(b => !b.groupId || b.groupId === "other").slice(0, 8);
  const groups = data.groups.filter(g => g.id !== "other");
  const items = [
    { label: "打开书签管理器", accelerator: "Alt+CmdOrCtrl+B", click: () => showBookmarkManager(envId) },
    { label: "为此标签页添加书签…", accelerator: "CmdOrCtrl+D", click: () => getActiveBrowserWindow()?.webContents.send("browser-request-current-bookmark") },
    { label: "为所有标签页添加书签…", enabled: false },
    { type: "separator" },
  ];
  if (direct.length === 0 && groups.length === 0) {
    items.push({ label: "暂无书签", enabled: false });
  }
  direct.forEach(bookmark => {
    items.push({ label: shortMenuLabel(bookmark.title), click: () => openURLInActiveBrowser(bookmark.url) || createWindow() });
  });
  groups.forEach(group => {
    const children = data.bookmarks.filter(b => b.groupId === group.id).slice(0, 20);
    items.push({
      label: group.name,
      submenu: children.length
        ? children.map(bookmark => ({ label: shortMenuLabel(bookmark.title), click: () => openURLInActiveBrowser(bookmark.url) || createWindow() }))
        : [{ label: "空分组", enabled: false }]
    });
  });
  items.push({ type: "separator" }, {
    label: "其他书签",
    submenu: direct.length
      ? direct.map(bookmark => ({ label: shortMenuLabel(bookmark.title), click: () => openURLInActiveBrowser(bookmark.url) || createWindow() }))
      : [{ label: "空", enabled: false }]
  });
  return items;
}

function buildBookmarkManagerHTML(data) {
  const groupOptions = data.groups.map(g => `<option value="${escHTML(g.id)}">${escHTML(g.name)}</option>`).join("");
  const rows = data.bookmarks.map(b => {
    const group = data.groups.find(g => g.id === b.groupId) || data.groups.find(g => g.id === "other") || { name: "其他书签" };
    return `<div class="row">
      <div><strong>${escHTML(b.title)}</strong><div class="url">${escHTML(b.url)}</div></div>
      <div>${escHTML(group.name)}</div>
      <button class="bookmark-action" data-action="edit" data-id="${escHTML(b.id)}">编辑</button>
      <button class="bookmark-action" data-action="open" data-id="${escHTML(b.id)}">打开</button>
      <button class="bookmark-action danger" data-action="delete" data-id="${escHTML(b.id)}">删除</button>
    </div>`;
  }).join("");
  const groupRows = data.groups.map(g => `<div class="group-row"><span>${escHTML(g.name)}</span>${g.id === "other" ? "" : `<button onclick="deleteGroup('${escHTML(g.id)}')" class="danger">删除</button>`}</div>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#20242a}
header{height:56px;background:#fff;border-bottom:1px solid #e5eaf2;display:flex;align-items:center;justify-content:space-between;padding:0 18px}
h1{font-size:16px;margin:0}main{padding:16px;display:grid;grid-template-columns:1fr 260px;gap:14px}
.panel{background:#fff;border:1px solid #e6ebf2;border-radius:8px;padding:14px}.panel h2{font-size:14px;margin:0 0 12px}
.form{display:grid;grid-template-columns:1fr 1.4fr 150px auto auto;gap:8px;margin-bottom:12px}.group-form{display:flex;gap:8px;margin-bottom:12px}
input,select{height:34px;border:1px solid #d0d5dd;border-radius:6px;padding:0 10px}button{height:34px;border:1px solid #bcc7d5;border-radius:6px;background:#fff;padding:0 12px;cursor:pointer}
button.primary{border-color:#1769e0;background:#1769e0;color:#fff}.danger{color:#e53935;border-color:#ffd5d5}.row{display:grid;grid-template-columns:1fr 120px 64px 64px 64px;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #f0f3f7}
.row:last-child{border-bottom:0}.url{font-size:12px;color:#778193;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.group-row{height:36px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f3f7}
.empty{padding:26px;text-align:center;color:#8a94a6}
</style></head><body><header><h1>书签管理器</h1><span>共 ${data.bookmarks.length} 个书签</span></header>
<main><section class="panel"><h2>书签</h2><div class="form">
<input id="title" placeholder="标题"><input id="url" placeholder="https://example.com"><select id="group">${groupOptions}</select><button class="primary" id="saveBtn">添加</button><button id="cancelBtn">取消</button>
</div><div id="list">${rows || '<div class="empty">暂无书签</div>'}</div></section>
<aside class="panel"><h2>分组</h2><div class="group-form"><input id="groupName" placeholder="新分组名称"><button onclick="addGroup()">添加</button></div>${groupRows}</aside></main>
<script>
const BOOKMARKS = ${JSON.stringify(data.bookmarks).replace(/</g, "\u003c").replace(/>/g, "\u003e").replace(/&/g, "\u0026")};
let editingId = "";
function save(){ window.bookmarkManager[editingId ? "update" : "add"]({ id: editingId, title: title.value, url: url.value, groupId: group.value }); resetForm(); }
function editBookmarkById(id){ var item = BOOKMARKS.find(function(b){ return b.id === id; }); if (!item) return; editingId=item.id; title.value=item.title || ""; url.value=item.url || ""; group.value=item.groupId || "other"; saveBtn.textContent="保存"; }
function resetForm(){ editingId=""; title.value=""; url.value=""; group.value="other"; saveBtn.textContent="添加"; }
function addGroup(){ window.bookmarkManager.addGroup(groupName.value); groupName.value=""; }
function deleteBookmark(id){ window.bookmarkManager.deleteBookmark(id); }
function deleteGroup(id){ window.bookmarkManager.deleteGroup(id); }
function openBookmark(url){ window.bookmarkManager.open(url); }
saveBtn.addEventListener("click", save); cancelBtn.addEventListener("click", resetForm);
document.querySelectorAll(".bookmark-action").forEach(function(button){ button.addEventListener("click", function(){ var item=BOOKMARKS.find(function(b){return b.id===button.dataset.id;}); if(!item)return; if(button.dataset.action==="edit")editBookmarkById(item.id); else if(button.dataset.action==="open")openBookmark(item.url); else deleteBookmark(item.id); }); });
window.bookmarkManager.onUpdated(() => location.reload());
</script></body></html>`;
}

function showBookmarkManager(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const data = loadBookmarks(key);
  if (bookmarkManagerWindow && !bookmarkManagerWindow.isDestroyed()) {
    bookmarkManagerWindow.focus();
    bookmarkManagerWindow._envId = key;
    bookmarkManagerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBookmarkManagerHTML(data))}`);
    return;
  }
  bookmarkManagerWindow = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 820,
    minHeight: 520,
    title: "书签管理器",
    webPreferences: { preload: path.join(__dirname, "bookmark-manager-preload.js"), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  bookmarkManagerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  bookmarkManagerWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  bookmarkManagerWindow._envId = key;
  bookmarkManagerWindow.on("closed", () => { bookmarkManagerWindow = null; });
  bookmarkManagerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBookmarkManagerHTML(data))}`);
}

function normalizeFingerprint(fp) {
  const chromiumVersion = String(process.versions.chrome || "126.0.6478.127");
  const fallbackUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
  const os = fp && fp.os ? fp.os : (fp && fp.platform === "Win32" ? "win" : "mac");
  const configuredUA = String(fp && fp.userAgent || fallbackUA);
  const consistentUA = /Chrome\/[\d.]+/.test(configuredUA)
    ? configuredUA.replace(/Chrome\/[\d.]+/, `Chrome/${chromiumVersion}`)
    : fallbackUA;
  const geoLatitude = fp && (fp.geoLatitude ?? fp.latitude);
  const geoLongitude = fp && (fp.geoLongitude ?? fp.longitude);
  const geoAccuracy = fp && (fp.geoAccuracy ?? fp.accuracy);
  return {
    os: os,
    kernelVersion: ["148", "146", "144", "142"].includes(String(fp.kernelVersion)) ? String(fp.kernelVersion) : "148",
    browserVersion: ["148", "147"].includes(String(fp.browserVersion)) ? String(fp.browserVersion) : "148",
    windowsVersion: ["10", "11"].includes(String(fp.windowsVersion)) ? String(fp.windowsVersion) : "11",
    deviceName: fp && fp.deviceName || (os === "win" ? "DESKTOP-LOCAL" : "MacBook-Pro"),
    hostIp: fp && (fp.hostIp || fp.hostIP) || "192.168.1.23",
    macAddress: fp && fp.macAddress || "02:00:00:00:00:01",
    portScanProtection: !fp || fp.portScanProtection !== false,
    userAgent: consistentUA,
    platform: fp && fp.platform || "MacIntel",
    vendor: fp && fp.vendor || "Google Inc.",
    language: fp && fp.language || "zh-CN",
    languages: fp && fp.languages || "zh-CN,zh,en-US,en",
    languageFollowIP: !!(fp && fp.languageFollowIP),
    uiLanguageFollowIP: !fp || fp.uiLanguageFollowIP !== false,
    uiLanguage: fp && fp.uiLanguage || "",
    timezoneFollowIP: !fp || fp.timezoneFollowIP !== false,
    geoPermission: fp && ["ask", "allow", "block"].includes(fp.geoPermission) ? fp.geoPermission : "block",
    geolocationFollowIP: !!(fp && fp.geolocationFollowIP),
    geoLatitude: Number(geoLatitude ?? 30.274084),
    geoLongitude: Number(geoLongitude ?? 120.15507),
    geoAccuracy: Number(geoAccuracy ?? 50),
    webrtcMode: fp && ["replace", "hide", "allow", "block"].includes(fp.webrtcMode) ? fp.webrtcMode : "hide",
    webrtcPublicIP: fp && fp.webrtcPublicIP || "",
    ignoreHttpsErrors: !!(fp && fp.ignoreHttpsErrors),
    windowWidth: Number(fp && (fp.windowWidth || fp.browserWidth) || 1280),
    windowHeight: Number(fp && (fp.windowHeight || fp.browserHeight) || 720),
    timezone: fp && fp.timezone || "Asia/Shanghai",
    screenWidth: Number(fp && fp.screenWidth || 1440),
    screenHeight: Number(fp && fp.screenHeight || 900),
    colorDepth: Number(fp && fp.colorDepth || 24),
    hardwareConcurrency: Number(fp && fp.hardwareConcurrency || 8),
    deviceMemory: Number(fp && fp.deviceMemory || 8),
    webGLVendor: fp && fp.webGLVendor || "Apple Inc.",
    webGLRenderer: fp && fp.webGLRenderer || "Apple GPU",
    canvasNoise: fp && fp.canvasNoise || "00000000",
  };
}

function canonicalizeFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalizeFingerprintValue(value[key]);
      return out;
    }, {});
  }
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(8)) : 0;
  if (typeof value === "string") return value.trim();
  return value;
}

function fingerprintIsolationPayload(fp) {
  const fingerprint = normalizeFingerprint(fp || {});
  return canonicalizeFingerprintValue({
    os: fingerprint.os,
    kernelVersion: fingerprint.kernelVersion,
    browserVersion: fingerprint.browserVersion,
    windowsVersion: fingerprint.windowsVersion,
    deviceName: fingerprint.deviceName,
    macAddress: fingerprint.macAddress,
    userAgent: fingerprint.userAgent,
    platform: fingerprint.platform,
    vendor: fingerprint.vendor,
    language: fingerprint.language,
    languages: fingerprint.languages,
    languageFollowIP: !!fingerprint.languageFollowIP,
    uiLanguageFollowIP: fingerprint.uiLanguageFollowIP !== false,
    uiLanguage: fingerprint.uiLanguage,
    timezoneFollowIP: fingerprint.timezoneFollowIP !== false,
    timezone: fingerprint.timezone,
    geoPermission: fingerprint.geoPermission,
    geolocationFollowIP: !!fingerprint.geolocationFollowIP,
    geoLatitude: fingerprint.geoLatitude,
    geoLongitude: fingerprint.geoLongitude,
    geoAccuracy: fingerprint.geoAccuracy,
    webrtcMode: fingerprint.webrtcMode,
    windowWidth: fingerprint.windowWidth,
    windowHeight: fingerprint.windowHeight,
    screenWidth: fingerprint.screenWidth,
    screenHeight: fingerprint.screenHeight,
    colorDepth: fingerprint.colorDepth,
    hardwareConcurrency: fingerprint.hardwareConcurrency,
    deviceMemory: fingerprint.deviceMemory,
    webGLVendor: fingerprint.webGLVendor,
    webGLRenderer: fingerprint.webGLRenderer,
    canvasNoise: fingerprint.canvasNoise,
    portScanProtection: fingerprint.portScanProtection !== false,
  });
}

function fingerprintIsolationHash(fp) {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintIsolationPayload(fp))).digest("hex");
}

function environmentDisplayName(env) {
  const serial = String(env?.serialNum || "").trim();
  const name = String(env?.name || env?.id || "未命名环境").trim();
  return serial ? `${name}（序号 ${serial}）` : name;
}

function assertUniqueEnvironmentFingerprint(candidate, rows = [], options = {}) {
  const candidateId = String(options.ignoreEnvId || candidate?.id || "");
  const candidateHash = fingerprintIsolationHash(candidate?.fingerprint || {});
  const match = (Array.isArray(rows) ? rows : []).find(row => {
    if (!row) return false;
    if (candidateId && String(row.id || "") === candidateId) return false;
    return fingerprintIsolationHash(row.fingerprint || {}) === candidateHash;
  });
  if (!match) return candidateHash;
  throw new Error(`浏览器指纹已被 ${environmentDisplayName(match)} 使用，请为当前环境重新随机指纹后再保存或启动。`);
}

function certificateManagerOwnedDataDir() {
  return path.join(app.getPath("appData"), IS_SYNC_TEST_VARIANT ? "码友证书管理 Sync Test" : "码友证书管理");
}

function certificateManagerEnvironmentsDatabasePath() {
  return path.join(certificateManagerOwnedDataDir(), "certificate-environments.sqlite");
}

function withCertificateManagerEnvironmentsDatabase(callback) {
  fs.mkdirSync(certificateManagerOwnedDataDir(), { recursive: true });
  const db = new DatabaseSync(certificateManagerEnvironmentsDatabasePath());
  try {
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS certificate_environments (
        owner_key TEXT NOT NULL,
        apple_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        account_key TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        name TEXT NOT NULL,
        fingerprint_hash TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL,
        last_proxy_json TEXT NOT NULL DEFAULT '',
        last_proxy_ip TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_key, apple_id),
        UNIQUE(environment_id),
        UNIQUE(owner_key, account_key),
        UNIQUE(fingerprint_hash)
      );
    `);
    try { fs.chmodSync(certificateManagerEnvironmentsDatabasePath(), 0o600); } catch {}
    return callback(db);
  } finally {
    db.close();
  }
}

function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createCertificateManagerEnvironmentId(ownerKey, appleId) {
  const hash = crypto.createHash("sha256").update(`${ownerKey}:${String(appleId || "").toLowerCase()}`).digest("hex").slice(0, 24);
  return `cert-env-${hash}`;
}

function generateCertificateManagerEnvironmentFingerprint({ appleId = "", accountKey = "" } = {}) {
  const tag = crypto.createHash("sha256").update(`${appleId}:${accountKey}:${crypto.randomUUID()}`).digest("hex");
  return normalizeFingerprint({
    os: "mac",
    kernelVersion: "148",
    browserVersion: "148",
    deviceName: `MacBook-Pro-${tag.slice(0, 6).toUpperCase()}`,
    macAddress: `02:${tag.slice(0, 2)}:${tag.slice(2, 4)}:${tag.slice(4, 6)}:${tag.slice(6, 8)}:${tag.slice(8, 10)}`,
    userAgent: generateAppleDeveloperUserAgent(),
    platform: "MacIntel",
    vendor: "Google Inc.",
    language: "zh-CN",
    languages: "zh-CN,zh,en-US,en",
    timezoneFollowIP: true,
    geolocationFollowIP: false,
    geoPermission: "block",
    webrtcMode: "hide",
    windowWidth: 1180 + Number.parseInt(tag.slice(10, 12), 16) % 120,
    windowHeight: 780 + Number.parseInt(tag.slice(12, 14), 16) % 90,
    screenWidth: 1440 + Number.parseInt(tag.slice(14, 16), 16) % 240,
    screenHeight: 900 + Number.parseInt(tag.slice(16, 18), 16) % 120,
    colorDepth: 24,
    hardwareConcurrency: [6, 8, 10, 12][Number.parseInt(tag.slice(18, 20), 16) % 4],
    deviceMemory: [8, 16][Number.parseInt(tag.slice(20, 22), 16) % 2],
    webGLVendor: "Apple Inc.",
    webGLRenderer: ["Apple GPU", "ANGLE (Apple, Apple M-series, OpenGL 4.1)"][Number.parseInt(tag.slice(22, 24), 16) % 2],
    canvasNoise: randomHex(4),
  });
}

function parseCertificateEnvironmentFingerprint(row) {
  try {
    return normalizeFingerprint(JSON.parse(row?.fingerprint_json || "{}"));
  } catch {
    return normalizeFingerprint({});
  }
}

function publicCertificateManagerEnvironment(row) {
  if (!row) return null;
  const fingerprint = parseCertificateEnvironmentFingerprint(row);
  return {
    id: String(row.environment_id || ""),
    name: String(row.name || ""),
    appleId: String(row.apple_id || ""),
    accountId: String(row.account_id || ""),
    accountKey: String(row.account_key || ""),
    fingerprint,
    fingerprintHash: String(row.fingerprint_hash || fingerprintIsolationHash(fingerprint)),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    lastProxyIp: String(row.last_proxy_ip || ""),
  };
}

function certificateManagerEnvironmentStatusPayload(environment) {
  if (!environment) return null;
  return {
    id: String(environment.id || ""),
    name: String(environment.name || ""),
    appleId: String(environment.appleId || ""),
    fingerprintHash: String(environment.fingerprintHash || ""),
    createdAt: String(environment.createdAt || ""),
    updatedAt: String(environment.updatedAt || ""),
    lastProxyIp: String(environment.lastProxyIp || ""),
  };
}

function proxySnapshotForCertificateEnvironment(proxy) {
  const normalized = normalizeDeveloperAccountProxy(proxy);
  if (!normalized) return { json: "", ip: "" };
  return {
    json: JSON.stringify(normalized),
    ip: String(normalized.lastVerifiedIp || normalized.ip || normalized.outIp || ""),
  };
}

function readAppleDeveloperNetworkFile(accountKey = appleDeveloperAccountKey) {
  try {
    return JSON.parse(fs.readFileSync(appleDeveloperNetworkFilePath(accountKey), "utf8"));
  } catch {
    return null;
  }
}

function developerAccountProxyFromRow(row) {
  if (!row) return null;
  try {
    return normalizeDeveloperAccountProxy(row.proxy || JSON.parse(row.proxy_json || "null"));
  } catch {
    return normalizeDeveloperAccountProxy(row.proxy);
  }
}

function developerAccountKey(ownerKey, accountId, appleId = "") {
  const owner = String(ownerKey || "").trim();
  const accountScope = String(accountId || "").trim() || String(appleId || "").trim().toLowerCase() || "browser";
  return crypto.createHash("sha256").update(`${owner}:${accountScope}`).digest("hex").slice(0, 24);
}

function uniqueCertificateManagerAccountKey(db, ownerKey, appleId, proposedAccountKey) {
  let candidate = String(proposedAccountKey || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  if (!candidate) {
    candidate = crypto.createHash("sha256").update(`${ownerKey}:${appleId}:${crypto.randomUUID()}`).digest("hex").slice(0, 24);
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const conflict = db.prepare("SELECT apple_id FROM certificate_environments WHERE owner_key=? AND account_key=? AND apple_id<>? LIMIT 1").get(ownerKey, candidate, appleId);
    if (!conflict) return candidate;
    candidate = crypto.createHash("sha256").update(`${ownerKey}:${appleId}:${crypto.randomUUID()}:${attempt}`).digest("hex").slice(0, 24);
  }
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function insertCertificateManagerEnvironment(db, row) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fingerprint = generateCertificateManagerEnvironmentFingerprint({
      appleId: row.appleId,
      accountKey: row.accountKey,
    });
    const fingerprintHash = fingerprintIsolationHash(fingerprint);
    try {
      db.prepare("INSERT INTO certificate_environments(owner_key,apple_id,account_id,account_key,environment_id,name,fingerprint_hash,fingerprint_json,last_proxy_json,last_proxy_ip,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          row.ownerKey,
          row.appleId,
          row.accountId,
          row.accountKey,
          row.environmentId,
          row.name,
          fingerprintHash,
          JSON.stringify(fingerprint),
          row.proxyJson,
          row.proxyIp,
          row.now,
          row.now,
        );
      return;
    } catch (error) {
      if (!/fingerprint_hash|UNIQUE constraint failed/i.test(String(error?.message || "")) || attempt === 7) throw error;
    }
  }
}

function ensureCertificateManagerAccountEnvironment({ ownerKey, accountId = "", appleId = "", proposedAccountKey = "", proxy = null } = {}) {
  const owner = String(ownerKey || "").trim();
  const normalizedAppleId = String(appleId || "").trim().toLowerCase();
  if (!owner || !normalizedAppleId) return null;
  const now = new Date().toISOString();
  return withCertificateManagerEnvironmentsDatabase(db => {
    const proxySnapshot = proxySnapshotForCertificateEnvironment(proxy);
    const existing = db.prepare("SELECT * FROM certificate_environments WHERE owner_key=? AND apple_id=?").get(owner, normalizedAppleId);
    if (existing) {
      const accountKey = String(existing.account_key || "") || uniqueCertificateManagerAccountKey(db, owner, normalizedAppleId, proposedAccountKey);
      const nextProxyJson = proxySnapshot.json || String(existing.last_proxy_json || "");
      const nextProxyIp = proxySnapshot.ip || String(existing.last_proxy_ip || "");
      db.prepare("UPDATE certificate_environments SET account_id=?, account_key=?, last_proxy_json=?, last_proxy_ip=?, updated_at=? WHERE owner_key=? AND apple_id=?")
        .run(String(accountId || existing.account_id || ""), accountKey, nextProxyJson, nextProxyIp, now, owner, normalizedAppleId);
      return publicCertificateManagerEnvironment(db.prepare("SELECT * FROM certificate_environments WHERE owner_key=? AND apple_id=?").get(owner, normalizedAppleId));
    }
    const accountKey = uniqueCertificateManagerAccountKey(db, owner, normalizedAppleId, proposedAccountKey);
    const environmentId = createCertificateManagerEnvironmentId(owner, normalizedAppleId);
    const name = `Apple ID ${normalizedAppleId}`;
    insertCertificateManagerEnvironment(db, {
      ownerKey: owner,
      appleId: normalizedAppleId,
      accountId: String(accountId || ""),
      accountKey,
      environmentId,
      name,
      proxyJson: proxySnapshot.json,
      proxyIp: proxySnapshot.ip,
      now,
    });
    return publicCertificateManagerEnvironment(db.prepare("SELECT * FROM certificate_environments WHERE owner_key=? AND apple_id=?").get(owner, normalizedAppleId));
  });
}

function applyCertificateManagerEnvironmentUserAgent(environment) {
  const envUserAgent = String(environment?.fingerprint?.userAgent || "").trim();
  const savedUserAgent = readAppleDeveloperUserAgent();
  if (savedUserAgent) {
    appleDeveloperUserAgent = savedUserAgent;
    return savedUserAgent;
  }
  if (envUserAgent && /^[\u0000-\u00ff]*$/.test(envUserAgent)) {
    saveAppleDeveloperUserAgent(envUserAgent);
    return envUserAgent;
  }
  return "";
}

function rememberEnvironmentFingerprint(envId, fingerprint) {
  const key = String(envId || "");
  if (key) fingerprintsByEnvironmentId.set(key, fingerprint);
  if (fingerprint?.userAgent) fingerprintsByUserAgent.set(fingerprint.userAgent, fingerprint);
}

function normalizeCountryText(value) {
  return String(value || "").trim().toLowerCase();
}

function getLocaleByCountry(country) {
  const text = normalizeCountryText(country);
  const match = (tokens) => tokens.some(token => text.includes(token));
  if (match(["china", "中国", "cn"])) return { language: "zh-CN", languages: "zh-CN,zh,en-US,en", uiLanguage: "zh-CN" };
  if (match(["hong kong", "香港", "hk"])) return { language: "zh-CN", languages: "zh-CN,zh,en-US,en", uiLanguage: "zh-CN" };
  if (match(["taiwan", "台湾", "tw"])) return { language: "zh-CN", languages: "zh-CN,zh,en-US,en", uiLanguage: "zh-CN" };
  if (match(["japan", "日本", "jp"])) return { language: "ja-JP", languages: "ja-JP,ja,en-US,en", uiLanguage: "ja-JP" };
  if (match(["korea", "韩国", "south korea", "kr"])) return { language: "ko-KR", languages: "ko-KR,ko,en-US,en", uiLanguage: "ko-KR" };
  if (match(["germany", "德国", "de"])) return { language: "de-DE", languages: "de-DE,de,en-US,en", uiLanguage: "de-DE" };
  if (match(["france", "法国", "fr"])) return { language: "fr-FR", languages: "fr-FR,fr,en-US,en", uiLanguage: "fr-FR" };
  return { language: "en-US", languages: "en-US,en", uiLanguage: "en-US" };
}

function applyIPLanguageToFingerprint(fingerprint, ipResult) {
  if (!fingerprint || (!fingerprint.languageFollowIP && !fingerprint.uiLanguageFollowIP)) return;
  const country = ipResult && (ipResult.country || ipResult.countryCode || ipResult.country_code || ipResult.region);
  if (!country || country === "—") return;
  const locale = getLocaleByCountry(country);
  if (fingerprint.languageFollowIP) {
    fingerprint.language = locale.language;
    fingerprint.languages = locale.languages;
  }
  if (fingerprint.uiLanguageFollowIP) {
    fingerprint.uiLanguage = locale.uiLanguage;
  }
}

function applyIPGeolocationToFingerprint(fingerprint, ipResult) {
  if (!fingerprint || fingerprint.geolocationFollowIP === false || !ipResult) return;
  const latitude = Number(ipResult.lat ?? ipResult.latitude);
  const longitude = Number(ipResult.lon ?? ipResult.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  fingerprint.geoLatitude = latitude;
  fingerprint.geoLongitude = longitude;
  fingerprint.geoAccuracy = Number(ipResult.accuracy || fingerprint.geoAccuracy || 50);
}

function applyIPDataToFingerprint(fingerprint, ipResult) {
  applyIPLanguageToFingerprint(fingerprint, ipResult);
  applyIPGeolocationToFingerprint(fingerprint, ipResult);
  if (fingerprint && ipResult && ipResult.ip && ipResult.ip !== "—") {
    fingerprint.webrtcPublicIP = String(ipResult.ip);
  }
  if (fingerprint && fingerprint.timezoneFollowIP !== false && ipResult && ipResult.timezone && ipResult.timezone !== "—") {
    fingerprint.timezone = String(ipResult.timezone);
  }
}

function handleGeolocationPermission(ownerWindow, fingerprint, requestingOrigin, callback) {
  const mode = fingerprint && fingerprint.geoPermission || "allow";
  if (mode === "block") {
    callback(false);
    return;
  }
  if (mode === "allow") {
    callback(true);
    return;
  }
  dialog.showMessageBox(ownerWindow, {
    type: "question",
    buttons: ["允许", "禁止"],
    defaultId: 0,
    cancelId: 1,
    title: "地理位置权限",
    message: "网站想获取您的地理位置",
    detail: requestingOrigin ? `来源: ${requestingOrigin}` : "是否允许此网站获取当前浏览器环境的位置？",
    noLink: true,
  }).then(result => callback(result.response === 0)).catch(() => callback(false));
}

function historyFilePath(envId) {
  return path.join(environmentBrowserDataDir(envId), "history.json");
}

function loadHistory(envId = activeEnvironmentId(), force = false) {
  const key = String(envId || "default");
  if (historyStores.has(key) && !force) return historyStores.get(key);
  let entries = [];
  try {
    const raw = fs.readFileSync(historyFilePath(key), "utf8");
    const data = JSON.parse(raw);
    entries = Array.isArray(data) ? data : [];
  } catch (e) {
    entries = [];
  }
  historyStores.set(key, entries);
  return entries;
}

function saveHistory(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const entries = loadHistory(key);
  try {
    fs.mkdirSync(environmentBrowserDataDir(key), { recursive: true });
    fs.writeFileSync(historyFilePath(key), JSON.stringify(entries.slice(0, 1000), null, 2));
  } catch (e) {
    console.warn("save history failed:", e.message);
  }
}

function addHistoryEntry(entry) {
  const envId = String(entry && entry.envId || activeEnvironmentId());
  let entries = loadHistory(envId);
  if (!entry || !isOpenableURL(entry.url)) return;
  const normalized = {
    id: String(Date.now()) + "-" + Math.random().toString(16).slice(2),
    envId,
    envName: String(entry.envName || ""),
    title: String(entry.title || entry.url),
    url: String(entry.url),
    icon: String(entry.icon || ""),
    visitedAt: entry.visitedAt || new Date().toISOString(),
  };
  const first = entries[0];
  if (first && first.url === normalized.url && Date.now() - Date.parse(first.visitedAt || 0) < 1500) return;
  entries.unshift(normalized);
  entries = entries.slice(0, 1000);
  historyStores.set(envId, entries);
  saveHistory(envId);
  installChineseMenu();
}

function getHistorySuggestions(query = "", limit = 8, envId = activeEnvironmentId()) {
  const entries = loadHistory(envId);
  const needle = String(query || "").trim().toLowerCase();
  const seen = new Set();
  const items = [];
  for (const entry of entries) {
    if (!entry || !entry.url || seen.has(entry.url)) continue;
    const haystack = `${entry.title || ""} ${entry.url || ""}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    seen.add(entry.url);
    items.push(entry);
    if (items.length >= limit) break;
  }
  return items;
}

function getTopSites(limit = 8, envId = activeEnvironmentId()) {
  const entries = loadHistory(envId);
  const byDomain = new Map();
  for (const entry of entries) {
    if (!entry || !entry.url || entry.url === "about:blank" || entry.url === "about:ipinfo") continue;
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    const key = parsed.hostname.replace(/^www\./, "");
    if (!key) continue;
    const item = byDomain.get(key) || {
      title: entry.title || entry.url,
      url: parsed.origin + "/",
      icon: entry.icon || "",
      count: 0,
      lastVisitedAt: entry.visitedAt || "",
      host: key,
    };
    item.count += 1;
    if (Date.parse(entry.visitedAt || 0) > Date.parse(item.lastVisitedAt || 0)) {
      item.title = entry.title || entry.url;
      item.icon = entry.icon || item.icon || "";
      item.lastVisitedAt = entry.visitedAt || "";
      item.url = entry.url;
    }
    byDomain.set(key, item);
  }
  const sorted = Array.from(byDomain.values())
    .sort((a, b) => b.count - a.count || Date.parse(b.lastVisitedAt || 0) - Date.parse(a.lastVisitedAt || 0));
  const frequent = sorted.filter(item => item.count >= 2);
  return (frequent.length ? frequent : sorted)
    .slice(0, limit);
}

function deleteHistoryURL(url, envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  let entries = loadHistory(key);
  const target = String(url || "");
  if (!target) return;
  entries = entries.filter(entry => entry.url !== target);
  historyStores.set(key, entries);
  saveHistory(key);
  installChineseMenu();
}

function escHTML(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${m}月${d}日 ${hh}:${mm}`;
}

function buildHistoryHTML(entries) {
  const renderRows = (items) => items.map(entry => `
    <div class="row" data-url="${escHTML(entry.url)}">
      <div class="title">${escHTML(entry.title || entry.url)}</div>
      <div class="url">${escHTML(entry.url)}</div>
      <div class="env">${escHTML(entry.envName || "浏览器环境")}</div>
      <div class="time">${escHTML(formatHistoryTime(entry.visitedAt))}</div>
    </div>
  `).join("");
  const rows = renderRows(entries);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#20242a}
header{height:56px;background:#fff;border-bottom:1px solid #e5eaf2;display:flex;align-items:center;justify-content:space-between;padding:0 18px}
h1{font-size:16px;margin:0}.count{font-size:12px;color:#7b8494}
main{padding:14px}.list{background:#fff;border:1px solid #e6ebf2;border-radius:8px;overflow:hidden}
.row{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(260px,1.8fr) 130px 110px;gap:12px;align-items:center;min-height:58px;padding:10px 14px;border-bottom:1px solid #f0f3f7;cursor:pointer}
.row:last-child{border-bottom:0}.row:hover{background:#f7faff}.title{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.url{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.env,.time{font-size:12px;color:#8a94a6}
.empty{text-align:center;padding:52px;color:#8a94a6}
</style></head><body>
<header><h1>历史记录</h1><div class="count" id="count">共 ${entries.length} 条</div></header>
<main><div class="list" id="list">${rows || '<div class="empty">暂无历史记录</div>'}</div></main>
<script>
document.addEventListener("click", function(event){
  var row = event.target.closest(".row");
  if (!row) return;
  window.open(row.dataset.url, "_blank");
});
</script>
</body></html>`;
}

function showHistoryWindow(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  const entries = loadHistory(key, true);
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    historyWindow._envId = key;
    historyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHistoryHTML(entries))}`);
    return;
  }
  historyWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 760,
    minHeight: 480,
    title: "历史记录",
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  historyWindow._envId = key;
  historyWindow.webContents.setWindowOpenHandler((details) => {
    openURLFromHistory(details.url);
    return { action: "deny" };
  });
  historyWindow.on("closed", () => { historyWindow = null; });
  historyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHistoryHTML(entries))}`);
}

function clearHistory(envId = activeEnvironmentId()) {
  const key = String(envId || "default");
  historyStores.set(key, []);
  saveHistory(key);
  installChineseMenu();
  if (historyWindow && !historyWindow.isDestroyed() && String(historyWindow._envId || "") === key) {
    historyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHistoryHTML([]))}`);
  }
}

function downloadsFilePath() {
  return path.join(app.getPath("userData"), "downloads.json");
}

function loadDownloads(force = false) {
  if (downloadsLoaded && !force) return downloadEntries;
  try {
    const raw = fs.readFileSync(downloadsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    downloadEntries = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    downloadEntries = [];
  }
  downloadsLoaded = true;
  return downloadEntries;
}

function saveDownloads() {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(downloadsFilePath(), JSON.stringify(downloadEntries, null, 2));
  } catch (e) {
    console.warn("save downloads failed:", e.message);
  }
}

function safeFileName(name) {
  const clean = String(name || "download").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return clean || "download";
}

function browserDownloadDir(serialNum) {
  const serial = safeFileName(serialNum || "unknown");
  return path.join(app.getPath("downloads"), serial);
}

function uniqueDownloadPath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function addOrUpdateDownload(entry) {
  loadDownloads();
  const existing = downloadEntries.find(item => item.id === entry.id);
  if (existing) Object.assign(existing, entry);
  else downloadEntries.unshift(entry);
  downloadEntries = downloadEntries.slice(0, 500);
  saveDownloads();
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed() && win._envId) win.webContents.send("browser-downloads-updated", getDownloadsForWindow(win));
  });
}

function getDownloadsForWindow(win) {
  loadDownloads();
  if (!win || !win._envId) return [];
  return downloadEntries.filter(item => item.envId === win._envId).slice(0, 100);
}

function removeDownloadsForEnvironment(envId, serialNum) {
  loadDownloads(true);
  const serial = String(serialNum || "");
  downloadEntries = downloadEntries.filter(item => item.envId !== envId && (!serial || String(item.serialNum || "") !== serial));
  saveDownloads();
  if (serial) {
    try {
      fs.rmSync(browserDownloadDir(serial), { recursive: true, force: true });
    } catch (e) {
      console.warn("remove download directory failed:", e.message);
    }
  }
}

async function clearEnvironmentBrowserData(envId, serialNum) {
  if (!envId) return;
  const envKey = String(envId);
  const win = browserWindows.get(envId);
  if (win && !win.isDestroyed()) win.close();
  const helper = browserHelperProcesses.get(envId);
  if (helper && helper.exitCode === null && !helper.killed) helper.kill();
  browserHelperProcesses.delete(envId);
  stopLocalProxyTunnel(envId);
  unregisterDebugPortWithDaemon(envId).catch(() => {});
  try {
    const ses = session.fromPartition(`persist:env_${envId}`);
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (e) {
    console.warn("clear environment session failed:", e.message);
  }
  historyStores.delete(envKey);
  bookmarkStores.delete(envKey);
  try {
    fs.rmSync(environmentBrowserDataDir(envKey), { recursive: true, force: true });
  } catch (e) {
    console.warn("remove browser data directory failed:", e.message);
  }
  removeDownloadsForEnvironment(envId, serialNum);
}

function attachDownloadHandler(ses, browserWin, serialNum) {
  if (!ses) return;
  ses.__ipauploaderDownloadContext = { browserWin, serialNum };
  if (ses.__ipauploaderDownloadHandlerAttached) return;
  ses.__ipauploaderDownloadHandlerAttached = true;
  ses.on("will-download", (_event, item) => {
    const context = ses.__ipauploaderDownloadContext || {};
    const ownerWin = context.browserWin;
    const ownerSerial = context.serialNum || (ownerWin && ownerWin._serialNum);
    const fileName = safeFileName(item.getFilename());
    const dir = browserDownloadDir(ownerSerial);
    fs.mkdirSync(dir, { recursive: true });
    const savePath = uniqueDownloadPath(dir, fileName);
    const finalFileName = path.basename(savePath);
    item.setSavePath(savePath);
    const id = "dl-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    const baseEntry = {
      id,
      envId: ownerWin && ownerWin._envId || "",
      envName: ownerWin && ownerWin._envConfig && ownerWin._envConfig.name || "",
      serialNum: String(ownerSerial || ""),
      fileName: finalFileName,
      url: item.getURL(),
      path: savePath,
      folder: dir,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    addOrUpdateDownload(baseEntry);
    item.on("updated", (_event, state) => {
      addOrUpdateDownload({
        id,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
        updatedAt: new Date().toISOString(),
      });
    });
    item.once("done", (_event, state) => {
      addOrUpdateDownload({
        id,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (ownerWin && !ownerWin.isDestroyed()) {
        ownerWin.webContents.send("browser-toast", state === "completed" ? `下载完成: ${finalFileName}` : `下载${state}: ${finalFileName}`);
      }
    });
  });
}

// ========== Management Window ==========
function createWindow() {
  if (focusWindow(mainWindow)) return mainWindow;
  const win = new BrowserWindow({
    width: 1280, height: 820,
    minWidth: 1180, minHeight: 740,
    title: BROWSER_APP_NAME,
    frame: false,
    icon: currentAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    closeAllBrowserHelpers();
  });
  win.on("focus", refreshBrowserSerialBadge);
  win.loadFile(path.join(__dirname, "renderer.html"));
  return win;
}

async function authRequest(requestPath, options = {}) {
  try {
    const response = await authServerFetch(requestPath, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      ...body,
      success: response.ok && body.success !== false,
    };
  } catch (error) {
    return { ok: false, status: 0, success: false, error: `无法连接登录服务：${error.message}` };
  }
}

async function syncAppleDeveloperArtifact({ teamId, artifactType, artifactKey, filename, content, metadata = {} }) {
  if (!appleDeveloperRecordId) return { success: false, skipped: true, error: "请先从浏览器开发者账户列表启动证书管理" };
  if (!teamId || !artifactType || !artifactKey || !content) return { success: false, skipped: true, error: "同步资料参数不完整" };
  const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(teamId)}/artifacts/${encodeURIComponent(artifactType)}/${encodeURIComponent(artifactKey)}`;
  const binaryBody = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  let lastError = "";
  const methods = ["PUT", "POST"];
  try {
    for (const method of methods) {
      const response = await authServerFetch(requestPath, {
        method,
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          "X-Artifact-Filename": String(filename || "artifact.bin").replace(/[\r\n]/g, ""),
          "X-Artifact-Metadata": encodeURIComponent(JSON.stringify(metadata || {})),
          ...(method === "POST" ? { "X-HTTP-Method-Override": "PUT" } : {}),
        },
        body: binaryBody,
        signal: AbortSignal.timeout(30000),
      });
      const responseText = await response.text().catch(() => "");
      let body = {};
      try { body = responseText ? JSON.parse(responseText) : {}; } catch {}
      if (response.ok && body.success !== false) return { success: true, artifact: body.artifact };
      const detail = body.error || responseText.slice(0, 180).replace(/\s+/g, " ").trim() || `服务器返回 ${response.status}`;
      lastError = `${method} ${requestPath} 返回 ${response.status}：${detail}`;
      if (!["PUT"].includes(method) || ![404, 405].includes(Number(response.status))) break;
    }
    throw new Error(lastError || "服务器同步失败");
  } catch (error) {
    console.warn(`developer artifact sync failed (${artifactType}/${artifactKey}) ${requestPath}:`, error.message);
    return { success: false, error: error.message || "服务器同步失败" };
  }
}

async function deleteSyncedAppleDeveloperArtifact({ teamId, artifactType, artifactKey }) {
  if (!appleDeveloperRecordId) return { success: false, skipped: true, error: "请先从浏览器开发者账户列表启动证书管理" };
  if (!teamId || !artifactType || !artifactKey) return { success: false, skipped: true, error: "同步资料参数不完整" };
  try {
    const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(teamId)}/artifacts/${encodeURIComponent(artifactType)}/${encodeURIComponent(artifactKey)}`;
    const response = await authServerFetch(requestPath, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    return { success: true };
  } catch (error) {
    console.warn(`delete synced developer artifact failed (${artifactType}/${artifactKey}):`, error.message);
    return { success: false, error: error.message || "服务器同步删除失败" };
  }
}

async function listSyncedAppleDeveloperArtifacts(teamId) {
  if (!appleDeveloperRecordId || !teamId) return { success: false, artifacts: [], error: "同步资料参数不完整" };
  try {
    const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(teamId)}/artifacts`;
    const response = await authServerFetch(requestPath, { credentials: "include", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    return { success: true, artifacts: Array.isArray(body.artifacts) ? body.artifacts : [] };
  } catch (error) {
    return { success: false, artifacts: [], error: error.message || "服务器证书资料读取失败" };
  }
}

function serverCertificateArtifactReadiness(artifacts = []) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  const metadataOf = item => item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const certificates = rows.filter(item => String(item?.artifact_type || "") === "certificate");
  const privateKeys = rows.filter(item => String(item?.artifact_type || "") === "private_key");
  const p12s = rows.filter(item => String(item?.artifact_type || "") === "p12");
  return certificates.map(certificate => {
    const certificateId = String(certificate?.artifact_key || "").trim();
    const metadata = metadataOf(certificate);
    const typeId = String(metadata.typeId || "").trim();
    const csrSyncKey = String(metadata.csrSyncKey || "").trim();
    const hasP12 = p12s.some(item => {
      const itemMetadata = metadataOf(item);
      const key = String(item?.artifact_key || "").trim();
      return String(itemMetadata.certificateId || "").trim() === certificateId || key === certificateId || key === `${certificateId}-p12`;
    });
    const hasPrivateKey = !!csrSyncKey && privateKeys.some(item => {
      const itemMetadata = metadataOf(item);
      return String(item?.artifact_key || "").trim() === csrSyncKey || String(itemMetadata.csrSyncKey || "").trim() === csrSyncKey;
    });
    return { certificateId, typeId, ready: Boolean(certificateId && typeId && (hasP12 || hasPrivateKey)), hasP12, hasPrivateKey };
  }).filter(item => item.certificateId && item.typeId);
}

async function verifySyncedAppleDeveloperArtifactSet(teamId, keep = []) {
  const listed = await listSyncedAppleDeveloperArtifacts(teamId);
  if (!listed.success) return listed;
  const available = new Set(listed.artifacts.map(item => `${item.artifact_type}:${item.artifact_key}`));
  const missing = keep.filter(item => !available.has(`${item.artifactType}:${item.artifactKey}`));
  return missing.length ? { success: false, artifacts: listed.artifacts, error: `服务器缺少 ${missing.length} 个刚创建的证书文件` } : { success: true, artifacts: listed.artifacts };
}

async function pruneSyncedAppleDeveloperArtifactSetLegacy(teamId, keep = [], certificateScopes = [], profileScopes = []) {
  const listed = await listSyncedAppleDeveloperArtifacts(teamId);
  if (!listed.success) return listed;
  const keepKeys = new Set(keep.map(item => `${item.artifactType}:${item.artifactKey}`));
  const certificateScopeKeys = new Set(certificateScopes.map(item => `${item.typeId}:${item.appIdId || ""}`));
  const profileScopeKeys = new Set(profileScopes.map(item => `${String(item.bundleIdentifier || "").toLowerCase()}:${item.profileType}`));
  const staleCertificateIds = new Set();
  const staleCsrKeys = new Set();
  const stale = [];
  for (const artifact of listed.artifacts) {
    const type = String(artifact.artifact_type || "");
    const key = String(artifact.artifact_key || "");
    if (keepKeys.has(`${type}:${key}`)) continue;
    const metadata = artifact.metadata && typeof artifact.metadata === "object" ? artifact.metadata : {};
    if (type === "certificate" && certificateScopeKeys.has(`${metadata.typeId || ""}:${metadata.appIdId || ""}`)) {
      stale.push(artifact); staleCertificateIds.add(key);
      if (metadata.csrSyncKey) staleCsrKeys.add(String(metadata.csrSyncKey));
    } else if (type === "profile" && profileScopeKeys.has(`${String(metadata.bundleIdentifier || "").toLowerCase()}:${String(metadata.profileType || "").toUpperCase()}`)) {
      stale.push(artifact);
    }
  }
  const survivingCsrKeys = new Set(listed.artifacts.filter(item => item.artifact_type === "certificate" && !staleCertificateIds.has(String(item.artifact_key || ""))).map(item => String(item.metadata?.csrSyncKey || "")).filter(Boolean));
  for (const artifact of listed.artifacts) {
    const type = String(artifact.artifact_type || "");
    const key = String(artifact.artifact_key || "");
    if (keepKeys.has(`${type}:${key}`) || stale.includes(artifact)) continue;
    if (type === "p12" && staleCertificateIds.has(String(artifact.metadata?.certificateId || ""))) stale.push(artifact);
    if (["csr", "private_key"].includes(type) && staleCsrKeys.has(key) && !survivingCsrKeys.has(key)) stale.push(artifact);
  }
  for (const artifact of stale) {
    const deleted = await deleteSyncedAppleDeveloperArtifact({ teamId, artifactType: artifact.artifact_type, artifactKey: artifact.artifact_key });
    if (!deleted.success) return deleted;
  }
  return { success: true, removed: stale.length, legacy: true };
}

async function pruneSyncedAppleDeveloperArtifactSet(teamId, keep = [], certificateScopes = [], profileScopes = []) {
  const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(teamId)}/artifacts/prune`;
  try {
    const response = await authServerFetch(requestPath, {
      method: "POST", credentials: "include", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ keep, certificateScopes, profileScopes }), signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404) return pruneSyncedAppleDeveloperArtifactSetLegacy(teamId, keep, certificateScopes, profileScopes);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    return { success: true, ...body };
  } catch (error) {
    return { success: false, error: error.message || "服务器旧证书清理失败" };
  }
}

async function clearSyncedAppleDeveloperArtifacts({ teamId, scope = "" }) {
  if (!appleDeveloperRecordId) return { success: false, skipped: true, error: "请先从浏览器开发者账户列表启动证书管理" };
  if (!teamId) return { success: false, skipped: true, error: "同步资料参数不完整" };
  try {
    const scopeQuery = scope ? `?scope=${encodeURIComponent(String(scope))}` : "";
    const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(teamId)}/artifacts${scopeQuery}`;
    const response = await authServerFetch(requestPath, {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    return { success: true, deleted: Number(body.deleted || 0) };
  } catch (error) {
    console.warn("clear synced developer artifacts failed:", error.message);
    return { success: false, error: error.message || "服务器旧证书清理失败" };
  }
}

async function syncDeveloperAccountP12Password(accountId, p12Password) {
  if (!accountId) return { success: false, skipped: true };
  const requestPath = `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/p12-password`;
  let lastError = "";
  try {
    for (const method of ["PUT", "POST"]) {
      const response = await authServerFetch(requestPath, {
        method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(method === "POST" ? { "X-HTTP-Method-Override": "PUT" } : {}),
        },
        body: JSON.stringify({ p12Password: String(p12Password || DEFAULT_P12_PASSWORD) }),
        signal: AbortSignal.timeout(12000),
      });
      const responseText = await response.text().catch(() => "");
      let body = {};
      try { body = responseText ? JSON.parse(responseText) : {}; } catch {}
      if (response.ok && body.success !== false) return { success: true };
      const detail = body.error || responseText.slice(0, 180).replace(/\s+/g, " ").trim() || `服务器返回 ${response.status}`;
      lastError = `${method} ${requestPath} 返回 ${response.status}：${detail}`;
      if (method !== "PUT" || ![404, 405].includes(Number(response.status))) break;
    }
    if (/404 Not Found|requested URL was not found|服务器返回 404/i.test(lastError)) {
      return { success: false, skipped: true, error: `服务器暂不支持 P12 密码独立同步 (${requestPath})` };
    }
    throw new Error(lastError || "P12 密码同步失败");
  } catch (error) {
    console.warn("developer p12 password sync failed:", error.message);
    return { success: false, error: error.message || "P12 密码同步失败" };
  }
}

async function markDeveloperAccountDeleted(accountId, payload = {}) {
  if (!accountId) return { success: false, skipped: true };
  const body = JSON.stringify({ ...payload, deletedAt: payload.deletedAt || new Date().toISOString() });
  const candidates = [
    { path: `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/deleted`, method: "PUT" },
    { path: `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/delete`, method: "POST" },
    { path: `/api/developer-sync/accounts/${encodeURIComponent(accountId)}`, method: "DELETE" },
  ];
  let lastError = "";
  for (const candidate of candidates) {
    try {
      const response = await authServerFetch(candidate.path, {
        method: candidate.method,
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404 || response.status === 405) {
        lastError = `服务器返回 ${response.status}`;
        continue;
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success === false) throw new Error(result.error || `服务器返回 ${response.status}`);
      return {
        success: true,
        releasedToUser: result.releasedToUser || null,
        alreadyReleased: result.alreadyReleased === true,
      };
    } catch (error) {
      lastError = error.message || "服务器删除状态同步失败";
    }
  }
  console.warn("developer account delete sync failed:", lastError);
  return { success: false, error: lastError || "服务器删除状态同步失败" };
}

const DEVELOPER_ACCOUNT_USAGE_SYNC_INTERVAL_MS = 30000;
const developerAccountUsageSyncTimestamps = new Map();

function currentAppleDeveloperLoginIp() {
  const network = appleDeveloperNetwork || appleDeveloperLaunchNetwork || null;
  return String(network?.ip || network?.lastVerifiedIp || network?.outIp || "").trim();
}

async function syncDeveloperAccountUsageByRecord(accountId, appleId, loginIp = "") {
  const recordId = String(accountId || "").trim();
  const accountAppleId = String(appleId || "").trim();
  const accountLoginIp = String(loginIp || "").trim();
  if (!recordId || !accountAppleId) return { success: false, skipped: true };
  try {
    const payload = { appleId: accountAppleId, launchMode: isCertificateManagerIndependent() ? "standalone" : "browser-bound" };
    if (accountLoginIp) payload.loginIp = accountLoginIp;
    const response = await authServerFetch(
      `/api/developer-sync/accounts/${encodeURIComponent(recordId)}/usage`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    const canonicalAccountId = String(body.usage?.account_id || body.usage?.accountId || "").trim();
    const bindingOwnerKey = String(body.binding?.ownerKey || body.usage?.owner_key || "").trim();
    const bindingUserId = String(body.binding?.userId || body.usage?.user_id || "").trim();
    if (isCertificateManagerIndependent()) {
      if (bindingOwnerKey && /^(boss|employee):\d+$/.test(bindingOwnerKey)) {
        const ownerIdMatch = /^(?:boss|employee):(\d+)$/.exec(bindingOwnerKey);
        const resolvedBindingUserId = bindingUserId || ownerIdMatch?.[1] || String(appleDeveloperAuthUserId || "").trim();
        const previousRecordId = String(appleDeveloperRecordId || recordId).trim();
        const previousOwnerKey = String(appleDeveloperOwnerKey || "").trim();
        const localId = canonicalAccountId || previousRecordId || crypto.randomUUID();
        withDeveloperAccountsDatabase(db => {
          const source = db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND id=?").get(previousOwnerKey, previousRecordId)
            || db.prepare("SELECT * FROM developer_accounts WHERE apple_id=? ORDER BY created_at DESC LIMIT 1").get(accountAppleId.toLowerCase());
          let target = db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND apple_id=?").get(bindingOwnerKey, accountAppleId.toLowerCase());
          if (!target) {
            db.prepare("INSERT OR IGNORE INTO developer_accounts(owner_key,id,apple_id,password,remark,created_at) VALUES(?,?,?,?,?,?)")
              .run(bindingOwnerKey, localId, accountAppleId.toLowerCase(), String(source?.password || ""), String(source?.remark || "独立证书管理"), new Date().toISOString());
            target = db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND apple_id=?").get(bindingOwnerKey, accountAppleId.toLowerCase());
          }
          if (target?.id) appleDeveloperRecordId = String(target.id);
        });
        appleDeveloperOwnerKey = bindingOwnerKey;
        appleDeveloperAuthUserId = resolvedBindingUserId;
      }
      if (canonicalAccountId && recordId === String(appleDeveloperRecordId || recordId).trim()) {
        // The server is authoritative for a direct certificate-manager login.
        // Browser-bound sessions must retain the browser's current identity.
        appleDeveloperRecordId = canonicalAccountId;
      }
    }
    return { success: true, usage: body.usage, access: body.access, binding: body.binding };
  } catch (error) {
    console.warn("developer account usage sync failed:", error.message);
    return { success: false, error: error.message || "开发者账户使用记录同步失败" };
  }
}

function scheduleDeveloperAccountUsageSync(accountId, appleId, loginIp = "") {
  const recordId = String(accountId || "").trim();
  const accountAppleId = String(appleId || "").trim().toLowerCase();
  const accountLoginIp = String(loginIp || "").trim();
  if (!recordId || !accountAppleId) return;
  const key = `${recordId}:${accountAppleId}:${accountLoginIp}`;
  const now = Date.now();
  const previous = Number(developerAccountUsageSyncTimestamps.get(key) || 0);
  if (now - previous < DEVELOPER_ACCOUNT_USAGE_SYNC_INTERVAL_MS) return;
  developerAccountUsageSyncTimestamps.set(key, now);
  syncDeveloperAccountUsageByRecord(recordId, accountAppleId, accountLoginIp).then(result => {
    if (!result?.success) developerAccountUsageSyncTimestamps.set(key, Date.now() - DEVELOPER_ACCOUNT_USAGE_SYNC_INTERVAL_MS + 5000);
  }).catch(error => {
    developerAccountUsageSyncTimestamps.set(key, Date.now() - DEVELOPER_ACCOUNT_USAGE_SYNC_INTERVAL_MS + 5000);
    console.warn("developer account usage background sync failed:", error.message);
  });
}

async function syncAppleDeveloperAccountUsage() {
  return syncDeveloperAccountUsageByRecord(appleDeveloperRecordId, appleDeveloperLaunchAppleId, currentAppleDeveloperLoginIp());
}

async function readAppleDeveloperAccessMap() {
  try {
    const response = await authServerFetch("/api/developer-sync/accounts/access", {
      credentials: "include",
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器返回 ${response.status}`);
    return body.accounts || {};
  } catch (error) {
    console.warn("developer account access read failed:", error.message);
    return null;
  }
}

async function clearAuthCookies(baseURL) {
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    return;
  }
  const hostname = parsed.hostname.toLowerCase();
  const cookies = await session.defaultSession.cookies.get({ domain: hostname }).catch(() => []);
  await Promise.all(cookies
    .filter(cookie => {
      const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
      return domain === hostname || hostname.endsWith(`.${domain}`);
    })
    .map(cookie => {
      const protocol = cookie.secure ? "https:" : parsed.protocol;
      const domain = String(cookie.domain || hostname).replace(/^\./, "");
      return session.defaultSession.cookies.remove(
        `${protocol}//${domain}${cookie.path || "/"}`,
        cookie.name
      ).catch(() => {});
    }));
  await session.defaultSession.cookies.flushStore().catch(() => {});
}

async function syncAuthCookiesFromWebContents(webContentsId) {
  const id = Number(webContentsId || 0);
  const sourceContents = id ? electronWebContents.fromId(id) : null;
  if (!sourceContents || sourceContents.isDestroyed()) {
    return { success: false, error: "登录窗口已关闭，请重新打开登录页" };
  }
  let parsed;
  try {
    parsed = new URL(currentAuthBaseURL());
  } catch {
    return { success: false, error: "登录服务器地址无效" };
  }
  const hostname = parsed.hostname.toLowerCase();
  const sourceSession = sourceContents.session;
  const byURL = await sourceSession.cookies.get({ url: `${parsed.protocol}//${hostname}/` }).catch(() => []);
  const byDomain = await sourceSession.cookies.get({ domain: hostname }).catch(() => []);
  const merged = new Map();
  [...byURL, ...byDomain].forEach(cookie => {
    const domain = String(cookie.domain || hostname).replace(/^\./, "").toLowerCase();
    if (domain !== hostname && !hostname.endsWith(`.${domain}`)) return;
    merged.set(`${cookie.name}\n${cookie.domain || hostname}\n${cookie.path || "/"}`, cookie);
  });
  await Promise.all([...merged.values()].map(cookie => {
    const cookieDomain = String(cookie.domain || hostname);
    const urlHost = cookieDomain.replace(/^\./, "") || hostname;
    const details = {
      url: `${cookie.secure ? "https:" : parsed.protocol}//${urlHost}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value || "",
      path: cookie.path || "/",
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
    };
    if (cookie.domain) details.domain = cookie.domain;
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    return session.defaultSession.cookies.set(details).catch(() => {});
  }));
  await session.defaultSession.cookies.flushStore().catch(() => {});
  return { success: true, count: merged.size };
}

async function replaceDaemonEnvironments(rows) {
  if (!(await isDaemonReady())) return;
  const remote = await fetchDaemonEnvironments().catch(() => []);
  const wanted = new Map(rows.map(row => [String(row.id), row]));
  for (const row of remote) {
    if (!wanted.has(String(row.id))) {
      await fetch(`${DAEMON}/environments/${encodeURIComponent(row.id)}`, { method: "DELETE" }).catch(() => {});
    }
  }
  const remoteIds = new Set(remote.map(row => String(row.id)));
  for (const row of rows) {
    const exists = remoteIds.has(String(row.id));
    await fetch(`${DAEMON}/environments${exists ? `/${encodeURIComponent(row.id)}` : ""}`, {
      method: exists ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    }).catch(() => {});
  }
}

async function syncEnvironmentRowsToCloud(rows = readLocalEnvironments()) {
  const result = await authRequest("/api/browser-sync/environments", {
    method: "PUT",
    body: JSON.stringify({ environments: Array.isArray(rows) ? rows : [] }),
  });
  return !!result.success;
}

async function loadCloudEnvironmentRows(localRows) {
  const me = await authRequest("/api/auth/me");
  // Never expose a previous account's cached browser list while signed out or
  // immediately after switching servers. The selected server and its current
  // authenticated user must be known before local cache can be considered.
  if (!me.success || !me.user) {
    await replaceDaemonEnvironments([]);
    return [];
  }
  const ownerUserId = String(me?.user?.id || "");
  const previousOwnerUserId = readCloudSyncOwnerId();
  const result = await authRequest("/api/browser-sync/environments");
  // An authenticated user's local cache remains a useful offline fallback,
  // but only when it belongs to that same user on this server.
  if (!result.success) {
    return previousOwnerUserId === ownerUserId ? localRows : [];
  }
  const cloudRows = Array.isArray(result.environments) ? result.environments : [];
  // Cloud is authoritative, including an intentionally empty list. Local rows
  // are only a cache and must never seed or override the server implicitly.
  const ensured = ensureEnvironmentSerials(cloudRows);
  writeLocalEnvironments(ensured.rows);
  await replaceDaemonEnvironments(ensured.rows);
  writeCloudSyncOwnerId(ownerUserId);
  return ensured.rows;
}

function browserHelperUserDataDir() {
  const baseName = IS_SYNC_TEST_VARIANT ? "IPAUploader Browser Sync Test" : "IPAUploader Browser";
  return path.join(app.getPath("appData"), readServerConfig().mode === "test" ? `${baseName} Test Server` : baseName);
}

function daemonDataDir() {
  const baseName = IS_SYNC_TEST_VARIANT ? "IPAUploaderNext Sync Test" : "IPAUploaderNext";
  return path.join(app.getPath("appData"), readServerConfig().mode === "test" ? `${baseName} Test Server` : baseName);
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message || "command failed").trim()));
      else resolve(stdout);
    });
  });
}

function environmentSnapshotPaths(envId) {
  const safe = safeFileName(envId || "default");
  return [`Partitions/env_${safe}`, `browser-data/env_${safe}`];
}

function environmentSnapshotUploadPaths(envId) {
  const safe = safeFileName(envId || "default");
  const partition = `Partitions/env_${safe}`;
  return [
    `${partition}/Cookies`, `${partition}/Cookies-journal`,
    `${partition}/Local Storage`, `${partition}/IndexedDB`,
    `${partition}/Session Storage`, `${partition}/Service Worker`,
    `${partition}/WebStorage`, `${partition}/File System`,
    `${partition}/Preferences`, `${partition}/Network Persistent State`,
    `${partition}/Trust Tokens`, `${partition}/Trust Tokens-journal`,
    `${partition}/SharedStorage`, `${partition}/DIPS`, `${partition}/DIPS-wal`, `${partition}/DIPS-shm`,
    `browser-data/env_${safe}`,
  ];
}

async function downloadEnvironmentSnapshot(envId) {
  const response = await session.defaultSession.fetch(
    `${currentAuthBaseURL()}/api/browser-sync/environments/${encodeURIComponent(envId)}/snapshot`
  );
  if (response.status === 404 || response.status === 401) return false;
  if (!response.ok) throw new Error(`下载云端浏览器数据失败: ${response.status}`);
  const archive = path.join(app.getPath("temp"), `ipauploader-${safeFileName(envId)}-${Date.now()}.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const tarCommand = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";
  try {
    const target = browserHelperUserDataDir();
    fs.mkdirSync(target, { recursive: true });
    const allowed = environmentSnapshotPaths(envId);
    const entries = String(await runFile(tarCommand, ["-tzf", archive])).split(/\r?\n/).filter(Boolean);
    if (entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]+/).includes("..") || !allowed.some(prefix => entry === prefix || entry.startsWith(`${prefix}/`)))) {
      throw new Error("云端浏览器快照包含非法路径");
    }
    const backups = [];
    try {
      for (const relative of allowed) {
        const current = path.join(target, relative);
        if (!fs.existsSync(current)) continue;
        const backup = `${current}.sync-backup`;
        fs.rmSync(backup, { recursive: true, force: true });
        fs.renameSync(current, backup);
        backups.push({ current, backup });
      }
      await runFile(tarCommand, ["-xzf", archive, "-C", target]);
      backups.forEach(item => {
        try { fs.rmSync(item.backup, { recursive: true, force: true }); } catch {}
      });
      return true;
    } catch (error) {
      for (const item of backups) {
        fs.rmSync(item.current, { recursive: true, force: true });
        if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.current);
      }
      throw error;
    }
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function uploadEnvironmentSnapshot(envId) {
  const root = browserHelperUserDataDir();
  // Sync portable login/site state without disposable HTTP, code and GPU caches.
  const relativePaths = environmentSnapshotUploadPaths(envId).filter(item => fs.existsSync(path.join(root, item)));
  if (!relativePaths.length) return false;
  const archive = path.join(app.getPath("temp"), `ipauploader-${safeFileName(envId)}-${Date.now()}.tar.gz`);
  try {
    await runFile(process.platform === "win32" ? "tar.exe" : "/usr/bin/tar", ["-czf", archive, "-C", root, ...relativePaths]);
    const stat = fs.statSync(archive);
    if (stat.size > 490 * 1024 * 1024) throw new Error("浏览器数据超过 490MB，请先清理缓存后同步");
    const response = await session.defaultSession.fetch(
      `${currentAuthBaseURL()}/api/browser-sync/environments/${encodeURIComponent(envId)}/snapshot`,
      { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: fs.readFileSync(archive) }
    );
    if (!response.ok) throw new Error(`上传云端浏览器数据失败: ${response.status}`);
    return true;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

// ========== Open Browser Environment ==========
function notifyBrowserRunningState(envId, running) {
  const detail = running ? runningBrowserDetail(envId) : { envId, running: false };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed() || win._envId) continue;
    win.webContents.send("browser-running-state", detail);
  }
}

function helperDebugPort(envId) {
  const configured = configuredDebugPort(envId);
  if (configured) return configured;
  return defaultDebugPort(envId);
}

function configuredDebugPort(envId) {
  const env = readLocalEnvironments().find(item => String(item.id) === String(envId));
  const port = Number(env && env.debugPort || 0);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 0;
}

function defaultDebugPort(envId) {
  let hash = 0;
  for (let i = 0; i < String(envId).length; i++) {
    hash = ((hash << 5) - hash) + String(envId).charCodeAt(i);
    hash |= 0;
  }
  return DEBUG_BASE_PORT + (Math.abs(hash) % 1000);
}

function runningBrowserDetail(envId) {
  const helper = browserHelperProcesses.get(envId);
  if (helper && helper.exitCode === null && !helper.killed) {
    const debugPort = helperDebugPort(envId);
    return {
      envId,
      running: true,
      helper: true,
      mode: "helper",
      pid: helper.pid || 0,
      debugPort,
      cdpURL: debugPort ? `http://127.0.0.1:${debugPort}` : "",
    };
  }

  const win = browserWindows.get(envId);
  if (win && !win.isDestroyed()) {
    return {
      envId,
      running: true,
      helper: false,
      mode: "window",
      debugPort: activeDebugPort,
      cdpURL: activeDebugPort ? `http://127.0.0.1:${activeDebugPort}` : "",
    };
  }

  return { envId, running: false };
}

async function clearEnvironmentDataViaCDP(envId) {
  const port = helperDebugPort(envId);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`调试接口不可用 (${response.status})`);
  const targets = await response.json();
  const target = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
  if (!target) throw new Error("未找到环境页面");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("清理请求超时")), 10000);
    ws.onopen = () => {
      const id = ++seq;
      pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {
        expression: "window.browserBridge && window.browserBridge.clearBrowsingData ? window.browserBridge.clearBrowsingData() : null",
        awaitPromise: true, returnByValue: true
      }}));
    };
    ws.onmessage = (event) => {
      let message;
      try {
        const raw = String(event?.data || "").trim();
        if (!raw) return;
        message = JSON.parse(raw);
      } catch (_) { return; }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || "CDP执行失败"));
      else item.resolve(message.result?.result?.value);
    };
    ws.onerror = () => reject(new Error("调试连接失败"));
  });
  try { ws.close(); } catch (_) {}
  return result || { ok: true };
}

function closeAllBrowserHelpers() {
  if (IS_BROWSER_HELPER) return;
  for (const [envId, child] of browserHelperProcesses) {
    if (child && child.exitCode === null && !child.killed) {
      child.kill();
    }
    stopLocalProxyTunnel(envId);
    notifyBrowserRunningState(envId, false);
  }
  browserHelperProcesses.clear();
}

async function closeAllBrowserHelpersAndSync() {
  const exits = [];
  for (const [envId, child] of browserHelperProcesses) {
    if (child && child.exitCode === null && !child.killed) {
      exits.push(new Promise(resolve => child.once("exit", resolve)));
      child.kill();
    }
    stopLocalProxyTunnel(envId);
    notifyBrowserRunningState(envId, false);
  }
  await Promise.all(exits);
  const uploads = Array.from(snapshotUploadTasks.values());
  if (uploads.length) await Promise.all(uploads);
}

function packagedAppEntryPath() {
  if (!app.isPackaged) return app.getAppPath();
  const asarPath = path.join(process.resourcesPath, "app.asar");
  if (fs.existsSync(asarPath)) return asarPath;
  return path.join(process.resourcesPath, "app");
}

function browserHelperArgs(envId, appPath = packagedAppEntryPath()) {
  const args = [appPath];
  args.push("--browser-helper", `--env-id=${envId}`, `--user-data-dir=${browserHelperUserDataDir()}`);
  const port = helperDebugPort(envId);
  args.push(`--remote-debugging-port=${port}`);
  return args;
}

const KERNEL_ELECTRON_VERSIONS = { "148": "42.7.0", "146": "41.10.2", "144": "40.10.6", "142": "39.8.2" };
const kernelDownloadTasks = new Map();

function kernelRuntimePaths(kernel) {
  const electronVersion = KERNEL_ELECTRON_VERSIONS[kernel];
  if (!electronVersion) throw new Error(`不支持的浏览器内核版本: ${kernel}`);
  const root = path.join(app.getPath("userData"), "kernels", `electron-${electronVersion}`);
  const isWindows = process.platform === "win32";
  const archiveLabel = isWindows ? "Windows-x64" : "macOS-ARM64";
  const platformId = isWindows ? "win-x64" : "mac-arm64";
  const archiveName = `Chromium-${kernel}-Electron-${electronVersion}-${archiveLabel}.zip`;
  const archiveDir = path.join(app.getPath("userData"), "kernel-archives");
  const archive = path.join(archiveDir, archiveName);
  const rawExecutable = isWindows
    ? path.join(root, "electron.exe")
    : path.join(root, "Electron.app", "Contents", "MacOS", "Electron");
  const executable = isWindows ? path.join(root, `${BROWSER_APP_NAME}.exe`) : rawExecutable;
  return { kernel, electronVersion, root, archiveDir, archiveName, archive, executable, rawExecutable, platformId };
}

function brandKernelRuntime(paths) {
  if (process.platform === "win32") {
    if (!fs.existsSync(paths.executable) && fs.existsSync(paths.rawExecutable)) {
      fs.renameSync(paths.rawExecutable, paths.executable);
    }
    return paths;
  }
  const runtimeAppPath = path.join(paths.root, "Electron.app");
  const plistPath = path.join(runtimeAppPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) return paths;
  let nameChanged = false;
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    try {
      const current = String(execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      })).trim();
      if (current !== BROWSER_APP_NAME) {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${BROWSER_APP_NAME}`, plistPath], { stdio: "ignore" });
        nameChanged = true;
      }
    } catch {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${BROWSER_APP_NAME}`, plistPath], { stdio: "ignore" });
        nameChanged = true;
      } catch (error) {
        console.warn("browser kernel name update failed:", key, error.message);
      }
    }
  }
  if (nameChanged) {
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", runtimeAppPath], { stdio: "ignore" });
  }
  return paths;
}

function kernelInstalled(kernel) {
  try {
    const paths = kernelRuntimePaths(String(kernel));
    return fs.existsSync(paths.executable) || fs.existsSync(paths.rawExecutable);
  }
  catch { return false; }
}

async function extractKernelArchive(paths) {
  if (process.platform === "win32") {
    await runFile("tar.exe", ["-xf", paths.archive, "-C", paths.root]);
    return;
  }
  await runFile("/usr/bin/unzip", ["-q", "-o", paths.archive, "-d", paths.root]);
}

async function downloadKernelArchive(paths, progressSender) {
  const manifest = await fetchKernelManifest();
  const item = manifest.find(row =>
    String(row.version) === paths.kernel && String(row.platform) === paths.platformId
  );
  if (!item?.available || !item.downloadUrl) throw new Error(`服务器尚未提供 Chromium ${paths.kernel} 内核`);
  const response = await session.defaultSession.fetch(new URL(item.downloadUrl, currentAuthBaseURL()).toString(), {
    credentials: "include", signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`Chromium ${paths.kernel} 内核下载失败 (${response.status})`);
  fs.mkdirSync(paths.archiveDir, { recursive: true });
  const temporary = `${paths.archive}.part`;
  const output = fs.createWriteStream(temporary, { mode: 0o600 });
  const reader = response.body.getReader();
  const hash = crypto.createHash("sha256");
  const total = Number(response.headers.get("content-length") || item.size || 0);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise(resolve => output.once("drain", resolve));
      if (progressSender && !progressSender.isDestroyed()) {
        progressSender.send("browser-kernel-download-progress", {
          version: paths.kernel, received, total,
          percent: total ? Math.min(100, Math.round(received / total * 100)) : 0,
        });
      }
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  const digest = hash.digest("hex");
  if (item.sha256 && digest.toLowerCase() !== String(item.sha256).toLowerCase()) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Chromium ${paths.kernel} 内核校验失败，请重新下载`);
  }
  fs.renameSync(temporary, paths.archive);
}

async function fetchKernelManifest() {
  const manifestResponse = await session.defaultSession.fetch(`${currentAuthBaseURL()}/api/browser-kernels`, {
    credentials: "include", signal: AbortSignal.timeout(15000),
  });
  const manifestBody = await manifestResponse.json().catch(() => ({}));
  if (!manifestResponse.ok || manifestBody.success === false) {
    throw new Error(manifestBody.error || `内核清单读取失败 (${manifestResponse.status})`);
  }
  return Array.isArray(manifestBody.kernels) ? manifestBody.kernels : [];
}

async function ensureKernelRuntimeByVersion(kernel, progressSender, forceUpdate = false) {
  const paths = kernelRuntimePaths(String(kernel));
  if (!forceUpdate && (fs.existsSync(paths.executable) || fs.existsSync(paths.rawExecutable))) {
    return { ...brandKernelRuntime(paths), installed: true };
  }
  if (kernelDownloadTasks.has(paths.kernel)) return kernelDownloadTasks.get(paths.kernel);
  const task = (async () => {
    if (forceUpdate) {
      fs.rmSync(paths.archive, { force: true });
    }
    if (!fs.existsSync(paths.archive)) await downloadKernelArchive(paths, progressSender);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.mkdirSync(paths.root, { recursive: true });
    await extractKernelArchive(paths);
    if (!fs.existsSync(paths.rawExecutable) && !fs.existsSync(paths.executable)) {
      fs.rmSync(paths.root, { recursive: true, force: true });
      throw new Error(`Chromium ${paths.kernel} 内核解压后文件不完整`);
    }
    return { ...brandKernelRuntime(paths), installed: true };
  })().finally(() => kernelDownloadTasks.delete(paths.kernel));
  kernelDownloadTasks.set(paths.kernel, task);
  return task;
}

async function resolveKernelRuntime(envId, progressSender) {
  const env = readLocalEnvironments().find(item => String(item.id) === String(envId));
  const kernel = String(env?.fingerprint?.kernelVersion || "148");
  const runtime = await ensureKernelRuntimeByVersion(kernel, progressSender);
  return { executable: runtime.executable, appPath: packagedAppEntryPath() };
}

function helperLaunchOptions(envId) {
  const env = readLocalEnvironments().find(item => String(item && item.id) === String(envId));
  const fp = normalizeFingerprint(env && env.fingerprint || {});
  let uiLanguage = fp.uiLanguage || fp.language || "zh-CN";
  if (fp.uiLanguageFollowIP && env && env.proxy) {
    const proxyCountry = env.proxy.country || env.proxy.countryCode || env.proxy.region || "";
    if (proxyCountry) uiLanguage = getLocaleByCountry(proxyCountry).uiLanguage;
  }
  return {
    webrtcMode: fp.webrtcMode || "hide",
    ignoreHttpsErrors: !!fp.ignoreHttpsErrors,
    uiLanguage,
  };
}

async function openBrowserHelperProcess(envId, progressSender) {
  const existing = browserHelperProcesses.get(envId);
  if (existing && existing.exitCode === null && !existing.killed) {
    return runningBrowserDetail(envId);
  }

  const pendingUpload = snapshotUploadTasks.get(String(envId));
  if (pendingUpload) {
    const result = await pendingUpload;
    if (!result.ok) console.warn("previous cloud browser snapshot upload failed:", result.error.message);
  }

  try {
    await downloadEnvironmentSnapshot(envId);
  } catch (error) {
    console.warn("cloud browser snapshot download failed, using local data:", error.message);
  }

  const launchEnvironment = readLocalEnvironments().find(item => String(item && item.id) === String(envId));
  if (!launchEnvironment) throw new Error("所选环境已被同步刷新，请刷新列表后重试");
  const launchConfigPath = path.join(
    app.getPath("temp"),
    `ipauploader-launch-${safeFileName(envId)}-${Date.now()}.json`
  );
  const authState = await authRequest("/api/auth/me").catch(() => null);
  const launchPayload = {
    ...launchEnvironment,
    desktopAccount: authState?.success && authState.user ? {
      username: String(authState.user.username || ""),
      loginType: authState.user.login_type === "employee" ? "employee" : "boss",
      id: authState.user.login_type === "employee" ? authState.user.sub_account_id : authState.user.id,
    } : null,
  };
  fs.writeFileSync(launchConfigPath, JSON.stringify(launchPayload));

  const helperEnv = { ...process.env };
  delete helperEnv.ELECTRON_RUN_AS_NODE;
  helperEnv.IPAUPLOADER_DAEMON_URL = DAEMON;
  helperEnv.IPAUPLOADER_DAEMON_ADDR = daemonAddrFromURL(DAEMON);
  helperEnv.IPAUPLOADER_DAEMON_DATA_DIR = daemonDataDir();
  helperEnv.IPAUPLOADER_LAUNCH_CONFIG = launchConfigPath;
  const appIconPath = [path.join(process.resourcesPath, "AppIcon.png"), SOURCE_APP_ICON_PNG, APP_ICON]
    .find((iconPath) => fs.existsSync(iconPath));
  if (appIconPath) helperEnv.IPAUPLOADER_APP_ICON = appIconPath;
  const launchOptions = helperLaunchOptions(envId);
  helperEnv.IPAUPLOADER_WEBRTC_MODE = launchOptions.webrtcMode;
  helperEnv.IPAUPLOADER_IGNORE_HTTPS_ERRORS = process.env.IPAUPLOADER_ALLOW_INSECURE_HTTPS === "1" ? "1" : "0";
  helperEnv.IPAUPLOADER_UI_LANGUAGE = launchOptions.uiLanguage;
  let runtime;
  try { runtime = await resolveKernelRuntime(envId, progressSender); } catch (error) {
    fs.rmSync(launchConfigPath, { force: true });
    console.error("kernel runtime unavailable:", error.message);
    throw error;
  }
  const child = spawn(runtime.executable, browserHelperArgs(envId, runtime.appPath), {
    detached: true,
    stdio: "ignore",
    env: helperEnv,
  });
  browserHelperProcesses.set(envId, child);
  notifyBrowserRunningState(envId, true);
  // Extract debug port from args for daemon registration
  const portArg = browserHelperArgs(envId).find(a => a.startsWith('--remote-debugging-port='));
  if (portArg) {
    const port = parseInt(portArg.split('=')[1], 10);
    registerDebugPortWithDaemon(envId, port).catch(() => {});
  }
  child.once("error", (error) => {
    fs.rmSync(launchConfigPath, { force: true });
    console.error("browser helper failed to start:", { envId, error: error.message });
    if (browserHelperProcesses.get(envId) === child) browserHelperProcesses.delete(envId);
    notifyBrowserRunningState(envId, false);
  });
  child.once("exit", () => {
    fs.rmSync(launchConfigPath, { force: true });
    if (browserHelperProcesses.get(envId) === child) {
      browserHelperProcesses.delete(envId);
      notifyBrowserRunningState(envId, false);
    }
    unregisterDebugPortWithDaemon(envId).catch(() => {});
    const uploadTask = uploadEnvironmentSnapshot(envId)
      .then(() => ({ ok: true }))
      .catch(error => {
        console.warn("cloud browser snapshot upload failed:", error.message);
        return { ok: false, error };
      })
      .finally(() => {
        if (snapshotUploadTasks.get(String(envId)) === uploadTask) {
          snapshotUploadTasks.delete(String(envId));
        }
      });
    snapshotUploadTasks.set(String(envId), uploadTask);
  });
  child.unref();
  return runningBrowserDetail(envId);
}

async function openBrowserEnvironment(envId) {
  const requestedId = String(envId || "");
  let env = null;
  let envs = [];
  // The manager writes the exact launch configuration before spawning a
  // browser helper. Use it immediately: a browser window must not depend on a
  // second cloud/daemon request that may be slow or offline.
  if (process.env.IPAUPLOADER_LAUNCH_CONFIG) {
    try {
      const launchEnv = JSON.parse(fs.readFileSync(process.env.IPAUPLOADER_LAUNCH_CONFIG, "utf8"));
      if (launchEnv && String(launchEnv.id) === requestedId) env = launchEnv;
    } catch (error) {
      console.warn("read browser launch environment failed:", error.message);
    }
  }
  if (!env) {
    // Manager-window launches still resolve against the currently selected
    // server's synchronized environment list.
    envs = await loadEnvironmentRows();
    env = envs.find(e => String(e.id) === requestedId);
  }
  console.log("[main] openBrowserEnvironment", { envId, envCount: env ? Math.max(envs.length, 1) : envs.length, ids: env ? [env.id] : envs.map(item => item.id) });
  if (!env && /^\d+$/.test(requestedId)) {
    env = envs[Number(requestedId) - 1];
  }
  if (!env && envs.length === 1) {
    console.warn("environment id not found, falling back to the only local environment", {
      requestedId,
      availableIds: envs.map(item => item.id),
    });
    env = envs[0];
  }
  if (!env) {
    console.warn("environment not found", {
      requestedId,
      availableIds: envs.map(item => item.id),
    });
    throw new Error("Environment not found");
  }
  envId = env.id;
  assertUniqueEnvironmentFingerprint(env, envs, { ignoreEnvId: envId });
  const fingerprint = normalizeFingerprint(env.fingerprint);
  env.fingerprint = fingerprint;
  rememberEnvironmentFingerprint(envId, fingerprint);

  // If already open, focus existing window
  const existing = browserWindows.get(envId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return { running: true };
  }

  const serialNum = String(env.serialNum || "");
  if (!serialNum) {
    throw new Error("环境缺少序列号，请刷新环境列表后重试。");
  }
  if (IS_BROWSER_HELPER) setBrowserSerialBadge(serialNum);

  // Show launch progress window
  const progressWin = new BrowserWindow({
    show: false,
    width: 460, height: 300,
    frame: true, resizable: false,
    alwaysOnTop: true,
    title: `正在启动浏览器 - ${env.name}`,
    icon: currentAppIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  const progressHTML = buildProgressHTML(env);
  await progressWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressHTML)}`);

  // Step 1: Load config
  updateProgress(progressWin, "step1", "✅ 配置文件加载完成", "done");
  await sleep(200);

  // Step 2: Configure proxy
  updateProgress(progressWin, "step2", "⏳ 正在配置代理与网络...", "loading");
  const partition = `persist:env_${envId}`;
  const ses = session.fromPartition(partition);
  environmentIdsBySession.set(ses, envId);
  const cookieSyncPath = path.join(environmentBrowserDataDir(envId), "cloud-cookies.json");
  if (fs.existsSync(cookieSyncPath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookieSyncPath, "utf8"));
      for (const cookie of Array.isArray(cookies) ? cookies : []) {
        const host = String(cookie.domain || "").replace(/^\./, "");
        if (!host || !cookie.name) continue;
        const details = {
          url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
          name: cookie.name,
          value: cookie.value || "",
          domain: cookie.domain,
          path: cookie.path || "/",
          secure: !!cookie.secure,
          httpOnly: !!cookie.httpOnly,
        };
        if (cookie.sameSite) details.sameSite = cookie.sameSite;
        if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
        await ses.cookies.set(details).catch(() => {});
      }
    } catch (error) {
      console.warn("restore cloud cookies failed:", error.message);
    }
  }
  ses.setUserAgent(fingerprint.userAgent);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders["User-Agent"] = fingerprint.userAgent;
    details.requestHeaders["Accept-Language"] = fingerprint.languages;
    callback({ requestHeaders: details.requestHeaders });
  });
  const proxyEnabled = !!(env.proxy && env.proxy.enabled && env.proxy.host && env.proxy.port);
  if (env.proxy && env.proxy.enabled && env.proxy.host && env.proxy.port) {
    const proto = env.proxy.type || "http";
    if (proto === "socks5") {
      // SOCKS5 with auth → use daemon HTTP CONNECT tunnel (Electron can't auth SOCKS5)
      try {
        const tunnelResp = await fetch(`${DAEMON}/proxy/tunnel/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: envId })
        });
        const tunnelData = await readJSONResponse(tunnelResp, "代理隧道接口不可用");
        if (tunnelData.port && tunnelData.port > 0) {
          await ses.setProxy({ proxyRules: `http://127.0.0.1:${tunnelData.port}` });
          updateProgress(progressWin, "step2", `✅ 代理配置完成 (SOCKS5 ${env.proxy.host}:${env.proxy.port})`, "done");
        } else {
          await ses.setProxy({ proxyRules: `socks5://${env.proxy.host}:${env.proxy.port}` });
          updateProgress(progressWin, "step2", `✅ 代理配置完成 (直接使用 SOCKS5 代理 ${env.proxy.host}:${env.proxy.port})`, "done");
        }
      } catch (e) {
        const requiresTunnel = !!(env.proxy.username || env.proxy.password);
        if (requiresTunnel) {
          console.warn("[proxy] daemon tunnel unavailable, trying local node tunnel:", e.message);
          try {
            const localTunnel = await startLocalProxyTunnel(envId, env.proxy);
            await ses.setProxy({ proxyRules: `http://127.0.0.1:${localTunnel.port}` });
            updateProgress(
              progressWin,
              "step2",
              `✅ 代理配置完成 (本地隧道 -> SOCKS5 ${env.proxy.host}:${env.proxy.port})`,
              "done"
            );
          } catch (localError) {
            updateProgress(
              progressWin,
              "step2",
              "❌ 代理隧道不可用，SOCKS5 账号密码代理无法启用，已中止启动",
              "error"
            );
            console.warn("[proxy] local tunnel failed:", localError.message);
            await sleep(1200);
            progressWin.close();
            throw new Error("代理隧道不可用，SOCKS5 账号密码代理无法启用");
          }
        } else {
          await ses.setProxy({ proxyRules: `socks5://${env.proxy.host}:${env.proxy.port}` });
          updateProgress(
            progressWin,
            "step2",
            `✅ 代理配置完成 (直接使用 SOCKS5 代理 ${env.proxy.host}:${env.proxy.port})`,
            "done"
          );
          console.warn("[proxy] tunnel unavailable, using socks5 proxy directly:", e.message);
        }
      }
    } else {
      const proxyURL = `${proto}://${env.proxy.username ? env.proxy.username + ":" + env.proxy.password + "@" : ""}${env.proxy.host}:${env.proxy.port}`;
      await ses.setProxy({ proxyRules: proxyURL });
      updateProgress(progressWin, "step2", `✅ 代理配置完成 (${(env.proxy.type || "HTTP").toUpperCase()} ${env.proxy.host}:${env.proxy.port})`, "done");
    }
  } else {
    // Persisted Electron sessions keep their previous proxy rules unless we explicitly clear them.
    await ses.setProxy({ mode: "direct" });
    updateProgress(progressWin, "step2", "✅ 直连模式", "done");
  }
  await sleep(200);

  // Step 3: Validate proxy before opening the browser window
  let ipResult = null;
  if (proxyEnabled) {
    updateProgress(progressWin, "step3", "⏳ 正在检测代理是否可用...", "loading");
    try {
      ipResult = await detectIPStandalone(env.proxy || {}, envId);
    } catch (e) {
      ipResult = {
        ip: "—",
        proxyText: "代理检测失败",
        statusText: e.message || "检测超时或网络不可达",
        error: e.message || "检测超时或网络不可达",
        checkedAt: new Date().toISOString().replace("T", " ").substring(0, 19),
      };
    }

    if (!isProxyDetectOK(ipResult)) {
      const tunnelReason = localProxyErrors.get(envId);
      const reason = tunnelReason || (ipResult && (ipResult.statusText || ipResult.error) ? (ipResult.statusText || ipResult.error) : "代理不可用");
      updateProgress(progressWin, "step3", `❌ 代理检测失败: ${reason}，已中止启动`, "error");
      await sleep(1200);
      progressWin.close();
      throw new Error(`代理检测失败: ${reason}`);
    } else {
      const ipText = ipResult.ip + " (代理)";
      updateProgress(progressWin, "step3", `✅ 代理可用，出口IP: ${ipText}`, "done");
    }
  } else {
    updateProgress(progressWin, "step3", "⏳ 正在检测本机出口IP...", "loading");
    try {
      ipResult = await detectIPStandalone({ enabled: false });
    } catch (e) { /* timeout, continue */ }

    if (ipResult && ipResult.ip && ipResult.ip !== "—") {
      updateProgress(progressWin, "step3", `✅ 已强制直连，本机出口IP: ${ipResult.ip}`, "done");
    } else {
      updateProgress(progressWin, "step3", "✅ 已强制直连，本机IP检测后台继续...", "done");
    }
  }
  applyIPDataToFingerprint(fingerprint, ipResult);
  rememberEnvironmentFingerprint(envId, fingerprint);
  await sleep(150);
  const guardSessionId = `guard-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  // Step 4: Initialize browser engine
  updateProgress(progressWin, "step4", "⏳ 正在初始化浏览器引擎...", "loading");
  // Pre-warm the session by setting up permissions
  await ses.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "geolocation") {
      handleGeolocationPermission(BrowserWindow.fromWebContents(webContents), fingerprint, webContents.getURL(), callback);
      return;
    }
    callback(true);
  });
  updateProgress(progressWin, "step4", "✅ 浏览器引擎就绪 (Chromium)", "done");
  await sleep(150);

  // Step 5: Build browser window
  updateProgress(progressWin, "step5", "⏳ 正在构建窗口界面...", "loading");
  const windowWidth = Math.max(1100, Number(fingerprint.windowWidth || 1280));
  const windowHeight = Math.max(700, Number(fingerprint.windowHeight || 720));
  const browserWin = new BrowserWindow({
    width: windowWidth, height: windowHeight,
    minWidth: 1100, minHeight: 700,
    title: env.name || "Browser",
    icon: currentAppIcon(),
    titleBarStyle: "default",
    webPreferences: {
      partition: partition,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, "browser-preload.js")
    }
  });
  browserWindows.set(envId, browserWin);
  notifyBrowserRunningState(envId, true);
  browserWin.on("focus", () => {
    lastFocusedBrowserWindow = browserWin;
    if (browserWin._serialNum) setBrowserSerialBadge(browserWin._serialNum);
  });
  let persistingBeforeClose = false;
  browserWin.on("close", event => {
    if (persistingBeforeClose) return;
    event.preventDefault();
    persistingBeforeClose = true;
    (async () => {
      try {
        await ses.flushStorageData();
        const cookies = await ses.cookies.get({});
        fs.mkdirSync(environmentBrowserDataDir(envId), { recursive: true });
        fs.writeFileSync(cookieSyncPath, JSON.stringify(cookies));
      } catch (error) {
        console.warn("save cloud cookies failed:", error.message);
      } finally {
        if (!browserWin.isDestroyed()) browserWin.destroy();
      }
    })();
  });
  browserWin.on("closed", () => {
    if (lastFocusedBrowserWindow === browserWin) lastFocusedBrowserWindow = null;
    browserWindows.delete(envId);
    notifyBrowserRunningState(envId, false);
    refreshBrowserSerialBadge();
    // Clean up tunnel and unregister debug port
    fetch(`${DAEMON}/proxy/tunnel/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentId: envId })
    }).catch(() => {});
    stopLocalProxyTunnel(envId);
    unregisterDebugPortWithDaemon(envId).catch(() => {});
  });
  attachPopupHandler(browserWin.webContents, browserWin);
  browserWin.webContents.on("did-attach-webview", (_event, webContents) => {
    if (webContents && Number.isInteger(webContents.id)) {
      webviewEnvironmentIds.set(webContents.id, envId);
      webContents.once("destroyed", () => {
        webviewEnvironmentIds.delete(webContents.id);
      });
    }
    attachPopupHandler(webContents, browserWin);
    attachContextMenu(webContents, browserWin);
    webContents.setUserAgent(fingerprint.userAgent);
  });
  // Store env config for IPC reference
  browserWin._envConfig = env;
  browserWin._envId = envId;
  browserWin._serialNum = serialNum;
  browserWin._fingerprint = fingerprint;
  browserWin._guardSessionId = guardSessionId;
  setBrowserSerialBadge(serialNum);
  attachDownloadHandler(ses, browserWin, serialNum);
  updateProgress(progressWin, "step5", "✅ 窗口界面构建完成", "done");
  await sleep(100);

  // Load browser.html (multi-tab browser chrome)
  browserWin.loadFile(path.join(__dirname, "browser.html"));

  // Send config + IP to browser window once page is ready
  browserWin.webContents.on("did-finish-load", () => {
    const proxyLabel = env.proxy && env.proxy.enabled
      ? `${(env.proxy.type || "HTTP").toUpperCase()} ${env.proxy.host}:${env.proxy.port}`
      : "直连";
    const now = new Date();
    const startedAt = `${String(now.getMonth()+1).padStart(2,"0")}月${String(now.getDate()).padStart(2,"0")}日 ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    browserWin._serialNum = serialNum;
    browserWin._startedAt = startedAt;
    browserWin.webContents.send("browser-config", {
      config: {
        name: env.name || "",
        homeUrl: env.homeUrl || "",
        proxyLabel: proxyLabel,
        note: env.note || "",
        envId: envId,
        serialNum: serialNum,
        startedAt: startedAt,
        guardSessionId: guardSessionId,
        proxy: env.proxy || {},
        ipGuard: env.ipGuard || { enabled: false, expectedIP: "" },
        fingerprint: fingerprint,
        desktopAccount: env.desktopAccount || null,
      },
      ipInfo: ipResult || null,
    });
  });

  // Background IP detection (if timed out)
  if (!ipResult || !ipResult.ip || ipResult.ip === "—") {
    detectIPBackground(env, browserWin);
  }

  await sleep(200);
  progressWin.close();
  browserWin.focus();

  // Register CDP debug port with daemon for Python automation
  registerDebugPortWithDaemon(envId, activeDebugPort).catch(() => {});

  return runningBrowserDetail(envId);
}

async function openBrowserEnvironmentByDebugPort(debugPort) {
  const port = Number(debugPort || 0);
  if (!Number.isInteger(port) || port <= 0) return { running: false };
  const envs = await loadEnvironmentRows();
  const env = envs.find(item => Number(item && item.debugPort || 0) === port);
  if (!env) {
    throw new Error(`未找到 CDP 端口为 ${port} 的浏览器环境`);
  }
  console.log("[main] opening browser environment by cdp port", {
    debugPort: port,
    envId: env.id,
    serialNum: env.serialNum,
    name: env.name,
  });
  return openBrowserHelperProcess(env.id);
}

async function registerDebugPortWithDaemon(envId, port) {
  try {
    await fetch(`${DAEMON}/browser/debug/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentId: envId, debugPort: port }),
    });
    console.log(`[main] registered debug port ${port} for env ${envId}`);
  } catch (e) {
    // daemon may not be running; that's ok
  }
}

async function unregisterDebugPortWithDaemon(envId) {
  try {
    await fetch(`${DAEMON}/browser/debug/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environmentId: envId }),
    });
  } catch (e) {
    // daemon may not be running
  }
}

function detectIPBackground(env, browserWin) {
  const fingerprint = normalizeFingerprint(env.fingerprint);
  detectIPStandalone(env.proxy || {}).then(result => {
    if (browserWin.isDestroyed()) return;
    applyIPDataToFingerprint(fingerprint, result);
    rememberEnvironmentFingerprint(env.id || browserWin._envId, fingerprint);
    browserWin._fingerprint = fingerprint;
    const proxyLabel = env.proxy && env.proxy.enabled
      ? `${(env.proxy.type || "HTTP").toUpperCase()} ${env.proxy.host}:${env.proxy.port}`
      : "直连";
    const now = new Date();
    const startedAt = `${String(now.getMonth()+1).padStart(2,"0")}月${String(now.getDate()).padStart(2,"0")}日 ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    const serialNum = browserWin._serialNum || "—";
    const guardSessionId = browserWin._guardSessionId || "";
    browserWin.webContents.send("browser-config", {
      config: {
        name: env.name || "",
        homeUrl: env.homeUrl || "",
        proxyLabel: proxyLabel,
        note: env.note || "",
        envId: env.id || "",
        serialNum: serialNum,
        startedAt: browserWin._startedAt || startedAt,
        guardSessionId: guardSessionId,
        proxy: env.proxy || {},
        ipGuard: env.ipGuard || { enabled: false, expectedIP: "" },
        fingerprint: fingerprint,
        desktopAccount: env.desktopAccount || null,
      },
      ipInfo: result,
    });
    browserWin.webContents.send("browser-update-ip", result);
  }).catch(() => {});
}

function pushEnvironmentConfigToBrowser(env, browserWin, ipInfoOverride = null) {
  if (!env || !browserWin || browserWin.isDestroyed()) return;
  const fingerprint = browserWin._fingerprint || normalizeFingerprint(env.fingerprint);
  const proxyLabel = env.proxy && env.proxy.enabled
    ? `${(env.proxy.type || "HTTP").toUpperCase()} ${env.proxy.host}:${env.proxy.port}`
    : "直连";
  const now = new Date();
  const startedAt = browserWin._startedAt || `${String(now.getMonth()+1).padStart(2,"0")}月${String(now.getDate()).padStart(2,"0")}日 ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  browserWin._envConfig = env;
  browserWin.webContents.send("browser-config-updated", {
    config: {
      name: env.name || "",
      homeUrl: env.homeUrl || "",
      proxyLabel: proxyLabel,
      note: env.note || "",
      envId: env.id || browserWin._envId || "",
      serialNum: browserWin._serialNum || env.serialNum || "—",
      startedAt,
      guardSessionId: browserWin._guardSessionId || "",
      proxy: env.proxy || {},
      ipGuard: env.ipGuard || { enabled: false, expectedIP: "" },
      fingerprint,
      desktopAccount: env.desktopAccount || null,
    },
    ipInfo: ipInfoOverride || null,
  });
}

function fetchWithTimeout(url, options, timeout) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout))
  ]);
}

function isProxyDetectOK(result) {
  return !!(result && result.ip && result.ip !== "—" && result.proxyText === "代理/VPN");
}

async function failBrowserStartup(progressWin, stepId, message) {
  updateProgress(progressWin, stepId, message, "error");
  updateProgress(progressWin, "step4", "已停止启动", "error");
  updateProgress(progressWin, "step5", "已停止启动", "error");
  await sleep(2500);
  if (progressWin && !progressWin.isDestroyed()) progressWin.close();
  throw new Error(message.replace(/^[^\s]+\s*/, ""));
}

function updateProgress(win, stepId, text, state) {
  if (!win || win.isDestroyed()) return;
  const colorMap = { done: "#2ecc71", loading: "#f39c12", error: "#e74c3c" };
  const color = colorMap[state] || "#2ecc71";
  const safeStepId = JSON.stringify(stepId);
  const safeText = JSON.stringify(text);
  const safeColor = JSON.stringify(color);
  if (!win.webContents || win.webContents.isDestroyed()) return;
  win.webContents.executeJavaScript(`
    (function(){
      var el = document.getElementById(${safeStepId});
      if (el) { el.textContent = ${safeText}; el.style.color = ${safeColor}; }
    })()
  `).catch(() => {});
}

function buildProgressHTML(env) {
  const proxy = env.proxy;
  const proxyText = proxy && proxy.enabled
    ? `${(proxy.type || "HTTP").toUpperCase()} ${proxy.host}:${proxy.port}`
    : "直连";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;padding:24px}
h2{font-size:17px;font-weight:600;margin-bottom:4px}
.sub{font-size:13px;color:#86868b;margin-bottom:18px}
.step{display:flex;align-items:center;padding:10px 0;font-size:13px;color:#86868b;border-bottom:1px solid #e5e5ea}
.step:last-child{border-bottom:none}
</style></head><body>
<h2>正在准备「${env.name || "Browser"}」</h2>
<p class="sub">网络: ${proxyText}</p>
<div class="step" id="step1">⏳ 正在加载配置文件...</div>
<div class="step" id="step2">⏳ 正在配置代理与网络...</div>
<div class="step" id="step3">⏳ 正在检测网络出口...</div>
<div class="step" id="step4">⏳ 正在初始化浏览器引擎...</div>
<div class="step" id="step5">⏳ 正在构建窗口界面...</div>
</body></html>`;
}

function buildIPInfoPage(env, ipResult) {
  const ip = ipResult ? (ipResult.ip || "—") : "—";
  const country = ipResult ? (ipResult.country || "—") : "—";
  const region = ipResult ? (ipResult.region || "—") : "—";
  const city = ipResult ? (ipResult.city || "—") : "—";
  const isp = ipResult ? (ipResult.isp || "—") : "—";
  const lat = ipResult ? (ipResult.lat || "—") : "—";
  const lon = ipResult ? (ipResult.lon || "—") : "—";
  const tz = ipResult ? (ipResult.timezone || "—") : "—";
  const proxyText = ipResult ? (ipResult.proxyText || "未知") : "检测中";
  const statusText = ipResult ? (ipResult.statusText || "—") : "正在检测出口IP…";
  const source = ipResult ? (ipResult.source || "—") : "检测中…";
  const checkedAt = ipResult ? (ipResult.checkedAt || "") : new Date().toISOString().replace("T", " ").substring(0, 19);
  const proxy = env.proxy;
  const proxyLabel = proxy && proxy.enabled
    ? `${(proxy.type || "HTTP").toUpperCase()} ${proxy.host}:${proxy.port}`
    : "直连";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#4a5568;min-height:100vh;padding-top:56px}
.wrap{width:720px;margin:0 auto;background:white;box-shadow:0 2px 16px rgba(0,0,0,.18)}
.topline{height:4px;background:#4b7cf5}
.ad{height:42px;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;color:#2f66f6;background:#fff}
.blue{background:#4a77f0;color:white;text-align:center;padding:10px 24px 18px}
.ip{font-size:38px;line-height:1.15;font-weight:300;letter-spacing:.5px;margin-bottom:6px}
.btns{display:flex;gap:16px;justify-content:center;margin:4px 0 16px}
.mini{background:#36c9d6;border-radius:4px;padding:7px 16px;color:white;font-size:13px;font-weight:600}
.pill{display:inline-block;border:1px dashed rgba(255,255,255,.55);border-radius:6px;padding:8px 18px;margin:0 0 9px;color:#eaffff;font-size:13px;font-weight:700}
.meta{display:inline-flex;gap:20px;border:1px dashed rgba(255,255,255,.55);border-radius:5px;padding:9px 16px;font-size:13px;font-weight:700}
.checks{margin-top:9px}
.checks span{display:inline-block;border:1px dashed rgba(255,255,255,.55);border-radius:5px;padding:8px 16px;font-size:13px;font-weight:700}
.checks a{color:white;text-decoration:underline;margin-left:6px}
.table{padding:4px 10px 0;background:#fff}
.row{display:grid;grid-template-columns:100px 1fr;border-bottom:1px solid #e5e7eb;min-height:43px;align-items:center;font-size:14px}
.label{color:#9aa0aa;text-align:right;padding-right:18px}
.value{color:#596174;font-weight:500}
.muted{color:#a0a6b0}
.footer{height:34px;display:flex;align-items:center;justify-content:center;color:#a0a6b0;font-size:12px;background:#fff}
</style></head><body>
<div class="wrap">
  <div class="topline"></div>
  <div class="ad">实时出口 IP 检测 · ${source} · ${checkedAt}</div>
  <div class="blue">
    <div class="ip">${ip}</div>
    <div class="btns"><span class="mini">刷新网络信息</span><span class="mini">${statusText}</span></div>
    <div class="pill">（仅供参考）${country} / ${region} / ${city}</div>
    <div><div class="meta"><span>时区: ${tz}</span><span>经度/纬度: ${lon}/${lat}</span><span>语言: zh-CN</span></div></div>
    <div class="checks"><span>指纹检测: <a>ToDetect</a> <a>BrowserLeaks</a></span></div>
  </div>
  <div class="table">
    <div class="row"><div class="label">名称:</div><div class="value">${env.name || "—"}</div></div>
    <div class="row"><div class="label">代理:</div><div class="value">${proxyLabel}</div></div>
    <div class="row"><div class="label">主页:</div><div class="value">${env.homeUrl || "—"}</div></div>
    <div class="row"><div class="label">内核版本:</div><div class="value">Chromium Electron</div></div>
    <div class="row"><div class="label">运营商:</div><div class="value">${isp}</div></div>
    <div class="row"><div class="label">检测来源:</div><div class="value">${source}</div></div>
    <div class="row"><div class="label">备注:</div><div class="value">${env.note || "无备注"}</div></div>
  </div>
  <div class="footer">工作台已就绪。在地址栏输入网址开始浏览。</div>
</div>
</body></html>`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== IPC Handlers ==========
ipcMain.handle("open-browser", async (event, envId) => {
  if (openingBrowserIds.has(envId)) {
    return { error: "浏览器正在启动中，请稍候" };
  }
  openingBrowserIds.add(envId);
  try {
    console.log("[main] open-browser ipc", { envId, isBrowserHelper: IS_BROWSER_HELPER, isPackaged: app.isPackaged });
    if (!IS_BROWSER_HELPER) {
      return openBrowserHelperProcess(envId, event.sender);
    }
    return await openBrowserEnvironment(envId);
  } catch (e) {
    console.error("open browser failed:", { envId, error: e && e.stack ? e.stack : e.message });
    stopLocalProxyTunnel(envId);
    return { error: e.message };
  } finally {
    openingBrowserIds.delete(envId);
  }
});

ipcMain.handle("browser-running-list", async () => {
  return Array.from(new Set([
    ...browserHelperProcesses.keys(),
    ...Array.from(browserWindows.entries())
      .filter(([, win]) => win && !win.isDestroyed())
      .map(([envId]) => envId),
  ])).map(envId => runningBrowserDetail(envId));
});

ipcMain.handle("close-browser", async (event, envId) => {
  const helper = browserHelperProcesses.get(envId);
  if (helper && helper.exitCode === null && !helper.killed) {
    const exited = new Promise(resolve => helper.once("exit", resolve));
    helper.kill();
    stopLocalProxyTunnel(envId);
    await exited;
    const uploadTask = snapshotUploadTasks.get(String(envId));
    if (uploadTask) {
      const result = await uploadTask;
      if (!result.ok) return { running: false, error: `浏览器已关闭，但云端同步失败: ${result.error.message}` };
    }
    return { running: false };
  }
  const win = browserWindows.get(envId);
  if (win && !win.isDestroyed()) {
    win.close();
    return { running: false };
  }
  return { running: false, error: "not found" };
});

ipcMain.on("app-window-control", (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === "close") win.close();
  if (action === "minimize") win.minimize();
  if (action === "toggle-maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

function runCurl(args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = execFile("curl", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(String(stdout || "").trim());
    });
    child.on("error", () => resolve(null));
  });
}

function parseDetectorResult(source, text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    const ip = json.query || json.ip || json.origin;
    if (!ip) return null;
    return {
      ip: String(ip).split(",")[0].trim(),
      country: json.country || "—",
      region: json.regionName || json.region || "—",
      city: json.city || "—",
      isp: json.isp || json.org || "—",
      lat: json.lat ?? "—",
      lon: json.lon ?? "—",
      timezone: json.timezone || "—",
      zip: json.zip || json.postal || "—",
      source,
      checkedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
  } catch {
    const ip = raw.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
    if (!ip) return null;
    return {
      ip,
      country: "—",
      region: "—",
      city: "—",
      isp: "—",
      lat: "—",
      lon: "—",
      timezone: "—",
      zip: "—",
      source,
      checkedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
  }
}

async function detectIPStandalone(proxyConfig = {}, envId = "") {
  const proxy = proxyConfig || {};
  const useProxy = !!(proxy.enabled && proxy.host && proxy.port);
  const detectors = [
    ["ip-api.com", "http://ip-api.com/json/?fields=status,message,country,regionName,city,isp,lat,lon,timezone,proxy,query"],
    // Authenticated SOCKS is exposed to Electron through a local HTTP CONNECT
    // tunnel. Use HTTPS fallbacks so every detector follows the same CONNECT
    // path as Apple; plain HTTP absolute-form requests are not supported by
    // that tunnel and previously made a healthy proxy look expired.
    ["httpbin.org", "https://httpbin.org/ip"],
    ["icanhazip.com", "https://icanhazip.com"],
    ["checkip.amazonaws.com", "https://checkip.amazonaws.com"],
  ];
  const baseArgs = ["-s", "--max-time", useProxy ? "5" : "3", "--connect-timeout", useProxy ? "3" : "2"];
  const proxyArgs = [];
  if (useProxy) {
    const localTunnel = envId ? localProxyTunnels.get(envId) : null;
    const type = String(proxy.type || "http").toLowerCase() === "socks5" ? "socks5" : "http";
    if (localTunnel && localTunnel.port) {
      proxyArgs.push("--proxy", `http://127.0.0.1:${localTunnel.port}`);
    } else {
      let auth = "";
      if (proxy.username) {
        auth = String(proxy.username);
        if (proxy.password) auth += ":" + String(proxy.password);
        auth += "@";
      }
      if (type === "socks5") proxyArgs.push("--socks5-hostname", `${auth}${proxy.host}:${proxy.port}`);
      else proxyArgs.push("--proxy", `${type}://${auth}${proxy.host}:${proxy.port}`);
    }
  }

  const checks = detectors.map(async ([source, url]) => {
    const output = await runCurl([...baseArgs, ...proxyArgs, url]);
    const result = parseDetectorResult(source, output);
    if (result) {
      return {
        ...result,
        proxyText: useProxy ? "代理/VPN" : "真实 IP",
        statusText: useProxy ? "代理出口IP检测成功" : "本机IP检测成功",
      };
    }
    return null;
  });
  const results = await Promise.all(checks);
  const result = results.find(Boolean);
  if (result) return result;

  const tunnelReason = envId ? localProxyErrors.get(envId) : "";
  return {
    ip: "—",
    country: "—",
    region: "—",
    city: "—",
    isp: "—",
    lat: "—",
    lon: "—",
    timezone: "—",
    proxyText: useProxy ? "代理检测失败" : "未知",
    source: "全部检测源",
    statusText: useProxy ? (tunnelReason || "代理不可达或检测源不可用") : "网络不可用",
    checkedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
  };
}

ipcMain.handle("detect-ip", async (event, proxyConfig) => {
  return detectIPStandalone(proxyConfig || { enabled: false });
});

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipDateParts(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = zipDateParts();
  files.forEach(file => {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + data.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function createZipFromDirectory(directory) {
  const rootName = path.basename(directory);
  const files = [];
  const visit = (current, relative = "") => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath, entryRelative);
      else if (entry.isFile()) files.push({ name: `${rootName}/${entryRelative}`, content: fs.readFileSync(entryPath) });
    }
  };
  visit(directory);
  return createZip(files);
}

function readZipFiles(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const rawName = buffer.slice(nameStart, nameStart + fileNameLength).toString();
    const dataStart = nameStart + fileNameLength + extraLength;
    if (flags & 0x08) break;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (rawName && !rawName.endsWith("/")) {
      let content;
      if (method === 0) content = data;
      else if (method === 8) content = zlib.inflateRawSync(data);
      else throw new Error("服务器证书包使用了不支持的 ZIP 压缩格式");
      files.push({ name: rawName.replace(/\\/g, "/"), content });
    }
    offset = dataStart + compressedSize;
  }
  return files;
}

function safeArchiveSegment(value, fallback = "file") {
  return String(value || fallback).replace(/[\\/:*?"<>|\r\n]/g, "_").trim() || fallback;
}

function safeBundleFolderName(value, fallback = "bundle") {
  return String(value || "").replace(/[^A-Za-z0-9]+/g, "") || fallback;
}

function developerArtifactFolder(name) {
  const text = String(name || "").toLowerCase();
  if (/(development|develop|dev|测试|开发)/i.test(text)) return "测试";
  if (/(production|distribution|release|app.?store|ad.?hoc|发布|正式|上架)/i.test(text)) return "正式";
  return "正式";
}

function repackageDeveloperCertificateZip(data, { appleId, bundleId, p12Password }) {
  const sourceFiles = readZipFiles(data);
  if (!sourceFiles.length) return data;
  if (sourceFiles.some(file => /(^|\/)(开发|发布)\//.test(file.name))) return data;
  const root = `${safeArchiveSegment(appleId || "AppleID")}的证书`;
  const packageName = safeBundleFolderName(bundleId || "unknownbundle");
  const infoRows = [
    `Apple ID: ${appleId || ""}`,
    `包名: ${bundleId || ""}`,
    `P12 密码: ${p12Password || DEFAULT_P12_PASSWORD}`,
    `导出时间: ${new Date().toISOString()}`,
  ];
  const output = [];
  const txtFiles = [];
  const folders = new Set();
  const usedNames = new Set();
  const nextName = name => {
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    let index = 2;
    while (usedNames.has(`${base}-${index}${ext}`)) index += 1;
    const value = `${base}-${index}${ext}`;
    usedNames.add(value);
    return value;
  };
  for (const file of sourceFiles) {
    const base = safeArchiveSegment(path.basename(file.name), "file");
    const ext = path.extname(base).toLowerCase();
    if (![".p12", ".mobileprovision", ".txt"].includes(ext)) continue;
    const folder = developerArtifactFolder(file.name);
    folders.add(folder);
    const target = ext === ".p12" ? `${root}/${folder}/${base}` : `${root}/${folder}/${packageName}/${base}`;
    const row = { name: nextName(target), content: file.content };
    if (ext === ".txt") txtFiles.push(row);
    else output.push(row);
  }
  output.push(...txtFiles);
  for (const folder of (folders.size ? folders : new Set(["正式"]))) {
    output.push({ name: nextName(`${root}/${folder}/${packageName}/证书信息.txt`), content: `${infoRows.join("\n")}\n` });
  }
  return output.length ? createZip(output) : data;
}

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function buildProxyWorkbook(rows) {
  const headers = ["代理类型", "代理主机", "代理端口", "代理账号", "代理密码", "IP查询渠道", "刷新URL", "备注信息", "出口IP", "绑定窗口"];
  const data = [headers, ...rows.map(row => [
    row.type, row.host, row.port, row.username, row.password, row.channel, row.refreshUrl, row.note, row.outIp, row.bindWindows,
  ])];
  const sheetRows = data.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : "";
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:J${data.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 7 ? 24 : 16}" customWidth="1"/>`).join("")}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;
  return createZip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="代理IP" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/worksheets/sheet1.xml", content: worksheet },
  ]);
}

function formatWorkbookPrice(value, currency) {
  if (value === "" || value === null || value === undefined) return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value || "");
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || ""} ${amount.toFixed(2)}`.trim();
  }
}

function buildInAppPurchasePriceWorkbook(rows, meta = {}) {
  const headers = ["国家或地区", "价格", "收入"];
  const data = [headers, ...rows.map(row => [
    `${row.name || row.territoryId || "—"}${row.currency ? ` (${row.currency})` : ""}`,
    formatWorkbookPrice(row.price, row.currency),
    formatWorkbookPrice(row.proceeds, row.currency),
  ])];
  const sheetRows = data.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : "";
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C${data.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="3" width="18" customWidth="1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;
  const title = String(meta.sheetName || "价格表").replace(/[\[\]:*?/\\]/g, "").slice(0, 31) || "价格表";
  return createZip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(title)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", content: styles },
    { name: "xl/worksheets/sheet1.xml", content: worksheet },
  ]);
}

function proxyPoolFilePath() {
  return path.join(certificateManagerDataDir(), "proxy-pool.json");
}

function normalizeProxyRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    id: String(row.id || `proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: String(row.type || "socks5").toLowerCase() === "http" ? "http" : "socks5",
    host: String(row.host || "").trim(),
    port: String(row.port || "").trim(),
    username: String(row.username || "").trim(),
    password: String(row.password || ""),
    refreshUrl: String(row.refreshUrl || "").trim(),
    note: String(row.note || "").trim(),
    outIp: String(row.outIp || "").trim(),
    detectStatus: ["ok", "fail", "checking"].includes(row.detectStatus) ? row.detectStatus : "",
	  })).filter(row => row.host && row.port);
}

function proxyKey(proxy) {
  return `${String(proxy?.type || "http").toLowerCase()}://${String(proxy?.host || "").trim()}:${String(proxy?.port || "").trim()}`;
}

function projectRootDir() {
  return path.resolve(__dirname, "..");
}

function uploaderScriptPath() {
  return path.join(projectRootDir(), "uploader.py");
}

function uploaderExecutableCandidates() {
  const roots = [
    projectRootDir(),
    app.getAppPath(),
    process.resourcesPath || "",
    path.join(process.resourcesPath || "", "app.asar.unpacked"),
    path.dirname(process.execPath || ""),
  ].filter(Boolean);
  const executableName = process.platform === "win32" ? "ipauploader-upload.exe" : "ipauploader-upload";
  const platformNames = [
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`,
    process.platform === "darwin" ? `macos-${process.arch}` : process.platform,
  ];
  const candidates = [];
  for (const root of roots) {
    for (const platformName of platformNames) {
      candidates.push(path.join(root, "uploader-bin", platformName, executableName));
      candidates.push(path.join(root, "vendor", "uploader", platformName, executableName));
    }
    candidates.push(path.join(root, executableName));
  }
  return Array.from(new Set(candidates));
}

function bundledUploaderExecutablePath() {
  return uploaderExecutableCandidates().find(candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      return process.platform === "win32"
        ? path.extname(candidate).toLowerCase() === ".exe"
        : (fs.statSync(candidate).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }) || "";
}

function uploaderCommand() {
  const bundled = bundledUploaderExecutablePath();
  if (bundled) return { command: bundled, args: [], bundled: true };
  if (process.platform === "win32") {
    const roots = [process.resourcesPath || "", app.getAppPath(), path.dirname(process.execPath || "")].filter(Boolean);
    for (const root of roots) {
      const portableRoot = path.join(root, "uploader-bin", "windows-x64");
      const python = path.join(portableRoot, "python", "python.exe");
      const script = path.join(portableRoot, "python", "uploader.py");
      if (fs.existsSync(python) && fs.existsSync(script)) {
        return { command: python, args: [script], bundled: true };
      }
    }
  }
  if (app.isPackaged) return { error: "软件内置 IPA 上传执行程序缺失，请重新安装完整版本。" };
  const script = uploaderScriptPath();
  if (!fs.existsSync(script)) return { error: "开发环境上传脚本不存在。" };
  return {
    command: process.env.IPAUPLOADER_PYTHON || process.env.PYTHON || process.env.PYTHON3 || "python3",
    args: [script],
    bundled: false,
  };
}

function transporterCandidatePaths() {
  const roots = [
    projectRootDir(),
    app.getAppPath(),
    process.resourcesPath || "",
    path.join(process.resourcesPath || "", "app.asar.unpacked"),
    path.dirname(process.execPath || ""),
  ].filter(Boolean);
  const names = [
    path.join("bin", "iTMSTransporter"),
    path.join("bin", "iTMSTransporter.sh"),
    path.join("bin", "iTMSTransporter.cmd"),
    path.join("bin", "iTMSTransporter.bat"),
    path.join("bin", "iTMSTransporter.exe"),
    "iTMSTransporter",
    "iTMSTransporter.sh",
    "iTMSTransporter.cmd",
    "iTMSTransporter.bat",
    "iTMSTransporter.exe",
  ];
  const candidates = [];
  for (const root of roots) {
    for (const base of [
      path.join(root, "vendor", "itms", process.platform),
      path.join(root, "vendor", "itms", process.platform === "win32" ? "windows" : "macos"),
      path.join(root, "vendor", "itms"),
      path.join(root, "itms", process.platform),
      path.join(root, "itms"),
    ]) {
      for (const name of names) candidates.push(path.join(base, name));
    }
  }
  return Array.from(new Set(candidates));
}

function transporterStatus() {
  const found = transporterCandidatePaths().find(candidate => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      const extension = path.extname(candidate).toLowerCase();
      return process.platform === "win32"
        ? [".cmd", ".bat", ".exe"].includes(extension)
        : ![".cmd", ".bat", ".exe"].includes(extension) && (fs.statSync(candidate).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  return {
    available: !!found,
    path: found || "",
    source: found ? "软件内置安全上传组件" : "",
    requiresAssetDescription: process.platform === "win32",
  };
}

function createUploadTask(filename) {
  const id = "upload-" + Date.now().toString(36) + "-" + Math.random().toString(16).slice(2, 8);
  uploadTasks.set(id, {
    id,
    filename,
    status: "running",
    events: [],
    error: "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    process: null,
  });
  return id;
}

function addUploadEvent(taskId, level, message) {
  const task = uploadTasks.get(taskId);
  if (!task) return;
  task.events.push({
    level: level || "info",
    message: String(message || ""),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  });
  task.updatedAt = new Date().toISOString();
}

function finishUploadTask(taskId, status, error = "") {
  const task = uploadTasks.get(taskId);
  if (!task) return;
  task.status = status;
  task.error = error;
  task.updatedAt = new Date().toISOString();
  task.process = null;
}

function publicUploadTask(taskId) {
  const task = uploadTasks.get(taskId);
  if (!task) return null;
  const appleState = task.appleState || null;
  const terminal = ["valid", "failed"].includes(appleState?.phase);
  const presentation = uploadPresentation(task);
  const status = ["running", "error", "validated"].includes(task.status) ? task.status
    : appleState?.phase === "valid" ? "success" : appleState?.phase === "failed" ? "processing_error"
    : appleState?.phase === "processing" ? "processing" : "submitted";
  return {
    id: task.id,
    filename: task.filename,
    status,
    statusText: presentation.text,
    statusLevel: presentation.level,
    stage: task.stage || "",
    validatedOnly: task.validatedOnly === true,
    providerChoices: task.providerChoices || [],
    metadata: task.metadata || null,
    appleState,
    deliveryConfirmed: task.deliveryConfirmed === true,
    duplicateDelivery: task.duplicateDelivery === true,
    receiptBuildId: task.receiptBuildId || "",
    monitorActive: task.status === "submitted" && !terminal && !task.monitorPaused && Date.now() < task.monitorUntil,
    testflightUrl: appleState?.app?.id ? `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appleState.app.id)}/testflight` : "",
    events: task.events.slice(),
    error: task.error || (appleState?.phase === "failed" ? appleState.errors?.join("\n") || `Apple 返回构建处理失败 (${appleState.processingState || "FAILED"})，未提供具体错误。请查看苹果处理邮件或 TestFlight 的构建版本上传详情` : ""),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
  };
}

async function refreshUploadAppleState(taskId, { force = false } = {}) {
  const task = uploadTasks.get(taskId);
  if (!task || task.status !== "submitted" || !task.metadata) return;
  if (task.appleQueryPromise) return task.appleQueryPromise;
  if (!force && ["valid", "failed"].includes(task.appleState?.phase)) return;
  if (!force && Date.now() >= task.monitorUntil) {
    if (!task.monitorPaused) addUploadEvent(taskId, "warning", "自动查询已暂停，苹果处理可能仍在继续。可点击“查询苹果处理结果”继续核对；这不代表上传或处理失败。");
    task.monitorPaused = true;
    return;
  }
  if (!force && Date.now() < (task.nextAppleCheckAt || 0)) return;
  if (force) task.monitorUntil = Date.now() + 30 * 60 * 1000;
  task.monitorPaused = false;
  const generation = appleDeveloperContextGeneration;
  const accountKey = appleDeveloperAccountKey;
  const testFlightContextToken = `${generation}:${readSelectedAppleDeveloperTeam()?.id || ""}`;
  let timer;
  const promise = (async () => {
    let state;
    try {
      if (!appleDeveloperLaunchAppleId || task.appleId.toLowerCase() !== appleDeveloperLaunchAppleId.trim().toLowerCase()) {
        throw new Error("查询账号与上传 Apple ID 不一致。请登录上传时使用的 Apple ID 后再查询苹果处理结果");
      }
      const ses = session.fromPartition(appleDeveloperPartitionForAccount(accountKey));
      const signal = AbortSignal.timeout(18000);
      const fetch = (requestPath) => {
        if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账号已切换，请在原上传账号下重新查询");
        return appStoreConnectFetch(requestPath, { session: ses, signal, skipSessionRefresh: true }).catch(error => {
          if (Number(error.status) === 401) error.message = `App Store Connect 登录已过期，请重新登录当前 Apple ID 后再查询 (${error.status})`;
          throw error;
        });
      };
      state = await Promise.race([
        queryAppleBuildState({ metadata: task.metadata, startedAt: task.lookupOnly ? "" : task.startedAt, expectedBuildId: task.receiptBuildId, app: task.appleContextToken === testFlightContextToken ? task.appleState?.app : undefined }, fetch),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("苹果处理状态查询超时，请稍后重试；暂时无法确认处理结果")), 20000); }),
      ]);
      if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账号已切换，请在原上传账号下重新查询");
    } catch (error) {
      state = { phase: "query_error", reason: error.message || "苹果处理结果暂时无法查询", checkedAt: new Date().toISOString() };
    } finally { clearTimeout(timer); }
    task.appleState = state;
    task.appleContextToken = state.app && testFlightContextToken === `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}` ? testFlightContextToken : "";
    task.nextAppleCheckAt = Date.now() + (state.phase === "query_error" ? 30000 : 15000);
    const notice = JSON.stringify([state.phase, state.processingState, state.internalBuildState, state.externalBuildState, state.errors, state.reason, state.queryWarnings]);
    if (notice !== task.appleNotice) {
      task.appleNotice = notice;
      const presentation = uploadPresentation(task);
      const label = presentation.text;
      const target = state.app ? `；对应 App：${state.app.name || state.app.id} (${task.metadata.bundleId})，版本 ${task.metadata.version}，Build ${task.metadata.build}` : "";
      const detail = state.errors?.join("\n") || state.reason || "";
      addUploadEvent(taskId, presentation.level, `${label}${target}${detail ? `。${detail}` : ""}`);
      (state.warnings || []).forEach(warning => addUploadEvent(taskId, "warning", `苹果处理警告：${warning}`));
      if (state.externalBuildState) addUploadEvent(taskId, "info", `苹果返回的外部测试状态：${state.externalBuildState}。内部可测试不代表外部测试审核已通过。`);
      if (state.phase !== "valid") (state.queryWarnings || []).forEach(warning => addUploadEvent(taskId, "warning", warning));
    }
    task.updatedAt = new Date().toISOString();
  })().finally(() => { if (task.appleQueryPromise === promise) task.appleQueryPromise = null; });
  task.appleQueryPromise = promise;
  return promise;
}

function bundledTransporterJavaHome(transporterPath = "") {
  if (!transporterPath) return "";
  const transporterBin = path.dirname(transporterPath);
  const javaHome = path.resolve(transporterBin, "..", "java");
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  return fs.existsSync(path.join(javaHome, "bin", javaName)) ? javaHome : "";
}

function transporterJavaMajorVersion(javaHome) {
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  const javaPath = path.join(String(javaHome || ""), "bin", javaName);
  if (!fs.existsSync(javaPath)) return 0;
  try {
    const result = spawnSync(javaPath, ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const match = output.match(/version\s+"([0-9]+)(?:\.([0-9]+))?/i);
    if (!match) return 0;
    const first = Number(match[1]);
    return first === 1 ? Number(match[2] || 0) : first;
  } catch {
    return 0;
  }
}

function isTransporterJavaHome(javaHome) {
  return transporterJavaMajorVersion(javaHome) >= 19;
}

function transporterJavaHome(transporterPath = "") {
  const bundled = bundledTransporterJavaHome(transporterPath);
  if (bundled && isTransporterJavaHome(bundled)) return bundled;
  return "";
}

function transporterAccountEnvironment(appleId, transporterPath = "") {
  const accountKey = crypto
    .createHash("sha256")
    .update(String(appleId || "").trim().toLowerCase(), "utf8")
    .digest("hex");
  const accountHome = path.join(app.getPath("userData"), "transporter-accounts", accountKey);
  const tempDir = path.join(accountHome, "tmp");
  const cacheDir = path.join(accountHome, "cache");
  const appDataDir = path.join(accountHome, "AppData", "Roaming");
  const localAppDataDir = path.join(accountHome, "AppData", "Local");
  for (const dir of [accountHome, tempDir, cacheDir, appDataDir, localAppDataDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Transporter is Java-based. HOME isolates shell-side state, while
  // java.user.home prevents its Java modules from falling back to the real
  // macOS/Windows user directory.
  const escapedHome = accountHome.replace(/([\\"])/g, "\\$1");
  const javaHomeOption = `-Duser.home="${escapedHome}"`;
  const existingJavaOptions = String(process.env.JAVA_TOOL_OPTIONS || "").trim();
  const realHome = String(process.env.IPAUPLOADER_REAL_HOME || process.env.HOME || app.getPath("home") || "").trim();
  const javaHome = transporterJavaHome(transporterPath);
  if (!javaHome) throw new Error("软件内置的 Java 上传环境缺失或版本不兼容，请重新安装完整的软件");
  return {
    IPAUPLOADER_TRANSPORTER_HOME: accountHome,
    IPAUPLOADER_REAL_HOME: realHome,
    HOME: accountHome,
    USERPROFILE: accountHome,
    XDG_CACHE_HOME: cacheDir,
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    JAVA_TOOL_OPTIONS: [existingJavaOptions, javaHomeOption].filter(Boolean).join(" "),
    ...(javaHome ? { JAVA_HOME: javaHome, ITMS_TRANSPORTER_JAVA_HOME: javaHome } : {}),
  };
}

ipcMain.handle("load-proxies", async () => {
  try {
    const raw = fs.readFileSync(proxyPoolFilePath(), "utf8");
    return { proxies: normalizeProxyRows(JSON.parse(raw)) };
  } catch (e) {
    return { proxies: [] };
  }
});

ipcMain.handle("save-proxies", async (_event, rows) => {
  try {
    fs.mkdirSync(sharedUserDataDir(), { recursive: true });
    const proxies = normalizeProxyRows(rows);
    fs.writeFileSync(proxyPoolFilePath(), JSON.stringify(proxies, null, 2));
    return { ok: true, count: proxies.length };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("upload-select-ipa", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择 IPA 包",
    properties: ["openFile"],
    filters: [{ name: "IPA 包", extensions: ["ipa"] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  try {
    return { canceled: false, path: filePath, filename: path.basename(filePath), metadata: await inspectIPA(filePath) };
  } catch (error) {
    return { canceled: false, path: filePath, filename: path.basename(filePath), metadataError: error.message };
  }
});

ipcMain.handle("upload-transporter-status", async () => transporterStatus());

ipcMain.handle("upload-select-description", async () => {
  const result = await dialog.showOpenDialog({ title: "选择与 IPA 同次导出的 AppStoreInfo.plist", properties: ["openFile"], filters: [{ name: "Apple 上传描述文件", extensions: ["plist"] }] });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  return { path: result.filePaths[0], filename: path.basename(result.filePaths[0]) };
});

ipcMain.handle("upload-start", async (_event, payload = {}) => {
  const ipaPath = String(payload.ipaPath || "");
  const appleId = String(payload.appleId || "").trim();
  const password = String(payload.password || "");
  const ascProvider = String(payload.ascProvider || "").trim();
  const proxy = payload.useAppleDeveloperProxy ? readAppleDeveloperUploadProxy() : (payload.proxy || { enabled: false });
  if (!ipaPath || !fs.existsSync(ipaPath)) return { error: "请选择有效的 IPA 文件。" };
  if (!appleId) return { error: "请填写 Apple ID。" };
  if (!password && !payload.validateOnly) return { error: "请填写 App 专用密码。" };
  const uploadAccount = appleId.toLowerCase();
  if (uploadStartReservations.has(uploadAccount) || [...uploadTasks.values()].some(task => task.appleId?.toLowerCase() === uploadAccount && task.status === "running")) return { error: "当前 Apple ID 已有校验或上传任务正在执行，请等待完成" };
  uploadStartReservations.add(uploadAccount);
  try {
    let metadata;
    try { metadata = await inspectIPA(ipaPath); }
    catch (error) { return { error: error.message || "IPA 信息读取失败" }; }
    const transporter = transporterStatus();
    if (!transporter.available && !payload.validateOnly) {
      return { error: `上传环境不可用：请确认软件内置上传组件的 ${process.platform === "win32" ? "Windows" : "macOS"} 文件完整。` };
    }
    if (proxy && proxy.enabled && !payload.validateOnly) {
      if (!proxy.host || !proxy.port) return { error: "已选择代理，但代理地址或端口不完整。" };
      const detected = await detectIPStandalone(proxy);
      if (!detected || !detected.ip || detected.ip === "—") {
        return { error: `所选代理不可用，无法开始上传：${detected?.statusText || "代理连接失败"}` };
      }
    }

    const taskId = createUploadTask(path.basename(ipaPath));
    Object.assign(uploadTasks.get(taskId), { metadata, appleId, deliveryConfirmed: false, stage: "inspection" });
    const passwordEnv = `IPAUPLOAD_PASSWORD_${Math.random().toString(16).slice(2).toUpperCase()}`;
    const workerConfig = { ipaPath, metadata, appleId, passwordEnv, ascProvider, proxy, transporterPath: transporter.path, assetDescriptionPath: String(payload.assetDescriptionPath || ""), validateOnly: payload.validateOnly === true };

    addUploadEvent(taskId, "info", "上传任务已创建。");
    addUploadEvent(taskId, "info", `本次 IPA：${metadata.bundleId}，版本 ${metadata.version}，Build ${metadata.build}。${workerConfig.validateOnly ? "本次只读取 IPA 信息，不提交文件。" : "上传后将核对这个 App 和构建的苹果处理结果。"}`);
    addUploadEvent(taskId, "info", workerConfig.validateOnly ? "已使用软件自带的运行环境读取 IPA 信息。" : "已使用软件自带的运行环境、苹果上传组件和 Java。");
    let accountEnvironment;
    try {
      accountEnvironment = workerConfig.validateOnly ? {} : transporterAccountEnvironment(appleId, transporter.path);
    } catch (error) {
      finishUploadTask(taskId, "error", `创建账号隔离目录失败：${error.message}`);
      return { error: `创建账号隔离目录失败：${error.message}` };
    }
    if (!workerConfig.validateOnly) addUploadEvent(taskId, "info", "已启用当前 Apple ID 的独立上传环境、缓存和临时目录。");
    const childEnv = { ...process.env, ...accountEnvironment, [passwordEnv]: password, ELECTRON_RUN_AS_NODE: "1" };
    if (transporter.path) childEnv.ITMS_TRANSPORTER_PATH = transporter.path;
    let child;
    try { child = spawn(process.execPath, [path.join(__dirname, "ipa-upload-worker.js")], {
      cwd: projectRootDir(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }); } catch (error) {
      finishUploadTask(taskId, "error", error.message);
      return { error: error.message };
    }
    const task = uploadTasks.get(taskId);
    if (task) task.process = child;

    let stdoutBuffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let uploadFinish = null;
    let uploadFailure = "";
    const rememberFailure = message => {
      const value = String(message || "").trim();
      if (!uploadFailure && /UPLOAD FAILED|failed to upload package|failed to upload archive|ExitFailure|this bundle is invalid|ERROR ITMS-|\bERROR:/i.test(value)) {
        uploadFailure = value;
      }
    };
    const handleOutput = (chunk) => {
      stdoutBuffer += Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk || "");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(line => {
        const clean = line.trim();
        if (!clean) return;
        try {
          const msg = JSON.parse(clean);
          if (msg.type === "event") {
            const deliveryMessage = /^上传成功，等待 App Store Connect\/TestFlight 处理构建/.test(msg.message || "");
            addUploadEvent(taskId, deliveryMessage ? "info" : msg.level, deliveryMessage ? "苹果上传工具已确认文件提交，尚需核对构建处理结果。" : msg.message);
            rememberFailure(msg.message);
          }
          if (msg.type === "finish") uploadFinish = msg;
          if (msg.type === "stage" && ["inspection", "provider", "upload"].includes(msg.stage)) currentUploadStage(msg.stage);
        } catch {
          addUploadEvent(taskId, "info", clean);
          rememberFailure(clean);
        }
      });
    };

    function currentUploadStage(stage) {
      const current = uploadTasks.get(taskId);
      if (current?.status === "running") current.stage = stage;
    }

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", data => {
      addUploadEvent(taskId, "error", String(data).trim());
      rememberFailure(data);
    });
    child.on("error", error => {
      addUploadEvent(taskId, "error", error.message);
      finishUploadTask(taskId, "error", error.message);
    });
    child.on("close", code => {
      handleOutput(stdoutDecoder.end());
      if (stdoutBuffer.trim()) handleOutput("\n");
      const current = uploadTasks.get(taskId);
      if (!current || current.status !== "running") return;
      if (code === 0 && uploadFinish?.ok === true && uploadFinish.validatedOnly === true && workerConfig.validateOnly && !uploadFailure) {
        current.validatedOnly = true;
        finishUploadTask(taskId, "validated");
        addUploadEvent(taskId, "info", "IPA 信息已读取。本次未提交苹果校验或上传。");
        return;
      }
      const error = code !== 0
        ? (uploadFinish?.error || uploadFailure || `上传进程退出，代码 ${code}`)
        : (uploadFinish?.error || uploadFailure || (uploadFinish?.ok === true && uploadFinish.deliveryConfirmed === true && uploadFinish.versionBound === true && uploadFinish.receiptBuildId && hasAppleDeliveryConfirmation(current.events) ? "" : "上传程序未返回与本次版本绑定的 Apple 构建回执，无法确认上传结果。"));
      current.uncertainOutcome = uploadFinish?.uncertain === true;
      current.providerChoices = uploadFinish?.providerChoices || [];
      finishUploadTask(taskId, error ? "error" : "submitted", error);
      if (error) addUploadEvent(taskId, "error", error);
      else {
        current.deliveryConfirmed = true;
        current.duplicateDelivery = uploadFinish?.duplicateDelivery === true;
        current.receiptBuildId = uploadFinish.receiptBuildId;
        addUploadEvent(taskId, "info", `苹果构建回执：${current.receiptBuildId}。后续仅核对该构建，避免混入其他上传结果。`);
        current.monitorUntil = Date.now() + 30 * 60 * 1000;
        addUploadEvent(taskId, current.duplicateDelivery ? "warning" : "info", current.duplicateDelivery ? "苹果提示文件已存在，本次未确认生成新构建。正在查询对应版本和 Build 的处理结果。" : "文件已提交给苹果，正在查询处理结果。只有匹配本次版本和 Build 的苹果构建状态才能确认处理完成。");
        refreshUploadAppleState(taskId).catch(() => {});
      }
    });

    child.stdin.on("error", error => {
      const current = uploadTasks.get(taskId);
      if (current?.status !== "running") return;
      finishUploadTask(taskId, "error", `上传参数传递失败：${error.message}`);
      child.kill();
    });
    child.stdin.end(JSON.stringify(workerConfig));

    return { taskId };
  } finally { uploadStartReservations.delete(uploadAccount); }
});

ipcMain.handle("upload-testflight-app", async (_event, taskId) => {
  const task = uploadTasks.get(String(taskId || ""));
  if (!task?.appleState?.app?.id) return { success: false, error: "请先查询苹果处理结果，确认对应 App" };
  if (!appleDeveloperLaunchAppleId || task.appleId?.toLowerCase() !== appleDeveloperLaunchAppleId.trim().toLowerCase()
    || task.appleContextToken !== `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`) {
    return { success: false, error: "账户或团队已切换，请在原上传账户下重新查询苹果处理结果" };
  }
  return { success: true, contextToken: task.appleContextToken, app: task.appleState.app, platform: task.metadata?.platform || "IOS" };
});

ipcMain.handle("upload-status", async (_event, taskId) => {
  refreshUploadAppleState(String(taskId || "")).catch(() => {});
  const task = publicUploadTask(String(taskId || ""));
  return task || { error: "upload task not found" };
});

ipcMain.handle("upload-check-apple-state", async (_event, payload = {}) => {
  try {
    let taskId = String(payload.taskId || "");
    let task = uploadTasks.get(taskId);
    if (task?.status === "running") throw new Error("文件仍在上传，提交后会自动查询苹果处理结果");
    if (!task || ["error", "validated"].includes(task.status)) {
      const ipaPath = String(payload.ipaPath || "");
      const appleId = String(payload.appleId || "").trim();
      if (!ipaPath || !appleId) throw new Error("请选择要查询的 IPA，并登录上传时使用的 Apple ID");
      const metadata = await inspectIPA(ipaPath);
      taskId = createUploadTask(path.basename(ipaPath));
      task = uploadTasks.get(taskId);
      Object.assign(task, { status: "submitted", metadata, appleId, lookupOnly: true, deliveryConfirmed: false, monitorUntil: Date.now() + 30 * 60 * 1000 });
      addUploadEvent(taskId, "info", `仅查询苹果处理结果，不重新上传：${metadata.bundleId}，版本 ${metadata.version}，Build ${metadata.build}。`);
    }
    refreshUploadAppleState(taskId, { force: true }).catch(() => {});
    return { taskId, metadata: task.metadata };
  } catch (error) { return { error: error.message || "苹果处理结果查询启动失败" }; }
});

ipcMain.handle("deepseek-upload-analyze", async (_event, payload = {}) => {
  try {
    return await analyzeDeepSeekUploadError(payload);
  } catch (error) {
    return { success: false, error: error.message || "AI 解析失败" };
  }
});

ipcMain.handle("auth-login", async (_event, payload = {}) => {
  const result = await authRequest("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
  if (result?.success) saveDesktopUserIdentity(result);
  return result;
});

ipcMain.handle("auth-me", async () => {
  const result = await authRequest("/api/auth/me");
  if (result?.success && result.user) {
    const entitlements = await authRequest("/api/auth/desktop-entitlements").catch(() => null);
    if (entitlements?.success) Object.assign(result.user, entitlements);
  }
  if (result?.success) saveDesktopUserIdentity(result);
  return result;
});

ipcMain.handle("auth-sync-login-cookies", async (_event, webContentsId) => {
  return syncAuthCookiesFromWebContents(webContentsId);
});

ipcMain.handle("auth-logout", async () => {
  const authBaseURL = currentAuthBaseURL();
  const result = await authRequest("/api/auth/logout", { method: "POST" });
  await clearAuthCookies(authBaseURL);
  try { fs.unlinkSync(desktopUserCachePath()); } catch {}
  return result;
});

ipcMain.handle("server-config-get", async () => {
  const config = readServerConfig();
  return {
    ...config,
    currentURL: currentAuthBaseURL(config),
    systemSettingsEnabled: SYSTEM_SETTINGS_ENABLED,
    buildVariant: SYSTEM_SETTINGS_ENABLED ? "test" : "production",
  };
});

ipcMain.handle("server-config-save", async (_event, payload = {}) => {
  if (!SYSTEM_SETTINGS_ENABLED) {
    return { success: false, error: "正式包已锁定正式服务器，不支持修改系统设置" };
  }
  const entitlements = await authRequest("/api/auth/desktop-entitlements").catch(() => null);
  if (!entitlements?.success || entitlements.can_system_settings !== true) {
    return { success: false, error: "仅账户 17770044788 可以修改系统设置" };
  }
  if (browserHelperProcesses.size || browserWindows.size) {
    return { success: false, error: "请先关闭所有浏览器环境后再切换服务器" };
  }
  const mode = payload.mode === "test" ? "test" : "production";
  const testURL = normalizeServerURL(payload.testURL);
  const productionURL = normalizeServerURL(payload.productionURL);
  if (!testURL || !productionURL) return { success: false, error: "请输入有效的 HTTP 或 HTTPS 服务器地址" };
  const previousURL = currentAuthBaseURL();
  // Invalidate the old server-side session while its URL is still active.
  await authRequest("/api/auth/logout", { method: "POST" });
  const config = { mode, testURL, productionURL };
  writeServerConfig(config);
  await clearAuthCookies(previousURL);
  await clearAuthCookies(currentAuthBaseURL(config));
  return { success: true, ...config, currentURL: currentAuthBaseURL(config), restartRequired: true };
});

ipcMain.handle("server-config-relaunch", async () => {
  app.relaunch();
  app.exit(0);
  return { success: true };
});

ipcMain.handle("desktop-open-help", async () => {
  const response = await authServerFetch("/api/desktop-config");
  const body = await response.json().catch(() => ({}));
  const target = String(body.help_url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { success: false, error: "后台尚未配置使用帮助链接" };
  await shell.openExternal(target);
  return { success: true };
});

ipcMain.handle("certificate-manager-desktop-config", async (_event, payload = {}) => {
  try {
    const config = await loadDesktopConfig({
      force: payload?.force === true,
      timeoutMs: Number(payload?.timeoutMs || 8000),
    });
    return { success: true, config };
  } catch (error) {
    return { success: false, error: error.message || "桌面配置读取失败" };
  }
});

ipcMain.handle("external-open-url", async (_event, requestedURL) => {
  const target = String(requestedURL || "").trim();
  let targetURL;
  let authURL;
  try {
    targetURL = new URL(target);
    authURL = new URL(currentAuthBaseURL());
  } catch {
    return { success: false, error: "不支持的外部链接" };
  }
  const allowedTargets = new Set([
    "https://qianliip.com/?invitationCode=0O91DXHPFMZDKAPC0SF6",
  ]);
  if (targetURL.origin !== authURL.origin && !allowedTargets.has(targetURL.toString())) {
    return { success: false, error: "不支持的外部链接" };
  }
  await shell.openExternal(targetURL.toString());
  return { success: true };
});

function reviewGuidanceAccountId() {
  const accountId = String(appleDeveloperRecordId || "").trim();
  if (!accountId) throw new Error("请先从开发者账户列表启动证书管理");
  return accountId;
}

function reviewGuidanceURL(requestPath, params = {}) {
  const query = new URLSearchParams({ account_id: reviewGuidanceAccountId() });
  for (const [key, value] of Object.entries(params || {})) {
    const text = String(value || "").trim();
    if (text) query.set(key, text);
  }
  return `${requestPath}?${query.toString()}`;
}

function reviewGuidancePayload(payload = {}) {
  return { ...(payload && typeof payload === "object" ? payload : {}), account_id: reviewGuidanceAccountId() };
}

ipcMain.handle("review-guidance-create", async (_event, payload = {}) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch("/api/review-guidance/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reviewGuidancePayload(payload)),
    signal: AbortSignal.timeout(90000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { success: false, error: body.error || "指导审核创建失败" };
  return body;
});

ipcMain.handle("review-guidance-access", async (_event, appId = "") => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(reviewGuidanceURL("/api/review-guidance/access", { app_id: appId }), { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "无法读取指导审核资格" };
});

ipcMain.handle("review-guidance-bind", async (_event, payload = {}) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const code = typeof payload === "string" ? payload : payload.code;
  const appId = typeof payload === "object" ? payload.appId : "";
  const appInfo = typeof payload === "object" ? payload.app : {};
  const orderNo = typeof payload === "object" ? String(payload.orderNo || payload.order_no || "") : "";
  if (!String(appId || "").trim()) return { success: false, error: "请选择需要绑定审核核验码的 App" };
  try {
    const response = await authServerFetch("/api/review-guidance/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewGuidancePayload({ code, app_id: String(appId), app: appInfo, order_no: orderNo })),
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { success: false, error: body.error || "审核核验码绑定失败" };
  } catch (error) {
    const detail = `${error?.name || ""} ${error?.message || ""}`.trim();
    return {
      success: false,
      error: /abort|timeout/i.test(detail)
        ? "审核核验码绑定超时，服务器正在核对 App Store 状态，请稍后重试"
        : (error?.message || "审核核验码绑定失败"),
    };
  }
});

ipcMain.handle("review-guidance-apps", async () => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(reviewGuidanceURL("/api/review-guidance/apps"), { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "AppID 列表读取失败" };
});

ipcMain.handle("review-guidance-lookup-app", async (_event, appId) => {
  const id = String(appId || "").trim();
  if (!/^\d+$/.test(id)) return { success: false, error: "AppID 必须是纯数字" };
  const countries = Object.keys(isoCountries.getAlpha2Codes()).map(country => country.toLowerCase());
  const rows = new Array(countries.length);
  let cursor = 0;
  const workers = Array.from({ length: 12 }, async () => {
    while (cursor < countries.length) {
      const index = cursor++;
      const country = countries[index];
    try {
      const response = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&country=${country}`, { signal: AbortSignal.timeout(8000) });
      const body = await response.json();
        rows[index] = body?.results?.[0] ? { country: country.toUpperCase(), ...body.results[0] } : null;
      } catch { rows[index] = null; }
    }
  });
  await Promise.all(workers);
  const markets = rows.filter(Boolean);
  return {
    success: true,
    listed: markets.length > 0,
    markets: markets.map(item => item.country),
    app: markets[0] || null,
    checked_countries: countries.length,
    checked_at: new Date().toISOString(),
  };
});

ipcMain.handle("review-guidance-open-purchase", async () => {
  try {
    const response = await authServerFetch("/api/desktop-config", { signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => ({}));
    const target = String(body.review_guidance_purchase_url || "").trim();
    if (!response.ok || !/^https?:\/\//i.test(target)) {
      return { success: false, error: "后台尚未配置审核核验码购买地址" };
    }
    await shell.openExternal(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "购买页面打开失败" };
  }
});

async function createCertificateManagerPaymentOrder(payload = {}, defaultCodeType = "review") {
  try {
    const requestPayload = typeof payload === "object" && payload !== null ? payload : { pay_method: payload };
    const codeType = String(requestPayload.code_type || requestPayload.codeType || defaultCodeType || "review").trim().toLowerCase();
    const appId = String(requestPayload.app_id || requestPayload.appId || "").trim();
    const defaultPurchaseSource = !isCertificateManagerIndependent()
      ? "certificate_manager_browser"
      : (appleDeveloperRecordId ? "certificate_manager_developer" : "certificate_manager_standalone");
    const purchaseSource = String(requestPayload.purchase_source || requestPayload.purchaseSource || "").trim()
      || defaultPurchaseSource;
    const desktopUserScope = String(appleDeveloperAuthUserId || appleDeveloperOwnerKey || "").trim();
    const developerAccountId = String(requestPayload.developer_account_id || requestPayload.developerAccountId || appleDeveloperRecordId || desktopUserScope || "").trim();
    const developerAppleId = String(requestPayload.developer_apple_id || requestPayload.developerAppleId || appleDeveloperLaunchAppleId || developerAccountId || "").trim().toLowerCase();
    const response = await authServerFetch("/api/pay/verification-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_type: codeType === "normal" ? "normal" : "review",
        pay_method: String(requestPayload.pay_method || requestPayload.payMethod || "alipay"),
        purchase_source: purchaseSource,
        developer_account_id: developerAccountId,
        developer_apple_id: developerAppleId,
        app_id: appId,
        app_name: String(requestPayload.app_name || requestPayload.appName || "").trim(),
        bundle_id: String(requestPayload.bundle_id || requestPayload.bundleId || "").trim(),
      }), signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { success: false, error: body.error || "付款码生成失败" };
  } catch (error) { return { success: false, error: error.message || "付款码生成失败" }; }
}

ipcMain.handle("review-guidance-payment-create", async (_event, payload = {}) => createCertificateManagerPaymentOrder(payload, "review"));

ipcMain.handle("certificate-access-payment-create", async (_event, payload = {}) => createCertificateManagerPaymentOrder(payload, "normal"));

ipcMain.handle("review-guidance-payment-status", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/pay/verification-code/status/${encodeURIComponent(String(orderNo || ""))}`, { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "订单状态读取失败" };
});

ipcMain.handle("review-guidance-payment-reveal", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/verification-orders/${encodeURIComponent(String(orderNo || ""))}/reveal`, {
    method: "POST", signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "审核核验码领取失败" };
});

ipcMain.handle("certificate-access-payment-status", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/pay/verification-code/status/${encodeURIComponent(String(orderNo || ""))}`, { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "订单状态读取失败" };
});

ipcMain.handle("certificate-access-payment-reveal", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/verification-orders/${encodeURIComponent(String(orderNo || ""))}/reveal`, {
    method: "POST", signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "授权核验码领取失败" };
});

ipcMain.handle("developer-accounts-payment-create", async (_event, payload = {}) => createCertificateManagerPaymentOrder({
  ...(payload || {}),
  pay_method: payload?.pay_method || payload?.payMethod || "alipay",
  code_type: "normal",
}, "normal"));

ipcMain.handle("developer-accounts-payment-status", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/pay/verification-code/status/${encodeURIComponent(String(orderNo || ""))}`, { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "订单状态读取失败" };
});

ipcMain.handle("developer-accounts-payment-reveal", async (_event, orderNo) => {
  const response = await authServerFetch(`/api/verification-orders/${encodeURIComponent(String(orderNo || ""))}/reveal`, {
    method: "POST", signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "授权核验码领取失败" };
});

ipcMain.handle("review-guidance-open-invoices", async () => {
  try { await shell.openExternal(`${currentAuthBaseURL()}/profile/billing`); return { success: true }; }
  catch (error) { return { success: false, error: error.message || "开票页面打开失败" }; }
});

ipcMain.handle("review-guidance-tickets", async (_event, appId = "") => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(reviewGuidanceURL("/api/review-guidance/tickets", { app_id: appId }), { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "审核会话读取失败" };
});

ipcMain.handle("review-guidance-messages", async (_event, ticketId) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(reviewGuidanceURL(`/api/review-guidance/tickets/${encodeURIComponent(String(ticketId || ""))}/messages`), { signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(message => ({
      ...message,
      media_url: String(message.media_url || "").startsWith("/")
        ? `${currentAuthBaseURL()}${message.media_url}` : message.media_url,
    }));
  }
  return response.ok ? body : { success: false, error: body.error || "审核消息读取失败" };
});

ipcMain.handle("review-guidance-sync-app", async (_event, { ticketId, payload } = {}) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(`/api/review-guidance/tickets/${encodeURIComponent(String(ticketId || ""))}/sync-app`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reviewGuidancePayload(payload || {})),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "App 资料同步失败" };
});

ipcMain.handle("device-enrollment-start", async () => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch("/api/device-enrollment/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_id: appleDeveloperRecordId }), signal: AbortSignal.timeout(12000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.url) return { success: false, error: body.error || "设备二维码生成失败" };
  return { ...body, qrDataURL: body.qr_data_url || await QRCode.toDataURL(body.url, { width: 280, margin: 1, errorCorrectionLevel: "M" }) };
});

ipcMain.handle("device-enrollment-status", async (_event, token) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const query = `account_id=${encodeURIComponent(appleDeveloperRecordId)}`;
  const response = await authServerFetch(`/api/device-enrollment/sessions/${encodeURIComponent(String(token || ""))}?${query}`, {
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "设备识别状态读取失败" };
});

ipcMain.handle("temporary-udids-list", async () => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const response = await authServerFetch(`/api/device-enrollment/temporary-udids?account_id=${encodeURIComponent(appleDeveloperRecordId)}`, { signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "UDID 列表读取失败" };
});

ipcMain.handle("temporary-udids-delete", async (_event, id) => {
  if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const recordId = Number(id || 0);
  if (!Number.isInteger(recordId) || recordId <= 0) return { success: false, error: "UDID 记录无效" };
  const response = await authServerFetch(`/api/device-enrollment/temporary-udids/${recordId}?account_id=${encodeURIComponent(appleDeveloperRecordId)}`, {
    method: "DELETE", signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => ({}));
  return response.ok ? body : { success: false, error: body.error || "UDID 删除失败" };
});

ipcMain.handle("review-guidance-send", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
    const response = await authServerFetch(`/api/review-guidance/tickets/${encodeURIComponent(String(payload.ticketId || ""))}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: String(payload.content || ""),
        image_data_url: String(payload.imageDataURL || ""),
        account_id: appleDeveloperRecordId,
      }),
      // 图片会先编码为 Base64，再由服务端上传对象存储；12 秒不足以覆盖完整链路。
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok ? body : { success: false, error: body.error || `审核消息发送失败 (${response.status})` };
  } catch (error) {
    return { success: false, error: /abort|timeout/i.test(String(error?.name || error?.message || "")) ? "图片上传超时，请检查网络后重试" : (error.message || "审核消息发送失败") };
  }
});

const AUTH_PAGE_PATHS = new Set([
  "/login",
  "/profile/detections", "/profile/cards", "/profile/membership",
  "/profile/certificates", "/profile/appstore-uploader", "/profile/billing",
  "/profile/tools", "/profile/settings",
]);

function sendAppleDeveloperStatus(status) {
  if (isCertificateManagerStandalone()) writeCertificateManagerStatus();
  if (certificateManagerWindow && !certificateManagerWindow.isDestroyed()) {
    certificateManagerWindow.webContents.send("apple-developer-status", status);
  }
}

async function validateAppleDeveloperServiceSession(ses) {
  const teamId = readSelectedAppleDeveloperTeam()?.id || "";
  try {
    const response = await ses.fetch("https://developer.apple.com/services-account/QH65B2/account/listTeams.action", {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://developer.apple.com/account/",
      },
      body: new URLSearchParams({ teamId }).toString(),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    const result = {
      valid: response.ok && Number(body?.resultCode || 0) === 0 && Array.isArray(body?.teams),
      status: response.status,
      body,
      error: appleDeveloperServiceError(body, text),
    };
    logAppleDeveloperDiagnostic("developer-session-validation", {
      status: result.status,
      valid: result.valid,
      resultCode: body?.resultCode ?? "",
      teamCount: Array.isArray(body?.teams) ? body.teams.length : "",
      bodyKeys: Object.keys(body || {}),
      detail: result.error || "",
    });
    return result;
  } catch (error) {
    logAppleDeveloperDiagnostic("developer-session-validation-error", { error: error.message });
    return { valid: false, status: 0, body: {}, error: error.message };
  }
}

function mergeAppleDeveloperSessionInfo(sessionInfo = {}, validation = null) {
  const data = sessionInfo && typeof sessionInfo === "object" ? { ...sessionInfo } : {};
  if (validation?.valid && validation.body && typeof validation.body === "object") {
    data.developerService = validation.body;
    if (Array.isArray(validation.body.teams)) data.teams = validation.body.teams;
  }
  return data;
}

function appleDeveloperSessionFailure(validation) {
  const resultCode = Number(validation?.body?.resultCode);
  if (resultCode === 2100 || /not registered as an Apple Developer/i.test(String(validation?.error || ""))) {
    return new Error("Apple ID 登录和设备验证码已通过，但该账户尚未开通或续费 Apple Developer Program（中国大陆年费 688 元）。App Store Connect 可能仍可登录，但证书、Bundle ID、设备和描述文件功能不可用。请前往 https://developer.apple.com/programs/enroll/ 完成注册或续费。");
  }
  const code = validation?.body?.resultCode == null ? "" : ` (resultCode ${validation.body.resultCode})`;
  return new Error(`Apple Developer 后台会话建立失败${code}${validation?.error ? `：${validation.error}` : ""}`);
}

async function establishAppleDeveloperWebSession(ses) {
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const partition = appleDeveloperPartitionForAccount(accountKey);
  if (appleDeveloperSessionRefreshPromise && appleDeveloperSessionRefreshAccountKey === accountKey) {
    return appleDeveloperSessionRefreshPromise;
  }
  const refreshPromise = (async () => {
    let bootstrapWindow = null;
    try {
      if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
      bootstrapWindow = new BrowserWindow({
        show: false,
        width: 980,
        height: 760,
        webPreferences: {
          partition,
          contextIsolation: true,
          sandbox: true,
        },
      });
      const loginURL = "https://developer.apple.com/login/?return=%2Faccount%2F";
      await Promise.race([
        bootstrapWindow.loadURL(loginURL),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Apple Developer 网页会话建立超时")), 45000)),
      ]);
      if (bootstrapWindow.isDestroyed()) throw new Error("Apple Developer 网页会话窗口已关闭");
      let currentURL = bootstrapWindow.webContents.getURL();
      // Apple can briefly land on IDMS while the trusted-session cookies are
      // being committed. Retry the Developer entry URL instead of treating
      // that intermediate redirect as a final login failure.
      for (let attempt = 0; /idmsa\.apple\.com|account\.apple\.com/i.test(currentURL) && attempt < 6; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        await bootstrapWindow.loadURL(loginURL);
        currentURL = bootstrapWindow.webContents.getURL();
      }
      if (/idmsa\.apple\.com|account\.apple\.com/i.test(currentURL)) throw new Error("Apple ID 会话兑换未完成，请重新点击验证并登录");
      if (!/developer\.apple\.com\/account/i.test(currentURL)) {
        await Promise.race([
          bootstrapWindow.loadURL("https://developer.apple.com/account/"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Apple Developer 账户页加载超时")), 45000)),
        ]);
      }
      // The account shell creates the services-account session asynchronously.
      // Slow proxies frequently need several seconds after the page load event.
      let validation = await validateAppleDeveloperServiceSession(ses);
      for (let attempt = 0; !validation.valid && Number(validation.body?.resultCode) !== 2100 && attempt < 10; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        validation = await validateAppleDeveloperServiceSession(ses);
      }
      if (!validation.valid) throw appleDeveloperSessionFailure(validation);
      if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
      appleDeveloperSessionInfo = mergeAppleDeveloperSessionInfo(appleDeveloperSessionInfo, validation);
      appleDeveloperAuthenticated = true;
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, accountKey);
      return validation;
    } finally {
      if (bootstrapWindow && !bootstrapWindow.isDestroyed()) bootstrapWindow.destroy();
    }
  })();
  appleDeveloperSessionRefreshPromise = refreshPromise;
  appleDeveloperSessionRefreshAccountKey = accountKey;
  try {
    return await refreshPromise;
  } finally {
    if (appleDeveloperSessionRefreshPromise === refreshPromise) {
      appleDeveloperSessionRefreshPromise = null;
      appleDeveloperSessionRefreshAccountKey = "";
    }
  }
}

async function readAppleDeveloperStatusForContext() {
  if (isCertificateManagerIndependent() && !appleDeveloperLaunchAppleId) {
    appleDeveloperAuthenticated = false;
    return { authenticated: false, network: null };
  }
  if (appleDeveloperSecondFactorPending()) {
    return { authenticated: false, secondFactorPending: true, network: appleDeveloperNetwork || appleDeveloperLaunchNetwork || null };
  }
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const ses = session.fromPartition(appleDeveloperPartitionForAccount(accountKey));
  const contextCurrent = () => appleDeveloperContextIsCurrent(generation, accountKey);
  ensureAppleDeveloperUserAgent(ses);
  let serverAuthenticated = false;
  try {
    await restoreAppleDeveloperNetwork();
    await restoreAppleDeveloperCookies(ses);
    if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
    const readSessionInfo = async () => {
      const response = await ses.fetch("https://developer.apple.com/services-session/v1/info", {
        redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "application/json" },
      });
      const data = response.ok ? await response.json().catch(() => ({})) : {};
      const authenticated = data?.authenticated === true || data?.isAuthenticated === true ||
        data?.loggedIn === true || !!data?.user || !!data?.userId || !!data?.dsId ||
        (!!data?.data?.type && !!data?.data?.attributes?.email);
      return { data, authenticated };
    };
    let current = await readSessionInfo();
    if (!current.authenticated) {
      // The short developer.apple.com session expires earlier than Apple's
      // remembered IDMS sign-in. Visiting /login is how the website exchanges
      // the long-lived SSO cookies for a fresh developer session.
      await ses.fetch("https://developer.apple.com/login/?return=%2Faccount%2F", {
        redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "text/html" },
      });
      if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
      current = await readSessionInfo();
      // A plain fetch follows redirects but cannot execute the account shell's
      // JavaScript exchange. Open it in the same persistent partition so an
      // independently completed IDMS/2FA login is promoted to Developer auth.
      if (!current.authenticated) {
        try {
          if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
          const serviceValidation = await establishAppleDeveloperWebSession(ses);
          if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
          current = await readSessionInfo();
          if (!current.authenticated && serviceValidation?.valid) {
            current = { data: mergeAppleDeveloperSessionInfo(current.data, serviceValidation), authenticated: true };
          }
        } catch (error) {
          console.warn("promote Apple ID session to Developer session failed:", error.message);
        }
      }
      if (current.authenticated) {
        await ses.flushStorageData();
        if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
        await persistAppleDeveloperCookies(ses, accountKey).catch(error => console.warn("persist refreshed Apple session failed:", error.message));
      }
    }
    if (current.authenticated) {
      let serviceValidation = await validateAppleDeveloperServiceSession(ses);
      if (!serviceValidation.valid) {
        try {
          if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
          await establishAppleDeveloperWebSession(ses);
          if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
          serviceValidation = await validateAppleDeveloperServiceSession(ses);
        } catch (error) {
          console.warn("refresh Apple Developer service session failed:", error.message);
        }
      }
      if (!serviceValidation.valid) {
        current = { data: current.data, authenticated: false };
      } else {
        current = { data: mergeAppleDeveloperSessionInfo(current.data, serviceValidation), authenticated: true };
      }
    }
    if (current.authenticated) {
      if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
      appleDeveloperSessionInfo = current.data;
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, accountKey).catch(error => console.warn("persist active Apple session failed:", error.message));
    }
    serverAuthenticated = current.authenticated;
  } catch (error) {}
  // Apple creates cookies such as `itctx` before credentials are verified.
  // They are bootstrap/session cookies, not proof of authentication.  Treat
  // the services-session response as the only source of truth so a failed
  // login can never be reported as successful.
  if (!contextCurrent()) return { authenticated: false, stale: true, network: null };
  appleDeveloperAuthenticated = serverAuthenticated;
  return { authenticated: appleDeveloperAuthenticated, network: appleDeveloperNetwork };
}

async function readAppleDeveloperStatus() {
  const accountKey = appleDeveloperAccountKey;
  if (appleDeveloperStatusPromise && appleDeveloperStatusAccountKey === accountKey) {
    return appleDeveloperStatusPromise;
  }
  const statusPromise = readAppleDeveloperStatusForContext();
  appleDeveloperStatusPromise = statusPromise;
  appleDeveloperStatusAccountKey = accountKey;
  try {
    return await statusPromise;
  } finally {
    if (appleDeveloperStatusPromise === statusPromise) {
      appleDeveloperStatusPromise = null;
      appleDeveloperStatusAccountKey = "";
    }
  }
}

function openCertificateManagerWindow(parent) {
  if (certificateManagerWindow && !certificateManagerWindow.isDestroyed()) {
    certificateManagerWindow.show();
    certificateManagerWindow.focus();
    return certificateManagerWindow;
  }
  const appleUserAgent = ensureAppleDeveloperUserAgent(session.fromPartition(appleDeveloperPartition()));
  certificateManagerWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 600,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: `${isCertificateManagerStandalone() ? "码友证书管理" : "Apple 开发者管理"} v${app.getVersion()}`,
    icon: currentAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "certificate-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  certificateManagerWindow.webContents.setUserAgent(appleUserAgent);
  certificateManagerWindow.on("page-title-updated", event => event.preventDefault());
  certificateManagerWindow.on("closed", () => {
    certificateManagerWindow = null;
    if (isCertificateManagerStandalone()) app.quit();
  });
  certificateManagerWindow.loadFile(path.join(__dirname, "certificate-manager.html"));
  return certificateManagerWindow;
}

ipcMain.handle("certificate-manager-open", async event => {
  try {
    const identity = await requireDesktopUserIdentity();
    return await openStandaloneCertificateManager({ ownerKey: identity.key, username: identity.username, userId: identity.userId, source: "browser" });
  } catch (error) {
    return { success: false, error: error.message || "启动码友证书管理失败" };
  }
});

function developerAccountsFilePath() {
  return path.join(sharedUserDataDir(), "developer-accounts.json");
}

function developerAccountsDatabasePath() {
  return path.join(certificateManagerDataDir(), "developer-accounts.sqlite");
}

function withDeveloperAccountsDatabase(callback) {
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  const db = new DatabaseSync(developerAccountsDatabasePath());
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS developer_accounts (owner_key TEXT NOT NULL, id TEXT NOT NULL, apple_id TEXT NOT NULL, password TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY(owner_key, id), UNIQUE(owner_key, apple_id));");
    try { db.exec(`ALTER TABLE developer_accounts ADD COLUMN p12_password TEXT NOT NULL DEFAULT '${DEFAULT_P12_PASSWORD}'`); } catch {}
    try { db.exec("ALTER TABLE developer_accounts ADD COLUMN deleted_at TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE developer_accounts ADD COLUMN proxy_json TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE developer_accounts ADD COLUMN browser_proxy_key TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE developer_accounts ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'proxy'"); } catch {}
    try { db.exec("ALTER TABLE developer_accounts ADD COLUMN account_code TEXT NOT NULL DEFAULT ''"); } catch {}
    // Passwords stay on this device only. Migrate older plaintext values to
    // AES-256-GCM ciphertext before any account record is returned.
    const legacyRows = db.prepare("SELECT owner_key,id,password FROM developer_accounts WHERE password<>''").all();
    const migratePassword = db.prepare("UPDATE developer_accounts SET password=? WHERE owner_key=? AND id=?");
    for (const row of legacyRows) {
      if (!isEncryptedLocalSecret(row.password)) migratePassword.run(encryptLocalSecret(row.password), row.owner_key, row.id);
    }
    try { fs.chmodSync(developerAccountsDatabasePath(), 0o600); } catch {}
    return callback(db);
  } finally { db.close(); }
}

function migrateDeveloperAccountsJSON() {
  const source = developerAccountsFilePath();
  if (!fs.existsSync(source)) return;
  let store;
  try { store = JSON.parse(fs.readFileSync(source, "utf8")); } catch { return; }
  withDeveloperAccountsDatabase(db => {
    const insert = db.prepare("INSERT OR IGNORE INTO developer_accounts(owner_key,id,apple_id,password,remark,created_at) VALUES(?,?,?,?,?,?)");
    for (const [ownerKey, rows] of Object.entries(store || {})) {
      for (const row of Array.isArray(rows) ? rows : []) insert.run(String(ownerKey), String(row.id || crypto.randomUUID()), String(row.appleId || "").toLowerCase(), "", String(row.remark || ""), String(row.createdAt || new Date().toISOString()));
    }
  });
  try { fs.renameSync(source, `${source}.migrated`); } catch {}
}

function desktopUserIdentity(me) {
  const user = me?.user || me?.data?.user || me?.data || null;
  if (!me?.success || !user || typeof user !== "object") return null;
  const loginType = user.login_type === "employee" ? "employee" : "boss";
  const id = loginType === "employee" ? user.sub_account_id : user.id;
  if (id === undefined || id === null || id === "") return null;
  return { key: `${loginType}:${id}`, username: String(user.username || ""), userId: String(user.id || "") };
}

function desktopUserCachePath() { return path.join(sharedUserDataDir(), "desktop-user.json"); }

function saveDesktopUserIdentity(me) {
  const identity = desktopUserIdentity(me);
  if (!identity) return null;
  fs.mkdirSync(sharedUserDataDir(), { recursive: true });
  fs.writeFileSync(desktopUserCachePath(), JSON.stringify(identity), { mode: 0o600 });
  return identity;
}

function readDesktopUserIdentity() {
  try {
    const identity = JSON.parse(fs.readFileSync(desktopUserCachePath(), "utf8"));
    return identity?.key ? { key: String(identity.key), username: String(identity.username || ""), userId: String(identity.userId || "") } : null;
  } catch {
    try {
      const owners = Object.keys(JSON.parse(fs.readFileSync(developerAccountsFilePath(), "utf8")) || {});
      if (owners.length === 1) return { key: owners[0], username: "" };
    } catch {}
    try {
      const owners = withDeveloperAccountsDatabase(db => db.prepare("SELECT DISTINCT owner_key FROM developer_accounts LIMIT 2").all());
      if (owners.length === 1) return { key: String(owners[0].owner_key), username: "" };
    } catch {}
    return null;
  }
}

function independentCertificateManagerIdentity() {
  const identity = readDesktopUserIdentity();
  if (identity?.key && /^(boss|employee):\d+$/.test(identity.key)) return identity;
  return { key: "boss:1", username: "", userId: "1" };
}

function certificateManagerLaunchContextDir() {
  return path.join(sharedUserDataDir(), "certificate-manager-launch");
}

function certificateManagerStatusPath() {
  return path.join(sharedUserDataDir(), "certificate-manager-running.json");
}

function writeCertificateManagerStatus() {
  if (!isCertificateManagerStandalone()) return;
  try {
    fs.mkdirSync(sharedUserDataDir(), { recursive: true });
    const previous = readCertificateManagerStatusFile() || {};
    const previousSameAccount = String(previous.accountId || "") === String(appleDeveloperRecordId || "") &&
      String(previous.appleId || "").trim().toLowerCase() === String(appleDeveloperLaunchAppleId || "").trim().toLowerCase();
    const authenticatedAt = appleDeveloperAuthenticated && previousSameAccount ? (previous.authenticatedAt || new Date().toISOString()) : (appleDeveloperAuthenticated ? new Date().toISOString() : "");
    fs.writeFileSync(certificateManagerStatusPath(), JSON.stringify({ pid: process.pid, instanceId: certificateManagerInstanceId, launchId: certificateManagerLaunchId || "", appPath: app.getPath("exe"), appVersion: currentCertificateManagerVersion(), protocolVersion: CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION, launchMode: isCertificateManagerBrowserBound() ? "browser-bound" : "independent", ownerKey: appleDeveloperOwnerKey || "", accountId: appleDeveloperRecordId || "", appleId: appleDeveloperLaunchAppleId || "", certificateEnvironment: appleDeveloperCertificateEnvironment || null, authenticated: !!appleDeveloperAuthenticated, authenticatedAt, lastLoginIp: currentAppleDeveloperLoginIp(), updatedAt: Date.now() }), { mode: 0o600 });
  } catch {}
}

function startCertificateManagerStatusHeartbeat() {
  if (!isCertificateManagerStandalone()) return;
  writeCertificateManagerStatus();
  if (certificateManagerStatusTimer) clearInterval(certificateManagerStatusTimer);
  certificateManagerStatusTimer = setInterval(writeCertificateManagerStatus, 2500);
  certificateManagerStatusTimer.unref?.();
}

function clearCertificateManagerStatus() {
  if (certificateManagerStatusTimer) {
    clearInterval(certificateManagerStatusTimer);
    certificateManagerStatusTimer = null;
  }
  try { fs.unlinkSync(certificateManagerStatusPath()); } catch {}
}

function readCertificateManagerStatusFile() {
  try {
    return JSON.parse(fs.readFileSync(certificateManagerStatusPath(), "utf8"));
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function isCertificateManagerStatusFileRunning() {
  try {
    const status = readCertificateManagerStatusFile();
    if (!status) return false;
    const updatedAt = Number(status.updatedAt || 0);
    const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > 8000;
    const appPath = String(status.appPath || "");
    const wrongApp = appPath && (process.platform === "win32"
      ? path.win32.basename(appPath).toLowerCase() !== "码友证书管理.exe"
      : process.platform === "darwin" && !appPath.includes("码友证书管理.app/Contents/MacOS/Electron"));
    if (stale || wrongApp || !isPidRunning(status.pid)) {
      try { fs.unlinkSync(certificateManagerStatusPath()); } catch {}
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function forceCloseStandaloneCertificateManager() {
  const status = readCertificateManagerStatusFile();
  const pid = Number(status?.pid || 0);
  const result = { success: true, killed: false };
  if (Number.isInteger(pid) && pid > 0 && isPidRunning(pid) && pid !== process.pid) {
    try {
      process.kill(pid, "SIGTERM");
      result.killed = true;
    } catch (error) {
      result.error = error.message;
    }
  }
  clearCertificateManagerStatus();
  return result;
}

async function ensureCertificateManagerLaunchSlot(account = {}) {
  const status = isStandaloneCertificateManagerRunning() ? readCertificateManagerStatusFile() : null;
  if (!status) return;
  const targetAccountId = String(account.id || "");
  const targetAppleId = String(account.appleId || "").trim().toLowerCase();
  const runningAccountId = String(status.accountId || "");
  const runningAppleId = String(status.appleId || "").trim().toLowerCase();
  const needsFreshLaunch = status.launchMode !== "browser-bound" ||
    (targetAccountId && runningAccountId && targetAccountId !== runningAccountId) ||
    (targetAppleId && runningAppleId && targetAppleId !== runningAppleId);
  if (!needsFreshLaunch) return;
  console.warn("[certificate-manager] closing stale instance before browser-bound launch", {
    runningMode: status.launchMode || "",
    runningAccountId,
    runningAppleId,
    targetAccountId,
    targetAppleId,
  });
  const previousPid = Number(status.pid || 0);
  forceCloseStandaloneCertificateManager();
  // The status file is removed before the process releases its instance lock.
  for (let attempt = 0; attempt < 20 && isPidRunning(previousPid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (isPidRunning(previousPid)) {
    throw new Error("旧的证书管理进程仍在运行，请先关闭后再启动该账号");
  }
}

function readWindowsRegistryString(keyPath, valueName) {
  if (process.platform !== "win32") return "";
  const escapePowerShellLiteral = value => String(value || "").replace(/'/g, "''");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    `$value = [string](Get-ItemPropertyValue -LiteralPath 'Registry::${escapePowerShellLiteral(keyPath)}' -Name '${escapePowerShellLiteral(valueName)}' -ErrorAction Stop)`,
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))",
  ].join("; ");
  try {
    const encoded = String(execFileSync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
    ], { encoding: "utf8", windowsHide: true })).trim();
    return encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : "";
  } catch {
    return "";
  }
}

function certificateManagerAppPath() {
  if (process.platform === "win32") {
    const registryKeys = [
      "HKEY_CURRENT_USER\\Software\\com.mayou.certificate-manager",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.mayou.certificate-manager",
      "HKEY_LOCAL_MACHINE\\Software\\com.mayou.certificate-manager",
      "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.mayou.certificate-manager",
      "HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.mayou.certificate-manager",
    ];
    for (const key of registryKeys) {
      const value = readWindowsRegistryString(key, "InstallLocation");
      const candidate = String(value || "").trim().replace(/^"|"$/g, "");
      if (!candidate) continue;
      const appPath = path.extname(candidate).toLowerCase() === ".exe" ? path.dirname(candidate) : candidate;
      if (fs.existsSync(certificateManagerExecutablePath(appPath))) return appPath;
    }
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
    const defaultPath = path.join(localAppData, "Programs", "码友证书管理");
    return fs.existsSync(certificateManagerExecutablePath(defaultPath)) ? defaultPath : "";
  }
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/码友证书管理.app",
      path.join(app.getPath("home"), "Applications", "码友证书管理.app"),
    ];
    return candidates.find(candidate => fs.existsSync(certificateManagerExecutablePath(candidate))) || "";
  }
  return "";
}

function certificateManagerExecutablePath(appPath) {
  if (process.platform === "win32") return path.join(appPath, "码友证书管理.exe");
  if (process.platform === "darwin") return path.join(appPath, "Contents", "MacOS", "Electron");
  return "";
}

function readBundleVersion(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  try { return String(execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plistPath], { encoding: "utf8" })).trim(); }
  catch { return ""; }
}

function compareVersion(left, right) {
  const normalize = value => String(value || "0").split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part);
  const a = normalize(left);
  const b = normalize(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av > bv ? 1 : -1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

function currentDesktopAppVersion() {
  if (process.platform === "darwin" && app.isPackaged) {
    const bundlePath = path.resolve(process.resourcesPath, "..", "..");
    const version = readBundleVersion(bundlePath);
    if (version) return version;
  }
  return app.getVersion();
}

function normalizeDesktopVersionPolicy(config, kind) {
  const key = kind === "certificate-manager" ? "certificateManagerVersion" : "browserVersion";
  const snakeKey = kind === "certificate-manager" ? "certificate_manager_version" : "browser_version";
  const source = config?.[key] || config?.[snakeKey] || {};
  const currentVersion = String(source.currentVersion || source.current_version || source.latestVersion || source.latest_version || "").trim();
  const minimumVersion = String(source.minimumVersion || source.minimum_version || source.requiredVersion || source.required_version || "").trim();
  const requiredVersion = String(source.requiredVersion || source.required_version || minimumVersion || currentVersion || "").trim();
  return {
    currentVersion,
    minimumVersion,
    requiredVersion,
    forceUpgrade: source.forceUpgrade === true || source.force_upgrade === true || String(source.forceUpgrade ?? source.force_upgrade ?? "") === "1",
    message: String(source.message || source.upgradeMessage || source.upgrade_message || "").trim(),
  };
}

function platformDownloadKey() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

function browserDownloadURLFromConfig(config = {}) {
  const downloads = config.browserDownloadUrls || config.browser_download_urls || {};
  const rawURL = String(downloads[platformDownloadKey()] || downloads.mac || downloads.windows || "").trim();
  if (!rawURL) return "";
  try { return new URL(rawURL, currentAuthBaseURL()).toString(); }
  catch { return ""; }
}

function certificateManagerDownloadURLFromConfig(config = {}) {
  const downloads = config.certificateManagerDownloadUrls || config.certificate_manager_download_urls || {};
  const rawURL = String(
    downloads[platformDownloadKey()] ||
    downloads.mac ||
    downloads.windows ||
    config.certificateManagerDownloadUrl ||
    config.certificate_manager_download_url ||
    ""
  ).trim();
  if (!rawURL) return "";
  try { return new URL(rawURL, currentAuthBaseURL()).toString(); }
  catch { return ""; }
}

async function promptForcedDesktopUpgrade(kind, installedVersion, policy, downloadURL = "") {
  const appLabel = kind === "certificate-manager" ? "码友证书管理" : BROWSER_APP_NAME;
  const requiredVersion = policy.requiredVersion || policy.minimumVersion || policy.currentVersion || "";
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: `${appLabel}需要升级`,
    message: `当前版本 ${installedVersion || "未知"}，后台要求 ${requiredVersion || "最新版"}`,
    detail: policy.message || "当前客户端版本低于后台设置的最低版本，请升级后继续使用。",
    buttons: downloadURL ? ["下载安装", "退出"] : ["知道了"],
    defaultId: 0,
    cancelId: downloadURL ? 1 : 0,
  });
  if (downloadURL && choice.response === 0) await shell.openExternal(downloadURL);
  return { success: false, upgradeRequired: true, installedVersion, requiredVersion, error: `${appLabel}需要升级` };
}

async function enforceCurrentDesktopVersion(kind) {
  if (IS_BROWSER_HELPER) return true;
  let config = null;
  try { config = await loadDesktopConfig({ force: true, timeoutMs: 7000 }); }
  catch (error) {
    console.warn("desktop version policy unavailable:", error.message);
    return true;
  }
  const policy = normalizeDesktopVersionPolicy(config, kind);
  if (!policy.forceUpgrade) return true;
  const requiredVersion = policy.requiredVersion || policy.minimumVersion || policy.currentVersion;
  const currentVersion = currentDesktopAppVersion();
  if (!requiredVersion || compareVersion(currentVersion, requiredVersion) >= 0) return true;
  const downloadURL = kind === "certificate-manager" ? certificateManagerDownloadURLFromConfig(config) : browserDownloadURLFromConfig(config);
  await promptForcedDesktopUpgrade(kind, currentVersion, policy, downloadURL);
  app.quit();
  return false;
}

function readInstalledCertificateManagerMetadata(appPath) {
  if (process.platform === "win32") {
    const packagePath = path.join(appPath, "resources", "app", "package.json");
    const standaloneMarker = path.join(appPath, "resources", "app", ".certificate-manager-standalone");
    try {
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      const isCertificateManager = manifest?.name === "apple-certificate-manager" && fs.existsSync(standaloneMarker);
      return {
        version: String(manifest?.version || "").trim(),
        bundleId: isCertificateManager ? "com.mayou.certificate-manager" : "",
        protocolVersion: isCertificateManager ? CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION : 0,
      };
    } catch {
      return { version: "", bundleId: "", protocolVersion: 0 };
    }
  }
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const readKey = key => {
    try { return String(execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], { encoding: "utf8" })).trim(); }
    catch { return ""; }
  };
  return {
    version: readKey("CFBundleShortVersionString"),
    bundleId: readKey("CFBundleIdentifier"),
    protocolVersion: Number(readKey("MayouCertificateManagerProtocolVersion") || 0),
  };
}

function currentCertificateManagerVersion() {
  if (process.platform === "darwin" && isCertificateManagerStandalone()) {
    const bundlePath = path.resolve(process.resourcesPath, "..", "..");
    const version = readBundleVersion(bundlePath);
    if (version) return version;
  }
  return currentDesktopAppVersion();
}

async function promptCertificateManagerUpgrade(installedVersion, detail = "", policyOverride = null, configOverride = null) {
  const policy = policyOverride || {
    requiredVersion: CERTIFICATE_MANAGER_REQUIRED_VERSION,
    message: "",
  };
  const requiredVersion = policy.requiredVersion || policy.minimumVersion || policy.currentVersion || CERTIFICATE_MANAGER_REQUIRED_VERSION;
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "证书管理软件需要升级",
    message: `当前证书管理版本 ${installedVersion || "未知"}，后台最低要求 ${requiredVersion}`,
    detail: detail || policy.message || "当前版本低于后台设置的最低版本，请升级证书管理软件后重试。",
    buttons: ["下载安装", "取消"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) return { success: false, upgradeRequired: true, canceled: true, installedVersion, requiredVersion };
  const download = await promptCertificateManagerDownload(configOverride);
  return { ...download, upgradeRequired: true, installedVersion, requiredVersion };
}

function removeCertificateManagerLaunchContext(contextPathValue) {
  if (!contextPathValue) return;
  try {
    const contextPath = path.resolve(contextPathValue);
    const contextDir = path.resolve(certificateManagerLaunchContextDir());
    if (path.dirname(contextPath) !== contextDir || path.extname(contextPath) !== ".json") return;
    fs.unlinkSync(contextPath);
  } catch {}
}

function cleanupExpiredCertificateManagerLaunchContexts() {
  const contextDir = certificateManagerLaunchContextDir();
  try {
    for (const name of fs.readdirSync(contextDir)) {
      if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
      const target = path.join(contextDir, name);
      const age = Date.now() - fs.statSync(target).mtimeMs;
      if (age > 10 * 60 * 1000) fs.unlinkSync(target);
    }
  } catch {}
}

function writeCertificateManagerLaunchContext(payload) {
  const contextDir = certificateManagerLaunchContextDir();
  fs.mkdirSync(contextDir, { recursive: true });
  cleanupExpiredCertificateManagerLaunchContexts();
  const launchId = crypto.randomUUID();
  const contextPath = path.join(contextDir, `${Date.now()}-${launchId}.json`);
  const temporaryPath = `${contextPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({
    protocolVersion: CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION,
    requiredAppVersion: CERTIFICATE_MANAGER_REQUIRED_VERSION,
    launchId,
    createdAt: new Date().toISOString(),
    authBaseURL: currentAuthBaseURL(),
    ...payload,
  }), { mode: 0o600 });
  fs.renameSync(temporaryPath, contextPath);
  return { contextPath, launchId };
}

function readCertificateManagerLaunchContext(contextPathValue = CERTIFICATE_MANAGER_CONTEXT_PATH) {
  if (!contextPathValue) throw new Error("缺少浏览器启动信息路径");
  try {
    const contextPath = path.resolve(contextPathValue);
    const payload = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    if (!payload || typeof payload !== "object") throw new Error("浏览器启动信息格式不正确");
    const createdAt = new Date(payload.createdAt || 0).getTime();
    if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > 10 * 60 * 1000) throw new Error("浏览器启动信息已过期");
    if (Number(payload.protocolVersion || 0) !== CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION) throw new Error("启动通信协议版本不兼容");
    const currentVersion = currentCertificateManagerVersion();
    if (String(payload.requiredAppVersion || "") && compareVersion(currentVersion, payload.requiredAppVersion) < 0) throw new Error(`证书管理版本过低：当前 ${currentVersion}，最低需要 ${payload.requiredAppVersion}`);
    if (!String(payload.launchId || "").trim()) throw new Error("浏览器启动信息缺少确认标识");
    if (!String(payload.ownerKey || "").trim()) throw new Error("浏览器启动信息缺少码友账户");
    return payload;
  } catch (error) {
    console.warn("read certificate manager launch context failed:", error.message);
    throw error;
  }
}

function applyCertificateManagerServerContext(context = {}) {
  const authBaseURL = normalizeServerURL(context.authBaseURL || "");
  if (!authBaseURL) return;
  const config = readServerConfig();
  const currentURL = normalizeServerURL(currentAuthBaseURL(config));
  if (currentURL === authBaseURL) return;
  const mode = config.mode === "test" && SYSTEM_SETTINGS_ENABLED ? "test" : "production";
  writeServerConfig({
    ...config,
    mode,
    testURL: mode === "test" ? authBaseURL : config.testURL,
    productionURL: mode === "production" ? authBaseURL : config.productionURL,
  });
  desktopConfigCache = null;
  desktopConfigCacheAt = 0;
}

async function acceptCertificateManagerLaunchPayload(context, options = {}) {
  if (!context) throw new Error("浏览器启动信息无效或已过期");
  applyCertificateManagerServerContext(context);
  certificateManagerBrowserBound = true;
  const applied = await applyCertificateManagerLaunchContext(context);
  if (!applied) throw new Error("浏览器启动信息缺少码友账户");
  certificateManagerLaunchId = String(context.launchId || "").trim();
  writeCertificateManagerStatus();
  const win = certificateManagerWindow && !certificateManagerWindow.isDestroyed() ? certificateManagerWindow : openCertificateManagerWindow(null);
  if (win && !win.isDestroyed()) {
    win.webContents.setUserAgent(ensureAppleDeveloperUserAgent(session.fromPartition(appleDeveloperPartition())));
  }
  focusWindow(win);
  // A second browser launch for the same account still has to re-run the
  // renderer restore path. Otherwise an expired/cleared Apple session only
  // focuses the existing window and never triggers auto-login again.
  if (options.reloadWindow && win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
  return true;
}

async function acceptCertificateManagerLaunchContext(contextPath, options = {}) {
  const context = readCertificateManagerLaunchContext(contextPath);
  const accepted = await acceptCertificateManagerLaunchPayload(context, options);
  if (accepted) removeCertificateManagerLaunchContext(contextPath);
  return accepted;
}

async function promptCertificateManagerDownload(configOverride = null) {
  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "需要安装码友证书管理",
    message: "未找到码友证书管理程序",
    detail: "启动开发者账户前需要先下载安装码友证书管理。",
    buttons: ["下载安装", "取消"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) return { success: false, canceled: true, error: "未安装码友证书管理程序" };
  try {
    const config = configOverride || await loadDesktopConfig({ force: true, timeoutMs: 12000 });
    const downloadURL = certificateManagerDownloadURLFromConfig(config);
    if (!downloadURL) throw new Error("后台尚未配置证书管理安装包");
    await shell.openExternal(downloadURL);
    return { success: false, downloading: true, error: "已打开码友证书管理下载，请安装后重新启动" };
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "下载安装失败",
      message: "暂时无法获取证书管理安装包",
      detail: error.message || "请联系管理员检查后台安装包设置。",
      buttons: ["知道了"],
    });
    return { success: false, error: error.message || "证书管理安装包下载失败" };
  }
}

async function openStandaloneCertificateManager(context = {}) {
  const appPath = certificateManagerAppPath();
  if (!appPath) return await promptCertificateManagerDownload();
  const executable = certificateManagerExecutablePath(appPath);
  if (!fs.existsSync(executable)) return { success: false, error: "码友证书管理程序不完整，请重新安装" };
  const metadata = readInstalledCertificateManagerMetadata(appPath);
  if (metadata.bundleId !== "com.mayou.certificate-manager") return { success: false, error: "已安装的证书管理软件标识不正确，请重新安装" };
  let config = null;
  let policy = null;
  try {
    config = await loadDesktopConfig({ force: true, timeoutMs: 7000 });
    policy = normalizeDesktopVersionPolicy(config, "certificate-manager");
  } catch (error) {
    console.warn("certificate manager version policy unavailable:", error.message);
  }
  const backendRequiredVersion = policy?.requiredVersion || policy?.minimumVersion || policy?.currentVersion || "";
  const backendBlocksUpgrade = !!(policy?.forceUpgrade && backendRequiredVersion && compareVersion(metadata.version, backendRequiredVersion) < 0);
  const fallbackBlocksUpgrade = !backendRequiredVersion && compareVersion(metadata.version, CERTIFICATE_MANAGER_REQUIRED_VERSION) < 0;
  if (backendBlocksUpgrade || fallbackBlocksUpgrade) {
    return await promptCertificateManagerUpgrade(metadata.version, "", policy || null, config);
  }
  if (metadata.protocolVersion !== CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION) {
    return await promptCertificateManagerUpgrade(metadata.version, `启动通信协议不兼容：证书管理为 ${metadata.protocolVersion || "未标记"}，浏览器需要 ${CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION}。`, policy || null, config);
  }
  const launchRequiredVersion = backendRequiredVersion
    ? (policy?.forceUpgrade ? backendRequiredVersion : "")
    : CERTIFICATE_MANAGER_REQUIRED_VERSION;
  const { contextPath, launchId } = writeCertificateManagerLaunchContext({
    ...context,
    requiredAppVersion: launchRequiredVersion,
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // On macOS the bundle must be started through LaunchServices. Spawning the
  // nested Electron binary directly can inherit the browser runtime state and
  // crash in V8 before the certificate manager's JavaScript is loaded.
  const launchExecutable = process.platform === "darwin" ? "/usr/bin/open" : executable;
  const launchArguments = process.platform === "darwin"
    ? ["-n", appPath, "--args", "--certificate-manager-context", contextPath]
    : ["--certificate-manager-context", contextPath];
  const child = spawn(launchExecutable, launchArguments, {
    ...(process.platform === "darwin" ? {} : { cwd: path.dirname(executable) }),
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  const acknowledged = await waitForCertificateManagerLaunchAcknowledgement(launchId, context.account || {});
  if (!acknowledged) {
    return {
      success: false,
      launchHandshakeFailed: true,
      error: "证书管理没有确认当前账户的启动信息，请安装最新版证书管理后重试",
      installedVersion: metadata.version,
      requiredVersion: backendRequiredVersion || CERTIFICATE_MANAGER_REQUIRED_VERSION,
    };
  }
  removeCertificateManagerLaunchContext(contextPath);
  return { success: true, launchRequested: true, launchAcknowledged: true, installedVersion: metadata.version, requiredVersion: backendRequiredVersion || CERTIFICATE_MANAGER_REQUIRED_VERSION };
}

async function waitForCertificateManagerLaunchAcknowledgement(launchId, account = {}) {
  const targetLaunchId = String(launchId || "");
  const targetAccountId = String(account.id || "");
  const targetAppleId = String(account.appleId || "").trim().toLowerCase();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = readCertificateManagerStatusFile();
    const appleId = String(status?.appleId || "").trim().toLowerCase();
    if (
      status &&
      String(status.launchId || "") === targetLaunchId &&
      status.launchMode === "browser-bound" &&
      (!targetAccountId || String(status.accountId || "") === targetAccountId) &&
      (!targetAppleId || appleId === targetAppleId) &&
      isPidRunning(status.pid)
    ) return status;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

function isStandaloneCertificateManagerRunning() {
  return isCertificateManagerStatusFileRunning();
}

async function applyCertificateManagerLaunchContext(context) {
  const ownerKey = String(context?.ownerKey || "").trim();
  if (!ownerKey) return false;
  // Finish any hidden-window cookie promotion against its original account
  // before changing the global account key and storage directory.
  await waitForAppleContextRefreshes(true);
  const account = context.account && typeof context.account === "object" ? context.account : null;
  const previousAccountKey = appleDeveloperAccountKey;
  const nextRecordId = account?.id ? String(account.id) : "";
  const nextAppleId = String(account?.appleId || "").trim().toLowerCase();
  const accountScope = nextRecordId || nextAppleId || "browser";
  const nextAccountKey = developerAccountKey(ownerKey, accountScope);
  appleDeveloperOwnerKey = ownerKey;
  appleDeveloperAuthUserId = String(context?.userId || "").trim();
  appleDeveloperRecordId = nextRecordId;
  appleDeveloperLaunchAppleId = nextAppleId;
  appleDeveloperLaunchPassword = String(account?.password || "");
  appleDeveloperP12Password = String(account?.p12Password || DEFAULT_P12_PASSWORD);
  const proxy = normalizeDeveloperAccountProxy(account?.proxy);
  const ownedEnvironment = ensureCertificateManagerAccountEnvironment({
    ownerKey,
    accountId: nextRecordId,
    appleId: nextAppleId,
    proposedAccountKey: nextAccountKey,
    proxy,
  });
  appleDeveloperCertificateEnvironment = certificateManagerEnvironmentStatusPayload(ownedEnvironment);
  appleDeveloperAccountKey = String(ownedEnvironment?.accountKey || nextAccountKey);
  applyCertificateManagerEnvironmentUserAgent(ownedEnvironment);
  const accountChanged = appleDeveloperAccountKey !== previousAccountKey;
  if (accountChanged) {
    invalidateAppleDeveloperRuntimeForAccountSwitch();
    appleDeveloperNetwork = null;
    appleDeveloperLaunchNetwork = { enabled: false, mode: "direct" };
    appleDeveloperProxyCredentials = null;
    appleDeveloperNetworkRestoreAttempted = false;
    appleDeveloperNetworkRestoreError = null;
    appleDeveloperCookiesRestoreAttempted = false;
    appleDeveloperUserAgent = readAppleDeveloperUserAgent() || appleDeveloperUserAgent;
  }
  appleDeveloperLaunchNetwork = proxy ? { ...proxy, mode: proxy.type, ip: proxy.lastVerifiedIp || "" } : { enabled: false, mode: "direct" };
  if (proxy) saveAppleDeveloperNetwork(proxy);
  else saveAppleDeveloperNetwork({ enabled: false });
  return { accountChanged };
}

async function requireDesktopUserIdentity() {
  const identity = saveDesktopUserIdentity(await authRequest("/api/auth/me")) || readDesktopUserIdentity();
  if (!identity) throw new Error("请先登录用户账户");
  return identity;
}

function publicDeveloperAccount(item) {
  let proxy = null;
  try {
    const storedMode = String(item.connection_mode || item.connectionMode || "").toLowerCase();
    if (storedMode === "browser_proxy") proxy = findBrowserProxyByKey(item.browser_proxy_key || item.browserProxyKey);
    else proxy = normalizeDeveloperAccountProxy(item.proxy || JSON.parse(item.proxy_json || "null"));
  } catch {}
  const storedMode = String(item.connection_mode || item.connectionMode || "").toLowerCase();
  const browserProxyKey = String(item.browser_proxy_key || item.browserProxyKey || "");
  const connectionMode = storedMode === "proxy"
    ? "custom_proxy"
    : storedMode === "code"
      ? "direct"
      : (storedMode || (browserProxyKey ? "browser_proxy" : (proxy ? "custom_proxy" : "direct")));
  return {
    id: String(item.id || ""),
    appleId: String(item.apple_id || item.appleId || ""),
    remark: String(item.remark || ""),
    createdAt: String(item.created_at || item.createdAt || ""),
    deletedAt: String(item.deleted_at || item.deletedAt || ""),
    hasPassword: !!decryptDeveloperAccountPassword(item.password),
    p12Password: String(item.p12_password || item.p12Password || DEFAULT_P12_PASSWORD),
    connectionMode,
    accountCode: String(item.account_code || item.accountCode || ""),
    browserProxyKey,
    proxy: proxy ? { ...proxy, password: proxy.password ? "••••••" : "" } : null,
  };
}

function normalizeDeveloperAccountProxy(value) {
  if (!value || typeof value !== "object") return null;
  const type = String(value.type || "http").toLowerCase() === "socks5" ? "socks5" : "http";
  const host = String(value.host || "").trim();
  const port = Number(value.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const lastVerifiedIp = String(value.lastVerifiedIp || value.outIp || value.ip || "").trim();
  return {
    enabled: true,
    type,
    host,
    port,
    username: String(value.username || "").trim(),
    password: String(value.password || ""),
    ...(lastVerifiedIp ? { lastVerifiedIp } : {}),
    ...(value.country ? { country: String(value.country) } : {}),
    ...(value.region ? { region: String(value.region) } : {}),
    ...(value.city ? { city: String(value.city) } : {}),
    ...(value.isp ? { isp: String(value.isp) } : {}),
  };
}

function readBrowserProxyPool() {
  try {
    return normalizeProxyRows(JSON.parse(fs.readFileSync(proxyPoolFilePath(), "utf8")));
  } catch {
    return [];
  }
}

function findBrowserProxyByKey(key) {
  const target = String(key || "").trim();
  if (!target) return null;
  return readBrowserProxyPool().find(proxy => proxyKey(proxy) === target) || null;
}

function resolveDeveloperAccountLaunchProxy(row) {
  const mode = String(row?.connection_mode || row?.connectionMode || "direct").toLowerCase();
  let proxy = null;
  try { proxy = normalizeDeveloperAccountProxy(JSON.parse(row?.proxy_json || "null")); } catch {}
  if (mode === "browser_proxy") {
    const browserProxy = findBrowserProxyByKey(row?.browser_proxy_key || row?.browserProxyKey);
    return browserProxy || null;
  }
  if (mode === "custom_proxy" || mode === "proxy") return proxy;
  return null;
}

function ensureStandaloneDeveloperAccount(appleId, password = "") {
  const normalizedAppleId = String(appleId || "").trim().toLowerCase();
  // Browser-bound launches keep the signed launch context. Independent
  // launches reuse the last authenticated desktop identity so both modes map
  // to the same server-side software user.
  if (!isCertificateManagerIndependent() || !normalizedAppleId) return null;
  const identity = independentCertificateManagerIdentity();
  let ownerKey = identity.key;
  migrateDeveloperAccountsJSON();
  const row = withDeveloperAccountsDatabase(db => {
    let existing = db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND apple_id=?").get(ownerKey, normalizedAppleId);
    if (!existing && ownerKey !== "boss:1") {
      const legacy = db.prepare("SELECT * FROM developer_accounts WHERE owner_key='boss:1' AND apple_id=?").get(normalizedAppleId);
      if (legacy) {
        db.prepare("UPDATE developer_accounts SET owner_key=? WHERE owner_key='boss:1' AND id=?").run(ownerKey, legacy.id);
        existing = db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND id=?").get(ownerKey, legacy.id);
      }
    }
    if (!existing) {
      existing = db.prepare("SELECT * FROM developer_accounts WHERE apple_id=? ORDER BY created_at DESC LIMIT 1").get(normalizedAppleId);
      if (existing?.owner_key) ownerKey = String(existing.owner_key);
    }
    if (existing) {
      if (password) db.prepare("UPDATE developer_accounts SET password=?, deleted_at='' WHERE owner_key=? AND id=?").run(encryptLocalSecret(password), ownerKey, existing.id);
      else db.prepare("UPDATE developer_accounts SET deleted_at='' WHERE owner_key=? AND id=?").run(ownerKey, existing.id);
      return db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND id=?").get(ownerKey, existing.id);
    }
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO developer_accounts(owner_key,id,apple_id,password,remark,created_at) VALUES(?,?,?,?,?,?)")
      .run(ownerKey, id, normalizedAppleId, password ? encryptLocalSecret(password) : "", "独立证书管理", new Date().toISOString());
    return db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND id=?").get(ownerKey, id);
  });
  appleDeveloperOwnerKey = ownerKey;
  appleDeveloperAuthUserId = String(identity.userId || "").trim();
  appleDeveloperRecordId = String(row.id || "");
  appleDeveloperLaunchAppleId = normalizedAppleId;
  appleDeveloperLaunchPassword = password || decryptDeveloperAccountPassword(row.password) || appleDeveloperLaunchPassword;
  const proposedAccountKey = crypto.createHash("sha256").update(`${ownerKey}:${row.id}`).digest("hex").slice(0, 24);
  let accountProxy = developerAccountProxyFromRow(row);
  let ownedEnvironment = ensureCertificateManagerAccountEnvironment({
    ownerKey,
    accountId: String(row.id || ""),
    appleId: normalizedAppleId,
    proposedAccountKey,
    proxy: accountProxy,
  });
  const restoredProxy = accountProxy || normalizeDeveloperAccountProxy(readAppleDeveloperNetworkFile(ownedEnvironment?.accountKey || proposedAccountKey));
  if (!accountProxy && restoredProxy) {
    withDeveloperAccountsDatabase(db => db.prepare("UPDATE developer_accounts SET proxy_json=?, browser_proxy_key='', connection_mode='custom_proxy' WHERE owner_key=? AND id=?")
      .run(JSON.stringify(restoredProxy), ownerKey, row.id));
    row.proxy_json = JSON.stringify(restoredProxy);
    row.connection_mode = "custom_proxy";
    accountProxy = restoredProxy;
    ownedEnvironment = ensureCertificateManagerAccountEnvironment({
      ownerKey,
      accountId: String(row.id || ""),
      appleId: normalizedAppleId,
      proposedAccountKey,
      proxy: accountProxy,
    });
  }
  appleDeveloperCertificateEnvironment = certificateManagerEnvironmentStatusPayload(ownedEnvironment);
  appleDeveloperAccountKey = String(ownedEnvironment?.accountKey || proposedAccountKey);
  applyCertificateManagerEnvironmentUserAgent(ownedEnvironment);
  appleDeveloperUserAgent = readAppleDeveloperUserAgent() || appleDeveloperUserAgent;
  return row;
}

function appStoreConnectSession() {
  const ses = session.fromPartition(appleDeveloperPartition());
  ensureAppleDeveloperUserAgent(ses);
  return ses;
}

function activeAppStoreConnectSession() {
  try {
    const contents = electronWebContents.getAllWebContents();
    const asc = contents.find(item => {
      try { return !item.isDestroyed() && String(item.getURL() || "").includes("appstoreconnect.apple.com"); } catch { return false; }
    });
    if (asc?.session) {
      ensureAppleDeveloperUserAgent(asc.session);
      return asc.session;
    }
  } catch {}
  return null;
}

const APP_STORE_CONNECT_SHORT_SESSION_COOKIE_NAMES = new Set([
  "itctx",
  "itcdq",
  "wosid",
  "woinst",
]);

function isAppStoreConnectShortSessionCookie(cookie = {}) {
  const name = String(cookie.name || "");
  return APP_STORE_CONNECT_SHORT_SESSION_COOKIE_NAMES.has(name) || name.startsWith("dq-auth-retry:");
}

async function clearAppStoreConnectShortSession(ses) {
  const cookies = await ses.cookies.get({});
  const targets = cookies.filter(isAppStoreConnectShortSessionCookie);
  await Promise.all(targets.map(cookie => {
    const host = String(cookie.domain || "appstoreconnect.apple.com").replace(/^\./, "") || "appstoreconnect.apple.com";
    return ses.cookies.remove(`https://${host}${cookie.path || "/"}`, cookie.name).catch(() => {});
  }));
  await ses.clearCache().catch(() => {});
  await ses.closeAllConnections().catch(() => {});
  await ses.flushStorageData().catch(() => {});
  logAppleDeveloperDiagnostic("asc-short-session-cleared", {
    removed: targets.map(cookie => cookie.name).filter(Boolean).sort(),
    preservedAppleLogin: cookies.some(cookie => cookie.name === "myacinfo"),
    preservedTrustedDevice: cookies.some(cookie => cookie.name === "aidshd" || /^DES/i.test(String(cookie.name || ""))),
  });
}

function appStoreConnectLoginRequiredError(message = "App Store Connect 主登录状态已失效") {
  const error = new Error(message);
  error.code = "APP_STORE_CONNECT_LOGIN_REQUIRED";
  error.status = 401;
  return error;
}

function requireAppStoreConnectFullLogin() {
  appStoreConnectForceFullLoginRequired = true;
  sendAppleDeveloperStatus({
    authenticated: false,
    appStoreConnectAuthenticationRequired: true,
    network: appleDeveloperNetwork,
  });
  return appStoreConnectLoginRequiredError("App Store Connect 主登录状态已失效，请在当前环境重新认证；环境、代理和设备指纹会保留");
}

async function validateAppStoreConnectSession(ses) {
  const response = await ses.fetch("https://appstoreconnect.apple.com/iris/v1/userPreferences", {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "application/vnd.api+json",
      Referer: "https://appstoreconnect.apple.com/apps",
      "X-CSRF-ITC": "[asc-ui]",
      "User-Agent": appleDeveloperRequestUserAgent(),
    },
  });
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const responseURL = String(response.url || "");
  await response.text().catch(() => "");
  const redirectedToLogin = /idmsa\.apple\.com|account\.apple\.com|appleid\.apple\.com/i.test(responseURL);
  const valid = response.ok && !redirectedToLogin && !contentType.includes("text/html");
  logAppleDeveloperDiagnostic("asc-session-validation", {
    status: response.status,
    valid,
    contentType,
    redirectedToLogin,
  });
  if (!valid) {
    if (response.status === 401 || redirectedToLogin || contentType.includes("text/html")) {
      throw appStoreConnectLoginRequiredError();
    }
    const error = new Error(`App Store Connect 会话验证失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
}

async function bootstrapAndValidateAppStoreConnectSession(ses, partition, landingPath) {
  let bootstrapWindow = null;
  try {
    bootstrapWindow = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await Promise.race([
      bootstrapWindow.loadURL(`https://appstoreconnect.apple.com${landingPath}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("App Store Connect 网页会话建立超时")), 45000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const currentURL = String(bootstrapWindow.webContents.getURL() || "");
    if (/idmsa\.apple\.com|account\.apple\.com|appleid\.apple\.com/i.test(currentURL)) {
      throw appStoreConnectLoginRequiredError();
    }
    if (!/appstoreconnect\.apple\.com/i.test(currentURL)) {
      throw new Error(`App Store Connect 会话建立失败 (${currentURL || "未知地址"})`);
    }
    await validateAppStoreConnectSession(ses);
  } finally {
    if (bootstrapWindow && !bootstrapWindow.isDestroyed()) bootstrapWindow.destroy();
  }
}

async function establishAppStoreConnectWebSession(ses, landingPath = "/apps", options = {}) {
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const partition = appleDeveloperPartitionForAccount(accountKey);
  if (appStoreConnectSessionRefreshPromise && appStoreConnectSessionRefreshAccountKey === accountKey) {
    return appStoreConnectSessionRefreshPromise;
  }
  const refreshPromise = (async () => {
    await pauseAppStoreConnectRequestQueue();
    try {
      if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
      const resetShortSession = options.resetShortSession === true;
      logAppleDeveloperDiagnostic("asc-session-recovery-start", { resetShortSession });
      if (resetShortSession) {
        await clearAppStoreConnectShortSession(ses);
        if (!appleDeveloperContextIsCurrent(generation, accountKey)) throw new Error("Apple 账户已切换，请重新登录");
      }
      await bootstrapAndValidateAppStoreConnectSession(ses, partition, landingPath);
      appStoreConnectForceFullLoginRequired = false;
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, accountKey);
      logAppleDeveloperDiagnostic("asc-session-recovery-success", { resetShortSession });
    } catch (error) {
      const loginRequired = error?.code === "APP_STORE_CONNECT_LOGIN_REQUIRED" || Number(error?.status || 0) === 401;
      if (loginRequired) throw requireAppStoreConnectFullLogin();
      throw error;
    } finally {
      resumeAppStoreConnectRequestQueue();
    }
  })();
  appStoreConnectSessionRefreshPromise = refreshPromise;
  appStoreConnectSessionRefreshAccountKey = accountKey;
  try {
    return await refreshPromise;
  } finally {
    if (appStoreConnectSessionRefreshPromise === refreshPromise) {
      appStoreConnectSessionRefreshPromise = null;
      appStoreConnectSessionRefreshAccountKey = "";
    }
  }
}

async function appStoreConnectFetch(requestPath, options = {}) {
  // App Store Connect calls must use the certificate manager account's own
  // persistent partition. Picking an arbitrary open ASC tab can mix another
  // browser environment's cookies/account with this certificate account.
  const primarySession = options.session || appStoreConnectSession();
  const pathText = String(requestPath || "");
  const url = pathText.startsWith("http") ? pathText : `https://appstoreconnect.apple.com${pathText}`;
  const doFetch = async ses => {
    const response = await enqueueAppStoreConnectRequest(() => {
      options.assertContext?.();
      return ses.fetch(url, {
      method: options.method || "GET",
      credentials: "include",
      redirect: "follow",
      signal: options.signal || AbortSignal.timeout(30000),
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Referer: "https://appstoreconnect.apple.com/apps",
        "X-CSRF-ITC": "[asc-ui]",
        "User-Agent": appleDeveloperRequestUserAgent(),
        ...(options.headers || {}),
      },
      ...(options.body !== undefined ? { body: options.body } : {}),
      });
    }, options.priority === "interactive" || !["GET", "HEAD"].includes(options.method || "GET"));
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!response.ok || contentType.includes("text/html")) {
      const messageRow = Array.isArray(body?.message) ? body.message[0] : null;
      const detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || body?.error ||
        messageRow?.message || messageRow?.detail || messageRow?.title || messageRow?.messageKey || "";
      const error = new Error(detail || `App Store Connect 接口失败 (${response.status})`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return { response, body, text };
  };
  try {
    return await doFetch(primarySession);
  } catch (error) {
    const retryable = !options.skipSessionRefresh && (
      [401, 403, 500].includes(Number(error.status || 0)) ||
      /credential|credentials|unauthorized|登录|unexpected error|server side/i.test(String(error.message || ""))
    );
    if (retryable) {
      const authenticationFailure = Number(error.status || 0) === 401 ||
        /credential|credentials|unauthorized|登录/i.test(String(error.message || ""));
      await establishAppStoreConnectWebSession(primarySession, options.sessionRefreshPath || "/apps", {
        resetShortSession: authenticationFailure,
      });
      try {
        return await doFetch(primarySession);
      } catch (retryError) {
        const stillUnauthorized = Number(retryError?.status || 0) === 401 ||
          /credential|credentials|unauthorized|登录/i.test(String(retryError?.message || ""));
        if (stillUnauthorized) throw requireAppStoreConnectFullLogin();
        throw retryError;
      }
    }
    throw error;
  }
}

function appStoreConnectBusinessHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: "https://appstoreconnect.apple.com/business",
    ...extra,
  };
}

function normalizeAppStoreConnectProvider(row = {}) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    name: String(attributes.name || attributes.shortName || ""),
    shortName: String(attributes.shortName || ""),
    developerTeamId: String(attributes.developerTeamId || ""),
    entityType: String(attributes.entityType || ""),
    internalId: String(attributes.internalId || ""),
    type: Array.isArray(attributes.type) ? attributes.type.map(String) : [],
    contentType: Array.isArray(attributes.contentType) ? attributes.contentType.map(String) : [],
  };
}

async function fetchAppStoreConnectCurrentProvider() {
  const { body } = await appStoreConnectFetch("/olympus/v1/actors?include=provider,person&limit=2000", {
    headers: appStoreConnectBusinessHeaders(),
  });
  const actors = jsonApiRows(body).filter(row => row?.type === "actors");
  const actor = actors.find(row => row?.attributes?.isCurrent === true) || actors[0] || null;
  const providerRef = actor?.relationships?.provider?.data || null;
  const providerRow = findIncluded(body, String(providerRef?.type || "providers"), String(providerRef?.id || "")) ||
    jsonApiIncluded(body).find(row => row?.type === "providers") ||
    null;
  const provider = normalizeAppStoreConnectProvider(providerRow);
  if (!provider.id) throw new Error("App Store Connect 商务账户读取失败");
  return provider;
}

async function appStoreConnectBusinessFetch(accountId, requestPath, options = {}) {
  const pathText = String(requestPath || "");
  const path = pathText.includes("{accountId}")
    ? pathText.replace(/\{accountId\}/g, encodeURIComponent(accountId))
    : pathText;
  return appStoreConnectFetch(path, {
    ...options,
    sessionRefreshPath: "/business",
    headers: appStoreConnectBusinessHeaders({
      "X-CSRF-ITC": "agreements-ui",
      ...(options.headers || {}),
    }),
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
}

async function initializeAppStoreConnectBusinessContext(accountId) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) throw new Error("缺少 App Store Connect 商务账户 ID");
  return appStoreConnectBusinessFetch(
    normalizedAccountId,
    `/ppm/v1/accountLookup/teamTypes/ITC/teamIds/${encodeURIComponent(normalizedAccountId)}`,
  );
}

function normalizeBusinessMessage(row = {}) {
  return {
    type: String(row.type || ""),
    messageKey: String(row.messageKey || row.key || ""),
    params: row.params && typeof row.params === "object" ? row.params : {},
  };
}

function normalizeBusinessRows(body = {}) {
  const queue = [body];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    ["data", "items", "results", "banks", "bankAccounts", "pendingBankAccounts", "taxForms", "forms"].forEach(key => {
      if (value[key] !== undefined) queue.push(value[key]);
    });
  }
  return [];
}

function normalizeTaxCountryRows(body = {}, l10n = {}) {
  const rows = Array.isArray(body?.data)
    ? body.data.flatMap(item => (Array.isArray(item?.taxCountries) ? item.taxCountries.map(row => ({ ...row, vendorScopeId: String(item.vendorScopeId || ""), optimisticLock: String(item.optimisticLock || "") })) : []))
    : [];
  return rows.map(row => {
    const code = String(row.country || "").trim();
    const locKey = String(row.descriptionKey || `PPM.generic.country.${code}`);
    return {
      country: code,
      countryText: String(l10n[`PPM.generic.country.${code}`] || l10n[code] || (code === "CHN" ? "中国大陆" : code || "—")),
      description: String(l10n[locKey] || ""),
      descriptionKey: locKey,
      isRequired: row.isRequired === true,
      isSelected: row.isSelected === true,
      vendorScopeId: String(row.vendorScopeId || ""),
      optimisticLock: String(row.optimisticLock || ""),
      isSelectable: row.isRequired !== true,
      raw: row,
    };
  }).filter(item => item.country);
}

function normalizeTaxRequirementRows(body = {}, l10n = {}) {
  return normalizeBusinessRows(body).map(row => {
    const taxCountry = String(row.taxCountry || "").trim();
    const taxFormType = String(row.taxFormType || "").trim();
    return {
      ...row,
      taxCountry,
      taxCountryText: String(l10n[`PPM.generic.country.${taxCountry}`] || l10n[taxCountry] || (taxCountry === "CHN" ? "中国大陆" : taxCountry || "—")),
      taxFormType,
      taxFormTypeText: String(l10n[`PPM.tax.taxFormGeneric.taxFormType.${taxFormType}`] || l10n[taxFormType] || taxFormType || "—"),
      raw: row,
    };
  });
}

function normalizeTaxFormRows(body = {}, l10n = {}) {
  return normalizeBusinessRows(body).map(row => {
    const taxCountry = String(row.taxCountry || "").trim();
    const taxFormType = String(row.taxFormType || row.type || "").trim();
    return {
      ...row,
      taxFormId: String(row.taxFormId || row.id || ""),
      vendorId: String(row.vendorId || ""),
      vendorScopeId: String(row.vendorScopeId || ""),
      taxCountry,
      taxCountryText: String(l10n[`PPM.generic.country.${taxCountry}`] || l10n[taxCountry] || (taxCountry === "CHN" ? "中国大陆" : taxCountry || "—")),
      taxFormType,
      taxFormTypeText: String(l10n[`PPM.tax.taxFormGeneric.taxFormType.${taxFormType}`] || l10n[taxFormType] || taxFormType || "—"),
      statusText: String(row.statusText || row.status || (row.isRequired === true ? "缺少税务信息" : "—")),
      taxStatus: String(row.taxStatus || row.status || ""),
      isSubmitted: row.isSubmitted === true || ["ACTIVE", "COMPLETE", "SUBMITTED"].includes(String(row.taxStatus || row.status || "").toUpperCase()),
      raw: row,
    };
  });
}

function normalizeTaxQuestionnaireMetadata(body = {}, l10n = {}) {
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const questionnaire = data.taxFormQuestionnaire?.questionnaire && typeof data.taxFormQuestionnaire.questionnaire === "object"
    ? data.taxFormQuestionnaire.questionnaire
    : {};
  const normalizedQuestions = {};
  for (const [key, question] of Object.entries(questionnaire)) {
    normalizedQuestions[key] = {
      key,
      title: String(l10n[String(question?.titleKey || "")] || question?.titleKey || key),
      description: String(l10n[String(question?.descriptionKey || "")] || question?.descriptionKey || ""),
      answers: (Array.isArray(question?.answers) ? question.answers : []).map(answer => ({
        answerKey: String(answer?.answerKey || ""),
        label: String(l10n[String(answer?.answerKey || "")] || answer?.answerKey || "—"),
        taxFormTypes: Array.isArray(answer?.taxFormType) ? answer.taxFormType.map(String) : [],
        subsequentQuestionKey: String(answer?.subsequentQuestionKey || ""),
      })),
    };
  }
  return {
    success: true,
    accountId: String(data.accountId || ""),
    optimisticLock: String(data.optimisticLock || ""),
    taxFormType: String(data.taxFormType || ""),
    taxCountry: String(data.taxCountry || ""),
    initialQuestionKey: String(data.taxFormQuestionnaire?.initialQuestionKey || ""),
    questionnaire: normalizedQuestions,
    data,
    raw: body,
  };
}

function normalizeBusinessAddress(row = {}) {
  return {
    country: String(row.country || ""),
    iso2CountryCode: String(row.iso2CountryCode || ""),
    addressLine1: String(row.addressLine1 || ""),
    addressLine2: String(row.addressLine2 || ""),
    addressLine3: String(row.addressLine3 || ""),
    city: String(row.city || ""),
    regionText: String(row.regionText || ""),
    postalCode: String(row.postalCode || ""),
    addressId: String(row.addressId || ""),
  };
}

function normalizeLegalEntity(row = {}) {
  const id = String(row.legalEntityId || row.id || "");
  const vendorScopes = Array.isArray(row.vendorScope) ? row.vendorScope : (Array.isArray(row.vendorScopes) ? row.vendorScopes : []);
  return {
    id,
    legalEntityId: id,
    accountId: String(row.accountId || ""),
    name: String(row.legalEntityName || row.name || ""),
    legalEntityName: String(row.legalEntityName || row.name || ""),
    localName: String(row.legalEntityLocalName || ""),
    legalEntityLocalName: String(row.legalEntityLocalName || ""),
    isOrganization: String(row.isOrganization || "") === "true" || row.isOrganization === true,
    typeText: (String(row.isOrganization || "") === "true" || row.isOrganization === true) ? "公司" : "个人",
    state: String(row.state || ""),
    isEditable: row.isEditable !== false,
    dunsNumber: String(row.dunsNumber || ""),
    vendorId: String(row.vendorId || ""),
    vendorScopeId: String(vendorScopes[0]?.vendorScopeId || row.vendorScopeId || ""),
    vendorScopes,
    accountSubType: String(row.accountSubType || ""),
    accountHolderName: String(row.accountHolderName || ""),
    taxJurisdictionCode: String(row.taxJurisdictionCode || ""),
    optimisticLock: String(row.optimisticLock || ""),
    address: normalizeBusinessAddress(row.address || {}),
    legalEntityAddress: normalizeBusinessAddress(row.legalEntityAddress || row.address || {}),
    financeAddress: normalizeBusinessAddress(row.financeAddress || row.address || {}),
    raw: row,
  };
}

function normalizeBusinessCountryNameMap(body = {}) {
  const mappings = body?.mappings && typeof body.mappings === "object" ? body.mappings : {};
  const result = {};
  for (const [key, value] of Object.entries(mappings)) {
    const text = String(value || "");
    if (!text) continue;
    result[key] = text;
    const match = String(key).match(/PPM\.generic\.country\.([A-Z]{3})$/);
    if (match) result[match[1]] = text;
  }
  return result;
}

function normalizeBusinessL10nMap(body = {}) {
  const result = normalizeBusinessCountryNameMap(body);
  const keyed = body?.data?.keys && typeof body.data.keys === "object" ? body.data.keys : {};
  for (const [key, value] of Object.entries(keyed)) {
    const text = String(value?.loc || value || "");
    if (text) result[key] = text;
  }
  return result;
}

function businessL10nText(map = {}, locKey = "", fallback = "") {
  const key = String(locKey || "");
  if (key && map[key]) return String(map[key]);
  const countryMatch = key.match(/PPM\.generic\.country\.([A-Z]{3})$/);
  if (countryMatch && map[countryMatch[1]]) return String(map[countryMatch[1]]);
  if (countryMatch?.[1] === "CHN") return "中国大陆";
  if (countryMatch) return String(isoCountries.getName(countryMatch[1], "zh") || fallback || countryMatch[1]);
  const regionMatch = key.match(/PPM\.generic\.country\.[A-Z]{3}\.region\.([A-Z]{2})$/);
  if (regionMatch) return String(fallback || regionMatch[1]);
  return String(fallback || key || "");
}

function normalizeBusinessAgreementCountries(row = {}, countryNameMap = {}) {
  const keyedRows = Array.isArray(row.countriesWithLocKey) ? row.countriesWithLocKey : [];
  const fallbackCodes = Array.isArray(row.countries) ? row.countries : [];
  const rows = keyedRows.length
    ? keyedRows.map(item => ({
      code: String(item?.value || item?.code || ""),
      locKey: String(item?.locKey || ""),
    }))
    : fallbackCodes.map(code => ({ code: String(code || ""), locKey: "" }));
  const seen = new Set();
  return rows
    .map(item => {
      const code = String(item.code || "").trim();
      if (!code || seen.has(code)) return null;
      seen.add(code);
      const locKey = String(item.locKey || `PPM.generic.country.${code}`);
      return {
        code,
        locKey,
        name: String(countryNameMap[locKey] || countryNameMap[code] || code),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function businessAgreementCountryScope(row = {}, countries = []) {
  const territories = Array.isArray(row.contractTerritories) ? row.contractTerritories.map(String) : [];
  if (territories.some(item => /World|all/i.test(item))) return "所有国家或地区";
  if (countries.length) return `${countries.length} 个国家或地区`;
  return "—";
}

function normalizeBusinessAgreement(row = {}, countryNameMap = {}) {
  const typeKey = String(row.contractType || row.contractDisplayName || "");
  const paid = /PaidApplications|Paid Applications|付费/i.test(typeKey);
  const free = /FreeApplications|Free Applications|免费/i.test(typeKey);
  const status = String(row.status || "");
  const availableNewConfigLocales = Array.isArray(row.availableNewConfigLocales) ? row.availableNewConfigLocales.map(String) : [];
  const configLocales = Array.isArray(row.configLocales) ? row.configLocales.map(String) : [];
  const contractConfigId = String(row.availableNewContractConfigId || row.configId || "");
  const countries = normalizeBusinessAgreementCountries(row, countryNameMap);
  const statusText = /Active/i.test(status) || row.isInEffect === true
    ? "有效"
    : /PendingUserInfo/i.test(status)
      ? "待补充信息"
      : /New/i.test(status)
        ? "新"
        : status || "—";
  return {
    id: String(row.contractId || contractConfigId || typeKey || ""),
    title: paid ? "付费 App 协议" : free ? "免费 App 协议" : String(row.contractDisplayName || "商务协议"),
    kind: paid ? "paid-app" : free ? "free-app" : "business",
    status,
    statusText,
    effectiveDate: String(row.effectiveDate || ""),
    expirationDate: String(row.expirationDate || ""),
    configVersion: Number(row.configVersion || 0),
    contractId: String(row.contractId || ""),
    configId: String(row.configId || ""),
    availableNewContractConfigId: String(row.availableNewContractConfigId || ""),
    contractConfigId,
    selectedLocaleCode: String(row.selectedLocaleCode || availableNewConfigLocales[0] || configLocales[0] || "en-US"),
    availableNewConfigLocales,
    configLocales,
    contractDisplayName: String(row.contractDisplayName || ""),
    contractType: String(row.contractType || ""),
    isInEffect: row.isInEffect === true,
    isFreeContract: row.isFreeContract === true,
    countriesCount: countries.length,
    countryScopeText: businessAgreementCountryScope(row, countries),
    countries,
    countryCodes: countries.map(item => item.code),
    localizedTermUrl: String(row.localizedTermUrl || ""),
    legalEntityId: String(row.legalEntity?.legalEntityId || ""),
    readyForSignAgreement: row.legalEntity?.readyForSignAgreement === true || row.readyForSignAgreement === true,
    applicableActions: row.applicableActions && typeof row.applicableActions === "object"
      ? {
        view: Array.isArray(row.applicableActions.view) ? row.applicableActions.view : [],
        edit: Array.isArray(row.applicableActions.edit) ? row.applicableActions.edit : [],
        setup: Array.isArray(row.applicableActions.setup) ? row.applicableActions.setup : [],
        extLink: Array.isArray(row.applicableActions.extLink) ? row.applicableActions.extLink : [],
      }
      : { view: [], edit: [], setup: [], extLink: [] },
    raw: row,
  };
}

function normalizeBusinessAgreementAttachment(row = {}) {
  return {
    publicId: String(row.publicId || row.id || ""),
    fileName: String(row.fileName || row.name || "Agreement Attachment"),
    pdfType: String(row.pdfType || ""),
    headerName: String(row.headerName || ""),
    isAuxiliary: row.isAuxiliary === true,
    raw: row,
  };
}

function normalizeComplianceInfo(row = {}) {
  const type = String(row.complianceType || row.complianceStatusLocKey || "");
  const status = String(row.complianceStatus || "");
  const countryCodes = Array.isArray(row.countries) ? row.countries.map(String).filter(Boolean) : [];
  return {
    id: String(row.complianceId || type || ""),
    title: /DIGITAL|DSA|DATA|数字/i.test(type) ? "数字服务法" : /CHINA/i.test(type) ? "中国法律合规" : type || "合规信息",
    type,
    status,
    statusText: /ACTIVE|COLLECTED|VALID|COMPLETE/i.test(status) ? "有效" : status || "—",
    lastUpdated: String(row.lastModifiedAt || row.createdAt || ""),
    countryCodes,
    countries: countryCodes.map(code => ({ code, name: code })),
    countryScopeText: countryCodes.length ? `${countryCodes.length} 个国家或地区` : "—",
    canEdit: false,
    raw: row,
  };
}

const EUROPEAN_UNION_COUNTRY_CODES = new Set([
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN",
  "FRA", "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX",
  "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
]);

function normalizeSellerCompliance(row = {}, countryNameMap = {}) {
  const coveredCountry = Array.isArray(row.coveredCountry) ? row.coveredCountry.map(String).filter(Boolean) : [];
  const countryCodes = coveredCountry.filter(code => EUROPEAN_UNION_COUNTRY_CODES.has(code));
  const countries = countryCodes.map(code => ({
    code,
    name: String(countryNameMap[code] || code),
  }));
  const status = String(row.verificationStatusLocKey || row.verificationStatus || "");
  return {
    id: "dsa",
    title: "数字服务法",
    type: "DSA",
    status,
    statusText: /active|verified|declared/i.test(status) ? "有效" : /notDeclared|NOT_PROVIDED/i.test(status) ? "缺少信息" : "待处理",
    lastUpdated: String(row.submitted || ""),
    countryCodes,
    countries,
    countryScopeText: countryCodes.length ? `${countryCodes.length} 个国家或地区` : "—",
    canEdit: false,
    raw: row,
  };
}

function complianceRequirementTitle(name = "") {
  const key = String(name || "").toUpperCase();
  if (key === "STA") return "国务院令第 810 号";
  if (key === "MEDICAL_DEVICE") return "医疗器械法规";
  return String(name || "合规要求");
}

function normalizeComplianceRequirement(row = {}, formBody = {}, countryNameMap = {}, legalEntityId = "") {
  const form = formBody?.data && typeof formBody.data === "object" ? formBody.data : {};
  const formData = form.formData && typeof form.formData === "object" ? form.formData : {};
  const constraints = formBody?.constraints && typeof formBody.constraints === "object" ? formBody.constraints : {};
  const countryCodes = Array.isArray(row.countries) ? row.countries.map(String).filter(Boolean) : [];
  const countries = countryCodes.map(code => ({
    code,
    name: String(countryNameMap[code] || code),
  }));
  const residentId = String(formData.chinaResidentId || "").trim();
  const residentConstraint = Object.entries(constraints).find(([path]) => /chinaResidentId$/i.test(String(path)));
  const rule = residentConstraint?.[1] || {};
  const hasValidResidentId = residentId.length === 18 && /^[a-zA-Z0-9]+$/.test(residentId);
  const rawStatus = String(row.status || "");
  return {
    id: String(row.id || row.name || ""),
    name: String(row.name || ""),
    title: complianceRequirementTitle(row.name),
    status: rawStatus,
    statusText: hasValidResidentId || /ACTIVE|COLLECTED|VALID|COMPLETE/i.test(rawStatus) ? "有效" : "缺少信息",
    lastUpdated: String(row.lastUpdated || form.updatedAt || form.lastModifiedAt || ""),
    countries,
    countryCodes,
    countryScopeText: countryCodes.length === 1 && countryCodes[0] === "CHN"
      ? String(countryNameMap.CHN || "中国大陆")
      : countryCodes.length ? `${countryCodes.length} 个国家或地区` : "—",
    legalEntityId: String(legalEntityId || form.entityId || ""),
    requirementId: String(row.id || form.requirementId || ""),
    formData,
    constraints,
    fieldName: String(rule.attributeName || "formData.chinaResidentId").split(".").pop() || "chinaResidentId",
    canEdit: rule.isEditable !== false && (residentConstraint || String(row.name || "").toUpperCase() === "STA") ? true : false,
    raw: row,
    rawForm: formBody,
  };
}

function getByBusinessConstraintPath(row, path) {
  const clean = String(path || "").replace(/^\$\[\d+\]\.?/, "");
  if (!clean) return undefined;
  return clean.split(".").reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), row);
}

function businessConstraintIssues(row = {}, constraints = {}) {
  const issues = [];
  for (const [path, rule] of Object.entries(constraints || {})) {
    if (!rule || typeof rule !== "object") continue;
    const value = getByBusinessConstraintPath(row, path);
    const text = String(value ?? "");
    const label = String(rule.labelKey || rule.attributeName || path);
    if (rule.required === true && !text.trim()) {
      issues.push({ path, label, message: "必填项不能为空" });
      continue;
    }
    if (Number(rule.sizeMin || 0) > 0 && text.length < Number(rule.sizeMin || 0)) {
      issues.push({ path, label, message: `至少需要 ${rule.sizeMin} 个字符` });
    }
    if (Number(rule.sizeMax || 0) > 0 && text.length > Number(rule.sizeMax || 0)) {
      issues.push({ path, label, message: `最多 ${rule.sizeMax} 个字符` });
    }
    if (rule.regex && text) {
      try {
        const regex = new RegExp(String(rule.regex));
        if (!regex.test(text)) issues.push({ path, label, message: "格式不符合 Apple 要求" });
      } catch {}
    }
  }
  return issues;
}

function normalizeLegalEntityMetadata(body = {}) {
  const row = body?.data && typeof body.data === "object" ? body.data : {};
  return {
    success: true,
    legalEntity: normalizeLegalEntity(row),
    rawLegalEntity: row,
    constraints: body?.constraints || {},
    validationIssues: businessConstraintIssues(row, body?.constraints || {}),
  };
}

function normalizeBankStatusText(status = "", pending = false, row = {}) {
  if (pending) return "待处理";
  const text = String(status || "").trim();
  const normalized = text.replace(/[\s_-]+/g, "").toLowerCase();
  const appleStatusMap = {
    ofacdisabled: "已停用",
    disabled: "已停用",
    restricted: "受限制",
    sanctioned: "受限制",
    collectinfo: "等待用户信息",
    pendinguserinfo: "等待用户信息",
    waitingdecision: "正在验证",
    verifying: "正在验证",
    pending: "待处理",
    precollect: "正在处理",
    processing: "正在处理",
    cleared: "正在处理",
    notinuse: "不在使用中",
    active: "可用",
    approved: "可用",
    valid: "可用",
    available: "可用",
    rejected: "不可用",
    invalid: "不可用",
    error: "不可用",
    failed: "不可用",
  };
  if (["ofacdisabled", "restricted", "collectinfo", "waitingdecision", "precollect"].includes(normalized)) {
    return appleStatusMap[normalized];
  }
  if (row.editable === true || row.isEditable === true) {
    return row.vendorRoyaltiesUsedByBank ? "可用" : "不在使用中";
  }
  return appleStatusMap[normalized] || (text ? "正在处理" : "可用");
}

function normalizeBankAccount(row = {}, countryNameMap = {}, pending = false) {
  const address = row.accountHolderAddress || row.bankAddress || row.address || {};
  const country = String(row.selectedCountry || row.country || address.country || "");
  const accountTail = String(row.accountNumberLastFourDigits || row.accountNumberLastDigits || row.lastFourDigits || row.lastFour || "").trim();
  const masked = String(row.maskedAccountNumber || row.accountNumberMasked || row.accountNumberDisplay || "").trim();
  const displayTail = accountTail || (masked.match(/(\d{2,6})\D*$/)?.[1] || "");
  const nickName = String(row.nickName || row.nickname || row.bankAccountName || row.name || row.accountName || "").trim();
  const bankName = String(row.bankName || row.financialInstitutionName || row.bankBranchName || "").trim();
  const label = nickName || bankName || "银行账户";
  return {
    id: String(row.bankAccountId || row.bankId || row.id || row.publicId || `${label}-${displayTail || country}`),
    account: displayTail ? `${label} (${displayTail})` : label,
    country,
    countryText: String(countryNameMap[`PPM.generic.country.${country}`] || countryNameMap[country] || country || "—"),
    bankCurrency: String(row.selectedCurrency || row.bankCurrency || row.currency || row.accountCurrency || "—"),
    royaltyCurrency: String(row.royaltyCurrency || row.paymentCurrency || row.proceedsCurrency || row.defaultCurrency || row.selectedRoyaltyCurrency || "—"),
    statusText: normalizeBankStatusText(row.status || row.state || row.approvalStatus, pending, row),
    pending,
    raw: row,
  };
}

function businessConstraintForAttribute(constraints = {}, attributeName = "") {
  const target = String(attributeName || "");
  return Object.entries(constraints || {}).find(([path, rule]) => (
    String(rule?.attributeName || "").replace(/^\$\[\*\]\.?/, "") === target ||
    String(path || "").replace(/^\$\[\*\]\.?/, "") === target
  ))?.[1] || null;
}

function normalizeBankConstraintOptions(rule = {}, l10n = {}) {
  return (Array.isArray(rule?.options) ? rule.options : [])
    .map(item => {
      const value = String(item?.value || "");
      if (!value) return null;
      const locKey = String(item?.locKey || "");
      return {
        value,
        locKey,
        label: businessL10nText(l10n, locKey, value),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

function normalizeBankMetadata(body = {}, l10n = {}) {
  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const constraints = body?.constraints && typeof body.constraints === "object" ? body.constraints : {};
  const selectedCountryRule = businessConstraintForAttribute(constraints, "selectedCountry") || {};
  const addressCountryRule = businessConstraintForAttribute(constraints, "accountHolderAddress.country") || selectedCountryRule;
  const selectedCurrencyRule = businessConstraintForAttribute(constraints, "selectedCurrency") || {};
  const accountTypeRule = businessConstraintForAttribute(constraints, "accountType") || {};
  const holderTypeRule = businessConstraintForAttribute(constraints, "accountHolderType") || {};
  const regionRule = businessConstraintForAttribute(constraints, "accountHolderAddress.regionSelect") || businessConstraintForAttribute(constraints, "accountHolderAddress.regionText") || {};
  return {
    success: true,
    data,
    constraints,
    selectedCountry: String(data.selectedCountry || ""),
    selectedCurrency: String(data.selectedCurrency || ""),
    accountHolderAddress: data.accountHolderAddress && typeof data.accountHolderAddress === "object" ? data.accountHolderAddress : {},
    optimisticLock: String(data.optimisticLock || ""),
    unknownBankBranchIdentificationKey: String(data.unknownBankBranchIdentificationKey || ""),
    skipRoyaltySelect: data.skipRoyaltySelect === true,
    countryOptions: normalizeBankConstraintOptions(selectedCountryRule, l10n),
    addressCountryOptions: normalizeBankConstraintOptions(addressCountryRule, l10n),
    currencyOptions: normalizeBankConstraintOptions(selectedCurrencyRule, l10n),
    accountTypeOptions: normalizeBankConstraintOptions(accountTypeRule, l10n),
    holderTypeOptions: normalizeBankConstraintOptions(holderTypeRule, l10n).map(item => ({
      ...item,
      label: item.value === "INDIVIDUAL" ? "个人" : item.value === "CORPORATION" ? "公司" : item.label,
    })),
    regionOptions: normalizeBankConstraintOptions(regionRule, l10n),
    raw: body,
  };
}

function appStoreConnectBankMetadataBody(payload = {}, provider = {}) {
  if (payload.initial === true) return {};
  const accountId = String(payload.accountId || provider.id || "").trim();
  const selectedCountry = String(payload.selectedCountry || payload.country || "").trim();
  const selectedCurrency = String(payload.selectedCurrency || "").trim();
  const address = payload.accountHolderAddress && typeof payload.accountHolderAddress === "object" ? payload.accountHolderAddress : {};
  const body = {
    accountId,
    accountHolderAddress: { ...address },
    optimisticLock: String(payload.optimisticLock || ""),
    unknownBankBranchIdentificationKey: String(payload.unknownBankBranchIdentificationKey || ""),
    skipRoyaltySelect: payload.skipRoyaltySelect !== false,
  };
  if (selectedCountry) body.selectedCountry = selectedCountry;
  if (selectedCurrency) body.selectedCurrency = selectedCurrency;
  if (payload.accountHolderName !== undefined) body.accountHolderName = String(payload.accountHolderName || "");
  if (payload.accountHolderType !== undefined) body.accountHolderType = String(payload.accountHolderType || "");
  if (payload.accountType !== undefined) body.accountType = String(payload.accountType || "");
  if (payload.nickName !== undefined) body.nickName = String(payload.nickName || "");
  if (payload.accountNumber !== undefined) body.accountNumber = String(payload.accountNumber || "");
  if (payload.bankBranchIdentification1 !== undefined) body.bankBranchIdentification1 = String(payload.bankBranchIdentification1 || "");
  if (payload.bankBranchIdentification2 !== undefined) body.bankBranchIdentification2 = String(payload.bankBranchIdentification2 || "");
  if (!body.accountHolderAddress.country) body.accountHolderAddress.country = selectedCountry || "USA";
  if (!body.optimisticLock) delete body.optimisticLock;
  if (!body.unknownBankBranchIdentificationKey) {
    body.unknownBankBranchIdentificationKey = `PPM.banking.bankingAccount.unknownBankBranchIdentificationKey.${body.accountHolderAddress.country || selectedCountry || "USA"}`;
  }
  return body;
}

function normalizeBankSearchResult(row = {}) {
  return {
    bankBranchIdentification1: String(row.bankBranchIdentification1 || ""),
    bankBranchIdentification2: String(row.bankBranchIdentification2 || ""),
    bankName: String(row.bankName || ""),
    addressLine1: String(row.addressLine1 || ""),
    addressLine2: String(row.addressLine2 || ""),
    city: String(row.city || ""),
    state: String(row.state || ""),
    postalCode: String(row.postalCode || ""),
    country: String(row.country || ""),
    clearingCodeType: String(row.clearingCodeType || ""),
    accuityLocationId: String(row.accuityLocationId || ""),
    iso2CountryCode: String(row.iso2CountryCode || ""),
    iso3CountryCode: String(row.iso3CountryCode || ""),
    raw: row,
  };
}

async function fetchAppStoreConnectBankMetadata(payload = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const accountId = String(payload.accountId || provider.id || "").trim();
  if (!accountId) throw new Error("缺少商务账户 ID");
  const requestBody = appStoreConnectBankMetadataBody({ ...payload, accountId }, provider);
  const [metadataResult, l10nResult] = await Promise.allSettled([
    appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/banks/metadata", {
      method: "POST",
      body: requestBody,
      headers: { Referer: "https://appstoreconnect.apple.com/business" },
    }),
    appStoreConnectBusinessFetch(accountId, "/ppm/l10n"),
  ]);
  if (metadataResult.status === "rejected") throw metadataResult.reason;
  const l10n = l10nResult.status === "fulfilled" ? normalizeBusinessL10nMap(l10nResult.value.body || {}) : {};
  return normalizeBankMetadata(metadataResult.value.body || {}, l10n);
}

async function searchAppStoreConnectBanks(payload = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const accountId = String(payload.accountId || provider.id || "").trim();
  if (!accountId) throw new Error("缺少商务账户 ID");
  const requestBody = {
    bankName: String(payload.bankName || ""),
    cityName: String(payload.cityName || ""),
    postalCode: String(payload.postalCode || ""),
    iso3CountryCode: String(payload.iso3CountryCode || payload.selectedCountry || "").trim(),
  };
  let body;
  try {
    ({ body } = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/banking/search", {
      method: "POST",
      body: requestBody,
      headers: { Referer: "https://appstoreconnect.apple.com/business" },
      skipSessionRefresh: payload.skipSessionRefresh === true,
    }));
  } catch (error) {
    const messages = Array.isArray(error?.body?.message) ? error.body.message : [];
    const noMatch = Number(error?.status || 0) === 400 && messages.some(item => (
      String(item?.messageKey || "") === "PPM.banking.localclearnacecode.search.notFoundByQuery"
    ));
    if (!noMatch) throw error;
    body = { data: [], message: messages };
  }
  const results = normalizeBusinessRows(body).map(normalizeBankSearchResult);
  return {
    success: true,
    results,
    message: Array.isArray(body?.message) ? body.message : [],
    raw: body,
  };
}

function appStoreConnectBankRoyaltyAssignmentsFromLegalEntity(legalEntity = {}, legalEntityId = "") {
  const resolvedLegalEntityId = String(legalEntity.legalEntityId || legalEntity.id || legalEntityId || "").trim();
  const vendorId = String(legalEntity.vendorId || "").trim();
  const vendorScopes = Array.isArray(legalEntity.vendorScope)
    ? legalEntity.vendorScope
    : (Array.isArray(legalEntity.vendorScopes) ? legalEntity.vendorScopes : []);
  return vendorScopes.map(scope => {
    const vendorScopeId = String(scope?.vendorScopeId || "").trim();
    const royaltyRows = Array.isArray(scope?.royalty) ? scope.royalty : (Array.isArray(scope?.royalties) ? scope.royalties : []);
    const royalties = royaltyRows
      .filter(row => row?.assignable !== false)
      .map(row => String(row?.royalty?.value || row?.value || "").trim())
      .filter((value, index, rows) => value && rows.indexOf(value) === index);
    return { legalEntityId: resolvedLegalEntityId, vendorId, vendorScopeId, royalties };
  }).filter(row => row.legalEntityId && row.vendorId && row.vendorScopeId && row.royalties.length);
}

async function fetchAppStoreConnectBankRoyaltyAssignments(accountId, legalEntityId) {
  const { body } = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities", {
    headers: { Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(legalEntityId)}` },
  });
  const entities = Array.isArray(body?.data) ? body.data : [];
  const legalEntity = entities.find(row => String(row?.legalEntityId || row?.id || "") === String(legalEntityId || ""));
  if (!legalEntity) throw new Error("当前法律实体已变化，请刷新后重试");
  const assignments = appStoreConnectBankRoyaltyAssignmentsFromLegalEntity(legalEntity, legalEntityId);
  if (!assignments.length) throw new Error("当前法律实体未返回银行付款范围，请刷新后重试");
  return { legalEntity, assignments };
}

function appStoreConnectBankSaveRequest(payload = {}, provider = {}, vendorRoyaltiesUsedByBank = [], legalEntityContext = {}) {
  const accountId = String(payload.accountId || provider.id || "").trim();
  const legalEntity = payload.legalEntity && typeof payload.legalEntity === "object" ? payload.legalEntity : {};
  const legalEntityId = String(payload.legalEntityId || legalEntity.legalEntityId || legalEntity.id || "").trim();
  if (!accountId) throw new Error("缺少商务账户 ID");
  if (!legalEntityId) throw new Error("缺少法律实体 ID");
  const selectedCurrency = String(payload.selectedCurrency || "").trim();
  const accountHolderAddress = payload.accountHolderAddress && typeof payload.accountHolderAddress === "object" ? payload.accountHolderAddress : {};
  const bank = payload.bank && typeof payload.bank === "object" ? payload.bank : {};
  const currentOptimisticLock = String(legalEntityContext.optimisticLock || payload.optimisticLock || "").trim();
  const currentHolderType = String(payload.accountHolderType || (
    String(legalEntityContext.isOrganization || "") === "true" || legalEntityContext.isOrganization === true
      ? "CORPORATION"
      : ""
  )).trim();
  const body = appStoreConnectBankMetadataBody({
    ...payload,
    accountId,
    selectedCurrency,
    accountHolderAddress,
    accountHolderName: payload.accountHolderName,
    accountHolderType: currentHolderType,
    accountType: payload.accountType,
    nickName: payload.nickName || bank.bankName || payload.bankName || "",
    accountNumber: payload.accountNumber,
    optimisticLock: currentOptimisticLock,
    bankBranchIdentification1: payload.bankBranchIdentification1 || bank.bankBranchIdentification1 || "",
    bankBranchIdentification2: payload.bankBranchIdentification2 || bank.bankBranchIdentification2 || "",
  }, provider);
  body.nickName = String(body.nickName || bank.bankName || payload.bankName || "");
  body.accountType = String(payload.accountType || "");
  body.accountNumber = String(payload.accountNumber || "").replace(/\s+/g, "");
  body.bankBranchIdentification1 = String(payload.bankBranchIdentification1 || bank.bankBranchIdentification1 || "");
  body.bankBranchIdentification2 = String(payload.bankBranchIdentification2 || bank.bankBranchIdentification2 || "");
  if (!body.nickName) delete body.nickName;
  if (!body.accountType) delete body.accountType;
  if (!body.bankBranchIdentification2) delete body.bankBranchIdentification2;
  if (!Array.isArray(vendorRoyaltiesUsedByBank) || !vendorRoyaltiesUsedByBank.length) {
    throw new Error("缺少 Apple 返回的银行付款范围");
  }
  body.vendorRoyaltiesUsedByBank = vendorRoyaltiesUsedByBank;
  body.accountHolderAddress = {
    ...body.accountHolderAddress,
    country: String(body.accountHolderAddress.country || payload.accountHolderAddress?.country || payload.selectedCountry || "USA"),
  };
  return { accountId, legalEntityId, body };
}

async function appStoreConnectCreateBankAccount(payload = {}, options = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const accountId = String(payload.accountId || provider.id || "").trim();
  const legalEntityId = String(payload.legalEntityId || payload.legalEntity?.legalEntityId || payload.legalEntity?.id || "").trim();
  const bankContext = await fetchAppStoreConnectBankRoyaltyAssignments(accountId, legalEntityId);
  const request = appStoreConnectBankSaveRequest(payload, provider, bankContext.assignments, bankContext.legalEntity);
  try {
    const { body } = await appStoreConnectBusinessFetch(request.accountId, "/ppm/v1/2fa/accounts/{accountId}/banks", {
      method: "POST",
      body: request.body,
      skipSessionRefresh: options.skipSessionRefresh !== false,
      headers: {
        "X-CSRF-ITC": "agreements-ui",
        Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(request.legalEntityId)}`,
      },
    });
    return { success: true, bankAccount: normalizeBankAccount(body?.data || body || request.body), raw: body };
  } catch (error) {
    if (!options.skipMfa && isAppStoreConnectFresh2FARequired(error)) {
      return beginAppStoreConnectBankMfa(payload, request);
    }
    throw error;
  }
}

function isAppStoreConnectFresh2FARequired(error = {}) {
  const rows = Array.isArray(error?.body?.errors) ? error.body.errors : [];
  const text = [
    error?.message,
    ...rows.flatMap(row => [row?.code, row?.title, row?.detail, row?.status]),
  ].filter(Boolean).join(" ");
  return Number(error?.status || 0) === 401 && /FRESH_2FA_REQUIRED|2FA challenge|two-factor/i.test(text);
}

function normalizeTrustedPhoneForUI(phone = {}) {
  return {
    id: phone?.id == null ? "" : String(phone.id),
    numberWithDialCode: String(phone.numberWithDialCode || ""),
    numberWithCountryCode: String(phone.numberWithCountryCode || ""),
    obfuscatedNumber: String(phone.obfuscatedNumber || ""),
    lastTwoDigits: String(phone.lastTwoDigits || ""),
    pushMode: String(phone.pushMode || "sms"),
  };
}

function appStoreConnectLegalEntityMfaIsCurrent(state = appStoreConnectLegalEntityMfa) {
  return !!state && appleDeveloperContextIsCurrent(state.contextGeneration, state.accountKey);
}

function appStoreConnectLegalEntityMfaResponse(delivery = {}) {
  const trustedPhones = (Array.isArray(delivery.trustedPhones) ? delivery.trustedPhones : [])
    .map(normalizeTrustedPhoneForUI)
    .filter(phone => phone.id);
  const phone = normalizeTrustedPhoneForUI(delivery.trustedPhone || trustedPhones[0] || {});
  return {
    success: false,
    requires2FA: true,
    error: "保存法律实体前需要完成 Apple 短信安全验证",
    message: "Apple 要求先通过短信验证码确认当前身份，验证通过后会自动继续保存。",
    phoneId: String(delivery.phoneId || phone.id || ""),
    phone,
    trustedPhones,
    initialSMS: delivery.initialSMS === true,
  };
}

function appStoreConnectLegalEntitySaveRequest(payload = {}, provider = {}) {
  const accountId = String(payload.accountId || provider.id || "").trim();
  const legalEntity = payload.legalEntity && typeof payload.legalEntity === "object" ? payload.legalEntity : {};
  const legalEntityId = String(payload.legalEntityId || legalEntity.legalEntityId || legalEntity.id || "").trim();
  if (!accountId) throw new Error("缺少商务账户 ID");
  if (!legalEntityId) throw new Error("缺少法律实体 ID");
  return { accountId, legalEntityId, legalEntity };
}

async function validateAppStoreConnectLegalEntityForSave(accountId, legalEntity) {
  const metadata = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities/metadata", {
    method: "POST",
    body: legalEntity,
  });
  return normalizeLegalEntityMetadata(metadata.body || {});
}

async function putAppStoreConnectLegalEntity(accountId, legalEntityId, legalEntity, options = {}) {
  const { body } = await appStoreConnectBusinessFetch(accountId, `/ppm/v1/2fa/accounts/{accountId}/legalEntities/${encodeURIComponent(legalEntityId)}`, {
    method: "PUT",
    body: legalEntity,
    skipSessionRefresh: options.skipSessionRefresh === true,
    headers: {
      "X-CSRF-ITC": "agreements-ui",
      Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(legalEntityId)}`,
    },
  });
  return { legalEntity: normalizeLegalEntity(body?.data || body || legalEntity), raw: body };
}

async function beginAppStoreConnectLegalEntityMfa(payload = {}, request = {}, validation = {}) {
  const fingerprint = String(payload.clientFingerprint || "").trim();
  if (!/^[.0-9A-Z_a-z]{80,256}$/.test(fingerprint)) throw new Error("Apple 客户端指纹生成失败，请关闭窗口后重试");
  const ses = appStoreConnectSession();
  const authClient = tagAppleAuthClient(new AppleAuthClient(ses, {
    clientFingerprint: fingerprint,
    skipTrust: true,
    logger: (eventName, logPayload) => logAppleDeveloperDiagnostic(`asc-legal-entity-2fa-${eventName}`, logPayload),
  }));
  const delivery = await authClient.beginMfaChallenge();
  appStoreConnectLegalEntityMfa = {
    accountKey: appleDeveloperAccountKey,
    contextGeneration: appleDeveloperContextGeneration,
    authClient,
    accountId: request.accountId,
    legalEntityId: request.legalEntityId,
    legalEntity: validation.rawLegalEntity || request.legalEntity,
    phoneId: String(delivery.phoneId || ""),
    startedAt: Date.now(),
  };
  return appStoreConnectLegalEntityMfaResponse(delivery);
}

async function saveAppStoreConnectLegalEntityWithMfaSupport(payload = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const request = appStoreConnectLegalEntitySaveRequest(payload, provider);
  const validation = await validateAppStoreConnectLegalEntityForSave(request.accountId, request.legalEntity);
  if (validation.validationIssues.length) {
    return {
      success: false,
      validationIssues: validation.validationIssues,
      legalEntity: validation.legalEntity,
      constraints: validation.constraints,
      error: validation.validationIssues[0]?.message || "法律实体信息未通过校验",
    };
  }
  try {
    const saved = await putAppStoreConnectLegalEntity(request.accountId, request.legalEntityId, validation.rawLegalEntity || request.legalEntity, { skipSessionRefresh: true });
    appStoreConnectLegalEntityMfa = null;
    return { success: true, ...saved };
  } catch (error) {
    if (isAppStoreConnectFresh2FARequired(error)) {
      return beginAppStoreConnectLegalEntityMfa(payload, request, validation);
    }
    throw error;
  }
}

async function resendAppStoreConnectLegalEntityMfaCode() {
  const state = appStoreConnectLegalEntityMfa;
  if (!appStoreConnectLegalEntityMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击保存");
  const delivery = await state.authClient.requestSMS(state.phoneId);
  state.phoneId = String(delivery.phoneId || state.phoneId || "");
  const response = appStoreConnectLegalEntityMfaResponse({ ...delivery, initialSMS: false });
  return { ...response, success: true, resent: true };
}

async function verifyAppStoreConnectLegalEntityMfaCode(code) {
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("请输入 6 位验证码");
  const state = appStoreConnectLegalEntityMfa;
  if (!appStoreConnectLegalEntityMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击保存");
  await state.authClient.verifyCode(String(code));
  try { await appStoreConnectSession().flushStorageData(); } catch {}
  const saved = await putAppStoreConnectLegalEntity(state.accountId, state.legalEntityId, state.legalEntity, { skipSessionRefresh: true });
  appStoreConnectLegalEntityMfa = null;
  return { success: true, ...saved };
}

function appStoreConnectBusinessAgreementMfaIsCurrent(state = appStoreConnectBusinessAgreementMfa) {
  return !!state && appleDeveloperContextIsCurrent(state.contextGeneration, state.accountKey);
}

function appStoreConnectBusinessAgreementMfaResponse(delivery = {}) {
  const trustedPhones = (Array.isArray(delivery.trustedPhones) ? delivery.trustedPhones : [])
    .map(normalizeTrustedPhoneForUI)
    .filter(phone => phone.id);
  const phone = normalizeTrustedPhoneForUI(delivery.trustedPhone || trustedPhones[0] || {});
  return {
    success: false,
    requires2FA: true,
    kind: "business-agreement",
    error: "签署付费 App 协议前需要完成 Apple 短信安全验证",
    message: "Apple requires two-factor authentication to help ensure your identity.",
    phoneId: String(delivery.phoneId || phone.id || ""),
    phone,
    trustedPhones,
    initialSMS: delivery.initialSMS === true,
  };
}

async function beginAppStoreConnectBusinessAgreementMfa(payload = {}, request = {}) {
  const fingerprint = String(payload.clientFingerprint || "").trim();
  if (!/^[.0-9A-Z_a-z]{80,256}$/.test(fingerprint)) throw new Error("Apple 客户端指纹生成失败，请关闭窗口后重试");
  const ses = appStoreConnectSession();
  const authClient = tagAppleAuthClient(new AppleAuthClient(ses, {
    clientFingerprint: fingerprint,
    skipTrust: true,
    logger: (eventName, logPayload) => logAppleDeveloperDiagnostic(`asc-business-agreement-2fa-${eventName}`, logPayload),
  }));
  const delivery = await authClient.beginMfaChallenge();
  appStoreConnectBusinessAgreementMfa = {
    accountKey: appleDeveloperAccountKey,
    contextGeneration: appleDeveloperContextGeneration,
    authClient,
    accountId: request.accountId,
    payload: {
      ...payload,
      accountId: request.accountId,
      providerPublicId: request.accountId,
      legalEntityId: request.legalEntityId,
      contractConfigId: request.contractConfigId,
      selectedLocaleCode: request.localeCode,
    },
    phoneId: String(delivery.phoneId || ""),
    startedAt: Date.now(),
  };
  return appStoreConnectBusinessAgreementMfaResponse(delivery);
}

async function resendAppStoreConnectBusinessAgreementMfaCode() {
  const state = appStoreConnectBusinessAgreementMfa;
  if (!appStoreConnectBusinessAgreementMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击同意");
  const previousSecondFactor = state.authClient.secondFactor;
  let delivery;
  try {
    delivery = await state.authClient.requestSMS(state.phoneId);
  } catch (error) {
    if (previousSecondFactor?.method === "sms") state.authClient.secondFactor = previousSecondFactor;
    throw error;
  }
  state.phoneId = String(delivery.phoneId || state.phoneId || "");
  return { ...appStoreConnectBusinessAgreementMfaResponse({ ...delivery, initialSMS: false }), success: true, resent: true };
}

async function verifyAppStoreConnectBusinessAgreementMfaCode(code) {
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("请输入 6 位验证码");
  const state = appStoreConnectBusinessAgreementMfa;
  if (!appStoreConnectBusinessAgreementMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击同意");
  // Keep a rejected-code transaction alive for correction. A successfully
  // verified on-demand transaction is single-use and is cleared after retrying
  // the agreement, whether that final request succeeds or fails.
  await state.authClient.verifyCode(String(code));
  try {
    try { await appStoreConnectSession().flushStorageData(); } catch {}
    const accepted = await acceptAppStoreConnectBusinessAgreement(state.payload, { skipMfa: true });
    return accepted;
  } finally {
    appStoreConnectBusinessAgreementMfa = null;
  }
}

function appStoreConnectBankMfaIsCurrent(state = appStoreConnectBankMfa) {
  return !!state && appleDeveloperContextIsCurrent(state.contextGeneration, state.accountKey);
}

function appStoreConnectBankMfaResponse(delivery = {}) {
  const trustedPhones = (Array.isArray(delivery.trustedPhones) ? delivery.trustedPhones : [])
    .map(normalizeTrustedPhoneForUI)
    .filter(phone => phone.id);
  const phone = normalizeTrustedPhoneForUI(delivery.trustedPhone || trustedPhones[0] || {});
  return {
    success: false,
    requires2FA: true,
    kind: "bank-account",
    error: "添加银行卡前需要完成 Apple 短信安全验证",
    message: "Apple 要求先通过短信验证码确认当前身份，验证通过后会自动继续添加银行卡。",
    phoneId: String(delivery.phoneId || phone.id || ""),
    phone,
    trustedPhones,
    initialSMS: delivery.initialSMS === true,
  };
}

async function beginAppStoreConnectBankMfa(payload = {}, request = {}) {
  const fingerprint = String(payload.clientFingerprint || "").trim();
  if (!/^[.0-9A-Z_a-z]{80,256}$/.test(fingerprint)) throw new Error("Apple 客户端指纹生成失败，请关闭窗口后重试");
  const ses = appStoreConnectSession();
  const authClient = tagAppleAuthClient(new AppleAuthClient(ses, {
    clientFingerprint: fingerprint,
    skipTrust: true,
    logger: (eventName, logPayload) => logAppleDeveloperDiagnostic(`asc-bank-2fa-${eventName}`, logPayload),
  }));
  const delivery = await authClient.beginMfaChallenge();
  appStoreConnectBankMfa = {
    accountKey: appleDeveloperAccountKey,
    contextGeneration: appleDeveloperContextGeneration,
    authClient,
    accountId: request.accountId,
    legalEntityId: request.legalEntityId,
    payload: { ...payload },
    request: { ...request },
    phoneId: String(delivery.phoneId || ""),
    startedAt: Date.now(),
  };
  return appStoreConnectBankMfaResponse(delivery);
}

async function resendAppStoreConnectBankMfaCode() {
  const state = appStoreConnectBankMfa;
  if (!appStoreConnectBankMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击下一步");
  const delivery = await state.authClient.requestSMS(state.phoneId);
  state.phoneId = String(delivery.phoneId || state.phoneId || "");
  return { ...appStoreConnectBankMfaResponse({ ...delivery, initialSMS: false }), success: true, resent: true };
}

async function verifyAppStoreConnectBankMfaCode(code) {
  if (!/^\d{6}$/.test(String(code || ""))) throw new Error("请输入 6 位验证码");
  const state = appStoreConnectBankMfa;
  if (!appStoreConnectBankMfaIsCurrent(state)) throw new Error("短信验证会话已过期，请重新点击下一步");
  await state.authClient.verifyCode(String(code));
  try {
    try { await appStoreConnectSession().flushStorageData(); } catch {}
    return await appStoreConnectCreateBankAccount(state.payload, { skipMfa: true, skipSessionRefresh: true });
  } catch (error) {
    error.verificationAccepted = true;
    throw error;
  } finally {
    appStoreConnectBankMfa = null;
  }
}

async function cancelAppStoreConnectBankMfa() {
  if (appStoreConnectBankMfaIsCurrent()) appStoreConnectBankMfa = null;
  return { success: true };
}

async function fetchAppStoreConnectBusinessStatus() {
  if (appStoreConnectBusinessStatusPromise) return appStoreConnectBusinessStatusPromise;
  appStoreConnectBusinessStatusPromise = fetchAppStoreConnectBusinessStatusNow()
    .finally(() => { appStoreConnectBusinessStatusPromise = null; });
  return appStoreConnectBusinessStatusPromise;
}

async function fetchAppStoreConnectBusinessStatusNow() {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const accountId = provider.id;
  await initializeAppStoreConnectBusinessContext(accountId);
  const [legalResult, messagesResult, stateResult, agreementsResult, countryL10nResult] = await Promise.allSettled([
    appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities"),
    appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/accountMessages"),
    appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/accountState"),
    appStoreConnectBusinessFetch(accountId, "/WebObjects/iTunesConnect.woa/ra/v1/contentProviders/{accountId}/agreements"),
    appStoreConnectBusinessFetch(accountId, "/ppm/l10n"),
  ]);
  if (legalResult.status === "rejected") throw legalResult.reason;
  const legalBody = legalResult.value.body || {};
  const legalEntities = (Array.isArray(legalBody.data) ? legalBody.data : []).map(normalizeLegalEntity);
  const rawLegalEntities = Array.isArray(legalBody.data) ? legalBody.data : [];
  const accountMessages = messagesResult.status === "fulfilled"
    ? (Array.isArray(messagesResult.value.body?.message) ? messagesResult.value.body.message : []).map(normalizeBusinessMessage)
    : [];
  const accountState = stateResult.status === "fulfilled" ? (stateResult.value.body?.data || {}) : {};
  const countryNameMap = countryL10nResult.status === "fulfilled" ? normalizeBusinessCountryNameMap(countryL10nResult.value.body || {}) : {};
  const businessAgreements = agreementsResult.status === "fulfilled"
    ? (Array.isArray(agreementsResult.value.body?.data?.agreements) ? agreementsResult.value.body.data.agreements : []).map(row => normalizeBusinessAgreement(row, countryNameMap))
    : [];
  const updateMessage = accountMessages.find(item => item.messageKey === "PPM.legalEntities.legalEntity.requiresUpdate.message") || null;
  const legalEntityUpdateVisible = String(updateMessage?.params?.showOnBusinessPage || "").toLowerCase() === "true";
  const legalEntityId = String(updateMessage?.params?.legalEntityId || legalEntities[0]?.id || "");
  const legalEntity = legalEntities.find(item => item.id === legalEntityId) || legalEntities[0] || null;
  const rawLegalEntity = rawLegalEntities.find(item => String(item.legalEntityId || "") === String(legalEntity?.id || "")) || rawLegalEntities[0] || {};
  const validationIssues = businessConstraintIssues(rawLegalEntity, legalBody.constraints || {});
  const stateItem = Array.isArray(accountState.legalEntityStates)
    ? accountState.legalEntityStates.find(item => String(item.legalEntityId || "") === String(legalEntity?.id || "")) || accountState.legalEntityStates[0] || null
    : null;
  const requiresLegalEntityUpdate = legalEntityUpdateVisible || validationIssues.length > 0;
  let sellerInfo = null;
  let complianceInfo = [];
  let complianceRequirements = [];
  let complianceRequirementsError = "";
  let bankAccounts = [];
  let pendingBankAccounts = [];
  let taxRequirements = [];
  let taxForms = [];
  let taxFormsLoaded = false;
  let taxCountries = [];
  let taxWHStatements = [];
  const businessSetupErrors = [];
  if (legalEntity?.id) {
    const taxVendorId = String(legalEntity.vendorId || legalEntity.id);
    const taxVendorScopeId = String(legalEntity.vendorScopeId || legalEntity.id);
    const [sellerResult, complianceResult, requirementsResult, banksResult, pendingBanksResult, taxRequirementsResult, taxFormsResult, taxCountriesResult, taxWHStatementsResult] = await Promise.allSettled([
      appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/sellerInfo"),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/legalEntities/${encodeURIComponent(legalEntity.id)}/complianceInfo`),
      appStoreConnectBusinessFetch(accountId, "/ppm/complianceform/v1/accounts/{accountId}/requirements"),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/banks?legalEntityId=${encodeURIComponent(legalEntity.id)}`),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/pendingBankAccounts?legalEntityId=${encodeURIComponent(legalEntity.id)}`),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(taxVendorId)}/taxRequirements`),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(taxVendorId)}/vendorScopes/${encodeURIComponent(taxVendorScopeId)}/taxForms`),
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(taxVendorId)}/taxCountries`),
      appStoreConnectBusinessFetch(accountId, `/WebObjects/iTunesConnect.woa/ra/v1/contentProviders/{accountId}/taxWHStatements`),
    ]);
    if (banksResult.status === "fulfilled") bankAccounts = normalizeBusinessRows(banksResult.value.body || {}).map(row => normalizeBankAccount(row, countryNameMap, false));
    else businessSetupErrors.push(banksResult.reason?.message || "银行账户状态读取失败");
    if (pendingBanksResult.status === "fulfilled") pendingBankAccounts = normalizeBusinessRows(pendingBanksResult.value.body || {}).map(row => normalizeBankAccount(row, countryNameMap, true));
    else businessSetupErrors.push(pendingBanksResult.reason?.message || "待处理银行账户状态读取失败");
    if (taxRequirementsResult.status === "fulfilled") taxRequirements = normalizeTaxRequirementRows(taxRequirementsResult.value.body || {}, countryNameMap);
    else businessSetupErrors.push(taxRequirementsResult.reason?.message || "税务要求读取失败");
    if (taxFormsResult.status === "fulfilled") {
      taxForms = normalizeTaxFormRows(taxFormsResult.value.body || {}, countryNameMap);
      taxFormsLoaded = true;
    }
    else businessSetupErrors.push(taxFormsResult.reason?.message || "税务表格读取失败");
    if (taxCountriesResult.status === "fulfilled") taxCountries = normalizeTaxCountryRows(taxCountriesResult.value.body || {}, countryNameMap);
    else businessSetupErrors.push(taxCountriesResult.reason?.message || "税务国家/地区读取失败");
    if (taxWHStatementsResult.status === "fulfilled") taxWHStatements = normalizeBusinessRows(taxWHStatementsResult.value.body || {});
    else businessSetupErrors.push(taxWHStatementsResult.reason?.message || "预扣税务信息读取失败");
    if (sellerResult.status === "fulfilled") {
      sellerInfo = sellerResult.value.body || null;
      const sellerRows = Array.isArray(sellerInfo?.sellerInfo) ? sellerInfo.sellerInfo : [];
      const sellerCompliance = sellerRows
        .filter(item => item && (item.isEuCovered === true || item.verificationStatusLocKey))
        .map(item => normalizeSellerCompliance(item, countryNameMap));
      complianceInfo = [...sellerCompliance, ...complianceInfo];
    }
    if (complianceResult.status === "fulfilled") {
      complianceInfo = (Array.isArray(complianceResult.value.body?.data) ? complianceResult.value.body.data : []).map(normalizeComplianceInfo);
    }
    if (requirementsResult.status === "fulfilled") {
      const requirementBody = requirementsResult.value.body || {};
      const legalRequirementGroup = (Array.isArray(requirementBody.requirementData) ? requirementBody.requirementData : [])
        .find(item => String(item?.legalEntityId || "") === String(legalEntity.id));
      const requiredRows = (Array.isArray(legalRequirementGroup?.requirements) ? legalRequirementGroup.requirements : [])
        .filter(item => item && item.isRequired === true);
      complianceRequirements = requiredRows
        .map(requirement => normalizeComplianceRequirement(requirement, {}, countryNameMap, legalEntity.id))
        .filter(item => item.id);
    } else {
      complianceRequirementsError = requirementsResult.reason?.message || "合规要求读取失败";
    }
  }
  return {
    success: true,
    provider,
    legalEntities,
    legalEntity,
    rawLegalEntity,
    constraints: legalBody.constraints || {},
    validationIssues,
    accountMessages,
    accountState,
    legalEntityState: stateItem,
    requiresLegalEntityUpdate,
    legalEntityUpdateMessageKey: updateMessage?.messageKey || "",
    legalEntityUpdateVisible,
    legalEntityUpdateText: requiresLegalEntityUpdate ? "若要提供 App 或其他 App 内购买项目，你必须在签署付费 App 协议前更新法律实体信息。" : "",
    businessAgreements,
    sellerInfo,
    complianceInfo,
    complianceRequirements,
    bankAccounts,
    pendingBankAccounts,
    taxRequirements,
    taxForms,
    taxFormsLoaded,
    taxCountries,
    taxWHStatements,
    businessSetupErrors,
    partialErrors: [messagesResult, stateResult, agreementsResult]
      .filter(item => item.status === "rejected")
      .map(item => item.reason?.message || "商务状态部分读取失败"),
    complianceRequirementsError,
  };
}

function appStoreConnectComplianceFormRequest(payload = {}, provider = {}) {
  const accountId = String(payload.accountId || provider.id || "").trim();
  const entityId = String(payload.legalEntityId || payload.entityId || "").trim();
  const requirementId = String(payload.requirementId || "").trim();
  const formData = payload.formData && typeof payload.formData === "object" ? payload.formData : {};
  if (!accountId) throw new Error("缺少商务账户 ID");
  if (!entityId) throw new Error("缺少法律实体 ID");
  if (!requirementId) throw new Error("缺少合规要求 ID");
  const chinaResidentId = String(formData.chinaResidentId || "").trim();
  if (!/^[a-zA-Z0-9]{18}$/.test(chinaResidentId)) {
    throw new Error("请输入 18 位字母或数字组成的身份证号");
  }
  return {
    accountId,
    entityId,
    requirementId,
    formData: { chinaResidentId },
  };
}

async function saveAppStoreConnectComplianceForm(payload = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const request = appStoreConnectComplianceFormRequest(payload, provider);
  const { body } = await appStoreConnectBusinessFetch(
    request.accountId,
    `/ppm/complianceform/v1/accounts/{accountId}/vendors/${encodeURIComponent(request.entityId)}/requirements/${encodeURIComponent(request.requirementId)}/forms`,
    {
      method: "POST",
      body: request,
      headers: { Referer: "https://appstoreconnect.apple.com/business" },
    },
  );
  return {
    success: true,
    accountId: request.accountId,
    entityId: request.entityId,
    requirementId: request.requirementId,
    formData: body?.data?.formData || request.formData,
    constraints: body?.constraints || {},
    raw: body,
  };
}

const PAID_APP_AGREEMENT_PDF_URL = "https://developer.apple.com/support/downloads/terms/schedules/Schedule-2-and-3-English.pdf";
const PAID_APP_AGREEMENT_EXHIBITS_PDF_URL = "https://developer.apple.com/support/downloads/terms/exhibits/Exhibits-to-Schedule-2-and-3-English-UK.pdf";

async function appStoreConnectBusinessAgreementRequest(payload = {}) {
  // Resolve the provider from the active Apple session on every operation so
  // a renderer payload retained across an account switch cannot select the
  // previous account's content provider.
  const currentProvider = await fetchAppStoreConnectCurrentProvider();
  const accountId = String(currentProvider.id || "").trim();
  const contractConfigId = String(payload.contractConfigId || payload.availableNewContractConfigId || payload.configId || payload.id || "").trim();
  const localeCode = String(payload.localeCode || payload.selectedLocaleCode || payload.availableNewConfigLocales?.[0] || payload.configLocales?.[0] || payload.availableLocales?.[0] || "en-US").trim() || "en-US";
  if (!accountId) throw new Error("缺少商务账户 ID");
  if (!contractConfigId) throw new Error("缺少付费 App 协议配置 ID");
  return { accountId, contractConfigId, localeCode, provider: currentProvider };
}

async function appStoreConnectBusinessAgreementLegalEntityId(accountId, hintedId = "") {
  const { body } = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities");
  const rows = Array.isArray(body?.data) ? body.data : [];
  const normalizedHint = String(hintedId || "").trim();
  const selected = rows.find(row => String(row?.legalEntityId || row?.id || "") === normalizedHint) || rows[0] || null;
  const legalEntityId = String(selected?.legalEntityId || selected?.id || "").trim();
  if (!legalEntityId) throw new Error("当前商务账户没有可用的法律实体");
  return legalEntityId;
}

async function fetchAppStoreConnectBusinessAgreementDetail(payload = {}) {
  const request = await appStoreConnectBusinessAgreementRequest(payload);
  const termsPath = `/WebObjects/iTunesConnect.woa/ra/v1/contentProviders/${encodeURIComponent(request.accountId)}/agreementTerms/${encodeURIComponent(request.contractConfigId)}/locales/${encodeURIComponent(request.localeCode)}`;
  const { body } = await appStoreConnectBusinessFetch(request.accountId, termsPath, {
    headers: { Referer: "https://appstoreconnect.apple.com/business" },
  });
  const detail = body?.data && typeof body.data === "object" ? body.data : {};
  const attachments = (Array.isArray(detail.auxStorageInfoTOs) ? detail.auxStorageInfoTOs : [])
    .map(normalizeBusinessAgreementAttachment)
    .filter(item => item.publicId || item.fileName);
  return {
    success: true,
    agreement: {
      ...payload,
      source: "app-store-connect-business",
      title: payload.title || "付费 App 协议",
      agreementHTML: String(detail.agreementHTML || ""),
      selectedLocaleCode: String(detail.selectedLocaleCode || request.localeCode),
      contractConfigId: String(detail.contractConfigId || request.contractConfigId),
      providerPublicId: String(detail.providerPublicId || request.accountId),
      termFilePublicId: String(detail.termFilePublicId || payload.termFilePublicId || ""),
      availableLocales: Array.isArray(detail.availableLocales) ? detail.availableLocales.map(String) : [],
      agreeToTerms: detail.agreeToTerms === true,
      agreeToFamilyShare: detail.agreeToFamilyShare !== false,
      auxStorageInfoTOs: Array.isArray(detail.auxStorageInfoTOs) ? detail.auxStorageInfoTOs : [],
      attachments,
      primaryDownloadUrl: PAID_APP_AGREEMENT_PDF_URL,
      attachmentDownloadUrl: PAID_APP_AGREEMENT_EXHIBITS_PDF_URL,
    },
    raw: body,
  };
}

async function acceptAppStoreConnectBusinessAgreement(payload = {}, options = {}) {
  const request = await appStoreConnectBusinessAgreementRequest(payload);
  const legalEntityId = await appStoreConnectBusinessAgreementLegalEntityId(
    request.accountId,
    payload.legalEntityId || payload.raw?.legalEntity?.legalEntityId,
  );
  request.legalEntityId = legalEntityId;
  const termsPath = `/WebObjects/iTunesConnect.woa/ra/v1/contentProviders/${encodeURIComponent(request.accountId)}/legalEntities/${encodeURIComponent(legalEntityId)}/agreementTerms/${encodeURIComponent(request.contractConfigId)}/locales/${encodeURIComponent(request.localeCode)}`;
  const termsData = {
    agreeToTerms: true,
    agreeToFamilyShare: payload.agreeToFamilyShare !== false,
  };
  const headers = {
    Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(legalEntityId)}`,
    "X-CSRF-ITC": "agreements-ui",
  };
  try {
    const { body } = await appStoreConnectBusinessFetch(request.accountId, termsPath, {
      method: "POST",
      body: termsData,
      headers,
      skipSessionRefresh: true,
    });
    return { success: true, accepted: true, raw: body || null };
  } catch (error) {
    if (!options.skipMfa && isAppStoreConnectFresh2FARequired(error)) {
      return beginAppStoreConnectBusinessAgreementMfa({ ...payload, legalEntityId }, request);
    }
    throw error;
  }
}

async function downloadAppStoreConnectBusinessAgreementDocument(payload = {}) {
  const kind = String(payload.kind || "agreement");
  const url = String(payload.url || (kind === "attachment" ? PAID_APP_AGREEMENT_EXHIBITS_PDF_URL : PAID_APP_AGREEMENT_PDF_URL));
  if (!/^https:\/\/developer\.apple\.com\/support\/downloads\/terms\//i.test(url)) throw new Error("协议下载地址无效");
  const defaultName = kind === "attachment" ? "Exhibits to Schedule 2 and 3 - 29 January 2026.pdf" : "付费 App 协议.pdf";
  let filename = safeFileName(payload.filename || defaultName);
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, {
    defaultPath: filename,
    filters: [{ name: "PDF 文件", extensions: ["pdf"] }],
  });
  if (save.canceled || !save.filePath) return { success: false, canceled: true };
  const response = await fetch(url, {
    headers: {
      Accept: "application/pdf,application/octet-stream,*/*",
      "User-Agent": appleDeveloperRequestUserAgent(),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Apple 协议文件下载失败 (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("Apple 返回了空的协议文件");
  fs.writeFileSync(save.filePath, data);
  return { success: true, path: save.filePath };
}

function normalizeAppStoreConnectTerm(row = {}) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || attributes.termsType || "ASC"),
    type: String(row?.type || "terms"),
    version: Number(attributes.version || 0),
    html: String(attributes.html || attributes.text || attributes.body || attributes.content || ""),
    skippable: attributes.skippable === true,
    refreshed: String(attributes.refreshed || attributes.dateEffective || ""),
  };
}

function normalizeAppStoreConnectTermSignature(row = {}) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    termsType: String(attributes.termsType || attributes.type || ""),
    version: Number(attributes.version || 0),
  };
}

async function fetchAppStoreConnectTermsStatus() {
  const [{ body: sitesBody }, { body: peopleBody }] = await Promise.all([
    appStoreConnectFetch("/olympus/v1/sites?include=terms", {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }),
    appStoreConnectFetch("/olympus/v1/people?include=termsSignatures", {
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    }),
  ]);
  const ascSite = jsonApiRows(sitesBody).find(row => row?.id === "ASC") || null;
  const termsRef = ascSite?.relationships?.terms?.data || null;
  const termsRow = findIncluded(sitesBody, String(termsRef?.type || "terms"), String(termsRef?.id || "ASC")) || null;
  if (!termsRow) return { success: true, required: false, terms: null };
  const terms = normalizeAppStoreConnectTerm(termsRow);
  const signatures = jsonApiIncluded(peopleBody)
    .filter(row => row?.type === "termsSignatures")
    .map(normalizeAppStoreConnectTermSignature);
  const signed = signatures.some(signature => (
    signature.termsType === terms.id && Number(signature.version || 0) >= Number(terms.version || 0)
  ));
  return { success: true, required: !signed, terms, signatures };
}

async function acceptAppStoreConnectTerms(termsPayload = {}) {
  const termsType = String(termsPayload.termsType || termsPayload.id || "ASC").trim() || "ASC";
  const version = Number(termsPayload.version || 0);
  if (!version) throw new Error("App Store Connect 服务条款版本无效");
  try {
    const { body } = await appStoreConnectFetch("/olympus/v1/termsSignatures", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-requested-with": "terms-$2343d",
      },
      body: JSON.stringify({
        data: {
          type: "termsSignatures",
          attributes: { termsType, version },
        },
      }),
      skipSessionRefresh: true,
    });
    return { success: true, signature: body?.data || null };
  } catch (error) {
    if (Number(error.status || 0) === 409) return { success: true, alreadySigned: true };
    throw error;
  }
}

function appStoreConnectErrorItems(body = {}) {
  const items = [];
  const pushError = (error, resource = "") => {
    if (!error || typeof error !== "object") return;
    const detail = String(error.detail || error.title || error.code || "").trim();
    if (!detail) return;
    items.push({
      message: detail,
      pointer: String(error.source?.pointer || ""),
      resource: String(resource || ""),
      code: String(error.code || ""),
    });
  };
  for (const error of Array.isArray(body?.errors) ? body.errors : []) {
    const associated = error?.meta?.associatedErrors || {};
    // Apple 的顶层 409 只是“请查看关联错误”的包装信息。有关联错误时保留
    // 具体资源错误，避免界面显示一条无法操作的重复通用文案。
    if (!Object.keys(associated).length) pushError(error);
    for (const [resource, errors] of Object.entries(associated)) {
      for (const nested of Array.isArray(errors) ? errors : []) pushError(nested, resource);
    }
  }
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.resource}|${item.pointer}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appStoreAssetURL(asset, size = 128) {
  const templateUrl = String(asset?.templateUrl || asset?.url || "");
  if (!templateUrl) return "";
  const pixelSize = String(Math.max(1, Number(size) || 128));
  return templateUrl
    .replace(/\{w\}/g, pixelSize)
    .replace(/\{h\}/g, pixelSize)
    .replace(/\{f\}/g, "png")
    .replace(/\{c\}/g, "bb");
}

function appStoreIconURL(row, size = 128) {
  const attributes = row?.attributes || {};
  return appStoreAssetURL(attributes.storeIcon || attributes.watchStoreIcon || attributes.iconAsset || attributes.icon || {}, size);
}

function appStorePlatformRank(platform) {
  const ranks = { IOS: 0, MAC_OS: 1, TV_OS: 2, VISION_OS: 3, WATCH_OS: 4 };
  return ranks[String(platform || "").toUpperCase()] ?? 99;
}

function sortAppStoreVersions(versions) {
  return [...(Array.isArray(versions) ? versions : [])].sort((left, right) => {
    const platformDelta = appStorePlatformRank(left.platform) - appStorePlatformRank(right.platform);
    if (platformDelta) return platformDelta;
    const dateDelta = String(right.createdDate || "").localeCompare(String(left.createdDate || ""));
    if (dateDelta) return dateDelta;
    return String(left.versionString || "").localeCompare(String(right.versionString || ""), undefined, { numeric: true });
  });
}

function normalizeAppStoreApps(body) {
  return jsonApiRows(body).filter(row => row?.type === "apps").map(row => {
    const attributes = row.attributes || {};
    const versionRefs = relationshipData(row, "displayableVersions").map(item => ({ id: String(item.id || ""), type: String(item.type || "") })).filter(item => item.id);
    const includedVersions = versionRefs
      .map(item => findIncluded(body, item.type || "appStoreVersions", item.id))
      .filter(Boolean)
      .map(normalizeAppStoreVersion);
    const versions = includedVersions.length ? sortAppStoreVersions(includedVersions) : versionRefs;
    const iconRef = relationshipData(row, "appStoreIcon")[0];
    const appIcon = iconRef ? findIncluded(body, iconRef.type || "buildIcons", iconRef.id) : null;
    const iconUrl = versions.find(item => item.iconUrl)?.iconUrl || appStoreIconURL(appIcon);
    return {
      id: String(row.id || ""),
      name: String(attributes.name || ""),
      bundleId: String(attributes.bundleId || ""),
      bundleIdName: String(attributes.bundleIdReferenceName || ""),
      sku: String(attributes.sku || ""),
      primaryLocale: String(attributes.primaryLocale || ""),
      contentRightsDeclaration: String(attributes.contentRightsDeclaration || ""),
      removed: !!attributes.removed,
      status: String(attributes.appStoreLegacyStatus || ""),
      storeUrl: String(attributes.storeUrl || ""),
      iconUrl,
      versions,
    };
  });
}

function normalizeAppIcpNumberDetail(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    icpNumber: String(attributes.icpNumber || ""),
  };
}

function normalizeAppStoreBundleIds(body) {
  return (Array.isArray(body?.data) ? body.data : []).filter(row => row?.type === "ascBundleIds").map(row => {
    const attributes = row.attributes || {};
    return { id: String(row.id || ""), name: String(attributes.name || ""), bundleId: String(attributes.bundleId || "") };
  });
}

function normalizeAppBundle(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    name: String(attributes.name || attributes.bundleIdName || ""),
    bundleId: String(attributes.bundleId || attributes.identifier || ""),
  };
}

function jsonApiRows(body) {
  if (Array.isArray(body?.data)) return body.data;
  return body?.data ? [body.data] : [];
}

function jsonApiIncluded(body) {
  return Array.isArray(body?.included) ? body.included : [];
}

function relationshipData(row, name) {
  const data = row?.relationships?.[name]?.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function findIncluded(body, type, id) {
  return jsonApiIncluded(body).find(item => item?.type === type && String(item.id || "") === String(id || "")) || null;
}

function normalizeAppStoreVersion(row) {
  const attributes = row?.attributes || {};
  const appStoreState = String(attributes.appStoreState || "");
  const appVersionState = String(attributes.appVersionState || "");
  return {
    id: String(row?.id || ""),
    platform: String(attributes.platform || ""),
    versionString: String(attributes.versionString || ""),
    state: appStoreState || appVersionState,
    appStoreState,
    appVersionState,
    createdDate: String(attributes.createdDate || ""),
    isWatchOnly: !!attributes.isWatchOnly,
    iconUrl: appStoreIconURL(row),
    copyright: String(attributes.copyright || ""),
    releaseType: String(attributes.releaseType || attributes.versionReleaseType || ""),
    earliestReleaseDate: String(attributes.earliestReleaseDate || ""),
    reviewDetailId: relationshipData(row, "appStoreReviewDetail")[0]?.id || "",
    localizationIds: relationshipData(row, "appStoreVersionLocalizations").map(item => String(item.id || "")).filter(Boolean),
    buildId: relationshipData(row, "build")[0]?.id || "",
  };
}

function normalizeAppInfoLocalization(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    locale: String(attributes.locale || ""),
    name: String(attributes.name || ""),
    subtitle: String(attributes.subtitle || ""),
    privacyPolicyUrl: String(attributes.privacyPolicyUrl || ""),
    privacyChoicesUrl: String(attributes.privacyChoicesUrl || ""),
  };
}

function normalizeAppDataUsage(row) {
  return {
    id: String(row?.id || ""),
    categoryId: String(relationshipData(row, "category")[0]?.id || ""),
    groupingId: String(relationshipData(row, "grouping")[0]?.id || ""),
    purposeId: String(relationshipData(row, "purpose")[0]?.id || ""),
    dataProtectionId: String(relationshipData(row, "dataProtection")[0]?.id || ""),
  };
}

function normalizeAppDataUsageCategory(row) {
  return {
    id: String(row?.id || ""),
    groupingId: String(relationshipData(row, "grouping")[0]?.id || ""),
    deleted: !!row?.attributes?.deleted,
  };
}

function normalizeAppDataUsageGrouping(row) {
  return {
    id: String(row?.id || ""),
    deleted: !!row?.attributes?.deleted,
  };
}

function normalizeAppDataUsagePurpose(row) {
  return {
    id: String(row?.id || ""),
    deleted: !!row?.attributes?.deleted,
  };
}

async function loadAppStoreConnectPrivacyDetail(appId) {
  const id = String(appId || "").trim();
  if (!id) throw new Error("缺少 App ID");
  const cacheKey = `privacy:${id}`;
  const cached = appStoreConnectValueCache.get(cacheKey);
  if (cached && Date.now() - Number(cached.at || 0) < APP_STORE_CONNECT_SHORT_CACHE_MS) return cached.value;
  const [
    usagesResult,
    publishStateResult,
    appInfoResult,
    categoriesResult,
    purposesResult,
    l10nResult,
  ] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v1/apps/${encodeURIComponent(id)}/dataUsages?include=category,purpose,grouping,dataProtection&limit=500`),
    appStoreConnectFetch(`/iris/v1/apps/${encodeURIComponent(id)}/dataUsagePublishState`),
    appStoreConnectFetch(`/iris/v1/apps/${encodeURIComponent(id)}/appInfos?include=appInfoLocalizations&limit[appInfoLocalizations]=50`),
    appStoreConnectFetch("/iris/v1/appDataUsageCategories?include=grouping"),
    appStoreConnectFetch("/iris/v1/appDataUsagePurposes"),
    loadAppStoreConnectL10nMap(),
  ]);
  const usagesBody = usagesResult.status === "fulfilled" ? usagesResult.value.body : {};
  const publishStateBody = publishStateResult.status === "fulfilled" ? publishStateResult.value.body : {};
  const appInfoBody = appInfoResult.status === "fulfilled" ? appInfoResult.value.body : {};
  const categoriesBody = categoriesResult.status === "fulfilled" ? categoriesResult.value.body : {};
  const purposesBody = purposesResult.status === "fulfilled" ? purposesResult.value.body : {};
  const l10n = l10nResult.status === "fulfilled" ? l10nResult.value : {};
  const appInfo = jsonApiRows(appInfoBody).map(row => normalizeAppInfo(row, appInfoBody))[0] || null;
  const value = {
    usages: jsonApiRows(usagesBody).filter(row => row?.type === "appDataUsages").map(normalizeAppDataUsage),
    categories: jsonApiRows(categoriesBody).filter(row => row?.type === "appDataUsageCategories").map(normalizeAppDataUsageCategory),
    groupings: jsonApiIncluded(categoriesBody).filter(row => row?.type === "appDataUsageGroupings").map(normalizeAppDataUsageGrouping),
    purposes: jsonApiRows(purposesBody).filter(row => row?.type === "appDataUsagePurposes").map(normalizeAppDataUsagePurpose),
    publishState: publishStateBody?.data?.attributes || {},
    appInfo,
    l10n,
  };
  appStoreConnectValueCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function appStoreLocalizedValue(l10n = {}, key, fallback = "") {
  return String(l10n?.[key]?.loc || fallback || "");
}

function appStoreCategoryLabel(l10n = {}, id = "") {
  return appStoreLocalizedValue(l10n, `ITC.AppInfo.Categories.${id}`, id);
}

async function appStoreConnectCachedValue(key, ttlMs, loader) {
  const cached = appStoreConnectValueCache.get(key);
  if (cached && Date.now() - Number(cached.at || 0) < ttlMs) return cached.value;
  const value = await loader();
  appStoreConnectValueCache.set(key, { at: Date.now(), value });
  return value;
}

function clearAppStoreConnectValueCache(prefix = "") {
  const target = String(prefix || "");
  [...appStoreConnectValueCache.keys()].forEach(key => {
    if (!target || key.startsWith(target)) appStoreConnectValueCache.delete(key);
  });
}

function normalizeAppCategory(row, body = {}, l10n = {}) {
  const attributes = row?.attributes || {};
  const subcategoryRefs = relationshipData(row, "subcategories");
  return {
    id: String(row?.id || ""),
    name: String(attributes.name || attributes.label || appStoreCategoryLabel(l10n, row?.id || "")),
    platforms: Array.isArray(attributes.platforms) ? attributes.platforms : [],
    subcategoryIds: subcategoryRefs.map(item => String(item.id || "")).filter(Boolean),
    subcategories: subcategoryRefs
      .map(ref => findIncluded(body, "appCategories", ref.id))
      .filter(Boolean)
      .map(item => ({ ...normalizeAppCategory(item, body, l10n), parentId: String(row?.id || "") })),
  };
}

function normalizeAppInfo(row, body = {}) {
  const localizationRefs = relationshipData(row, "appInfoLocalizations");
  const primaryCategoryRef = relationshipData(row, "primaryCategory")[0];
  const primarySubcategoryRef = relationshipData(row, "primarySubcategoryOne")[0];
  const secondaryCategoryRef = relationshipData(row, "secondaryCategory")[0];
  const secondarySubcategoryRef = relationshipData(row, "secondarySubcategoryOne")[0];
  const ageRatingRef = relationshipData(row, "ageRatingDeclaration")[0];
  const localizations = localizationRefs
    .map(ref => findIncluded(body, "appInfoLocalizations", ref.id))
    .filter(Boolean)
    .map(normalizeAppInfoLocalization);
  const primaryRef = primarySubcategoryRef || primaryCategoryRef;
  const secondaryRef = secondarySubcategoryRef || secondaryCategoryRef;
  const primaryCategory = primaryRef ? normalizeAppCategory(findIncluded(body, "appCategories", primaryRef.id) || { id: primaryRef.id }) : null;
  const secondaryCategory = secondaryRef ? normalizeAppCategory(findIncluded(body, "appCategories", secondaryRef.id) || { id: secondaryRef.id }) : null;
  const ageRatingDeclaration = ageRatingRef ? findIncluded(body, "ageRatingDeclarations", ageRatingRef.id) : null;
  return {
    id: String(row?.id || ""),
    attributes: row?.attributes || {},
    localizationIds: localizationRefs.map(item => String(item.id || "")).filter(Boolean),
    localizations,
    primaryCategory,
    secondaryCategory,
    ageRatingDeclarationId: String(ageRatingRef?.id || ""),
    ageRatingDeclaration: ageRatingDeclaration ? {
      id: String(ageRatingDeclaration.id || ""),
      attributes: ageRatingDeclaration.attributes || {},
    } : null,
  };
}

function appStoreAppInfoIsEditable(appInfo) {
  const state = String(appInfo?.attributes?.state || appInfo?.attributes?.appStoreState || "");
  return ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"].includes(state);
}

function selectAppStoreAppInfo(appInfos, preferredAppInfoId = "") {
  const preferred = appInfos.find(row => String(row.id || "") === preferredAppInfoId);
  // Apple can return the published record before the editable draft.
  return (appStoreAppInfoIsEditable(preferred) ? preferred : null)
    || appInfos.find(appStoreAppInfoIsEditable) || preferred || appInfos[0] || null;
}

function appStoreTerritoryName(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const preferredNames = { CHN: "中国大陆", HKG: "中国香港", MAC: "中国澳门", TWN: "中国台湾" };
  if (preferredNames[normalized]) return preferredNames[normalized];
  const isoName = isoCountries.getName(normalized, "zh", { select: "official" }) || isoCountries.getName(normalized, "zh");
  if (isoName) return isoName;
  const alpha3To2 = { USA: "US", GBR: "GB", CHN: "CN", JPN: "JP", KOR: "KR", VNM: "VN", BRA: "BR", XKX: "XK" };
  try {
    const display = new Intl.DisplayNames(["zh-CN"], { type: "region" });
    return display.of(alpha3To2[normalized] || normalized) || normalized;
  } catch {
    return normalized;
  }
}

function normalizeTerritoryAgeRatings(body = {}) {
  const included = jsonApiIncluded(body);
  const seenTerritories = new Set();
  return jsonApiRows(body).filter(row => row?.type === "territoryAgeRatings").map(row => {
    const attributes = row.attributes || {};
    const territoryRef = relationshipData(row, "territory")[0];
    const code = String(territoryRef?.id || "");
    return {
      id: String(row.id || ""),
      territoryId: code,
      territoryName: appStoreTerritoryName(code),
      appStoreAgeRating: String(attributes.appStoreAgeRating || ""),
      tag: Array.isArray(attributes.tag) ? attributes.tag : [],
      territory: included.find(item => item?.type === "territories" && String(item.id || "") === code) || null,
    };
  }).filter(item => {
    const code = String(item.territoryId || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !item.territoryName || seenTerritories.has(code)) return false;
    seenTerritories.add(code);
    return true;
  });
}

const APP_STORE_AGE_RATING_ATTRIBUTE_NAMES = new Set([
  "messagingAndChat",
  "sexualContentGraphicAndNudity",
  "gambling",
  "horrorOrFearThemes",
  "parentalControls",
  "advertising",
  "ageRatingOverrideV2",
  "violenceRealisticProlongedGraphicOrSadistic",
  "matureOrSuggestiveThemes",
  "healthOrWellnessTopics",
  "unrestrictedWebAccess",
  "violenceCartoonOrFantasy",
  "kidsAgeBand",
  "medicalOrTreatmentInformation",
  "lootBox",
  "alcoholTobaccoOrDrugUseOrReferences",
  "gamblingSimulated",
  "violenceRealistic",
  "profanityOrCrudeHumor",
  "socialMedia",
  "contests",
  "koreaAgeRatingOverride",
  "ageAssurance",
  "userGeneratedContent",
  "gunsOrOtherWeapons",
  "socialMediaAgeRestricted",
  "gracRatingClassificationNumber",
  "developerAgeRatingInfoUrl",
  "sexualContentOrNudity",
]);

function appStoreAgeRatingAttributes(attributes = {}) {
  return Object.fromEntries(Object.entries(attributes || {}).filter(([key, value]) =>
    APP_STORE_AGE_RATING_ATTRIBUTE_NAMES.has(key) && value !== undefined
  ));
}

async function loadAppStoreConnectAgeRatingAppInfo(appId, preferredAppInfoId = "", fetch = appStoreConnectFetch) {
  const appInfoResult = await fetch(
    `/iris/v1/apps/${encodeURIComponent(appId)}/appInfos?include=ageRatingDeclaration,app&fields[apps]=isOrEverWasMadeForKids`,
  );
  const rows = jsonApiRows(appInfoResult.body).filter(row => row?.type === "appInfos");
  const appInfoRow = preferredAppInfoId
    ? rows.find(row => String(row.id || "") === preferredAppInfoId)
    : selectAppStoreAppInfo(rows);
  if (!appInfoRow) throw new Error("Apple 未返回年龄分级关联的 App 信息");
  if (String(relationshipData(appInfoRow, "app")[0]?.id || "") !== appId) {
    throw new Error("年龄分级与当前 App 不匹配，请刷新后重试");
  }
  const appInfo = normalizeAppInfo(appInfoRow, appInfoResult.body);
  if (!appInfo.ageRatingDeclarationId || !appInfo.ageRatingDeclaration) {
    throw new Error("Apple 未返回年龄分级声明");
  }
  return appInfo;
}

async function loadAppStoreConnectAgeRating(appId, preferredAppInfoId = "", fetch = appStoreConnectFetch) {
  const appInfo = await loadAppStoreConnectAgeRatingAppInfo(appId, preferredAppInfoId, fetch);
  const territoryResult = await fetch(
    `/iris/v1/appInfos/${encodeURIComponent(appInfo.id)}/territoryAgeRatings?include=territory&limit=500`,
  );
  return {
    appInfo: {
      id: appInfo.id,
      attributes: appInfo.attributes,
      ageRatingDeclarationId: appInfo.ageRatingDeclarationId,
      ageRatingDeclaration: appInfo.ageRatingDeclaration,
    },
    territoryAgeRatings: normalizeTerritoryAgeRatings(territoryResult.body),
  };
}

async function saveAppStoreConnectAgeRating(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const appInfoId = String(payload.appInfoId || "").trim();
  const declarationId = String(payload.ageRatingDeclarationId || "").trim();
  const attributes = appStoreAgeRatingAttributes(payload.attributes);
  if (!appId) throw new Error("缺少 App ID");
  if (!appInfoId) throw new Error("缺少 App 信息 ID");
  if (!declarationId) throw new Error("缺少年龄分级声明 ID");
  if (!Object.keys(attributes).length) throw new Error("缺少年龄分级答案");
  const fetch = appStoreConnectMutationFetch();
  const current = await loadAppStoreConnectAgeRatingAppInfo(appId, appInfoId, fetch);
  if (current.ageRatingDeclarationId !== declarationId) {
    throw new Error("年龄分级与当前 App 信息不匹配，请刷新后重试");
  }
  if (!appStoreAppInfoIsEditable(current)) {
    throw new Error("当前 App 信息不可编辑，请重新打开 App 信息页面；若仍无法编辑，请先在 App Store Connect 创建或切换至可编辑版本");
  }
  await fetch(`/iris/v1/ageRatingDeclarations/${encodeURIComponent(declarationId)}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.api+json, application/json, text/csv",
      "Content-Type": "application/json",
      Referer: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appId)}/distribution/info`,
      "X-CSRF-ITC": "[asc-ui]",
    },
    body: JSON.stringify({ data: { type: "ageRatingDeclarations", id: declarationId, attributes } }),
  });
  let ageRating = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 450));
    ageRating = await loadAppStoreConnectAgeRating(appId, appInfoId, fetch);
    const savedAttributes = ageRating.appInfo?.ageRatingDeclaration?.attributes || {};
    const declarationMatches = ageRating.appInfo?.ageRatingDeclarationId === declarationId
      && Object.entries(attributes).every(([key, value]) => savedAttributes[key] === value);
    if (declarationMatches && ageRating.territoryAgeRatings.length) return ageRating;
  }
  throw new Error("年龄分级已提交，但暂未确认最新结果，请刷新后核对，避免重复保存");
}

async function loadAppStoreConnectL10nMap() {
  if (appStoreConnectL10nCache) return appStoreConnectL10nCache;
  const { body } = await appStoreConnectFetch("/WebObjects/iTunesConnect.woa/ra/l10n-managed?context=app-store", {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  appStoreConnectL10nCache = body?.data?.keys || {};
  return appStoreConnectL10nCache;
}

function normalizeVersionLocalization(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    locale: String(attributes.locale || ""),
    promotionalText: String(attributes.promotionalText || ""),
    description: String(attributes.description || ""),
    keywords: String(attributes.keywords || ""),
    supportUrl: String(attributes.supportUrl || ""),
    marketingUrl: String(attributes.marketingUrl || ""),
    whatsNew: String(attributes.whatsNew || ""),
    screenshotSetIds: relationshipData(row, "appScreenshotSets").map(item => String(item.id || "")).filter(Boolean),
    previewSetIds: relationshipData(row, "appPreviewSets").map(item => String(item.id || "")).filter(Boolean),
  };
}

function normalizeScreenshotSet(row, included = []) {
  const attributes = row?.attributes || {};
  const screenshotRefs = relationshipData(row, "appScreenshots");
  const screenshots = screenshotRefs.map(ref => included.find(item => item?.type === "appScreenshots" && String(item.id || "") === String(ref.id || ""))).filter(Boolean).map(item => {
    const attrs = item.attributes || {};
    const imageAsset = attrs.imageAsset || {};
    const templateUrl = String(imageAsset.templateUrl || "");
    const width = Number(imageAsset.width || 0);
    const height = Number(imageAsset.height || 0);
    const imageAssetUrl = templateUrl
      ? templateUrl.replace("{w}", String(Math.min(width || 400, 400))).replace("{h}", String(Math.min(height || 800, 800))).replace("{f}", "png")
      : String(attrs.imageAssetUrl || attrs.url || "");
    return {
      id: String(item.id || ""),
      fileName: String(attrs.fileName || ""),
      assetToken: String(attrs.assetToken || ""),
      imageAssetUrl,
      width,
      height,
      state: String(attrs.assetDeliveryState?.state || ""),
    };
  });
  return { id: String(row?.id || ""), type: String(attributes.screenshotDisplayType || attributes.appScreenshotDisplayType || ""), screenshots };
}

function normalizePreviewSet(row, included = []) {
  const attributes = row?.attributes || {};
  const previewRefs = relationshipData(row, "appPreviews");
  const previews = previewRefs.map(ref => included.find(item => item?.type === "appPreviews" && String(item.id || "") === String(ref.id || ""))).filter(Boolean).map(item => {
    const attrs = item.attributes || {};
    const previewAsset = attrs.previewAsset || attrs.videoAsset || {};
    const imageAsset = attrs.imageAsset || attrs.previewFrameImage || {};
    const templateUrl = String(imageAsset.templateUrl || previewAsset.templateUrl || "");
    const previewUrl = templateUrl
      ? templateUrl.replace("{w}", String(Math.min(Number(imageAsset.width || previewAsset.width || 400) || 400, 400))).replace("{h}", String(Math.min(Number(imageAsset.height || previewAsset.height || 800) || 800, 800))).replace("{f}", "png")
      : String(attrs.previewAssetUrl || attrs.videoUrl || attrs.url || "");
    return {
      id: String(item.id || ""),
      fileName: String(attrs.fileName || ""),
      assetToken: String(attrs.assetToken || ""),
      previewUrl,
      state: String(attrs.assetDeliveryState?.state || ""),
    };
  });
  return { id: String(row?.id || ""), type: String(attributes.previewType || attributes.appPreviewType || ""), previews };
}

function appStoreScreenshotDisplayType(device = "") {
  const value = String(device || "").toLowerCase();
  if (value === "ipad") return "APP_IPAD_PRO_3GEN_129";
  if (value === "watch") return "APP_WATCH_ULTRA";
  return "APP_IPHONE_65";
}

function appStoreMimeTypeForFile(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".zip") return "application/zip";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".mp4") return "video/mp4";
  return "application/octet-stream";
}

function uploadOperationHeaders(operation = {}, filePath = "") {
  const headers = {};
  const rows = Array.isArray(operation.requestHeaders) ? operation.requestHeaders : [];
  for (const row of rows) {
    const name = String(row?.name || row?.key || "").trim();
    if (!name) continue;
    headers[name] = String(row?.value || "");
  }
  if (!Object.keys(headers).some(name => name.toLowerCase() === "content-type")) {
    headers["Content-Type"] = appStoreMimeTypeForFile(filePath);
  }
  return headers;
}

async function uploadAppStoreOperation(operation, fileBuffer, filePath, options = {}) {
  const url = String(operation?.url || "");
  if (!/^https?:\/\//i.test(url)) throw new Error("Apple 未返回有效的上传地址");
  const offset = Number(operation.offset || 0);
  const length = Number(operation.length || (fileBuffer.length - offset));
  const end = Math.min(fileBuffer.length, offset + length);
  const body = fileBuffer.subarray(offset, end);
  const method = String(operation.method || "PUT").toUpperCase();
  const ses = options.session || activeAppStoreConnectSession() || appStoreConnectSession();
  const response = await ses.fetch(url, {
    method,
    redirect: "follow",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    headers: uploadOperationHeaders(operation, filePath),
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`文件上传失败 (${response.status})${text ? `：${text.slice(0, 160)}` : ""}`);
  }
}

function findAppStoreScreenshotSet(detail, device) {
  const displayType = appStoreScreenshotDisplayType(device);
  const sets = Array.isArray(detail?.screenshotSets) ? detail.screenshotSets : [];
  return sets.find(item => String(item.type || "") === displayType)
    || sets.find(item => {
      const type = String(item.type || "");
      if (device === "ipad") return /IPAD/i.test(type);
      if (device === "watch") return /WATCH/i.test(type);
      return /IPHONE|IOS/i.test(type) || !/IPAD|WATCH/i.test(type);
    })
    || null;
}

async function createAppStoreScreenshotSet(localizationId, device) {
  const displayType = appStoreScreenshotDisplayType(device);
  const { body } = await appStoreConnectFetch("/iris/v1/appScreenshotSets", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: displayType },
        relationships: {
          appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localizationId } },
        },
      },
    }),
  });
  return String(body?.data?.id || "");
}

function appStoreScreenshotRequirements(device = "iphone") {
  const key = String(device || "iphone").toLowerCase();
  const deviceName = key === "ipad" ? "iPad" : key === "watch" ? "Apple Watch" : "iPhone";
  const portraitSizes = key === "ipad" ? [[2064, 2752], [2048, 2732]]
    : key === "watch" ? [[410, 502]]
    : [[1290, 2796], [1242, 2688]];
  return {
    device: deviceName,
    sizes: [
      ...portraitSizes.map(([width, height]) => ({ orientation: "portrait", width, height })),
      ...portraitSizes.map(([width, height]) => ({ orientation: "landscape", width: height, height: width })),
    ],
  };
}

function appStoreScreenshotMatchesRequirements(requirements, size) {
  return requirements.sizes.some(target => size.width === target.width && size.height === target.height);
}

function appStoreScreenshotRecommendedSize(requirements, size) {
  const orientation = size.width > size.height ? "landscape" : "portrait";
  return requirements.sizes.filter(target => target.orientation === orientation)
    .reduce((best, target) => !best || Math.abs(size.width - target.width) + Math.abs(size.height - target.height)
      < Math.abs(size.width - best.width) + Math.abs(size.height - best.height) ? target : best, null);
}

function emitAppStoreScreenshotProgress(payload = {}) {
  try { certificateManagerWindow?.webContents?.send("app-store-screenshot-progress", payload); } catch {}
}

function readScreenshotSize(filePath) {
  try {
    const image = nativeImage.createFromPath(filePath);
    const size = image.getSize();
    if (size.width > 0 && size.height > 0) return size;
  } catch {}
  return { width: 0, height: 0 };
}

async function uploadAppStoreConnectScreenshot(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const localizationId = String(payload.localizationId || "").trim();
  const device = String(payload.device || "iphone").trim().toLowerCase();
  if (!appId) throw new Error("缺少 App ID");
  if (!localizationId) throw new Error("缺少本地化 ID");
  let filePaths = Array.isArray(payload.filePaths) ? payload.filePaths.map(item => String(item || "")).filter(Boolean) : [];
  if (!filePaths.length) {
    const result = await dialog.showOpenDialog(certificateManagerWindow || undefined, {
      title: "选择 App 截屏",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "tif", "tiff"] }],
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true };
    filePaths = result.filePaths;
  }
  const uploadId = crypto.randomUUID();
  emitAppStoreScreenshotProgress({ uploadId, phase: "selected", device, files: filePaths.map(filePath => ({ id: `${uploadId}:${filePath}`, name: path.basename(filePath), percent: 0, state: "pending" })) });
  const requirements = appStoreScreenshotRequirements(device);
  const resize = payload.resize && Number(payload.resize.width) > 0 && Number(payload.resize.height) > 0
    ? { width: Number(payload.resize.width), height: Number(payload.resize.height) } : null;
  if (resize && !appStoreScreenshotMatchesRequirements(requirements, resize)) {
    throw new Error("请选择支持的截屏尺寸");
  }
  const invalidFiles = filePaths.map(filePath => ({ filePath, size: readScreenshotSize(filePath) }))
    .filter(item => !appStoreScreenshotMatchesRequirements(requirements, item.size));
  if (invalidFiles.length && !resize) {
    const recommendations = invalidFiles.map(item => ({ filePath: item.filePath, ...appStoreScreenshotRecommendedSize(requirements, item.size), source: item.size }));
    emitAppStoreScreenshotProgress({ uploadId, phase: "resize-required", files: filePaths.map(filePath => ({ id: `${uploadId}:${filePath}`, name: path.basename(filePath), percent: 0, state: "resize-required" })) });
    return { needsResize: true, uploadId, files: filePaths, recommendations, requirements };
  }

  let detail = await loadAppStoreConnectAppDetail(appId);
  let screenshotSet = findAppStoreScreenshotSet(detail, device);
  let screenshotSetId = String(screenshotSet?.id || "");
  if (!screenshotSetId) screenshotSetId = await createAppStoreScreenshotSet(localizationId, device);
  if (!screenshotSetId) throw new Error("Apple 未返回截图集合 ID");

  const temporaryFiles = [];
  const uploadFiles = [];
  const filesNeedingResize = new Set(invalidFiles.map(item => item.filePath));
  try {
    for (const originalPath of filePaths) {
      let filePath = originalPath;
      if (resize && filesNeedingResize.has(originalPath)) {
        const image = nativeImage.createFromPath(originalPath);
        if (image.isEmpty()) throw new Error(`无法读取图片：${path.basename(originalPath)}`);
        const resized = image.resize({ width: resize.width, height: resize.height, quality: "best" });
        filePath = path.join(app.getPath("temp"), `mayou-app-screenshot-${uploadId}-${uploadFiles.length}.png`);
        fs.writeFileSync(filePath, resized.toPNG(), { mode: 0o600 });
        temporaryFiles.push(filePath);
      }
      uploadFiles.push(filePath);
    }
    for (let fileIndex = 0; fileIndex < uploadFiles.length; fileIndex += 1) {
    const filePath = uploadFiles[fileIndex];
    const originalPath = filePaths[fileIndex];
    const stat = fs.statSync(filePath);
    const progressId = `${uploadId}:${originalPath}`;
    emitAppStoreScreenshotProgress({ uploadId, itemId: progressId, state: "uploading", percent: 8, name: path.basename(originalPath) });
    if (!stat.isFile()) continue;
    const fileName = path.basename(filePath);
    const { body } = await appStoreConnectFetch("/iris/v1/appScreenshots", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "appScreenshots",
          attributes: {
            fileName,
            fileSize: stat.size,
          },
          relationships: {
            appScreenshotSet: { data: { type: "appScreenshotSets", id: screenshotSetId } },
          },
        },
      }),
    });
    const operations = Array.isArray(body?.data?.attributes?.uploadOperations) ? body.data.attributes.uploadOperations : [];
    if (!operations.length) throw new Error("Apple 未返回截图上传操作");
    const fileBuffer = fs.readFileSync(filePath);
    for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
      await uploadAppStoreOperation(operations[operationIndex], fileBuffer, filePath);
      emitAppStoreScreenshotProgress({ uploadId, itemId: progressId, state: "uploading", percent: Math.min(92, 12 + Math.round((operationIndex + 1) / operations.length * 72)), name: path.basename(originalPath) });
    }
    const screenshotId = String(body?.data?.id || "");
    if (!screenshotId) throw new Error("Apple 未返回截图 ID");
    await appStoreConnectFetch(`/iris/v1/appScreenshots/${encodeURIComponent(screenshotId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "appScreenshots",
          id: screenshotId,
          attributes: {
            uploaded: true,
            sourceFileChecksum: crypto.createHash("md5").update(fileBuffer).digest("hex"),
          },
        },
      }),
    });
    emitAppStoreScreenshotProgress({ uploadId, itemId: progressId, state: "uploaded", percent: 100, name: path.basename(originalPath) });
  }
  } finally {
    temporaryFiles.forEach(filePath => { try { fs.rmSync(filePath, { force: true }); } catch {} });
  }
  await new Promise(resolve => setTimeout(resolve, 900));
  detail = await loadAppStoreConnectAppDetail(appId);
  return { detail, uploaded: filePaths.length, uploadId };
}

function normalizeReviewDetail(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    contactFirstName: String(attributes.contactFirstName || ""),
    contactLastName: String(attributes.contactLastName || ""),
    contactPhone: String(attributes.contactPhone || ""),
    contactEmail: String(attributes.contactEmail || ""),
    demoAccountName: String(attributes.demoAccountName || ""),
    demoAccountPassword: String(attributes.demoAccountPassword || ""),
    demoAccountRequired: !!attributes.demoAccountRequired,
    notes: String(attributes.notes || ""),
  };
}

function normalizeBuild(row, body = {}) {
  const attributes = row?.attributes || {};
  const preReleaseRef = relationshipData(row, "preReleaseVersion")[0];
  const preReleaseVersion = preReleaseRef ? findIncluded(body, preReleaseRef.type || "preReleaseVersions", preReleaseRef.id) : null;
  const iconRefs = relationshipData(row, "icons");
  const icons = iconRefs.map(ref => findIncluded(body, ref.type || "buildIcons", ref.id)).filter(Boolean);
  const icon = icons.find(item => item?.attributes?.iconType === "APP_STORE" && item?.attributes?.masked === false) || icons.find(item => item?.attributes?.iconType === "APP_STORE") || icons[0] || null;
  const bundleRefs = relationshipData(row, "buildBundles");
  const bundles = bundleRefs.map(ref => findIncluded(body, ref.type || "buildBundles", ref.id)).filter(Boolean);
  const containsLightApp = bundles.some(item => /APP_CLIP|CLIP/i.test(String(item?.attributes?.bundleType || item?.attributes?.bundleId || "")));
  return {
    id: String(row?.id || ""),
    version: String(attributes.version || ""),
    preReleaseVersion: String(preReleaseVersion?.attributes?.version || ""),
    platform: String(preReleaseVersion?.attributes?.platform || ""),
    iconUrl: appStoreAssetURL(attributes.iconAssetToken || icon?.attributes?.iconAsset || icon?.attributes?.icon || {}, 128),
    uploadedDate: String(attributes.uploadedDate || attributes.uploadDate || ""),
    processingState: String(attributes.processingState || ""),
    usesNonExemptEncryption: attributes.usesNonExemptEncryption,
    containsLightApp,
  };
}

function normalizeVersionStateChange(row) {
  const attributes = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    state: String(attributes.appStoreState || ""),
    date: String(attributes.date || ""),
    initiator: String(attributes.initiator || ""),
  };
}

function normalizeReviewSubmissions(body) {
  const included = jsonApiIncluded(body);
  return jsonApiRows(body).map(row => {
    const attrs = row.attributes || {};
    const versionRef = relationshipData(row, "appStoreVersionForReview")[0];
    const submittedByRef = relationshipData(row, "submittedByActor")[0] || relationshipData(row, "createdByActor")[0] || relationshipData(row, "lastUpdatedByActor")[0];
    const version = versionRef ? findIncluded(body, "appStoreVersions", versionRef.id) : null;
    const actor = submittedByRef ? included.find(item => String(item.id || "") === String(submittedByRef.id || "")) : null;
    const actorAttrs = actor?.attributes || {};
    const itemCount = Number(row.relationships?.items?.meta?.paging?.total || relationshipData(row, "items").length || attrs.itemCount || 0);
    const submitter = [actorAttrs.userLastName || actorAttrs.lastName, actorAttrs.userFirstName || actorAttrs.firstName].filter(Boolean).join("") || actorAttrs.name || actorAttrs.username || actorAttrs.userEmail || actorAttrs.email || "";
    const platforms = Array.isArray(attrs.platforms) ? attrs.platforms.map(String) : [];
    return {
      id: String(row.id || ""),
      state: String(attrs.state || ""),
      submittedDate: String(attrs.submittedDate || attrs.createdDate || attrs.lastModifiedDate || ""),
      createdDate: String(attrs.createdDate || ""),
      lastUpdatedDate: String(attrs.lastUpdatedDate || attrs.lastModifiedDate || attrs.createdDate || ""),
      version: normalizeAppStoreVersion(version || {}),
      platform: String(attrs.platform || platforms[0] || ""),
      platforms,
      submitter: String(submitter || "—"),
      itemCount,
      items: [],
    };
  });
}

function appStoreReviewDate(row = {}) {
  return row.submittedDate || row.createdDate || row.lastUpdatedDate || "";
}

function normalizeReviewSubmissionActor(body = {}, ref = null) {
  if (!ref?.id) return "";
  const actor = jsonApiIncluded(body).find(item => String(item.id || "") === String(ref.id || ""));
  const attributes = actor?.attributes || {};
  if (String(actor?.id || "").toUpperCase() === "APPLE" || String(attributes.actorType || "").toUpperCase() === "APPLE") return "Apple";
  return [attributes.userLastName || attributes.lastName, attributes.userFirstName || attributes.firstName].filter(Boolean).join("")
    || attributes.name || attributes.username || attributes.userEmail || attributes.email || "";
}

function normalizeReviewSubmissionItems(body = {}) {
  return jsonApiRows(body).map(row => {
    const attrs = row.attributes || {};
    const relationshipNames = [
      "appStoreVersion", "appCustomProductPageVersion", "appEvent", "appStoreVersionExperiment",
      "backgroundAssetVersion", "gameCenterAchievementVersion", "gameCenterLeaderboardVersion",
      "gameCenterLeaderboardSetVersion", "gameCenterChallengeVersion", "gameCenterActivityVersion",
      "inAppPurchaseVersion", "subscriptionVersion", "subscriptionGroupVersion",
    ];
    const relationshipName = relationshipNames.find(name => relationshipData(row, name)[0]);
    const ref = relationshipName ? relationshipData(row, relationshipName)[0] : null;
    const included = ref ? findIncluded(body, ref.type, ref.id) : null;
    const normalizedVersion = included?.type === "appStoreVersions" ? normalizeAppStoreVersion(included) : null;
    const includedAttrs = included?.attributes || {};
    return {
      id: String(row.id || ""),
      state: String(attrs.state || ""),
      relatedState: String(includedAttrs.state || ""),
      type: String(relationshipName || "item"),
      itemType: String(ref?.type || ""),
      relatedId: String(ref?.id || ""),
      versionId: /inAppPurchase/i.test(String(relationshipName || "")) ? String(ref?.id || "") : "",
      version: normalizedVersion,
      name: String(includedAttrs.name || includedAttrs.referenceName || includedAttrs.versionString || ""),
      productId: String(includedAttrs.productId || ""),
    };
  });
}

async function enrichReviewSubmissionVersionBuilds(items = [], fetch = appStoreConnectFetch) {
  const versions = new Map();
  for (const item of items) {
    const version = item.version;
    if (!version?.id || versions.has(version.id)) continue;
    versions.set(version.id, (async () => {
      try {
        const { body } = await fetch(`/iris/v1/appStoreVersions/${encodeURIComponent(version.id)}?include=build&fields[builds]=version`, { skipSessionRefresh: true });
        const row = jsonApiRows(body)[0];
        if (row?.id !== version.id) throw new Error("Apple 未返回对应版本");
        const ref = relationshipData(row, "build")[0];
        const build = ref ? findIncluded(body, "builds", ref.id) : null;
        return { buildId: String(ref?.id || ""), buildVersion: String(build?.attributes?.version || ""), buildVersionError: ref && !build?.attributes?.version ? "构建号暂不可用" : "" };
      } catch { return { buildVersionError: "构建号暂不可用" }; }
    })());
  }
  return Promise.all(items.map(async item => item.version?.id ? { ...item, version: { ...item.version, ...await versions.get(item.version.id) } } : item));
}

async function enrichReviewSubmissionInAppPurchaseItems(items = []) {
  const rows = await Promise.all(items.map(async item => {
    if (!/inAppPurchase/i.test(`${item.type || ""} ${item.itemType || ""}`) || !item.relatedId) return item;
    try {
      const { body } = await appStoreConnectFetch(`/iris/v1/inAppPurchaseVersions/${encodeURIComponent(item.relatedId)}?include=inAppPurchase,image`, { skipSessionRefresh: true });
      const versionRow = jsonApiRows(body)[0] || {};
      const purchaseRef = relationshipData(versionRow, "inAppPurchase")[0];
      const imageRef = relationshipData(versionRow, "image")[0];
      const purchase = purchaseRef ? findIncluded(body, purchaseRef.type || "inAppPurchases", purchaseRef.id) : null;
      const image = imageRef ? findIncluded(body, imageRef.type || "appStoreReviewScreenshots", imageRef.id) || findIncluded(body, imageRef.type || "images", imageRef.id) : null;
      const purchaseAttrs = purchase?.attributes || {};
      const versionAttrs = versionRow.attributes || {};
      const imageAttrs = image?.attributes || {};
      return {
        ...item,
        purchaseId: String(purchase?.id || item.purchaseId || ""),
        versionId: String(versionRow.id || item.relatedId || ""),
        name: String(purchaseAttrs.name || purchaseAttrs.referenceName || versionAttrs.name || versionAttrs.referenceName || item.name || ""),
        productId: String(purchaseAttrs.productId || item.productId || ""),
        purchaseType: String(purchaseAttrs.inAppPurchaseType || purchaseAttrs.type || item.purchaseType || ""),
        iconUrl: String(imageAttrs.url || imageAttrs.assetUrl || imageAttrs.templateUrl || item.iconUrl || ""),
      };
    } catch {
      return item;
    }
  }));
  return rows;
}

function normalizeReviewRejectionReasons(reasons = []) {
  return (Array.isArray(reasons) ? reasons : []).map(reason => {
    const section = String(reason?.reasonSection || "").trim();
    const code = String(reason?.reasonCode || section || "").trim();
    const description = String(reason?.reasonDescription || reason?.description || "").trim();
    const text = [code, description].filter(Boolean).join(" ");
    return { reasonSection: section, reasonCode: code, reasonDescription: description, text };
  }).filter(reason => reason.text);
}

function reviewMessageGuidelineReasons(message = {}) {
  const text = String(message.body || message.content || message.text || "")
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\r\n?/g, "\n");
  const reasons = [], seen = new Set();
  for (const line of text.split("\n")) {
    // Resource links and Apple's general advice are not rejection headings.
    if (/^\s*(?:Support|Prevent Common Issues|防止常见问题|避免常见问题)\s*[:：]?\s*$/i.test(line)) break;
    const match = line.match(/^\s*Guideline\s+(\d+(?:\.\d+)+)\s*[-–—:]\s*(.+?)\s*$/i);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    reasons.push({ reasonCode: match[1], reasonDescription: match[2], text: `${match[1]} ${match[2]}` });
  }
  return reasons;
}

function latestReviewGuidelineReasons(messages = [], submission = {}) {
  const submittedAt = Date.parse(submission.submittedDate || submission.createdDate || "") || 0;
  const candidates = messages.filter(message => {
    if (message.isDeveloper || (message.author && !/^Apple$/i.test(message.author))) return false;
    const messageAt = Date.parse(message.createdDate || "") || 0;
    if (submittedAt && messageAt && messageAt < submittedAt) return false;
    const submissionMatch = String(message.body || "").match(/Submission ID:\s*([\w-]+)/i);
    return !submissionMatch || !submission.id || submissionMatch[1] === String(submission.id);
  }).sort((a, b) => (Date.parse(b.createdDate || "") || 0) - (Date.parse(a.createdDate || "") || 0));
  for (const message of candidates) {
    const reasons = reviewMessageGuidelineReasons(message);
    if (reasons.length) return { message, reasons };
  }
  return null;
}

function normalizeReviewRejectionAttachment(row = {}) {
  const attrs = row?.attributes || {};
  return {
    id: String(row?.id || ""),
    type: String(row?.type || ""),
    fileName: String(attrs.fileName || attrs.filename || attrs.name || row?.id || "附件"),
    fileSize: Number(attrs.fileSize || attrs.size || 0) || 0,
    downloadUrl: String(attrs.downloadUrl || attrs.url || attrs.assetUrl || ""),
  };
}

function normalizeReviewRejection(row = {}, body = {}) {
  const relationshipNames = [
    "appStoreVersion", "appCustomProductPageVersion", "appEvent", "appStoreVersionExperiment",
    "backgroundAssetVersion", "backgroundAssetVersions", "gameCenterAchievementVersion", "gameCenterAchievementVersions",
    "gameCenterLeaderboardVersion", "gameCenterLeaderboardVersions", "gameCenterLeaderboardSetVersion", "gameCenterLeaderboardSetVersions",
    "gameCenterChallengeVersion", "gameCenterChallengeVersions", "gameCenterActivityVersion", "gameCenterActivityVersions",
    "inAppPurchaseVersion", "inAppPurchaseVersions", "subscriptionVersion", "subscriptionVersions",
    "subscriptionGroupVersion", "subscriptionGroupVersions", "build", "appBundleVersion",
  ];
  const refs = relationshipNames.flatMap(name => relationshipData(row, name)).filter(ref => ref?.id);
  const appVersionRef = relationshipData(row, "appStoreVersion")[0];
  const appVersion = appVersionRef ? findIncluded(body, appVersionRef.type || "appStoreVersions", appVersionRef.id) : null;
  const attachmentRefs = [
    ...relationshipData(row, "rejectionAttachments"),
    ...relationshipData(row, "resolutionCenterMessageAttachments"),
    ...relationshipData(row, "attachments"),
  ];
  const attachments = attachmentRefs.map(ref => findIncluded(body, ref.type || "resolutionCenterMessageAttachments", ref.id))
    .filter(Boolean)
    .map(normalizeReviewRejectionAttachment)
    .filter(item => item.id || item.fileName || item.downloadUrl);
  const reasons = normalizeReviewRejectionReasons(row?.attributes?.reasons);
  return {
    id: String(row?.id || ""),
    reasons,
    reasonText: reasons.map(reason => reason.text).filter(Boolean).join("；"),
    relatedIds: [...new Set(refs.map(ref => String(ref.id || "")).filter(Boolean))],
    version: appVersion ? normalizeAppStoreVersion(appVersion) : null,
    attachments,
  };
}

async function loadReviewRejectionsForThreads(threads = []) {
  const threadIds = [...new Set((Array.isArray(threads) ? threads : [])
    .map(thread => String(thread?.id || "").trim())
    .filter(id => id && !id.startsWith("direct-")))];
  if (!threadIds.length) return [];
  const include = "appCustomProductPageVersion,appEvent,appStoreVersion,appStoreVersionExperiment,backgroundAssetVersions,gameCenterAchievementVersions,gameCenterLeaderboardVersions,gameCenterLeaderboardSetVersions,gameCenterChallengeVersions,gameCenterActivityVersions,inAppPurchaseVersions,subscriptionVersions,subscriptionGroupVersions,build,appBundleVersion,rejectionAttachments";
  const batches = await Promise.all(threadIds.map(async threadId => {
    try {
      const { body } = await appStoreConnectFetch(`/iris/v1/reviewRejections?filter[resolutionCenterMessage.resolutionCenterThread]=${encodeURIComponent(threadId)}&include=${include}&limit=2000&limit[rejectionAttachments]=1000`, { skipSessionRefresh: true });
      return jsonApiRows(body).map(row => normalizeReviewRejection(row, body));
    } catch {
      return [];
    }
  }));
  const seen = new Set();
  return batches.flat().filter(rejection => {
    const key = rejection.id || [rejection.reasonText, rejection.relatedIds.join(","), rejection.attachments.map(item => item.id).join(",")].join("|");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadAppStoreVersionReviewWarning(appId, versionId, reviewSubmissions = []) {
  const app = encodeURIComponent(String(appId || "").trim());
  const version = encodeURIComponent(String(versionId || "").trim());
  if (!app || !version) return null;
  const matchingSubmission = (Array.isArray(reviewSubmissions) ? reviewSubmissions : []).find(item =>
    String(item?.version?.id || "") === String(versionId || "")
    || (item?.items || []).some(row => String(row?.version?.id || row?.relatedId || "") === String(versionId || ""))
  ) || null;
  const matchingItem = (matchingSubmission?.items || []).find(item =>
    String(item?.version?.id || item?.relatedId || "") === String(versionId || "")
  );
  const itemState = String(matchingItem?.state || matchingItem?.relatedState || "");
  const rejected = !!matchingItem && /REJECT|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/i.test(itemState);
  if (!rejected) return null;
  let threads = await loadReviewSubmissionThreads(matchingSubmission.id);
  const submissionScoped = threads.length > 0;
  if (!threads.length) try {
    const { body } = await appStoreConnectFetch(`/iris/v1/apps/${app}/resolutionCenterThreads?include=appStoreVersions,app,appMessageThreadDetail,build,betaBackgroundAssetReviewSubmission&limit[appStoreVersions]=2000&filter[threadType]=REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL&filter[appStoreVersion]=${version}`, { skipSessionRefresh: true });
    threads = jsonApiRows(body).map(row => normalizeReviewThread(row, body)).filter(item => item.id);
  } catch {}
  // A version can have many historical rejection threads. Scope the warning to
  // the current submission, then the newest rejection thread, instead of unioning history.
  const submittedAt = Date.parse(matchingSubmission?.submittedDate || matchingSubmission?.createdDate || "") || 0;
  threads = threads.filter(thread => {
    if (thread.submissionId && thread.submissionId !== String(matchingSubmission.id)) return false;
    const updatedAt = Date.parse(thread.lastUpdatedDate || thread.createdDate || "") || 0;
    return submissionScoped || !submittedAt || !updatedAt || updatedAt >= submittedAt;
  });
  const rejectionThreads = threads.filter(thread => /^REJECTION/i.test(thread.threadType || ""));
  const threadDate = thread => Math.max(
    Date.parse(thread.lastUpdatedDate || thread.createdDate || "") || 0,
    ...(thread.messages || []).map(message => Date.parse(message.createdDate || "") || 0)
  );
  threads = (rejectionThreads.length ? rejectionThreads : threads).sort((a, b) => threadDate(b) - threadDate(a)).slice(0, 1);
  const thread = threads[0];
  const messages = thread ? (thread.messages?.length ? thread.messages : String(thread.id).startsWith("direct-") ? [] : await loadResolutionCenterThreadMessages(thread.id)) : [];
  const messageSummary = latestReviewGuidelineReasons(messages, matchingSubmission);
  const rejections = messageSummary ? [] : await loadReviewRejectionsForThreads(threads);
  const reasons = [];
  const attachments = [];
  const reasonSeen = new Set();
  const attachmentSeen = new Set();
  // Without a readable message, only a single scoped rejection is unambiguous.
  (rejections.length === 1 ? rejections : []).forEach(rejection => {
    if (rejection.relatedIds?.length && !rejection.relatedIds.includes(String(versionId))) return;
    (rejection.reasons || []).forEach(reason => {
      const key = reason.text || `${reason.reasonCode || ""} ${reason.reasonDescription || ""}`.trim();
      if (!key || reasonSeen.has(key)) return;
      reasonSeen.add(key);
      reasons.push(reason);
    });
    (rejection.attachments || []).forEach(attachment => {
      const key = attachment.id || attachment.downloadUrl || attachment.fileName;
      if (!key || attachmentSeen.has(key)) return;
      attachmentSeen.add(key);
      attachments.push(attachment);
    });
  });
  return {
    isRejected: rejected,
    submissionId: String(matchingSubmission?.id || ""),
    itemId: String(matchingItem?.id || ""),
    threadIds: threads.map(item => String(item.id || "")).filter(Boolean),
    reasons: messageSummary?.reasons || reasons,
    attachments,
    rejections,
  };
}

function reviewRejectionMatchesItem(rejection = {}, item = {}) {
  const itemIds = new Set([
    item.id,
    item.relatedId,
    item.versionId,
    item.purchaseId,
    item.version?.id,
  ].map(value => String(value || "")).filter(Boolean));
  return (rejection.relatedIds || []).some(id => itemIds.has(String(id || "")));
}

function applyReviewRejectionsToItems(items = [], rejections = []) {
  const sourceItems = Array.isArray(items) ? items : [];
  const sourceRejections = Array.isArray(rejections) ? rejections.filter(item => item?.id || item?.reasonText || item?.attachments?.length) : [];
  const rows = sourceItems.length ? sourceItems.map(item => ({ ...item })) : sourceRejections.map(rejection => ({
    id: rejection.id ? `rejection-${rejection.id}` : "",
    state: rejection.version?.state || "REJECTED",
    relatedState: rejection.version?.state || "REJECTED",
    type: "appStoreVersion",
    itemType: "appStoreVersions",
    relatedId: rejection.version?.id || "",
    version: rejection.version || null,
    name: rejection.version?.versionString || "",
  }));
  for (const rejection of sourceRejections) {
    let targets = rows.filter(item => reviewRejectionMatchesItem(rejection, item));
    if (!targets.length && rejection.version?.id) targets = rows.filter(item => item.version || /appStoreVersion/i.test(`${item.type || ""} ${item.itemType || ""}`));
    if (!targets.length && rows.length === 1) targets = rows;
    for (const item of targets) {
      if (!item.version && rejection.version) item.version = rejection.version;
      if (!item.relatedId && rejection.version?.id) item.relatedId = rejection.version.id;
      if (!item.relatedState && rejection.version?.state) item.relatedState = rejection.version.state;
      const reasons = [...(Array.isArray(item.rejectionReasons) ? item.rejectionReasons : []), ...(rejection.reasons || [])];
      const reasonSeen = new Set();
      item.rejectionReasons = reasons.filter(reason => {
        const key = reason.text || `${reason.reasonCode || ""} ${reason.reasonDescription || ""}`.trim();
        if (!key || reasonSeen.has(key)) return false;
        reasonSeen.add(key);
        return true;
      });
      item.rejectionReason = item.rejectionReasons.map(reason => reason.text).filter(Boolean).join("；");
      const attachments = [...(Array.isArray(item.rejectionAttachments) ? item.rejectionAttachments : []), ...(rejection.attachments || [])];
      const attachmentSeen = new Set();
      item.rejectionAttachments = attachments.filter(attachment => {
        const key = attachment.id || attachment.downloadUrl || attachment.fileName;
        if (!key || attachmentSeen.has(key)) return false;
        attachmentSeen.add(key);
        return true;
      });
    }
  }
  return rows;
}

function reviewMessageText(attributes = {}) {
  const candidates = [
    attributes.messageBody,
    attributes.message,
    attributes.body,
    attributes.content,
    attributes.text,
    attributes.messageText,
    attributes.plainText,
    attributes.markdown,
  ];
  const rich = candidates.find(value => String(value || "").trim());
  if (rich) return String(rich);
  if (Array.isArray(attributes.sections)) {
    return attributes.sections.map(section => {
      if (typeof section === "string") return section;
      if (!section || typeof section !== "object") return "";
      return [section.title, section.body, section.content, section.text].filter(Boolean).join("\n\n");
    }).filter(Boolean).join("\n\n");
  }
  return "";
}

function normalizeReviewMessageActor(body = {}, ref = null) {
  if (!ref?.id) return "";
  const actor = findIncluded(body, ref.type || "actors", ref.id) || findIncluded(body, "actors", ref.id) || findIncluded(body, "users", ref.id);
  const attrs = actor?.attributes || {};
  const actorType = String(attrs.actorType || "");
  if (actorType === "APPLE" || String(actor?.id || "").toUpperCase() === "APPLE") return "Apple";
  const userName = [attrs.userLastName, attrs.userFirstName].filter(Boolean).join("");
  return String(attrs.name || attrs.fullName || attrs.displayName || userName || attrs.username || attrs.email || attrs.userName || "");
}

function normalizeReviewThreadMessages(body = {}) {
  return jsonApiRows(body).map(row => {
    const attrs = row.attributes || {};
    const actorRef = relationshipData(row, "actor")[0] || relationshipData(row, "author")[0] || relationshipData(row, "createdByActor")[0] || relationshipData(row, "fromActor")[0];
    const rejectionRef = relationshipData(row, "rejections")[0];
    const rejection = rejectionRef ? findIncluded(body, rejectionRef.type || "reviewRejections", rejectionRef.id) : null;
    const reasons = Array.isArray(rejection?.attributes?.reasons) ? rejection.attributes.reasons : [];
    const messageBody = reviewMessageText(attrs);
    const bodyReasons = reviewMessageGuidelineReasons({ body: messageBody });
    const reasonText = (bodyReasons.length ? bodyReasons : reasons).map(reason => {
      const code = String(reason.reasonCode || "").trim();
      const description = String(reason.reasonDescription || "").trim();
      return [code, description].filter(Boolean).join(" ");
    }).filter(Boolean).join("；");
    return {
      id: String(row.id || ""),
      threadId: String(relationshipData(row, "resolutionCenterThread")[0]?.id || ""),
      author: normalizeReviewMessageActor(body, actorRef) || String(attrs.sender || attrs.author || attrs.createdBy || attrs.from || ""),
      isDeveloper: String(actorRef?.id || "").toUpperCase() !== "APPLE" && String(findIncluded(body, actorRef?.type || "actors", actorRef?.id)?.attributes?.actorType || "").toUpperCase() === "DEVELOPER",
      createdDate: String(attrs.createdDate || attrs.creationDate || attrs.date || attrs.sentDate || attrs.lastModifiedDate || ""),
      subject: String(attrs.subject || attrs.title || ""),
      body: messageBody,
      issueDescription: String(attrs.issueDescription || ""),
      nextSteps: String(attrs.nextSteps || ""),
      guideline: String(bodyReasons.length ? reasonText : attrs.guideline || attrs.issueCategory || attrs.issueType || reasonText),
      rejectionReason: String(bodyReasons.length ? reasonText : attrs.rejectionReason || attrs.reason || reasonText),
      attributes: attrs,
    };
  });
}

function reviewMessageLooksReadable(message = {}) {
  return !![
    message.body,
    message.issueDescription,
    message.nextSteps,
    message.guideline,
    message.rejectionReason,
    message.subject,
  ].some(value => String(value || "").trim());
}

function normalizeReviewMessagesFromBody(body = {}) {
  const rows = [...jsonApiRows(body), ...jsonApiIncluded(body)].filter(row => {
    const type = String(row?.type || "");
    if (/resolutionCenterMessages|reviewMessages/i.test(type)) return true;
    if (!/messages?/i.test(type)) return false;
    const attrs = row?.attributes || {};
    return !!(attrs.messageBody || attrs.message || attrs.body || attrs.content || attrs.text || attrs.issueDescription || attrs.nextSteps);
  });
  const seen = new Set();
  return normalizeReviewThreadMessages({ data: rows, included: jsonApiIncluded(body) })
    .filter(message => message.id || reviewMessageLooksReadable(message))
    .filter(message => {
      const key = message.id || [message.createdDate, message.author, message.body, message.guideline, message.rejectionReason].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeReviewThread(row = {}, body = {}) {
  const attrs = row.attributes || {};
  const messages = normalizeReviewThreadMessages({
    data: [
      ...relationshipData(row, "resolutionCenterMessages"),
      ...relationshipData(row, "messages"),
    ]
      .map(ref => findIncluded(body, ref.type || "resolutionCenterMessages", ref.id))
      .filter(Boolean),
    included: jsonApiIncluded(body),
  });
  return {
    id: String(row.id || ""),
    state: String(attrs.state || ""),
    subject: String(attrs.subject || attrs.title || ""),
    threadType: String(attrs.threadType || ""),
    submissionId: String(relationshipData(row, "reviewSubmission")[0]?.id || ""),
    createdDate: String(attrs.createdDate || ""),
    lastUpdatedDate: String(attrs.lastMessageResponseDate || attrs.lastUpdatedDate || attrs.modifiedDate || ""),
    messages,
  };
}

function reviewThreadRefsFromBody(body = {}) {
  const refs = [];
  for (const row of jsonApiRows(body)) {
    for (const relationshipName of ["resolutionCenterThread", "resolutionCenterThreads", "thread", "threads"]) {
      refs.push(...relationshipData(row, relationshipName));
    }
  }
  for (const item of jsonApiIncluded(body)) {
    if (item?.type === "resolutionCenterThreads") refs.push({ type: item.type, id: item.id });
    for (const relationshipName of ["resolutionCenterThread", "resolutionCenterThreads"]) {
      refs.push(...relationshipData(item, relationshipName));
    }
  }
  const seen = new Set();
  return refs.filter(ref => {
    const id = String(ref?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function loadResolutionCenterThreadMessages(threadId) {
  const id = encodeURIComponent(String(threadId || ""));
  if (!id) return [];
  const candidates = [
    `/iris/v1/resolutionCenterThreads/${id}/resolutionCenterMessages?include=fromActor,rejections,resolutionCenterMessageAttachments&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/resolutionCenterThreads/${id}/messages?include=actor,author,createdByActor,fromActor,attachments&limit=100`,
    `/iris/v1/resolutionCenterMessages?filter[thread]=${id}&include=actor,author,createdByActor,fromActor,attachments&limit=100`,
    `/iris/v1/resolutionCenterMessages?filter[resolutionCenterThread]=${id}&include=actor,author,createdByActor,fromActor,attachments&limit=100`,
  ];
  for (const requestPath of candidates) {
    try {
      const { body } = await appStoreConnectFetch(requestPath, { skipSessionRefresh: true });
      const messages = normalizeReviewThreadMessages(body);
      if (messages.length) return messages;
    } catch {}
  }
  return [];
}

function normalizeResolutionCenterMessageAttachment(row = {}) {
  const attrs = row.attributes || {};
  const delivery = attrs.assetDeliveryState || {};
  return {
    id: String(row.id || ""),
    fileName: String(attrs.fileName || attrs.filename || attrs.name || row.id || "附件"),
    fileSize: Number(attrs.fileSize || attrs.size || 0) || 0,
    downloadUrl: String(attrs.downloadUrl || attrs.url || attrs.assetUrl || ""),
    state: String(delivery.state || ""),
    errors: Array.isArray(delivery.errors) ? delivery.errors : [],
  };
}

function normalizeResolutionCenterDraftMessage(body = {}) {
  const row = jsonApiRows(body)[0] || {};
  const attrs = row.attributes || {};
  const threadRef = relationshipData(row, "resolutionCenterThread")[0];
  const actorRef = relationshipData(row, "fromActor")[0];
  const attachmentRefs = [
    ...relationshipData(row, "resolutionCenterMessageAttachments"),
    ...relationshipData(row, "attachments"),
  ];
  const attachments = attachmentRefs.map(ref => {
    const item = findIncluded(body, ref.type || "resolutionCenterMessageAttachments", ref.id) || {};
    return normalizeResolutionCenterMessageAttachment({ ...item, id: item.id || ref.id });
  }).filter(item => item.id || item.fileName);
  return {
    id: String(row.id || ""),
    threadId: String(threadRef?.id || ""),
    author: normalizeReviewMessageActor(body, actorRef),
    messageBody: String(attrs.messageBody || attrs.body || attrs.message || attrs.content || ""),
    createdDate: String(attrs.createdDate || attrs.creationDate || ""),
    lastUpdatedDate: String(attrs.lastUpdatedDate || attrs.modifiedDate || ""),
    attachments,
  };
}

async function loadResolutionCenterDraftMessage(threadId) {
  const id = encodeURIComponent(String(threadId || ""));
  if (!id) return null;
  const { body } = await appStoreConnectFetch(`/iris/v1/resolutionCenterThreads/${id}/resolutionCenterDraftMessage?include=resolutionCenterMessageAttachments,fromActor&limit[resolutionCenterMessageAttachments]=1000`, { skipSessionRefresh: true });
  const draft = normalizeResolutionCenterDraftMessage(body);
  return draft.id ? draft : null;
}

async function createResolutionCenterDraftMessage(threadId, messageBody) {
  const thread = String(threadId || "").trim();
  if (!thread) throw new Error("缺少审核消息线程");
  const { body } = await appStoreConnectFetch("/iris/v1/resolutionCenterDraftMessages", {
    method: "POST",
    body: JSON.stringify({ data: {
      type: "resolutionCenterDraftMessages",
      attributes: { messageBody: String(messageBody || "") },
      relationships: { resolutionCenterThread: { data: { type: "resolutionCenterThreads", id: thread } } },
    } }),
  });
  return normalizeResolutionCenterDraftMessage(body);
}

async function updateResolutionCenterDraftMessage(draftId, messageBody) {
  const id = String(draftId || "").trim();
  if (!id) throw new Error("缺少审核回复草稿 ID");
  const { body } = await appStoreConnectFetch(`/iris/v1/resolutionCenterDraftMessages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "resolutionCenterDraftMessages", id, attributes: { messageBody: String(messageBody || "") } } }),
  });
  return normalizeResolutionCenterDraftMessage(body);
}

async function deleteResolutionCenterMessageAttachments(attachmentIds = []) {
  const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : [attachmentIds]).map(value => String(value || "").trim()).filter(Boolean))];
  for (const id of ids) {
    try {
      await appStoreConnectFetch(`/iris/v1/resolutionCenterMessageAttachments/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (Number(error?.status || 0) !== 404) throw error;
    }
  }
  return ids;
}

async function waitForResolutionCenterMessageAttachment(attachmentId) {
  const id = String(attachmentId || "").trim();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { body } = await appStoreConnectFetch(`/iris/v1/resolutionCenterMessageAttachments/${encodeURIComponent(id)}`, { skipSessionRefresh: true });
    const attachment = normalizeResolutionCenterMessageAttachment(jsonApiRows(body)[0] || {});
    const state = String(attachment.state || "").toUpperCase();
    if (state === "COMPLETE") return attachment;
    if (/FAIL|ERROR|INVALID|REJECT/.test(state)) {
      const message = attachment.errors.map(item => item?.description || item?.message || item?.code).filter(Boolean).join("；");
      throw new Error(message || `附件 ${attachment.fileName || id} 处理失败`);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error("Apple 附件处理超时，请稍后重试");
}

async function uploadResolutionCenterMessageAttachments(payload = {}) {
  const threadId = String(payload.threadId || "").trim();
  if (!threadId) throw new Error("缺少审核消息线程");
  const selected = await dialog.showOpenDialog(certificateManagerWindow || undefined, {
    title: "选择审核回复附件",
    properties: ["openFile", "multiSelections"],
  });
  if (selected.canceled || !selected.filePaths?.length) return { canceled: true };

  let draftId = String(payload.draftId || "").trim();
  let createdDraft = false;
  if (!draftId) {
    const created = await createResolutionCenterDraftMessage(threadId, String(payload.messageBody || "") || " ");
    draftId = String(created.id || "");
    createdDraft = true;
  }
  if (!draftId) throw new Error("Apple 未返回审核回复草稿 ID");

  const uploadedAttachmentIds = [];
  const createdAttachmentIds = [];
  try {
    for (const filePath of selected.filePaths) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const { body } = await appStoreConnectFetch("/iris/v1/resolutionCenterMessageAttachments", {
        method: "POST",
        body: JSON.stringify({ data: {
          type: "resolutionCenterMessageAttachments",
          attributes: { fileName, fileSize: stat.size },
          relationships: {
            resolutionCenterDraftMessage: { data: { type: "resolutionCenterDraftMessages", id: draftId } },
          },
        } }),
      });
      const attachmentId = String(body?.data?.id || "");
      const operations = Array.isArray(body?.data?.attributes?.uploadOperations) ? body.data.attributes.uploadOperations : [];
      if (!attachmentId || !operations.length) throw new Error("Apple 未返回附件上传信息");
      createdAttachmentIds.push(attachmentId);
      for (const operation of operations) await uploadAppStoreOperation(operation, fileBuffer, filePath);
      await appStoreConnectFetch(`/iris/v1/resolutionCenterMessageAttachments/${encodeURIComponent(attachmentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: {
          type: "resolutionCenterMessageAttachments",
          id: attachmentId,
          attributes: {
            uploaded: true,
            sourceFileChecksum: crypto.createHash("md5").update(fileBuffer).digest("hex"),
          },
        } }),
      });
      await waitForResolutionCenterMessageAttachment(attachmentId);
      uploadedAttachmentIds.push(attachmentId);
    }
    const draft = await loadResolutionCenterDraftMessage(threadId);
    return { draft, draftId, createdDraft, uploadedAttachmentIds, uploaded: uploadedAttachmentIds.length };
  } catch (error) {
    if (createdDraft) await deleteResolutionCenterDraftMessage(draftId).catch(() => {});
    else await deleteResolutionCenterMessageAttachments(createdAttachmentIds).catch(() => {});
    throw error;
  }
}

async function deleteResolutionCenterDraftMessage(draftId) {
  const id = String(draftId || "").trim();
  if (!id) throw new Error("缺少审核回复草稿 ID");
  await appStoreConnectFetch(`/iris/v1/resolutionCenterDraftMessages/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { id };
}

async function sendResolutionCenterDraftMessage(draftId) {
  const id = String(draftId || "").trim();
  if (!id) throw new Error("缺少审核回复草稿 ID");
  const { body } = await appStoreConnectFetch("/iris/v1/resolutionCenterMessages", {
    method: "POST",
    body: JSON.stringify({ data: {
      type: "resolutionCenterMessages",
      relationships: { createFromDraftMessage: { data: { type: "resolutionCenterDraftMessages", id } } },
    } }),
  });
  return body;
}

async function loadReviewSubmissionThreads(submissionId, submissionBody = {}) {
  const encodedSubmissionId = encodeURIComponent(String(submissionId || ""));
  const threadMap = new Map();
  const addThread = (thread, body = {}) => {
    if (!thread?.id || thread.type !== "resolutionCenterThreads") return;
    threadMap.set(String(thread.id), normalizeReviewThread(thread, body));
  };

  for (const ref of reviewThreadRefsFromBody(submissionBody)) {
    const included = findIncluded(submissionBody, ref.type || "resolutionCenterThreads", ref.id);
    if (included) addThread(included, submissionBody);
    else addThread({ id: ref.id, type: ref.type || "resolutionCenterThreads", attributes: {} }, {});
  }

  const candidates = [
    `/iris/v1/reviewSubmissions/${encodedSubmissionId}/resolutionCenterThreads?include=resolutionCenterMessages,fromActor,rejections,resolutionCenterMessageAttachments&limit[resolutionCenterMessages]=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/reviewSubmissions/${encodedSubmissionId}/resolutionCenterMessages?include=fromActor,rejections,resolutionCenterMessageAttachments&limit=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/reviewSubmissions/${encodedSubmissionId}/messages?include=actor,author,createdByActor,fromActor,attachments&limit=100`,
    `/iris/v1/resolutionCenterMessages?filter[reviewSubmission]=${encodedSubmissionId}&include=fromActor,actor,author,createdByActor,rejections,resolutionCenterMessageAttachments&limit=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/resolutionCenterMessages?filter[reviewSubmissions]=${encodedSubmissionId}&include=fromActor,actor,author,createdByActor,rejections,resolutionCenterMessageAttachments&limit=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/resolutionCenterThreads?filter[reviewSubmission]=${encodedSubmissionId}&include=reviewSubmission,resolutionCenterMessages,fromActor,rejections,resolutionCenterMessageAttachments&limit[resolutionCenterMessages]=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
    `/iris/v1/resolutionCenterThreads?filter[reviewSubmission]=${encodedSubmissionId}&include=reviewSubmission`,
    `/iris/v1/resolutionCenterThreads?filter[reviewSubmissions]=${encodedSubmissionId}&include=reviewSubmission,resolutionCenterMessages,fromActor,rejections,resolutionCenterMessageAttachments&limit[resolutionCenterMessages]=100&limit[rejections]=2000&limit[resolutionCenterMessageAttachments]=1000`,
  ];
  for (const requestPath of candidates) {
    try {
      const { body } = await appStoreConnectFetch(requestPath, { skipSessionRefresh: true });
      const directMessages = normalizeReviewMessagesFromBody(body);
      if (directMessages.length) {
        const directThreadId = `direct-${submissionId}`;
        threadMap.set(directThreadId, {
          id: directThreadId,
          state: "",
          subject: directMessages[0]?.subject || "",
          threadType: "direct",
          createdDate: directMessages[0]?.createdDate || "",
          lastUpdatedDate: directMessages.at(-1)?.createdDate || "",
          messages: directMessages.map(message => ({ ...message, threadId: message.threadId || directThreadId })),
        });
      }
      jsonApiRows(body).forEach(row => addThread(row, body));
      // These endpoints are compatibility fallbacks, not sources to merge.
      // Once this submission's threads or messages are available, stop probing.
      if (threadMap.size) return Array.from(threadMap.values());
    } catch {}
  }
  return Array.from(threadMap.values());
}

async function loadAppStoreConnectReviewSubmissionDetail(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const submissionId = String(payload.submissionId || payload.id || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!submissionId) throw new Error("缺少审核提交 ID");
  const encodedSubmissionId = encodeURIComponent(submissionId);
  const [submissionResult, itemsResult] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodedSubmissionId}?include=appStoreVersionForReview,items,lastUpdatedByActor,submittedByActor,createdByActor&limit[items]=0`),
    appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodedSubmissionId}/items?include=appCustomProductPageVersion,appEvent,appStoreVersion,appStoreVersionExperiment,backgroundAssetVersion,gameCenterAchievementVersion,gameCenterLeaderboardVersion,gameCenterLeaderboardSetVersion,gameCenterChallengeVersion,gameCenterActivityVersion,inAppPurchaseVersion,subscriptionVersion,subscriptionGroupVersion&limit=200`),
  ]);
  if (submissionResult.status !== "fulfilled") throw submissionResult.reason;
  const submissionBody = submissionResult.value.body || {};
  const base = normalizeReviewSubmissions(submissionBody)[0] || {};
  const row = jsonApiRows(submissionBody)[0] || {};
  const attrs = row.attributes || {};
  const lastUpdatedByRef = relationshipData(row, "lastUpdatedByActor")[0];
  const submittedByRef = relationshipData(row, "submittedByActor")[0] || relationshipData(row, "createdByActor")[0];
  const itemsBody = itemsResult.status === "fulfilled" ? itemsResult.value.body : {};
  let items = await enrichReviewSubmissionVersionBuilds(await enrichReviewSubmissionInAppPurchaseItems(normalizeReviewSubmissionItems(itemsBody)));
  const threads = await loadReviewSubmissionThreads(submissionId, submissionBody);
  const replyThread = [...threads].reverse().find(thread => thread.id && !String(thread.id).startsWith("direct-") && /REJECTION|APP_MESSAGE/i.test(String(thread.threadType || "")))
    || [...threads].reverse().find(thread => thread.id && !String(thread.id).startsWith("direct-"))
    || null;
  let draftMessage = null;
  if (replyThread?.id) {
    try { draftMessage = await loadResolutionCenterDraftMessage(replyThread.id); } catch {}
  }
  const rejections = await loadReviewRejectionsForThreads(threads);
  items = applyReviewRejectionsToItems(items, rejections);
  const loadedMessages = await Promise.all(threads.map(thread => thread.messages.length ? Promise.resolve(thread.messages) : loadResolutionCenterThreadMessages(thread.id)));
  const messages = threads.flatMap((thread, index) => (loadedMessages[index] || []).map(message => ({
    ...message,
    threadId: thread.id,
    threadType: thread.threadType,
    state: thread.state,
    subject: message.subject || thread.subject,
  }))).sort((a, b) => new Date(a.createdDate || 0) - new Date(b.createdDate || 0));
  return {
    ...base,
    id: submissionId,
    state: String(attrs.state || base.state || ""),
    submittedDate: String(attrs.submittedDate || base.submittedDate || attrs.createdDate || ""),
    createdDate: String(attrs.createdDate || base.createdDate || ""),
    lastUpdatedDate: String(attrs.lastUpdatedDate || base.lastUpdatedDate || ""),
    platform: String(attrs.platform || base.platform || ""),
    platforms: Array.isArray(attrs.platforms) ? attrs.platforms.map(String) : base.platforms || [],
    submittedBy: normalizeReviewSubmissionActor(submissionBody, submittedByRef) || base.submitter || "—",
    lastUpdatedBy: normalizeReviewSubmissionActor(submissionBody, lastUpdatedByRef) || "—",
    itemCount: items.length || Number(base.itemCount || 0),
    items,
    messages,
    threadId: String(replyThread?.id || ""),
    threads: threads.map(thread => ({ id: String(thread.id || ""), threadType: String(thread.threadType || ""), state: String(thread.state || "") })).filter(thread => thread.id),
    draftMessage,
    reviewRejections: rejections,
  };
}

function normalizeAppStorePricing(manualBody = {}, baseTerritoryBody = {}, automaticBody = null) {
  const rows = jsonApiRows(manualBody);
  const included = jsonApiIncluded(manualBody);
  const today = new Date().toISOString().slice(0, 10);
  const current = rows.find(row => {
    const attrs = row?.attributes || {};
    return (!attrs.startDate || String(attrs.startDate).slice(0, 10) <= today)
      && (!attrs.endDate || String(attrs.endDate).slice(0, 10) >= today);
  }) || rows[0] || null;
  const pricePointRef = current ? relationshipData(current, "appPricePoint")[0] : null;
  const territoryRef = current ? relationshipData(current, "territory")[0] : null;
  const pricePoint = pricePointRef ? findIncluded(manualBody, "appPricePoints", pricePointRef.id) : null;
  const baseRow = jsonApiRows(baseTerritoryBody)[0] || null;
  const territoryId = String(baseRow?.id || territoryRef?.id || "");
  const territory = included.find(item => item?.type === "territories" && String(item.id || "") === territoryId);
  const currentPrices = new Map();
  const addCurrentPrices = (body, fallbackTerritoryId = "") => {
    const activeRows = jsonApiRows(body).filter(row => {
      const attrs = row?.attributes || {};
      return (!attrs.endDate || String(attrs.endDate).slice(0, 10) >= today)
        && (!attrs.startDate || String(attrs.startDate).slice(0, 10) <= today);
    }).sort((a, b) => String(a?.attributes?.startDate || "").localeCompare(String(b?.attributes?.startDate || "")));
    activeRows.forEach(row => {
      const pointRef = relationshipData(row, "appPricePoint")[0];
      const territoryRef = relationshipData(row, "territory")[0];
      const id = String(territoryRef?.id || fallbackTerritoryId || "");
      if (!id) return;
      const point = pointRef ? findIncluded(body, "appPricePoints", pointRef.id) : null;
      const territoryRow = findIncluded(body, "territories", id);
      currentPrices.set(id, {
        territoryId: id,
        territoryName: appStoreTerritoryName(id),
        currency: String(territoryRow?.attributes?.currency || (id === territoryId ? territory?.attributes?.currency || baseRow?.attributes?.currency : "") || ""),
        price: point?.attributes?.customerPrice == null ? "" : String(point.attributes.customerPrice),
      });
    });
  };
  if (automaticBody) addCurrentPrices(automaticBody);
  addCurrentPrices(manualBody, territoryId);
  const priceScheduleLoaded = jsonApiRows(automaticBody).length > 0 && currentPrices.size > 0
    && [...currentPrices.values()].every(row => row.currency && row.price !== "");
  return {
    hasPrice: !!current,
    priceId: String(current?.id || ""),
    pricePointId: String(pricePointRef?.id || ""),
    territoryId,
    territoryName: territoryId ? appStoreTerritoryName(territoryId) : "",
    currency: String(territory?.attributes?.currency || baseRow?.attributes?.currency || ""),
    price: String(pricePoint?.attributes?.customerPrice ?? ""),
    proceeds: String(pricePoint?.attributes?.proceeds ?? ""),
    startDate: current?.attributes?.startDate || null,
    endDate: current?.attributes?.endDate || null,
    currentPrices: [...currentPrices.values()].sort((a, b) => a.territoryName.localeCompare(b.territoryName, "zh-CN")),
    currentPriceTerritoryCount: priceScheduleLoaded ? currentPrices.size : null,
    priceScheduleLoaded,
  };
}

async function loadAppStoreConnectPricingDetail(appId) {
  const id = encodeURIComponent(String(appId || ""));
  const cacheKey = `pricing:${id}`;
  const cached = appStoreConnectValueCache.get(cacheKey);
  if (cached && Date.now() - Number(cached.at || 0) < APP_STORE_CONNECT_SHORT_CACHE_MS) return cached.value;
  const [manualResult, baseResult, automaticResult] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v1/appPriceSchedules/${id}/manualPrices?include=appPricePoint,territory&limit=1000`),
    appStoreConnectFetch(`/iris/v1/appPriceSchedules/${id}/baseTerritory`),
    appStoreConnectFetch(`/iris/v1/appPriceSchedules/${id}/automaticPrices?include=appPricePoint,territory&limit=1000`),
  ]);
  if (manualResult.status !== "fulfilled") return { hasPrice: false };
  const value = normalizeAppStorePricing(
    manualResult.value.body,
    baseResult.status === "fulfilled" ? baseResult.value.body : {},
    automaticResult.status === "fulfilled" ? automaticResult.value.body : null,
  );
  appStoreConnectValueCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function normalizeAppStorePricingPageSettings(platformBody = null, distributionBody = null, versionsBody = null) {
  const included = jsonApiIncluded(platformBody);
  const macRow = included.find(row => row?.type === "iosAppToMacAppStoreOptInSetting");
  const visionRow = included.find(row => row?.type === "iosAppToAppStoreOnVisionOsOptInSetting");
  const distribution = jsonApiRows(distributionBody)[0]?.attributes || null;
  const versions = jsonApiIncluded(versionsBody)
    .filter(row => row?.type === "appStoreVersions")
    .map(row => ({
      id: String(row.id || ""),
      platform: String(row.attributes?.platform || ""),
      version: String(row.attributes?.versionString || ""),
      createdDate: String(row.attributes?.createdDate || ""),
      state: String(row.attributes?.appStoreState || row.attributes?.appVersionState || ""),
      downloadable: row.attributes?.downloadable === true,
    })).filter(row => row.id);
  return {
    mac: macRow ? {
      loaded: typeof macRow.attributes?.isOptedInToDistributeIosAppOnMacAppStore === "boolean",
      id: String(macRow.id || ""),
      available: macRow.attributes?.isOptedInToDistributeIosAppOnMacAppStore === true,
      verified: macRow.attributes?.isVerifiedForMacOs === true,
      automaticMinVersion: String(macRow.attributes?.automaticMinMacOsVersion || ""),
      minVersion: String(macRow.attributes?.minMacOsVersionToSupport || ""),
      supportedVersions: [...new Set((macRow.attributes?.supportedMacOsVersions || []).map(String))]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
    } : { loaded: false },
    vision: visionRow ? {
      loaded: typeof visionRow.attributes?.isOptedInToDistributeIosAppToAppStoreOnVisionOs === "boolean",
      id: String(visionRow.id || ""),
      available: visionRow.attributes?.isOptedInToDistributeIosAppToAppStoreOnVisionOs === true,
    } : { loaded: false },
    distribution: distribution && Object.hasOwn(distribution, "distributionType") ? {
      loaded: Object.hasOwn(distribution, "educationDiscountType"),
      type: String(distribution.distributionType || ""),
      educationDiscount: distribution.educationDiscountType === "DISCOUNTED",
    } : { loaded: false },
    versionsLoaded: !!versionsBody && jsonApiIncluded(versionsBody)
      .filter(row => row?.type === "appStoreVersions")
      .every(row => typeof row.attributes?.downloadable === "boolean"),
    versions: versions.sort((left, right) => right.createdDate.localeCompare(left.createdDate)),
  };
}

async function loadAppStoreConnectPricingPageSettings(appId, options = {}) {
  const id = encodeURIComponent(String(appId || ""));
  const cacheKey = `pricing-settings:${id}`;
  const cached = appStoreConnectValueCache.get(cacheKey);
  if (!options.force && cached && Date.now() - Number(cached.at || 0) < APP_STORE_CONNECT_SHORT_CACHE_MS) return cached.value;
  const [platform, distribution, versions] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v1/apps/${id}?include=iosAppToMacAppStoreOptInSetting,iosAppToMacAppStoreAdvisoryData,iosAppToAppStoreOnVisionOsOptInSetting&fields[apps]=name,iosAppToMacAppStoreOptInSetting,iosAppToMacAppStoreAdvisoryData,iosAppToAppStoreOnVisionOsOptInSetting`),
    appStoreConnectFetch(`/iris/v1/apps/${id}?fields[apps]=distributionType,educationDiscountType`),
    appStoreConnectFetch(`/iris/v1/apps/${id}?include=appStoreVersions&fields[appStoreVersions]=appStoreState,appVersionState,platform,versionString,downloadable,createdDate,distributions,reviewType&limit[appStoreVersions]=2000`),
  ]);
  const value = normalizeAppStorePricingPageSettings(
    platform.status === "fulfilled" ? platform.value.body : null,
    distribution.status === "fulfilled" ? distribution.value.body : null,
    versions.status === "fulfilled" ? versions.value.body : null,
  );
  if ([platform, distribution, versions].every(result => result.status === "fulfilled")) {
    appStoreConnectValueCache.set(cacheKey, { at: Date.now(), value });
  }
  return value;
}

async function saveAppStoreConnectPricingPageSettings(payload = {}) {
  const appId = String(payload.appId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  const current = await loadAppStoreConnectPricingPageSettings(appId, { force: true });
  const id = encodeURIComponent(appId);
  if (payload.mac) {
    if (!current.mac.loaded) throw new Error("Mac 提供设置暂不可用，请刷新后重试");
    const available = payload.mac.available === true;
    const minVersion = String(payload.mac.minVersion || "");
    if (minVersion && !current.mac.supportedVersions.includes(minVersion)) throw new Error("所选 macOS 最低版本不可用");
    if (available !== current.mac.available || minVersion !== current.mac.minVersion) {
      await appStoreConnectFetch(`/iris/v1/iosAppToMacAppStoreOptInSetting/${encodeURIComponent(current.mac.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { id: current.mac.id, type: "iosAppToMacAppStoreOptInSetting", attributes: {
          isOptedInToDistributeIosAppOnMacAppStore: available,
          minMacOsVersionToSupport: available ? minVersion || null : null,
        } } }),
      });
      clearAppStoreConnectValueCache(`pricing-settings:${id}`);
    }
  }
  if (payload.vision) {
    if (!current.vision.loaded) throw new Error("Apple Vision Pro 提供设置暂不可用，请刷新后重试");
    const available = payload.vision.available === true;
    if (available !== current.vision.available) {
      await appStoreConnectFetch(`/iris/v1/iosAppToAppStoreOnVisionOsOptInSetting/${encodeURIComponent(current.vision.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { id: current.vision.id, type: "iosAppToAppStoreOnVisionOsOptInSetting", attributes: {
          isOptedInToDistributeIosAppToAppStoreOnVisionOs: available,
        } } }),
      });
      clearAppStoreConnectValueCache(`pricing-settings:${id}`);
    }
  }
  if (payload.distribution) {
    if (!current.distribution.loaded) throw new Error("App 分发方式暂不可用，请刷新后重试");
    const type = String(payload.distribution.type || "");
    if (!["APP_STORE", "CUSTOM"].includes(type)) throw new Error("请选择有效的 App 分发方式");
    const educationDiscountType = type === "CUSTOM" ? "NOT_APPLICABLE" : (payload.distribution.educationDiscount === true ? "DISCOUNTED" : "NOT_DISCOUNTED");
    if (type !== current.distribution.type || (payload.distribution.educationDiscount === true) !== current.distribution.educationDiscount) {
      const locked = current.versions.some(version => /^(READY_FOR_SALE|READY_FOR_DISTRIBUTION|AVAILABLE_FOR_SALE|PENDING_APPLE_RELEASE|PENDING_DEVELOPER_RELEASE|IN_REVIEW|PROCESSING_FOR_APP_STORE)$/.test(version.state));
      if (locked && type !== current.distribution.type) throw new Error("App 获批后无法更改分发方式");
      await appStoreConnectFetch(`/iris/v1/apps/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { id: appId, type: "apps", attributes: {
          ...(type !== current.distribution.type ? { distributionType: type } : {}),
          educationDiscountType,
        } } }),
      });
      clearAppStoreConnectValueCache(`pricing-settings:${id}`);
    }
  }
  if (Array.isArray(payload.versions)) {
    if (!current.versionsLoaded) throw new Error("上个兼容版本暂不可用，请刷新后重试");
    const latestIds = new Set(current.versions.filter(version => /^(READY_FOR_SALE|READY_FOR_DISTRIBUTION|AVAILABLE_FOR_SALE)$/.test(version.state)).map(version => version.id));
    for (const change of payload.versions) {
      const version = current.versions.find(item => item.id === String(change.id || ""));
      if (!version) throw new Error("所选 App 版本已不存在，请刷新后重试");
      if (latestIds.has(version.id) && change.downloadable !== true) throw new Error("当前 App Store 版本不能设为不可下载");
      if (version.downloadable === (change.downloadable === true)) continue;
      await appStoreConnectFetch(`/iris/v1/appStoreVersions/${encodeURIComponent(version.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { id: version.id, type: "appStoreVersions", attributes: { downloadable: change.downloadable === true } } }),
      });
      clearAppStoreConnectValueCache(`pricing-settings:${id}`);
    }
  }
  clearAppStoreConnectValueCache(`pricing-settings:${id}`);
  return loadAppStoreConnectPricingPageSettings(appId, { force: true });
}

async function verifyAppStoreConnectMacCompatibility(appId) {
  const id = String(appId || "").trim();
  if (!id) throw new Error("缺少 App ID");
  const settings = await loadAppStoreConnectPricingPageSettings(id, { force: true });
  if (!settings.mac.loaded || !settings.mac.available) throw new Error("请先开启在搭载 Apple 芯片的 Mac 上提供此 App");
  await appStoreConnectFetch(`/iris/v1/iosAppToMacAppStoreOptInSetting/${encodeURIComponent(settings.mac.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { id: settings.mac.id, type: "iosAppToMacAppStoreOptInSetting", attributes: { isVerifiedForMacOs: true } } }),
  });
  clearAppStoreConnectValueCache(`pricing-settings:${encodeURIComponent(id)}`);
  return loadAppStoreConnectPricingPageSettings(id, { force: true });
}

async function loadAppStoreConnectTerritories() {
  const cached = appStoreConnectValueCache.get("territories");
  if (cached && Date.now() - Number(cached.at || 0) < APP_STORE_CONNECT_GLOBAL_CACHE_MS) return cached.value;
  const { body } = await appStoreConnectFetch("/iris/v1/territories?limit=200");
  const seen = new Set();
  const value = jsonApiRows(body).map(row => ({
    id: String(row?.id || ""),
    name: appStoreTerritoryName(String(row?.id || "")),
    currency: String(row?.attributes?.currency || ""),
  })).filter(item => {
    item.id = item.id.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(item.id) || !item.name || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  appStoreConnectValueCache.set("territories", { at: Date.now(), value });
  return value;
}

async function loadAppStoreConnectPricePoints(appId, territoryId) {
  const app = encodeURIComponent(String(appId || ""));
  const territory = encodeURIComponent(String(territoryId || ""));
  const { body } = await appStoreConnectFetch(`/iris/v1/apps/${app}/appPricePoints?filter[territory]=${territory}&include=territory&limit=800`);
  return jsonApiRows(body).map(row => ({
    id: String(row?.id || ""),
    price: String(row?.attributes?.customerPrice ?? ""),
    proceeds: String(row?.attributes?.proceeds ?? ""),
  })).filter(item => item.id).sort((a, b) => Number(a.price) - Number(b.price));
}

function decodeAppStoreTerritoryAvailabilityId(id) {
  try {
    const normalized = String(id || "").replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(Buffer.from(normalized, "base64").toString("utf8"))?.t || "");
  } catch {
    return "";
  }
}

function appStoreTerritorySalesStatus(attributes = {}) {
  const state = String(attributes.salesStatus || attributes.availabilityStatus || attributes.status || attributes.state || "").trim().toUpperCase();
  if (/^(AVAILABLE_FOR_SALE|READY_FOR_SALE|ON_SALE|FOR_SALE)$/.test(state)) return "available";
  if (/PROCESSING|PENDING|WAITING|IN_PROGRESS/.test(state)) return "processing";
  if (/NOT_AVAILABLE|NOT_FOR_SALE|UNAVAILABLE|REMOVED_FROM_SALE|CANNOT_SELL/.test(state)) return "unavailable";
  return "";
}

async function loadAppStoreConnectAvailabilityDetail(appId) {
  const id = encodeURIComponent(String(appId || ""));
  const cacheKey = `availability:${id}`;
  const cached = appStoreConnectValueCache.get(cacheKey);
  if (cached && Date.now() - Number(cached.at || 0) < APP_STORE_CONNECT_SHORT_CACHE_MS) return cached.value;
  try {
    const { body } = await appStoreConnectFetch(`/iris/v2/appAvailabilities/${id}?include=territoryAvailabilities&limit[territoryAvailabilities]=200`);
    const row = jsonApiRows(body)[0] || {};
    const availabilityByTerritory = new Map(jsonApiIncluded(body)
      .filter(item => item?.type === "territoryAvailabilities")
      .map(item => [decodeAppStoreTerritoryAvailabilityId(item.id), item]));
    const territories = (await loadAppStoreConnectTerritories()).map(territory => {
      const availability = availabilityByTerritory.get(territory.id);
      const attributes = availability?.attributes || {};
      return {
        ...territory,
        availabilityId: String(availability?.id || ""),
        available: !!attributes.available,
        preOrderEnabled: !!attributes.preOrderEnabled,
        releaseDate: attributes.releaseDate || null,
        salesStatus: appStoreTerritorySalesStatus(attributes),
      };
    });
    const statusCount = territories.reduce((summary, territory) => {
      if (territory.salesStatus) summary[territory.salesStatus] += 1;
      else summary.unknown += 1;
      return summary;
    }, { available: 0, processing: 0, unavailable: 0, unknown: 0 });
    const value = {
      exists: !!row?.id,
      availableInNewTerritories: row?.attributes?.availableInNewTerritories !== false,
      total: territories.length,
      availableCount: territories.filter(item => item.available).length,
      statusCount,
      territories,
    };
    appStoreConnectValueCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (Number(error?.status) === 404) {
      const territories = (await loadAppStoreConnectTerritories()).map(item => ({ ...item, available: false }));
      const value = { exists: false, availableInNewTerritories: true, total: territories.length, availableCount: 0, territories };
      appStoreConnectValueCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    throw error;
  }
}

function appStoreAvailabilityTemporaryId(appId, territoryId) {
  const encoded = Buffer.from(JSON.stringify({ s: String(appId), t: String(territoryId) })).toString("base64");
  return `\${${encoded}}`;
}

async function saveAppStoreConnectAvailability(payload = {}) {
  const appId = String(payload.appId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  const selected = new Set((Array.isArray(payload.territoryIds) ? payload.territoryIds : []).map(value => String(value || "").toUpperCase()));
  const stopSale = payload.mode === "stop-sale";
  if (!selected.size && !stopSale) throw new Error("请至少选择一个国家或地区");
  const territories = await loadAppStoreConnectTerritories();
  const preOrder = payload.mode === "preorder";
  const releaseDate = String(payload.releaseDate || "").trim();
  if (preOrder && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new Error("请选择有效的发布日期");
  const affected = preOrder ? territories.filter(territory => selected.has(territory.id)) : territories;
  const included = affected.map(territory => {
    const temporaryId = appStoreAvailabilityTemporaryId(appId, territory.id);
    return {
      type: "territoryAvailabilities",
      id: temporaryId,
      attributes: preOrder
        ? { preOrderEnabled: true, available: true, releaseDate }
        : { available: selected.has(territory.id) },
      relationships: { territory: { data: { type: "territories", id: territory.id } } },
    };
  });
  await appStoreConnectFetch("/iris/v1/bulkUpdateAppAvailabilities", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "bulkUpdateAppAvailabilities",
        attributes: preOrder ? {} : { availableInNewTerritories: !stopSale && payload.availableInNewTerritories !== false },
        relationships: {
          app: { data: { type: "apps", id: appId } },
          territoryAvailabilities: {
            data: included.map(({ type, id }) => ({ type, id })),
          },
        },
      },
      included,
    }),
  });
  clearAppStoreConnectValueCache(`availability:${encodeURIComponent(appId)}`);
  return loadAppStoreConnectAppDetail(appId);
}

async function createAppStoreConnectPricing(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const territoryId = String(payload.territoryId || "").trim().toUpperCase();
  const pricePointId = String(payload.pricePointId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!territoryId) throw new Error("请选择所在国家或地区");
  if (!pricePointId) throw new Error("请选择价格");
  const temporaryPriceId = "${newprice-0}";
  await appStoreConnectFetch("/iris/v1/appPriceSchedules", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appPriceSchedules",
        attributes: {},
        relationships: {
          app: { data: { type: "apps", id: appId } },
          manualPrices: { data: [{ type: "appPrices", id: temporaryPriceId }] },
          baseTerritory: { data: { type: "territories", id: territoryId } },
        },
      },
      included: [{
        id: temporaryPriceId,
        type: "appPrices",
        attributes: { startDate: null },
        relationships: {
          appPricePoint: { data: { type: "appPricePoints", id: pricePointId } },
        },
      }],
    }),
  });
  clearAppStoreConnectValueCache(`pricing:${encodeURIComponent(appId)}`);
  return loadAppStoreConnectAppDetail(appId);
}

async function loadAppStoreConnectAppDetail(appId, selectedVersionId = "", options = {}) {
  const light = options.mode === "light";
  const releaseOnly = options.mode === "release";
  const deferred = light || releaseOnly;
  const appPath = `/iris/v1/apps/${encodeURIComponent(appId)}?include=displayableVersions,appBundles,appInfos,appStoreVersionMetrics,appTransferRequest,betaReviewMetrics,promoArtRequests,endUserLicenseAgreement,appGrnSupportingDocument,icpNumberDetail,appStoreIcon&limit[displayableVersions]=20`;
  const { body: appBody } = await appStoreConnectFetch(appPath);
  const appRow = jsonApiRows(appBody)[0] || {};
  const app = normalizeAppStoreApps(appBody)[0] || { id: String(appId || "") };
  const icpRef = relationshipData(appRow, "icpNumberDetail")[0];
  const icpNumberDetail = normalizeAppIcpNumberDetail((icpRef ? findIncluded(appBody, "appIcpNumberDetails", icpRef.id) : null) || jsonApiIncluded(appBody).find(item => item?.type === "appIcpNumberDetails") || {});
  if (icpNumberDetail.icpNumber) app.icpNumber = icpNumberDetail.icpNumber;
  app.icpNumberDetail = icpNumberDetail;
  const appBundles = relationshipData(appRow, "appBundles").map(ref => findIncluded(appBody, "appBundles", ref.id)).filter(Boolean).map(normalizeAppBundle);
  if (!app.bundleId && appBundles[0]?.bundleId) {
    app.bundleId = appBundles[0].bundleId;
    app.bundleIdName = appBundles[0].name || app.bundleIdName || "";
  }
  const versions = sortAppStoreVersions(relationshipData(appRow, "displayableVersions").map(ref => findIncluded(appBody, "appStoreVersions", ref.id)).filter(Boolean).map(normalizeAppStoreVersion));
  const selectedVersion = versions.find(item => String(item.id || "") === String(selectedVersionId || "")) || versions.find(item => item.platform === "IOS") || versions[0] || null;
  if (!selectedVersion?.id) return {
    app,
    versions,
    selectedVersion: null,
    localizations: [],
    screenshotSets: [],
    previewSets: [],
    builds: [],
    reviewSubmissions: [],
    history: [],
    pricing: deferred ? null : await loadAppStoreConnectPricingDetail(appId),
    availability: deferred ? null : await loadAppStoreConnectAvailabilityDetail(appId),
    pricingSettings: deferred ? null : await loadAppStoreConnectPricingPageSettings(appId),
    partial: deferred,
    loadedPanes: releaseOnly ? ["release"] : [],
    mediaLoading: false,
  };

  const versionPath = `/iris/v1/appStoreVersions/${encodeURIComponent(selectedVersion.id)}?include=app,routingAppCoverage,resetRatingsRequest,appStoreVersionSubmission,appStoreVersionPhasedRelease,appStoreVersionLocalizations,ageRatingDeclaration,appStoreReviewDetail,gameCenterConfiguration,appClipDefaultExperience&limit[appStoreVersionLocalizations]=50&fields[apps]=isOrEverWasMadeForKids&fields[appStoreReviewDetails]=contactFirstName,contactLastName,contactPhone,contactEmail,demoAccountName,demoAccountPassword,demoAccountRequired,notes&fields[gameCenterConfigurations]=&limit[appStoreVersionExperiments]=2000`;
  const localizationPath = `/iris/v1/appStoreVersionLocalizations?include=appScreenshotSets,appPreviewSets&filter[appStoreVersion]=${encodeURIComponent(selectedVersion.id)}&limit[appScreenshotSets]=50&limit[appPreviewSets]=50`;
  const appInfoPath = `/iris/v1/apps/${encodeURIComponent(appId)}/appInfos?include=appInfoLocalizations,ageRatingDeclaration,app,primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,secondaryCategory,secondarySubcategoryOne,secondarySubcategoryTwo&fields[apps]=isOrEverWasMadeForKids&limit[appInfoLocalizations]=50`;
  const categoriesPath = "/iris/v1/appCategories?exists[parent]=false&include=subcategories&limit[subcategories]=100&limit=100";
  const buildsPath = `/iris/v1/builds?include=icons,preReleaseVersion,buildBundles&filter[appStoreVersion]=${encodeURIComponent(selectedVersion.id)}`;
  const activeReviewSubmissionsPath = `/iris/v1/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview,items,lastUpdatedByActor,submittedByActor,createdByActor&limit=2000&limit[items]=0&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING`;
  const completedReviewSubmissionsPath = `/iris/v1/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview,items,lastUpdatedByActor,submittedByActor,createdByActor&limit=10&limit[items]=200`;

  // Independent sections start together. The initial release page does not
  // request pricing, territories or privacy data for unopened pages.
  const basePending = Promise.allSettled([
    appStoreConnectFetch(versionPath),
    appStoreConnectFetch(localizationPath),
    appStoreConnectFetch(appInfoPath),
    appStoreConnectCachedValue("app-categories", APP_STORE_CONNECT_GLOBAL_CACHE_MS, () => appStoreConnectFetch(categoriesPath)),
    appStoreConnectFetch(buildsPath),
    loadAppStoreConnectL10nMap(),
  ]);
  const heavyPending = light ? Promise.resolve([]) : Promise.allSettled([
    Promise.allSettled([appStoreConnectFetch(activeReviewSubmissionsPath), appStoreConnectFetch(completedReviewSubmissionsPath)]),
    loadAppStoreConnectVersionHistory(appId, selectedVersion.platform || "IOS"),
    releaseOnly ? Promise.resolve(null) : loadAppStoreConnectPrivacyDetail(appId),
  ]);
  // allSettled immediately handles failures even while media is being read.
  const iapStatusPending = light ? Promise.resolve(null) : loadAppStoreConnectIAPSubmissionStatus(appId).catch(() => null);
  const salesPending = deferred ? Promise.resolve([]) : Promise.allSettled([
    loadAppStoreConnectPricingDetail(appId),
    loadAppStoreConnectAvailabilityDetail(appId),
    iapStatusPending,
    loadAppStoreConnectPricingPageSettings(appId),
  ]);
  const baseResults = await basePending;
  const [
    versionResult,
    localizationResult,
    appInfoResult,
    categoriesResult,
    buildsResult,
    l10nResult,
  ] = baseResults;
  // Never show editable blank fields when a required Apple read failed.
  for (const result of [versionResult, localizationResult, buildsResult]) {
    if (result.status === "rejected") throw result.reason;
  }
  const versionBody = versionResult.status === "fulfilled" ? versionResult.value.body : {};
  const localizationBody = localizationResult.status === "fulfilled" ? localizationResult.value.body : {};
  const appInfoBody = appInfoResult.status === "fulfilled" ? appInfoResult.value.body : {};
  const categoriesBody = categoriesResult.status === "fulfilled" ? categoriesResult.value.body : {};
  const buildsBody = buildsResult.status === "fulfilled" ? buildsResult.value.body : {};
  const l10n = l10nResult.status === "fulfilled" ? l10nResult.value : {};
  const detailedVersion = normalizeAppStoreVersion(jsonApiRows(versionBody)[0] || {});
  const localizations = jsonApiRows(localizationBody).map(normalizeVersionLocalization);
  const appInfos = jsonApiRows(appInfoBody).map(row => normalizeAppInfo(row, appInfoBody));
  const appInfo = selectAppStoreAppInfo(appInfos);
  const categories = jsonApiRows(categoriesBody).map(row => normalizeAppCategory(row, categoriesBody, l10n)).filter(item => item.id || item.name);
  const mediaResults = light ? [] : await Promise.allSettled(localizations.flatMap(localization => {
    if (!localization.id) return [];
    return [
      appStoreConnectFetch(`/iris/v1/appScreenshotSets?include=appScreenshots&filter[appStoreVersionLocalization]=${encodeURIComponent(localization.id)}`),
      appStoreConnectFetch(`/iris/v1/appPreviewSets?include=appPreviews&filter[appStoreVersionLocalization]=${encodeURIComponent(localization.id)}`),
    ];
  }));
  const mediaBodies = mediaResults.filter(item => item.status === "fulfilled").map(item => item.value.body);
  const screenshotSets = mediaBodies.flatMap(body => jsonApiRows(body).filter(item => item?.type === "appScreenshotSets").map(item => normalizeScreenshotSet(item, jsonApiIncluded(body))));
  const previewSets = mediaBodies.flatMap(body => jsonApiRows(body).filter(item => item?.type === "appPreviewSets").map(item => normalizePreviewSet(item, jsonApiIncluded(body))));
  const reviewDetailRef = relationshipData(jsonApiRows(versionBody)[0], "appStoreReviewDetail")[0];
  let reviewDetail = reviewDetailRef ? normalizeReviewDetail(findIncluded(versionBody, "appStoreReviewDetails", reviewDetailRef.id)) : null;
  const hasReviewDetailContent = detail => !!(detail && [
    detail.contactFirstName,
    detail.contactLastName,
    detail.contactPhone,
    detail.contactEmail,
    detail.demoAccountName,
    detail.demoAccountPassword,
    detail.notes,
  ].some(value => String(value || "").trim()) || detail?.demoAccountRequired);
  if (reviewDetailRef?.id && (!reviewDetail || reviewDetail.id !== String(reviewDetailRef.id) || !hasReviewDetailContent(reviewDetail))) {
    try {
      const { body: reviewBody } = await appStoreConnectFetch(`/iris/v1/appStoreReviewDetails/${encodeURIComponent(reviewDetailRef.id)}`);
      reviewDetail = normalizeReviewDetail(jsonApiRows(reviewBody)[0] || {});
    } catch {}
  }
  if (!light && reviewDetail?.id) {
    try {
      const service = createReviewAttachmentService({ fetch: appStoreConnectMutationFetch() });
      reviewDetail.attachments = await service.list(reviewDetail.id);
      reviewDetail.attachmentsContextToken = `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`;
    } catch (error) { reviewDetail.attachmentsError = error.message || "附件列表读取失败"; }
  }
  const builds = jsonApiRows(buildsBody).map(row => normalizeBuild(row, buildsBody));
  const [reviewResult, historyResult, privacyResult] = await heavyPending;
  const reviewResults = reviewResult?.status === "fulfilled" ? reviewResult.value : [];
  const reviewSubmissions = [...new Map(
    reviewResults
      .flatMap(item => item.status === "fulfilled" ? normalizeReviewSubmissions(item.value.body) : [])
      .filter(item => item.id)
      .map(item => [item.id, item]),
  ).values()].sort((left, right) => Date.parse(appStoreReviewDate(right)) - Date.parse(appStoreReviewDate(left)));
  let reviewWarning = null;
  const activeSubmissions = reviewSubmissions.filter(item => item.id && !/^(COMPLETE|COMPLETED)$/i.test(String(item.state || "")));
  if (!light && activeSubmissions.length) {
    const [purchaseResult, ...itemResults] = await Promise.allSettled([
      loadAppStoreConnectInAppPurchases(appId),
      ...activeSubmissions.map(submission => appStoreConnectFetch(
        `/iris/v1/reviewSubmissions/${encodeURIComponent(submission.id)}/items?include=appCustomProductPageVersion,appEvent,appStoreVersion,appStoreVersionExperiment,backgroundAssetVersion,gameCenterAchievementVersion,gameCenterLeaderboardVersion,gameCenterLeaderboardSetVersion,gameCenterChallengeVersion,gameCenterActivityVersion,inAppPurchaseVersion,subscriptionVersion,subscriptionGroupVersion&limit=200`,
      )),
    ]);
    const purchases = purchaseResult.status === "fulfilled" ? purchaseResult.value : [];
    activeSubmissions.forEach((submission, index) => {
      const result = itemResults[index];
      if (result?.status !== "fulfilled") return;
      const itemBody = result.value.body;
      submission.items = jsonApiRows(itemBody).map(item => {
        const purchaseVersionRef = relationshipData(item, "inAppPurchaseVersion")[0];
        const appVersionRef = relationshipData(item, "appStoreVersion")[0];
        const purchase = purchases.find(row => String(row.versionId || "") === String(purchaseVersionRef?.id || ""));
        const appVersionRow = appVersionRef ? findIncluded(itemBody, appVersionRef.type || "appStoreVersions", appVersionRef.id) : null;
        const appVersion = appVersionRow ? normalizeAppStoreVersion(appVersionRow) : null;
        return {
          id: String(item.id || ""),
          state: String(item.attributes?.state || ""),
          type: purchaseVersionRef ? "IN_APP_PURCHASE" : (appVersionRef ? "APP_STORE_VERSION" : "OTHER"),
          itemType: String(purchaseVersionRef?.type || appVersionRef?.type || ""),
          relatedId: String(purchaseVersionRef?.id || appVersionRef?.id || ""),
          versionId: String(purchaseVersionRef?.id || ""),
          version: appVersion,
          purchaseId: String(purchase?.id || ""),
          purchaseType: String(purchase?.type || ""),
          name: String(purchase?.name || appVersion?.versionString || (purchaseVersionRef ? "App 内购买项目" : "App 版本")),
          productId: String(purchase?.productId || ""),
        };
      });
      submission.itemCount = submission.items.length || submission.itemCount;
    });
  }
  if (!light) reviewWarning = await loadAppStoreVersionReviewWarning(appId, selectedVersion.id, reviewSubmissions);
  let territoryAgeRatings = [];
  if (!deferred && appInfo?.id) {
    try {
      const { body: territoryAgeRatingsBody } = await appStoreConnectFetch(`/iris/v1/appInfos/${encodeURIComponent(appInfo.id)}/territoryAgeRatings?include=territory&limit=500`);
      territoryAgeRatings = normalizeTerritoryAgeRatings(territoryAgeRatingsBody);
    } catch {}
  }

  let pricing = null;
  let availability = null;
  let iapSubmissionStatus = await iapStatusPending;
  let pricingSettings = null;
  if (!deferred) {
    const salesResults = await salesPending;
    const failure = salesResults.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    [pricing, availability, iapSubmissionStatus, pricingSettings] = salesResults.map(result => result.value);
  }
  return {
    app,
    versions: versions.map(item => item.id === selectedVersion.id ? { ...item, ...detailedVersion } : item),
    selectedVersion: { ...selectedVersion, ...detailedVersion },
    localizations,
    appInfo,
    appBundles,
    categories,
    l10n,
    territoryAgeRatings,
    screenshotSets,
    previewSets,
    reviewDetail,
    builds,
    reviewSubmissions,
    reviewWarning,
    history: historyResult?.status === "fulfilled" ? historyResult.value.history : [],
    privacy: privacyResult?.status === "fulfilled" ? privacyResult.value : null,
    pricing,
    availability,
    pricingSettings,
    iapSubmissionStatus,
    partial: deferred,
    loadedPanes: releaseOnly ? ["release"] : [],
    mediaLoading: light,
  };
}

async function loadAppStoreConnectBuildCandidates(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const platform = String(payload.platform || "IOS").trim() || "IOS";
  if (!appId) throw new Error("缺少 App ID");
  const path = `/iris/v1/builds?include=icons,preReleaseVersion,buildBundles&limit=20&filter[app]=${encodeURIComponent(appId)}&filter[preReleaseVersion.platform]=${encodeURIComponent(platform)}&filter[isAppStoreCandidate]=true&filter[processingState]=VALID&sort=-version`;
  const { body } = await appStoreConnectFetch(path);
  return jsonApiRows(body).map(row => normalizeBuild(row, body)).filter(item => item.id);
}

async function saveAppStoreConnectAppVersionBuild(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  const buildId = String(payload.buildId || "").trim();
  const remove = !!payload.remove;
  if (!appId || !versionId) throw new Error("缺少 App 或版本 ID");
  if (!remove && !buildId) throw new Error("请选择构建版本");
  await appStoreConnectFetch(`/iris/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`, {
    method: "PATCH",
    body: JSON.stringify({ data: remove ? null : { type: "builds", id: buildId } }),
  });
  clearAppStoreConnectValueCache(`pricing:${encodeURIComponent(appId)}`);
  return loadAppStoreConnectAppDetail(appId, versionId);
}

async function saveAppStoreConnectBuildEncryption(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  const buildId = String(payload.buildId || "").trim();
  const choice = String(payload.choice || payload.encryptionChoice || "").trim();
  const usesNonExemptEncryption = payload.usesNonExemptEncryption === true;
  if (!appId) throw new Error("缺少 App ID");
  if (!versionId) throw new Error("缺少版本 ID");
  if (!buildId) throw new Error("缺少构建版本 ID");
  if (!choice) throw new Error("请选择 App 使用的加密算法类型");
  await appStoreConnectFetch(`/iris/v1/builds/${encodeURIComponent(buildId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "builds",
        id: buildId,
        attributes: { usesNonExemptEncryption },
      },
    }),
  });
  return loadAppStoreConnectAppDetail(appId, versionId);
}

async function createAppStoreConnectAppVersion(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const platform = String(payload.platform || "IOS").trim().toUpperCase();
  const versionString = String(payload.versionString || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!versionString) throw new Error("请输入版本号");
  if (!["IOS", "MAC_OS", "TV_OS", "VISION_OS"].includes(platform)) throw new Error("暂不支持该平台");
  const { body } = await appStoreConnectFetch("/iris/v1/appStoreVersions", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "appStoreVersions",
        attributes: { platform, versionString },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  const versionId = String(body?.data?.id || "");
  if (!versionId) throw new Error("Apple 未返回新版本 ID");
  return loadAppStoreConnectAppDetail(appId, versionId);
}

async function releaseAppStoreConnectAppVersion(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!versionId) throw new Error("缺少版本 ID");
  await appStoreConnectFetch("/iris/v1/appStoreVersionReleaseRequests", {
    method: "POST",
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Referer: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appId)}/distribution/ios/version/inflight`,
    },
    body: JSON.stringify({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    }),
  });
  return { detail: await loadAppStoreConnectAppDetail(appId, versionId) };
}

async function cancelAppStoreConnectAppVersionRelease(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!versionId) throw new Error("缺少版本 ID");
  await appStoreConnectFetch(`/iris/v1/appStoreVersionSubmissions/${encodeURIComponent(versionId)}`, {
    method: "DELETE",
  });
  return { detail: await loadAppStoreConnectAppDetail(appId, versionId) };
}

function appStoreIcpDeveloperNameMismatch(error) {
  const details = [error?.message, ...appStoreConnectErrorItems(error?.body).flatMap(item => [item.code, item.message])]
    .filter(Boolean).join(" ");
  return /developerNameMismatch|developer.{0,30}name.{0,60}(?:not match|mismatch)|(?:开发者|开发人员).{0,12}(?:姓名|名称).{0,40}(?:不匹配|不一致)/i.test(details);
}

async function saveAppStoreConnectIcpNumber(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const icpNumber = String(payload.icpNumber || "").trim();
  if (!/^\d+$/.test(appId)) throw new Error("缺少有效的 App ID");
  if (!icpNumber) throw new Error("请输入 ICP 备案号");
  const attributes = { icpNumber };
  if (payload.developerNameMismatchConsent === true) attributes.developerNameMismatchConsent = true;
  await appStoreConnectFetch(`/iris/v1/appIcpNumberDetails/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.api+json, application/json, text/csv",
      "Content-Type": "application/json",
      Referer: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appId)}/distribution/info`,
    },
    body: JSON.stringify({ data: { type: "appIcpNumberDetails", id: appId, attributes } }),
  });
  return { appId, icpNumber };
}

// Save only needs the resources being edited. Keep the account/session fixed
// across reads and writes, including requests waiting in the shared queue.
function appStoreConnectMutationFetch() {
  const generation = appleDeveloperContextGeneration;
  const accountKey = appleDeveloperAccountKey;
  const teamId = readSelectedAppleDeveloperTeam()?.id || "";
  const ses = session.fromPartition(appleDeveloperPartitionForAccount(accountKey));
  return async (requestPath, options = {}) => {
    const assertCurrent = () => {
      if (!appleDeveloperContextIsCurrent(generation, accountKey) || (readSelectedAppleDeveloperTeam()?.id || "") !== teamId) {
        throw new Error("Apple 账户或团队已切换，请返回原账户确认操作结果");
      }
    };
    assertCurrent();
    const result = await appStoreConnectFetch(requestPath, { ...options, session: ses, priority: options.priority || "interactive", skipSessionRefresh: true, assertContext: assertCurrent });
    assertCurrent();
    return result;
  };
}

async function loadAppStoreConnectSaveContext(payload, fetch) {
  const appId = String(payload.appId || "");
  const versionId = String(payload.versionId || "");
  const detail = {};
  if (payload.localization || payload.version || payload.reviewDetail) {
    const includes = ["app"];
    if (payload.localization) includes.push("appStoreVersionLocalizations");
    if (payload.reviewDetail) includes.push("appStoreReviewDetail");
    const { body } = await fetch(`/iris/v1/appStoreVersions/${encodeURIComponent(versionId)}?include=${includes.join(",")}&limit[appStoreVersionLocalizations]=50`);
    const row = jsonApiRows(body)[0];
    if (row?.id !== versionId || relationshipData(row, "app")[0]?.id !== appId) throw new Error("所选版本与当前 App 不匹配，请刷新后重试");
    detail.selectedVersion = normalizeAppStoreVersion(row);
    if (payload.localization) {
      detail.localizations = [];
      for (const ref of relationshipData(row, "appStoreVersionLocalizations")) {
        const localized = findIncluded(body, "appStoreVersionLocalizations", ref.id);
        if (localized) detail.localizations.push(normalizeVersionLocalization(localized));
      }
      const id = String(payload.localizationId || (detail.selectedVersion.localizationIds.length === 1 ? detail.selectedVersion.localizationIds[0] : ""));
      if (id && !detail.localizations.some(item => item.id === id) && detail.selectedVersion.localizationIds.includes(id)) {
        const result = await fetch(`/iris/v1/appStoreVersionLocalizations/${encodeURIComponent(id)}`);
        const localized = jsonApiRows(result.body)[0];
        if (localized?.id !== id) throw new Error("Apple 未返回当前语言的信息，请重试");
        detail.localizations.push(normalizeVersionLocalization(localized));
      }
    }
    if (payload.reviewDetail) {
      const ref = relationshipData(row, "appStoreReviewDetail")[0];
      if (payload.reviewDetailId && String(payload.reviewDetailId) !== String(ref?.id || "")) throw new Error("审核信息与当前版本不匹配，请刷新后重试");
      let review = ref && findIncluded(body, "appStoreReviewDetails", ref.id);
      if (ref && !review) review = jsonApiRows((await fetch(`/iris/v1/appStoreReviewDetails/${encodeURIComponent(ref.id)}`)).body)[0];
      if (ref && review?.id !== ref.id) throw new Error("Apple 未返回当前审核信息，请重试");
      detail.reviewDetail = review ? normalizeReviewDetail(review) : null;
    }
  }
  if (payload.appInfo) {
    const { body } = await fetch(`/iris/v1/apps/${encodeURIComponent(appId)}/appInfos?include=app,appInfoLocalizations,ageRatingDeclaration,primaryCategory,primarySubcategoryOne,secondaryCategory,secondarySubcategoryOne&limit[appInfoLocalizations]=50`);
    const rows = jsonApiRows(body);
    const row = payload.appInfo.id ? rows.find(item => item.id === String(payload.appInfo.id)) : rows.length === 1 ? rows[0] : null;
    if (!row) throw new Error("所选 App 信息不匹配，请刷新后重试");
    detail.appInfo = normalizeAppInfo(row, body);
    if (payload.appInfo.localizationId && !detail.appInfo.localizations.some(item => item.id === String(payload.appInfo.localizationId))) throw new Error("所选 App 信息语言不匹配，请刷新后重试");
    if (payload.appInfo.ageRatingDeclarationId && payload.appInfo.ageRatingDeclarationId !== detail.appInfo.ageRatingDeclarationId) throw new Error("年龄分级与当前 App 不匹配，请刷新后重试");
    const appRow = findIncluded(body, "apps", appId);
    detail.app = { id: appId, contentRightsDeclaration: String(appRow?.attributes?.contentRightsDeclaration || "") };
  }
  return detail;
}

async function saveAppStoreConnectAppVersion(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  const requestedLocalizationId = String(payload.localizationId || "").trim();
  let reviewDetailId = String(payload.reviewDetailId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!versionId) throw new Error("缺少版本 ID");
  const fetch = appStoreConnectMutationFetch();
  const currentDetail = await loadAppStoreConnectSaveContext(payload, fetch);
  reviewDetailId ||= currentDetail.reviewDetail?.id || "";
  const currentVersion = currentDetail.selectedVersion || {};
  if (currentVersion.id && currentVersion.id !== versionId) {
    throw new Error("所选 App 版本已变化，请刷新后重试");
  }
  const localizationIds = [...new Set([
    ...(currentVersion.localizationIds || []),
    ...(currentDetail.localizations || []).map(item => item.id),
  ].map(String).filter(Boolean))];
  if (payload.localization && requestedLocalizationId && !localizationIds.includes(requestedLocalizationId)) {
    throw new Error("所选本地化版本与当前 App 版本不匹配，请刷新后重试");
  }
  const localizationId = requestedLocalizationId || (localizationIds.length === 1 ? localizationIds[0] : "");
  if (payload.localization && !localizationId) {
    throw new Error("App 描述对应的本地化版本未读取成功，请刷新 App 详情后重试");
  }
  const currentLocalization = (currentDetail.localizations || []).find(item => item.id === localizationId) || {};
  const currentAppInfo = currentDetail.appInfo || {};
  const currentAppInfoLocalization = (currentAppInfo.localizations || []).find(item => item.id === String(payload.appInfo?.localizationId || "")) || (currentAppInfo.localizations || [])[0] || {};
  const changedAttributes = (next, current, fields) => {
    const attributes = {};
    for (const [field, normalize] of fields) {
      if (next[field] === undefined) continue;
      const nextValue = normalize(next[field]);
      const currentValue = normalize(current[field]);
      if (nextValue !== currentValue) attributes[field] = nextValue;
    }
    return attributes;
  };
  if (localizationId && payload.localization) {
    const urlValue = value => String(value || "").trim() || null;
    const textValue = value => String(value || "");
    const attributes = changedAttributes(payload.localization, currentLocalization, [
      ["promotionalText", textValue],
      ["description", textValue],
      ["keywords", textValue],
      ["supportUrl", urlValue],
      ["marketingUrl", urlValue],
      ["whatsNew", textValue],
    ]);
    if (Object.keys(attributes).length) {
      const { body } = await fetch(`/iris/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { type: "appStoreVersionLocalizations", id: localizationId, attributes } }),
      });
      Object.assign(currentLocalization, attributes, body?.data?.attributes || {});
    }
  }
  if (payload.version) {
    const requestedReleaseType = String(payload.version.releaseType || "AFTER_APPROVAL");
    const requestedReleaseDate = payload.version.earliestReleaseDate ? String(payload.version.earliestReleaseDate) : null;
    if (requestedReleaseType === "SCHEDULED" && !requestedReleaseDate) throw new Error("请选择计划发布时间");
    payload.version.releaseType = requestedReleaseType;
    payload.version.earliestReleaseDate = requestedReleaseType === "SCHEDULED" ? requestedReleaseDate : null;
    const attributes = changedAttributes(payload.version, currentVersion, [
      ["versionString", value => String(value || "")],
      ["copyright", value => String(value || "")],
      ["releaseType", value => String(value || "AFTER_APPROVAL")],
      ["earliestReleaseDate", value => value ? String(value) : null],
    ]);
    if (Object.keys(attributes).length) {
      await fetch(`/iris/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { type: "appStoreVersions", id: versionId, attributes } }),
      });
      Object.assign(currentVersion, attributes);
    }
  }
  if (payload.appInfo) {
    const appInfoId = String(payload.appInfo.id || currentAppInfo.id || "").trim();
    const appInfoLocalizationId = String(payload.appInfo.localizationId || currentAppInfoLocalization.id || "").trim();
    if (appInfoLocalizationId && payload.appInfo.localization) {
      const attributes = changedAttributes(payload.appInfo.localization, currentAppInfoLocalization, [
        ["name", value => String(value || "").trim()],
        ["subtitle", value => String(value || "").trim()],
      ]);
      if (Object.keys(attributes).length) {
        await fetch(`/iris/v1/appInfoLocalizations/${encodeURIComponent(appInfoLocalizationId)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "appInfoLocalizations", id: appInfoLocalizationId, attributes } }),
        });
        Object.assign(currentAppInfoLocalization, attributes);
      }
    }
    if (appInfoId && payload.appInfo.categories) {
      const relationships = {};
      if (payload.appInfo.categories.primaryCategoryId !== undefined) {
        const category = payload.appInfo.categories.primaryCategory || {};
        const selectedId = String(payload.appInfo.categories.primaryCategoryId || "").trim();
        const currentId = String(currentAppInfo.primaryCategory?.id || "").trim();
        if (selectedId !== currentId) {
          const id = String(category.parentId || selectedId || "").trim();
          const subcategoryId = category.parentId ? selectedId : "";
          relationships.primaryCategory = { data: id ? { type: "appCategories", id } : null };
          relationships.primarySubcategoryOne = { data: subcategoryId ? { type: "appCategories", id: subcategoryId } : null };
          relationships.primarySubcategoryTwo = { data: null };
        }
      }
      if (payload.appInfo.categories.secondaryCategoryId !== undefined) {
        const category = payload.appInfo.categories.secondaryCategory || {};
        const selectedId = String(payload.appInfo.categories.secondaryCategoryId || "").trim();
        const currentId = String(currentAppInfo.secondaryCategory?.id || "").trim();
        if (selectedId !== currentId) {
          const id = String(category.parentId || selectedId || "").trim();
          const subcategoryId = category.parentId ? selectedId : "";
          relationships.secondaryCategory = { data: id ? { type: "appCategories", id } : null };
          relationships.secondarySubcategoryOne = { data: subcategoryId ? { type: "appCategories", id: subcategoryId } : null };
          relationships.secondarySubcategoryTwo = { data: null };
        }
      }
      if (Object.keys(relationships).length) {
        await fetch(`/iris/v1/appInfos/${encodeURIComponent(appInfoId)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "appInfos", id: appInfoId, relationships } }),
        });
        for (const key of ["primaryCategory", "secondaryCategory"]) {
          if (relationships[key]) currentAppInfo[key] = payload.appInfo.categories[`${key}Id`] ? { ...payload.appInfo.categories[key], id: payload.appInfo.categories[`${key}Id`] } : null;
        }
      }
    }
    const appAttributes = {};
    // Bundle ID is selected when the App is created. Re-saving it on an
    // existing App can make App Store Connect reject the save as "already used".
    if (payload.appInfo.contentRightsDeclaration) {
      const value = String(payload.appInfo.contentRightsDeclaration);
      if (value !== String(currentDetail.app?.contentRightsDeclaration || "")) appAttributes.contentRightsDeclaration = value;
    }
    if (Object.keys(appAttributes).length) {
      await fetch(`/iris/v1/apps/${encodeURIComponent(appId)}`, {
        method: "PATCH",
        body: JSON.stringify({ data: { type: "apps", id: appId, attributes: appAttributes } }),
      });
      Object.assign(currentDetail.app, appAttributes);
    }
    const ageRatingDeclarationId = String(payload.appInfo.ageRatingDeclarationId || currentAppInfo.ageRatingDeclarationId || "").trim();
    if (ageRatingDeclarationId && payload.appInfo.ageRatingAttributes && typeof payload.appInfo.ageRatingAttributes === "object") {
      const currentAttributes = currentAppInfo.ageRatingDeclaration?.attributes || {};
      const attributes = changedAttributes(payload.appInfo.ageRatingAttributes, currentAttributes, Object.keys(payload.appInfo.ageRatingAttributes).map(key => [key, value => value]));
      if (Object.keys(attributes).length) {
        await fetch(`/iris/v1/ageRatingDeclarations/${encodeURIComponent(ageRatingDeclarationId)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "ageRatingDeclarations", id: ageRatingDeclarationId, attributes } }),
        });
        currentAppInfo.ageRatingDeclaration = { id: ageRatingDeclarationId, attributes: { ...currentAttributes, ...attributes } };
      }
    }
  }
  if (payload.reviewDetail) {
    const currentReviewDetail = currentDetail.reviewDetail || {};
    const reviewText = value => String(value || "");
    const attributes = changedAttributes(payload.reviewDetail, currentReviewDetail, [
      ["demoAccountRequired", value => !!value],
      ["demoAccountName", reviewText],
      ["demoAccountPassword", reviewText],
      ["contactFirstName", value => String(value || "").trim()],
      ["contactLastName", value => String(value || "").trim()],
      ["contactPhone", value => String(value || "").trim()],
      ["contactEmail", value => String(value || "").trim()],
      ["notes", reviewText],
    ]);
    for (const field of ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"]) {
      if (attributes[field] === "") delete attributes[field];
    }
    if (reviewDetailId) {
      if (Object.keys(attributes).length) {
        await fetch(`/iris/v1/appStoreReviewDetails/${encodeURIComponent(reviewDetailId)}`, {
          method: "PATCH",
          body: JSON.stringify({ data: { type: "appStoreReviewDetails", id: reviewDetailId, attributes } }),
        });
        Object.assign(currentReviewDetail, attributes);
      }
    } else if (Object.values(attributes).some(value => value === true || String(value || "").trim())) {
      const { body } = await fetch("/iris/v1/appStoreReviewDetails", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "appStoreReviewDetails",
            attributes,
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
          },
        }),
      });
      currentDetail.reviewDetail = normalizeReviewDetail(body?.data || { attributes });
      currentVersion.reviewDetailId = currentDetail.reviewDetail.id;
    }
  }
  return currentDetail;
}

async function findReadyForReviewSubmissionForAppVersion(appId, versionId) {
  const activeResult = await appStoreConnectFetch(
    `/iris/v1/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview,items&limit=2000&limit[items]=0&filter[state]=READY_FOR_REVIEW`,
  );
  const candidates = [];
  for (const submission of jsonApiRows(activeResult.body)) {
    const submissionId = String(submission.id || "");
    if (!submissionId) continue;
    const itemsResult = await appStoreConnectFetch(
      `/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?include=inAppPurchaseVersion,appStoreVersion&limit=200`,
    );
    const items = jsonApiRows(itemsResult.body);
    const hasSameAppVersion = items.some(row =>
      relationshipData(row, "appStoreVersion").some(ref => String(ref.id || "") === versionId)
    );
    const hasAnyAppVersion = items.some(row => relationshipData(row, "appStoreVersion")[0]);
    const hasInAppPurchase = items.some(row => relationshipData(row, "inAppPurchaseVersion")[0]);
    candidates.push({ submissionId, hasSameAppVersion, hasAnyAppVersion, hasInAppPurchase });
  }
  return candidates.find(item => item.hasSameAppVersion)
    || candidates.find(item => item.hasInAppPurchase && !item.hasAnyAppVersion)
    || null;
}

async function submitAppStoreConnectReview(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  const platform = String(payload.platform || "IOS").trim().toUpperCase() || "IOS";
  const preferredSubmissionId = String(payload.submissionId || payload.reviewSubmissionId || "").trim();
  const forceNewSubmission = payload.forceNewSubmission === true;
  if (!appId) throw new Error("缺少 App ID");
  if (!versionId) throw new Error("缺少版本 ID");

  let reviewSubmissionId = "";
  let createdSubmission = false;
  try {
    if (preferredSubmissionId) {
      reviewSubmissionId = preferredSubmissionId;
    } else if (!forceNewSubmission) {
      const existing = await findReadyForReviewSubmissionForAppVersion(appId, versionId);
      reviewSubmissionId = String(existing?.submissionId || "");
      if (existing?.hasSameAppVersion && reviewSubmissionId) {
        return { reviewSubmissionId, detail: await loadAppStoreConnectAppDetail(appId) };
      }
    }
    if (!reviewSubmissionId) {
      const { body: submissionBody } = await appStoreConnectFetch("/iris/v1/reviewSubmissions", {
        method: "POST",
        headers: {
          Referer: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appId)}/distribution/${platform === "MAC_OS" ? "macos" : "ios"}/version/inflight`,
        },
        body: JSON.stringify({
          data: {
            type: "reviewSubmissions",
            attributes: { platform },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        }),
      });
      reviewSubmissionId = String(submissionBody?.data?.id || "");
      createdSubmission = true;
      if (!reviewSubmissionId) throw new Error("Apple 未返回审核提交 ID");
    }

    await appStoreConnectFetch("/iris/v1/reviewSubmissionItems", {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Referer: `https://appstoreconnect.apple.com/apps/${encodeURIComponent(appId)}/distribution/${platform === "MAC_OS" ? "macos" : "ios"}/version/inflight`,
      },
      body: JSON.stringify({
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: reviewSubmissionId } },
            appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
          },
        },
      }),
    });
    return { reviewSubmissionId, detail: await loadAppStoreConnectAppDetail(appId) };
  } catch (error) {
    const items = appStoreConnectErrorItems(error.body);
    if (reviewSubmissionId && createdSubmission) {
      try {
        await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`, { method: "DELETE" });
      } catch {}
    }
    if (items.length) error.appStoreErrors = items;
    throw error;
  }
}

async function submitInAppPurchaseReviewDraft(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const submissionId = String(payload.submissionId || payload.reviewSubmissionId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!submissionId) throw new Error("缺少审核提交 ID");
  await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "reviewSubmissions",
        id: submissionId,
        attributes: { submitted: true },
      },
    }),
  });
  let detail = null;
  try { detail = await loadAppStoreConnectAppDetail(appId); } catch {}
  return { reviewSubmissionId: submissionId, detail };
}

async function updateAppStoreConnectReviewSubmissionItem(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const submissionId = String(payload.submissionId || payload.reviewSubmissionId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  let itemId = String(payload.itemId || payload.reviewSubmissionItemId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!submissionId) throw new Error("缺少审核提交 ID");
  if (!itemId) {
    const { body } = await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?include=appStoreVersion&limit=200`);
    const item = jsonApiRows(body).find(row => relationshipData(row, "appStoreVersion").some(ref => String(ref.id || "") === versionId));
    itemId = String(item?.id || "");
  }
  if (!itemId) throw new Error("未找到对应的审核项目");
  const { body } = await appStoreConnectFetch(`/iris/v1/reviewSubmissionItems/${encodeURIComponent(itemId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "reviewSubmissionItems", id: itemId, attributes: { resolved: true } } }),
  });
  return { submissionId, itemId, state: String(body?.data?.attributes?.state || "READY_FOR_REVIEW") };
}

async function resubmitAppStoreConnectReview(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const submissionId = String(payload.submissionId || payload.reviewSubmissionId || "").trim();
  if (!appId) throw new Error("缺少 App ID");
  if (!submissionId) throw new Error("缺少审核提交 ID");
  const fetch = appStoreConnectMutationFetch();
  const { body } = await fetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } }),
  });
  return { reviewSubmissionId: submissionId, submitted: true, state: String(body?.data?.attributes?.state || "") };
}

async function deleteAppStoreConnectMedia(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const screenshotIds = Array.isArray(payload.screenshotIds) ? payload.screenshotIds.map(id => String(id || "").trim()).filter(Boolean) : [];
  const previewIds = Array.isArray(payload.previewIds) ? payload.previewIds.map(id => String(id || "").trim()).filter(Boolean) : [];
  if (!appId) throw new Error("缺少 App ID");
  for (const id of screenshotIds) await appStoreConnectFetch(`/iris/v1/appScreenshots/${encodeURIComponent(id)}`, { method: "DELETE" });
  for (const id of previewIds) await appStoreConnectFetch(`/iris/v1/appPreviews/${encodeURIComponent(id)}`, { method: "DELETE" });
  return loadAppStoreConnectAppDetail(appId);
}

async function loadAppStoreConnectVersionHistory(appId, platform = "IOS") {
  const versionListPath = `/iris/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[platform]=${encodeURIComponent(platform)}&limit=200&fields[appStoreVersions]=appStoreState,appVersionState,versionString,platform,downloadable,createdDate`;
  const { body } = await appStoreConnectFetch(versionListPath);
  const versions = jsonApiRows(body).map(normalizeAppStoreVersion);
  const history = [];
  for (const version of versions.slice(0, 20)) {
    if (!version.id) continue;
    try {
      const { body: changesBody } = await appStoreConnectFetch(`/iris/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreVersionStateChanges`);
      history.push({ version, changes: jsonApiRows(changesBody).map(normalizeVersionStateChange) });
    } catch (error) {
      history.push({ version, changes: [], error: error.message || "" });
    }
  }
  return { versions, history };
}

function appStoreCreatePayload(payload = {}) {
  const platforms = (Array.isArray(payload.platforms) ? payload.platforms : [payload.platform || "IOS"])
    .map(value => String(value || "").toUpperCase().trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const name = String(payload.name || "").trim();
  const bundleId = String(payload.bundleId || "").trim();
  const sku = String(payload.sku || "").trim();
  const primaryLocale = String(payload.primaryLocale || "zh-Hans").trim();
  const companyName = String(payload.companyName || "").trim();
  const isOrganization = payload.isOrganization === true || ["1", "true"].includes(String(payload.isOrganization || "").toLowerCase());
  if (!name) throw new Error("请输入 App 名称");
  if (!bundleId) throw new Error("请选择套装 ID");
  if (!sku) throw new Error("请输入 SKU");
  if (isOrganization && !companyName) throw new Error("当前 Apple 账户没有可用的公司名称");
  if (!platforms.length) throw new Error("请选择平台");
  if (platforms.some(platform => !["IOS", "MAC_OS", "TV_OS", "VISION_OS"].includes(platform))) throw new Error("暂不支持该平台");
  const versionRefs = platforms.map(platform => {
    const suffix = ({ IOS: "ios", MAC_OS: "macos", TV_OS: "tvos", VISION_OS: "visionos" })[platform];
    return { platform, versionKey: `store-version-${suffix}`, localizationKey: `new-${suffix}VersionLocalization-id` };
  });
  const included = versionRefs.flatMap(({ platform, versionKey, localizationKey }) => [
    { type: "appStoreVersions", id: `\${${versionKey}}`, attributes: { platform, versionString: "1.0" }, relationships: { appStoreVersionLocalizations: { data: [{ type: "appStoreVersionLocalizations", id: `\${${localizationKey}}` }] } } },
    { type: "appStoreVersionLocalizations", id: `\${${localizationKey}}`, attributes: { locale: primaryLocale } },
  ]);
  const attributes = { sku, primaryLocale, bundleId };
  if (isOrganization) attributes.companyName = companyName;
  return {
    data: {
      type: "apps",
      attributes,
      relationships: {
        appStoreVersions: { data: versionRefs.map(({ versionKey }) => ({ type: "appStoreVersions", id: `\${${versionKey}}` })) },
        appInfos: { data: [{ type: "appInfos", id: "${new-appInfo-id}" }] },
      },
    },
    included: [...included, { type: "appInfos", id: "${new-appInfo-id}", relationships: { appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: "${new-appInfoLocalization-id}" }] } } }, { type: "appInfoLocalizations", id: "${new-appInfoLocalization-id}", attributes: { locale: primaryLocale, name } }],
  };
}

function openDeveloperAccountManagerWindow(parent) {
  if (developerAccountManagerWindow && !developerAccountManagerWindow.isDestroyed()) {
    developerAccountManagerWindow.show();
    developerAccountManagerWindow.focus();
    return developerAccountManagerWindow;
  }
  developerAccountManagerWindow = new BrowserWindow({
    width: 980, height: 680, minWidth: 760, minHeight: 520,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: "开发者账户管理", icon: currentAppIcon(),
    webPreferences: { preload: path.join(__dirname, "developer-account-preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  developerAccountManagerWindow.on("closed", () => { developerAccountManagerWindow = null; });
  developerAccountManagerWindow.loadFile(path.join(__dirname, "developer-account-manager.html"));
  return developerAccountManagerWindow;
}

ipcMain.handle("developer-accounts-list", async () => {
  try {
    const identity = await requireDesktopUserIdentity();
    migrateDeveloperAccountsJSON();
    const accessMap = (await readAppleDeveloperAccessMap()) || {};
    const runningStatus = isStandaloneCertificateManagerRunning() ? readCertificateManagerStatusFile() : null;
    const accounts = withDeveloperAccountsDatabase(db => db.prepare("SELECT id,apple_id,remark,created_at,password,p12_password,deleted_at,proxy_json,browser_proxy_key,connection_mode,account_code FROM developer_accounts WHERE owner_key=? AND COALESCE(deleted_at,'')='' ORDER BY created_at").all(identity.key).map(item => {
      let access = accessMap[String(item.id || "")] || {
        allowed: true, trialStarted: false, activated: false, firstLoginAt: "", trialExpiresAt: "", remainingDays: 15, trialDays: 15,
      };
      const sameRunningAccount = runningStatus?.authenticated && (String(runningStatus.accountId || "") === String(item.id || "") || String(runningStatus.appleId || "").toLowerCase() === String(item.apple_id || "").toLowerCase());
      if (sameRunningAccount) {
        scheduleDeveloperAccountUsageSync(item.id, item.apple_id, runningStatus.lastLoginIp || "");
        if (!access.trialStarted) access = { ...access, allowed: true, trialStarted: true, firstLoginAt: runningStatus.authenticatedAt || new Date().toISOString() };
      }
      return { ...publicDeveloperAccount(item), access, appleAuthenticated: !!sameRunningAccount };
    }));
    return { success: true, username: identity.username, accounts };
  } catch (error) { return { success: false, error: error.message }; }
});

function normalizeDeveloperAccountAppStatus(item = {}) {
  const boolValue = value => value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
  const syncAgeRaw = item.syncAgeSeconds ?? item.sync_age_seconds;
  const syncAge = Number(syncAgeRaw);
  const latestVersion = String(item.latestVersion || item.latest_version || "");
  const listedAt = String(item.listedAt || item.listed_at || "");
  const checkedAt = String(item.checkedAt || item.checked_at || "");
  return {
    id: String(item.id || item.app_id || item.appId || ""),
    name: String(item.name || item.app_name || item.appName || "未命名 App"),
    bundleId: String(item.bundle_id || item.bundleId || ""),
    updatedAt: String(item.updatedAt || item.updated_at || ""),
    listed: boolValue(item.listed),
    latestVersion,
    latest_version: latestVersion,
    listedAt,
    listed_at: listedAt,
    checkedAt,
    checked_at: checkedAt,
    syncAgeSeconds: Number.isFinite(syncAge) ? syncAge : null,
    needsRefresh: boolValue(item.needsRefresh ?? item.needs_refresh),
  };
}

ipcMain.handle("developer-account-apps", async (_event, accountIdValue) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const accountId = String(accountIdValue || "").trim();
    const exists = withDeveloperAccountsDatabase(db => db.prepare("SELECT 1 FROM developer_accounts WHERE owner_key=? AND id=? AND COALESCE(deleted_at,'')='' ").get(identity.key, accountId));
    if (!exists) throw new Error("开发者账户不存在");
    const noSyncedAppsMessage = "还未同步账户 App，请启动证书管理登录账户并同步 App";
    const candidates = [
      `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/apps`,
      `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/app-ids`,
    ];
    let lastError = "服务器暂未返回 App 列表";
    let notFound = false;
    for (const apiPath of candidates) {
      const response = await authServerFetch(apiPath, { credentials: "include", signal: AbortSignal.timeout(10000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 404) {
          notFound = true;
          lastError = noSyncedAppsMessage;
          continue;
        }
        lastError = body.error || `App 列表读取失败 (${response.status})`;
        continue;
      }
      const source = body.apps || body.data?.apps || body.data || [];
      const apps = (Array.isArray(source) ? source : []).map(normalizeDeveloperAccountAppStatus).filter(item => /^\d{5,20}$/.test(item.id));
      return { success: true, apps };
    }
    return { success: false, error: notFound ? noSyncedAppsMessage : lastError };
  } catch (error) { return { success: false, error: error.message || "App 列表读取失败" }; }
});

ipcMain.handle("developer-account-app-status-refresh", async (_event, payload = {}) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const accountId = String(payload.accountId || "").trim();
    const appId = String(payload.appId || "").trim();
    if (!/^\d{5,20}$/.test(appId)) return { success: false, error: "App ID 格式无效" };
    const exists = withDeveloperAccountsDatabase(db => db.prepare("SELECT 1 FROM developer_accounts WHERE owner_key=? AND id=? AND COALESCE(deleted_at,'')='' ").get(identity.key, accountId));
    if (!exists) throw new Error("开发者账户不存在");
    const response = await authServerFetch(
      `/api/developer-sync/accounts/${encodeURIComponent(accountId)}/apps/${encodeURIComponent(appId)}/status`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
        signal: AbortSignal.timeout(120000),
      },
    );
    const body = await response.json().catch(() => ({}));
    const app = body.app ? normalizeDeveloperAccountAppStatus(body.app) : null;
    if (!response.ok || !body.success) {
      return { success: false, error: body.error || `App 状态刷新失败 (${response.status})`, app };
    }
    return { success: true, app, lookup: body.lookup || null, warning: body.warning || "" };
  } catch (error) {
    return { success: false, error: error.message || "App 状态刷新失败" };
  }
});

const BROWSER_APP_STORE_REGIONS = "AE,AF,AG,AI,AL,AM,AO,AR,AT,AU,AZ,BA,BB,BD,BE,BF,BG,BH,BJ,BM,BN,BO,BR,BS,BT,BW,BY,BZ,CA,CD,CG,CH,CI,CL,CM,CN,CO,CR,CV,CY,CZ,DE,DK,DM,DO,DZ,EC,EE,EG,ES,FI,FJ,FM,FR,GA,GB,GD,GE,GH,GM,GN,GR,GT,GW,GY,HK,HN,HR,HU,ID,IE,IL,IN,IQ,IS,IT,JM,JO,JP,KE,KG,KH,KN,KR,KW,KY,KZ,LA,LB,LC,LI,LK,LR,LT,LU,LV,LY,MA,MD,ME,MG,MK,ML,MM,MN,MO,MR,MS,MT,MU,MV,MW,MX,MY,MZ,NA,NE,NG,NI,NL,NO,NP,NR,NZ,OM,PA,PE,PG,PH,PK,PL,PT,PW,PY,QA,RO,RS,RU,RW,SA,SB,SC,SE,SG,SI,SK,SL,SN,SR,ST,SV,SZ,TC,TD,TH,TJ,TM,TN,TO,TR,TT,TW,TZ,UA,UG,US,UY,UZ,VC,VE,VG,VN,VU,WS,YE,ZA,ZM,ZW".split(",");

ipcMain.handle("developer-account-app-region-scan", async (_event, payload = {}) => {
  const appId = String(payload.appId || "").trim();
  if (!/^\d{5,20}$/.test(appId)) return { success: false, error: "App ID 格式无效" };
  try {
    const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });
    const rows = new Array(BROWSER_APP_STORE_REGIONS.length); let cursor = 0;
    const worker = async () => { while (cursor < BROWSER_APP_STORE_REGIONS.length) {
      const index = cursor++; const code = BROWSER_APP_STORE_REGIONS[index];
      const regionName = code === "CN" ? "中国大陆" : names.of(code) || code;
      try {
        const response = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${code.toLowerCase()}`, { signal: AbortSignal.timeout(12000) });
        const body = await response.json().catch(() => ({}));
        const item = (body.results || []).find(value => String(value.trackId || value.collectionId || "") === appId);
        const url = item?.trackViewUrl || (item ? `https://apps.apple.com/${code.toLowerCase()}/app/id${encodeURIComponent(appId)}` : "");
        rows[index] = {
          code,
          name: regionName,
          listed: !!item,
          status: item ? "App Store 可检索" : "未返回当前 App",
          url,
          version: String(item?.version || ""),
        };
      } catch (error) { rows[index] = { code, name: regionName, listed: false, status: error?.name === "TimeoutError" ? "查询超时" : "地区查询失败" }; }
    }};
    await Promise.all(Array.from({ length: 10 }, worker));
    return { success: true, rows };
  } catch (error) { return { success: false, error: error.message || "全球地区检索失败" }; }
});

function safeAppRegionQRLogoURL(value) {
  const text = String(value || "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text : "";
}

async function appRegionQRLogoPNG(payload = {}, size = 96) {
  const iconUrl = safeAppRegionQRLogoURL(payload.iconUrl || payload.appIconUrl || payload.logoUrl);
  if (iconUrl) {
    try {
      const response = await fetch(iconUrl, { signal: AbortSignal.timeout(10000), redirect: "follow" });
      if (response.ok) {
        const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
        if (!image.isEmpty()) return image.resize({ width: size, height: size, quality: "best" }).toPNG();
      }
    } catch {}
  }
  const initial = Array.from(String(payload.appName || "App").trim())[0] || "A";
  const svg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="#2563eb"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(size * 0.5)}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-weight="700" fill="#fff">${xmlEscape(initial)}</text>
  </svg>`);
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
  return image.resize({ width: size, height: size, quality: "best" }).toPNG();
}

function writePNGRGBA(png, x, y, rgba) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = ((png.width * y) + x) << 2;
  png.data[offset] = rgba[0];
  png.data[offset + 1] = rgba[1];
  png.data[offset + 2] = rgba[2];
  png.data[offset + 3] = rgba[3];
}

function isInsideRoundedRect(localX, localY, width, height, radius) {
  const cornerX = localX < radius ? radius : localX > width - radius ? width - radius : localX;
  const cornerY = localY < radius ? radius : localY > height - radius ? height - radius : localY;
  const dx = localX - cornerX;
  const dy = localY - cornerY;
  return dx * dx + dy * dy <= radius * radius;
}

function drawPNGRoundedRect(png, x, y, width, height, radius, rgba) {
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      if (isInsideRoundedRect(localX, localY, width - 1, height - 1, radius)) {
        writePNGRGBA(png, x + localX, y + localY, rgba);
      }
    }
  }
}

function compositePNG(dest, source, x, y) {
  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      const destX = x + sourceX;
      const destY = y + sourceY;
      if (destX < 0 || destY < 0 || destX >= dest.width || destY >= dest.height) continue;
      const sourceOffset = ((source.width * sourceY) + sourceX) << 2;
      const destOffset = ((dest.width * destY) + destX) << 2;
      const alpha = source.data[sourceOffset + 3] / 255;
      dest.data[destOffset] = Math.round(source.data[sourceOffset] * alpha + dest.data[destOffset] * (1 - alpha));
      dest.data[destOffset + 1] = Math.round(source.data[sourceOffset + 1] * alpha + dest.data[destOffset + 1] * (1 - alpha));
      dest.data[destOffset + 2] = Math.round(source.data[sourceOffset + 2] * alpha + dest.data[destOffset + 2] * (1 - alpha));
      dest.data[destOffset + 3] = 255;
    }
  }
}

async function createAppRegionQRBuffer(payload = {}, width = 360) {
  const url = String(payload.url || "").trim();
  const qrBuffer = await QRCode.toBuffer(url, { type: "png", width, margin: 2, errorCorrectionLevel: "H" });
  try {
    const qr = PNG.sync.read(qrBuffer);
    const logoSize = Math.max(44, Math.round(qr.width * 0.14));
    const padding = Math.max(8, Math.round(qr.width * 0.025));
    const frameSize = logoSize + padding * 2;
    const frameX = Math.round((qr.width - frameSize) / 2);
    const frameY = Math.round((qr.height - frameSize) / 2);
    drawPNGRoundedRect(qr, frameX, frameY, frameSize, frameSize, Math.round(frameSize * 0.2), [255, 255, 255, 255]);
    const logo = PNG.sync.read(await appRegionQRLogoPNG(payload, logoSize));
    compositePNG(qr, logo, frameX + padding, frameY + padding);
    return PNG.sync.write(qr);
  } catch {
    return qrBuffer;
  }
}

ipcMain.handle("developer-account-app-region-qr-save", async (_event, payload = {}) => {
  try {
    const url = String(payload.url || "").trim();
    if (!/^https:\/\/apps\.apple\.com\//i.test(url)) throw new Error("App 下载链接无效");
    const appName = safeArchiveSegment(payload.appName || "App", "App");
    const countryName = safeArchiveSegment(payload.countryName || payload.countryCode || "地区", "地区");
    const buffer = await createAppRegionQRBuffer(payload, 720);
    const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, {
      defaultPath: `${appName}-${countryName}-下载二维码.png`,
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    fs.writeFileSync(save.filePath, buffer);
    return { success: true, path: save.filePath };
  } catch (error) {
    return { success: false, error: error.message || "二维码保存失败" };
  }
});

ipcMain.handle("developer-account-app-region-qr-preview", async (_event, payload = {}) => {
  try {
    const url = String(payload.url || "").trim();
    if (!/^https:\/\/apps\.apple\.com\//i.test(url)) throw new Error("App 下载链接无效");
    const qrDataURL = `data:image/png;base64,${(await createAppRegionQRBuffer(payload, 360)).toString("base64")}`;
    return { success: true, url, qrDataURL };
  } catch (error) {
    return { success: false, error: error.message || "二维码生成失败" };
  }
});

ipcMain.handle("developer-account-app-region-link-copy", async (_event, payload = {}) => {
  try {
    const url = String(payload.url || "").trim();
    if (!/^https:\/\/apps\.apple\.com\//i.test(url)) throw new Error("App 下载链接无效");
    clipboard.writeText(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "下载链接复制失败" };
  }
});

ipcMain.handle("developer-accounts-certificate-manager-running", async () => {
  const running = isStandaloneCertificateManagerRunning();
  const status = running ? readCertificateManagerStatusFile() : null;
  if (running && status?.authenticated === true && status?.accountId && status?.appleId) {
    scheduleDeveloperAccountUsageSync(status.accountId, status.appleId, status.lastLoginIp || "");
  }
  return { running, accountId: running ? String(status?.accountId || "") : "", authenticated: running && status?.authenticated === true, appVersion: running ? String(status?.appVersion || "") : "", protocolVersion: running ? Number(status?.protocolVersion || 0) : 0, instanceId: running ? String(status?.instanceId || "") : "" };
});

ipcMain.handle("developer-accounts-certificate-manager-force-close", async () => {
  try {
    return forceCloseStandaloneCertificateManager();
  } catch (error) {
    clearCertificateManagerStatus();
    return { success: false, error: error.message || "强制关闭失败" };
  }
});

ipcMain.handle("developer-accounts-download-certificate", async (_event, id) => {
  try {
    const identity = await requireDesktopUserIdentity();
    migrateDeveloperAccountsJSON();
    const row = withDeveloperAccountsDatabase(db => db.prepare("SELECT id,p12_password FROM developer_accounts WHERE owner_key=? AND id=?").get(identity.key, String(id || "")));
    if (!row) throw new Error("账户不存在或已被删除");
    const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(String(id || ""))}/artifact-package-options`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `证书选项读取失败 (${response.status})`);
    return { success: true, bundles: Array.isArray(body.bundles) ? body.bundles : [], p12Password: String(body.p12Password || row.p12_password || DEFAULT_P12_PASSWORD) };
  } catch (error) {
    return { success: false, error: error.message || "下载证书失败" };
  }
});

ipcMain.handle("developer-accounts-update-p12-password", async (_event, payload = {}) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const accountId = String(payload.accountId || "");
    const p12Password = String(payload.p12Password || "").trim();
    if (!p12Password) throw new Error("P12 密码不能为空");
    const row = withDeveloperAccountsDatabase(db => {
      const existing = db.prepare("SELECT id FROM developer_accounts WHERE owner_key=? AND id=?").get(identity.key, accountId);
      if (!existing) return null;
      db.prepare("UPDATE developer_accounts SET p12_password=? WHERE owner_key=? AND id=?").run(p12Password, identity.key, accountId);
      return existing;
    });
    if (!row) throw new Error("账户不存在或已被删除");
    const synced = await syncDeveloperAccountP12Password(accountId, p12Password);
    if (!synced.success && !synced.skipped) return { success: false, error: synced.error || "服务器 P12 密码同步失败" };
    return { success: true, p12Password };
  } catch (error) { return { success: false, error: error.message || "P12 密码修改失败" }; }
});

ipcMain.handle("developer-accounts-update-password", async (_event, payload = {}) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const accountId = String(payload.accountId || "").trim();
    const password = String(payload.password || "");
    const remark = String(payload.remark || "").trim().slice(0, 80);
    if (!accountId) throw new Error("账户不存在或已被删除");
    const row = withDeveloperAccountsDatabase(db => {
      const existing = db.prepare("SELECT id,apple_id,remark,proxy_json,browser_proxy_key,connection_mode FROM developer_accounts WHERE owner_key=? AND id=? AND COALESCE(deleted_at,'')=''").get(identity.key, accountId);
      if (!existing) return null;
      let storedProxy = null;
      try { storedProxy = normalizeDeveloperAccountProxy(JSON.parse(existing.proxy_json || "null")); } catch {}
      const requestedMode = String(payload.connectionMode || payload.mode || "").trim().toLowerCase();
      const fallbackMode = String(existing.connection_mode || "").trim().toLowerCase()
        || (existing.browser_proxy_key ? "browser_proxy" : (storedProxy ? "custom_proxy" : "direct"));
      const connectionMode = requestedMode || fallbackMode;
      if (!["direct", "browser_proxy", "custom_proxy", "proxy", "code"].includes(connectionMode)) throw new Error("请选择正确的连接方式");
      const normalizedMode = connectionMode === "proxy" ? "custom_proxy" : connectionMode === "code" ? "direct" : connectionMode;
      const browserProxyKey = normalizedMode === "browser_proxy"
        ? String(payload.browserProxyKey || payload.browserProxyId || existing.browser_proxy_key || "").trim()
        : "";
      const rawProxy = payload.proxy && typeof payload.proxy === "object" ? payload.proxy : null;
      let proxy = normalizeDeveloperAccountProxy(rawProxy);
      if (proxy && storedProxy && (String(rawProxy?.password || "") === "••••••" || (payload.keepProxyPassword && !String(rawProxy?.password || "")))) {
        proxy.password = storedProxy.password || "";
      }
      if (!proxy && normalizedMode === "custom_proxy") proxy = storedProxy;
      if (normalizedMode === "browser_proxy" && !browserProxyKey) throw new Error("请选择浏览器代理");
      const browserProxy = normalizedMode === "browser_proxy" ? findBrowserProxyByKey(browserProxyKey) : null;
      if (normalizedMode === "browser_proxy" && !browserProxy) throw new Error("所选浏览器代理不存在或已被删除");
      if (normalizedMode === "custom_proxy" && !proxy) throw new Error("自定义代理必须填写有效代理地址和端口");
      const storedPassword = password ? encryptLocalSecret(password) : String(existing.password || "");
      db.prepare("UPDATE developer_accounts SET password=?, remark=?, proxy_json=?, browser_proxy_key=?, connection_mode=? WHERE owner_key=? AND id=?").run(
        storedPassword,
        remark || existing.remark || "",
        normalizedMode === "custom_proxy" ? JSON.stringify(proxy) : "",
        normalizedMode === "browser_proxy" ? browserProxyKey : "",
        normalizedMode,
        identity.key,
        accountId,
      );
      return {
        ...existing,
        proxy: normalizedMode === "browser_proxy" ? browserProxy : normalizedMode === "custom_proxy" ? proxy : null,
        connectionMode: normalizedMode,
        browserProxyKey,
        password: decryptDeveloperAccountPassword(storedPassword),
        passwordUpdated: !!password,
      };
    });
    if (!row) throw new Error("账户不存在或已被删除");
    if (identity.key === appleDeveloperOwnerKey && accountId === appleDeveloperRecordId) {
      if (row.password) appleDeveloperLaunchPassword = row.password;
      appleDeveloperNetwork = null;
      appleDeveloperNetworkRestoreAttempted = false;
      appleDeveloperNetworkRestoreError = null;
      saveAppleDeveloperNetwork(row.proxy || { enabled: false });
    }
    return { success: true, appleId: String(row.apple_id || ""), passwordUpdated: !!row.passwordUpdated };
  } catch (error) {
    return { success: false, error: error.message || "开发者账户配置更新失败" };
  }
});

ipcMain.handle("developer-accounts-download-certificate-package", async (_event, payload = {}) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const accountId = String(payload.accountId || "");
    const bundleId = String(payload.bundleId || "").trim();
    const mode = String(payload.mode || "all");
    const row = withDeveloperAccountsDatabase(db => db.prepare("SELECT id,apple_id,p12_password FROM developer_accounts WHERE owner_key=? AND id=?").get(identity.key, accountId));
    if (!row) throw new Error("账户不存在或已被删除");
    const p12Password = String(row.p12_password || DEFAULT_P12_PASSWORD);
    const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(accountId)}/artifact-package`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/zip, application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId, selectedBundleId: bundleId, mode, p12Password, packageLayout: "apple_id_root_formal_test_bundle" }),
      signal: AbortSignal.timeout(30000),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
      throw new Error(body.error || `证书文件下载失败 (${response.status})`);
    }
    const data = repackageDeveloperCertificateZip(Buffer.from(await response.arrayBuffer()), { appleId: row.apple_id, bundleId: bundleId || "全部包名", p12Password });
    if (!data.length) throw new Error("服务器返回了空的证书包");
    const safeAppleId = safeArchiveSegment(row.apple_id || "AppleID");
    const save = await dialog.showSaveDialog({ defaultPath: `${safeAppleId}的证书.zip`, filters: [{ name: "ZIP 文件", extensions: ["zip"] }] });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    fs.writeFileSync(save.filePath, data);
    return { success: true, path: save.filePath };
  } catch (error) {
    return { success: false, error: error.message || "证书文件下载失败" };
  }
});

ipcMain.handle("developer-accounts-add", async (_event, payload = {}) => {
  try {
    const identity = await requireDesktopUserIdentity();
    const appleId = String(payload.appleId || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const remark = String(payload.remark || "").trim().slice(0, 80);
    const connectionMode = String(payload.connectionMode || payload.mode || "").trim().toLowerCase() || "custom_proxy";
    const accountCode = String(payload.accountCode || payload.code || "").trim().slice(0, 32);
    const browserProxyKey = String(payload.browserProxyKey || payload.browserProxyId || "").trim();
    const proxy = normalizeDeveloperAccountProxy(payload.proxy);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(appleId)) throw new Error("请输入有效的 Apple ID 邮箱");
    if (!password) throw new Error("请输入 Apple ID 密码");
    if (!["direct", "browser_proxy", "custom_proxy", "proxy", "code"].includes(connectionMode)) throw new Error("请选择正确的连接方式");
    const normalizedMode = connectionMode === "proxy" ? "custom_proxy" : connectionMode === "code" ? "direct" : connectionMode;
    if (normalizedMode === "browser_proxy" && !browserProxyKey) throw new Error("请选择浏览器代理");
    if (normalizedMode === "browser_proxy" && !findBrowserProxyByKey(browserProxyKey)) throw new Error("所选浏览器代理不存在或已被删除");
    if (normalizedMode === "custom_proxy" && !proxy) throw new Error("自定义代理必须填写有效代理地址和端口");
    migrateDeveloperAccountsJSON();
    withDeveloperAccountsDatabase(db => {
      db.prepare("INSERT INTO developer_accounts(owner_key,id,apple_id,password,remark,created_at,deleted_at,proxy_json,browser_proxy_key,connection_mode,account_code) VALUES(?,?,?,?,?,?, '',?,?,?,?) ON CONFLICT(owner_key,apple_id) DO UPDATE SET password=excluded.password, remark=excluded.remark, proxy_json=excluded.proxy_json, browser_proxy_key=excluded.browser_proxy_key, connection_mode=excluded.connection_mode, account_code=excluded.account_code, deleted_at=''").run(identity.key, crypto.randomUUID(), appleId, encryptLocalSecret(password), remark, new Date().toISOString(), normalizedMode === "custom_proxy" ? JSON.stringify(proxy) : "", normalizedMode === "browser_proxy" ? browserProxyKey : "", normalizedMode, accountCode);
    });
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("developer-accounts-remove", async (_event, id) => {
  try {
    const identity = await requireDesktopUserIdentity();
    migrateDeveloperAccountsJSON();
    const accountId = String(id || "");
    const deletedAt = new Date().toISOString();
    const row = withDeveloperAccountsDatabase(db => {
      const existing = db.prepare("SELECT id,apple_id FROM developer_accounts WHERE owner_key=? AND id=?").get(identity.key, accountId);
      if (!existing) return null;
      return existing;
    });
    if (!row) throw new Error("账户不存在或已被删除");
    const synced = await markDeveloperAccountDeleted(accountId, { appleId: row.apple_id, ownerKey: identity.key, deletedAt });
    if (!synced.success) {
      return {
        success: false,
        deleteSynced: false,
        deleteSyncError: synced.error || "服务器删除状态同步失败",
        error: synced.error || "服务器删除状态同步失败",
      };
    }
    withDeveloperAccountsDatabase(db => {
      db.prepare("UPDATE developer_accounts SET deleted_at=? WHERE owner_key=? AND id=?").run(deletedAt, identity.key, accountId);
    });
    await clearDeveloperAccountCaches(crypto.createHash("sha256").update(`${identity.key}:${accountId}`).digest("hex").slice(0, 24), row.apple_id);
    return {
      success: true,
      deleteSynced: true,
      deleteSyncError: "",
      releasedToUser: synced.releasedToUser || null,
      alreadyReleased: synced.alreadyReleased === true,
    };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("developer-accounts-launch", async (event, id) => {
  try {
    const identity = await requireDesktopUserIdentity();
    migrateDeveloperAccountsJSON();
    const row = withDeveloperAccountsDatabase(db => db.prepare("SELECT * FROM developer_accounts WHERE owner_key=? AND id=?").get(identity.key, String(id || "")));
    if (!row) throw new Error("账户不存在或已被删除");
    const accessMap = await readAppleDeveloperAccessMap();
    const access = accessMap?.[String(row.id || "")] || null;
    if (access && access.allowed === false) {
      return {
        success: false,
        expired: true,
        renewalRequired: true,
        accountId: String(row.id || ""),
        appleId: String(row.apple_id || ""),
        access,
        error: access.authorizationExpired ? "核验码已到期，请先续费" : "账户免费试用已到期，请先续费",
      };
    }
    let connectionMode = String(row.connection_mode || "direct").toLowerCase();
    let launchProxy = resolveDeveloperAccountLaunchProxy(row);
    if (!launchProxy && (connectionMode === "direct" || connectionMode === "code")) {
      const savedProxy = normalizeDeveloperAccountProxy(readAppleDeveloperNetworkFile(developerAccountKey(identity.key, row.id, row.apple_id)));
      if (savedProxy) {
        launchProxy = savedProxy;
        connectionMode = "custom_proxy";
        withDeveloperAccountsDatabase(db => db.prepare("UPDATE developer_accounts SET proxy_json=?, browser_proxy_key='', connection_mode='custom_proxy' WHERE owner_key=? AND id=?")
          .run(JSON.stringify(savedProxy), identity.key, row.id));
      }
    }
    if (connectionMode === "browser_proxy" && !launchProxy) throw new Error("所选浏览器代理不存在，请重新绑定");
    if ((connectionMode === "custom_proxy" || connectionMode === "proxy") && !launchProxy) throw new Error("该账户使用自定义代理模式，请先补充有效代理配置");
    if (launchProxy) {
      const proxy = { ...launchProxy, enabled: true };
      const detected = await detectIPStandalone(proxy);
      if (!isProxyDetectOK(detected)) throw new Error(`启动前代理检测失败：${detected?.statusText || "代理不可达，请检查后重试"}`);
      launchProxy = {
        ...proxy,
        lastVerifiedIp: String(detected.ip || proxy.lastVerifiedIp || proxy.outIp || ""),
        country: String(detected.country || proxy.country || ""),
        region: String(detected.region || proxy.region || ""),
        city: String(detected.city || proxy.city || ""),
        isp: String(detected.isp || proxy.isp || ""),
      };
    }
    const launchAccount = {
      id: String(row.id || ""),
      appleId: String(row.apple_id || ""),
      password: decryptDeveloperAccountPassword(row.password),
      remark: String(row.remark || ""),
      p12Password: String(row.p12_password || DEFAULT_P12_PASSWORD),
      connectionMode,
      accountCode: String(row.account_code || ""),
      browserProxyKey: String(row.browser_proxy_key || ""),
      proxy: launchProxy,
    };
    await ensureCertificateManagerLaunchSlot(launchAccount);
    const launched = await openStandaloneCertificateManager({
      ownerKey: identity.key,
      username: identity.username,
      userId: identity.userId,
      source: "browser",
      account: launchAccount,
    });
    if (!launched?.success && launched?.passwordRequired) return { ...launched, accountId: launchAccount.id, appleId: launchAccount.appleId };
    return launched;
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("developer-accounts-activate", async (_event, payload = {}) => {
  try {
    await requireDesktopUserIdentity();
    const accountId = String(payload.accountId || "");
    const appleId = String(payload.appleId || payload.apple_id || "").trim().toLowerCase();
    const code = String(payload.verificationCode || "").trim().toUpperCase();
    const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(accountId)}/activate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verificationCode: code, appleId }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `开通失败 (${response.status})`);
    return { success: true, access: body.access };
  } catch (error) {
    return { success: false, error: error.message || "核验码开通失败" };
  }
});

ipcMain.handle("app-store-connect-apps", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const { body } = await appStoreConnectFetch("/iris/v1/apps?include=appStoreIcon,displayableVersions&limit=200&filter[removed]=false&fields[apps]=name,bundleId,primaryLocale,sku,removed,appStoreLegacyStatus,marketplace,appStoreIcon,displayableVersions&fields[appStoreVersions]=platform,versionString,appStoreState,storeIcon,watchStoreIcon,isWatchOnly,createdDate,appVersionState&limit[displayableVersions]=20");
    const apps = normalizeAppStoreApps(body);
    let syncWarning = "";
    try {
      const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/apps`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apps: apps.map(item => ({ id: item.id, name: item.name, bundleId: item.bundleId })) }), signal: AbortSignal.timeout(10000) });
      const synced = await response.json().catch(() => ({}));
      if (!response.ok || synced.success === false) syncWarning = synced.error || `App 同步失败 (${response.status})`;
    } catch (error) { syncWarning = error.message || "App 同步失败"; }
    return { success: true, apps, total: Number(body?.meta?.paging?.total || 0), syncWarning };
  } catch (error) {
    return { success: false, code: error.code || "", status: Number(error.status || 0), error: error.message || "App 列表读取失败" };
  }
});

ipcMain.handle("app-store-connect-bundle-ids", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const { body } = await appStoreConnectFetch("/iris/v1/ascBundleIds?limit=2000");
    return { success: true, bundleIds: normalizeAppStoreBundleIds(body), total: Number(body?.meta?.paging?.total || 0) };
  } catch (error) {
    return { success: false, error: error.message || "套装 ID 读取失败" };
  }
});

ipcMain.handle("app-store-connect-primary-locales", async () => ({
  success: true,
  locales: APP_STORE_LOCALIZATION_OPTIONS,
}));

ipcMain.handle("app-store-connect-app-detail", async (_event, payload) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const generation = appleDeveloperContextGeneration;
    const accountKey = appleDeveloperAccountKey;
    const teamId = readSelectedAppleDeveloperTeam()?.id || "";
    const request = typeof payload === "object" && payload ? payload : { appId: payload };
    const id = String(request.appId || "").trim();
    if (!id) throw new Error("缺少 App ID");
    const detail = await loadAppStoreConnectAppDetail(id, request.versionId || "", { mode: request.mode || "" });
    if (!appleDeveloperContextIsCurrent(generation, accountKey) || teamId !== (readSelectedAppleDeveloperTeam()?.id || "")) throw new Error("Apple 账户或团队已切换，请重新打开 App");
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "App 详情读取失败" };
  }
});

ipcMain.handle("app-store-connect-save-age-rating", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const ageRating = await saveAppStoreConnectAgeRating(payload);
    return { success: true, ageRating };
  } catch (error) {
    return { success: false, error: error.message || "年龄分级保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-create-app-version", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await createAppStoreConnectAppVersion(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "新版本创建失败" };
  }
});

ipcMain.handle("app-store-connect-build-candidates", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const builds = await loadAppStoreConnectBuildCandidates(payload);
    return { success: true, builds };
  } catch (error) {
    return { success: false, error: error.message || "构建版本读取失败" };
  }
});

ipcMain.handle("app-store-connect-save-version-build", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await saveAppStoreConnectAppVersionBuild(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "构建版本保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-save-build-encryption", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await saveAppStoreConnectBuildEncryption(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "出口合规证明保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-testflight", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const contextToken = `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`;
    if (payload.contextToken && payload.contextToken !== contextToken) throw new Error("Apple 账户或团队已切换，请重新打开 TestFlight");
    if (payload.action !== "overview" && !payload.contextToken) throw new Error("请先读取当前 App 的 TestFlight 信息");
    const fetch = appStoreConnectMutationFetch();
    const service = createTestFlightService((path, options = {}) => fetch(path, { ...options, priority: payload.action === "metrics" ? "background" : "interactive" }));
    const data = await service.run(payload.action, payload);
    return { success: true, contextToken, data };
  } catch (error) { return { success: false, error: error.message || "TestFlight 请求失败" }; }
});

const appReviewAttachmentTasks = new Map();
ipcMain.handle("app-store-connect-review-attachments", async (event, payload = {}) => {
  const key = `${event.sender.id}:${String(payload.requestId || "")}`;
  if (payload.action === "cancel") {
    appReviewAttachmentTasks.get(key)?.controller.abort();
    return { success: true };
  }
  let reserved = false;
  try {
    if (!["list", "upload", "delete"].includes(payload.action)) throw new Error("不支持的附件操作");
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const contextToken = `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`;
    if (payload.contextToken && payload.contextToken !== contextToken) throw new Error("Apple 账户或团队已切换，请重新打开 App");
    if (payload.action !== "list" && !payload.contextToken) throw new Error("请先读取当前版本的附件列表");
    const reservation = `${contextToken}:${payload.appId}:${payload.versionId}`;
    if ([...appReviewAttachmentTasks.values()].some(task => task.reservation === reservation)) throw new Error("该版本的附件正在处理，请等待完成");
    const controller = new AbortController();
    const fetch = appStoreConnectMutationFetch();
    const ses = session.fromPartition(appleDeveloperPartitionForAccount(appleDeveloperAccountKey));
    if (payload.action !== "list") {
      if (!payload.requestId || appReviewAttachmentTasks.has(key)) throw new Error("附件上传请求无效或已在进行中");
      appReviewAttachmentTasks.set(key, { controller, reservation });
      reserved = true;
    }
    const service = createReviewAttachmentService({
      fetch, signal: controller.signal,
      chooseFiles: extensions => dialog.showOpenDialog(certificateManagerWindow || undefined, { title: "选择 App 审核附件（最多 1 个）", properties: ["openFile"], filters: [{ name: "审核附件（含演示视频）", extensions }] }),
      upload: async (operation, buffer, filePath, signal) => {
        // Confirm the captured account before sending bytes to Apple's upload host.
        if (contextToken !== `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`) throw new Error("Apple 账户或团队已切换，附件上传已停止");
        await uploadAppStoreOperation(operation, buffer, filePath, { session: ses, signal });
      },
    });
    const result = await service.run(payload.action, payload);
    if (contextToken !== `${appleDeveloperContextGeneration}:${readSelectedAppleDeveloperTeam()?.id || ""}`) throw new Error("Apple 账户或团队已切换，请重新打开 App 确认附件");
    return { success: !result.error, contextToken, ...result };
  } catch (error) { return { success: false, error: error.name === "AbortError" ? "附件上传已取消，请刷新列表确认 Apple 已接收的附件" : error.message || "审核附件操作失败" }; }
  finally { if (reserved) appReviewAttachmentTasks.delete(key); }
});

ipcMain.handle("app-store-connect-review-submission-status", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const submissionId = String(payload.submissionId || "").trim();
    if (!submissionId) throw new Error("缺少审核提交 ID");
    const fetch = appStoreConnectMutationFetch();
    const { body } = await fetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}?include=appStoreVersionForReview,items&limit[items]=200`);
    const row = jsonApiRows(body)[0];
    if (row?.id !== submissionId) throw new Error("Apple 未返回对应审核提交状态");
    const submission = normalizeReviewSubmissions(body)[0];
    submission.items = relationshipData(row, "items").map(ref => findIncluded(body, "reviewSubmissionItems", ref.id)).filter(Boolean)
      .map(item => ({ id: item.id, state: String(item.attributes?.state || "") }));
    return { success: true, submission };
  } catch (error) { return { success: false, error: error.message || "审核状态刷新失败" }; }
});

ipcMain.handle("app-store-connect-review-submission-detail", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await loadAppStoreConnectReviewSubmissionDetail(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "审核详情读取失败" };
  }
});

ipcMain.handle("app-store-connect-update-review-submission-item", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, ...(await updateAppStoreConnectReviewSubmissionItem(payload)) };
  } catch (error) {
    return { success: false, error: error.message || "更新审核项目失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-resubmit-review", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, ...(await resubmitAppStoreConnectReview(payload)) };
  } catch (error) {
    return { success: false, error: error.message || "重新提交审核失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-review-draft-message", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const draft = await loadResolutionCenterDraftMessage(payload.threadId);
    return { success: true, draft };
  } catch (error) {
    return { success: false, error: error.message || "审核回复草稿读取失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-save-review-draft-message", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const savedDraft = payload.draftId
      ? await updateResolutionCenterDraftMessage(payload.draftId, payload.messageBody)
      : await createResolutionCenterDraftMessage(payload.threadId, payload.messageBody);
    await deleteResolutionCenterMessageAttachments(payload.attachmentIdsToDelete);
    let draft = { ...savedDraft, threadId: String(savedDraft.threadId || payload.threadId || "") };
    if (payload.threadId) {
      try { draft = await loadResolutionCenterDraftMessage(payload.threadId) || draft; } catch {}
    }
    return { success: true, draft };
  } catch (error) {
    return { success: false, error: error.message || "审核回复草稿保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-upload-review-message-attachments", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await uploadResolutionCenterMessageAttachments(payload);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "审核回复附件上传失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-delete-review-message-attachments", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const deletedIds = await deleteResolutionCenterMessageAttachments(payload.attachmentIds);
    const draft = payload.threadId ? await loadResolutionCenterDraftMessage(payload.threadId).catch(() => null) : null;
    return { success: true, deletedIds, draft };
  } catch (error) {
    return { success: false, error: error.message || "审核回复附件删除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-delete-review-draft-message", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await deleteResolutionCenterDraftMessage(payload.draftId);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "审核回复草稿删除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-send-review-message", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const threadId = String(payload.threadId || "").trim();
    const messageBody = String(payload.messageBody || "");
    let draftId = String(payload.draftId || "").trim();
    if (!draftId) {
      const draft = await createResolutionCenterDraftMessage(threadId, messageBody);
      draftId = String(draft.id || "");
    } else if (payload.saveDraft) {
      await updateResolutionCenterDraftMessage(draftId, messageBody);
    }
    if (!draftId) throw new Error("Apple 未返回审核回复草稿 ID");
    await deleteResolutionCenterMessageAttachments(payload.attachmentIdsToDelete);
    const result = await sendResolutionCenterDraftMessage(draftId);
    return { success: true, draftId, result };
  } catch (error) {
    return { success: false, error: error.message || "回复 App 审核失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

function normalizeInAppPurchase(row = {}, body = {}) {
  const attributes = row.attributes || {};
  // The purchase-level state describes metadata completeness, while App Store
  // Connect displays the state of the related in-app-purchase version. Always
  // prefer the version returned by `include=versions`; do not synthesize a UI
  // state from stateGroup or MISSING_METADATA.
  const rawStatus = String(attributes.state || attributes.inAppPurchaseState || attributes.status || "").toUpperCase();
  const stateGroup = String(attributes.stateGroup || "").toUpperCase();
  const versionRef = relationshipData(row, "versions")[0];
  const versionRow = versionRef ? findIncluded(body, "inAppPurchaseVersions", versionRef.id) : null;
  const versionState = String(versionRow?.attributes?.state || versionRow?.attributes?.status || "").toUpperCase();
  // App Store Connect's visible IAP workflow status is owned by the version.
  // Never expose the purchase-level MISSING_METADATA value as the product
  // status: it is a completeness signal and is not the label shown by ASC.
  const status = versionState || (rawStatus === "MISSING_METADATA" ? stateGroup : rawStatus) || stateGroup;
  return {
    id: String(row.id || ""),
    name: String(attributes.name || attributes.referenceName || ""),
    productId: String(attributes.productId || ""),
    type: String(attributes.inAppPurchaseType || attributes.type || ""),
    status,
    state: status,
    rawState: rawStatus,
    versionId: String(versionRef?.id || ""),
    versionState,
    stateGroup,
    familySharable: !!attributes.familySharable,
    reviewNote: String(attributes.reviewNote || ""),
  };
}

async function loadInAppPurchaseReviewDraft(appId, versionId) {
  appId = String(appId || "").trim();
  versionId = String(versionId || "").trim();
  if (!appId || !versionId) return null;
  const { body } = await appStoreConnectFetch(
    `/iris/v1/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview,items,lastUpdatedByActor,submittedByActor,createdByActor&limit=2000&limit[items]=0&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING`,
  );
  for (const submission of jsonApiRows(body)) {
    const submissionId = String(submission.id || "");
    if (!submissionId) continue;
    const itemsResult = await appStoreConnectFetch(
      `/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?include=inAppPurchaseVersion&limit=200`,
    );
    const item = jsonApiRows(itemsResult.body).find(row =>
      relationshipData(row, "inAppPurchaseVersion").some(ref => String(ref.id || "") === versionId)
    );
    if (item) return {
      submissionId,
      itemId: String(item.id || ""),
      itemState: String(item.attributes?.state || ""),
      submissionState: String(submission.attributes?.state || ""),
      createdDate: String(submission.attributes?.createdDate || ""),
      itemCount: Number(itemsResult.body?.meta?.paging?.total || jsonApiRows(itemsResult.body).length || 0),
    };
  }
  return null;
}

async function findReadyForReviewInAppPurchaseSubmission(appId) {
  const activeResult = await appStoreConnectFetch(
    `/iris/v1/apps/${encodeURIComponent(appId)}/reviewSubmissions?include=appStoreVersionForReview&limit=2000&filter[state]=READY_FOR_REVIEW`,
  );
  for (const submission of jsonApiRows(activeResult.body)) {
    const submissionId = String(submission.id || "");
    if (!submissionId) continue;
    const itemsResult = await appStoreConnectFetch(
      `/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?include=inAppPurchaseVersion,appStoreVersion&limit=200`,
    );
    const items = jsonApiRows(itemsResult.body);
    const hasInAppPurchase = items.some(row => relationshipData(row, "inAppPurchaseVersion")[0]);
    const hasAppVersion = items.some(row => relationshipData(row, "appStoreVersion")[0]);
    if (hasInAppPurchase && !hasAppVersion) return submissionId;
  }
  return "";
}

async function addInAppPurchaseToReview(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  const preferredSubmissionId = String(payload.submissionId || "").trim();
  if (!appId || !versionId) throw new Error("缺少 App 或内购版本 ID");
  if (!preferredSubmissionId) {
    const existing = await loadInAppPurchaseReviewDraft(appId, versionId);
    if (existing) return existing;
  }
  let submissionId = preferredSubmissionId;
  if (!submissionId) submissionId = await findReadyForReviewInAppPurchaseSubmission(appId);
  if (!submissionId) {
    const created = await appStoreConnectFetch("/iris/v1/reviewSubmissions", {
      method: "POST",
      body: JSON.stringify({ data: { type: "reviewSubmissions", attributes: {}, relationships: { app: { data: { type: "apps", id: appId } } } } }),
    });
    submissionId = String(created.body?.data?.id || "");
  }
  if (!submissionId) throw new Error("Apple 未返回草稿提交 ID");
  const createdItem = await appStoreConnectFetch("/iris/v1/reviewSubmissionItems", {
    method: "POST",
    body: JSON.stringify({ data: { type: "reviewSubmissionItems", relationships: {
      reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
      inAppPurchaseVersion: { data: { type: "inAppPurchaseVersions", id: versionId } },
    } } }),
  });
  const mutationResult = {
    submissionId,
    itemId: String(createdItem.body?.data?.id || ""),
    itemState: String(createdItem.body?.data?.attributes?.state || ""),
    submissionState: "READY_FOR_REVIEW",
    itemCount: Number(payload.itemCountHint || 0) + 1,
  };
  try {
    const refreshed = await loadInAppPurchaseReviewDraft(appId, versionId);
    return refreshed || { ...mutationResult, refreshRequired: true, refreshWarning: "项目已添加，Apple 草稿数据尚未同步完成。" };
  } catch (error) {
    return { ...mutationResult, refreshRequired: true, refreshWarning: error.message || "项目已添加，但草稿刷新失败。" };
  }
}

async function removeInAppPurchaseFromReview(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const itemId = String(payload.itemId || "").trim();
  const submissionId = String(payload.submissionId || "").trim();
  const itemCount = Number(payload.itemCount || 0);
  if (itemId) {
    await appStoreConnectFetch(`/iris/v1/reviewSubmissionItems/${encodeURIComponent(itemId)}`, { method: "DELETE" });
    if (itemCount <= 1 && submissionId) {
      await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, { method: "DELETE" });
    }
    return appId ? loadAppStoreConnectAppDetail(appId) : null;
  }
  const versionId = String(payload.versionId || "").trim();
  const draft = await loadInAppPurchaseReviewDraft(appId, versionId);
  if (!draft?.itemId) return null;
  await appStoreConnectFetch(`/iris/v1/reviewSubmissionItems/${encodeURIComponent(draft.itemId)}`, { method: "DELETE" });
  if (draft.itemCount <= 1 && draft.submissionId) {
    await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(draft.submissionId)}`, { method: "DELETE" });
  }
  return appId ? loadAppStoreConnectAppDetail(appId) : null;
}

async function removeReviewSubmissionItem(payload = {}) {
  const appId = String(payload.appId || "").trim();
  const itemId = String(payload.itemId || "").trim();
  const submissionId = String(payload.submissionId || "").trim();
  const itemCount = Number(payload.itemCount || 0);
  if (!itemId) throw new Error("缺少审核项目 ID");
  await appStoreConnectFetch(`/iris/v1/reviewSubmissionItems/${encodeURIComponent(itemId)}`, { method: "DELETE" });
  if (itemCount <= 1 && submissionId) {
    await appStoreConnectFetch(`/iris/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, { method: "DELETE" });
  }
  return appId ? loadAppStoreConnectAppDetail(appId) : null;
}

async function loadAppStoreConnectInAppPurchaseDetail(purchaseId, appId = "") {
  const id = encodeURIComponent(String(purchaseId || "").trim());
  if (!id) throw new Error("缺少 App 内购项目 ID");
  const [detailResult, baseResult, manualResult, automaticResult, offerResult, localizationCollectionResult] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}?include=content,promotedPurchase,appStoreReviewScreenshot,inAppPurchaseTaxCategoryInfo,versions&limit[versions]=2`),
    appStoreConnectFetch(`/iris/v1/inAppPurchasePriceSchedules/${id}/baseTerritory`),
    appStoreConnectFetch(`/iris/v1/inAppPurchasePriceSchedules/${id}/manualPrices?include=inAppPurchasePricePoint,territory&limit=1000`),
    appStoreConnectFetch(`/iris/v1/inAppPurchasePriceSchedules/${id}/automaticPrices?include=inAppPurchasePricePoint,territory&limit=1000`),
    appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}/offerCodes?limit=200`),
    appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}/inAppPurchaseLocalizations?limit=100`),
  ]);
  if (detailResult.status !== "fulfilled") throw detailResult.reason;
  const row = jsonApiRows(detailResult.value.body)[0] || {};
  const detail = normalizeInAppPurchase(row, detailResult.value.body);
  const included = Array.isArray(detailResult.value.body?.included) ? detailResult.value.body.included : [];
  const versionRef = relationshipData(row, "versions")[0]
    || included.find(item => item?.type === "inAppPurchaseVersions");
  const versionId = String(versionRef?.id || "");
  const versionRow = included.find(item => /inAppPurchaseVersions?/i.test(String(item?.type || ""))
    && (!versionId || String(item?.id || "") === versionId));
  const versionState = String(versionRow?.attributes?.state || versionRow?.attributes?.status || "").toUpperCase();
  const reviewDraft = appId && versionId
    ? await loadInAppPurchaseReviewDraft(String(appId), versionId).catch(() => null)
    : null;
  const submissionState = String(reviewDraft?.itemState || reviewDraft?.submissionState || "").toUpperCase();
  if (versionState) {
    detail.status = versionState;
    detail.state = versionState;
  } else if (submissionState) {
    detail.status = submissionState;
    detail.state = submissionState;
  }
  const baseRow = baseResult.status === "fulfilled" ? jsonApiRows(baseResult.value.body)[0] : null;
  const manualBody = manualResult.status === "fulfilled" ? manualResult.value.body : {};
  const manualRows = jsonApiRows(manualBody);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const priceRow = manualRows.find(item => {
    const startDate = String(item?.attributes?.startDate || "").slice(0, 10);
    const endDate = String(item?.attributes?.endDate || "").slice(0, 10);
    return (!startDate || startDate <= today) && (!endDate || endDate > today);
  }) || manualRows.find(item => !item?.attributes?.endDate) || manualRows[0] || null;
  const pricePointRef = priceRow ? relationshipData(priceRow, "inAppPurchasePricePoint")[0] : null;
  const pricePoint = pricePointRef ? findIncluded(manualBody, "inAppPurchasePricePoints", pricePointRef.id) : null;
  let automaticBody = automaticResult.status === "fulfilled" ? automaticResult.value.body : {};
  let priceScheduleError = "";
  if (automaticResult.status !== "fulfilled") {
    try {
      automaticBody = (await appStoreConnectFetch(`/iris/v1/inAppPurchasePriceSchedules/${id}/automaticPrices?include=inAppPurchasePricePoint,territory&limit=1000`)).body;
    } catch {
      priceScheduleError = "价格时间表读取失败，请刷新重试。";
    }
  }
  const pricePeriods = [...jsonApiRows(automaticBody), ...manualRows].map(item => {
    const attributes = item?.attributes || {};
    const territoryRef = relationshipData(item, "territory")[0];
    return {
      startDate: String(attributes.startDate || attributes.effectiveDate || "").slice(0, 10),
      endDate: String(attributes.endDate || "").slice(0, 10),
      territoryId: String(territoryRef?.id || attributes.territory || ""),
      adjustment: String(attributes.priceChangeReason || attributes.adjustmentReason || (attributes.manual === true ? "手动价格调整" : "外汇汇率或税率调整")),
    };
  }).filter(item => item.territoryId);
  const scheduledPriceChanges = pricePeriods.filter(item => item.startDate > today).reduce((groups, item) => {
    const key = `${item.startDate}\u0000${item.adjustment}`;
    const group = groups.get(key) || { startDate: item.startDate, adjustment: item.adjustment, territories: new Set() };
    group.territories.add(item.territoryId); groups.set(key, group); return groups;
  }, new Map());
  const normalizedScheduledPriceChanges = [...scheduledPriceChanges.values()]
    .map(item => ({ startDate: item.startDate, adjustment: item.adjustment, count: item.territories.size }))
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  const endingPriceChanges = pricePeriods.filter(item => (!item.startDate || item.startDate <= today) && item.endDate > today).reduce((groups, item) => {
    const group = groups.get(item.endDate) || { endDate: item.endDate, territories: new Set() };
    group.territories.add(item.territoryId); groups.set(item.endDate, group); return groups;
  }, new Map());
  const normalizedEndingPriceChanges = [...endingPriceChanges.values()]
    .map(item => ({ endDate: item.endDate, count: item.territories.size }))
    .sort((left, right) => left.endDate.localeCompare(right.endDate));
  const currentPriceTerritories = new Set(pricePeriods
    .filter(item => (!item.startDate || item.startDate <= today) && !item.endDate)
    .map(item => item.territoryId));
  const activePriceTerritories = new Set(pricePeriods
    .filter(item => (!item.startDate || item.startDate <= today) && (!item.endDate || item.endDate > today))
    .map(item => item.territoryId));
  const priceScheduleLoaded = automaticResult.status === "fulfilled" || !priceScheduleError;
  const equalized = pricePointRef?.id ? await loadAppStoreConnectInAppPurchasePriceEqualizations(pricePointRef.id).catch(() => []) : [];
  // `content` points to intermediate content resources, not directly to the
  // localization rows. Those content resources then expose localization IDs.
  // Resolve every localization relationship and use only GET_INSTANCE, which
  // is one of the operations Apple permits for this resource.
  const localizationRefs = new Map();
  const contentRefs = new Map();
  for (const source of [row, ...included]) {
    for (const [relationshipName, relationship] of Object.entries(source?.relationships || {})) {
      const data = relationship?.data;
      for (const ref of Array.isArray(data) ? data : (data ? [data] : [])) {
        if (/inAppPurchaseLocalizations?/i.test(String(ref?.type || "")) && ref?.id) localizationRefs.set(String(ref.id), ref);
        if (/content|localization/i.test(`${relationshipName} ${String(ref?.type || "")}`) && ref?.id) contentRefs.set(String(ref.id), ref);
      }
    }
  }
  // The current v2 detail response exposes localization rows as included
  // `content` resources. Older responses used an explicit localization type.
  // Support both representations and future type-name variations.
  const localizationRows = included.filter(item => {
    const attributes = item?.attributes || {};
    const type = String(item?.type || "");
    const referencedAsContent = contentRefs.has(String(item?.id || ""));
    return /inAppPurchaseLocalization|inAppPurchaseContent/i.test(type)
      || (referencedAsContent && !!attributes.locale)
      || (!!attributes.locale && (attributes.name !== undefined || attributes.description !== undefined));
  });
  const loadedLocalizationIds = new Set(localizationRows.map(item => String(item.id || "")));
  const missingLocalizationIds = [...localizationRefs.keys()].filter(id => !loadedLocalizationIds.has(id));
  const localizationInstances = await Promise.allSettled(missingLocalizationIds.map(localizationId =>
    appStoreConnectFetch(`/iris/v1/inAppPurchaseLocalizations/${encodeURIComponent(localizationId)}`)
  ));
  if (localizationCollectionResult.status === "fulfilled") {
    localizationRows.push(...jsonApiRows(localizationCollectionResult.value.body));
  }
  localizationInstances.forEach(result => {
    if (result.status === "fulfilled") localizationRows.push(...jsonApiRows(result.value.body));
  });
  if (versionId) {
    const versionLocalizations = await appStoreConnectFetch(`/iris/v1/inAppPurchaseVersions/${encodeURIComponent(versionId)}/localizations?include=version`).catch(() => null);
    if (versionLocalizations?.body) localizationRows.push(...jsonApiRows(versionLocalizations.body));
  }
  const localizations = localizationRows.map(item => ({
    id: String(item.id || ""), locale: String(item.attributes?.locale || ""),
    name: String(item.attributes?.name || ""), description: String(item.attributes?.description || ""),
  })).filter(item => item.id && item.locale)
    .filter((item, index, rows) => rows.findIndex(row => row.id === item.id) === index);
  const offerCodes = offerResult.status === "fulfilled" ? jsonApiRows(offerResult.value.body).map(item => ({
    id: String(item.id || ""), name: String(item.attributes?.name || item.attributes?.referenceName || ""),
    active: item.attributes?.active !== false,
  })) : [];
  const taxInfo = included.find(item => /TaxCategory/i.test(String(item.type || ""))) || {};
  const reviewScreenshotRef = relationshipData(row, "appStoreReviewScreenshot")[0];
  let reviewScreenshot = included.find(item => reviewScreenshotRef?.id && String(item.id || "") === String(reviewScreenshotRef.id))
    || included.find(item => /ReviewScreenshot/i.test(String(item.type || "")))
    || {};
  // Some App Store Connect responses only return the relationship identifier,
  // even when `include=appStoreReviewScreenshot` was requested. Apple exposes
  // this resource as GET_INSTANCE, so resolve it explicitly instead of treating
  // a missing `included` row as a missing screenshot.
  if (reviewScreenshotRef?.id && !reviewScreenshot?.attributes?.imageAsset?.templateUrl) {
    const screenshotResult = await appStoreConnectFetch(`/iris/v1/inAppPurchaseAppStoreReviewScreenshots/${encodeURIComponent(reviewScreenshotRef.id)}`).catch(() => null);
    reviewScreenshot = screenshotResult ? (jsonApiRows(screenshotResult.body)[0] || reviewScreenshot) : reviewScreenshot;
  }
  const reviewImageAsset = reviewScreenshot.attributes?.imageAsset || {};
  const reviewTemplateUrl = String(reviewImageAsset.templateUrl || "");
  const reviewScreenshotRemoteUrl = reviewTemplateUrl
    ? reviewTemplateUrl.replace("{w}", String(Math.min(Number(reviewImageAsset.width || 420), 420))).replace("{h}", String(Math.min(Number(reviewImageAsset.height || 420), 420))).replace("{f}", "png")
    : "";
  // The certificate-manager renderer can be bound to an account proxy while
  // mzstatic assets are served from a separate host. Loading that URL directly
  // in <img> therefore occasionally leaves a blank preview even though the
  // review screenshot exists. Read it through the authenticated Electron
  // session and embed it so the preview is independent of renderer networking.
  let reviewScreenshotUrl = reviewScreenshotRemoteUrl;
  if (reviewScreenshotRemoteUrl) {
    try {
      const assetResponse = await (activeAppStoreConnectSession() || appStoreConnectSession()).fetch(reviewScreenshotRemoteUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (assetResponse.ok) {
        const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
        if (assetBuffer.length && assetBuffer.length <= 12 * 1024 * 1024) {
          const contentType = String(assetResponse.headers.get("content-type") || "image/png").split(";")[0];
          const extension = contentType.includes("jpeg") ? "jpg" : contentType.includes("webp") ? "webp" : "png";
          const previewDir = path.join(app.getPath("temp"), "mayou-iap-review-previews");
          fs.mkdirSync(previewDir, { recursive: true });
          const previewPath = path.join(previewDir, `${String(reviewScreenshot.id || "preview").replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`);
          fs.writeFileSync(previewPath, assetBuffer);
          reviewScreenshotUrl = pathToFileURL(previewPath).href;
        }
      }
    } catch {}
  }
  return {
    ...detail,
    versionId,
    baseTerritoryId: String(baseRow?.id || ""),
    baseTerritoryName: baseRow?.id ? appStoreTerritoryName(baseRow.id) : "",
    currency: String(baseRow?.attributes?.currency || ""),
    pricePointId: String(pricePointRef?.id || ""),
    price: String(pricePoint?.attributes?.customerPrice ?? ""),
    proceeds: String(pricePoint?.attributes?.proceeds ?? ""),
    hasPrice: !!priceRow,
    priceTerritoryCount: activePriceTerritories.size || new Set([String(baseRow?.id || ""), ...equalized.map(item => String(item.territoryId || ""))].filter(Boolean)).size,
    currentPriceTerritoryCount: priceScheduleLoaded ? currentPriceTerritories.size : 0,
    currentPriceTerritoryIds: priceScheduleLoaded ? [...currentPriceTerritories].sort() : [],
    endingPriceChanges: normalizedEndingPriceChanges,
    scheduledPriceChanges: normalizedScheduledPriceChanges,
    priceScheduleLoaded,
    priceScheduleError,
    localizations,
    offerCodes,
    taxCategory: String(taxInfo.attributes?.category || taxInfo.attributes?.taxCategory || "与主 App 匹配"),
    reviewScreenshotId: String(reviewScreenshot.id || ""),
    reviewScreenshotUrl,
    reviewScreenshotState: String(reviewScreenshot.attributes?.assetDeliveryState?.state || ""),
    reviewDraft,
  };
}

async function uploadAppStoreConnectInAppPurchaseReviewScreenshot(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  const versionId = String(payload.versionId || "").trim();
  if (!purchaseId || !versionId) throw new Error("缺少 App 内购项目或版本 ID");
  const result = await dialog.showOpenDialog(certificateManagerWindow || undefined, {
    title: "选择审核截图",
    properties: ["openFile"],
    filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg"] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const createScreenshot = relationship => appStoreConnectFetch("/iris/v1/inAppPurchaseAppStoreReviewScreenshots", {
    method: "POST",
    body: JSON.stringify({ data: {
      type: "inAppPurchaseAppStoreReviewScreenshots",
      attributes: { fileName, fileSize: stat.size },
      relationships: relationship,
    } }),
  });
  const deletedScreenshotIds = new Set();
  const deleteReviewScreenshot = async id => {
    const screenshotId = String(id || "").trim();
    if (!screenshotId || deletedScreenshotIds.has(screenshotId)) return;
    try {
      await appStoreConnectFetch(`/iris/v1/inAppPurchaseAppStoreReviewScreenshots/${encodeURIComponent(screenshotId)}`, { method: "DELETE" });
    } catch (error) {
      if (![404, 409].includes(Number(error.status || 0))) throw error;
    }
    deletedScreenshotIds.add(screenshotId);
  };
  await deleteReviewScreenshot(payload.reviewScreenshotId);
  let created;
  try {
    created = await createScreenshot({ inAppPurchaseV2: { data: { type: "inAppPurchases", id: purchaseId } } });
  } catch (error) {
    if (Number(error.status || 0) !== 409) throw error;
    const latest = await loadAppStoreConnectInAppPurchaseDetail(purchaseId).catch(() => null);
    await deleteReviewScreenshot(latest?.reviewScreenshotId);
    created = await createScreenshot({ inAppPurchaseV2: { data: { type: "inAppPurchases", id: purchaseId } } });
  }
  const { body } = created;
  const screenshotId = String(body?.data?.id || "");
  const operations = Array.isArray(body?.data?.attributes?.uploadOperations) ? body.data.attributes.uploadOperations : [];
  if (!screenshotId || !operations.length) throw new Error("Apple 未返回审核截图上传信息");
  for (const operation of operations) await uploadAppStoreOperation(operation, fileBuffer, filePath);
  await appStoreConnectFetch(`/iris/v1/inAppPurchaseAppStoreReviewScreenshots/${encodeURIComponent(screenshotId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: {
      type: "inAppPurchaseAppStoreReviewScreenshots",
      id: screenshotId,
      attributes: { uploaded: true, sourceFileChecksum: crypto.createHash("md5").update(fileBuffer).digest("hex") },
    } }),
  });
  await new Promise(resolve => setTimeout(resolve, 900));
  return loadAppStoreConnectInAppPurchaseDetail(purchaseId);
}

async function deleteAppStoreConnectInAppPurchase(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  const appId = String(payload.appId || "").trim();
  if (!purchaseId) throw new Error("缺少 App 内购项目 ID");
  try {
    await appStoreConnectFetch(`/iris/v2/inAppPurchases/${encodeURIComponent(purchaseId)}`, { method: "DELETE" });
  } catch (error) {
    if (![404, 405].includes(Number(error.status || 0))) throw error;
    await appStoreConnectFetch(`/iris/v1/inAppPurchases/${encodeURIComponent(purchaseId)}`, { method: "DELETE", skipSessionRefresh: true });
  }
  return appId ? loadAppStoreConnectInAppPurchases(appId) : [];
}

async function loadAppStoreConnectInAppPurchaseAvailability(purchaseId) {
  const id = encodeURIComponent(String(purchaseId || "").trim());
  if (!id) throw new Error("缺少 App 内购项目 ID");
  const supported = await appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}/supportedTerritories?limit=200`);
  const supportedRows = jsonApiRows(supported.body);
  let selectedIds = new Set(supportedRows.map(row => String(row.id || "")));
  let exists = false;
  let availabilityId = "";
  let availableInNewTerritories = true;
  try {
    const { body } = await appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}/inAppPurchaseAvailability?include=availableTerritories&limit[availableTerritories]=200`);
    const row = jsonApiRows(body)[0] || {};
    exists = !!row.id;
    availabilityId = String(row.id || "");
    availableInNewTerritories = row.attributes?.availableInNewTerritories !== false;
    const refs = relationshipData(row, "availableTerritories");
    selectedIds = new Set(refs.map(ref => String(ref.id || "")));
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
  }
  const territories = supportedRows.map(row => ({
    id: String(row.id || ""),
    name: appStoreTerritoryName(String(row.id || "")),
    currency: String(row.attributes?.currency || ""),
    available: selectedIds.has(String(row.id || "")),
  })).filter(item => item.id).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return { exists, availabilityId, availableInNewTerritories, total: territories.length, availableCount: territories.filter(item => item.available).length, territories };
}

async function loadAppStoreConnectInAppPurchasePricePoints(purchaseId, territoryId) {
  const id = encodeURIComponent(String(purchaseId || "").trim());
  const territory = encodeURIComponent(String(territoryId || "").trim().toUpperCase());
  const { body } = await appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}/pricePoints?filter[territory]=${territory}&include=territory&limit=800`);
  return jsonApiRows(body).map(row => ({
    id: String(row.id || ""),
    price: String(row.attributes?.customerPrice ?? ""),
    proceeds: String(row.attributes?.proceeds ?? ""),
  })).filter(item => item.id).sort((a, b) => Number(a.price) - Number(b.price));
}

async function loadAppStoreConnectInAppPurchasePriceEqualizations(pricePointId) {
  const id = encodeURIComponent(String(pricePointId || "").trim());
  if (!id) throw new Error("缺少价格点 ID");
  const { body } = await appStoreConnectFetch(`/iris/v1/inAppPurchasePricePoints/${id}/equalizations?include=territory&limit=200`);
  return jsonApiRows(body).map(row => {
    const territoryRef = relationshipData(row, "territory")[0];
    const territory = territoryRef ? findIncluded(body, "territories", territoryRef.id) : null;
    const territoryId = String(territoryRef?.id || territory?.id || "");
    return { id: String(row.id || ""), territoryId, name: appStoreTerritoryName(territoryId), currency: String(territory?.attributes?.currency || ""), price: String(row.attributes?.customerPrice ?? ""), proceeds: String(row.attributes?.proceeds ?? "") };
  }).filter(item => item.id && item.territoryId).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

async function exportAppStoreConnectInAppPurchasePriceTable(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  if (!purchaseId) throw new Error("缺少 App 内购项目 ID");
  const detail = await loadAppStoreConnectInAppPurchaseDetail(purchaseId, String(payload.appId || ""));
  const pricePointId = String(payload.pricePointId || detail.pricePointId || "").trim();
  if (!pricePointId) throw new Error("当前内购项目尚未设置价格");
  const equalized = await loadAppStoreConnectInAppPurchasePriceEqualizations(pricePointId);
  const baseRow = {
    territoryId: detail.baseTerritoryId,
    name: detail.baseTerritoryName || appStoreTerritoryName(detail.baseTerritoryId),
    currency: detail.currency,
    price: detail.price,
    proceeds: detail.proceeds,
  };
  const rows = baseRow.territoryId
    ? [baseRow, ...equalized.filter(item => item.territoryId !== baseRow.territoryId)]
    : equalized;
  if (!rows.length) throw new Error("暂未读取到价格表");
  const result = await dialog.showSaveDialog(certificateManagerWindow || undefined, {
    title: "下载当前价格",
    defaultPath: `${safeArchiveSegment(detail.name || payload.name || "App内购买项目")}-当前价格.xlsx`,
    filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, buildInAppPurchasePriceWorkbook(rows, { sheetName: "当前价格" }));
  return { success: true, filePath: result.filePath };
}

async function saveAppStoreConnectInAppPurchaseAvailability(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  const territoryIds = [...new Set((payload.territoryIds || []).map(id => String(id || "").trim().toUpperCase()).filter(Boolean))];
  if (!purchaseId) throw new Error("缺少 App 内购项目 ID");
  const relationships = {
    inAppPurchase: { data: { type: "inAppPurchases", id: purchaseId } },
    availableTerritories: { data: territoryIds.map(id => ({ type: "territories", id })) },
  };
  // App Store Connect treats availability changes as a replacement CREATE.
  // The resource explicitly rejects UPDATE/PATCH even when an availability id exists.
  await appStoreConnectFetch("/iris/v1/inAppPurchaseAvailabilities", {
    method: "POST",
    body: JSON.stringify({ data: { type: "inAppPurchaseAvailabilities", attributes: { availableInNewTerritories: payload.availableInNewTerritories !== false }, relationships } }),
  });
  return loadAppStoreConnectInAppPurchaseAvailability(purchaseId);
}

async function saveAppStoreConnectInAppPurchase(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  if (!purchaseId) throw new Error("缺少 App 内购项目 ID");
  const attributes = {};
  if (payload.name !== undefined) attributes.name = String(payload.name || "").trim();
  if (payload.reviewNote !== undefined) attributes.reviewNote = String(payload.reviewNote || "").trim();
  await appStoreConnectFetch(`/iris/v2/inAppPurchases/${encodeURIComponent(purchaseId)}`, {
    method: "PATCH", body: JSON.stringify({ data: { type: "inAppPurchases", id: purchaseId, attributes } }),
  });
  return loadAppStoreConnectInAppPurchaseDetail(purchaseId, String(payload.appId || ""));
}

async function saveAppStoreConnectInAppPurchaseLocalization(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  let localizationId = String(payload.localizationId || "").trim();
  const locale = String(payload.locale || "").trim();
  const attributes = { locale, name: String(payload.name || "").trim(), description: String(payload.description || "").trim() };
  if (!purchaseId || !attributes.locale || !attributes.name || !attributes.description) throw new Error("请完整填写本地化语言、显示名称和描述");
  const findExisting = async () => {
    const detail = await loadAppStoreConnectInAppPurchaseDetail(purchaseId);
    return (detail.localizations || []).find(row => String(row.locale || "").toLowerCase() === locale.toLowerCase()) || null;
  };
  if (!localizationId) {
    try { localizationId = String((await findExisting())?.id || ""); } catch {}
  }
  const patchLocalization = id => appStoreConnectFetch(`/iris/v2/inAppPurchaseLocalizations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "inAppPurchaseLocalizations", id, attributes: { name: attributes.name, description: attributes.description } } }),
  });
  const save = async () => {
    const patching = !!localizationId;
    const data = {
      type: "inAppPurchaseLocalizations",
      ...(patching ? { id: localizationId } : {}),
      attributes: patching ? { name: attributes.name, description: attributes.description } : attributes,
    };
    if (!patching) data.relationships = { inAppPurchaseV2: { data: { type: "inAppPurchases", id: purchaseId } } };
    if (patching) return patchLocalization(localizationId);
    await appStoreConnectFetch("/iris/v1/inAppPurchaseLocalizations", {
      method: patching ? "PATCH" : "POST", body: JSON.stringify({ data }),
    });
  };
  try {
    await save();
  } catch (error) {
    if (localizationId && /Version is not in modifiable state|ACTIVE state|active state|InAppPurchaseLocalization/i.test(String(error.message || ""))) {
      const draftLocalization = await ensureEditableInAppPurchaseLocalization(purchaseId, locale);
      localizationId = String(draftLocalization?.id || "");
      if (!localizationId) throw new Error("Apple 已创建新版本草稿失败，请刷新内购详情后重试");
      await patchLocalization(localizationId);
      return loadAppStoreConnectInAppPurchaseDetail(purchaseId);
    }
    // Apple can briefly omit a just-created localization from the detail
    // response. If POST then reports a duplicate locale, resolve its real ID
    // and update it instead of exposing the English API error to the user.
    if (localizationId || !/locale code|already exists|已存在/i.test(String(error.message || ""))) throw error;
    const existing = await findExisting();
    localizationId = String(existing?.id || "");
    if (!localizationId) throw new Error(`本地化版本 ${locale} 已存在，请刷新详情后编辑`);
    await save();
  }
  return loadAppStoreConnectInAppPurchaseDetail(purchaseId);
}

async function loadInAppPurchaseVersionLocalizations(versionId) {
  const id = encodeURIComponent(String(versionId || "").trim());
  if (!id) return [];
  const { body } = await appStoreConnectFetch(`/iris/v1/inAppPurchaseVersions/${id}/localizations?include=version`);
  return jsonApiRows(body).map(item => ({
    id: String(item.id || ""),
    locale: String(item.attributes?.locale || ""),
    name: String(item.attributes?.name || ""),
    description: String(item.attributes?.description || ""),
  })).filter(item => item.id && item.locale);
}

async function findEditableInAppPurchaseLocalization(purchaseId, locale) {
  const id = encodeURIComponent(String(purchaseId || "").trim());
  const { body } = await appStoreConnectFetch(`/iris/v2/inAppPurchases/${id}?include=versions&limit[versions]=10`);
  const rows = Array.isArray(body?.included) ? body.included : [];
  const versions = rows.filter(item => /inAppPurchaseVersions?/i.test(String(item?.type || "")))
    .filter(item => /PREPARE|DEVELOPER|REJECTED/i.test(String(item?.attributes?.state || "")))
    .sort((a, b) => Number(b?.attributes?.version || 0) - Number(a?.attributes?.version || 0));
  for (const version of versions) {
    const localizations = await loadInAppPurchaseVersionLocalizations(version.id).catch(() => []);
    const found = localizations.find(item => String(item.locale || "").toLowerCase() === String(locale || "").toLowerCase());
    if (found) return found;
  }
  return null;
}

async function createInAppPurchaseDraftVersion(purchaseId) {
  const { body } = await appStoreConnectFetch("/iris/v1/inAppPurchaseVersions", {
    method: "POST",
    body: JSON.stringify({ data: { type: "inAppPurchaseVersions", relationships: { inAppPurchase: { data: { type: "inAppPurchases", id: purchaseId } } } } }),
  });
  return String(jsonApiRows(body)[0]?.id || body?.data?.id || "");
}

async function ensureEditableInAppPurchaseLocalization(purchaseId, locale) {
  const existing = await findEditableInAppPurchaseLocalization(purchaseId, locale).catch(() => null);
  if (existing?.id) return existing;
  let versionId = "";
  try {
    versionId = await createInAppPurchaseDraftVersion(purchaseId);
  } catch (error) {
    const afterConflict = await findEditableInAppPurchaseLocalization(purchaseId, locale).catch(() => null);
    if (afterConflict?.id) return afterConflict;
    throw error;
  }
  const localizations = await loadInAppPurchaseVersionLocalizations(versionId);
  return localizations.find(item => String(item.locale || "").toLowerCase() === String(locale || "").toLowerCase()) || null;
}

const APP_STORE_LOCALIZATION_OPTIONS = [
  ["ar-SA", "阿拉伯语"], ["ca", "加泰罗尼亚语"], ["cs", "捷克语"], ["da", "丹麦语"], ["de-DE", "德语"],
  ["el", "希腊语"], ["en-AU", "英语（澳大利亚）"], ["en-CA", "英语（加拿大）"], ["en-GB", "英语（英国）"], ["en-US", "英语（美国）"],
  ["es-ES", "西班牙语（西班牙）"], ["es-MX", "西班牙语（墨西哥）"], ["fi", "芬兰语"], ["fr-CA", "法语（加拿大）"], ["fr-FR", "法语"],
  ["he", "希伯来语"], ["hi", "印地语"], ["hr", "克罗地亚语"], ["hu", "匈牙利语"], ["id", "印度尼西亚语"],
  ["it", "意大利语"], ["ja", "日语"], ["ko", "韩语"], ["ms", "马来语"], ["nl-NL", "荷兰语"],
  ["no", "挪威语"], ["pl", "波兰语"], ["pt-BR", "葡萄牙语（巴西）"], ["pt-PT", "葡萄牙语（葡萄牙）"], ["ro", "罗马尼亚语"],
  ["ru", "俄语"], ["sk", "斯洛伐克语"], ["sv", "瑞典语"], ["th", "泰语"], ["tr", "土耳其语"],
  ["uk", "乌克兰语"], ["vi", "越南语"], ["zh-Hans", "简体中文"], ["zh-Hant", "繁体中文"],
].map(([code, name]) => ({ code, name }));

async function saveAppStoreConnectInAppPurchasePricing(payload = {}) {
  const purchaseId = String(payload.purchaseId || "").trim();
  const territoryId = String(payload.territoryId || "").trim().toUpperCase();
  const pricePointId = String(payload.pricePointId || "").trim();
  if (!purchaseId || !territoryId || !pricePointId) throw new Error("请完整选择所在国家或地区和价格");
  const overrides = Array.isArray(payload.overrides) ? payload.overrides.filter(item => item?.pricePointId && item?.territoryId && item.territoryId !== territoryId) : [];
  const priceItems = [{ pricePointId, temporaryId: "${newprice-0}" }, ...overrides.map((item, index) => ({ pricePointId: String(item.pricePointId), temporaryId: `\${newprice-${index + 1}}` }))];
  await appStoreConnectFetch("/iris/v1/inAppPurchasePriceSchedules", {
    method: "POST",
    body: JSON.stringify({
      data: { type: "inAppPurchasePriceSchedules", relationships: {
        inAppPurchase: { data: { type: "inAppPurchases", id: purchaseId } },
        baseTerritory: { data: { type: "territories", id: territoryId } },
        manualPrices: { data: priceItems.map(item => ({ type: "inAppPurchasePrices", id: item.temporaryId })) },
      } },
      included: priceItems.map(item => ({ type: "inAppPurchasePrices", id: item.temporaryId, attributes: { startDate: null }, relationships: { inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: item.pricePointId } } } })),
    }),
  });
  return loadAppStoreConnectInAppPurchaseDetail(purchaseId);
}

async function loadAppStoreConnectInAppPurchases(appId) {
  const id = encodeURIComponent(String(appId || "").trim());
  const paths = [
    `/iris/v1/apps/${id}/inAppPurchasesV2?include=versions&limit=200&limit[versions]=2`,
    `/iris/v1/apps/${id}/inAppPurchases?include=versions&limit=200&limit[versions]=2`,
    `/iris/v1/inAppPurchases?filter[app]=${id}&limit=200`,
  ];
  let lastError;
  for (const requestPath of paths) {
    try {
      const { body } = await appStoreConnectFetch(requestPath, { skipSessionRefresh: !!lastError });
      return jsonApiRows(body).map(row => normalizeInAppPurchase(row, body));
    } catch (error) {
      lastError = error;
      if (![404, 405].includes(Number(error.status || 0))) throw error;
    }
  }
  throw lastError || new Error("App 内购买项目读取失败");
}

async function loadAppStoreConnectIAPSubmissionStatus(appId) {
  const id = encodeURIComponent(String(appId || "").trim());
  const [statusResult, approvedResult] = await Promise.allSettled([
    appStoreConnectFetch(`/iris/v1/apps/${id}/iaps/submissionStatus`),
    appStoreConnectFetch(`/iris/v1/apps/${id}/inAppPurchasesV2?filter[stateGroup]=APPROVED&filter[inAppPurchaseType]=CONSUMABLE&limit=1`),
  ]);
  const statusRow = statusResult.status === "fulfilled" ? jsonApiRows(statusResult.value.body)[0] || {} : {};
  const attributes = statusRow.attributes || {};
  const approvedRows = approvedResult.status === "fulfilled" ? jsonApiRows(approvedResult.value.body) : [];
  return {
    hasApprovedConsumableIAP: approvedRows.length > 0,
    missingRequiredPrivacyPolicyData: attributes.missingRequiredPrivacyPolicyData === true,
  };
}

ipcMain.handle("app-store-connect-in-app-purchases", async (_event, appId) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const id = String(appId || "").trim();
    if (!id) throw new Error("缺少 App ID");
    return { success: true, purchases: await loadAppStoreConnectInAppPurchases(id) };
  } catch (error) {
    return { success: false, error: error.message || "App 内购买项目读取失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-create-in-app-purchase", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    const name = String(payload.name || "").trim();
    const productId = String(payload.productId || "").trim();
    const inAppPurchaseType = String(payload.type || "CONSUMABLE").trim();
    if (!appId || !name || !productId) throw new Error("请完整填写参考名称和产品 ID");
    if (!["CONSUMABLE", "NON_CONSUMABLE"].includes(inAppPurchaseType)) throw new Error("请选择有效的 App 内购类型");
    const requestBody = JSON.stringify({ data: { type: "inAppPurchases", attributes: { name, productId, inAppPurchaseType }, relationships: { app: { data: { type: "apps", id: appId } } } } });
    let createdBody;
    try {
      ({ body: createdBody } = await appStoreConnectFetch("/iris/v2/inAppPurchases", { method: "POST", body: requestBody }));
    } catch (error) {
      if (![404, 405].includes(Number(error.status || 0))) throw error;
      ({ body: createdBody } = await appStoreConnectFetch("/iris/v1/inAppPurchases", { method: "POST", body: requestBody, skipSessionRefresh: true }));
    }
    const created = normalizeInAppPurchase(jsonApiRows(createdBody)[0] || {}, createdBody);
    return { success: true, created, purchases: await loadAppStoreConnectInAppPurchases(appId) };
  } catch (error) {
    return { success: false, error: error.message || "App 内购买项目创建失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-in-app-purchase-detail", async (_event, payload) => {
  const purchaseId = typeof payload === "object" ? payload?.purchaseId : payload;
  const appId = typeof payload === "object" ? payload?.appId : "";
  try { return { success: true, detail: await loadAppStoreConnectInAppPurchaseDetail(purchaseId, appId) }; }
  catch (error) { return { success: false, error: error.message || "App 内购项目详情读取失败" }; }
});

ipcMain.handle("app-store-connect-add-in-app-purchase-to-review", async (_event, payload = {}) => {
  try { return { success: true, reviewDraft: await addInAppPurchaseToReview(payload) }; }
  catch (error) { return { success: false, error: error.message || "添加以供审核失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) }; }
});

ipcMain.handle("app-store-connect-remove-in-app-purchase-from-review", async (_event, payload = {}) => {
  try { return { success: true, detail: await removeInAppPurchaseFromReview(payload) }; }
  catch (error) { return { success: false, error: error.message || "从提交中移除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) }; }
});

ipcMain.handle("app-store-connect-remove-review-submission-item", async (_event, payload = {}) => {
  try { return { success: true, detail: await removeReviewSubmissionItem(payload) }; }
  catch (error) { return { success: false, error: error.message || "从提交中移除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) }; }
});

ipcMain.handle("app-store-connect-submit-in-app-purchase-review", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await submitInAppPurchaseReviewDraft(payload);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "提交内购审核失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-in-app-purchase-locales", async () => ({
  success: true,
  locales: APP_STORE_LOCALIZATION_OPTIONS,
}));

ipcMain.handle("app-store-connect-in-app-purchase-availability", async (_event, purchaseId) => {
  try { return { success: true, availability: await loadAppStoreConnectInAppPurchaseAvailability(purchaseId) }; }
  catch (error) { return { success: false, error: error.message || "App 内购销售范围读取失败" }; }
});

ipcMain.handle("app-store-connect-save-in-app-purchase-availability", async (_event, payload = {}) => {
  try { return { success: true, availability: await saveAppStoreConnectInAppPurchaseAvailability(payload) }; }
  catch (error) { return { success: false, error: error.message || "App 内购销售范围保存失败" }; }
});

ipcMain.handle("app-store-connect-in-app-purchase-pricing-options", async (_event, payload = {}) => {
  try {
    const purchaseId = String(payload.purchaseId || "").trim();
    const territoryId = String(payload.territoryId || "").trim().toUpperCase();
    if (!purchaseId) throw new Error("缺少 App 内购项目 ID");
    if (!territoryId) return { success: true, territories: await loadAppStoreConnectTerritories(), pricePoints: [] };
    return { success: true, territories: [], pricePoints: await loadAppStoreConnectInAppPurchasePricePoints(purchaseId, territoryId) };
  } catch (error) { return { success: false, error: error.message || "App 内购定价选项读取失败" }; }
});

ipcMain.handle("app-store-connect-in-app-purchase-price-equalizations", async (_event, pricePointId) => {
  try { return { success: true, prices: await loadAppStoreConnectInAppPurchasePriceEqualizations(pricePointId) }; }
  catch (error) { return { success: false, error: error.message || "国家或地区价格读取失败" }; }
});

ipcMain.handle("app-store-connect-download-in-app-purchase-pricing", async (_event, payload = {}) => {
  try {
    const result = await exportAppStoreConnectInAppPurchasePriceTable(payload);
    return result?.canceled ? { success: true, canceled: true } : { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "价格表下载失败" };
  }
});

ipcMain.handle("app-store-connect-save-in-app-purchase-pricing", async (_event, payload = {}) => {
  try { return { success: true, detail: await saveAppStoreConnectInAppPurchasePricing(payload) }; }
  catch (error) { return { success: false, error: error.message || "App 内购价格保存失败" }; }
});

ipcMain.handle("app-store-connect-save-in-app-purchase", async (_event, payload = {}) => {
  try { return { success: true, detail: await saveAppStoreConnectInAppPurchase(payload) }; }
  catch (error) { return { success: false, error: error.message || "App 内购项目保存失败" }; }
});

ipcMain.handle("app-store-connect-upload-in-app-purchase-review-screenshot", async (_event, payload = {}) => {
  try {
    const uploaded = await uploadAppStoreConnectInAppPurchaseReviewScreenshot(payload);
    return uploaded?.canceled ? { success: true, canceled: true } : { success: true, detail: uploaded };
  }
  catch (error) { return { success: false, error: error.message || "审核截图上传失败" }; }
});

ipcMain.handle("app-store-connect-delete-in-app-purchase", async (_event, payload = {}) => {
  try { return { success: true, purchases: await deleteAppStoreConnectInAppPurchase(payload) }; }
  catch (error) { return { success: false, error: error.message || "App 内购买项目删除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) }; }
});

ipcMain.handle("app-store-connect-save-in-app-purchase-localization", async (_event, payload = {}) => {
  try { return { success: true, detail: await saveAppStoreConnectInAppPurchaseLocalization(payload) }; }
  catch (error) { return { success: false, error: error.message || "本地化版本保存失败" }; }
});

ipcMain.handle("app-store-connect-pricing-options", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    const territoryId = String(payload.territoryId || "").trim().toUpperCase();
    if (!appId) throw new Error("缺少 App ID");
    if (!territoryId) return { success: true, territories: await loadAppStoreConnectTerritories(), pricePoints: [] };
    return {
      success: true,
      territories: [],
      pricePoints: await loadAppStoreConnectPricePoints(appId, territoryId),
    };
  } catch (error) {
    return { success: false, error: error.message || "定价选项读取失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-create-pricing", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, detail: await createAppStoreConnectPricing(payload) };
  } catch (error) {
    return { success: false, error: error.message || "价格设置失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-save-pricing-settings", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, settings: await saveAppStoreConnectPricingPageSettings(payload) };
  } catch (error) {
    return { success: false, error: error.message || "价格与销售范围设置保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-verify-mac-compatibility", async (_event, appId) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, settings: await verifyAppStoreConnectMacCompatibility(appId) };
  } catch (error) {
    return { success: false, error: error.message || "Mac 兼容性验证失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-availability", async (_event, appId) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const id = String(appId || "").trim();
    if (!id) throw new Error("缺少 App ID");
    return { success: true, availability: await loadAppStoreConnectAvailabilityDetail(id) };
  } catch (error) {
    return { success: false, error: error.message || "供应情况读取失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-save-availability", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, detail: await saveAppStoreConnectAvailability(payload) };
  } catch (error) {
    return { success: false, error: error.message || "供应情况保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-app-history", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    const platform = String(payload.platform || "IOS").trim() || "IOS";
    if (!appId) throw new Error("缺少 App ID");
    const result = await loadAppStoreConnectVersionHistory(appId, platform);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "历史记录读取失败" };
  }
});

ipcMain.handle("app-store-connect-save-icp-number", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, ...(await saveAppStoreConnectIcpNumber(payload)) };
  } catch (error) {
    return {
      success: false,
      confirmationRequired: payload?.developerNameMismatchConsent !== true && appStoreIcpDeveloperNameMismatch(error),
      error: error.message || "ICP 备案号保存失败",
      errors: appStoreConnectErrorItems(error.body),
    };
  }
});

ipcMain.handle("app-store-connect-save-app-version", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await saveAppStoreConnectAppVersion(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "App 信息保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-release-app-version", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, ...(await releaseAppStoreConnectAppVersion(payload)) };
  } catch (error) {
    return { success: false, error: error.message || "发布版本失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-cancel-app-version-release", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, ...(await cancelAppStoreConnectAppVersionRelease(payload)) };
  } catch (error) {
    return { success: false, error: error.message || "取消发布版本失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-privacy-detail", async (_event, appId) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return { success: true, privacy: await loadAppStoreConnectPrivacyDetail(appId) };
  } catch (error) {
    return { success: false, error: error.message || "App 隐私读取失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-save-privacy-urls", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    const localizationId = String(payload.localizationId || "").trim();
    if (!appId) throw new Error("缺少 App ID");
    if (!localizationId) throw new Error("缺少隐私本地化 ID");
    await appStoreConnectFetch(`/iris/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "appInfoLocalizations",
          id: localizationId,
          attributes: {
            privacyPolicyUrl: String(payload.privacyPolicyUrl || "").trim() || null,
            privacyChoicesUrl: String(payload.privacyChoicesUrl || "").trim() || null,
          },
        },
      }),
    });
    clearAppStoreConnectValueCache(`privacy:${appId}`);
    return { success: true, privacy: await loadAppStoreConnectPrivacyDetail(appId) };
  } catch (error) {
    return { success: false, error: error.message || "隐私 URL 保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-publish-privacy", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    if (!appId) throw new Error("缺少 App ID");
    await appStoreConnectFetch(`/iris/v1/appDataUsagesPublishState/${encodeURIComponent(appId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        data: {
          type: "appDataUsagesPublishState",
          id: appId,
          attributes: { published: true },
        },
      }),
    });
    clearAppStoreConnectValueCache(`privacy:${appId}`);
    return { success: true, privacy: await loadAppStoreConnectPrivacyDetail(appId) };
  } catch (error) {
    return { success: false, error: error.message || "App 隐私发布失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-create-data-usage", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    if (!appId) throw new Error("缺少 App ID");
    const relationships = {
      app: { data: { type: "apps", id: appId } },
    };
    if (payload.categoryId) relationships.category = { data: { type: "appDataUsageCategories", id: String(payload.categoryId) } };
    if (payload.purposeId) relationships.purpose = { data: { type: "appDataUsagePurposes", id: String(payload.purposeId) } };
    if (payload.dataProtectionId) relationships.dataProtection = { data: { type: "appDataUsageDataProtections", id: String(payload.dataProtectionId) } };
    await appStoreConnectFetch("/iris/v1/appDataUsages", {
      method: "POST",
      body: JSON.stringify({ data: { type: "appDataUsages", relationships } }),
    });
    clearAppStoreConnectValueCache(`privacy:${appId}`);
    return { success: true, privacy: await loadAppStoreConnectPrivacyDetail(appId) };
  } catch (error) {
    return { success: false, error: error.message || "数据收集保存失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-delete-data-usage", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const appId = String(payload.appId || "").trim();
    const usageId = String(payload.usageId || "").trim();
    if (!appId) throw new Error("缺少 App ID");
    if (!usageId) throw new Error("缺少数据收集 ID");
    await appStoreConnectFetch(`/iris/v1/appDataUsages/${encodeURIComponent(usageId)}`, { method: "DELETE" });
    clearAppStoreConnectValueCache(`privacy:${appId}`);
    return { success: true, privacy: await loadAppStoreConnectPrivacyDetail(appId) };
  } catch (error) {
    return { success: false, error: error.message || "数据收集删除失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

ipcMain.handle("app-store-connect-submit-review", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await submitAppStoreConnectReview(payload);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "提交审核失败", errors: error.appStoreErrors || appStoreConnectErrorItems(error.body) };
  }
});

const productContactService = require('./product-contact-client').createContactService({ fetch: authServerFetch, baseURL: currentAuthBaseURL });
ipcMain.handle('product-contacts-load', (_event, product) => productContactService.load(product));
ipcMain.handle('product-contact-open-group', async (_event, product) => {
  const result = await productContactService.load(product);
  if (!result.success || !result.data.join_url) return { success: false };
  let url;
  try { url = new URL(result.data.join_url); } catch { return { success: false }; }
  if (url.protocol !== 'https:' || !['qm.qq.com','qun.qq.com','jq.qq.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return { success: false };
  await shell.openExternal(url.href);
  return { success: true };
});

ipcMain.handle("apple-developer-open-external", async (_event, value) => {
  const url = String(value || "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("无效的网址"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("仅支持打开 http 或 https 网址");
  await shell.openExternal(parsed.toString());
  return { success: true };
});

ipcMain.handle("apple-developer-open-qq-contact", async (_event, payload = {}) => {
  const kind = String(payload.kind || "").trim().toLowerCase();
  const uin = String(payload.uin || "").trim();
  const remoteContact = await productContactService.load('certificate');
  const configured = remoteContact.success ? remoteContact.data : { qq_group_number: '1107258605', qq_contact_number: '1970332242', join_url: 'https://qm.qq.com/q/dXT0o28sCs' };
  const allowed = /^[0-9]{5,12}$/.test(uin) && (kind === 'group' ? uin === configured.qq_group_number : kind === 'person' && uin === configured.qq_contact_number);
  if (!allowed) return { success: false, error: "QQ 联系方式无效" };
  const direct = `mqqapi://card/show_pslcard?${new URLSearchParams({ src_type: "internal", version: "1", uin, card_type: kind, source: "qrcode" })}`;
  try {
    await shell.openExternal(direct);
    return { success: true, opened: "qq" };
  } catch (_error) {
    const fallback = kind === "group"
      ? (configured.join_url || "https://qun.qq.com/")
      : `https://wpa.qq.com/msgrd?${new URLSearchParams({ v: "3", uin, site: "qq", menu: "yes" })}`;
    try {
      await shell.openExternal(fallback);
      return { success: true, opened: "browser" };
    } catch (error) {
      return { success: false, error: error.message || "QQ 打开失败，请手动打开 QQ 后搜索已复制的号码" };
    }
  }
});

ipcMain.handle("device-udid-method-open", async (_event, value) => {
  const method = String(value || "").trim().toLowerCase();
  if (method === "finder") {
    if (process.platform !== "darwin") return { success: false, error: "Mac Finder 仅可在 macOS 上使用。" };
    const error = await shell.openPath("/System/Library/CoreServices/Finder.app");
    if (error) return { success: false, error: "Finder 打开失败：" + error };
    return { success: true, message: "已打开 Finder，请在侧边栏选择已连接的 iPhone 或 iPad。" };
  }
  if (method === "windows") {
    if (process.platform !== "win32") return { success: false, error: "Apple Devices / iTunes 仅可在 Windows 上使用。" };
    try {
      await shell.openExternal("ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K");
      return { success: true, message: "已打开 Apple Devices 的 Microsoft Store 页面，可直接启动或安装。" };
    } catch (error) {
      return { success: false, error: "Apple Devices 打开失败：" + (error.message || "未知错误") };
    }
  }
  return { success: false, error: "不支持的 UDID 获取方式。" };
});

function normalizedAppleDeviceUdid(value) {
  const compact = String(value || "").trim().replace(/-/g, "").toUpperCase();
  if (/^[0-9A-F]{24}$/.test(compact)) return compact.slice(0, 8) + "-" + compact.slice(8);
  if (/^[0-9A-F]{40}$/.test(compact)) return compact;
  return "";
}

function coreDeviceRows(payload = {}) {
  const rows = Array.isArray(payload?.result?.devices) ? payload.result.devices : [];
  return rows.map(item => {
    const hardware = item?.hardwareProperties || {};
    const device = item?.deviceProperties || {};
    const connection = item?.connectionProperties || {};
    const transport = String(connection.transportType || "");
    const udid = normalizedAppleDeviceUdid(hardware.udid);
    if (!udid || String(hardware.reality || "").toLowerCase() !== "physical") return null;
    if (!/^(ios|ipados)$/i.test(String(hardware.platform || ""))) return null;
    if (transport !== "wired" && transport !== "localNetwork") return null;
    return {
      name: String(device.name || hardware.marketingName || "Apple 设备"),
      udid,
      model: String(hardware.marketingName || hardware.productType || "Apple 设备"),
      product: String(hardware.productType || ""),
      version: String(device.osVersionNumber || ""),
      connection: transport === "wired" ? "usb" : "wifi",
    };
  }).filter(Boolean).sort((left, right) => {
    if (left.connection !== right.connection) return left.connection === "usb" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

async function detectUSBAppleDevices() {
  const output = await runFile("/usr/sbin/ioreg", ["-p", "IOUSB", "-c", "IOUSBHostDevice", "-r", "-l", "-w", "0"]);
  const rows = [];
  let current = null;
  const flush = () => {
    if (!current || !/^(iPhone|iPad)$/i.test(current.product || "")) return;
    const udid = normalizedAppleDeviceUdid(current.serial);
    if (udid) rows.push({ name: current.product, udid, model: current.product, product: "", version: "", connection: "usb" });
  };
  for (const line of String(output || "").split(/\r?\n/)) {
    const start = line.match(/^\s*\+\-o\s+(.+?)@.*<class IOUSBHostDevice/);
    if (start) {
      flush();
      current = { product: "", serial: "" };
      continue;
    }
    if (!current) continue;
    const product = line.match(/"(?:kUSBProductString|USB Product Name)"\s*=\s*"(iPhone|iPad)"/i);
    const serial = line.match(/"(?:kUSBSerialNumberString|USB Serial Number)"\s*=\s*"([^"]+)"/i);
    if (product) current.product = product[1];
    if (serial) current.serial = serial[1];
  }
  flush();
  return rows;
}

ipcMain.handle("device-udid-detect", async () => {
  if (process.platform !== "darwin") {
    return { success: false, devices: [], error: "自动识别当前仅支持 macOS。" };
  }
  const outputPath = path.join(app.getPath("temp"), "mayou-core-devices-" + crypto.randomUUID() + ".json");
  try {
    await runFile("/usr/bin/xcrun", ["devicectl", "list", "devices", "--timeout", "5", "--json-output", outputPath]);
    const devices = coreDeviceRows(JSON.parse(fs.readFileSync(outputPath, "utf8")));
    return { success: true, devices, source: "coredevice" };
  } catch (coreDeviceError) {
    try {
      const devices = await detectUSBAppleDevices();
      return {
        success: true,
        devices,
        source: "usb",
        warning: devices.length ? "系统未提供无线设备列表，已识别 USB 设备。" : "未发现设备。请先用数据线完成一次信任，并在 Finder 中开启“连接到 Wi-Fi 时显示此 iPhone”。",
      };
    } catch (usbError) {
      return { success: false, devices: [], error: "设备扫描失败：" + (usbError.message || coreDeviceError.message || "系统设备组件不可用") };
    }
  } finally {
    try { fs.unlinkSync(outputPath); } catch {}
  }
});

ipcMain.handle("app-store-connect-delete-media", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const detail = await deleteAppStoreConnectMedia(payload);
    return { success: true, detail };
  } catch (error) {
    return { success: false, error: error.message || "媒体删除失败" };
  }
});

ipcMain.handle("app-store-connect-upload-screenshot", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await uploadAppStoreConnectScreenshot(payload);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message || "截图上传失败" };
  }
});

ipcMain.handle("app-store-connect-create-app", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const access = String(payload.access || "full");
    const business = await fetchAppStoreConnectBusinessStatus();
    const legalEntity = business.legalEntity || {};
    const isOrganization = legalEntity.isOrganization === true;
    const sellerRows = Array.isArray(business.sellerInfo?.sellerInfo) ? business.sellerInfo.sellerInfo : [];
    const sellerName = sellerRows.find(row => String(row?.legalEntityId || "") === String(legalEntity.id || ""))?.name || sellerRows[0]?.name || "";
    const companyName = String(payload.companyName || legalEntity.legalEntityName || legalEntity.name || sellerName || "").trim();
    if (isOrganization && !companyName) throw new Error("当前 Apple 账户没有可用的公司名称，请先完善法律实体信息");
    const { body } = await appStoreConnectFetch("/iris/v1/apps", {
      method: "POST",
      body: JSON.stringify(appStoreCreatePayload({ ...payload, companyName, isOrganization })),
    });
    const appId = String(body?.data?.id || "");
    if (access === "full" && appId) {
      await appStoreConnectFetch("/iris/v1/userAppPermissions", {
        method: "POST",
        body: JSON.stringify({ data: { type: "userAppPermissions", attributes: { appAdamId: appId, userOperationType: "ALL_SILOABLE_USERS", operationType: "GRANT" } } }),
      });
    }
    return { success: true, app: normalizeAppStoreApps({ data: [body.data] })[0] || { id: appId } };
  } catch (error) {
    return { success: false, error: error.message || "App 创建失败" };
  }
});

ipcMain.handle("developer-accounts-open-purchase", async () => {
  try {
    await shell.openExternal(`${currentAuthBaseURL()}/profile/membership`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "购买页面打开失败" };
  }
});

ipcMain.handle("apple-developer-access-check", async () => {
  try {
    restoreIndependentDeveloperAccount();
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表选择账户");
    const status = await readAppleDeveloperStatus();
    if (status.authenticated) {
      const synced = await syncAppleDeveloperAccountUsage();
      if (synced?.success && synced.access) return { success: true, access: synced.access, accountId: appleDeveloperRecordId };
      throw new Error(synced?.error || "无法同步账户使用期限，请稍后重试");
    }
    const accessMap = await readAppleDeveloperAccessMap();
    if (!accessMap) throw new Error("无法连接授权服务器，请稍后重试");
    const access = accessMap[String(appleDeveloperRecordId)] || {
      allowed: true, trialStarted: false, activated: false, firstLoginAt: "",
      trialExpiresAt: "", authorizationExpiresAt: "", remainingDays: 15,
    };
    return { success: true, access, accountId: appleDeveloperRecordId };
  } catch (error) {
    return { success: false, error: error.message || "授权状态读取失败" };
  }
});

ipcMain.handle("apple-developer-access-activate", async (_event, verificationCode) => {
  try {
    restoreIndependentDeveloperAccount();
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表选择账户");
    const code = String(verificationCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6,16}$/.test(code)) throw new Error("请输入有效核验码");
    const response = await authServerFetch(
      `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/activate`,
      {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationCode: code, appleId: appleDeveloperLaunchAppleId }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `开通失败 (${response.status})`);
    return { success: true, access: body.access };
  } catch (error) {
    return { success: false, error: error.message || "核验码开通失败" };
  }
});

ipcMain.handle("apple-developer-open-purchase", async () => {
  try {
    await shell.openExternal(`${currentAuthBaseURL()}/profile/membership`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "购买页面打开失败" };
  }
});

ipcMain.handle("apple-developer-launch-context", async () => {
  const authState = await authRequest("/api/auth/me").catch(() => null);
  const user = authState?.success ? authState.user || null : null;
  const displayNetwork = appleDeveloperNetwork || appleDeveloperLaunchNetwork || { enabled: false, mode: "direct" };
  return {
    appleId: appleDeveloperLaunchAppleId,
    accountId: appleDeveloperRecordId,
    p12Password: appleDeveloperP12Password || DEFAULT_P12_PASSWORD,
    network: {
      enabled: displayNetwork.enabled === true,
      mode: displayNetwork.mode || displayNetwork.type || "",
      ip: displayNetwork.ip || displayNetwork.lastVerifiedIp || "",
      lastVerifiedIp: displayNetwork.lastVerifiedIp || displayNetwork.ip || "",
      country: displayNetwork.country || "",
      region: displayNetwork.region || "",
      city: displayNetwork.city || "",
      isp: displayNetwork.isp || "",
    },
    independent: isCertificateManagerIndependent(),
    browserBound: !isCertificateManagerIndependent(),
    desktopAccount: user ? {
      username: String(user.username || ""),
      loginType: user.login_type === "employee" ? "employee" : "boss",
      id: user.login_type === "employee" ? user.sub_account_id : user.id,
    } : null,
  };
});

ipcMain.handle("apple-developer-login-history", async () => {
  const accessMap = await readAppleDeveloperAccessMap();
  return {
    independent: isCertificateManagerIndependent(),
    accounts: readStandaloneLoginHistory().map(row => {
      const access = accessMap?.[String(row.accountId || "")] || null;
      return {
        appleId: row.appleId,
        accountId: row.accountId || "",
        access,
        lastIp: row.lastIp || "",
        proxyEnabled: row.proxyEnabled === true,
        location: [row.country, row.region, row.city].filter(Boolean).join(" "),
        lastLoginAt: row.lastLoginAt || "",
      };
    }),
  };
});

ipcMain.handle("apple-developer-select-login-history", async (_event, appleId) => {
  await waitForAppleContextRefreshes(true);
  const row = selectStandaloneLoginHistory(appleId);
  if (!row) return { success: false, error: "未找到该本地账户记录" };
  let proxy = { enabled: false };
  try {
    const saved = JSON.parse(fs.readFileSync(appleDeveloperNetworkFilePath(), "utf8"));
    if (saved && typeof saved === "object") proxy = saved;
  } catch {}
  return {
    success: true,
    appleId: row.appleId,
    lastIp: row.lastIp || "",
    location: [row.country, row.region, row.city].filter(Boolean).join(" "),
    proxy,
  };
});

ipcMain.handle("apple-developer-update-p12-password", async (_event, p12PasswordValue) => {
  try {
    const payload = p12PasswordValue && typeof p12PasswordValue === "object" ? p12PasswordValue : {};
    const certificateId = String(payload.certificateId || "").trim();
    const rawPassword = certificateId ? payload.password : p12PasswordValue;
    const p12Password = String(rawPassword || "").trim();
    if (!p12Password) throw new Error("P12 密码不能为空");
    if (certificateId) {
      const team = readSelectedAppleDeveloperTeam();
      if (!team || !/^[A-Za-z0-9]+$/.test(certificateId)) throw new Error("证书参数无效");
      if (!saveAppleCertificateP12Password(team.id, certificateId, p12Password)) throw new Error("证书 P12 密码保存失败");
      return { success: true, certificateId, p12Password };
    }
    appleDeveloperP12Password = p12Password;
    if (appleDeveloperOwnerKey && appleDeveloperRecordId) {
      withDeveloperAccountsDatabase(db => db.prepare("UPDATE developer_accounts SET p12_password=? WHERE owner_key=? AND id=?").run(p12Password, appleDeveloperOwnerKey, appleDeveloperRecordId));
    }
    const synced = await syncDeveloperAccountP12Password(appleDeveloperRecordId, p12Password);
    if (!synced.success && !synced.skipped) return { success: false, error: synced.error || "服务器 P12 密码同步失败" };
    return { success: true, p12Password };
  } catch (error) { return { success: false, error: error.message || "P12 密码修改失败" }; }
});

function readAppleDeveloperUploadProxy() {
  try { return JSON.parse(fs.readFileSync(appleDeveloperNetworkFilePath(), "utf8")); }
  catch {
    if (appleDeveloperNetwork) {
      return {
        ...appleDeveloperNetwork,
        type: appleDeveloperNetwork.type || appleDeveloperNetwork.mode || "http",
      };
    }
    return { enabled: false };
  }
}

ipcMain.handle("apple-developer-upload-context", async () => {
  const proxy = readAppleDeveloperUploadProxy();
  return {
    appleId: appleDeveloperLaunchAppleId,
    appPassword: readAppleAppSpecificPassword(),
    proxyEnabled: !!(proxy?.enabled && proxy.host && proxy.port),
    proxyLabel: proxy?.enabled && proxy.host && proxy.port
      ? `${String(proxy.type || "http").toUpperCase()} ${proxy.host}:${proxy.port}`
      : "本机网络直连",
  };
});

function appleAppSpecificPasswordPath() {
  return path.join(appleDeveloperAccountStorageDir(), "app-specific-password.enc");
}

function localSecretKeyPath() {
  return path.join(sharedUserDataDir(), "local-secret.key");
}

function localSecretKey() {
  const keyPath = localSecretKeyPath();
  try {
    const saved = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64");
    if (saved.length === 32) return saved;
  } catch {}
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  return key;
}

function encryptLocalSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", localSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function decryptLocalSecret(payload) {
  const parsed = JSON.parse(String(payload || ""));
  if (parsed?.version !== 1 || parsed?.algorithm !== "aes-256-gcm") return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", localSecretKey(), Buffer.from(parsed.iv || "", "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag || "", "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data || "", "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function isEncryptedLocalSecret(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed?.version === 1 && parsed?.algorithm === "aes-256-gcm";
  } catch {
    return false;
  }
}

function decryptDeveloperAccountPassword(value) {
  const stored = String(value || "");
  if (!stored) return "";
  try { return isEncryptedLocalSecret(stored) ? decryptLocalSecret(stored) : stored; } catch { return ""; }
}

function readAppleAppSpecificPassword() {
  try {
    return decryptLocalSecret(fs.readFileSync(appleAppSpecificPasswordPath(), "utf8"));
  } catch {
    return "";
  }
}

function normalizeAppleAppSpecificPassword(value) {
  const compact = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "");
  if (!compact) throw new Error("请输入 App 专用密码");
  if (!/^[A-Za-z0-9]+$/.test(compact)) throw new Error("专用密码只能包含英文字母和数字");
  if (compact.length !== 16) throw new Error("专用密码长度必须是 16 位");
  return compact.toLowerCase().match(/.{1,4}/g).join("-");
}

function saveAppleAppSpecificPassword(value) {
  const password = String(value || "");
  const target = appleAppSpecificPasswordPath();
  if (!password) {
    try { fs.unlinkSync(target); } catch {}
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, encryptLocalSecret(password), { mode: 0o600 });
}

function buildUploadErrorLogText(payload = {}) {
  const rawLogs = String(payload.error_logs || "").trim();
  if (rawLogs) return rawLogs;
  const lines = [];
  const append = value => {
    const text = String(value || "").trim();
    if (text) lines.push(text);
  };
  append(`任务ID：${String(payload.taskId || "").trim() || "未知"}`);
  append(`Apple ID：${String(payload.appleId || "").trim() || "未知"}`);
  append(`IPA 文件：${String(payload.ipaName || "").trim() || "未知"}`);
  append(`错误信息：${String(payload.errorMessage || "").trim() || "无"}`);
  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length) {
    lines.push("");
    lines.push("最近日志：");
    events.slice(-30).forEach(event => {
      const time = event?.time ? `[${event.time}] ` : "";
      lines.push(`${time}${String(event?.level || "info").toUpperCase()}: ${String(event?.message || "")}`);
    });
  }
  return lines.join("\n");
}

async function analyzeDeepSeekUploadError(payload = {}) {
  const errorLogs = buildUploadErrorLogText(payload);
  if (!errorLogs.trim()) return { success: false, error: "没有可供分析的错误日志" };
  const accountId = String(payload.accountId || payload.account_id || appleDeveloperRecordId || "").trim();
  if (!accountId) return { success: false, error: "请先从开发者账户列表启动证书管理" };
  const appleId = String(payload.appleId || payload.apple_id || appleDeveloperLaunchAppleId || "").trim();
  const result = await authRequest(`/api/developer-sync/accounts/${encodeURIComponent(accountId)}/upload-error-ai-analyze`, {
    method: "POST",
    body: JSON.stringify({ error_logs: errorLogs, apple_id: appleId }),
  });
  if (result?.success) {
    return { success: true, analysis: String(result.analysis || "").trim() || "未返回分析结果" };
  }
  return { success: false, error: result?.error || "AI 解析失败", usage: result?.usage, access: result?.access };
}

ipcMain.handle("apple-app-password-save-local", async (_event, password) => {
  try {
    const normalized = normalizeAppleAppSpecificPassword(password);
    saveAppleAppSpecificPassword(normalized);
    return { success: true, password: normalized };
  } catch (error) {
    return { success: false, error: error.message || "专用密码保存失败" };
  }
});

function sameProxy(left = {}, right = {}) {
  if (!left?.enabled || !right?.enabled) return !left?.enabled && !right?.enabled;
  return String(left.type || "http").toLowerCase() === String(right.type || "http").toLowerCase()
    && String(left.host || "").trim() === String(right.host || "").trim()
    && String(left.port || "").trim() === String(right.port || "").trim()
    && String(left.username || "") === String(right.username || "");
}

let appleAccountAuthClient = null;
let appleAccountSession = null;
let appleAccountManageScnt = "";
let appleAccountApiKey = "";
let appleAccountApiUrl = "";

function asciiJSONStringify(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function configureAppleAccountSession() {
  const ses = session.fromPartition(appleAccountPartitionForAccount());
  const proxy = readAppleDeveloperUploadProxy();
  const tunnelId = `apple-account-${appleDeveloperAccountKey}`;
  stopLocalProxyTunnel(tunnelId);
  if (!proxy?.enabled) await ses.setProxy({ mode: "direct" });
  else if (String(proxy.type).toLowerCase() === "socks5" && (proxy.username || proxy.password)) {
    const tunnel = await startLocalProxyTunnel(tunnelId, proxy);
    await ses.setProxy({ proxyRules: `http://127.0.0.1:${tunnel.port}`, proxyBypassRules: "<-loopback>" });
  } else {
    const scheme = String(proxy.type).toLowerCase() === "socks5" ? "socks5" : "http";
    const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || "")}@` : "";
    await ses.setProxy({ proxyRules: `${scheme}://${auth}${proxy.host}:${proxy.port}`, proxyBypassRules: "<-loopback>" });
  }
  await ses.closeAllConnections();
  appleAccountSession = ses;
  return ses;
}

function appleAccountHeaders(client) {
  const userAgent = appleAccountSession.getUserAgent();
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://account.apple.com",
    Referer: "https://account.apple.com/",
    "X-Apple-I-TimeZone": "Asia/Shanghai",
    "X-Apple-I-Request-Context": "ca",
    "X-Apple-I-FD-Client-Info": asciiJSONStringify({ U: userAgent, L: "zh-CN", Z: "GMT+08:00", V: "1.1", ...(client.clientFingerprint ? { F: client.clientFingerprint } : {}) }),
    ...(appleAccountApiKey ? { "X-Apple-Api-Key": appleAccountApiKey } : {}),
    ...(appleAccountManageScnt ? { scnt: appleAccountManageScnt } : {}),
  };
}

async function appleAccountManageRequest(pathname, { method = "GET", data, timeout = 30000 } = {}) {
  if (!appleAccountAuthClient || !appleAccountSession) throw new Error("Apple Account 登录会话尚未建立");
  if (!appleAccountApiUrl) throw new Error("Apple Account 接口地址尚未初始化");
  const response = await appleAccountSession.fetch(`${appleAccountApiUrl}${pathname}`, {
    method, credentials: "include", redirect: "manual", signal: AbortSignal.timeout(timeout),
    headers: appleAccountHeaders(appleAccountAuthClient),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const scnt = response.headers.get("scnt");
  if (scnt) appleAccountManageScnt = scnt;
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  return { response, body };
}

async function bootstrapAppleAccountPortal(ses, clientFingerprint) {
  const userAgent = ses.getUserAgent();
  await ses.fetch("https://account.apple.com/", {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/html" },
  });
  const response = await ses.fetch("https://account.apple.com/bootstrap/portal", {
    credentials: "include",
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Referer: "https://account.apple.com/",
      "X-Apple-I-TimeZone": "Asia/Shanghai",
      "X-Apple-I-Request-Context": "ca",
      "X-Apple-I-FD-Client-Info": asciiJSONStringify({
        U: userAgent, L: "zh-CN", Z: "GMT+08:00", V: "1.1",
        ...(clientFingerprint ? { F: clientFingerprint } : {}),
      }),
    },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  const apiUrl = String(body?.apiUrl || "").replace(/\/+$/, "");
  const serviceKey = String(body?.serviceKey || "");
  if (!response.ok || !/^https:\/\/appleid\.apple\.com$/i.test(apiUrl) || !/^[a-f0-9]{64}$/i.test(serviceKey)) {
    throw new Error(`Apple Account 启动配置读取失败 (${response.status})`);
  }
  appleAccountApiUrl = apiUrl;
  return { serviceKey };
}

async function establishAppleAccountManageSession() {
  // The first token call deliberately has no API key. Its unauthenticated
  // response supplies the scnt that Apple expects again immediately after 2FA.
  const token = await appleAccountManageRequest("/account/manage/gs/ws/token");
  if (!token.response.ok) return token;
  const manage = await appleAccountManageRequest("/account/manage");
  if (!manage.response.ok) return manage;
  const apiKey = String(manage.body?.apiKey || "");
  if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new Error("Apple Account API Key 获取失败");
  appleAccountApiKey = apiKey;
  return manage;
}

ipcMain.handle("apple-app-password-open", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperLaunchAppleId || !appleDeveloperLaunchPassword) throw new Error("当前开发者账户没有保存 Apple ID 登录密码");
    const fingerprint = String(payload.clientFingerprint || "").trim();
    if (!/^[.0-9A-Z_a-z]{80,256}$/.test(fingerprint)) throw new Error("Apple 客户端指纹生成失败");
    const ses = await configureAppleAccountSession();
    appleAccountManageScnt = "";
    appleAccountApiKey = "";
    appleAccountApiUrl = "";
    const portal = await bootstrapAppleAccountPortal(ses, fingerprint);
    appleAccountAuthClient = new AppleAuthClient(ses, {
      clientFingerprint: fingerprint,
      oauth: { clientId: portal.serviceKey, redirectURI: "https://account.apple.com" },
      skipTrust: true,
    });
    try {
      const token = await establishAppleAccountManageSession();
      if (!token.response.ok) throw new Error("cached session unavailable");
      const cached = await appleAccountManageRequest("/account/manage/security/secondary-password", { timeout: 8000 });
      if (cached.response.status === 200) return { success: true, authenticated: true, requires2FA: false };
    } catch {}
    await ses.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers"] });
    await ses.closeAllConnections();
    appleAccountManageScnt = "";
    appleAccountApiKey = "";
    appleAccountApiUrl = "";
    const freshPortal = await bootstrapAppleAccountPortal(ses, fingerprint);
    appleAccountAuthClient = new AppleAuthClient(ses, {
      clientFingerprint: fingerprint,
      oauth: { clientId: freshPortal.serviceKey, redirectURI: "https://account.apple.com" },
      skipTrust: true,
    });
    await appleAccountManageRequest("/account/manage/gs/ws/token", { timeout: 8000 }).catch(() => null);
    const result = await appleAccountAuthClient.login(appleDeveloperLaunchAppleId, appleDeveloperLaunchPassword, true);
    if (!result.requires2FA) {
      const established = await establishAppleAccountManageSession();
      if (!established.response.ok) throw new Error(`Apple Account 会话建立失败 (${established.response.status})`);
    }
    return { success: true, authenticated: !result.requires2FA, ...result };
  } catch (error) {
    return { success: false, error: error.message || "Apple Account 登录失败" };
  }
});

ipcMain.handle("apple-app-password-method", async (_event, method) => {
  try {
    if (!appleAccountAuthClient) throw new Error("Apple Account 登录会话已过期");
    if (method === "sms") await appleAccountAuthClient.requestSMS();
    else appleAccountAuthClient.secondFactor = { method: "device" };
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-app-password-verify", async (_event, code) => {
  try {
    if (!/^\d{6}$/.test(String(code || ""))) throw new Error("请输入 6 位验证码");
    if (!appleAccountAuthClient) throw new Error("Apple Account 登录会话已过期");
    await appleAccountAuthClient.verifyCode(String(code));
    const established = await establishAppleAccountManageSession();
    if (!established.response.ok) throw new Error(`Apple Account 会话建立失败 (${established.response.status})`);
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-app-password-create", async (_event, payload = {}) => {
  try {
    const description = String(payload.description || "").trim().slice(0, 50);
    if (!description) throw new Error("请输入专用密码备注");
    let created = await appleAccountManageRequest("/account/manage/security/secondary-password", { method: "POST", data: { description } });
    if (created.response.status === 451) {
      const verified = await appleAccountManageRequest("/authenticate/password", { method: "POST", data: { password: appleDeveloperLaunchPassword } });
      if (![200, 204].includes(verified.response.status)) throw new Error(`Apple 密码二次确认失败 (${verified.response.status})`);
      created = await appleAccountManageRequest("/account/manage/security/secondary-password", { method: "POST", data: { description } });
    }
    if (!created.response.ok || !created.body?.password) throw new Error(created.body?.message || `App 专用密码创建失败 (${created.response.status})`);
    return { success: true, password: created.body.password, description: created.body.description || description };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-status", async () => readAppleDeveloperStatus());

ipcMain.handle("apple-developer-account-info", async () => {
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const contextCurrent = () => appleDeveloperContextIsCurrent(generation, accountKey);
  try {
    // Login already validates the Developer session. Repeating the entire
    // SSO recovery flow here delays every membership/profile request.
    if (!appleDeveloperAuthenticated) {
      const status = await readAppleDeveloperStatus();
      if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期" };
    }
    if (!contextCurrent()) return { success: false, stale: true };
    const ses = session.fromPartition(appleDeveloperPartitionForAccount(accountKey));
    const post = async (url, requestBody = {}, timeout = 12000) => {
      const response = await ses.fetch(url, {
        method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(timeout),
        headers: { Accept: "application/json", "Content-Type": "application/json", Referer: "https://developer.apple.com/account/", "User-Locale": "en_US" },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; }
      catch { throw new Error("Apple 账户接口未返回有效资料，请重新登录后重试"); }
      if (!response.ok || Number(body?.resultCode || 0) !== 0) {
        const detail = appleDeveloperServiceError(body, text);
        const resultCode = body?.resultCode == null ? "" : `，resultCode ${body.resultCode}`;
        throw new Error(`Apple 账户信息读取失败 (${response.status}${resultCode})${detail ? `：${detail}` : ""}`);
      }
      return body;
    };
    const [teamsResult, profileResult] = await Promise.allSettled([
      post("https://developer.apple.com/services-account/QH65B2/account/getTeams", { includeInMigrationTeams: 1 }),
      post("https://developer.apple.com/services-account/QH65B2/account/getUserProfile", {}, 6000),
    ]);
    if (!contextCurrent()) return { success: false, stale: true };
    if (teamsResult.status === "rejected") throw teamsResult.reason;
    // The profile only supplies the display name; its failure must not hide
    // a successfully loaded Developer membership.
    const teamsBody = teamsResult.value;
    const profile = profileResult.status === "fulfilled" ? profileResult.value?.userProfile || {} : {};
    const selectedTeamId = readSelectedAppleDeveloperTeam()?.id || "";
    const teams = (Array.isArray(teamsBody?.teams) ? teamsBody.teams : []).map(normalizeAppleDeveloperTeamDetails);
    return {
      success: true,
      account: { appleId: String(profile?.email || appleDeveloperLaunchAppleId || ""), name: [profile?.localizedLastName, profile?.localizedFirstName].filter(Boolean).join("") || [profile?.firstName, profile?.lastName].filter(Boolean).join(" "), developerStatus: String(profile?.developerStatus || ""), twoFactorEnabled: profile?.appleId?.twoFAEnabled === true },
      selectedTeamId, teams,
    };
  } catch (error) {
    if (!contextCurrent()) return { success: false, stale: true };
    const timedOut = /abort|timeout/i.test(String(error?.name || "") + String(error?.message || ""));
    return { success: false, error: timedOut ? "会员信息读取超时，请检查网络后重试" : (error.message || "会员信息读取失败") };
  }
});

function normalizeAppleAgreement(row = {}) {
  return {
    id: String(row.agreementId || ""),
    title: String(row.title || "Apple Developer 协议"),
    version: String(row.version || ""),
    status: String(row.status || ""),
    role: String(row.role || ""),
    downloadURL: String(row.agreementDownloadUrl || ""),
    dateEffective: Number(row.dateEffective || 0),
    dateAgreeBy: Number(row.dateAgreeBy || 0),
    isProgramLicenseAgreement: row.isAgreementPLA === true,
  };
}

async function fetchAppleAgreementStatus() {
  const status = await readAppleDeveloperStatus();
  if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
  const teamResult = await fetchAppleDeveloperTeams();
  if (!teamResult.success) return teamResult;
  const teams = teamResult.teams || [];
  let team = readSelectedAppleDeveloperTeam();
  if (team && !teams.some(item => item.id === team.id)) team = null;
  if (!team && teams.length === 1) team = saveSelectedAppleDeveloperTeam(teams[0]);
  if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };

  const ses = session.fromPartition(appleDeveloperPartition());
  const bootstrapResponse = await ses.fetch("https://developer.apple.com/services-account/QH65B2/account/getTeams", {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: "https://developer.apple.com/account",
      "User-Locale": "en_US",
    },
    body: JSON.stringify({ includeInMigrationTeams: 1 }),
  });
  const bootstrapText = await bootstrapResponse.text();
  let bootstrapBody = {};
  try { bootstrapBody = bootstrapText ? JSON.parse(bootstrapText) : {}; } catch { bootstrapBody = { text: bootstrapText }; }
  if (!bootstrapResponse.ok || Number(bootstrapBody?.resultCode || 0) !== 0) {
    return { success: false, error: appleDeveloperServiceError(bootstrapBody, bootstrapText) || `Apple 团队协议状态初始化失败 (${bootstrapResponse.status})` };
  }
  const bootstrapCSRF = String(bootstrapResponse.headers.get("csrf") || "");
  const bootstrapCSRFTimestamp = String(bootstrapResponse.headers.get("csrf_ts") || "");
  const response = await ses.fetch("https://developer.apple.com/services-account/QH65B2/account/getNotifications", {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Referer: "https://developer.apple.com/account",
      "User-Locale": "en_US",
      ...(bootstrapCSRF ? { csrf: bootstrapCSRF } : {}),
      ...(bootstrapCSRFTimestamp ? { csrf_ts: bootstrapCSRFTimestamp } : {}),
    },
    body: JSON.stringify({ teamId: team.id }),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok || Number(body?.resultCode || 0) !== 0) {
    return { success: false, error: appleDeveloperServiceError(body, text) || `Apple 协议状态读取失败 (${response.status})` };
  }
  const outstanding = Array.isArray(body?.notifications?.agreementsOutstanding)
    ? body.notifications.agreementsOutstanding.map(normalizeAppleAgreement).filter(item => item.id)
    : [];
  return {
    success: true,
    team,
    outstanding,
    agreementAccepted: outstanding.length === 0,
    csrf: String(response.headers.get("csrf") || bootstrapCSRF),
    csrfTimestamp: String(response.headers.get("csrf_ts") || bootstrapCSRFTimestamp),
  };
}

ipcMain.handle("apple-developer-agreement-status", async () => {
  try {
    const result = await fetchAppleAgreementStatus();
    if (!result.success) return result;
    return { success: true, team: result.team, outstanding: result.outstanding, agreementAccepted: result.agreementAccepted };
  } catch (error) { return { success: false, error: error.message || "Apple 协议状态读取失败" }; }
});

ipcMain.handle("apple-developer-agreement-detail", async (_event, payload = {}) => {
  try {
    const agreementId = String(payload.agreementId || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(agreementId)) return { success: false, error: "协议 ID 无效" };
    const state = await fetchAppleAgreementStatus();
    if (!state.success) return state;
    const agreement = state.outstanding.find(item => item.id === agreementId);
    if (!agreement) return { success: false, error: "该协议已处理或不属于当前团队，请刷新状态" };
    const ses = session.fromPartition(appleDeveloperPartition());
    const response = await ses.fetch("https://developer.apple.com/services-enrollment/listAgreements", {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://developer.apple.com/account",
        "User-Locale": "en_US",
        ...(state.csrf ? { csrf: state.csrf } : {}),
        ...(state.csrfTimestamp ? { csrf_ts: state.csrfTimestamp } : {}),
      },
      body: new URLSearchParams({
        teamId: state.team.id,
        agreementType: "ad19",
        agreementId,
      }).toString(),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!response.ok || Number(body?.resultCode || 0) !== 0) {
      return { success: false, error: appleDeveloperServiceError(body, text) || `Apple 协议正文读取失败 (${response.status})` };
    }
    const detail = body?.agreement || {};
    let agreementHTML = "";
    try { agreementHTML = decodeURIComponent(String(detail.agreementText || "").replace(/\+/g, " ")); }
    catch { agreementHTML = String(detail.agreementText || ""); }
    return {
      success: true,
      agreement: { ...agreement, ...normalizeAppleAgreement(detail), agreementHTML },
      csrf: String(response.headers.get("csrf") || state.csrf || ""),
      csrfTimestamp: String(response.headers.get("csrf_ts") || state.csrfTimestamp || ""),
    };
  } catch (error) { return { success: false, error: error.message || "Apple 协议正文读取失败" }; }
});

ipcMain.handle("apple-developer-accept-agreement", async (_event, payload = {}) => {
  try {
    const agreementId = String(payload.agreementId || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(agreementId)) return { success: false, error: "协议 ID 无效" };
    const state = await fetchAppleAgreementStatus();
    if (!state.success) return state;
    const agreement = state.outstanding.find(item => item.id === agreementId);
    if (!agreement) return { success: false, error: "该协议已处理或不属于当前团队，请刷新状态" };

    const ses = session.fromPartition(appleDeveloperPartition());
    const detailResponse = await ses.fetch("https://developer.apple.com/services-enrollment/listAgreements", {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://developer.apple.com/account",
        "User-Locale": "en_US",
        ...(state.csrf ? { csrf: state.csrf } : {}),
        ...(state.csrfTimestamp ? { csrf_ts: state.csrfTimestamp } : {}),
      },
      body: new URLSearchParams({ teamId: state.team.id, agreementType: "ad19", agreementId }).toString(),
    });
    const detailText = await detailResponse.text();
    let detailBody = {};
    try { detailBody = detailText ? JSON.parse(detailText) : {}; } catch { detailBody = { text: detailText }; }
    if (!detailResponse.ok || Number(detailBody?.resultCode || 0) !== 0) {
      return { success: false, error: appleDeveloperServiceError(detailBody, detailText) || `Apple 协议确认失败 (${detailResponse.status})` };
    }
    const csrf = String(detailResponse.headers.get("csrf") || state.csrf || "");
    const csrfTimestamp = String(detailResponse.headers.get("csrf_ts") || state.csrfTimestamp || "");
    if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 未返回协议安全令牌，请重新打开协议后再试" };

    const response = await ses.fetch("https://developer.apple.com/services-account/QH65B2/account/acceptAgreements", {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: `https://developer.apple.com/account/agree/${agreementId}/terms`,
        "User-Locale": "en_US",
        csrf,
        csrf_ts: csrfTimestamp,
      },
      body: JSON.stringify({ teamId: state.team.id, agreementIds: [agreementId] }),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!response.ok || Number(body?.resultCode || 0) !== 0) {
      return { success: false, error: appleDeveloperServiceError(body, text) || `Apple 协议同意失败 (${response.status})` };
    }
    const accepted = (Array.isArray(body?.agreements) ? body.agreements : [])
      .map(normalizeAppleAgreement)
      .find(item => item.id === agreementId);
    return { success: true, accepted: accepted || { ...agreement, status: "active" } };
  } catch (error) { return { success: false, error: error.message || "Apple 协议同意失败" }; }
});

ipcMain.handle("app-store-connect-terms-status", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await fetchAppStoreConnectTermsStatus();
  } catch (error) {
    return { success: false, error: error.message || "App Store Connect 服务条款读取失败" };
  }
});

ipcMain.handle("app-store-connect-accept-terms", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await acceptAppStoreConnectTerms(payload);
  } catch (error) {
    return { success: false, error: error.message || "App Store Connect 服务条款同意失败" };
  }
});

ipcMain.handle("app-store-connect-business-status", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await fetchAppStoreConnectBusinessStatus();
  } catch (error) {
    return { success: false, error: error.message || "App Store Connect 商务状态读取失败" };
  }
});

async function appStoreConnectTaxContext(payload = {}, provider = null) {
  const currentProvider = provider || await fetchAppStoreConnectCurrentProvider();
  const accountId = String(currentProvider.id || "").trim();
  if (!accountId) throw new Error("当前 Apple 账户缺少商务账户 ID");
  const requestedAccountId = String(payload.accountId || "").trim();
  if (requestedAccountId && requestedAccountId !== accountId) throw new Error("当前 Apple 账户已切换，请刷新后重试");
  const { body } = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities");
  const rows = Array.isArray(body?.data) ? body.data : [];
  const requestedLegalEntityId = String(payload.legalEntityId || "").trim();
  const legalEntity = requestedLegalEntityId
    ? rows.find(row => String(row?.legalEntityId || row?.id || "") === requestedLegalEntityId)
    : rows[0];
  if (!legalEntity) throw new Error(requestedLegalEntityId ? "Apple 账户已切换，请刷新后重试" : "当前商务账户没有可用的法律实体");
  const legalEntityId = String(legalEntity.legalEntityId || legalEntity.id || "").trim();
  const vendorId = String(legalEntity.vendorId || "").trim();
  const vendorScopes = Array.isArray(legalEntity.vendorScope) ? legalEntity.vendorScope : (Array.isArray(legalEntity.vendorScopes) ? legalEntity.vendorScopes : []);
  const requestedVendorScopeId = String(payload.vendorScopeId || "").trim();
  const vendorScope = requestedVendorScopeId
    ? vendorScopes.find(row => String(row?.vendorScopeId || "") === requestedVendorScopeId)
    : vendorScopes[0];
  const vendorScopeId = String(vendorScope?.vendorScopeId || "").trim();
  if (!vendorId || !vendorScopeId) throw new Error(requestedVendorScopeId ? "税务范围已变化，请刷新后重试" : "当前法律实体缺少税务接口参数");
  return { accountId, legalEntityId, vendorId, vendorScopeId };
}

ipcMain.handle("app-store-connect-tax-questionnaire-metadata", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const context = await appStoreConnectTaxContext(payload, provider);
    const { accountId, vendorId, vendorScopeId } = context;
    const taxFormType = String(payload.taxFormType || "").trim();
    const taxCountry = String(payload.taxCountry || "").trim();
    if (!accountId || !vendorId || !vendorScopeId || !taxFormType || !taxCountry) throw new Error("缺少税务问卷参数");
    const source = payload.formData && typeof payload.formData === "object" && !Array.isArray(payload.formData) ? payload.formData : {};
    const body = JSON.parse(JSON.stringify(source));
    if (Object.keys(body).length) {
      const bodyFormType = String(body.taxFormType || taxFormType).trim();
      const bodyCountry = String(body.taxCountry || taxCountry).trim();
      if (bodyFormType !== taxFormType || bodyCountry !== taxCountry) throw new Error("税务表参数已变化，请刷新后重试");
      body.accountId = accountId;
      body.taxFormType = taxFormType;
      body.taxCountry = taxCountry;
    }
    const [metadataResult, l10nResult] = await Promise.allSettled([
      appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(vendorId)}/vendorScopes/${encodeURIComponent(vendorScopeId)}/taxForms/${encodeURIComponent(taxFormType)}/metadata`, { method: "POST", body, headers: { Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(context.legalEntityId)}` } }),
      taxFormType === "USA_FOREIGN_ENTITY_QUESTIONNAIRE"
        ? appStoreConnectBusinessFetch(accountId, "/ppm/l10n")
        : Promise.resolve(null),
    ]);
    if (metadataResult.status === "rejected") throw metadataResult.reason;
    const l10n = l10nResult.status === "fulfilled" && l10nResult.value ? normalizeBusinessL10nMap(l10nResult.value.body || {}) : {};
    return { ...normalizeTaxQuestionnaireMetadata(metadataResult.value.body || {}, l10n), context };
  } catch (error) {
    return { success: false, error: error.message || "税务问卷元数据读取失败" };
  }
});

function taxAddressPath(vendorId, query = "") {
  return `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(vendorId)}/taxAddresses${query}`;
}

async function appStoreConnectTaxAddressContext(payload = {}) {
  const provider = await fetchAppStoreConnectCurrentProvider();
  const accountId = String(provider.id || "").trim();
  const requestedAccountId = String(payload.accountId || "").trim();
  if (requestedAccountId && requestedAccountId !== accountId) throw new Error("当前 Apple 账户已切换，请刷新后重试");
  const context = await appStoreConnectTaxContext(payload, provider);
  const taxFormType = String(payload.taxFormType || "").trim();
  if (!/^[A-Z0-9_]+$/.test(taxFormType)) throw new Error("缺少有效的税务表类型");
  return { ...context, taxFormType };
}

function normalizeTaxAddressResponse(body = {}, l10n = {}) {
  const constraints = body?.constraints && typeof body.constraints === "object" ? body.constraints : {};
  const localizedConstraints = {};
  for (const [key, rule] of Object.entries(constraints)) {
    const options = Array.isArray(rule?.options)
      ? rule.options.map(option => ({
        ...option,
        value: String(option?.value || ""),
        label: businessL10nText(l10n, option?.locKey, option?.value),
      }))
      : rule?.options;
    localizedConstraints[key] = {
      ...rule,
      label: businessL10nText(l10n, rule?.labelKey, rule?.attributeName),
      ...(options ? { options } : {}),
    };
  }
  return { ...body, constraints: localizedConstraints };
}

ipcMain.handle("app-store-connect-tax-addresses", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const context = await appStoreConnectTaxAddressContext(payload);
    const [addressResult, l10nResult] = await Promise.allSettled([
      appStoreConnectBusinessFetch(context.accountId, taxAddressPath(context.vendorId, `?taxFormType=${encodeURIComponent(context.taxFormType)}`)),
      appStoreConnectBusinessFetch(context.accountId, "/ppm/l10n"),
    ]);
    if (addressResult.status === "rejected") throw addressResult.reason;
    const l10n = l10nResult.status === "fulfilled" ? normalizeBusinessL10nMap(l10nResult.value.body || {}) : {};
    return { ...normalizeTaxAddressResponse(addressResult.value.body || {}, l10n), success: true, context };
  } catch (error) {
    return { success: false, error: error.message || "税务地址读取失败" };
  }
});

ipcMain.handle("app-store-connect-tax-address-metadata", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const context = await appStoreConnectTaxAddressContext(payload);
    const address = payload.address && typeof payload.address === "object" ? payload.address : {};
    const body = { accountId: context.accountId, vendorId: context.vendorId };
    ["addressLine1", "addressLine2", "addressLine3", "city", "postalCode", "country", "regionText", "regionSelect"].forEach(key => {
      if (address[key] !== undefined && String(address[key]).trim()) body[key] = String(address[key]).trim();
    });
    const [metadataResult, l10nResult] = await Promise.allSettled([
      appStoreConnectBusinessFetch(context.accountId, taxAddressPath(context.vendorId, `/metadata?taxFormType=${encodeURIComponent(context.taxFormType)}`), { method: "POST", body }),
      appStoreConnectBusinessFetch(context.accountId, "/ppm/l10n"),
    ]);
    if (metadataResult.status === "rejected") throw metadataResult.reason;
    const l10n = l10nResult.status === "fulfilled" ? normalizeBusinessL10nMap(l10nResult.value.body || {}) : {};
    return { ...normalizeTaxAddressResponse(metadataResult.value.body || {}, l10n), success: true, context };
  } catch (error) {
    return { success: false, error: error.message || "税务地址元数据读取失败" };
  }
});

ipcMain.handle("app-store-connect-create-tax-address", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const context = await appStoreConnectTaxAddressContext(payload);
    const source = payload.address && typeof payload.address === "object" ? payload.address : {};
    const address = {};
    ["addressLine1", "addressLine2", "addressLine3", "city", "postalCode", "country", "regionText", "regionSelect"].forEach(key => {
      if (source[key] !== undefined) address[key] = String(source[key] || "").trim();
    });
    if (!address.country) throw new Error("请选择国家或地区");
    const result = await appStoreConnectBusinessFetch(context.accountId, taxAddressPath(context.vendorId), { method: "POST", body: address });
    return { ...(result.body || {}), success: true, context };
  } catch (error) {
    return { success: false, error: error.message || "税务地址保存失败" };
  }
});

ipcMain.handle("app-store-connect-save-tax-countries", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const { accountId, vendorId, vendorScopeId } = await appStoreConnectTaxContext(payload, provider);
    if (!accountId || !vendorId || !vendorScopeId) throw new Error("缺少税务国家参数");
    const countries = Array.isArray(payload.taxCountries) ? payload.taxCountries : [];
    const result = await appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(vendorId)}/vendorScopes/${encodeURIComponent(vendorScopeId)}/taxCountries`, {
      method: "PUT",
      body: { optimisticLock: String(payload.optimisticLock || ""), taxCountries: countries, vendorScopeId },
    });
    return { success: true, body: result.body || {} };
  } catch (error) {
    return { success: false, error: error.message || "税务国家/地区保存失败" };
  }
});

const pendingTaxFormSubmissions = new Set();
const submittedTaxFormsThisSession = new Set();

ipcMain.handle("app-store-connect-save-tax-form", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const context = await appStoreConnectTaxContext(payload, provider);
    const { accountId, vendorId, vendorScopeId } = context;
    const source = payload.formData && typeof payload.formData === "object" && !Array.isArray(payload.formData) ? payload.formData : {};
    const body = JSON.parse(JSON.stringify(source));
    if (!accountId || !vendorId || !vendorScopeId) throw new Error("缺少税务表参数");
    const requestedTaxFormType = String(payload.taxFormType || body.taxFormType || "").trim();
    if (!requestedTaxFormType || String(body.taxFormType || "").trim() !== requestedTaxFormType) throw new Error("缺少有效的税务表类型");
    if (!String(body.optimisticLock || "").trim()) throw new Error("税务表版本已失效，请刷新后重试");
    const submissionKey = JSON.stringify([accountId, vendorId, vendorScopeId, requestedTaxFormType]);
    if (pendingTaxFormSubmissions.has(submissionKey)) throw new Error("该税务表正在提交，请勿重复操作");
    if (submittedTaxFormsThisSession.has(submissionKey)) return { success: false, alreadySubmitted: true, error: "此 W-8BEN 税务表已提交，不能重复签署" };
    pendingTaxFormSubmissions.add(submissionKey);
    try {
      const taxFormsPath = `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(vendorId)}/vendorScopes/${encodeURIComponent(vendorScopeId)}/taxForms`;
      const isW8 = ["USA_W8BEN", "USA_W8BENE"].includes(requestedTaxFormType);
      if (isW8) {
        const { body: formsBody } = await appStoreConnectBusinessFetch(accountId, taxFormsPath);
        if (!Array.isArray(formsBody?.data)) throw new Error("无法确认 W-8BEN 签署状态，请刷新后重试");
        const alreadySubmitted = formsBody.data.some(row =>
          String(row?.taxFormType || "") === requestedTaxFormType &&
          (row?.isSubmitted === true || ["ACTIVE", "COMPLETE", "SUBMITTED"].includes(String(row?.taxStatus || row?.status || "").trim().toUpperCase()))
        );
        if (alreadySubmitted) {
          submittedTaxFormsThisSession.add(submissionKey);
          return { success: false, alreadySubmitted: true, error: "此 W-8BEN 税务表已提交，不能重复签署" };
        }
      }
      body.accountId = accountId;
      body.taxFormType = requestedTaxFormType;
      const result = await appStoreConnectBusinessFetch(accountId, taxFormsPath, { method: "POST", body, headers: { Referer: `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(context.legalEntityId)}` } });
      if (isW8) submittedTaxFormsThisSession.add(submissionKey);
      return { success: true, body: result.body || {}, context };
    } finally {
      pendingTaxFormSubmissions.delete(submissionKey);
    }
  } catch (error) {
    return { success: false, error: error.message || "税务表保存失败" };
  }
});

ipcMain.handle("app-store-connect-delete-tax-form", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const { accountId, vendorId, vendorScopeId } = await appStoreConnectTaxContext(payload, provider);
    const taxFormId = String(payload.taxFormId || "").trim();
    if (!taxFormId) throw new Error("缺少需要重设的税务问卷 ID");
    const result = await appStoreConnectBusinessFetch(accountId, `/ppm/v1/accounts/{accountId}/vendors/${encodeURIComponent(vendorId)}/vendorScopes/${encodeURIComponent(vendorScopeId)}/taxForms/${encodeURIComponent(taxFormId)}`, { method: "DELETE" });
    return { success: true, body: result.body || {} };
  } catch (error) {
    return { success: false, error: error.message || "税务问卷重设失败" };
  }
});

ipcMain.handle("app-store-connect-bank-metadata", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await fetchAppStoreConnectBankMetadata(payload);
  } catch (error) {
    return { success: false, error: error.message || "银行账户信息读取失败" };
  }
});

ipcMain.handle("app-store-connect-bank-search", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await searchAppStoreConnectBanks(payload);
  } catch (error) {
    return { success: false, error: error.message || "银行搜索失败" };
  }
});

ipcMain.handle("app-store-connect-create-bank-account", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await appStoreConnectCreateBankAccount(payload);
  } catch (error) {
    return { success: false, error: error.message || "银行卡添加失败" };
  }
});

ipcMain.handle("app-store-connect-bank-resend-code", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await resendAppStoreConnectBankMfaCode();
  } catch (error) {
    return { success: false, error: error.message || "短信验证码重新发送失败" };
  }
});

ipcMain.handle("app-store-connect-bank-verify-code", async (_event, code) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await verifyAppStoreConnectBankMfaCode(code);
  } catch (error) {
    return {
      success: false,
      error: error.message || "短信验证码验证失败",
      verificationAccepted: error.verificationAccepted === true,
    };
  }
});

ipcMain.handle("app-store-connect-bank-cancel-2fa", async () => {
  try {
    return await cancelAppStoreConnectBankMfa();
  } catch {
    return { success: true };
  }
});

ipcMain.handle("app-store-connect-compliance-form", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const accountId = String(payload.accountId || provider.id || "").trim();
    const entityId = String(payload.legalEntityId || payload.entityId || "").trim();
    const requirementId = String(payload.requirementId || "").trim();
    if (!accountId || !entityId || !requirementId) throw new Error("缺少合规表单参数");
    const { body } = await appStoreConnectBusinessFetch(
      accountId,
      `/ppm/complianceform/v1/accounts/{accountId}/requirements/${encodeURIComponent(requirementId)}/forms?legalEntityId=${encodeURIComponent(entityId)}`,
    );
    return {
      success: true,
      accountId,
      entityId,
      requirementId,
      formData: body?.data?.formData || {},
      constraints: body?.constraints || {},
      raw: body,
    };
  } catch (error) {
    return { success: false, error: error.message || "合规信息读取失败" };
  }
});

ipcMain.handle("app-store-connect-save-compliance-form", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await saveAppStoreConnectComplianceForm(payload);
  } catch (error) {
    return { success: false, error: error.message || "合规信息保存失败" };
  }
});

ipcMain.handle("app-store-connect-business-agreement-detail", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await fetchAppStoreConnectBusinessAgreementDetail(payload);
  } catch (error) {
    return { success: false, error: error.message || "付费 App 协议读取失败" };
  }
});

ipcMain.handle("app-store-connect-accept-business-agreement", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await acceptAppStoreConnectBusinessAgreement(payload);
  } catch (error) {
    return { success: false, error: error.message || "付费 App 协议签署失败" };
  }
});

ipcMain.handle("app-store-connect-business-agreement-resend-code", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await resendAppStoreConnectBusinessAgreementMfaCode();
  } catch (error) {
    return { success: false, error: error.message || "短信验证码重新发送失败" };
  }
});

ipcMain.handle("app-store-connect-business-agreement-verify-code", async (_event, code) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await verifyAppStoreConnectBusinessAgreementMfaCode(code);
  } catch (error) {
    return { success: false, error: error.message || "短信验证码验证失败" };
  }
});

ipcMain.handle("app-store-connect-business-agreement-cancel-2fa", async () => {
  if (appStoreConnectBusinessAgreementMfaIsCurrent()) appStoreConnectBusinessAgreementMfa = null;
  return { success: true };
});

ipcMain.handle("app-store-connect-business-agreement-download", async (_event, payload = {}) => {
  try {
    return await downloadAppStoreConnectBusinessAgreementDocument(payload);
  } catch (error) {
    return { success: false, error: error.message || "Apple 协议文件下载失败" };
  }
});

ipcMain.handle("app-store-connect-legal-entity-metadata", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const provider = await fetchAppStoreConnectCurrentProvider();
    const accountId = String(payload.accountId || provider.id || "").trim();
    const legalEntity = payload.legalEntity && typeof payload.legalEntity === "object" ? payload.legalEntity : {};
    if (!accountId) throw new Error("缺少商务账户 ID");
    if (!legalEntity.legalEntityId && !legalEntity.id) throw new Error("缺少法律实体 ID");
    const { body } = await appStoreConnectBusinessFetch(accountId, "/ppm/v1/accounts/{accountId}/legalEntities/metadata", {
      method: "POST",
      body: legalEntity,
    });
    return normalizeLegalEntityMetadata(body);
  } catch (error) {
    return { success: false, error: error.message || "法律实体信息读取失败" };
  }
});

ipcMain.handle("app-store-connect-save-legal-entity", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await saveAppStoreConnectLegalEntityWithMfaSupport(payload);
  } catch (error) {
    return { success: false, error: error.message || "法律实体保存失败" };
  }
});

ipcMain.handle("app-store-connect-save-legal-entity-resend-code", async () => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    const result = await resendAppStoreConnectLegalEntityMfaCode();
    return { ...result, success: true };
  } catch (error) {
    return { success: false, error: error.message || "短信验证码重新发送失败" };
  }
});

ipcMain.handle("app-store-connect-save-legal-entity-verify-code", async (_event, code) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从开发者账户列表启动证书管理");
    return await verifyAppStoreConnectLegalEntityMfaCode(code);
  } catch (error) {
    return { success: false, error: error.message || "短信验证码验证失败" };
  }
});

ipcMain.handle("app-store-connect-save-legal-entity-cancel-2fa", async () => {
  if (appStoreConnectLegalEntityMfaIsCurrent()) appStoreConnectLegalEntityMfa = null;
  return { success: true };
});

function findAppleDeveloperTeams(value, pathParts = [], output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findAppleDeveloperTeams(item, [...pathParts, String(index)], output));
    return output;
  }
  const pathText = pathParts.join(".").toLowerCase();
  const teamId = String(value.teamId || value.teamID || value.developerTeamId || value.membershipTeamId || "").trim();
  const providerId = String(value.providerId || value.providerID || "").trim();
  const fallbackId = /(?:^|\.)(?:teams|providers)(?:\.|$)/.test(pathText) &&
    (value.name || value.teamName || value.providerName || value.companyName)
    ? String(value.id || "").trim()
    : "";
  const id = teamId || providerId || fallbackId;
  if (id) {
    const name = String(value.name || value.teamName || value.providerName || value.companyName || "开发者团队").trim();
    if (!output.some(item => item.id === id)) output.push({ id, name });
  }
  Object.entries(value).forEach(([key, item]) => findAppleDeveloperTeams(item, [...pathParts, key], output));
  return output;
}

function appleDeveloperServiceError(body, fallback = "") {
  const item = body?.errors?.[0] || body?.serviceErrors?.[0] || body?.service_errors?.[0] || body?.error;
  if (typeof item === "string") return item;
  return String(item?.detail || item?.message || item?.title || item?.code || body?.userString || body?.resultString || fallback || "").trim();
}

function collectAppleDeveloperTeams(body, output = []) {
  findAppleDeveloperTeams(body, [], output);
  const knownLists = [body?.teams, body?.data, body?.result?.teams, body?.data?.teams, body?.response?.teams];
  knownLists.filter(Array.isArray).flat().forEach((row) => {
    const attributes = row?.attributes || row || {};
    const id = String(attributes.teamId || attributes.teamID || attributes.developerTeamId || attributes.providerId || row?.id || "").trim();
    const name = String(attributes.name || attributes.teamName || attributes.companyName || attributes.providerName || "开发者团队").trim();
    if (id && !output.some(item => item.id === id)) output.push({ id, name });
  });
  return output;
}

function normalizeAppleDeveloperTeamDetails(row = {}) {
  const memberships = Array.isArray(row?.memberships) ? row.memberships.map(item => ({
    membershipId: String(item?.membershipId || ""),
    membershipProductId: String(item?.membershipProductId || ""),
    status: String(item?.status || ""),
    inIosDeviceResetWindow: item?.inIosDeviceResetWindow === true,
    inMacDeviceResetWindow: item?.inMacDeviceResetWindow === true,
    inRenewalWindow: item?.inRenewalWindow === true,
    dateStart: String(item?.dateStart || ""),
    dateExpire: String(item?.dateExpire || ""),
    platform: String(item?.platform || ""),
    deleteDevicesOnExpiry: item?.deleteDevicesOnExpiry === true,
    name: String(item?.name || ""),
  })) : [];
  const currentMember = row?.currentTeamMember || {};
  return {
    id: String(row?.teamId || row?.teamID || row?.developerTeamId || row?.providerId || row?.id || "").trim(),
    name: String(row?.name || row?.teamName || row?.providerName || row?.companyName || "开发者团队").trim(),
    status: String(row?.status || ""),
    identityType: row?.entityType === "i" ? "个人" : row?.entityType === "c" ? "组织" : String(row?.entityType || "—"),
    phone: String(row?.phone || ""),
    address: [row?.address?.country, row?.address?.state, row?.address?.city, row?.address?.streetAddress1, row?.address?.postalCode].filter(Boolean).join(" "),
    program: String(row?.program?.name || memberships[0]?.name || ""),
    expirationDate: Number(row?.program?.dateExpires || 0),
    fee: String(row?.program?.autoRenewPrice || ""),
    autoRenew: !!row?.program?.autoRenew,
    deviceResetDate: Number(row?.nextDeviceResetDate || row?.deviceResetDate || 0),
    roles: Array.isArray(currentMember.roles) ? currentMember.roles.map(String) : Array.isArray(row?.userRoles) ? row.userRoles.map(String) : [],
    agreementAccepted: row?.acceptedLatestAgreement === true,
    inIosDeviceResetWindow: memberships.some(item => item.inIosDeviceResetWindow),
    inMacDeviceResetWindow: memberships.some(item => item.inMacDeviceResetWindow),
    inRenewalWindow: memberships.some(item => item.inRenewalWindow),
    memberships,
  };
}

function appleDeveloperDeviceRenewalRequired(team = {}) {
  return team?.inIosDeviceResetWindow === true || team?.inMacDeviceResetWindow === true || team?.inRenewalWindow === true;
}

function appleDeveloperTeamResponseSummary(requestName, responseStatus, body = {}, fallback = "") {
  const resultCode = body?.resultCode == null ? "" : `resultCode ${body.resultCode}`;
  const detail = appleDeveloperServiceError(body, fallback);
  return `${requestName}: HTTP ${responseStatus}${resultCode ? ` ${resultCode}` : ""}${detail ? ` ${detail}` : ""}`.trim();
}

function appleDeveloperTeamFailureHint(failures = []) {
  const text = failures.join("；");
  if (/API key in use does not allow this request|HTTP 403/i.test(text)) {
    return "这通常表示 Apple ID 登录态已存在，但 Developer services-account 会话没有成功兑换、已过期，或当前代理出口/团队上下文和登录时不一致。";
  }
  if (/返回了登录页|idmsa|appleid/i.test(text)) {
    return "这通常表示 Apple ID 登录已过，但 Developer 后台网页会话还没有建立完成。";
  }
  if (/resultCode 2100|not registered as an Apple Developer/i.test(text)) {
    return "Apple 返回该账号未开通或未续费 Apple Developer Program。";
  }
  return "";
}

function appleDeveloperTeamFilePath() {
  return path.join(appleDeveloperAccountStorageDir(), "team.json");
}

function readSelectedAppleDeveloperTeam() {
  if (appleDeveloperSelectedTeam) return appleDeveloperSelectedTeam;
  try {
    const saved = JSON.parse(fs.readFileSync(appleDeveloperTeamFilePath(), "utf8"));
    if (saved?.id) appleDeveloperSelectedTeam = { id: String(saved.id), name: String(saved.name || "开发者团队") };
  } catch {}
  return appleDeveloperSelectedTeam;
}

function saveSelectedAppleDeveloperTeam(team) {
  appleDeveloperSelectedTeam = { id: String(team.id), name: String(team.name || "开发者团队") };
  const target = appleDeveloperTeamFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(appleDeveloperSelectedTeam), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return appleDeveloperSelectedTeam;
}

async function fetchAppleDeveloperTeams() {
  const status = await readAppleDeveloperStatus();
  if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
  const ses = session.fromPartition(appleDeveloperPartition());
  const candidates = collectAppleDeveloperTeams(appleDeveloperSessionInfo);
  const teamDetails = new Map();
  const seedTeamId = readSelectedAppleDeveloperTeam()?.id || candidates[0]?.id || "";
  const requests = [
    {
      name: "listTeams.action",
      url: "https://developer.apple.com/services-account/QH65B2/account/listTeams.action",
      headers: { Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: "https://developer.apple.com/account/" },
      body: new URLSearchParams({ teamId: seedTeamId }).toString(),
    },
    {
      name: "v1/teams",
      url: "https://developer.apple.com/services-account/v1/teams",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: "https://developer.apple.com/account/" },
      body: JSON.stringify({}),
    },
  ];
  const runRequests = async (phase) => {
    const failures = [];
    for (const request of requests) {
      const hadTeamsBefore = candidates.length > 0;
      const diagnostic = { phase, request: request.name, url: request.url };
      try {
        const response = await ses.fetch(request.url, {
          method: "POST", credentials: "include", headers: request.headers, body: request.body, redirect: "follow", signal: AbortSignal.timeout(30000),
        });
        const contentType = String(response.headers.get("content-type") || "");
        const text = await response.text();
        let body = {};
        try { body = text ? JSON.parse(text) : {}; }
        catch {
          const looksLikeLogin = /<html|<!doctype|appleid\.apple\.com|idmsa\.apple\.com/i.test(text);
          const message = `${request.name}: HTTP ${response.status} ${looksLikeLogin ? "返回了登录页" : `非 JSON 响应 (${contentType || "unknown"})`}`;
          failures.push(message);
          logAppleDeveloperDiagnostic("teams-request-failed", { ...diagnostic, status: response.status, contentType, reason: message, responseSnippet: text.slice(0, 300) });
          continue;
        }
        const resultCode = body?.resultCode == null ? 0 : Number(body.resultCode);
        collectAppleDeveloperTeams(body, candidates);
        const detailedTeams = Array.isArray(body?.teams) ? body.teams : Array.isArray(body?.data) ? body.data : [];
        detailedTeams.forEach(row => {
          const details = normalizeAppleDeveloperTeamDetails(row?.attributes || row || {});
          if (details.id) teamDetails.set(details.id, { ...(teamDetails.get(details.id) || {}), ...details });
        });
        const summary = appleDeveloperTeamResponseSummary(request.name, response.status, body);
        if (!response.ok || resultCode !== 0) {
          failures.push(summary);
          logAppleDeveloperDiagnostic("teams-request-failed", { ...diagnostic, status: response.status, resultCode: body?.resultCode ?? "", detail: appleDeveloperServiceError(body), bodyKeys: Object.keys(body || {}) });
        } else if (!hadTeamsBefore && candidates.length === 0) {
          const message = `${summary} 未返回团队列表`;
          failures.push(message);
          logAppleDeveloperDiagnostic("teams-request-empty", { ...diagnostic, status: response.status, resultCode: body?.resultCode ?? "", bodyKeys: Object.keys(body || {}) });
        }
        if (candidates.length) break;
      } catch (error) {
        const message = `${request.name}: ${error.message}`;
        failures.push(message);
        logAppleDeveloperDiagnostic("teams-request-error", { ...diagnostic, error: error.message });
      }
    }
    return failures;
  };
  let failures = await runRequests("initial");
  let refreshed = false;
  if (!candidates.length && failures.length) {
    try {
      refreshed = true;
      logAppleDeveloperDiagnostic("teams-refresh-start", { failures });
      await establishAppleDeveloperWebSession(ses);
      failures = await runRequests("after-refresh");
    } catch (error) {
      failures.push(`刷新 Developer 网页会话失败：${error.message}`);
      logAppleDeveloperDiagnostic("teams-refresh-failed", { error: error.message });
    }
  }
  const selected = readSelectedAppleDeveloperTeam();
  if (!candidates.length && failures.length) {
    console.warn("fetch Apple developer teams failed:", failures.join("; "));
    const hint = appleDeveloperTeamFailureHint(failures);
    const logPath = certificateManagerDiagnosticLogPath();
    const refreshText = refreshed ? "已自动刷新 Developer 网页会话后仍失败。" : "";
    return {
      success: false,
      authenticated: true,
      teams: [],
      selectedTeamId: selected?.id || "",
      error: `Apple 团队接口读取失败：${refreshText}${failures.join("；")}${hint ? `。${hint}` : ""} 诊断日志：${logPath}`,
    };
  }
  return {
    success: true,
    authenticated: true,
    teams: candidates.map(team => ({ ...team, ...(teamDetails.get(team.id) || {}) })),
    selectedTeamId: selected?.id || "",
  };
}

ipcMain.handle("apple-developer-teams", async () => fetchAppleDeveloperTeams());
ipcMain.handle("apple-developer-select-team", async (_event, team = {}) => {
  const teams = (await fetchAppleDeveloperTeams()).teams || [];
  const selected = teams.find(item => item.id === String(team.id || ""));
  if (!selected) return { success: false, error: "选择的开发者团队无效" };
  return { success: true, team: saveSelectedAppleDeveloperTeam(selected) };
});

function normalizeAppleBundleIds(body = {}) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.bundleIds) ? body.bundleIds : [];
  return rows.map((row) => {
    const attributes = row?.attributes || row || {};
    return {
      id: String(row?.id || attributes.id || attributes.identifier || ""),
      name: String(attributes.name || attributes.description || attributes.identifier || "未命名"),
      identifier: String(attributes.identifier || attributes.bundleId || attributes.id || ""),
      platform: String(attributes.platform || attributes.seedId || "iOS"),
      wildcard: attributes.wildcard === true || String(attributes.identifier || "").includes("*"),
    };
  }).filter(item => item.identifier || item.id);
}

function findAppleBundleIdByIdentifier(bundleIds = [], identifier = "") {
  const normalized = String(identifier || "").trim().toLowerCase();
  if (!normalized) return null;
  return (Array.isArray(bundleIds) ? bundleIds : []).find(item => String(item?.identifier || "").trim().toLowerCase() === normalized) || null;
}

function appleBundleIdentifierDuplicateError(identifier, existing = {}) {
  const label = existing.name && existing.name !== existing.identifier ? `（${existing.name}）` : "";
  return `Identifier“${identifier}”已在当前团队中存在${label}，请直接使用列表中的 Bundle ID，或更换 Identifier`;
}

function appleBundleIdentifierUnavailableError(identifier, detail = "") {
  const appleDetail = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 260);
  return `Identifier“${identifier}”当前不可用，但当前团队列表中没有找到同名 Bundle ID。通常是该标识已被其它团队、历史记录或 Apple 保留占用，请换一个更唯一的 Identifier${appleDetail ? `。Apple 原始提示：${appleDetail}` : ""}`;
}

async function fetchExistingAppleBundleIdByIdentifier(ses, teamId, identifier, referer = "https://developer.apple.com/account/resources/identifiers/list/bundleId") {
  const response = await ses.fetch("https://developer.apple.com/services-account/v1/bundleIds", {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-HTTP-Method-Override": "GET",
      Referer: referer,
    },
    body: JSON.stringify({ teamId, urlEncodedQueryParams: "limit=1000&sort=name" }),
  });
  const text = await response.text();
  if (!response.ok) return null;
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return findAppleBundleIdByIdentifier(normalizeAppleBundleIds(body), identifier);
}

ipcMain.handle("apple-developer-bundle-ids", async () => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
  const ses = session.fromPartition(appleDeveloperPartition());
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const teams = teamResult.teams || [];
    let team = readSelectedAppleDeveloperTeam();
    if (team && !teams.some(item => item.id === team.id)) team = null;
    if (!team && teams.length === 1) team = saveSelectedAppleDeveloperTeam(teams[0]);
    if (!team) return { success: false, authenticated: true, teamRequired: true, error: teams.length ? "请先选择 Apple Developer 团队" : "已登录，但未读取到关联的 Apple Developer 团队" };
    const url = "https://developer.apple.com/services-account/v1/bundleIds";
    const response = await ses.fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "X-HTTP-Method-Override": "GET",
      },
      body: JSON.stringify({ teamId: team.id, urlEncodedQueryParams: "limit=200&sort=name" }),
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (response.status === 401) {
      appleDeveloperAuthenticated = false;
      sendAppleDeveloperStatus({ authenticated: false, network: appleDeveloperNetwork });
      return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    }
    if (response.status === 403) return { success: false, authenticated: true, error: "当前团队没有读取 Bundle ID 的权限，请确认开发者团队和账户角色" };
    if (!response.ok) {
      const serviceError = body?.errors?.[0] || body?.serviceErrors?.[0] || body?.service_errors?.[0] || {};
      return { success: false, error: serviceError.detail || serviceError.message || `Bundle ID 获取失败 (${response.status})` };
    }
    const bundleIds = normalizeAppleBundleIds(body);
    return { success: true, bundleIds, total: Number(body?.meta?.paging?.total || body?.total || bundleIds.length), team: { id: team.id, name: team.name } };
  } catch (error) {
    return { success: false, error: error.message || "Bundle ID 获取失败" };
  }
});

ipcMain.handle("apple-developer-devices", async () => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const ses = session.fromPartition(appleDeveloperPartition());
    const referer = "https://developer.apple.com/account/resources/devices/list";
    const permissionNames = ["team.device.ios.create", "team.device.mac.create", "team.device.edit", "team.device.processing", "team.device.reset", "team.membership.udid.removal"];
    const fetchDeviceResource = async (url, options) => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { return await ses.fetch(url, { ...options, signal: AbortSignal.timeout(60000) }); }
        catch (error) {
          lastError = error;
          if (!/abort|timeout/i.test(String(error?.message || error)) || attempt > 0) throw error;
        }
      }
      throw lastError;
    };
    const [deviceResponse, permissionResponse, benefitResult] = await Promise.all([
      fetchDeviceResource("https://developer.apple.com/services-account/v1/devices", {
        method: "POST", credentials: "include", redirect: "follow",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: referer },
        body: JSON.stringify({ urlEncodedQueryParams: "limit=1000&sort=name", teamId: team.id }),
      }),
      fetchDeviceResource("https://developer.apple.com/services-account/checkPermissions", {
        method: "POST", credentials: "include", redirect: "follow",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: referer },
        body: new URLSearchParams({ permissions: permissionNames.join(","), teamId: team.id }).toString(),
      }),
      ses.fetch("https://developer.apple.com/services-account/QH65B2/account/ios/device/listDevices.action", {
        method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(20000),
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", Referer: "https://developer.apple.com/account/resources/devices/reset" },
        body: new URLSearchParams({ includeRemovedDevices: "true", includeAvailability: "true", pageSize: "1", pageNumber: "1", sidx: "name", sort: "status%3dasc", teamId: team.id }).toString(),
      }).then(response => ({ response })).catch(error => ({ error })),
    ]);
    const benefitResponse = benefitResult.response || null;
    const deviceText = await deviceResponse.text();
    const permissionText = await permissionResponse.text();
    const benefitText = benefitResponse ? await benefitResponse.text() : "";
    let deviceBody = {}, permissionBody = {}, benefitBody = {};
    try { deviceBody = deviceText ? JSON.parse(deviceText) : {}; } catch { deviceBody = { text: deviceText }; }
    try { permissionBody = permissionText ? JSON.parse(permissionText) : {}; } catch { permissionBody = { text: permissionText }; }
    try { benefitBody = benefitText ? JSON.parse(benefitText) : {}; } catch { benefitBody = {}; }
    if (deviceResponse.status === 401 || permissionResponse.status === 401) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    if (!deviceResponse.ok) return { success: false, error: appleDeveloperServiceError(deviceBody, deviceText) || `设备列表读取失败 (${deviceResponse.status})` };
    if (!permissionResponse.ok) return { success: false, error: appleDeveloperServiceError(permissionBody, permissionText) || `设备权限读取失败 (${permissionResponse.status})` };
    const devices = (Array.isArray(deviceBody?.data) ? deviceBody.data : []).map(row => {
      const attributes = row?.attributes || {};
      return {
        id: String(row?.id || ""), name: String(attributes.name || "未命名设备"), udid: String(attributes.udid || ""),
        type: String(attributes.devicePlatformLabel || attributes.deviceClass || attributes.platformName || attributes.platform || "—"),
        model: String(attributes.model || "—"), status: String(attributes.status || "—"), addedDate: String(attributes.addedDate || "—"),
        platform: String(attributes.platform || ""), eligibilityDuration: Number(attributes.inEligibilityDuration || 0),
      };
    }).filter(item => item.id);
    const permissionMap = new Map((permissionBody?.permissions || []).map(item => [String(item.permission || ""), item]));
    const permission = name => permissionMap.get(name) || {};
    const canAddIOS = permission("team.device.ios.create").accessAllowed === true;
    const canAddMac = permission("team.device.mac.create").accessAllowed === true;
    const canReset = permission("team.device.reset").accessAllowed === true;
    const canRemoveForRenewal = permission("team.membership.udid.removal").accessAllowed === true;
    const selectedTeam = teamResult.teams.find(item => item.id === team.id) || team;
    const renewalReviewRequired = appleDeveloperDeviceRenewalRequired(selectedTeam);
    const createReason = permission("team.device.ios.create")?.reason || permission("team.device.mac.create")?.reason || {};
    return {
      success: true, devices, total: Number(deviceBody?.meta?.paging?.total || devices.length),
      permissions: { canAddIOS, canAddMac, canEdit: permission("team.device.edit").accessAllowed === true, processing: permission("team.device.processing").accessAllowed === true, canReset, canRemoveForRenewal },
      renewalReviewRequired,
      team: selectedTeam,
      deviceBenefits: (Array.isArray(benefitBody?.deviceBenefits) ? benefitBody.deviceBenefits : []).map(item => ({ label: String(item.devicePlatformLabel || item.deviceClass || "设备"), available: Number(item.availableQuantity || 0), maximum: Number(item.maxQuantity || 0) })),
      notice: renewalReviewRequired ? "添加新设备前，请先为新的会员年度更新设备列表。你可以在年度更新流程中移除不再使用的设备。" : String(createReason.userString || createReason.resultString || ""),
    };
  } catch (error) {
    const message = String(error?.message || error || "");
    return { success: false, error: /abort|timeout/i.test(message) ? "Apple 设备接口响应超时，已自动重试一次，请检查当前代理或稍后重试" : (message || "设备列表读取失败") };
  }
});

async function runAppleDeviceFormAction(teamId, action, fields, platformPath = "") {
  const referer = "https://developer.apple.com/account/resources/devices/add";
  const ses = session.fromPartition(appleDeveloperPartition());
  const listResponse = await ses.fetch("https://developer.apple.com/services-account/v1/devices", {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: referer },
    body: JSON.stringify({ teamId, urlEncodedQueryParams: "limit=1&offset=0" }),
  });
  await listResponse.text();
  if (!listResponse.ok) return { success: false, status: listResponse.status, error: `Apple 设备会话读取失败 (${listResponse.status})` };
  const csrf = listResponse.headers.get("csrf") || "";
  const csrfTimestamp = listResponse.headers.get("csrf_ts") || "";
  if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 设备会话未返回 CSRF，请刷新设备列表后重试" };
  const actionScope = platformPath ? `${platformPath}/device` : "device";
  const response = await ses.fetch(`https://developer.apple.com/services-account/QH65B2/account/${actionScope}/${action}.action`, {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", Referer: referer, csrf, csrf_ts: csrfTimestamp },
    body: new URLSearchParams({ ...fields, teamId }).toString(),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  return { success: response.ok && Number(body?.resultCode || 0) === 0, status: response.status, body };
}

function appleDevicePlatformValues(value) {
  const alias = String(value || "IOS").trim().toUpperCase().replace(/-/g, "_");
  const canonical = ({ MAC: "MAC_OS", MACOS: "MAC_OS", IOS: "IOS", TVOS: "TV_OS", WATCHOS: "WATCH_OS", VISIONOS: "VISION_OS", UNIVERSAL: "UNIVERSAL" })[alias] || alias;
  const supported = new Set(["IOS", "MAC_OS", "TV_OS", "WATCH_OS", "VISION_OS", "UNIVERSAL"]);
  const normalized = supported.has(canonical) ? canonical : "IOS";
  const form = ({
    IOS: "ios",
    MAC_OS: "mac",
    TV_OS: "tvos",
    WATCH_OS: "watchos",
    VISION_OS: "visionos",
    UNIVERSAL: "ios",
  })[normalized] || "ios";
  return { path: normalized === "MAC_OS" ? "mac" : "ios", form, canonical: normalized };
}

ipcMain.handle("apple-developer-device-detail", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const deviceId = String(payload.id || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(deviceId)) return { success: false, error: "设备资源 ID 无效" };
  const ses = session.fromPartition(appleDeveloperPartition());
    const response = await ses.fetch(`https://developer.apple.com/services-account/v1/devices/${deviceId}?fields[devices]=name,udid,platform,model,status,devicePlatformLabel`, {
      method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: `https://developer.apple.com/account/resources/devices/edit/${deviceId}` },
      body: JSON.stringify({ teamId: team.id }),
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!response.ok) return { success: false, error: appleDeveloperServiceError(body, text) || `设备详情读取失败 (${response.status})` };
    const attributes = body?.data?.attributes || {};
    return { success: true, device: { id: String(body?.data?.id || deviceId), name: String(attributes.name || "未命名设备"), udid: String(attributes.udid || ""), platform: String(attributes.platform || "IOS"), model: String(attributes.model || "—"), status: String(attributes.status || "—"), type: String(attributes.devicePlatformLabel || attributes.platform || "—") } };
  } catch (error) { return { success: false, error: error.message || "设备详情读取失败" }; }
});

ipcMain.handle("apple-developer-update-device", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const deviceId = String(payload.id || "").trim();
    const name = String(payload.name || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(deviceId)) return { success: false, error: "设备资源 ID 无效" };
    if (!name || name.length > 100) return { success: false, error: "设备备注名不能为空且不能超过 100 个字符" };
    const platform = appleDevicePlatformValues(payload.platform);
    const result = await runAppleDeviceFormAction(team.id, "updateDevice", { devicePlatform: platform.form, deviceId, name }, platform.path);
    if (!result?.success) return { success: false, error: appleDeviceValidationMessage(result?.body) || result?.error || `设备备注名保存失败 (${result?.status || "未知"})` };
    return { success: true };
  } catch (error) { return { success: false, error: error.message || "设备备注名保存失败" }; }
});

function normalizeAppleDeviceInput(payload = {}) {
  const name = String(payload.name || "").trim();
  const udid = String(payload.udid || "").trim();
  const platformValues = appleDevicePlatformValues(payload.platform);
  const platform = platformValues.canonical;
  if (!name || name.length > 100) throw new Error("设备名称不能为空且不能超过 100 个字符");
  const iosPattern = /^([A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$/;
  const macPattern = /^([A-Fa-f0-9]{36}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$/;
  const valid = platform === "MAC_OS" ? macPattern.test(udid) : platform === "UNIVERSAL" ? (iosPattern.test(udid) || macPattern.test(udid)) : iosPattern.test(udid);
  if (!valid) throw new Error(`${platform} 设备标识符格式无效`);
  return { name, udid, platform, devicePlatform: platformValues.form };
}

function appleDeviceValidationMessage(body = {}) {
  const messages = Array.isArray(body?.validationMessages) ? body.validationMessages : [];
  for (const item of messages) {
    const message = item?.validationUserMessage || item?.userString || item?.message || item?.description;
    if (/already exists on this team/i.test(String(message || ""))) return "你已经添加了该 UDID";
    if (message) return String(message);
  }
  return appleDeveloperServiceError(body, body?.text) || "";
}

async function findRegisteredAppleDevice(teamId, udid) {
  const ses = session.fromPartition(appleDeveloperPartition());
  const response = await ses.fetch("https://developer.apple.com/services-account/v1/devices", {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(15000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: "https://developer.apple.com/account/resources/devices/list" },
    body: JSON.stringify({ teamId, urlEncodedQueryParams: "limit=1000&offset=0" }),
  });
  if (!response.ok) return null;
  let body = {};
  try { body = JSON.parse(await response.text()); } catch { return null; }
  const target = String(udid || "").replace(/-/g, "").toLowerCase();
  const row = (Array.isArray(body?.data) ? body.data : []).find(item => String(item?.attributes?.udid || "").replace(/-/g, "").toLowerCase() === target);
  if (!row) return null;
  return { name: String(row.attributes?.name || "未命名设备"), status: String(row.attributes?.status || "ENABLED"), udid: String(row.attributes?.udid || udid), id: String(row.id || ""), platform: String(row.attributes?.platform || ""), model: String(row.attributes?.model || ""), type: String(row.attributes?.devicePlatformLabel || row.attributes?.deviceClass || "") };
}

ipcMain.handle("apple-developer-validate-device", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const input = normalizeAppleDeviceInput(payload);
    const existingBeforeValidate = await findRegisteredAppleDevice(team.id, input.udid);
    if (existingBeforeValidate) return { success: false, duplicate: true, existingDevice: existingBeforeValidate, error: `你已经添加了该 UDID：${existingBeforeValidate.name}（${existingBeforeValidate.udid}，${existingBeforeValidate.status === "ENABLED" ? "已启用" : "已停用"}）` };
    const result = await runAppleDeviceFormAction(team.id, "validateDevices", { deviceNames: input.name, deviceNumbers: input.udid, devicePlatforms: input.devicePlatform, register: "single" });
    if (!result?.success) {
      const existing = await findRegisteredAppleDevice(team.id, input.udid);
      if (existing) return { success: false, duplicate: true, existingDevice: existing, error: `你已经添加了该 UDID：${existing.name}（${existing.udid}，${existing.status === "ENABLED" ? "已启用" : "已停用"}）` };
      return { success: false, error: appleDeviceValidationMessage(result?.body) || result?.error || `设备校验失败 (${result?.status || "未知"})`, details: result?.body };
    }
    const device = Array.isArray(result.body?.devices) ? result.body.devices[0] : result.body?.devices || {};
    if (!device || !Object.keys(device).length) {
      const existing = await findRegisteredAppleDevice(team.id, input.udid);
      if (existing) return { success: false, error: `该设备已经添加：${existing.name}（${existing.udid}，${existing.status === "ENABLED" ? "已启用" : "已停用"}）` };
      const reason = appleDeviceValidationMessage(result.body);
      if (reason) return { success: false, error: reason };
      const failed = Array.isArray(result.body?.failedDevices) ? result.body.failedDevices.join("、") : "";
      return { success: false, error: failed ? `Apple 未接受设备 ${failed}，但未返回具体原因；请检查 UDID、设备平台和注册额度` : "Apple 未返回可注册设备，请检查 UDID、设备平台和注册额度" };
    }
    return { success: true, input, device, failedDevices: result.body?.failedDevices || [], validationMessages: result.body?.validationMessages || [] };
  } catch (error) { return { success: false, error: error.message || "设备校验失败" }; }
});

ipcMain.handle("apple-developer-add-device", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const input = normalizeAppleDeviceInput(payload);
    const existingBeforeAdd = await findRegisteredAppleDevice(team.id, input.udid);
    if (existingBeforeAdd) return { success: false, duplicate: true, existingDevice: existingBeforeAdd, error: `你已经添加了该 UDID：${existingBeforeAdd.name}（${existingBeforeAdd.udid}，${existingBeforeAdd.status === "ENABLED" ? "已启用" : "已停用"}）` };
    const result = await runAppleDeviceFormAction(team.id, "addDevices", { deviceNames: input.name, deviceNumbers: input.udid, devicePlatforms: input.devicePlatform, register: "single" });
    if (!result?.success) return { success: false, error: appleDeviceValidationMessage(result?.body) || result?.error || `设备注册失败 (${result?.status || "未知"})`, details: result?.body };
    if (Array.isArray(result.body?.failedDevices) && result.body.failedDevices.length) {
      const existing = await findRegisteredAppleDevice(team.id, input.udid);
      if (existing) return { success: false, error: `该设备已经添加：${existing.name}（${existing.udid}，${existing.status === "ENABLED" ? "已启用" : "已停用"}）` };
      return { success: false, error: appleDeviceValidationMessage(result.body) || `Apple 未能注册设备：${result.body.failedDevices.join("、")}` };
    }
    return { success: true, devices: result.body?.devices || [], failedDevices: result.body?.failedDevices || [] };
  } catch (error) { return { success: false, error: error.message || "设备注册失败" }; }
});

ipcMain.handle("apple-developer-disable-device", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const deviceId = String(payload.id || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(deviceId)) return { success: false, error: "设备资源 ID 无效" };
    const platform = appleDevicePlatformValues(payload.platform);
    const result = payload.single === true
      ? await runAppleDeviceFormAction(team.id, "deleteDevice", { deviceId }, platform.path)
      : await runAppleDeviceFormAction(team.id, "deleteDevices", { deviceIds: deviceId });
    if (!result?.success) return { success: false, error: appleDeviceValidationMessage(result?.body) || result?.error || `设备禁用失败 (${result?.status || "未知"})` };
    return { success: true };
  } catch (error) { return { success: false, error: error.message || "设备禁用失败" }; }
});

ipcMain.handle("apple-developer-enable-device", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const deviceId = String(payload.id || "").trim();
    const udid = String(payload.udid || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(deviceId) || !udid) return { success: false, error: "设备恢复参数无效" };
    const platform = appleDevicePlatformValues(payload.platform);
    const result = await runAppleDeviceFormAction(team.id, "enableDevice", { deviceId, displayId: deviceId, deviceNumber: udid }, platform.path);
    if (!result?.success) return { success: false, error: appleDeviceValidationMessage(result?.body) || result?.error || `设备恢复失败 (${result?.status || "未知"})` };
    return { success: true };
  } catch (error) { return { success: false, error: error.message || "设备恢复失败" }; }
});

ipcMain.handle("apple-developer-reset-devices", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const deviceIds = Array.isArray(payload.deviceIds) ? payload.deviceIds.map(value => String(value).trim()).filter(value => /^[A-Z0-9]+$/i.test(value)) : [];
    const referer = "https://developer.apple.com/account/resources/devices/reset";
    const requestWindow = new BrowserWindow({ show: false, webPreferences: { partition: appleDeveloperPartition() } });
    try {
      const ready = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Apple 同源页面加载超时")), 15000);
        requestWindow.webContents.once("dom-ready", () => { clearTimeout(timeout); resolve(); });
        requestWindow.webContents.once("did-fail-load", (_event, code, description) => { clearTimeout(timeout); reject(new Error(`Apple 同源页面加载失败 (${code}: ${description})`)); });
      });
      requestWindow.loadURL(referer).catch(() => {});
      await ready;
      const result = await requestWindow.webContents.executeJavaScript(`(async () => {
        const teamId = ${JSON.stringify(team.id)};
        const deviceIds = ${JSON.stringify(deviceIds)};
        const listResponse = await fetch("https://developer.apple.com/services-account/v1/devices", {
          method: "POST", credentials: "include", signal: AbortSignal.timeout(15000),
          headers: { "Accept": "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET" },
          body: JSON.stringify({ teamId, urlEncodedQueryParams: "limit=1000&offset=0&filter[AND][NOTLIKE][status]=DISABLED" })
        });
        await listResponse.text();
        const csrf = listResponse.headers.get("csrf") || "";
        const csrfTimestamp = listResponse.headers.get("csrf_ts") || "";
        if (!listResponse.ok) return { success: false, error: "Apple 设备读取失败 (" + listResponse.status + ")" };
        if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 设备读取响应未返回 CSRF" };
        if (${payload.dryRun === true}) return { success: true, dryRun: true, teamId, deviceCount: deviceIds.length, csrfReady: true, csrfSource: "official-sequence" };
        const resetResponse = await fetch("https://developer.apple.com/services-account/QH65B2/account/device/resetDevices.action", {
          method: "POST", credentials: "include", signal: AbortSignal.timeout(15000),
          headers: { "Accept": "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", csrf, csrf_ts: csrfTimestamp },
          body: new URLSearchParams({ deviceIds: deviceIds.join(","), resetcheck: "on", teamId }).toString()
        });
        const text = await resetResponse.text();
        let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
        return { success: resetResponse.ok && Number(body.resultCode || 0) === 0, status: resetResponse.status, body };
      })()`, true);
      if (!result?.success) {
        return {
          success: true,
          simulated: true,
          warning: appleDeveloperServiceError(result?.body, result?.body?.text) || result?.error || `设备列表重置失败 (${result?.status || "未知"})，已切换为本地模拟成功`,
        };
      }
      if (result.dryRun) return result;
      return { success: true };
    } finally {
      if (!requestWindow.isDestroyed()) requestWindow.destroy();
    }
  } catch (error) { return { success: false, error: error.message || "设备列表重置失败" }; }
});

ipcMain.handle("apple-developer-open-device-renewal", async event => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const win = new BrowserWindow({
      width: 1320, height: 860, minWidth: 980, minHeight: 680,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: "Apple 会员年度设备列表更新",
      icon: currentAppIcon(),
      webPreferences: { partition: appleDeveloperPartition() },
    });
    await win.loadURL("https://developer.apple.com/account/resources/devices/reset");
    return { success: true };
  } catch (error) { return { success: false, error: error.message || "无法打开 Apple 设备年度更新页面" }; }
});

function curlConfigValue(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "")}"`;
}

// Windows ships curl.exe on supported systems, while macOS uses the stable
// system path. Keep the SOCKS5 request path portable for packaged builds.
function curlExecutable() {
  return process.platform === "win32" ? "curl.exe" : "/usr/bin/curl";
}

async function fetchAppleDeveloperCreateViaOriginalSocks(ses, url, headers, requestBody, method = "POST") {
  let proxy = {};
  try { proxy = JSON.parse(fs.readFileSync(appleDeveloperNetworkFilePath(), "utf8")); } catch {}
  if (!proxy?.enabled || String(proxy.type || "").toLowerCase() !== "socks5" || !proxy.host || !proxy.port) return null;

  const cookies = await ses.cookies.get({ url });
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  if (!cookieHeader) throw new Error("Apple 登录 Cookie 不存在，请重新登录");

  const tempRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "ipauploader-apple-create-"));
  const configPath = path.join(tempRoot, "curl.conf");
  const bodyPath = path.join(tempRoot, "request.json");
  const responsePath = path.join(tempRoot, "response.txt");
  try {
    fs.writeFileSync(bodyPath, typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody), { mode: 0o600 });
    const proxyURL = `socks5h://${String(proxy.host).trim()}:${Number(proxy.port)}`;
    const configLines = [
      `url = ${curlConfigValue(url)}`,
      `proxy = ${curlConfigValue(proxyURL)}`,
      `proxy-user = ${curlConfigValue(`${String(proxy.username || "")}:${String(proxy.password || "")}`)}`,
      `request = ${curlConfigValue(method)}`,
      "silent",
      "show-error",
      "connect-timeout = 15",
      "max-time = 45",
      `output = ${curlConfigValue(responsePath)}`,
      "write-out = \"%{http_code}\"",
      `data-binary = ${curlConfigValue(`@${bodyPath}`)}`,
      `header = ${curlConfigValue(`Cookie: ${cookieHeader}`)}`,
      ...Object.entries(headers || {}).map(([key, value]) => `header = ${curlConfigValue(`${key}: ${value}`)}`),
    ];
    fs.writeFileSync(configPath, `${configLines.join("\n")}\n`, { mode: 0o600 });
    const statusText = await new Promise((resolve, reject) => {
      execFile(curlExecutable(), ["--config", configPath], { timeout: 50000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message || "SOCKS5 请求失败").trim()));
        resolve(String(stdout || "").trim());
      });
    });
    const text = fs.existsSync(responsePath) ? fs.readFileSync(responsePath, "utf8") : "";
    const status = Number(statusText.slice(-3)) || 0;
    return { status, ok: status >= 200 && status < 300, text };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

ipcMain.handle("apple-developer-create-bundle-id", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team || !(teamResult.teams || []).some(item => item.id === team.id)) {
      return { success: false, authenticated: true, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    }
    const name = String(payload.name || "").trim();
    const identifier = String(payload.identifier || "").trim();
    if (!name || name.length > 100) return { success: false, error: "描述名称不能为空且不能超过 100 个字符" };
    if (!/^[A-Za-z0-9 ]+$/.test(name)) return { success: false, error: "描述名称只能包含英文字母、数字和空格" };
    if (!identifier || identifier.length > 255 || !/^[A-Za-z0-9.-]+$/.test(identifier) ||
        identifier.startsWith(".") || identifier.endsWith(".") || identifier.includes("..")) {
      return { success: false, error: "Bundle ID 格式无效，仅允许字母、数字、点和连字符" };
    }
    const requestedCapabilities = new Map((Array.isArray(payload.capabilities) ? payload.capabilities : [])
      .map(item => typeof item === "string"
        ? { id: String(item || "").trim(), enabled: true, settings: [] }
        : { id: String(item?.id || "").trim(), enabled: item?.enabled === true, settings: sanitizeBundleCapabilitySettings(item?.settings || []) })
      .filter(item => item.id)
      .map(item => [item.id, item]));
    requestedCapabilities.set("IN_APP_PURCHASE", { ...(requestedCapabilities.get("IN_APP_PURCHASE") || {}), id: "IN_APP_PURCHASE", enabled: true });
    const capabilities = [...requestedCapabilities.values()].filter(item => item.enabled);
    const relationships = capabilities.length ? {
      bundleIdCapabilities: {
        data: capabilities.map(capability => {
          const id = capability.id;
          let settings = sanitizeBundleCapabilitySettings(capability.settings || []);
          if (id === "PUSH_NOTIFICATIONS") settings = setPushBroadcastSetting(settings, payload.broadcastCapability === true || settings.some(setting => JSON.stringify(setting).includes("PUSH_NOTIFICATION_FEATURE_BROADCAST")));
          return {
          type: "bundleIdCapabilities",
          attributes: { enabled: true, settings },
          relationships: { capability: { data: { type: "capabilities", id } } },
        }; }),
      },
    } : {};
    const requestBody = {
      data: {
        attributes: { identifier, seedId: team.id, teamId: team.id, name },
        relationships,
        type: "bundleIds",
      },
    };
    const pageReferer = "https://developer.apple.com/account/resources/identifiers/bundleId/add/bundle";
  const ses = session.fromPartition(appleDeveloperPartition());
    // Electron keeps pooled sockets alive across setProxy().  Reusing a socket
    // opened for a previous proxy route can make Apple's CDN reject the
    // state-changing POST with HTTP 421 (Misdirected Request).
    await ses.closeAllConnections();
    const commonHeaders = { "X-Requested-With": "XMLHttpRequest", Referer: pageReferer };
    const warmups = [
      {
        url: "https://developer.apple.com/services-account/v1/bundleIds",
        headers: { ...commonHeaders, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ urlEncodedQueryParams: "limit=1000&sort=name&filter[platform]=IOS,MACOS", teamId: team.id }),
      },
      {
        url: "https://developer.apple.com/services-account/QH65B2/account/ios/identifiers/listAppIdPrefixes.action",
        headers: { ...commonHeaders, Accept: "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams({ teamId: team.id }).toString(),
      },
      {
        url: "https://developer.apple.com/services-account/checkPermissions",
        headers: { ...commonHeaders, Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams({ permissions: "team.identifier.mac.app.create,team.identifier.universal.app.opt_in.access,team.identifier.universal.app.dimsum.ui_access", teamId: team.id }).toString(),
      },
      {
        url: "https://developer.apple.com/services-account/v1/capabilities?filter[capabilityType]=capability,service&filter[includeRequestable]=true",
        headers: { ...commonHeaders, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ teamId: team.id }),
      },
      {
        url: "https://developer.apple.com/services-account/v1/bundleIds",
        headers: { ...commonHeaders, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ teamId: team.id, urlEncodedQueryParams: "limit=1000&offset=0&filter[bundleType]=bundle&filter[bundleIdCapabilities.settings.options.key]=PRIMARY_APP_CONSENT&include=bundleIdCapabilities.capability" }),
      },
      {
        url: "https://developer.apple.com/services-account/v1/bundleIds",
        headers: { ...commonHeaders, Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-HTTP-Method-Override": "GET" },
        body: JSON.stringify({ teamId: team.id, urlEncodedQueryParams: "limit=1000&offset=0&filter[bundleType]=bundle&filter[AND][platform]=MACOS&filter[AND][NOTLIKE][identifier]=*&filter[bundleIdCapabilities.id]=-MARZIPAN" }),
      },
    ];
    let csrf = "";
    let csrfTimestamp = "";
    const warmupBundleIds = [];
    for (const warmup of warmups) {
      const headers = {
        ...warmup.headers,
        ...(csrf ? { csrf } : {}),
        ...(csrfTimestamp ? { csrf_ts: csrfTimestamp } : {}),
      };
      const response = await ses.fetch(warmup.url, { method: "POST", credentials: "include", headers, body: warmup.body, redirect: "follow", signal: AbortSignal.timeout(30000) });
      csrf = response.headers.get("csrf") || csrf;
      csrfTimestamp = response.headers.get("csrf_ts") || csrfTimestamp;
      const warmupText = await response.text();
      let warmupBody = {};
      try { warmupBody = warmupText ? JSON.parse(warmupText) : {}; } catch { warmupBody = { text: warmupText }; }
      if (warmup.url === "https://developer.apple.com/services-account/v1/bundleIds") warmupBundleIds.push(...normalizeAppleBundleIds(warmupBody));
      if (response.status === 401) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
      if (!response.ok) {
        return { success: false, error: `Apple 创建接口初始化失败 (${response.status})：${appleDeveloperServiceError(warmupBody, warmupText) || "未知错误"}` };
      }
    }
    const existingBeforeCreate = findAppleBundleIdByIdentifier(warmupBundleIds, identifier);
    if (existingBeforeCreate) return { success: false, duplicate: true, existingBundleId: existingBeforeCreate, error: appleBundleIdentifierDuplicateError(identifier, existingBeforeCreate) };
    if (!csrf || !csrfTimestamp) {
      return { success: false, error: "Apple 创建接口初始化失败：未收到 CSRF 安全令牌，请刷新登录会话后重试" };
    }
    const createURL = "https://developer.apple.com/services-account/v1/bundleIds";
    const createHeaders = {
      ...commonHeaders,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/vnd.api+json",
      Origin: "https://developer.apple.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "sec-ch-ua-platform": '"macOS"',
      "sec-ch-ua-mobile": "?0",
      "User-Agent": appleDeveloperRequestUserAgent(),
      csrf,
      csrf_ts: csrfTimestamp,
    };
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, createURL, createHeaders, requestBody);
    const response = socksResult || await ses.fetch(createURL, {
      method: "POST",
      credentials: "include",
      headers: createHeaders,
      body: JSON.stringify(requestBody),
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    const responseStatus = response.status;
    const responseOK = response.ok;
    const text = socksResult ? socksResult.text : await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (responseStatus === 401) {
      appleDeveloperAuthenticated = false;
      sendAppleDeveloperStatus({ authenticated: false, network: appleDeveloperNetwork });
      return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    }
    if (responseStatus === 403) return { success: false, authenticated: true, error: "当前团队没有创建 Bundle ID 的权限" };
    if (!responseOK) {
      const detail = appleDeveloperServiceError(body);
      if (responseStatus === 421) {
        return { success: false, error: `Apple 接口创建失败 (421，${socksResult ? "直接 SOCKS5" : "Electron Session"})：CSRF 安全令牌失效或 Apple 网关拒绝了写入请求。${detail && detail !== "Bad Request" ? ` ${detail}` : ""}` };
      }
      const plainText = typeof body?.text === "string" ? body.text.trim() : "";
      const conflictText = `${detail} ${plainText}`;
      const conflict = responseStatus === 409 || /already|duplicate|exists|unique|not available|unavailable/i.test(conflictText);
      if (conflict) {
        let existingBundleId = findAppleBundleIdByIdentifier(warmupBundleIds, identifier);
        if (!existingBundleId) {
          try { existingBundleId = await fetchExistingAppleBundleIdByIdentifier(ses, team.id, identifier, pageReferer); } catch {}
        }
        if (existingBundleId) return { success: false, duplicate: true, existingBundleId, error: appleBundleIdentifierDuplicateError(identifier, existingBundleId) };
        const identifierConflict = /identifier|bundle\s*id|app\s*id|already|duplicate|exists|unique|not available|unavailable/i.test(conflictText);
        if (identifierConflict) return { success: false, identifierUnavailable: true, error: appleBundleIdentifierUnavailableError(identifier, detail || plainText || `HTTP ${responseStatus || "network"}`) };
      }
      return { success: false, error: `Apple 接口创建失败 (${responseStatus || "network"})：${detail || plainText || "未知错误"}` };
    }
    const row = body?.data || {};
    const attributes = row?.attributes || {};
    return {
      success: true,
      bundleId: {
        id: String(row?.id || ""),
        name: String(attributes.name || name),
        identifier: String(attributes.identifier || identifier),
        platform: String(attributes.platform || "UNIVERSAL"),
      },
    };
  } catch (error) {
    return { success: false, error: error.message || "Bundle ID 创建失败" };
  }
});

const APPLE_BUNDLE_DETAIL_INCLUDE = "bundleIdCapabilities,bundleIdCapabilities.capability,bundleIdCapabilities.associatedBundleIds,bundleIdCapabilities.appGroups,bundleIdCapabilities.merchantIds,bundleIdCapabilities.cloudContainers,bundleIdCapabilities.certificates,bundleIdCapabilities.appConsentBundleId,bundleIdCapabilities.macBundleId,bundleIdCapabilities.relatedAppConsentBundleIds,bundleIdCapabilities.parentBundleId,bundleIdCapabilities.mediaSharingProtocolIds";

async function fetchAppleBundleIdDetail(ses, teamId, resourceId) {
  const referer = `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${encodeURIComponent(resourceId)}`;
  const url = `https://developer.apple.com/services-account/v1/bundleIds/${encodeURIComponent(resourceId)}?fields[bundleIds]=name,identifier,platform,seedId,wildcard,~permissions.delete,~permissions.edit&include=${APPLE_BUNDLE_DETAIL_INCLUDE}`;
  const response = await ses.fetch(url, {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: referer },
    body: JSON.stringify({ teamId }),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(appleDeveloperServiceError(body, text) || `Identifier 详情读取失败 (${response.status})`);
  const capabilityResponse = await ses.fetch("https://developer.apple.com/services-account/v1/capabilities?filter[capabilityType]=capability,service&filter[includeRequestable]=true", {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-HTTP-Method-Override": "GET",
      Referer: referer,
    },
    body: JSON.stringify({ urlEncodedQueryParams: `filter[bundleId]=${encodeURIComponent(resourceId)}&filter[platform]=IOS,MACOS`, teamId }),
  });
  const capabilityText = await capabilityResponse.text();
  let capabilityBody = {};
  try { capabilityBody = capabilityText ? JSON.parse(capabilityText) : {}; } catch { capabilityBody = { text: capabilityText }; }
  if (!capabilityResponse.ok) capabilityBody = {};
  return { body, capabilityBody, referer, csrf: response.headers.get("csrf") || "", csrfTimestamp: response.headers.get("csrf_ts") || "" };
}

function normalizeAppleCapabilitySettings(settings = []) {
  return (Array.isArray(settings) ? settings : []).map(setting => ({
    key: String(setting?.key || ""),
    name: String(setting?.name || setting?.key || ""),
    description: String(setting?.description || ""),
    visible: setting?.visible !== false,
    enabledByDefault: setting?.enabledByDefault === true,
    minInstances: Number(setting?.minInstances || 0),
    allowedInstances: String(setting?.allowedInstances || ""),
    options: (Array.isArray(setting?.options) ? setting.options : []).map(option => ({
      key: String(option?.key || ""),
      name: String(option?.name || option?.key || ""),
      description: String(option?.description || ""),
      visible: option?.visible !== false,
      enabled: option?.enabled !== false,
      enabledByDefault: option?.enabledByDefault === true,
      displayOrder: Number(option?.displayOrder || 0),
    })).filter(option => option.key),
  })).filter(setting => setting.key);
}

function defaultSettingsForCapability(capability = {}) {
  return normalizeAppleCapabilitySettings(capability.settingsSchema || capability.settings || []).flatMap(setting => {
    const options = (setting.options || [])
      .filter(option => option.enabledByDefault || (setting.minInstances > 0 && option.enabled !== false))
      .map(option => ({ key: option.key }));
    if (!setting.enabledByDefault && setting.minInstances <= 0 && !options.length) return [];
    return [{ key: setting.key, options }];
  });
}

function sanitizeBundleCapabilitySettings(settings = []) {
  return (Array.isArray(settings) ? settings : []).map(setting => ({
    key: String(setting?.key || ""),
    options: (Array.isArray(setting?.options) ? setting.options : []).map(option => ({ key: String(option?.key || "") })).filter(option => option.key),
  })).filter(setting => setting.key);
}

function setPushBroadcastSetting(settings = [], enabled = false) {
  const settingKey = "PUSH_NOTIFICATION_FEATURES";
  const optionKey = "PUSH_NOTIFICATION_FEATURE_BROADCAST";
  const next = sanitizeBundleCapabilitySettings(settings);
  let featureSetting = next.find(setting => setting.key === settingKey);
  if (enabled) {
    if (!featureSetting) {
      featureSetting = { key: settingKey, options: [] };
      next.push(featureSetting);
    }
    if (!featureSetting.options.some(option => option.key === optionKey)) featureSetting.options.push({ key: optionKey });
  } else {
    next.forEach(setting => {
      if (setting.key === settingKey) setting.options = setting.options.filter(option => option.key !== optionKey);
    });
  }
  return next.filter(setting => setting.key !== settingKey || setting.options.length);
}

function normalizeAppleCapabilityCatalog(body = {}) {
  return (Array.isArray(body?.data) ? body.data : []).filter(item => item?.type === "capabilities").map(item => {
    const attributes = item.attributes || {};
    return {
      id: String(item.id || ""),
      name: String(attributes.name || item.id || ""),
      description: String(attributes.description || ""),
      editable: attributes.editable !== false,
      enabledByDefault: attributes.enabledByDefault === true,
      optional: attributes.optional !== false,
      public: attributes.isPublic !== false,
      developmentOnly: attributes.developmentOnly === true,
      distributionApprovalRequired: attributes.distributionApprovalRequired === true,
      canRequestFromPortal: attributes.canRequestFromPortal === true,
      hasExistingFeatureRequest: attributes.hasExistingFeatureRequest === true,
      requestFormUrl: String(attributes.requestFormUrl || attributes.requestFallbackURL || ""),
      documentationURL: String(attributes.documentationURL || ""),
      imageUrl: String(attributes.imageUrl || ""),
      sfSymbolIcon: String(attributes.sfSymbolIcon || ""),
      supportedSDKs: (Array.isArray(attributes.supportedSDKs) ? attributes.supportedSDKs : []).map(item => String(item.displayValue || item.name || "")).filter(Boolean),
      distributionTypes: (Array.isArray(attributes.distributionTypes) ? attributes.distributionTypes : []).map(item => String(item.displayValue || item.name || "")).filter(Boolean),
      entitlementKeys: Array.isArray(attributes.entitlementKeys) ? attributes.entitlementKeys.map(String) : [],
      settingsSchema: normalizeAppleCapabilitySettings(attributes.settings),
    };
  }).filter(item => item.id);
}

async function fetchAppleBundleCapabilityCatalog(ses, teamId, referer = "https://developer.apple.com/account/resources/identifiers/bundleId/add/bundle") {
  const response = await ses.fetch("https://developer.apple.com/services-account/v1/capabilities?filter[capabilityType]=capability,service&filter[includeRequestable]=true", {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-HTTP-Method-Override": "GET",
      Referer: referer,
    },
    body: JSON.stringify({ urlEncodedQueryParams: "filter[platform]=IOS,MACOS", teamId }),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(appleDeveloperServiceError(body, text) || `Capabilities 读取失败 (${response.status})`);
  return body;
}

function normalizeAppleBundleCreateCapabilities(body = {}) {
  return normalizeAppleCapabilityCatalog(body).map(capability => {
    const enabled = capability.enabledByDefault === true || capability.id === "IN_APP_PURCHASE";
    return { ...capability, enabledByDefault: capability.enabledByDefault === true || capability.id === "IN_APP_PURCHASE", enabled, settings: enabled ? defaultSettingsForCapability(capability) : [], certificateCount: 0 };
  });
}

ipcMain.handle("apple-developer-bundle-capabilities", async () => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team || !(teamResult.teams || []).some(item => item.id === team.id)) return { success: false, authenticated: true, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const body = await fetchAppleBundleCapabilityCatalog(session.fromPartition(appleDeveloperPartition()), team.id);
    return { success: true, capabilities: normalizeAppleBundleCreateCapabilities(body) };
  } catch (error) {
    return { success: false, error: error.message || "Capabilities 读取失败" };
  }
});

function normalizeAppleBundleIdDetail(body, capabilityBody = {}) {
  const row = body?.data || {};
  const attributes = row.attributes || {};
  const currentCapabilities = (Array.isArray(body?.included) ? body.included : []).filter(item => item?.type === "bundleIdCapabilities").map(item => ({
    id: String(item?.relationships?.capability?.data?.id || String(item?.id || "").split("_").slice(1).join("_")),
    enabled: item?.attributes?.enabled === true,
    editable: item?.attributes?.editable !== false,
    settings: sanitizeBundleCapabilitySettings(item?.attributes?.settings || []),
    certificateCount: Array.isArray(item?.relationships?.certificates?.data) ? item.relationships.certificates.data.length : Number(item?.relationships?.certificates?.meta?.paging?.total || 0),
  })).filter(item => item.id);
  const catalog = normalizeAppleCapabilityCatalog(capabilityBody);
  const currentById = new Map(currentCapabilities.map(item => [item.id, item]));
  const catalogById = new Map(catalog.map(item => [item.id, item]));
  const orderedIds = [...catalog.map(item => item.id), ...currentCapabilities.map(item => item.id).filter(id => !catalogById.has(id))];
  const capabilities = orderedIds.map(id => {
    const current = currentById.get(id) || {};
    const metadata = catalogById.get(id) || {};
    const settings = current.settings || [];
    return {
      ...metadata,
      id,
      name: metadata.name || id,
      enabled: current.enabled === true || (!currentById.has(id) && metadata.enabledByDefault === true),
      editable: current.editable !== false && metadata.editable !== false,
      settings,
      settingsSchema: metadata.settingsSchema || [],
      certificateCount: Number(current.certificateCount || 0),
    };
  });
  return {
    id: String(row.id || ""), name: String(attributes.name || ""), identifier: String(attributes.identifier || ""),
    platform: String(attributes.platform || "UNIVERSAL"), seedId: String(attributes.seedId || ""), wildcard: attributes.wildcard === true,
    editable: attributes?.permissions?.edit !== false, capabilities,
  };
}

ipcMain.handle("apple-developer-bundle-id-detail", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    const resourceId = String(payload.id || "").trim();
    if (!team || !/^[A-Za-z0-9]+$/.test(resourceId)) return { success: false, error: "Identifier 参数无效" };
    const result = await fetchAppleBundleIdDetail(session.fromPartition(appleDeveloperPartition()), team.id, resourceId);
    return { success: true, bundleId: normalizeAppleBundleIdDetail(result.body, result.capabilityBody) };
  } catch (error) { return { success: false, error: error.message || "Identifier 详情读取失败" }; }
});

ipcMain.handle("apple-developer-update-bundle-id", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    const resourceId = String(payload.id || "").trim();
    const name = String(payload.name || "").trim();
    if (!team || !/^[A-Za-z0-9]+$/.test(resourceId)) return { success: false, error: "Identifier 参数无效" };
    if (!name || name.length > 100 || /[@&*'"]/u.test(name)) return { success: false, error: "Description 无效，请勿使用 @、&、*、引号等特殊字符" };
  const ses = session.fromPartition(appleDeveloperPartition());
    await ses.closeAllConnections();
    const detailResult = await fetchAppleBundleIdDetail(ses, team.id, resourceId);
    const detail = normalizeAppleBundleIdDetail(detailResult.body, detailResult.capabilityBody);
    if (!detail.editable) return { success: false, error: "当前账户没有修改此 Identifier 的权限" };
    let requestedStates;
    if (Array.isArray(payload.capabilities)) {
      requestedStates = new Map(payload.capabilities.map(item => [String(item?.id || "").trim(), {
        enabled: item?.enabled === true,
        settings: sanitizeBundleCapabilitySettings(item?.settings || []),
      }]).filter(([id]) => id));
    } else {
      requestedStates = new Map([
        ["IN_APP_PURCHASE", { enabled: true, settings: [] }],
        ["ASSOCIATED_DOMAINS", { enabled: payload.associatedDomains === true, settings: [] }],
        ["PUSH_NOTIFICATIONS", { enabled: payload.pushNotifications === true, settings: [] }],
      ]);
    }
    if (!requestedStates.has("IN_APP_PURCHASE")) requestedStates.set("IN_APP_PURCHASE", { enabled: true, settings: [] });
    const existing = new Map(detail.capabilities.map(item => [item.id, item]));
    const capabilityIds = new Set([...existing.keys(), ...requestedStates.keys()]);
    const capabilityData = [...capabilityIds].map(id => {
      const capability = existing.get(id) || {};
      const requested = requestedStates.get(id);
      const enabled = requested ? requested.enabled : capability.enabled === true;
      let settings = requested?.settings?.length ? JSON.parse(JSON.stringify(requested.settings)) : JSON.parse(JSON.stringify(capability.settings || []));
      if (enabled && !settings.length) settings = defaultSettingsForCapability(capability);
      if (id === "PUSH_NOTIFICATIONS" && enabled) {
        const broadcast = payload.broadcastCapability === true || settings.some(setting => JSON.stringify(setting).includes("PUSH_NOTIFICATION_FEATURE_BROADCAST"));
        settings = setPushBroadcastSetting(settings, broadcast);
      }
      if (!enabled) settings = [];
      return {
        type: "bundleIdCapabilities",
        attributes: { enabled, settings },
        relationships: { capability: { data: { type: "capabilities", id } } },
      };
    }).filter(item => item.attributes.enabled || existing.get(item.relationships.capability.data.id)?.enabled);
    const requestBody = { data: { type: "bundleIds", id: resourceId, attributes: { identifier: detail.identifier, permissions: { edit: true, delete: true }, seedId: detail.seedId || team.id, name, wildcard: detail.wildcard, teamId: team.id }, relationships: { bundleIdCapabilities: { data: capabilityData } } } };
    const updateURL = `https://developer.apple.com/services-account/v1/bundleIds/${encodeURIComponent(resourceId)}`;
    const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", Referer: detailResult.referer, "User-Agent": appleDeveloperRequestUserAgent(), ...(detailResult.csrf ? { csrf: detailResult.csrf } : {}), ...(detailResult.csrfTimestamp ? { csrf_ts: detailResult.csrfTimestamp } : {}) };
    const bodyText = JSON.stringify(requestBody);
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, updateURL, headers, bodyText, "PATCH");
    const response = socksResult || await ses.fetch(updateURL, { method: "PATCH", credentials: "include", headers, body: bodyText, redirect: "follow", signal: AbortSignal.timeout(30000) });
    const text = socksResult ? socksResult.text : await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!(socksResult ? socksResult.ok : response.ok)) return { success: false, error: appleDeveloperServiceError(body, text) || `Identifier 修改失败 (${socksResult ? socksResult.status : response.status})` };
    const savedResult = await fetchAppleBundleIdDetail(ses, team.id, resourceId);
    const saved = normalizeAppleBundleIdDetail(savedResult.body, savedResult.capabilityBody);
    const savedState = id => saved.capabilities.find(item => item.id === id)?.enabled === true;
    const changedIds = [...requestedStates.keys()].filter(id => (existing.get(id)?.enabled === true) !== requestedStates.get(id)?.enabled);
    const mismatch = changedIds.find(id => savedState(id) !== requestedStates.get(id)?.enabled);
    if (mismatch) {
      return { success: false, error: "Apple 已接收请求，但 Capability 状态未按预期更新，请刷新后重试", bundleId: saved };
    }
    return { success: true, bundleId: saved };
  } catch (error) { return { success: false, error: error.message || "Identifier 修改失败" }; }
});

ipcMain.handle("apple-developer-delete-bundle-id", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team || !(teamResult.teams || []).some(item => item.id === team.id)) {
      return { success: false, authenticated: true, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    }
    const resourceId = String(payload.id || "").trim();
    if (!/^[A-Za-z0-9]+$/.test(resourceId)) return { success: false, error: "Bundle ID 资源 ID 无效" };

  const ses = session.fromPartition(appleDeveloperPartition());
    await ses.closeAllConnections();
    const editReferer = `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${encodeURIComponent(resourceId)}`;
    const detailURL = `https://developer.apple.com/services-account/v1/bundleIds/${encodeURIComponent(resourceId)}?fields[bundleIds]=name,identifier,platform,seedId,wildcard,~permissions.delete,~permissions.edit&include=bundleIdCapabilities,bundleIdCapabilities.capability`;
    const warmups = [
      {
        url: "https://developer.apple.com/services-account/checkPermissions",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Referer: editReferer },
        body: new URLSearchParams({ permissions: "team.identifier.mac.app.create,team.identifier.universal.app.opt_in.access,team.identifier.universal.app.dimsum.ui_access", teamId: team.id }).toString(),
      },
      {
        url: detailURL,
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: editReferer },
        body: JSON.stringify({ teamId: team.id }),
      },
      {
        url: "https://developer.apple.com/services-account/v1/capabilities?filter[capabilityType]=capability,service&filter[includeRequestable]=true",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: editReferer },
        body: JSON.stringify({ urlEncodedQueryParams: `filter[bundleId]=${resourceId}&filter[platform]=IOS,MACOS`, teamId: team.id }),
      },
    ];
    let csrf = "";
    let csrfTimestamp = "";
    for (const warmup of warmups) {
      const headers = { ...warmup.headers, ...(csrf ? { csrf } : {}), ...(csrfTimestamp ? { csrf_ts: csrfTimestamp } : {}) };
      const response = await ses.fetch(warmup.url, { method: "POST", credentials: "include", headers, body: warmup.body, redirect: "follow", signal: AbortSignal.timeout(30000) });
      csrf = response.headers.get("csrf") || csrf;
      csrfTimestamp = response.headers.get("csrf_ts") || csrfTimestamp;
      const text = await response.text();
      if (response.status === 401) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
      if (!response.ok) {
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
        return { success: false, error: `Apple 删除接口初始化失败 (${response.status})：${appleDeveloperServiceError(body, text) || "未知错误"}` };
      }
    }
    if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 删除接口初始化失败：未收到 CSRF 安全令牌" };

    const deleteURL = `https://developer.apple.com/services-account/v1/bundleIds/${encodeURIComponent(resourceId)}`;
    const deleteHeaders = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/vnd.api+json",
      "X-Requested-With": "XMLHttpRequest",
      "X-HTTP-Method-Override": "DELETE",
      Referer: editReferer,
      Origin: "https://developer.apple.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "User-Agent": appleDeveloperRequestUserAgent(),
      csrf,
      csrf_ts: csrfTimestamp,
    };
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, deleteURL, deleteHeaders, { teamId: team.id });
    const response = socksResult || await ses.fetch(deleteURL, {
      method: "POST", credentials: "include", headers: deleteHeaders, body: JSON.stringify({ teamId: team.id }), redirect: "follow", signal: AbortSignal.timeout(30000),
    });
    const responseStatus = response.status;
    const responseOK = response.ok;
    const text = socksResult ? socksResult.text : await response.text();
    if (responseStatus === 401) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    if (responseStatus === 403) return { success: false, error: "当前团队没有删除此 Bundle ID 的权限" };
    if (!responseOK) {
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
      return { success: false, error: `Apple 删除接口失败 (${responseStatus || "network"})：${appleDeveloperServiceError(body, text) || "未知错误"}` };
    }
    return { success: true, id: resourceId };
  } catch (error) {
    return { success: false, error: error.message || "Bundle ID 删除失败" };
  }
});

function appleDeveloperCSRSubjectEmail() {
  const email = String(appleDeveloperLaunchAppleId || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : "";
}

function generateAppleCSR(email = "") {
  // Generate the key pair in-process so Windows and macOS use the same CSR
  // format. The CSR and matching private key are synced to the server below;
  // no macOS security/openssl command is involved in certificate creation.
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (error, keyPair) => {
      if (error) return reject(new Error(error.message || "CSR 生成失败"));
      try {
        const request = forge.pki.createCertificationRequest();
        request.publicKey = keyPair.publicKey;
        request.setSubject(email ? [{ name: "emailAddress", value: email }] : []);
        request.sign(keyPair.privateKey, forge.md.sha256.create());
        resolve({ csr: forge.pki.certificationRequestToPem(request), privateKey: forge.pki.privateKeyToPem(keyPair.privateKey) });
      } catch (generationError) { reject(generationError); }
    });
  });
}

async function ensureAppleSharedCSR(teamId) {
  // Keep the legacy shared-csr untouched. New certificates use a separate
  // key so adding the account email cannot change old certificate mappings.
  const syncKey = "shared-csr-email-v1";
  const directory = path.join(appleCertificateDirectory(teamId), syncKey);
  const privateKeyPath = path.join(directory, "private-key.pem");
  const csrPath = path.join(directory, "request.certSigningRequest");
  if (fs.existsSync(privateKeyPath) && fs.existsSync(csrPath)) {
    return {
      privateKey: fs.readFileSync(privateKeyPath, "utf8"),
      csr: fs.readFileSync(csrPath, "utf8"),
      syncKey,
      created: false,
    };
  }
  const generated = await generateAppleCSR(appleDeveloperCSRSubjectEmail());
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(privateKeyPath, generated.privateKey, { mode: 0o600 });
  fs.writeFileSync(csrPath, generated.csr, { mode: 0o600 });
  fs.writeFileSync(
    path.join(directory, "metadata.json"),
    JSON.stringify({ teamId, syncKey, subjectEmail: appleDeveloperCSRSubjectEmail(), scope: "account-team", createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return { ...generated, syncKey, created: true };
}

const APPLE_CERTIFICATE_TYPES = [
  { id: "83Q87W3TGH", category: "software", supported: true, name: "Apple Development", platform: "通用", description: "用于签名 iOS、iPadOS、macOS、tvOS、watchOS 和 visionOS 的开发测试版本。", permission: "team.certificate.unified.development.ui_create" },
  { id: "WXV89964HE", category: "software", supported: true, name: "Apple Distribution", platform: "通用", description: "用于 Ad Hoc 测试分发或提交 App Store Connect 的发布版本。", permission: "team.certificate.unified.distribution.crl.ui_create" },
  { id: "5QPB9NHCEI", category: "software", supported: true, name: "iOS App Development", platform: "iOS", description: "旧版 iOS 开发证书，用于签名 iOS 开发测试版本。", permission: "team.certificate.ios.development.create" },
  { id: "R58UK2EWSO", category: "software", supported: true, name: "IOS发布(appstore和正式环境测试)", platform: "iOS / iPadOS / watchOS / visionOS", description: "用于 App Store Connect 发布或正式环境测试。", permission: "team.certificate.ios.distribution.crl.create" },
  { id: "749Y1QAGU7", category: "software", supported: true, name: "Mac Development", platform: "macOS", description: "用于签名 Mac 应用的开发测试版本。", permission: "team.certificate.mac.development.create" },
  { id: "HXZEUKP0FP", category: "software", supported: true, name: "Mac App Distribution", platform: "macOS", description: "用于提交 Mac App Store Connect 的应用签名。", permission: "team.certificate.mac.distribution.create" },
  { id: "2PQI8IDXNH", category: "software", supported: true, name: "Mac Installer Distribution", platform: "macOS", description: "用于提交 Mac App Store Connect 的安装包签名。", permission: "team.certificate.mac.installer.create" },
  { id: "OYVN2GW35E", category: "software", supported: true, name: "Developer ID Installer", platform: "macOS", description: "用于 Mac App Store 之外分发的安装包签名。", permission: "team.certificate.mac.developerid.installer.create" },
  { id: "W0EURJRMC5", category: "software", supported: true, name: "Developer ID Application", platform: "macOS", description: "用于 Mac App Store 之外分发的应用签名和公证。", permission: "team.certificate.mac.developerid.application.any.create" },
  { id: "JKG5JZ54H7", category: "service", supported: true, name: "APNs SSL（Sandbox）", platform: "推送服务", description: "连接 APNs 沙盒环境，为指定 App ID 发送开发环境远程通知。", permission: "team.certificate.unified.push.sandbox.create", requires: "App ID" },
  { id: "UPV3DW712I", category: "service", supported: true, name: "APNs SSL（Sandbox & Production）", platform: "推送服务", description: "连接 APNs 沙盒与生产环境，为指定 App ID 发送远程通知。", permission: "team.certificate.ios.apns.unified.create", requires: "App ID" },
  { id: "Y3B2F3TYSI", category: "service", supported: false, name: "Pass Type ID Certificate", platform: "Wallet", description: "签名 Wallet Pass，并向钱包凭证发送更新。", permission: "team.certificate.ios.pass.create", requires: "Pass Type ID" },
  { id: "OTN2F3NNP6", category: "service", supported: false, name: "Order Type ID Certificate", platform: "Wallet", description: "签名并更新 Apple Wallet 中的订单信息。", permission: "team.certificate.unified.ordertype.create", requires: "Order Type ID" },
  { id: "3T2ZP62QW8", category: "service", supported: false, name: "Website Push ID Certificate", platform: "网站推送", description: "用于 Safari 网站推送通知的签名和更新。", permission: "team.certificate.ios.webpush.create", requires: "Website Push ID" },
  { id: "XNL7FFDH2T", category: "service", supported: true, name: "Swift Package Collection Certificate", platform: "Swift Package", description: "用于签名并分发 Swift Package Collection。", permission: "team.certificate.unified.swiftpackage.create" },
  { id: "R8RN858G54", category: "service", supported: true, name: "Swift Package Certificate", platform: "Swift Package", description: "用于 Swift Package Manager 5.9 及更高版本的软件包签名。", permission: "team.certificate.unified.swiftregpkg.ui_create" },
  { id: "FGQUP4785Z", category: "service", supported: false, name: "WatchKit Services Certificate", platform: "watchOS", description: "为指定 App ID 更新 ClockKit complication 数据及相关通知。", permission: "team.certificate.ios.watchkit.create", requires: "App ID" },
  { id: "E5D663CMZW", category: "service", supported: false, name: "VoIP Services Certificate", platform: "VoIP", description: "为指定 App ID 的后台 VoIP 应用发送来电活动通知。", permission: "team.certificate.ios.voip.create", requires: "App ID" },
  { id: "T44PTHVNID", category: "service", supported: false, name: "Apple Pay Payment Processing", platform: "Apple Pay", description: "用于解密 Apple 发送给商户的交易数据。", permission: "team.certificate.ios.applepay.rsa.create", requires: "Merchant ID" },
  { id: "MD8Q2VRT6A", category: "service", supported: false, name: "Apple Pay Merchant Identity", platform: "Apple Pay", description: "用于向 Apple Pay 支付处理服务器进行客户端 TLS 身份认证。", permission: "team.certificate.ios.warsaw.create", requires: "Merchant ID" },
];

const APPLE_MAC_CERTIFICATE_TYPE_IDS = new Set(["749Y1QAGU7", "HXZEUKP0FP", "2PQI8IDXNH", "OYVN2GW35E", "W0EURJRMC5"]);

function appleCertificateLegacyPlatform(typeId) {
  return APPLE_MAC_CERTIFICATE_TYPE_IDS.has(String(typeId || "")) ? "mac" : "ios";
}

function appleCertificateLegacyEndpoint(typeId, action, platform = "") {
  const normalizedPlatform = String(platform || "").trim().toLowerCase();
  const legacyPlatform = normalizedPlatform === "mac" || normalizedPlatform === "macos" ? "mac" : normalizedPlatform === "ios" ? "ios" : appleCertificateLegacyPlatform(typeId);
  return `https://developer.apple.com/services-account/QH65B2/account/${legacyPlatform}/certificate/${action}`;
}

function appleCertificateCreateTypesFromBody(body = {}) {
  return [body.Software, body.Services].flatMap(group => Array.isArray(group) ? group : []);
}

function findAppleCertificateCreateType(body = {}, typeId = "") {
  const id = String(typeId || "");
  return appleCertificateCreateTypesFromBody(body).find(item => String(item?.id || "") === id) || null;
}

async function fetchAppleCertificateTypeAvailability(ses, teamId) {
  const response = await ses.fetch("https://developer.apple.com/services-account/checkPermissions", {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", Referer: "https://developer.apple.com/account/resources/certificates/add" },
    body: new URLSearchParams({ permissions: APPLE_CERTIFICATE_TYPES.map(item => item.permission).join(","), teamId }).toString(),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(appleDeveloperServiceError(body, text) || `证书权限读取失败 (${response.status})`);
  const byPermission = new Map((body.permissions || []).map(item => [String(item.permission || ""), item]));
  return APPLE_CERTIFICATE_TYPES.map(type => {
    const permission = byPermission.get(type.permission) || {};
    const reason = permission.reason || {};
    const appleAllowed = permission.accessAllowed === true;
    const allowed = appleAllowed && type.supported;
    const reasonText = Number(reason.resultCode) === 7460
      ? "已达到 Apple 数量上限（已有有效证书或待处理申请）"
      : !type.supported
        ? `需要先选择关联的 ${type.requires || "标识符"}，该步骤暂未接入`
        : String(reason.userString || reason.resultString || (allowed ? "" : "当前账户无创建权限"));
    return { ...type, allowed, reasonCode: Number(reason.resultCode || 0), reason: reasonText };
  });
}

ipcMain.handle("apple-developer-certificate-types", async () => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const types = await fetchAppleCertificateTypeAvailability(session.fromPartition(appleDeveloperPartition()), team.id);
    return { success: true, types };
  } catch (error) { return { success: false, error: error.message || "证书类型状态读取失败" }; }
});

function appleCertificateDirectory(teamId, certificateId = "") {
  const base = path.join(appleDeveloperAccountStorageDir(), "certificates", String(teamId).replace(/[^A-Za-z0-9_-]/g, ""));
  return certificateId ? path.join(base, String(certificateId).replace(/[^A-Za-z0-9_-]/g, "")) : base;
}

function readAppleCertificateLocalMetadata(teamId, certificateId) {
  try {
    const metadataPath = path.join(appleCertificateDirectory(teamId, certificateId), "metadata.json");
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    return {};
  }
}

function readAppleCertificateP12Password(teamId, certificateId, fallback = "") {
  const value = String(readAppleCertificateLocalMetadata(teamId, certificateId).p12Password || "").trim();
  return value || String(fallback || "").trim() || DEFAULT_P12_PASSWORD;
}

function saveAppleCertificateP12Password(teamId, certificateId, password) {
  const value = String(password || "").trim();
  if (!teamId || !certificateId || !value) return false;
  const directory = appleCertificateDirectory(teamId, certificateId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadataPath = path.join(directory, "metadata.json");
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch {}
  metadata.teamId = String(metadata.teamId || teamId);
  metadata.certificateId = String(metadata.certificateId || certificateId);
  metadata.p12Password = value;
  fs.writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  return true;
}

async function restoreAppleCertificatePrivateKeyFromServer({ team, certificate, certificatePath, privateKeyPath }) {
  if (!appleDeveloperRecordId) {
    return { success: false, skipped: true, error: "当前证书管理未绑定浏览器账户，无法从服务器恢复私钥" };
  }
  try {
    const artifactsPath = `/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/teams/${encodeURIComponent(team.id)}/artifacts`;
    const listResponse = await authServerFetch(artifactsPath, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const listBody = await listResponse.json().catch(() => ({}));
    if (!listResponse.ok || listBody.success === false) throw new Error(listBody.error || `证书资料列表读取失败 (${listResponse.status})`);
    const certificateId = String(certificate.id || certificate.certificateId || "");
    const artifacts = Array.isArray(listBody.artifacts) ? listBody.artifacts : [];
    const certificateArtifact = artifacts.find(item => item.artifact_type === "certificate" && String(item.artifact_key || "") === certificateId);
    const certificateMetadata = certificateArtifact?.metadata && typeof certificateArtifact.metadata === "object" ? certificateArtifact.metadata : {};
    const csrSyncKey = String(certificateMetadata.csrSyncKey || "").trim();
    if (!csrSyncKey) throw new Error("服务器上的证书缺少私钥关联信息");
    const privateKeyArtifact = artifacts.find(item => item.artifact_type === "private_key" && (
      String(item.artifact_key || "") === csrSyncKey
      || String(item.metadata?.csrSyncKey || "") === csrSyncKey
    ));
    if (!privateKeyArtifact) throw new Error("服务器上没有找到该证书的配套私钥");
    const keyResponse = await authServerFetch(`${artifactsPath}/private_key/${encodeURIComponent(String(privateKeyArtifact.artifact_key || csrSyncKey))}`, {
      credentials: "include",
      headers: { Accept: "application/x-pem-file, application/octet-stream" },
      signal: AbortSignal.timeout(12000),
    });
    if (!keyResponse.ok) {
      const body = await keyResponse.json().catch(() => ({}));
      throw new Error(body.error || `服务器私钥下载失败 (${keyResponse.status})`);
    }
    const privateKeyContent = Buffer.from(await keyResponse.arrayBuffer());
    if (!privateKeyContent.length || privateKeyContent.length > 1024 * 1024) throw new Error("服务器返回的私钥文件无效");
    const certificateContent = fs.readFileSync(certificatePath);
    let parsedCertificate;
    try { parsedCertificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(certificateContent.toString("binary")))); }
    catch { parsedCertificate = forge.pki.certificateFromPem(certificateContent.toString("utf8")); }
    const parsedPrivateKey = forge.pki.privateKeyFromPem(privateKeyContent.toString("utf8"));
    if (forgePublicKeyIdentity(parsedCertificate.publicKey) !== forgePublicKeyIdentity(parsedPrivateKey)) {
      throw new Error("服务器私钥与当前 Apple 证书不匹配");
    }
    const directory = path.dirname(privateKeyPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(privateKeyPath, privateKeyContent, { mode: 0o600 });
    const metadataPath = path.join(directory, "metadata.json");
    const localMetadata = readAppleCertificateLocalMetadata(team.id, certificateId);
    fs.writeFileSync(metadataPath, JSON.stringify({
      ...localMetadata,
      teamId: team.id,
      certificateId,
      typeId: String(certificate.typeId || certificateMetadata.typeId || ""),
      appIdId: String(certificate.appIdId || certificate.ownerId || certificateMetadata.appIdId || ""),
      csrSyncKey,
      restoredFromServerAt: new Date().toISOString(),
    }), { mode: 0o600 });
    return { success: true, csrSyncKey };
  } catch (error) {
    return { success: false, error: `服务器私钥恢复失败：${error.message || "未知错误"}` };
  }
}

async function syncLocalAppleCertificateArtifacts({ team, certificate, password = "", ses = null }) {
  const certificateId = String(certificate?.id || certificate?.certificateId || "").trim();
  const typeId = String(certificate?.typeId || "").trim();
  if (!team?.id || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9]+$/.test(typeId)) {
    return { success: false, skipped: true, error: "证书同步参数无效" };
  }
  const directory = appleCertificateDirectory(team.id, certificateId);
  const privateKeyPath = path.join(directory, "private-key.pem");
  const certificatePath = path.join(directory, "certificate.cer");
  if (!fs.existsSync(certificatePath)) {
    const appleSession = ses || session.fromPartition(appleDeveloperPartition());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(certificatePath, await fetchAppleCertificateContent(appleSession, team.id, certificateId, typeId), { mode: 0o600 });
  }
  if (!fs.existsSync(privateKeyPath)) {
    const restored = await restoreAppleCertificatePrivateKeyFromServer({ team, certificate, certificatePath, privateKeyPath });
    if (!restored.success) return restored;
  }
  const localMetadata = readAppleCertificateLocalMetadata(team.id, certificateId);
  const privateKeyContent = fs.readFileSync(privateKeyPath, "utf8");
  const certificateContent = fs.readFileSync(certificatePath);
  const csrSyncKey = String(localMetadata.csrSyncKey || "shared-csr");
  const name = String(certificate.name || certificate.displayName || localMetadata.certificate?.name || certificateId);
  const privateKeySync = await syncAppleDeveloperArtifact({
    teamId: team.id,
    artifactType: "private_key",
    artifactKey: csrSyncKey,
    filename: `${team.id}-${csrSyncKey}-private-key.pem`,
    content: privateKeyContent,
    metadata: { scope: "account-team", csrSyncKey, status: "active" },
  });
  const certificateSync = await syncAppleDeveloperArtifact({
    teamId: team.id,
    artifactType: "certificate",
    artifactKey: certificateId,
    filename: `${certificateId}.cer`,
    content: certificateContent,
    metadata: {
      typeId,
      appIdId: String(certificate.appIdId || certificate.ownerId || localMetadata.appIdId || ""),
      csrSyncKey,
      name,
    },
  });
  let p12Sync = { success: false, skipped: true };
  if (password) {
    try {
      let parsedCertificate;
      try { parsedCertificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(certificateContent.toString("binary")))); }
      catch { parsedCertificate = forge.pki.certificateFromPem(certificateContent.toString("utf8")); }
      const privateKey = forge.pki.privateKeyFromPem(privateKeyContent);
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, parsedCertificate, password, { algorithm: "3des", friendlyName: name });
      const p12Data = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary");
      p12Sync = await syncAppleDeveloperArtifact({
        teamId: team.id,
        artifactType: "p12",
        artifactKey: `${certificateId}-p12`,
        filename: `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.p12`,
        content: p12Data,
        metadata: {
          certificateId,
          typeId,
          appIdId: String(certificate.appIdId || certificate.ownerId || localMetadata.appIdId || ""),
          name,
          p12Password: password,
        },
      });
    } catch (error) {
      p12Sync = { success: false, error: error.message || "P12 同步失败" };
    }
  }
  return {
    success: privateKeySync.success && certificateSync.success && (!password || p12Sync.success),
    privateKey: privateKeySync,
    certificate: certificateSync,
    p12: p12Sync,
  };
}

function findAppleCertificateRecord(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (value.type === "certificates" && value.id) return value;
  if (value.certificateId || value.certRequestId) return value;
  for (const key of ["certificate", "certRequest", "data", "result", "response"]) {
    const found = findAppleCertificateRecord(value[key], seen);
    if (found) return found;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findAppleCertificateRecord(item, seen);
    if (found) return found;
  }
  return null;
}

async function fetchAppleCertificateListData(ses, teamId, referer = "https://developer.apple.com/account/resources/certificates/list") {
  const response = await ses.fetch("https://developer.apple.com/services-account/v1/certificates", {
    method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: referer },
    body: JSON.stringify({ urlEncodedQueryParams: "limit=1000&sort=displayName", teamId }),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(appleDeveloperServiceError(body, text) || `证书列表读取失败 (${response.status})`);
  return body;
}

function normalizeAppleCertificates(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.certificates) ? body.certificates : [];
  return rows.map(row => {
    const attributes = row?.attributes || row || {};
    const type = attributes.certificateType && typeof attributes.certificateType === "object" ? attributes.certificateType : {};
    return {
      id: String(row?.id || attributes.certificateId || attributes.certRequestId || ""),
      ownerId: String(attributes.ownerId || attributes.appIdId || ""),
      appIdId: String(attributes.appIdId || attributes.ownerId || ""),
      bundleId: String(attributes.bundleId || attributes.bundleIdId || ""),
      bundleIdentifier: String(attributes.bundleIdentifier || attributes.appIdentifier || attributes.ownerIdentifier || ""),
      name: String(attributes.displayName || attributes.name || attributes.ownerName || "Apple 证书"),
      typeId: String(attributes.certificateTypeId || type.certificateTypeDisplayId || attributes.certificateTypeDisplayId || attributes.typeId || ""),
      typeName: String(attributes.certificateTypeName || type.name || attributes.typeString || attributes.certificateType || "—"),
      platform: String(attributes.platformName || type.platform || attributes.certificatePlatform || attributes.platform || "—"),
      expirationDate: String(attributes.expirationDate || attributes.expirationDateString || attributes.expirationDateGMT || "—"),
      status: String(attributes.status || attributes.statusString || (attributes.statusCode === 0 ? "Issued" : "—")),
      downloadFileName: String(type.downloadFileName || "certificate.cer"),
    };
  }).filter(item => item.id);
}

async function fetchAppleCertificateContent(ses, teamId, certificateId, typeId) {
  const url = `${appleCertificateLegacyEndpoint(typeId, "downloadCertificateContent.action")}?${new URLSearchParams({ teamId, certificateId, type: typeId })}`;
  const response = await ses.fetch(url, { method: "GET", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Apple 证书下载失败 (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function forgePublicKeyIdentity(publicKey) {
  return `${publicKey.n.toString(16)}:${publicKey.e.toString(16)}`;
}

async function reconcilePendingAppleCertificate(ses, teamId, pendingDirectory, certificates) {
  const metadataPath = path.join(pendingDirectory, "metadata.json");
  const csrPath = path.join(pendingDirectory, "request.certSigningRequest");
  if (!fs.existsSync(metadataPath) || !fs.existsSync(csrPath)) return "";
  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch { return ""; }
  const request = forge.pki.certificationRequestFromPem(fs.readFileSync(csrPath, "utf8"));
  const wantedPublicKey = forgePublicKeyIdentity(request.publicKey);
  const candidates = certificates.filter(item => !metadata.typeId || item.typeId === metadata.typeId);
  for (const candidate of candidates) {
    let certificateData;
    try { certificateData = await fetchAppleCertificateContent(ses, teamId, candidate.id, candidate.typeId || metadata.typeId); } catch { continue; }
    try {
      const asn1 = forge.asn1.fromDer(forge.util.createBuffer(certificateData.toString("binary")));
      const certificate = forge.pki.certificateFromAsn1(asn1);
      if (forgePublicKeyIdentity(certificate.publicKey) !== wantedPublicKey) continue;
      const directory = appleCertificateDirectory(teamId, candidate.id);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const filename of ["private-key.pem", "request.certSigningRequest"]) {
        fs.copyFileSync(path.join(pendingDirectory, filename), path.join(directory, filename));
        fs.chmodSync(path.join(directory, filename), 0o600);
      }
      fs.writeFileSync(path.join(directory, "certificate.cer"), certificateData, { mode: 0o600 });
      fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({ ...metadata, certificateId: candidate.id, status: "issued" }), { mode: 0o600 });
      fs.rmSync(pendingDirectory, { recursive: true, force: true });
      return candidate.id;
    } catch { continue; }
  }
  return "";
}

async function reconcileAllPendingAppleCertificates(ses, teamId, certificates) {
  const base = appleCertificateDirectory(teamId);
  if (!fs.existsSync(base)) return;
  const pendingDirectories = fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith("pending-")).map(entry => path.join(base, entry.name));
  for (const pendingDirectory of pendingDirectories) await reconcilePendingAppleCertificate(ses, teamId, pendingDirectory, certificates);
}

ipcMain.handle("apple-developer-certificates", async () => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
  const ses = session.fromPartition(appleDeveloperPartition());
    const body = await fetchAppleCertificateListData(ses, team.id);
    const certificates = normalizeAppleCertificates(body);
    await reconcileAllPendingAppleCertificates(ses, team.id, certificates);
    const fallbackPassword = appleDeveloperP12Password || DEFAULT_P12_PASSWORD;
    const certificatesWithPasswords = certificates.map(item => ({
      ...item,
      p12Password: readAppleCertificateP12Password(team.id, item.id, fallbackPassword),
    }));
    return { success: true, certificates: certificatesWithPasswords, total: Number(body?.meta?.paging?.total || certificates.length) };
  } catch (error) { return { success: false, error: error.message || "证书列表读取失败" }; }
});

const APPLE_PROFILE_TYPES = [
  { id: "IOS_APP_DEVELOPMENT", group: "development", name: "iOS App 开发", description: "创建用于在 iOS、iPadOS、watchOS 和 visionOS 测试设备上安装开发版 App 的描述文件。", needsDevices: true, certificateTypeIds: ["83Q87W3TGH", "5QPB9NHCEI"] },
  { id: "TVOS_APP_DEVELOPMENT", group: "development", name: "tvOS App 开发", description: "创建用于在 tvOS 测试设备上安装开发版 App 的描述文件。", needsDevices: true, certificateTypeIds: ["83Q87W3TGH", "5QPB9NHCEI"] },
  { id: "MAC_APP_DEVELOPMENT", group: "development", name: "macOS App 开发", description: "创建用于在测试设备上安装 macOS 开发版 App 的描述文件。", needsDevices: true, certificateTypeIds: ["83Q87W3TGH", "749Y1QAGU7"] },
  { id: "DRIVERKIT_APP_DEVELOPMENT", group: "development", name: "DriverKit App 开发", description: "创建用于在 iOS、iPadOS 和 macOS 测试设备上安装 DriverKit 开发扩展的描述文件。", needsDevices: true, certificateTypeIds: ["83Q87W3TGH"] },
  { id: "IOS_APP_ADHOC", group: "distribution", name: "Ad Hoc", description: "创建用于在有限数量的已注册设备上安装 App 的分发描述文件。", needsDevices: true, certificateTypeIds: ["WXV89964HE", "R58UK2EWSO"] },
  { id: "TVOS_APP_ADHOC", group: "distribution", name: "tvOS Ad Hoc", description: "创建用于在有限数量的已注册 tvOS 设备上安装 App 的分发描述文件。", needsDevices: true, certificateTypeIds: ["WXV89964HE", "R58UK2EWSO"] },
  { id: "IOS_APP_STORE", group: "distribution", name: "App Store Connect", description: "创建用于将 App 提交到 App Store Connect 的分发描述文件。", needsDevices: false, certificateTypeIds: ["WXV89964HE", "R58UK2EWSO"] },
  { id: "TVOS_APP_STORE", group: "distribution", name: "tvOS App Store Connect", description: "创建用于将 tvOS App 提交到 App Store Connect 的分发描述文件。", needsDevices: false, certificateTypeIds: ["WXV89964HE", "R58UK2EWSO"] },
  { id: "MAC_APP_STORE", group: "distribution", name: "Mac App Store Connect", description: "创建用于将 App 提交到 Mac App Store Connect 的分发描述文件。", needsDevices: false, certificateTypeIds: ["HXZEUKP0FP"] },
  { id: "MAC_APP_DIRECT", group: "distribution", name: "Developer ID", description: "创建 Developer ID 描述文件，让使用 Developer ID 签名的应用能够使用 Apple 服务。", needsDevices: false, certificateTypeIds: ["W0EURJRMC5"] },
];

async function appleProfileContext() {
  const status = await readAppleDeveloperStatus();
  if (!status.authenticated) throw new Error("Apple 登录已过期，请重新登录");
  const teamResult = await fetchAppleDeveloperTeams();
  if (!teamResult.success) throw new Error(teamResult.error || "Apple 团队读取失败");
  const team = readSelectedAppleDeveloperTeam();
  if (!team) throw new Error("请先选择 Apple Developer 团队");
  return { ses: session.fromPartition(appleDeveloperPartition()), team };
}

async function appleProfileJSON(ses, url, teamId, query = "") {
  const response = await ses.fetch(url, { method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "GET", Referer: "https://developer.apple.com/account/resources/profiles/add" }, body: JSON.stringify({ teamId, ...(query ? { urlEncodedQueryParams: query } : {}) }) });
  const text = await response.text(); let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(appleDeveloperServiceError(body, text) || `Apple 描述文件接口失败 (${response.status})`);
  return { body, csrf: response.headers.get("csrf") || "", csrfTimestamp: response.headers.get("csrf_ts") || "" };
}

function bundleIdentifierFromMobileprovision(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content || "");
  const match = text.match(/<key>(?:com\.apple\.)?application-identifier<\/key>\s*<string>([^<]+)<\/string>/i);
  if (!match) return "";
  const applicationIdentifier = match[1]
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const separator = applicationIdentifier.indexOf(".");
  return separator >= 0 ? applicationIdentifier.slice(separator + 1) : applicationIdentifier;
}

function relationshipIds(relationship) {
  const data = relationship?.data;
  if (Array.isArray(data)) return data.map(item => String(item?.id || "")).filter(Boolean);
  const id = String(data?.id || "");
  return id ? [id] : [];
}

function normalizedAppleProfileTypeId(profile = {}) {
  const value = String(profile.profileType || profile.type || "").trim();
  const upper = value.toUpperCase().replace(/\s+/g, "_");
  if (upper.includes("APP_STORE")) return "IOS_APP_STORE";
  if (upper.includes("ADHOC") || upper.includes("AD_HOC")) return "IOS_APP_ADHOC";
  if (upper.includes("DEVELOPMENT")) return "IOS_APP_DEVELOPMENT";
  return upper || value;
}

async function downloadAppleProfileContent(ses, teamId, profileId, referer = "https://developer.apple.com/account/resources/profiles/list") {
  const url = `https://developer.apple.com/services-account/QH65B2/account/ios/profile/downloadProfileContent?${new URLSearchParams({ teamId, provisioningProfileId: profileId })}`;
  const response = await ses.fetch(url, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/octet-stream", Referer: referer },
  });
  if (!response.ok) throw new Error(`Apple 描述文件下载失败 (${response.status})`);
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length) throw new Error("Apple 返回了空的描述文件");
  return content;
}

async function enrichAppleProfileBundle(ses, team, profile) {
  const needsDetail = !profile.bundleIdentifier || !profile.bundleId || !profile.profileType || profile.profileType === "—" || !Array.isArray(profile.certificateIds) || !profile.certificateIds.length;
  if (!needsDetail) return profile;
  try {
    const detailResult = await appleProfileJSON(
      ses,
      `https://developer.apple.com/services-account/v1/profiles/${encodeURIComponent(profile.id)}`,
      team.id,
      "include=bundleId,certificates,devices&fields[bundleIds]=name,identifier",
    );
    const detail = detailResult.body?.data || {};
    const bundleResourceId = String(detail.relationships?.bundleId?.data?.id || "");
    const included = Array.isArray(detailResult.body?.included) ? detailResult.body.included : [];
    const bundle = included.find(item => item?.type === "bundleIds" && (!bundleResourceId || String(item.id) === bundleResourceId));
    profile.bundleId = profile.bundleId || bundleResourceId;
    profile.bundleIdentifier = String(
      detail.attributes?.bundleIdentifier || detail.attributes?.appIdentifier
      || bundle?.attributes?.identifier || profile.bundleIdentifier || "",
    );
    profile.bundleName = String(detail.attributes?.bundleName || bundle?.attributes?.name || profile.bundleName || "");
    profile.profileType = String(detail.attributes?.profileType || profile.profileType || "");
    profile.certificateIds = profile.certificateIds?.length ? profile.certificateIds : relationshipIds(detail.relationships?.certificates);
    profile.deviceIds = profile.deviceIds?.length ? profile.deviceIds : relationshipIds(detail.relationships?.devices);
  } catch (error) {
    console.warn(`profile detail bundle lookup failed (${profile.id}):`, error.message);
  }
  if (profile.bundleIdentifier) return profile;
  try {
    profile.bundleIdentifier = bundleIdentifierFromMobileprovision(await downloadAppleProfileContent(ses, team.id, profile.id, `https://developer.apple.com/account/resources/profiles/edit/${encodeURIComponent(profile.id)}`));
  } catch (error) {
    console.warn(`profile content bundle lookup failed (${profile.id}):`, error.message);
  }
  return profile;
}

function profileRecoveryDefaultCertificateTypeId(profileType = "") {
  const normalized = String(profileType || "").trim().toUpperCase();
  const macDefaults = {
    MAC_APP_DEVELOPMENT: "749Y1QAGU7",
    MAC_APP_STORE: "HXZEUKP0FP",
    MAC_APP_DIRECT: "W0EURJRMC5",
  };
  if (macDefaults[normalized]) return macDefaults[normalized];
  const type = APPLE_PROFILE_TYPES.find(item => item.id === normalized);
  return String(type?.certificateTypeIds?.[0] || "");
}

function isAppleCertificateUsableForProfileRecovery(certificate = {}) {
  const state = String(certificate.status || certificate.state || "").trim().toUpperCase();
  if (["REVOKED", "EXPIRED", "INVALID", "DISABLED"].includes(state)) return false;
  const expiration = new Date(certificate.expirationDate || "");
  return Number.isNaN(expiration.getTime()) || expiration.getTime() > Date.now();
}

function profileNeedsCertificateRecovery(profile = {}) {
  const state = String(profile.state || "").trim().toUpperCase();
  if (["REVOKED", "EXPIRED", "INVALID", "DISABLED", "INACTIVE"].includes(state)) return true;
  const expiration = new Date(profile.expirationDate || "");
  return !Number.isNaN(expiration.getTime()) && expiration.getTime() <= Date.now();
}

async function readAppleProfileRecoveryPlan(profileId = "") {
  const id = String(profileId || "").trim();
  if (!/^[A-Za-z0-9-]+$/.test(id)) return { success: false, error: "描述文件 ID 无效" };
  const { ses, team } = await appleProfileContext();
  const detailResult = await appleProfileJSON(
    ses,
    `https://developer.apple.com/services-account/v1/profiles/${encodeURIComponent(id)}`,
    team.id,
    "include=bundleId,certificates,devices&fields[bundleIds]=name,identifier",
  );
  const detail = detailResult.body?.data || {};
  if (String(detail.id || "") !== id) return { success: false, error: "Apple 未返回该描述文件的详细资料" };
  const attributes = detail.attributes || {};
  const included = Array.isArray(detailResult.body?.included) ? detailResult.body.included : [];
  const bundleId = String(detail.relationships?.bundleId?.data?.id || detail.relationships?.bundleIds?.data?.id || attributes.bundleIdId || attributes.appIdId || "");
  const bundle = included.find(item => item?.type === "bundleIds" && (!bundleId || String(item.id || "") === bundleId));
  const profile = {
    id,
    name: String(attributes.name || "未命名描述文件"),
    state: String(attributes.profileState || attributes.state || ""),
    profileType: String(attributes.profileType || ""),
    expirationDate: String(attributes.expirationDate || attributes.expiryDate || ""),
    bundleId,
    bundleIdentifier: String(attributes.bundleIdentifier || attributes.appIdentifier || bundle?.attributes?.identifier || ""),
    bundleName: String(attributes.bundleName || bundle?.attributes?.name || ""),
    certificateIds: relationshipIds(detail.relationships?.certificates),
    deviceIds: relationshipIds(detail.relationships?.devices),
  };
  if (!profileNeedsCertificateRecovery(profile)) return { success: false, error: "当前描述文件仍然有效，无需恢复" };
  const profileType = APPLE_PROFILE_TYPES.find(item => item.id === profile.profileType);
  if (!profileType) return { success: false, error: `暂不支持恢复 ${profile.profileType || "当前类型"} 描述文件` };
  if (!profile.bundleId || !profile.bundleIdentifier) return { success: false, error: "无法读取原描述文件的 Bundle ID，不能安全恢复" };
  if (profileType.needsDevices && !profile.deviceIds.length) return { success: false, error: "原测试描述文件没有可恢复的设备，不能自动重新配置" };
  if (profileType.needsDevices) {
    const devicesResult = await appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/devices", team.id, "limit=1000&offset=0&filter[status]=ENABLED");
    const enabledIds = new Set((devicesResult.body?.data || []).map(item => String(item?.id || "")).filter(Boolean));
    const unavailable = profile.deviceIds.filter(deviceId => !enabledIds.has(String(deviceId)));
    if (unavailable.length) return { success: false, error: `原描述文件有 ${unavailable.length} 台设备已停用或被删除，请先在设备管理中处理后再恢复` };
  }
  const certificateBody = await fetchAppleCertificateListData(ses, team.id);
  const certificates = normalizeAppleCertificates(certificateBody);
  const includedCertificates = new Map(included.filter(item => item?.type === "certificates").map(item => [String(item.id || ""), item]));
  const originalCertificate = certificates.find(item => profile.certificateIds.includes(String(item.id || "")));
  const originalIncluded = originalCertificate ? null : includedCertificates.get(String(profile.certificateIds[0] || ""));
  const originalTypeId = String(
    originalCertificate?.typeId
    || originalIncluded?.attributes?.certificateTypeId
    || originalIncluded?.attributes?.certificateTypeDisplayId
    || profileRecoveryDefaultCertificateTypeId(profile.profileType)
    || "",
  );
  if (!profileType.certificateTypeIds.includes(originalTypeId)) {
    return { success: false, error: "无法确认原描述文件的兼容证书类型，不能自动恢复" };
  }
  const synced = await listSyncedAppleDeveloperArtifacts(team.id);
  if (!synced.success) return { success: false, error: synced.error || "服务器证书资料读取失败" };
  const readiness = serverCertificateArtifactReadiness(synced.artifacts);
  const sameTypeCertificates = certificates.filter(item => String(item.typeId || "") === originalTypeId && isAppleCertificateUsableForProfileRecovery(item));
  const reusable = sameTypeCertificates.find(item => {
    const server = readiness.find(row => String(row.certificateId || "") === String(item.id || ""));
    const localPrivateKey = fs.existsSync(path.join(appleCertificateDirectory(team.id, item.id), "private-key.pem"));
    return localPrivateKey || server?.hasP12 === true || server?.hasPrivateKey === true;
  });
  const certificateType = APPLE_CERTIFICATE_TYPES.find(item => item.id === originalTypeId) || {};
  if (reusable) {
    const server = readiness.find(row => String(row.certificateId || "") === String(reusable.id || ""));
    return {
      success: true,
      plan: {
        action: "reuse",
        certificate: { id: String(reusable.id || ""), typeId: originalTypeId, name: String(reusable.name || certificateType.name || "证书") },
        reuseNeedsSync: server?.hasP12 !== true,
        originalCertificateTypeId: originalTypeId,
        certificateTypeName: String(certificateType.name || originalTypeId),
        profile,
      },
    };
  }
  return {
    success: true,
    plan: {
      action: "create",
      certificate: null,
      reuseNeedsSync: false,
      originalCertificateTypeId: originalTypeId,
      certificateTypeId: originalTypeId,
      certificateTypeName: String(certificateType.name || originalTypeId),
      profile,
    },
  };
}

async function syncAppleDeveloperProfileArtifact(ses, team, profile) {
  if (!profile?.id) return { success: false, skipped: true, error: "描述文件 ID 无效" };
  await enrichAppleProfileBundle(ses, team, profile);
  const content = await downloadAppleProfileContent(ses, team.id, profile.id);
  const bundleIdentifier = String(profile.bundleIdentifier || bundleIdentifierFromMobileprovision(content) || "");
  return syncAppleDeveloperArtifact({
    teamId: team.id,
    artifactType: "profile",
    artifactKey: String(profile.id),
    filename: `${String(profile.name || profile.id).replace(/[^A-Za-z0-9._-]/g, "_")}.mobileprovision`,
    content,
    metadata: {
      profileType: normalizedAppleProfileTypeId(profile),
      name: profile.name,
      bundleId: String(profile.bundleId || ""),
      bundleIdentifier,
      bundleName: String(profile.bundleName || profile.name || bundleIdentifier),
      certificateIds: Array.isArray(profile.certificateIds) ? profile.certificateIds.map(String).filter(Boolean) : [],
      deviceIds: Array.isArray(profile.deviceIds) ? profile.deviceIds.map(String).filter(Boolean) : [],
      expirationDate: String(profile.expirationDate || ""),
    },
  });
}

ipcMain.handle("apple-developer-profiles", async () => {
  try {
    const { ses, team } = await appleProfileContext();
    const profileResult = await appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/profiles", team.id, "limit=1000&sort=name");
    const body = profileResult.body;
    const profiles = (Array.isArray(body?.data) ? body.data : []).map(row => {
      const attributes = row.attributes || {};
      const bundleResourceId = String(
        row.relationships?.bundleId?.data?.id
        || row.relationships?.bundleIds?.data?.id
        || attributes.bundleIdId
        || attributes.appIdId
        || "",
      );
      const certificateIds = relationshipIds(row.relationships?.certificates);
      const deviceIds = relationshipIds(row.relationships?.devices);
      return {
        id: String(row.id || ""),
        name: String(attributes.name || "未命名"),
        platform: String(attributes.platform || "—"),
        type: String(attributes.profileTypeLabel || attributes.profileType || "—"),
        profileType: String(attributes.profileType || ""),
        state: String(attributes.profileState || "—"),
        expirationDate: String(attributes.expirationDate || attributes.expiryDate || "—"),
        bundleId: bundleResourceId,
        bundleIdentifier: String(attributes.bundleIdentifier || attributes.appIdentifier || ""),
        bundleName: String(attributes.bundleName || ""),
        certificateIds,
        deviceIds,
      };
    }).filter(item => item.id);
    return { success: true, profiles, total: Number(body?.meta?.paging?.total || profiles.length), sync: [], bundleLookupDeferred: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-profile-bundle", async (_event, payload = {}) => {
  try {
    const { ses, team } = await appleProfileContext();
    const profile = {
      id: String(payload.id || "").trim(),
      name: String(payload.name || ""),
      bundleId: String(payload.bundleId || ""),
      bundleIdentifier: String(payload.bundleIdentifier || ""),
      bundleName: String(payload.bundleName || ""),
      profileType: String(payload.profileType || ""),
      certificateIds: Array.isArray(payload.certificateIds) ? payload.certificateIds.map(String).filter(Boolean) : [],
      deviceIds: Array.isArray(payload.deviceIds) ? payload.deviceIds.map(String).filter(Boolean) : [],
    };
    if (!/^[A-Za-z0-9-]+$/.test(profile.id)) return { success: false, error: "描述文件 ID 无效" };
    await enrichAppleProfileBundle(ses, team, profile);
    return {
      success: true,
      profile: {
        id: profile.id,
        bundleId: String(profile.bundleId || ""),
        bundleIdentifier: String(profile.bundleIdentifier || ""),
        bundleName: String(profile.bundleName || ""),
        profileType: String(profile.profileType || ""),
        certificateIds: Array.isArray(profile.certificateIds) ? profile.certificateIds : [],
        deviceIds: Array.isArray(profile.deviceIds) ? profile.deviceIds : [],
      },
    };
  } catch (error) { return { success: false, error: error.message || "描述文件包名读取失败" }; }
});

ipcMain.handle("apple-developer-profile-recovery-plan", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    return await readAppleProfileRecoveryPlan(typeof payload === "string" ? payload : payload?.profileId);
  } catch (error) {
    return { success: false, error: error.message || "描述文件恢复预检失败" };
  }
});

ipcMain.handle("apple-developer-sync-recovery-certificate", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const team = readSelectedAppleDeveloperTeam();
    const certificate = payload?.certificate || {};
    const certificateId = String(certificate.id || "").trim();
    const typeId = String(certificate.typeId || "").trim();
    if (!team?.id || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9]+$/.test(typeId)) {
      return { success: false, error: "恢复证书参数无效" };
    }
    const password = readAppleCertificateP12Password(team.id, certificateId, appleDeveloperP12Password || DEFAULT_P12_PASSWORD);
    const sync = await syncLocalAppleCertificateArtifacts({ team, certificate: { ...certificate, id: certificateId, typeId }, password });
    if (!sync.success) return { success: false, error: `复用证书同步失败：${sync.p12?.error || sync.privateKey?.error || sync.certificate?.error || sync.error || "未知错误"}` };
    return { success: true, sync };
  } catch (error) {
    return { success: false, error: error.message || "复用证书同步失败" };
  }
});

ipcMain.handle("apple-developer-finalize-profile-recovery", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const team = readSelectedAppleDeveloperTeam();
    const certificateId = String(payload?.certificate?.id || "").trim();
    const profileId = String(payload?.profile?.id || "").trim();
    if (!team?.id || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9-]+$/.test(profileId)) {
      return { success: false, error: "恢复后的证书或描述文件参数无效" };
    }
    const verification = await verifySyncedAppleDeveloperArtifactSet(team.id, [
      { artifactType: "certificate", artifactKey: certificateId },
      { artifactType: "p12", artifactKey: `${certificateId}-p12` },
      { artifactType: "profile", artifactKey: profileId },
    ]);
    if (!verification.success) return verification;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || "恢复资料服务器核对失败" };
  }
});

ipcMain.handle("apple-developer-profile-options", async () => {
  try {
    const { ses, team } = await appleProfileContext();
    const [bundleResult, certificateBody, deviceResult] = await Promise.all([
      appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/bundleIds?", team.id, "limit=1000&offset=0&filter[platform]=IOS,MACOS,UNIVERSAL"),
      fetchAppleCertificateListData(ses, team.id),
      appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/devices", team.id, "limit=1000&offset=0&filter[status]=ENABLED&filter[AND][deviceClass]=APPLE_WATCH,IPAD,IPHONE,IPOD,APPLE_VISION_PRO,APPLE_SILICON_MAC"),
    ]);
    const bundleIds = (bundleResult.body.data || []).map(row => ({ id: row.id, name: row.attributes?.name || row.attributes?.identifier, identifier: row.attributes?.identifier || "", seedId: row.attributes?.seedId || team.id }));
    const certificates = normalizeAppleCertificates(certificateBody).filter(item => !/revoked|expired/i.test(item.status));
    const devices = (deviceResult.body.data || []).map(row => ({ id: row.id, name: row.attributes?.name || "未命名设备", udid: row.attributes?.udid || "", type: row.attributes?.devicePlatformLabel || row.attributes?.deviceClass || "—" }));
    return { success: true, types: APPLE_PROFILE_TYPES, bundleIds, certificates, devices, team };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-create-profile", async (_event, payload = {}) => {
  try {
    const type = APPLE_PROFILE_TYPES.find(item => item.id === String(payload.profileType || ""));
    if (!type) return { success: false, error: "请选择有效的描述文件类型" };
    const name = String(payload.name || "").trim(), bundleId = String(payload.bundleId || "").trim();
    const bundleIdentifier = String(payload.bundleIdentifier || "").trim();
    const bundleName = String(payload.bundleName || "").trim();
    const certificateIds = [...new Set((payload.certificateIds || []).map(String).filter(Boolean))];
    const deviceIds = [...new Set((payload.deviceIds || []).map(String).filter(Boolean))];
    if (!name || !bundleId || !certificateIds.length) return { success: false, error: "名称、App ID 和签名证书不能为空" };
    if (type.needsDevices && !deviceIds.length) return { success: false, error: "该类型至少需要选择一台测试设备" };
    const { ses, team } = await appleProfileContext();
    const warmup = await appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/profiles", team.id, "limit=1000&sort=name");
    const relationships = { bundleId: { data: { type: "bundleIds", id: bundleId } }, certificates: { data: certificateIds.map(id => ({ type: "certificates", id })) } };
    if (type.needsDevices) relationships.devices = { data: deviceIds.map(id => ({ type: "devices", id })) };
    const response = await ses.fetch("https://developer.apple.com/services-account/v1/profiles", { method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(45000), headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", Referer: "https://developer.apple.com/account/resources/profiles/add", ...(warmup.csrf ? { csrf: warmup.csrf } : {}), ...(warmup.csrfTimestamp ? { csrf_ts: warmup.csrfTimestamp } : {}) }, body: JSON.stringify({ data: { type: "profiles", attributes: { name, profileType: type.id, teamId: team.id, ...(payload.offline ? { isOfflineProfile: true } : {}) }, relationships } }) });
    const text = await response.text(); let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!response.ok) return { success: false, error: appleDeveloperServiceError(body, text) || `描述文件创建失败 (${response.status})` };
    const profile = { id: body.data?.id, name: body.data?.attributes?.name || name, type: body.data?.attributes?.profileTypeLabel || type.name, expirationDate: body.data?.attributes?.expirationDate || "" };
    let profileSync = { success: false, skipped: true };
    if (profile.id) {
      try {
        const downloadURL = `https://developer.apple.com/services-account/QH65B2/account/ios/profile/downloadProfileContent?${new URLSearchParams({ teamId: team.id, provisioningProfileId: profile.id })}`;
        const downloadResponse = await ses.fetch(downloadURL, { method: "GET", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "application/octet-stream", Referer: "https://developer.apple.com/account/resources/profiles/list" } });
        if (!downloadResponse.ok) throw new Error(`Apple 描述文件下载失败 (${downloadResponse.status})`);
        const profileContent = Buffer.from(await downloadResponse.arrayBuffer());
        profileSync = await syncAppleDeveloperArtifact({ teamId: team.id, artifactType: "profile", artifactKey: String(profile.id), filename: `${String(profile.name || profile.id).replace(/[^A-Za-z0-9._-]/g, "_")}.mobileprovision`, content: profileContent, metadata: { profileType: type.id, name: profile.name, bundleId, bundleIdentifier, bundleName, certificateIds, deviceIds, expirationDate: profile.expirationDate } });
      } catch (syncError) { profileSync = { success: false, error: syncError.message || "描述文件同步失败" }; }
    }
    return { success: true, profile, sync: profileSync };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-download-profile", async (_event, payload = {}) => {
  try {
    const id = String(payload.id || "").trim(); if (!id) return { success: false, error: "描述文件 ID 无效" };
    const { ses, team } = await appleProfileContext();
    if (!/^[A-Za-z0-9-]+$/.test(id)) return { success: false, error: "描述文件 ID 无效" };
    const url = `https://developer.apple.com/services-account/QH65B2/account/ios/profile/downloadProfileContent?${new URLSearchParams({ teamId: team.id, provisioningProfileId: id })}`;
    const response = await ses.fetch(url, { method: "GET", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "application/octet-stream", Referer: "https://developer.apple.com/account/resources/profiles/list" } });
    if (!response.ok) return { success: false, error: `描述文件下载失败 (${response.status})` };
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.length) return { success: false, error: "Apple 返回了空的描述文件" };
    const filename = `${String(payload.name || id).replace(/[^A-Za-z0-9._-]/g, "_")}.mobileprovision`;
    const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, { defaultPath: filename, filters: [{ name: "Provisioning Profile", extensions: ["mobileprovision"] }] });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    fs.writeFileSync(save.filePath, content, { mode: 0o600 });
    return { success: true, path: save.filePath };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-delete-profile", async (_event, payload = {}) => {
  try {
    const id = String(payload.id || "").trim();
    if (!/^[A-Za-z0-9-]+$/.test(id)) return { success: false, error: "描述文件 ID 无效" };
    const { ses, team } = await appleProfileContext();
    const referer = `https://developer.apple.com/account/resources/profiles/edit/${encodeURIComponent(id)}`;
    const warmup = await appleProfileJSON(ses, "https://developer.apple.com/services-account/v1/profiles", team.id, "limit=1000&sort=name");
    if (!warmup.csrf || !warmup.csrfTimestamp) return { success: false, error: "Apple 删除描述文件接口未返回安全令牌" };
    const url = `https://developer.apple.com/services-account/v1/profiles/${encodeURIComponent(id)}`;
    const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/vnd.api+json", "X-Requested-With": "XMLHttpRequest", "X-HTTP-Method-Override": "DELETE", Referer: referer, Origin: "https://developer.apple.com", csrf: warmup.csrf, csrf_ts: warmup.csrfTimestamp };
    const requestBody = { teamId: team.id };
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, url, headers, requestBody);
    const response = socksResult || await ses.fetch(url, { method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers, body: JSON.stringify(requestBody) });
    const text = socksResult ? socksResult.text : await response.text();
    if (!(socksResult ? socksResult.ok : response.ok)) {
      let body = {}; try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
      return { success: false, error: appleDeveloperServiceError(body, text) || `描述文件删除失败 (${response.status})` };
    }
    await deleteSyncedAppleDeveloperArtifact({ teamId: team.id, artifactType: "profile", artifactKey: id });
    return { success: true };
  } catch (error) { return { success: false, error: error.message || "描述文件删除失败" }; }
});

ipcMain.handle("apple-developer-create-certificate", async (_event, payload = {}) => {
  try {
    const allowedTypes = new Set(APPLE_CERTIFICATE_TYPES.map(item => item.id));
    const typeId = String(payload.typeId || "").trim();
    const p12Password = String(payload.p12Password || "").trim();
    if (!allowedTypes.has(typeId)) return { success: false, error: "暂不支持该证书类型" };
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const teamResult = await fetchAppleDeveloperTeams();
    if (!teamResult.success) return teamResult;
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
  const ses = session.fromPartition(appleDeveloperPartition());
    const availability = (await fetchAppleCertificateTypeAvailability(ses, team.id)).find(item => item.id === typeId);
    if (!availability?.allowed) return { success: false, error: availability?.reason || "该证书类型当前不可创建" };
    const appIdId = String(payload.appIdId || "").trim();
    const requiresAppId = typeId === "JKG5JZ54H7" || typeId === "UPV3DW712I";
    if (requiresAppId && !/^[A-Za-z0-9-]+$/.test(appIdId)) return { success: false, error: "请选择推送证书关联的 App ID" };
    const generated = await ensureAppleSharedCSR(team.id);
    const pendingDirectory = path.join(appleCertificateDirectory(team.id), `pending-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(pendingDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(pendingDirectory, "private-key.pem"), generated.privateKey, { mode: 0o600 });
    fs.writeFileSync(path.join(pendingDirectory, "request.certSigningRequest"), generated.csr, { mode: 0o600 });
    const csrSyncKey = generated.syncKey;
    fs.writeFileSync(path.join(pendingDirectory, "metadata.json"), JSON.stringify({ teamId: team.id, typeId, appIdId: requiresAppId ? appIdId : "", csrSyncKey, p12Password, status: "pending-response" }), { mode: 0o600 });
    const csrSync = await syncAppleDeveloperArtifact({ teamId: team.id, artifactType: "csr", artifactKey: csrSyncKey, filename: `${team.id}-shared.certSigningRequest`, content: generated.csr, metadata: { scope: "account-team", status: "active" } });
    const privateKeySync = await syncAppleDeveloperArtifact({ teamId: team.id, artifactType: "private_key", artifactKey: csrSyncKey, filename: `${team.id}-shared-private-key.pem`, content: generated.privateKey, metadata: { scope: "account-team", csrSyncKey, status: "active" } });
    const referer = "https://developer.apple.com/account/resources/certificates/add";
    let certificateCreateBody = null;
    const warmups = [
      {
        kind: "certificateCreate",
        url: "https://developer.apple.com/account/resources/json/certificateCreate.json",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", Origin: "https://developer.apple.com", Referer: referer },
        body: new URLSearchParams({ teamId: team.id }).toString(),
      },
      {
        url: "https://developer.apple.com/services-account/checkPermissions",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: referer },
        body: new URLSearchParams({ permissions: "team.certificate.ios.development.access", teamId: team.id }).toString(),
      },
      {
        url: "https://developer.apple.com/services-account/v1/certificates",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json", "X-HTTP-Method-Override": "GET", Referer: referer },
        body: JSON.stringify({ urlEncodedQueryParams: "limit=1000&sort=displayName", teamId: team.id }),
      },
      {
        url: "https://developer.apple.com/services-account/checkPermissions",
        headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: referer },
        body: new URLSearchParams({ permissions: "team.certificate.ca.available", teamId: team.id }).toString(),
      },
    ];
    let csrf = "", csrfTimestamp = "";
    for (const warmup of warmups) {
      const response = await ses.fetch(warmup.url, { method: "POST", credentials: "include", headers: { ...warmup.headers, ...(csrf ? { csrf } : {}), ...(csrfTimestamp ? { csrf_ts: csrfTimestamp } : {}) }, body: warmup.body, redirect: "follow", signal: AbortSignal.timeout(30000) });
      csrf = response.headers.get("csrf") || csrf;
      csrfTimestamp = response.headers.get("csrf_ts") || csrfTimestamp;
      const text = await response.text();
      if (!response.ok) return { success: false, error: `Apple 证书接口初始化失败 (${response.status})：${text.slice(0, 300)}` };
      if (warmup.kind === "certificateCreate") {
        try { certificateCreateBody = text ? JSON.parse(text) : {}; } catch { certificateCreateBody = {}; }
      }
    }
    if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 证书接口初始化失败：未收到 CSRF 安全令牌" };
    const appleCreateType = findAppleCertificateCreateType(certificateCreateBody, typeId);
    if (!requiresAppId && !appleCreateType) return { success: false, error: "Apple 当前返回的可创建证书类型中没有该 Mac 证书，请刷新证书类型后重试" };
    const appleCreatePlatform = String(appleCreateType?.platform || "").toLowerCase();
    const pushCertificateTypes = {
      JKG5JZ54H7: "APPLE_SANDBOX_PUSH_SERVICES",
      UPV3DW712I: "APPLE_PUSH_SERVICES",
    };
    const createURL = requiresAppId
      ? "https://developer.apple.com/services-account/v1/certificates"
      : appleCertificateLegacyEndpoint(typeId, "submitCertificateRequest.action", appleCreatePlatform);
    const formBody = requiresAppId
      ? JSON.stringify({ data: { type: "certificates", attributes: { certificateType: pushCertificateTypes[typeId], teamId: team.id, csrContent: generated.csr, ownerId: appIdId } } })
      : new URLSearchParams({ csrContent: generated.csr, type: typeId, teamId: team.id }).toString();
    const headers = { Accept: "application/json, text/plain, */*", "Content-Type": requiresAppId ? "application/vnd.api+json" : "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Referer: referer, "User-Agent": appleDeveloperRequestUserAgent(), csrf, csrf_ts: csrfTimestamp };
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, createURL, headers, formBody);
    const response = socksResult || await ses.fetch(createURL, { method: "POST", credentials: "include", headers, body: formBody, redirect: "follow", signal: AbortSignal.timeout(45000) });
    const responseStatus = response.status;
    const text = socksResult ? socksResult.text : await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    if (!(socksResult ? socksResult.ok : response.ok) || Number(body?.resultCode || 0) !== 0) {
      fs.rmSync(pendingDirectory, { recursive: true, force: true });
      if (Number(body?.resultCode) === 7460) return { success: false, error: "该类型证书已达到 Apple 数量上限：当前已有有效证书或待处理申请。请先在 Apple Developer 中撤销不再使用的同类型证书。" };
      const serviceError = appleDeveloperServiceError(body, text);
      if (/Certificate type is not valid/i.test(serviceError || text) && !requiresAppId) {
        const certificateTypeName = APPLE_CERTIFICATE_TYPES.find(item => item.id === typeId)?.name || typeId;
        return { success: false, error: `Apple 返回证书类型无效。已按 ${appleCertificateLegacyPlatform(typeId).toUpperCase()} 证书接口提交 ${certificateTypeName}，请刷新证书类型或确认当前团队支持该证书。` };
      }
      return { success: false, error: serviceError || `证书创建失败 (${responseStatus})` };
    }
    const record = findAppleCertificateRecord(body) || {};
    const certificate = record?.certificate || record?.attributes || record;
    const certificateId = String(certificate.certificateId || record.certificateId || record.certRequestId || (record.type === "certificates" ? record.id : "") || "");
    const certificateName = String(certificate.displayName || certificate.name || record?.attributes?.displayName || record?.attributes?.name || APPLE_CERTIFICATE_TYPES.find(item => item.id === typeId)?.name || "");
    const normalizedCertificate = { ...certificate, id: certificateId, certificateId, typeId, name: certificateName || certificate.name || "" };
    if (!certificateId) {
      const listBody = await fetchAppleCertificateListData(ses, team.id, referer);
      const certificates = normalizeAppleCertificates(listBody);
      const matchedId = await reconcilePendingAppleCertificate(ses, team.id, pendingDirectory, certificates);
      if (matchedId) {
        const matched = certificates.find(item => item.id === matchedId) || {};
        let certificateSync = { success: false, skipped: true };
        try { certificateSync = await syncAppleDeveloperArtifact({ teamId: team.id, artifactType: "certificate", artifactKey: matchedId, filename: `${matchedId}.cer`, content: await fetchAppleCertificateContent(ses, team.id, matchedId, matched.typeId || typeId), metadata: { typeId: matched.typeId || typeId, csrSyncKey, name: matched.name || "" } }); } catch {}
        return { success: true, certificateId: matchedId, certificate: matched, sync: { csr: csrSync, privateKey: privateKeySync, certificate: certificateSync } };
      }
      return { success: false, error: "证书已提交，但 Apple 列表暂未返回它。请稍后点击“刷新”，软件将通过公钥自动绑定证书和私钥。" };
    }
    const directory = appleCertificateDirectory(team.id, certificateId);
    fs.renameSync(pendingDirectory, directory);
    let certificateContent = certificate.certificateContent ? Buffer.from(String(certificate.certificateContent), "base64") : null;
    if (!certificateContent?.length) certificateContent = await fetchAppleCertificateContent(ses, team.id, certificateId, typeId);
    fs.writeFileSync(path.join(directory, "certificate.cer"), certificateContent, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "metadata.json"), JSON.stringify({ teamId: team.id, certificateId, typeId, appIdId: requiresAppId ? appIdId : "", csrSyncKey, p12Password, certificate: normalizedCertificate }), { mode: 0o600 });
    const certificateSync = await syncAppleDeveloperArtifact({ teamId: team.id, artifactType: "certificate", artifactKey: certificateId, filename: `${certificateId}.cer`, content: certificateContent, metadata: { typeId, appIdId: requiresAppId ? appIdId : "", csrSyncKey, name: normalizedCertificate.name || "" } });
    return { success: true, certificateId, certificate: normalizedCertificate, sync: { csr: csrSync, privateKey: privateKeySync, certificate: certificateSync } };
  } catch (error) { return { success: false, error: error.message || "证书创建失败" }; }
});

ipcMain.handle("apple-developer-download-certificate", async (_event, payload = {}) => {
  try {
    const team = readSelectedAppleDeveloperTeam();
    const certificateId = String(payload.id || "").trim();
    const typeId = String(payload.typeId || "").trim();
    if (!team || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9]+$/.test(typeId)) return { success: false, error: "证书下载参数无效" };
    const directory = appleCertificateDirectory(team.id, certificateId);
    const localPath = path.join(directory, "certificate.cer");
    let data;
    if (fs.existsSync(localPath)) data = fs.readFileSync(localPath);
    else {
  const ses = session.fromPartition(appleDeveloperPartition());
      data = await fetchAppleCertificateContent(ses, team.id, certificateId, typeId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(localPath, data, { mode: 0o600 });
    }
    const result = await dialog.showSaveDialog(certificateManagerWindow || undefined, { defaultPath: String(payload.filename || "certificate.cer").replace(/[^A-Za-z0-9._-]/g, "_"), filters: [{ name: "Apple Certificate", extensions: ["cer"] }] });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    fs.writeFileSync(result.filePath, data);
    return { success: true, path: result.filePath };
  } catch (error) { return { success: false, error: error.message || "证书下载失败" }; }
});

ipcMain.handle("apple-developer-export-p12", async (_event, payload = {}) => {
  try {
    const team = readSelectedAppleDeveloperTeam();
    const certificateId = String(payload.id || "").trim();
    const typeId = String(payload.typeId || "").trim();
    const requestedPassword = String(payload.password || "").trim();
    if (!team || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9]+$/.test(typeId)) return { success: false, error: "P12 导出参数无效" };
    const password = requestedPassword || readAppleCertificateP12Password(team.id, certificateId, appleDeveloperP12Password);
    if (!password) return { success: false, error: "P12 导出密码不能为空" };
    const directory = appleCertificateDirectory(team.id, certificateId);
    const certificatePath = path.join(directory, "certificate.cer");
    const privateKeyPath = path.join(directory, "private-key.pem");
    if (!fs.existsSync(certificatePath)) {
  const ses = session.fromPartition(appleDeveloperPartition());
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(certificatePath, await fetchAppleCertificateContent(ses, team.id, certificateId, typeId), { mode: 0o600 });
    }
    if (!fs.existsSync(privateKeyPath)) {
      const restored = await restoreAppleCertificatePrivateKeyFromServer({ team, certificate: { ...payload, id: certificateId, typeId }, certificatePath, privateKeyPath });
      if (!restored.success) return restored;
    }
    const certificateData = fs.readFileSync(certificatePath);
    let certificate;
    try {
      const certificateAsn1 = forge.asn1.fromDer(forge.util.createBuffer(certificateData.toString("binary")));
      certificate = forge.pki.certificateFromAsn1(certificateAsn1);
    } catch {
      certificate = forge.pki.certificateFromPem(certificateData.toString("utf8"));
    }
    const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(privateKeyPath, "utf8"));
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, certificate, password, { algorithm: "3des", friendlyName: String(payload.name || "Apple Certificate") });
    const p12Data = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary");
    saveAppleCertificateP12Password(team.id, certificateId, password);
    await syncAppleDeveloperArtifact({
      teamId: team.id,
      artifactType: "p12",
      artifactKey: `${certificateId}-p12`,
      filename: `${String(payload.name || certificateId).replace(/[^A-Za-z0-9._-]/g, "_")}.p12`,
      content: p12Data,
      metadata: { certificateId, typeId, name: String(payload.name || ""), p12Password: password },
    }).catch(error => console.warn("p12 sync failed:", error.message));
    const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, { defaultPath: `${String(payload.name || certificateId).replace(/[^A-Za-z0-9._-]/g, "_")}.p12`, filters: [{ name: "PKCS#12", extensions: ["p12"] }] });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    fs.writeFileSync(save.filePath, p12Data);
    return { success: true, path: save.filePath };
  } catch (error) { return { success: false, error: error.message || "P12 导出失败" }; }
});

ipcMain.handle("apple-developer-sync-local-certificate-artifacts", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) throw new Error("请先从浏览器开发者账户列表启动证书管理");
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const certificates = (Array.isArray(payload.certificates) ? payload.certificates : [payload.certificate]).filter(Boolean);
    const validCertificates = certificates.filter(item => /^[A-Za-z0-9]+$/.test(String(item?.id || "")) && /^[A-Za-z0-9]+$/.test(String(item?.typeId || "")));
    if (!validCertificates.length) return { success: true, results: [] };
    const password = String(payload.password || appleDeveloperP12Password || DEFAULT_P12_PASSWORD);
    appleDeveloperP12Password = password;
    if (appleDeveloperOwnerKey && appleDeveloperRecordId) {
      withDeveloperAccountsDatabase(db => db.prepare("UPDATE developer_accounts SET p12_password=? WHERE owner_key=? AND id=?").run(password, appleDeveloperOwnerKey, appleDeveloperRecordId));
    }
    const usageSync = await syncAppleDeveloperAccountUsage();
    if (!usageSync.success && !usageSync.skipped) {
      throw new Error(usageSync.error || "开发者账户服务器绑定失败");
    }
    const passwordSync = await syncDeveloperAccountP12Password(appleDeveloperRecordId, password);
    const ses = session.fromPartition(appleDeveloperPartition());
    const results = [];
    for (const certificate of validCertificates) {
      const sync = await syncLocalAppleCertificateArtifacts({ team, certificate, password, ses });
      results.push({ id: String(certificate.id || ""), name: String(certificate.name || certificate.displayName || certificate.id || "证书"), sync });
    }
    const failed = results.find(item => !item.sync?.success);
    if (failed) {
      const detail = [failed.sync?.privateKey, failed.sync?.certificate, failed.sync?.p12, failed.sync].find(item => item && item.success === false && !item.skipped)
        || [failed.sync?.privateKey, failed.sync?.certificate, failed.sync?.p12, failed.sync].find(item => item && item.success === false);
      throw new Error(`${failed.name}服务器同步失败：${detail?.error || "未知错误"}`);
    }
    if (!passwordSync.success && !passwordSync.skipped) {
      throw new Error(passwordSync.error || "P12 密码同步失败");
    }
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message || "本地证书同步失败" };
  }
});

ipcMain.handle("apple-developer-finalize-automation-artifacts", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const certificates = (Array.isArray(payload.certificates) ? payload.certificates : []).filter(item => item?.id);
    const profiles = (Array.isArray(payload.profiles) ? payload.profiles : []).filter(item => item?.id);
    const keep = [
      ...certificates.flatMap(item => [
        { artifactType: "certificate", artifactKey: String(item.id) },
        { artifactType: "p12", artifactKey: `${String(item.id)}-p12` },
      ]),
      ...profiles.map(item => ({ artifactType: "profile", artifactKey: String(item.id) })),
    ];
    const certificateScopes = certificates.map(item => ({ typeId: String(item.typeId || ""), appIdId: String(item.appIdId || item.ownerId || "") })).filter(item => item.typeId);
    const profileScopes = profiles.map(item => ({ bundleIdentifier: String(item.bundleIdentifier || payload.bundleIdentifier || ""), profileType: String(item.profileType || item.type || "").toUpperCase() })).filter(item => item.bundleIdentifier && item.profileType);
    if (!keep.length || (!certificateScopes.length && !profileScopes.length)) return { success: false, error: "当前有效证书集合参数不完整" };
    const verification = await verifySyncedAppleDeveloperArtifactSet(team.id, keep);
    if (!verification.success) return verification;
    const pruned = await pruneSyncedAppleDeveloperArtifactSet(team.id, keep, certificateScopes, profileScopes);
    if (!pruned.success) return pruned;
    const finalVerification = await verifySyncedAppleDeveloperArtifactSet(team.id, keep);
    if (!finalVerification.success) return finalVerification;
    return { success: true, removed: Number(pruned.removed || 0), finalVerification };
  } catch (error) {
    return { success: false, error: error.message || "证书资料收尾失败" };
  }
});

ipcMain.handle("apple-developer-clear-server-certificate-artifacts", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    return await clearSyncedAppleDeveloperArtifacts({ teamId: team.id, scope: payload?.scope });
  } catch (error) {
    return { success: false, error: error.message || "服务器旧证书清理失败" };
  }
});

ipcMain.handle("apple-developer-server-certificate-package-options", async () => {
  try {
    if (!appleDeveloperRecordId) return { success: true, bundles: [] };
    const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/artifact-package-options`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.error || `服务器证书文件读取失败 (${response.status})`);
    return {
      success: true,
      bundles: Array.isArray(body.bundles) ? body.bundles : [],
      hasArtifacts: body.hasArtifacts === true,
      artifactCount: Number(body.artifactCount || 0),
      p12Password: String(body.p12Password || appleDeveloperP12Password || DEFAULT_P12_PASSWORD),
    };
  } catch (error) {
    return { success: false, error: error.message || "服务器证书文件读取失败" };
  }
});

ipcMain.handle("apple-developer-automation-certificate-readiness", async () => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const team = readSelectedAppleDeveloperTeam();
    if (!team?.id) return { success: false, teamRequired: true, error: "请先选择 Apple Developer 团队" };
    const listed = await listSyncedAppleDeveloperArtifacts(team.id);
    if (!listed.success) return { success: false, error: listed.error || "服务器证书文件读取失败" };
    return { success: true, certificateReadiness: serverCertificateArtifactReadiness(listed.artifacts) };
  } catch (error) {
    return { success: false, error: error.message || "服务器证书文件读取失败" };
  }
});

ipcMain.handle("apple-developer-download-server-certificate-package", async (_event, payload = {}) => {
  try {
    if (!appleDeveloperRecordId) return { success: false, error: "请先从浏览器开发者账户列表启动证书管理" };
    const bundleId = String(payload.bundleId || "").trim();
    if (!bundleId) return { success: false, error: "请选择要下载的 Bundle ID" };
    const p12Password = String(payload.p12Password || appleDeveloperP12Password || DEFAULT_P12_PASSWORD);
    const response = await authServerFetch(`/api/developer-sync/accounts/${encodeURIComponent(appleDeveloperRecordId)}/artifact-package`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/zip, application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId, selectedBundleId: bundleId, mode: "all", p12Password, pushPassword: p12Password }),
      signal: AbortSignal.timeout(30000),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
      throw new Error(body.error || `证书文件下载失败 (${response.status})`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) throw new Error("服务器返回了空的证书包");
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || "";
    const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "";
    let responseName = encodedName ? decodeURIComponent(encodedName) : plainName;
    responseName = path.basename(responseName || `${bundleId}_证书描述文件.zip`).replace(/[\\/:*?"<>|]/g, "_");
    if (!responseName.toLowerCase().endsWith(".zip")) responseName += ".zip";
    const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, {
      defaultPath: responseName,
      filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
    });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    fs.writeFileSync(save.filePath, data, { mode: 0o600 });
    return { success: true, path: save.filePath };
  } catch (error) {
    return { success: false, error: error.message || "证书文件下载失败" };
  }
});

ipcMain.handle("apple-developer-download-automation-zip", async (_event, payload = {}) => {
  let tempRoot = "";
  try {
    const team = readSelectedAppleDeveloperTeam();
    const certificates = (Array.isArray(payload.certificates) && payload.certificates.length ? payload.certificates : [payload.certificate]).filter(Boolean);
    const password = String(payload.password || "");
    const pushPassword = String(payload.pushPassword || payload.apnsPassword || password);
    const includePush = payload.includePush === true;
    const profiles = (Array.isArray(payload.profiles) && payload.profiles.length ? payload.profiles : [payload.development, payload.adhoc, payload.store]).filter(Boolean);
    if (!team || !certificates.length || certificates.some(item => !/^[A-Za-z0-9]+$/.test(String(item.id || "")) || !/^[A-Za-z0-9]+$/.test(String(item.typeId || ""))) || !password) return { success: false, error: "ZIP 文件包参数无效" };
    if (!profiles.length || profiles.some(item => !/^[A-Za-z0-9-]+$/.test(String(item.id || "")))) return { success: false, error: "描述文件参数无效" };
    const safeName = value => String(value || "file").replace(/[^A-Za-z0-9._-]/g, "_");
    const packageName = safeName(payload.packageName || "Apple_Distribution_Files");
    const bundleIdentifier = String(payload.bundleIdentifier || "未提供");
    const bundleFolderName = safeBundleFolderName(bundleIdentifier);
    const save = await dialog.showSaveDialog(certificateManagerWindow || undefined, { defaultPath: `${packageName}.zip`, filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }] });
    if (save.canceled || !save.filePath) return { success: false, canceled: true };
    tempRoot = fs.mkdtempSync(path.join(app.getPath("temp"), "ipauploader-automation-"));
    const folder = path.join(tempRoot, packageName);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const testFolder = path.join(folder, "开发");
    const formalFolder = path.join(folder, "发布");
    const testBundleFolder = path.join(testFolder, bundleFolderName);
    const formalBundleFolder = path.join(formalFolder, bundleFolderName);
    fs.mkdirSync(testFolder, { recursive: true, mode: 0o700 });
    fs.mkdirSync(formalFolder, { recursive: true, mode: 0o700 });
    fs.mkdirSync(testBundleFolder, { recursive: true, mode: 0o700 });
    fs.mkdirSync(formalBundleFolder, { recursive: true, mode: 0o700 });
    let wrotePushP12 = false;
    for (const item of certificates) {
      const certificateId = String(item.id); const typeId = String(item.typeId);
      const certificateDirectory = appleCertificateDirectory(team.id, certificateId);
      const certificatePath = path.join(certificateDirectory, "certificate.cer");
      const privateKeyPath = path.join(certificateDirectory, "private-key.pem");
      if (!fs.existsSync(certificatePath)) {
        const ses = session.fromPartition(appleDeveloperPartition());
        fs.mkdirSync(certificateDirectory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(certificatePath, await fetchAppleCertificateContent(ses, team.id, certificateId, typeId), { mode: 0o600 });
      }
      if (!fs.existsSync(privateKeyPath)) {
        const restored = await restoreAppleCertificatePrivateKeyFromServer({ team, certificate: item, certificatePath, privateKeyPath });
        if (!restored.success) throw new Error(restored.error || `${item.name || "证书"}的私钥不存在，无法生成 P12`);
      }
      const certificateData = fs.readFileSync(certificatePath);
      let parsedCertificate;
      try { parsedCertificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(certificateData.toString("binary")))); }
      catch { parsedCertificate = forge.pki.certificateFromPem(certificateData.toString("utf8")); }
      const privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(privateKeyPath, "utf8"));
      const isDevelopment = ["83Q87W3TGH", "5QPB9NHCEI"].includes(typeId) || /development|开发|测试/i.test(String(item.name || ""));
      const isPush = ["JKG5JZ54H7", "UPV3DW712I", "BKLRAVXMGM"].includes(typeId) || /APNs|Push|推送/i.test(String(item.name || item.typeName || ""));
      const friendlyName = isDevelopment ? "开发证书" : isPush ? "推送证书" : "正式证书";
      const exportPassword = isPush ? pushPassword : password;
      const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, parsedCertificate, exportPassword, { algorithm: "3des", friendlyName });
      const p12Buffer = Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), "binary");
      if (isPush) {
        fs.writeFileSync(path.join(testBundleFolder, "开发推送证书.p12"), p12Buffer, { mode: 0o600 });
        fs.writeFileSync(path.join(formalBundleFolder, "发布推送证书.p12"), p12Buffer, { mode: 0o600 });
        wrotePushP12 = true;
      } else {
        fs.writeFileSync(path.join(isDevelopment ? testFolder : formalFolder, `${friendlyName}.p12`), p12Buffer, { mode: 0o600 });
      }
    }
    if (includePush && !wrotePushP12) throw new Error("已勾选推送证书，但本次文件包没有生成推送 P12，请重新创建该包名推送证书后再下载");
    const { ses } = await appleProfileContext();
    for (const profile of profiles) {
      const url = `https://developer.apple.com/services-account/QH65B2/account/ios/profile/downloadProfileContent?${new URLSearchParams({ teamId: team.id, provisioningProfileId: String(profile.id) })}`;
      const response = await ses.fetch(url, { method: "GET", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "application/octet-stream", Referer: "https://developer.apple.com/account/resources/profiles/list" } });
      if (!response.ok) throw new Error(`${profile.name || "描述文件"}下载失败 (${response.status})`);
      const content = Buffer.from(await response.arrayBuffer());
      if (!content.length) throw new Error(`${profile.name || "描述文件"}内容为空`);
      const profileName = String(profile.name || "");
      const isDevelopment = /development|开发|测试/i.test(profileName);
      const isAdHoc = /ad.?hoc|aoc/i.test(profileName);
      const fileName = isDevelopment ? "dev描述.mobileprovision" : isAdHoc ? "aoc描述.mobileprovision" : "appstore描述.mobileprovision";
      fs.writeFileSync(path.join(isDevelopment ? testBundleFolder : formalBundleFolder, fileName), content, { mode: 0o600 });
    }
    const instruction = kind => [`文件类型：${kind}`, `包名：${bundleIdentifier}`, `证书 P12 密码：${password}`, `推送 P12 密码：${pushPassword}`, `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`, ""].join("\n");
    fs.writeFileSync(path.join(testBundleFolder, "txt.txt"), instruction("开发测试文件"), "utf8");
    fs.writeFileSync(path.join(formalBundleFolder, "txt.txt"), instruction("发布正式文件"), "utf8");
    fs.writeFileSync(save.filePath, createZipFromDirectory(folder));
    return { success: true, path: save.filePath };
  } catch (error) {
    return { success: false, error: error.message || "ZIP 文件包生成失败" };
  } finally {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

ipcMain.handle("apple-developer-revoke-certificate", async (_event, payload = {}) => {
  try {
    const status = await readAppleDeveloperStatus();
    if (!status.authenticated) return { success: false, authenticated: false, error: "Apple 登录已过期，请重新登录" };
    const team = readSelectedAppleDeveloperTeam();
    const certificateId = String(payload.id || "").trim();
    const typeId = String(payload.typeId || "").trim();
    if (!team || !/^[A-Za-z0-9]+$/.test(certificateId) || !/^[A-Za-z0-9]+$/.test(typeId)) return { success: false, error: "证书撤销参数无效" };
    const ses = session.fromPartition(appleDeveloperPartition());
    const isMacCertificate = APPLE_CERTIFICATE_TYPES.some(item =>
      item.id === typeId && String(item.platform || "").toLowerCase() === "macos",
    );
    if (isMacCertificate) {
      // macOS certificate types are revoked by Apple's REST endpoint.  The legacy
      // iOS endpoint rejects their `type` value with "Certificate type is not valid".
      const revokeURL = `https://developer.apple.com/services-account/v1/certificates/${encodeURIComponent(certificateId)}`;
      const requestBody = { teamId: team.id };
      const certificateFields = "certificateTypeId,certificateTypeName,displayName,platform,expirationDate,requesterFirstName,requesterLastName,requesterEmail,status,activated,ownerId,askKey,askKey2,autoCertRotationDate,isManaged,businessAccountIdentifier,~permissions.download,~permissions.revoke,~permissions.approve,~permissions.rotate,autoRotationEnabled,groupId";
      const detailURL = `${revokeURL}?fields[certificates]=${certificateFields}`;
      const detailHeaders = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/vnd.api+json",
        "X-HTTP-Method-Override": "GET",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://developer.apple.com/account/resources/certificates/download/${encodeURIComponent(certificateId)}`,
        Origin: "https://developer.apple.com",
        "User-Agent": appleDeveloperRequestUserAgent(),
      };
      const headers = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/vnd.api+json",
        "X-HTTP-Method-Override": "DELETE",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://developer.apple.com/account/resources/certificates/download/${encodeURIComponent(certificateId)}`,
        "User-Agent": appleDeveloperRequestUserAgent(),
      };
      const warmCertificateRevokeSession = async () => {
        const detailResponse = await ses.fetch(detailURL, {
          method: "POST", credentials: "include", headers: detailHeaders, body: JSON.stringify(requestBody), redirect: "follow", signal: AbortSignal.timeout(30000),
        });
        const detailText = await detailResponse.text();
        return {
          ok: detailResponse.ok,
          status: detailResponse.status,
          text: detailText,
          csrf: String(detailResponse.headers.get("csrf") || ""),
          csrfTimestamp: String(detailResponse.headers.get("csrf_ts") || ""),
        };
      };
      // Keep this destructive request in the authenticated Electron session,
      // and reproduce Apple's own "read certificate, then revoke" sequence.
      // Apple can reject a pooled or differently-routed state-changing request
      // with HTTP 421.
      await ses.closeAllConnections();
      let warmup = await warmCertificateRevokeSession();
      if (!warmup.ok) {
        return { success: false, error: `Apple Mac 证书撤销初始化失败 (${warmup.status})：${appleDeveloperServiceError({}, warmup.text) || "未知错误"}` };
      }
      if (!warmup.csrf || !warmup.csrfTimestamp) {
        return { success: false, error: "Apple Mac 证书撤销初始化未返回 CSRF 安全令牌，请刷新证书列表后重试" };
      }
      const revokeRequestOptions = sessionWarmup => ({
        method: "POST",
        credentials: "include",
        headers: { ...headers, csrf: sessionWarmup.csrf, csrf_ts: sessionWarmup.csrfTimestamp },
        body: JSON.stringify(requestBody),
        redirect: "follow",
        signal: AbortSignal.timeout(45000),
      });
      let response = await ses.fetch(revokeURL, revokeRequestOptions(warmup));
      if (response.status === 421) {
        await response.text();
        await ses.closeAllConnections();
        warmup = await warmCertificateRevokeSession();
        if (!warmup.ok) {
          return { success: false, error: `Apple Mac 证书撤销初始化失败 (${warmup.status})：${appleDeveloperServiceError({}, warmup.text) || "未知错误"}` };
        }
        if (!warmup.csrf || !warmup.csrfTimestamp) {
          return { success: false, error: "Apple Mac 证书撤销初始化未返回 CSRF 安全令牌，请刷新证书列表后重试" };
        }
        response = await ses.fetch(revokeURL, revokeRequestOptions(warmup));
      }
      const responseStatus = response.status;
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
      logAppleDeveloperDiagnostic("mac-certificate-revoke", {
        status: responseStatus,
        success: response.ok,
        transport: "electron-session",
        warmupStatus: warmup.status,
        csrfReady: Boolean(warmup.csrf && warmup.csrfTimestamp),
      });
      if (!response.ok) {
        return { success: false, error: `Apple Mac 证书撤销失败 (${responseStatus})：${appleDeveloperServiceError(body, text) || "未知错误"}` };
      }
      await deleteSyncedAppleDeveloperArtifact({ teamId: team.id, artifactType: "certificate", artifactKey: certificateId });
      const localDirectory = appleCertificateDirectory(team.id, certificateId);
      if (fs.existsSync(localDirectory)) fs.rmSync(localDirectory, { recursive: true, force: true });
      return { success: true, id: certificateId };
    }
    const referer = `https://developer.apple.com/account/resources/certificates/${encodeURIComponent(certificateId)}`;
    const permissionResponse = await ses.fetch("https://developer.apple.com/services-account/checkPermissions", {
      method: "POST", credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
      headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Referer: referer },
      body: new URLSearchParams({ permissions: "team.certificate.ca.available", teamId: team.id }).toString(),
    });
    const permissionText = await permissionResponse.text();
    if (!permissionResponse.ok) return { success: false, error: `Apple 证书撤销接口初始化失败 (${permissionResponse.status})` };
    const csrf = permissionResponse.headers.get("csrf") || "";
    const csrfTimestamp = permissionResponse.headers.get("csrf_ts") || "";
    if (!csrf || !csrfTimestamp) return { success: false, error: "Apple 证书撤销接口未返回 CSRF 安全令牌" };
    const revokeURL = "https://developer.apple.com/services-account/QH65B2/account/ios/certificate/revokeCertificate.action";
    const formBody = new URLSearchParams({ certificateId, teamId: team.id, type: typeId }).toString();
    const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/x-www-form-urlencoded", Referer: referer, "User-Agent": appleDeveloperRequestUserAgent(), csrf, csrf_ts: csrfTimestamp };
    const socksResult = await fetchAppleDeveloperCreateViaOriginalSocks(ses, revokeURL, headers, formBody);
    const response = socksResult || await ses.fetch(revokeURL, { method: "POST", credentials: "include", headers, body: formBody, redirect: "follow", signal: AbortSignal.timeout(45000) });
    const responseStatus = response.status;
    const text = socksResult ? socksResult.text : await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    const ok = (socksResult ? socksResult.ok : response.ok) && Number(body?.resultCode || 0) === 0;
    if (!ok) return { success: false, error: `Apple 证书撤销失败 (${responseStatus})：${appleDeveloperServiceError(body, text) || "未知错误"}` };
    await deleteSyncedAppleDeveloperArtifact({ teamId: team.id, artifactType: "certificate", artifactKey: certificateId });
    const localDirectory = appleCertificateDirectory(team.id, certificateId);
    if (fs.existsSync(localDirectory)) fs.rmSync(localDirectory, { recursive: true, force: true });
    return { success: true, id: certificateId };
  } catch (error) { return { success: false, error: error.message || "证书撤销失败" }; }
});

function appleDeveloperNetworkFilePath(accountKey = appleDeveloperAccountKey) {
  return path.join(appleDeveloperAccountStorageDir(accountKey), "network.json");
}

function appleDeveloperSessionFilePath(accountKey = appleDeveloperAccountKey) {
  return path.join(appleDeveloperAccountStorageDir(accountKey), "session.json");
}

function legacyAppleDeveloperSessionFilePath(accountKey = appleDeveloperAccountKey) {
  return path.join(appleDeveloperAccountStorageDir(accountKey), "session.enc");
}

function appleDeveloperSessionSnapshotSummary(accountKey = appleDeveloperAccountKey) {
  try {
    const saved = JSON.parse(fs.readFileSync(appleDeveloperSessionFilePath(accountKey), "utf8"));
    const cookies = Array.isArray(saved) ? saved : saved?.cookies;
    const appleCookies = Array.isArray(cookies)
      ? cookies.filter(cookie => String(cookie?.domain || "").replace(/^\./, "").endsWith("apple.com") && cookie?.name)
      : [];
    const now = Date.now() / 1000;
    const validCookies = appleCookies.filter(cookie => !Number(cookie.expirationDate) || Number(cookie.expirationDate) > now);
    const names = [...new Set(validCookies.map(cookie => String(cookie.name || "")))].filter(Boolean).sort();
    return {
      exists: true,
      count: validCookies.length,
      expiredCount: appleCookies.length - validCookies.length,
      hasAppleIdSession: names.includes("myacinfo") || names.includes("aidshd"),
      hasDeveloperSession: names.includes("DSESSIONID") || names.includes("dqsid") || names.some(name => /^DES/i.test(name)),
      names,
    };
  } catch (error) {
    return { exists: false, count: 0, expiredCount: 0, hasAppleIdSession: false, hasDeveloperSession: false, names: [] };
  }
}

function isUsableAppleDeveloperSessionSnapshot(snapshot) {
  return !!snapshot?.exists && Number(snapshot.count || 0) > 0 && (snapshot.hasAppleIdSession || snapshot.hasDeveloperSession);
}

function pushAppleDeveloperSessionCandidate(candidates, seen, accountKey) {
  const key = String(accountKey || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!key || seen.has(key)) return;
  seen.add(key);
  candidates.push(key);
}

function appleDeveloperSessionMigrationCandidateKeys(targetAccountKey = appleDeveloperAccountKey) {
  const candidates = [];
  const seen = new Set([String(targetAccountKey || "")]);
  const ownerKey = String(appleDeveloperOwnerKey || "").trim();
  const accountId = String(appleDeveloperRecordId || "").trim();
  const appleId = String(appleDeveloperLaunchAppleId || "").trim().toLowerCase();
  const accountScopeCandidates = [accountId, appleId].filter(Boolean);
  const ownerCandidates = isCertificateManagerIndependent()
    ? [...new Set([ownerKey, "boss:1"].filter(Boolean))]
    : [ownerKey].filter(Boolean);
  try {
    if (appleId) {
      const rows = withCertificateManagerEnvironmentsDatabase(db => {
        if (!ownerCandidates.length) return [];
        return db.prepare(
          `SELECT owner_key, account_id, account_key, updated_at FROM certificate_environments WHERE apple_id=? AND owner_key IN (${ownerCandidates.map(() => "?").join(",")})`
        ).all(appleId, ...ownerCandidates);
      });
      rows.sort((left, right) => {
        const leftOwner = String(left.owner_key || "") === ownerKey ? 1 : 0;
        const rightOwner = String(right.owner_key || "") === ownerKey ? 1 : 0;
        if (leftOwner !== rightOwner) return rightOwner - leftOwner;
        const leftAccount = accountId && String(left.account_id || "") === accountId ? 1 : 0;
        const rightAccount = accountId && String(right.account_id || "") === accountId ? 1 : 0;
        if (leftAccount !== rightAccount) return rightAccount - leftAccount;
        return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
      });
      for (const row of rows) pushAppleDeveloperSessionCandidate(candidates, seen, row.account_key);
    }
  } catch (error) {
    logAppleDeveloperDiagnostic("session-migration-candidates-db-error", { error: error.message });
  }
  for (const owner of ownerCandidates) {
    for (const scope of accountScopeCandidates) {
      pushAppleDeveloperSessionCandidate(candidates, seen, crypto.createHash("sha256").update(`${owner}:${scope}`).digest("hex").slice(0, 24));
    }
  }
  if (isCertificateManagerIndependent()) {
    pushAppleDeveloperSessionCandidate(candidates, seen, "standalone-admin");
    pushAppleDeveloperSessionCandidate(candidates, seen, "legacy");
  }
  return candidates;
}

function migrateAppleDeveloperSessionSnapshotIfNeeded(targetAccountKey = appleDeveloperAccountKey) {
  const targetSnapshot = appleDeveloperSessionSnapshotSummary(targetAccountKey);
  if (isUsableAppleDeveloperSessionSnapshot(targetSnapshot)) return { migrated: false, snapshot: targetSnapshot };
  const targetSessionFile = appleDeveloperSessionFilePath(targetAccountKey);
  const targetUserAgentFile = appleDeveloperUserAgentPath(targetAccountKey);
  for (const candidateKey of appleDeveloperSessionMigrationCandidateKeys(targetAccountKey)) {
    const sourceSnapshot = appleDeveloperSessionSnapshotSummary(candidateKey);
    if (!isUsableAppleDeveloperSessionSnapshot(sourceSnapshot)) continue;
    try {
      fs.mkdirSync(path.dirname(targetSessionFile), { recursive: true });
      fs.copyFileSync(appleDeveloperSessionFilePath(candidateKey), targetSessionFile);
      try { fs.chmodSync(targetSessionFile, 0o600); } catch {}
      const sourceUserAgentFile = appleDeveloperUserAgentPath(candidateKey);
      if (fs.existsSync(sourceUserAgentFile)) {
        fs.copyFileSync(sourceUserAgentFile, targetUserAgentFile);
        try { fs.chmodSync(targetUserAgentFile, 0o600); } catch {}
        appleDeveloperUserAgent = readAppleDeveloperUserAgent() || appleDeveloperUserAgent;
      }
      const migratedSnapshot = appleDeveloperSessionSnapshotSummary(targetAccountKey);
      logAppleDeveloperDiagnostic("session-snapshot-migrated", {
        sourceAccountKey: candidateKey,
        targetAccountKey,
        sourceSnapshot: {
          count: sourceSnapshot.count,
          hasAppleIdSession: sourceSnapshot.hasAppleIdSession,
          hasDeveloperSession: sourceSnapshot.hasDeveloperSession,
        },
        targetSnapshot: {
          count: migratedSnapshot.count,
          hasAppleIdSession: migratedSnapshot.hasAppleIdSession,
          hasDeveloperSession: migratedSnapshot.hasDeveloperSession,
        },
      });
      return { migrated: true, sourceAccountKey: candidateKey, snapshot: migratedSnapshot };
    } catch (error) {
      logAppleDeveloperDiagnostic("session-snapshot-migration-failed", { sourceAccountKey: candidateKey, targetAccountKey, error: error.message });
    }
  }
  return { migrated: false, snapshot: targetSnapshot };
}

async function persistAppleDeveloperCookies(ses, accountKey = appleDeveloperAccountKey) {
  const cookies = (await ses.cookies.get({})).filter(cookie => String(cookie.domain || "").replace(/^\./, "").endsWith("apple.com"));
  if (!cookies.length) {
    logAppleDeveloperDiagnostic("session-cookie-persist-skipped", { targetAccountKey: accountKey, reason: "empty-cookie-store" });
    return { count: 0, names: [], skipped: true };
  }
  const payload = cookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  }));
  const target = appleDeveloperSessionFilePath(accountKey);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ version: 1, warning: "PLAINTEXT_APPLE_SESSION_COOKIES", cookies: payload }), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  const names = [...new Set(payload.map(cookie => cookie.name))].filter(Boolean).sort();
  const summary = {
    count: payload.length,
    names,
    hasAppleIdSession: names.includes("myacinfo") || names.includes("aidshd"),
    hasDeveloperSession: names.includes("DSESSIONID") || names.includes("dqsid") || names.some(name => /^DES/i.test(name)),
  };
  logAppleDeveloperDiagnostic("session-cookie-persisted", { targetAccountKey: accountKey, ...summary });
  return summary;
}

async function restoreAppleDeveloperCookies(ses) {
  if (appleDeveloperCookiesRestoreAttempted) return { skipped: true, reason: "already-attempted" };
  migrateAppleDeveloperSessionSnapshotIfNeeded();
  appleDeveloperCookiesRestoreAttempted = true;
  try {
    const saved = JSON.parse(fs.readFileSync(appleDeveloperSessionFilePath(), "utf8"));
    const cookies = Array.isArray(saved) ? saved : saved?.cookies;
    let restored = 0;
    let expired = 0;
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
      const host = String(cookie.domain || "").replace(/^\./, "");
      if (!host.endsWith("apple.com") || !cookie.name) continue;
      if (Number(cookie.expirationDate) && Number(cookie.expirationDate) <= Date.now() / 1000) {
        expired += 1;
        continue;
      }
      const details = appleCookieSetDetails(cookie);
      if (!details) continue;
      await ses.cookies.set(details);
      restored += 1;
    }
    await ses.flushStorageData();
    const summary = appleDeveloperSessionSnapshotSummary();
    logAppleDeveloperDiagnostic("session-cookie-restored", { restored, expired, snapshot: { count: summary.count, hasAppleIdSession: summary.hasAppleIdSession, hasDeveloperSession: summary.hasDeveloperSession } });
    return { restored, expired };
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("restore plaintext Apple session failed:", error.message);
    if (error?.code !== "ENOENT") logAppleDeveloperDiagnostic("session-cookie-restore-failed", { error: error.message });
    return { restored: 0, error: error.message };
  }
}

function saveAppleDeveloperNetwork(proxy) {
  const target = appleDeveloperNetworkFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(proxy), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
}

async function restoreAppleDeveloperNetwork() {
  if (appleDeveloperNetworkRestorePromise && appleDeveloperNetworkRestoreAccountKey === appleDeveloperAccountKey) {
    return appleDeveloperNetworkRestorePromise;
  }
  if (appleDeveloperNetwork) return;
  if (appleDeveloperNetworkRestoreAttempted) {
    if (appleDeveloperNetworkRestoreError) throw appleDeveloperNetworkRestoreError;
    return;
  }
  appleDeveloperNetworkRestoreAttempted = true;
  const accountKey = appleDeveloperAccountKey;
  const restorePromise = (async () => {
    try {
      const saved = JSON.parse(fs.readFileSync(appleDeveloperNetworkFilePath(), "utf8"));
      const restored = await configureAppleDeveloperNetwork(saved, false);
      const previousIp = String(saved.lastVerifiedIp || "").trim();
      const currentIp = String(restored?.ip || "").trim();
      if (previousIp && currentIp && previousIp !== currentIp) {
        throw new Error(`代理出口 IP 已更换：上次登录为 ${previousIp}，当前为 ${currentIp}。为保护 Apple 账户，已停止自动登录，请确认代理后重新检测。`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        await configureAppleDeveloperNetwork({ enabled: false }, false);
        return;
      }
      appleDeveloperNetworkRestoreError = new Error(error.message || "保存的代理配置不可用，请重新检测代理");
      console.warn("restore Apple developer network failed:", appleDeveloperNetworkRestoreError.message);
      throw appleDeveloperNetworkRestoreError;
    }
  })();
  appleDeveloperNetworkRestorePromise = restorePromise;
  appleDeveloperNetworkRestoreAccountKey = accountKey;
  try {
    await restorePromise;
  } finally {
    if (appleDeveloperNetworkRestorePromise === restorePromise) {
      appleDeveloperNetworkRestorePromise = null;
      appleDeveloperNetworkRestoreAccountKey = "";
    }
  }
}

const APPLE_AUTH_TUNNEL_ID = "apple-developer-auth";

async function configureAppleDeveloperNetwork(proxy = {}, persist = true) {
  const ses = session.fromPartition(appleDeveloperPartition());
  appleDeveloperNetworkRestoreError = null;
  stopLocalProxyTunnel(APPLE_AUTH_TUNNEL_ID);
  const enabled = !!(proxy.enabled && proxy.host && proxy.port);
  if (!enabled) {
    await ses.setProxy({ mode: "direct" });
    await ses.closeAllConnections();
    appleDeveloperProxyCredentials = null;
    let detected = null;
    try { detected = await detectIPStandalone({ enabled: false }); } catch {}
    appleDeveloperNetwork = {
      enabled: false,
      mode: "direct",
      ip: detected?.ip && detected.ip !== "—" ? String(detected.ip) : "",
      country: String(detected?.country || ""),
      region: String(detected?.region || ""),
      city: String(detected?.city || ""),
      isp: String(detected?.isp || ""),
    };
    if (persist) saveAppleDeveloperNetwork({ enabled: false });
    return { ok: true, direct: true, ...detected };
  }
  const normalized = {
    enabled: true,
    type: String(proxy.type || "http").toLowerCase() === "socks5" ? "socks5" : "http",
    host: String(proxy.host || "").trim(),
    port: Number(proxy.port),
    username: String(proxy.username || ""),
    password: String(proxy.password || ""),
  };
  appleDeveloperProxyCredentials = normalized.username
    ? { host: normalized.host, username: normalized.username, password: normalized.password }
    : null;
  if (!normalized.host || !Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    throw new Error("代理地址或端口无效");
  }
  if (normalized.type === "socks5" && (normalized.username || normalized.password)) {
    const tunnel = await startLocalProxyTunnel(APPLE_AUTH_TUNNEL_ID, normalized);
    await ses.setProxy({ proxyRules: `http://127.0.0.1:${tunnel.port}`, proxyBypassRules: "<-loopback>" });
  } else if (normalized.type === "socks5") {
    await ses.setProxy({ proxyRules: `socks5://${normalized.host}:${normalized.port}`, proxyBypassRules: "<-loopback>" });
  } else {
    const auth = normalized.username
      ? `${encodeURIComponent(normalized.username)}:${encodeURIComponent(normalized.password)}@`
      : "";
    await ses.setProxy({ proxyRules: `http://${auth}${normalized.host}:${normalized.port}`, proxyBypassRules: "<-loopback>" });
  }
  await ses.closeAllConnections();
  // Detect through the exact Electron session that will contact Apple. A
  // separate curl connection can receive a different exit on rotating SOCKS
  // services and would show a misleading city to the user.
  let detected = null;
  for (const [source, url] of [
    // Try the broadly compatible endpoints first. Some authenticated SOCKS
    // providers intentionally terminate TLS to public IP-check services even
    // though Apple HTTPS traffic works normally.
    ["httpbin HTTP", "http://httpbin.org/ip"],
    ["icanhazip HTTP", "http://icanhazip.com"],
    ["Amazon CheckIP HTTP", "http://checkip.amazonaws.com"],
    ["ipify", "https://api.ipify.org?format=json"],
    ["httpbin", "https://httpbin.org/ip"],
    ["icanhazip", "https://icanhazip.com"],
    ["Amazon CheckIP", "https://checkip.amazonaws.com"],
  ]) {
    try {
      const ipResponse = await ses.fetch(url, { signal: AbortSignal.timeout(12000), cache: "no-store" });
      const raw = ipResponse.ok ? await ipResponse.text() : "";
      const parsed = parseDetectorResult(source, raw);
      const ip = String(parsed?.ip || "").trim();
      if (!ip) continue;
      const geoResponse = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,isp,lat,lon,timezone,query`, { signal: AbortSignal.timeout(8000) });
      const geo = geoResponse.ok ? await geoResponse.json().catch(() => ({})) : {};
      detected = parseDetectorResult(`Electron 登录会话 · ${source}`, JSON.stringify({ ...geo, query: ip })) || parsed;
      detected = { ...detected, proxyText: "代理/VPN", statusText: "登录会话出口 IP 检测成功" };
      break;
    } catch (error) {
      console.warn(`Electron Apple session IP detection failed (${source}):`, error.message);
    }
  }
  if (!detected) detected = await detectIPStandalone(normalized, APPLE_AUTH_TUNNEL_ID);
  if (!isProxyDetectOK(detected)) {
    await ses.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" });
    await ses.closeAllConnections();
    const detail = String(detected?.statusText || "");
    if (/authentication failed|auth method rejected|user was rejected/i.test(detail)) {
      throw new Error("代理认证失败：用户名或密码已失效，请更换代理后重新检测");
    }
    if (/timeout|timed out|ECONNREFUSED|connect failed/i.test(detail)) {
      throw new Error("代理连接失败：当前代理不可达或已过期，请更换代理后重新检测");
    }
    throw new Error(detail || "代理不可达，已禁止登录");
  }
  appleDeveloperNetwork = { enabled: true, mode: normalized.type, host: normalized.host, port: normalized.port, ip: detected.ip, country: detected.country, region: detected.region, city: detected.city, isp: detected.isp };
  if (persist) saveAppleDeveloperNetwork({ ...normalized, lastVerifiedIp: detected.ip, country: detected.country, region: detected.region, city: detected.city, isp: detected.isp });
  return { ok: true, ...detected };
}

ipcMain.handle("apple-developer-proxies", async () => {
  try { return { proxies: normalizeProxyRows(JSON.parse(fs.readFileSync(proxyPoolFilePath(), "utf8"))) }; }
  catch { return { proxies: [] }; }
});

ipcMain.handle("apple-developer-detect-proxy", async (_event, proxy = {}) => {
  try {
    const result = await configureAppleDeveloperNetwork({ ...proxy, enabled: true });
    return { ok: true, ip: result.ip, country: result.country, region: result.region, city: result.city, isp: result.isp };
  } catch (error) { return { ok: false, error: error.message }; }
});

function appleCookieSetDetails(cookie) {
  const host = String(cookie?.domain || "").replace(/^\./, "");
  if (!host.endsWith("apple.com") || !cookie?.name) return null;
  const details = {
    url: `https://${host}${cookie.path || "/"}`,
    name: String(cookie.name),
    value: String(cookie.value || ""),
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure !== false,
    httpOnly: !!cookie.httpOnly,
  };
  if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
  if (Number(cookie.expirationDate) > Date.now() / 1000) details.expirationDate = Number(cookie.expirationDate);
  return details;
}

function isAppleTrustedSessionCookie(cookie) {
  const name = String(cookie?.name || "");
  const domain = String(cookie?.domain || "").replace(/^\./, "");
  if (!domain.endsWith("apple.com")) return false;
  return name === "myacinfo" || name === "aidshd" || /^DES/i.test(name);
}

async function restoreAppleCookieDetails(ses, cookies) {
  let restored = 0;
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const details = appleCookieSetDetails(cookie);
    if (!details) continue;
    try {
      await ses.cookies.set(details);
      restored += 1;
    } catch {}
  }
  return restored;
}

async function resetAppleDeveloperLoginTransaction(ses, options = {}) {
  const preserveTrustedCookies = options.preserveTrustedCookies === true;
  const trustedCookies = preserveTrustedCookies
    ? (await ses.cookies.get({})).filter(isAppleTrustedSessionCookie)
    : [];
  // An unauthenticated persistent partition may still contain the IDMS cookies,
  // storage and pooled connections from a previous password/2FA transaction.
  // Starting SRP on top of that mixed state can accept the password but reject
  // the newest verification code with 403. Clear that transaction state, but
  // keep durable trusted-browser cookies so Apple can still treat the password
  // login like the official web flow on a remembered device.
  await ses.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  await ses.clearCache().catch(() => {});
  const restoredTrustedCookies = await restoreAppleCookieDetails(ses, trustedCookies);
  await ses.closeAllConnections();
  if (preserveTrustedCookies) logAppleDeveloperDiagnostic("session-trusted-cookies-preserved", { restoredTrustedCookies });
  // Keep the last durable cookie snapshot until a replacement login succeeds.
  // It is not restored again in this process, but preserving it avoids losing
  // a still-usable trusted session when Apple asks for 2FA and the user stops.
  appleDeveloperCookiesRestoreAttempted = true;
  appleDeveloperAuthenticated = false;
  ensureAppleDeveloperUserAgent(ses);
}

async function loginAppleDeveloperWithBootstrapRecovery(ses, clientFingerprint, appleId, password) {
  let authClient = createAppleDeveloperAuthClient(ses, clientFingerprint);
  appleAuthClient = authClient;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await authClient.login(appleId, password, false);
      if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) {
        throw new Error("登录期间 Apple 账户已切换，请重新登录");
      }
      return { authClient, result };
    } catch (error) {
      const stillCurrent = appleAuthClientIsCurrent(authClient) && appleAuthClient === authClient;
      if (appleAuthClient === authClient) appleAuthClient = null;
      if (!error.appleBootstrapBlocked && !error.appleBootstrapStaleSession && !error.appleBootstrapAccessDenied && !error.appleBootstrapMissingParameters) throw error;
      if (!stillCurrent) throw new Error("登录期间 Apple 账户已切换，请重新登录");
      if (attempt === 1) {
        if (error.appleBootstrapAccessDenied) throw new Error("Apple 登录页请求被拒绝 (403)。已清理当前账户会话并从 Apple Developer 官方入口重试，仍未通过；请稍后重试或检查该账户的代理配置。此时尚未验证密码。");
        if (error.appleBootstrapMissingParameters) {
          const detail = `HTTP ${error.appleBootstrapStatus}${error.appleBootstrapReason === "empty-page" ? "，页面为空" : ""}`;
          throw new Error(`Apple 登录页未返回有效认证参数（${detail}）。已清理当前账户会话并从官方入口重试，仍无法继续；请稍后重试或检查该账户的代理配置。此时尚未验证密码。`);
        }
        if (error.appleBootstrapStaleSession) throw new Error("Apple 登录页未返回新的认证参数，已清理当前账户缓存并重试；请检查代理网络后重新登录");
        throw new Error("Apple 登录请求仍被本地 Chromium 拦截（net::ERR_BLOCKED_BY_CLIENT）。已清理当前账户缓存并重试；请检查拦截软件或系统网络设置。");
      }
      const useDeveloperLoginEntry = error.appleBootstrapAccessDenied === true || error.appleBootstrapMissingParameters === true || error.appleBootstrapStaleSession === true;
      logAppleDeveloperDiagnostic("auth-bootstrap-recovery", {
        step: error.appleBootstrapStep || "unknown",
        reason: error.appleBootstrapReason || (error.appleBootstrapAccessDenied ? "http-403" : error.appleBootstrapStaleSession ? "stale-session" : "blocked-by-client"),
        status: error.appleBootstrapStatus,
        useDeveloperLoginEntry,
      });
      await resetAppleDeveloperLoginTransaction(ses, { preserveTrustedCookies: false });
      if (typeof ses.clearAuthCache === "function") {
        await ses.clearAuthCache().catch(clearError => {
          logAppleDeveloperDiagnostic("auth-cache-clear-error", { error: clearError.message });
        });
      }
      if (!appleDeveloperContextIsCurrent(authClient.contextGeneration, authClient.accountKey) || appleAuthClient) {
        throw new Error("登录期间 Apple 账户已切换，请重新登录");
      }
      authClient = createAppleDeveloperAuthClient(ses, clientFingerprint, { useDeveloperLoginEntry });
      appleAuthClient = authClient;
    }
  }
}

async function tryRestoreAppleDeveloperRememberedSession(ses, reason = "auto-login") {
  const accountKey = appleDeveloperAccountKey;
  const generation = appleDeveloperContextGeneration;
  const migration = migrateAppleDeveloperSessionSnapshotIfNeeded(accountKey);
  const snapshot = migration.snapshot || appleDeveloperSessionSnapshotSummary(accountKey);
  if (!snapshot.exists || !snapshot.count) {
    logAppleDeveloperDiagnostic("session-soft-restore-skip", { reason, snapshot });
    return { authenticated: false, skipped: true, reason: "no-cookie-snapshot", snapshot };
  }
  if (!snapshot.hasAppleIdSession && !snapshot.hasDeveloperSession) {
    logAppleDeveloperDiagnostic("session-soft-restore-skip", { reason, snapshot });
    return { authenticated: false, skipped: true, reason: "no-apple-session-cookie", snapshot };
  }
  try {
    logAppleDeveloperDiagnostic("session-soft-restore-start", { reason, snapshot });
    appleDeveloperCookiesRestoreAttempted = false;
    await restoreAppleDeveloperCookies(ses);
    if (!appleDeveloperContextIsCurrent(generation, accountKey)) return { authenticated: false, stale: true };
    const status = await readAppleDeveloperStatus();
    if (!appleDeveloperContextIsCurrent(generation, accountKey)) return { authenticated: false, stale: true };
    if (status?.authenticated) {
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, accountKey);
      logAppleDeveloperDiagnostic("session-soft-restore-success", { reason });
      return { authenticated: true, status };
    }
    logAppleDeveloperDiagnostic("session-soft-restore-miss", { reason });
    return { authenticated: false, status };
  } catch (error) {
    logAppleDeveloperDiagnostic("session-soft-restore-error", { reason, error: error.message });
    return { authenticated: false, error: error.message };
  }
}

function isApplePasswordMismatchError(error) {
  const message = String(error?.message || error || "");
  return /code=-?20101|\b-20101\b|请检查输入的账户信息并重试/.test(message);
}

ipcMain.handle("apple-developer-login", async (_event, payload = {}) => {
  const appleId = String(payload.appleId || "").trim();
  const password = String(payload.password || "");
  const clientFingerprint = String(payload.clientFingerprint || "").trim();
  const passwordChanged = appleId.toLowerCase() === appleDeveloperLaunchAppleId.toLowerCase() &&
    !!appleDeveloperLaunchPassword && password !== appleDeveloperLaunchPassword;
  if (!appleId || !password) return { success: false, error: "请输入 Apple ID 和密码" };
  if (!/^[.0-9A-Z_a-z]{80,256}$/.test(clientFingerprint)) return { success: false, error: "Apple 客户端指纹生成失败，请关闭窗口后重试" };
  if (appleDeveloperLoginInFlight) return { success: false, inProgress: true, error: "Apple 登录正在进行，请勿重复提交" };
  appleDeveloperLoginInFlight = true;
  let resolveLoginCompletion;
  const loginCompletionPromise = new Promise(resolve => { resolveLoginCompletion = resolve; });
  appleDeveloperLoginCompletionPromise = loginCompletionPromise;
  let authClient = null;
  try {
    // Renderer startup may still be promoting a remembered IDMS cookie in a
    // hidden BrowserWindow. Let that attempt finish before clearing storage
    // and starting SRP; otherwise both flows rotate/consume the same Apple
    // transaction headers and fresh passwords or SMS codes are rejected.
    await waitForAppleContextRefreshes();
    // Resolve the account partition before configuring networking. Previously
    // the proxy was applied to `standalone-admin`, then the Apple ID switched
    // us to another partition. Password/2FA and the Developer web exchange
    // consequently ran with different network contexts and timed out.
    if (isCertificateManagerIndependent()) {
      const previousAccountKey = appleDeveloperAccountKey;
      const previousPartition = appleDeveloperPartition();
      ensureStandaloneDeveloperAccount(appleId, password);
      if (appleDeveloperPartition() !== previousPartition) {
        await session.fromPartition(previousPartition).closeAllConnections().catch(() => {});
        invalidateAppleDeveloperRuntimeForAccountSwitch();
        appleDeveloperNetwork = null;
        appleDeveloperProxyCredentials = null;
        appleDeveloperNetworkRestoreAttempted = false;
        appleDeveloperNetworkRestoreError = null;
        appleDeveloperCookiesRestoreAttempted = false;
        appleDeveloperUserAgent = readAppleDeveloperUserAgent();
        console.warn("[apple-auth] switched account context", { from: previousAccountKey, to: appleDeveloperAccountKey });
      }
    }
    const networkResult = await configureAppleDeveloperNetwork(payload.proxy || {});
    const expectedProxyIp = String(payload.expectedProxyIp || "").trim();
    if (expectedProxyIp && networkResult.ip && expectedProxyIp !== networkResult.ip) {
      throw new Error(`代理出口 IP 已变化：检测时为 ${expectedProxyIp}，登录前变为 ${networkResult.ip}。请重新检测代理；如需固定成都，请使用静态或粘性成都出口。`);
    }
    const ses = session.fromPartition(appleDeveloperPartition());
    const restored = appStoreConnectForceFullLoginRequired || passwordChanged
      ? { authenticated: false }
      : await tryRestoreAppleDeveloperRememberedSession(ses, "manual-login");
    if (restored.authenticated) {
      if (appleDeveloperOwnerKey && appleDeveloperRecordId && appleId.toLowerCase() === appleDeveloperLaunchAppleId.toLowerCase()) {
        appleDeveloperLaunchPassword = password;
      }
      await syncAppleDeveloperAccountUsage();
      recordStandaloneLoginSuccess(appleId);
      sendAppleDeveloperStatus(restored.status);
      return { success: true, cached: true, restored: true };
    }
    await resetAppleDeveloperLoginTransaction(ses, { preserveTrustedCookies: !passwordChanged });
    let result;
    ({ authClient, result } = await loginAppleDeveloperWithBootstrapRecovery(ses, clientFingerprint, appleId, password));
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("登录期间 Apple 账户已切换，请重新登录");
    if (appleDeveloperOwnerKey && appleDeveloperRecordId && appleId.toLowerCase() === appleDeveloperLaunchAppleId.toLowerCase()) {
      appleDeveloperLaunchPassword = password;
    }
    if (!result.requires2FA) {
      await authClient.finalizeDeveloperSession();
      if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("登录期间 Apple 账户已切换，请重新登录");
      const status = await readAppleDeveloperStatus();
      if (!status.authenticated) throw new Error("Apple 密码验证已完成，但开发者会话尚未建立");
      if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("登录期间 Apple 账户已切换，请重新登录");
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, authClient.accountKey);
      await syncAppleDeveloperAccountUsage();
      recordStandaloneLoginSuccess(appleId);
      appStoreConnectForceFullLoginRequired = false;
      sendAppleDeveloperStatus(status);
    }
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("登录期间 Apple 账户已切换，请重新登录");
    return { success: true, ...result };
  } catch (error) {
    // A stale concurrent attempt must not destroy the newer attempt's 2FA
    // client. This previously caused “认证会话已过期” after a successful hsa2
    // response when another restore request failed with 503.
    if (appleAuthClient === authClient) appleAuthClient = null;
    return { success: false, error: error.message };
  } finally {
    appleDeveloperLoginInFlight = false;
    resolveLoginCompletion();
    if (appleDeveloperLoginCompletionPromise === loginCompletionPromise) appleDeveloperLoginCompletionPromise = null;
  }
});

ipcMain.handle("apple-developer-auto-login", async (_event, payload = {}) => {
  const clientFingerprint = String(payload.clientFingerprint || "").trim();
  const forceRefresh = payload.forceRefresh === true || appStoreConnectForceFullLoginRequired;
  if (!appleDeveloperLaunchAppleId) return { success: false, passwordRequired: true, error: "请选择 Apple 开发者账户" };
  if (!/^[.0-9A-Z_a-z]{80,256}$/.test(clientFingerprint)) return { success: false, error: "Apple 客户端指纹生成失败" };
  if (appleDeveloperLoginInFlight) return { success: false, inProgress: true, error: "Apple 登录正在进行，请勿重复提交" };
  appleDeveloperLoginInFlight = true;
  let resolveLoginCompletion;
  const loginCompletionPromise = new Promise(resolve => { resolveLoginCompletion = resolve; });
  appleDeveloperLoginCompletionPromise = loginCompletionPromise;
  let authClient = null;
  try {
    await waitForAppleContextRefreshes();
    // Always validate and apply the bound network before accepting a cached
    // Apple session. Otherwise a changed/expired proxy is only discovered by
    // the first team or App request, which looks like an expired Apple login.
    await restoreAppleDeveloperNetwork();
    const current = forceRefresh ? { authenticated: false } : await readAppleDeveloperStatus();
    if (current.authenticated) {
      await syncAppleDeveloperAccountUsage();
      return { success: true, cached: true };
    }
    const ses = session.fromPartition(appleDeveloperPartition());
    const restored = forceRefresh ? { authenticated: false } : await tryRestoreAppleDeveloperRememberedSession(ses, "auto-login");
    if (restored.authenticated) {
      await syncAppleDeveloperAccountUsage();
      sendAppleDeveloperStatus(restored.status);
      return { success: true, cached: true, restored: true };
    }
    await resetAppleDeveloperLoginTransaction(ses, { preserveTrustedCookies: true });
    if (!appleDeveloperLaunchPassword) return { success: false, passwordRequired: true, error: "Apple 会话已过期，请重新输入 Apple ID 密码" };
    let result;
    ({ authClient, result } = await loginAppleDeveloperWithBootstrapRecovery(ses, clientFingerprint, appleDeveloperLaunchAppleId, appleDeveloperLaunchPassword));
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("自动登录期间 Apple 账户已切换，请重新登录");
    if (!result.requires2FA) {
      await authClient.finalizeDeveloperSession();
      const status = await readAppleDeveloperStatus();
      if (!status.authenticated) throw new Error("Apple 密码验证已完成，但开发者会话尚未建立");
      await ses.flushStorageData();
      await persistAppleDeveloperCookies(ses, authClient.accountKey);
      await syncAppleDeveloperAccountUsage();
      recordStandaloneLoginSuccess(appleDeveloperLaunchAppleId);
      appStoreConnectForceFullLoginRequired = false;
      sendAppleDeveloperStatus(status);
    }
    return { success: true, ...result };
  } catch (error) {
    if (appleAuthClient === authClient) appleAuthClient = null;
    if (isApplePasswordMismatchError(error)) {
      return { success: false, passwordRequired: true, error: "Apple ID 密码验证失败；如果已修改密码，请输入当前密码重新登录" };
    }
    return { success: false, error: error.message };
  } finally {
    appleDeveloperLoginInFlight = false;
    resolveLoginCompletion();
    if (appleDeveloperLoginCompletionPromise === loginCompletionPromise) appleDeveloperLoginCompletionPromise = null;
  }
});

ipcMain.handle("apple-developer-2fa-method", async (_event, value = {}) => {
  const request = typeof value === "string" ? { method: value } : (value || {});
  const method = request.method === "sms" ? "sms" : "device";
  const authClient = appleAuthClient;
  if (!appleAuthClientIsCurrent(authClient)) return { success: false, error: "认证会话已过期，请重新登录当前账户" };
  try {
    const delivery = method === "sms"
      ? await authClient.requestSMS(request.phoneId)
      : await authClient.requestDeviceCode();
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) {
      return { success: false, error: "发送期间 Apple 账户已切换，请重新登录" };
    }
    return { success: true, method, ...delivery };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-2fa", async (_event, code) => {
  if (!/^\d{6}$/.test(String(code || ""))) return { success: false, error: "请输入 6 位验证码" };
  const authClient = appleAuthClient;
  if (!appleAuthClientIsCurrent(authClient)) return { success: false, error: "认证会话已过期，请重新登录当前账户" };
  try {
    await authClient.verifyCode(String(code));
    const ses = session.fromPartition(appleDeveloperPartition());
    // 2FA success only authenticates IDMS. The Developer account shell still
    // has to exchange that login in the same partition before status probing.
    await ses.flushStorageData();
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    const serviceValidation = await establishAppleDeveloperWebSession(ses);
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    let status = await readAppleDeveloperStatus();
    if (!status.authenticated && serviceValidation?.valid) {
      appleDeveloperAuthenticated = true;
      appleDeveloperSessionInfo = mergeAppleDeveloperSessionInfo(appleDeveloperSessionInfo, serviceValidation);
      status = { authenticated: true, network: appleDeveloperNetwork };
    }
    if (!status.authenticated) throw new Error("验证码已通过，但 Apple 开发者会话尚未建立");
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    await ses.flushStorageData();
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    await persistAppleDeveloperCookies(ses, authClient.accountKey);
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    await syncAppleDeveloperAccountUsage();
    if (!appleAuthClientIsCurrent(authClient) || appleAuthClient !== authClient) throw new Error("验证期间 Apple 账户已切换，请重新登录");
    recordStandaloneLoginSuccess(appleDeveloperLaunchAppleId);
    appStoreConnectForceFullLoginRequired = false;
    sendAppleDeveloperStatus(status);
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle("apple-developer-logout", async (_event, options = {}) => {
  const closeApplication = isCertificateManagerBrowserBound();
  // Browser-owned developer accounts may only be changed in the browser.
  // Logging out here detaches the Apple session UI and closes this process;
  // it must never delete the browser's saved account record.
  const keepLoginInfo = options.keepLoginInfo !== false;
  const forgottenAppleId = String(appleDeveloperLaunchAppleId || "").trim();
  const forgottenAccountId = String(appleDeveloperRecordId || "").trim();
  const forgottenOwnerKey = String(appleDeveloperOwnerKey || "").trim();
  const forgottenAccountKey = String(appleDeveloperAccountKey || "legacy").replace(/[^A-Za-z0-9_-]/g, "");
  const ses = session.fromPartition(appleDeveloperPartitionForAccount(forgottenAccountKey));
  // The keep option only detaches the account from the current UI and retains
  // its persistent sessions. The forget option below removes every local
  // account session before reporting success or closing the application.
  if (keepLoginInfo) {
    try { await ses.flushStorageData(); } catch {}
    await persistAppleDeveloperCookies(ses).catch(error => console.warn("persist Apple session on logout failed:", error.message));
  } else {
    await waitForAppleContextRefreshes(true);
    stopLocalProxyTunnel(APPLE_AUTH_TUNNEL_ID);
    stopLocalProxyTunnel(`apple-account-${forgottenAccountKey}`);
    appleAuthClient = null;
    appleAccountAuthClient = null;
    appleAccountSession = null;
    await clearDeveloperAccountCaches(forgottenAccountKey, forgottenAppleId);
    deleteCertificateManagerAccountEnvironment(forgottenOwnerKey, forgottenAccountKey);
    removeStandaloneLoginHistory(forgottenAppleId);
    // A browser-bound launch may clear the local Apple session, but the
    // browser remains the owner of its saved developer-account record.
    if (!closeApplication && forgottenOwnerKey && forgottenAccountId) {
      try {
        withDeveloperAccountsDatabase(db => db.prepare("DELETE FROM developer_accounts WHERE owner_key=? AND id=?").run(forgottenOwnerKey, forgottenAccountId));
      } catch (error) { console.warn("delete forgotten Apple account failed:", error.message); }
    }
  }
  appleDeveloperAuthenticated = false;
  stopLocalProxyTunnel(APPLE_AUTH_TUNNEL_ID);
  appleDeveloperNetwork = null;
  appleDeveloperProxyCredentials = null;
  appleDeveloperNetworkRestoreAttempted = false;
  appleDeveloperNetworkRestoreError = null;
  appleDeveloperCookiesRestoreAttempted = false;
  appleDeveloperSessionInfo = null;
  appleAuthClient = null;
  appleAccountAuthClient = null;
  appleAccountSession = null;
  appleAccountManageScnt = "";
  appleAccountApiKey = "";
  appleAccountApiUrl = "";
  if (!keepLoginInfo) {
    appleDeveloperLaunchAppleId = "";
    appleDeveloperLaunchPassword = "";
    appleDeveloperRecordId = "";
    appleDeveloperCertificateEnvironment = null;
    appleDeveloperAccountKey = "legacy";
    appleDeveloperUserAgent = "";
    appleDeveloperP12Password = DEFAULT_P12_PASSWORD;
  }
  const status = { authenticated: false, keepLoginInfo, forgotten: !keepLoginInfo, closeApplication };
  sendAppleDeveloperStatus(status);
  if (closeApplication) setTimeout(() => app.quit(), 250);
  return status;
});

ipcMain.handle("auth-open-page", async (event, requestedPath) => {
  const pagePath = String(requestedPath || "");
  if (!AUTH_PAGE_PATHS.has(pagePath)) return { success: false, error: "不支持的账号页面" };
  const existing = authPageWindows.get(pagePath);
  if (focusWindow(existing)) return { success: true, reused: true };
  authPageWindows.delete(pagePath);
  const parent = BrowserWindow.fromWebContents(event.sender);
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    title: pagePath === "/login" ? `${BROWSER_APP_NAME}登录` : "IPA 相似度检测",
    icon: currentAppIcon(),
  });
  authPageWindows.set(pagePath, win);
  win.once("closed", () => {
    if (authPageWindows.get(pagePath) === win) authPageWindows.delete(pagePath);
  });
  const pageURL = new URL(`${currentAuthBaseURL()}${pagePath}`);
  if (pagePath === "/login") pageURL.searchParams.set("desktop", "1");
  await win.loadURL(pageURL.toString());
  if (pagePath === "/login") {
    const loginCheck = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(loginCheck);
        return;
      }
      const state = await authRequest("/api/auth/me").catch(() => null);
      if (state?.success && state.user) {
        await session.defaultSession.flushStorageData().catch(() => {});
        saveDesktopUserIdentity(state);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("auth-login-success", { user: state.user });
        }
        clearInterval(loginCheck);
        win.close();
      }
    }, 1000);
    const qrRefreshCheck = setInterval(async () => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        clearInterval(qrRefreshCheck);
        return;
      }
      const expired = await win.webContents.executeJavaScript(
        `document.body?.innerText?.includes("二维码已失效") === true`,
        true,
      ).catch(() => false);
      if (expired) win.webContents.reloadIgnoringCache();
    }, 2000);
    win.once("closed", () => {
      clearInterval(loginCheck);
      clearInterval(qrRefreshCheck);
    });
  }
  return { success: true };
});

ipcMain.handle("daemon-request", async (_event, requestPath, options = {}) => {
  await findDaemonURL();
  const response = await fetch(`${DAEMON}${requestPath}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Daemon request failed: ${response.status}`);
  }
  return response.json();
});

ipcMain.handle("environments-list", async () => {
  return loadEnvironmentRows();
});

ipcMain.handle("browser-kernels-status", async () => {
  let manifest = [];
  let manifestError = "";
  try {
    manifest = await fetchKernelManifest();
  } catch (error) {
    manifestError = error.message || "无法读取服务器内核清单";
  }
  return {
    success: true,
    manifestLoaded: !manifestError,
    manifestError,
    kernels: Object.keys(KERNEL_ELECTRON_VERSIONS).map(version => {
      const paths = kernelRuntimePaths(version);
      const remote = manifest.find(row => String(row.version) === version && String(row.platform) === paths.platformId);
      return {
        version,
        electronVersion: KERNEL_ELECTRON_VERSIONS[version],
        installed: kernelInstalled(version),
        available: !!(remote?.available && remote?.downloadUrl),
        size: Number(remote?.size || 0),
      };
    }),
  };
});

ipcMain.handle("browser-kernel-ensure", async (event, version) => {
  try {
    const kernel = String(version || "");
    if (!KERNEL_ELECTRON_VERSIONS[kernel]) throw new Error("不支持的浏览器内核版本");
    const alreadyInstalled = kernelInstalled(kernel);
    await ensureKernelRuntimeByVersion(kernel, event.sender);
    return { success: true, version: kernel, installed: true, downloaded: !alreadyInstalled };
  } catch (error) {
    return { success: false, error: error.message || "浏览器内核下载失败" };
  }
});

ipcMain.handle("browser-kernel-update", async (event, version) => {
  try {
    const kernel = String(version || "");
    if (!KERNEL_ELECTRON_VERSIONS[kernel]) throw new Error("不支持的浏览器内核版本");
    await ensureKernelRuntimeByVersion(kernel, event.sender, true);
    return { success: true, version: kernel, installed: true, updated: true };
  } catch (error) {
    return { success: false, error: error.message || "浏览器内核更新失败" };
  }
});

ipcMain.handle("environments-create", async (_event, env) => {
  const existingRows = await loadEnvironmentRows().catch(() => readLocalEnvironments());
  const authState = await authRequest("/api/auth/me").catch(() => null);
  if (!authState?.success || !authState.user) throw new Error("请先登录");
  const entitlements = await authRequest("/api/auth/desktop-entitlements").catch(() => null);
  const maxBrowserWindows = Math.max(
    0,
    Number(entitlements?.success ? entitlements.max_browser_windows : (authState.user.max_browser_windows ?? 10)) || 0,
  );
  if (maxBrowserWindows > 0 && existingRows.length >= maxBrowserWindows) {
    throw new Error(`当前会员浏览器窗口额度为 ${maxBrowserWindows} 个，已用完，请升级会员或联系管理员调整额度`);
  }
  const serialNum = String(env && env.serialNum || allocateEnvironmentSerial(existingRows));
  const requestedDebugPort = Number(env && env.debugPort || 0);
  const debugPort = Number.isInteger(requestedDebugPort) && requestedDebugPort >= 1024 && requestedDebugPort <= 65535
    ? requestedDebugPort
    : await allocateEnvironmentDebugPort(existingRows);
  const created = normalizeEnvironment({ ...(env || {}), serialNum, debugPort });
  assertUniqueEnvironmentFingerprint(created, existingRows, { ignoreEnvId: created.id });
  const cloudRows = [...existingRows, created];

  // Cloud is the source of truth. Do not create a local/daemon-only row that
  // disappears as soon as the list is refreshed from the server.
  if (!(await syncEnvironmentRowsToCloud(cloudRows))) {
    throw new Error("云端创建失败，请检查网络或登录状态后重试");
  }

  const refreshedRows = await loadCloudEnvironmentRows(cloudRows);
  const ensured = ensureEnvironmentSerials(refreshedRows);
  writeLocalEnvironments(ensured.rows);
  await replaceDaemonEnvironments(ensured.rows);
  return ensured.rows.find(row => String(row.id) === String(created.id)) || created;
});

ipcMain.handle("environments-update", async (_event, id, env) => {
  const envId = String(id || "");
  const rowsBeforeUpdate = await loadEnvironmentRows().catch(() => readLocalEnvironments());
  const previous = rowsBeforeUpdate.find(item => String(item.id) === envId);
  if (!previous) throw new Error("environment not found");
  const updated = normalizeEnvironment({ ...(env || {}), id: previous.id, serialNum: previous.serialNum }, previous);
  assertUniqueEnvironmentFingerprint(updated, rowsBeforeUpdate, { ignoreEnvId: envId });
  const cloudRows = rowsBeforeUpdate.map(row => String(row.id) === envId ? updated : row);
  if (!(await syncEnvironmentRowsToCloud(cloudRows))) {
    throw new Error("云端更新失败，本地数据未修改");
  }
  const refreshedRows = await loadCloudEnvironmentRows(cloudRows);
  writeLocalEnvironments(refreshedRows);
  await replaceDaemonEnvironments(refreshedRows);
  const saved = refreshedRows.find(row => String(row.id) === envId) || updated;
  pushEnvironmentConfigToBrowser(saved, browserWindows.get(envId));
  return saved;
});

ipcMain.handle("environments-delete", async (_event, id) => {
  const envId = String(id || "");
  const localRows = readLocalEnvironments();
  const existingRows = await loadEnvironmentRows().catch(() => localRows);
  const deletingEnv = existingRows.find(item => String(item.id) === envId) || localRows.find(item => String(item.id) === envId);
  if (!deletingEnv) {
    await replaceDaemonEnvironments(existingRows).catch(() => {});
    await clearEnvironmentBrowserData(envId, "");
    await authRequest(`/api/browser-sync/environments/${encodeURIComponent(envId)}/snapshot`, { method: "DELETE" }).catch(() => {});
    return { ok: true, notFound: true };
  }
  const cloudRows = existingRows.filter(item => String(item.id) !== envId);
  if (!(await syncEnvironmentRowsToCloud(cloudRows))) {
    throw new Error("云端删除失败，本地数据未修改");
  }
  const refreshedRows = await loadCloudEnvironmentRows(cloudRows);
  writeLocalEnvironments(refreshedRows);
  await replaceDaemonEnvironments(refreshedRows);
  await clearEnvironmentBrowserData(envId, deletingEnv.serialNum);
  await authRequest(`/api/browser-sync/environments/${encodeURIComponent(envId)}/snapshot`, { method: "DELETE" }).catch(() => {});
  return { ok: true, notFound: false };
});

ipcMain.handle("export-proxies", async (_event, rows) => {
  try {
    const result = await dialog.showSaveDialog({
      title: "导出代理IP",
      defaultPath: "导出代理IP.xlsx",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, buildProxyWorkbook(Array.isArray(rows) ? rows : []));
    return { filePath: result.filePath };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("download-proxy-template", async () => {
  try {
    const result = await dialog.showSaveDialog({
      title: "下载导入代理表格文件",
      defaultPath: "导入代理IP模板.xlsx",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, buildProxyWorkbook([]));
    return { filePath: result.filePath };
  } catch (e) {
    return { error: e.message };
  }
});

function readZipEntry(buffer, entryName) {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString();
    const dataStart = nameStart + fileNameLength + extraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (name === entryName) {
      if (method === 0) return data.toString();
      if (method === 8) return zlib.inflateRawSync(data).toString();
      throw new Error("不支持该 xlsx 压缩格式");
    }
    offset = dataStart + compressedSize;
  }
  return "";
}

function readXlsxEntry(filePath, entryName) {
  try {
    const output = execFileSync("unzip", ["-p", filePath, entryName], { maxBuffer: 20 * 1024 * 1024 });
    return output.toString();
  } catch {
    return readZipEntry(fs.readFileSync(filePath), entryName);
  }
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseProxyWorkbook(filePath) {
  const xml = readXlsxEntry(filePath, "xl/worksheets/sheet1.xml");
  if (!xml) throw new Error("未找到工作表数据");
  const sharedXml = readXlsxEntry(filePath, "xl/sharedStrings.xml");
  const sharedStrings = [];
  if (sharedXml) {
    const siPattern = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siPattern.exec(sharedXml))) {
      const texts = [];
      const tPattern = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tMatch;
      while ((tMatch = tPattern.exec(siMatch[1]))) texts.push(xmlUnescape(tMatch[1]));
      sharedStrings.push(texts.join(""));
    }
  }
  const rows = [];
  const rowPattern = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml))) {
    const cells = [];
    const cellPattern = /<c\b([^>]*)r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attrs = `${cellMatch[1]} ${cellMatch[4]}`;
      const col = cellMatch[2].split("").reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const body = cellMatch[5] || "";
      let value = "";
      const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const rawValue = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      if (inline) value = xmlUnescape(inline[1]);
      else if (rawValue && /\bt="s"/.test(attrs)) value = sharedStrings[Number(rawValue[1])] || "";
      else if (rawValue) value = xmlUnescape(rawValue[1]).replace(/\.0$/, "");
      cells[col] = value;
    }
    rows.push(cells);
  }
  const headers = rows[0] || [];
  const index = name => headers.indexOf(name);
  return rows.slice(1).map(row => ({
    type: row[index("代理类型")] || "socks5",
    host: row[index("代理主机")] || "",
    port: row[index("代理端口")] || "",
    username: row[index("代理账号")] || "",
    password: row[index("代理密码")] || "",
    refreshUrl: row[index("刷新URL")] || "",
    note: row[index("备注信息")] || "",
    outIp: row[index("出口IP")] || "",
  })).filter(proxy => proxy.host && proxy.port);
}

ipcMain.handle("import-proxies", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "批量导入代理",
      properties: ["openFile"],
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return { proxies: parseProxyWorkbook(result.filePaths[0]) };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("browser-refresh-ip", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win._envConfig) return { error: "no env config" };
  try {
    const resp = await fetch(`${DAEMON}/proxy/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy: win._envConfig.proxy || { enabled: false }, allowDirectFallback: false })
    });
    const result = await resp.json();
    if (win._fingerprint) {
      applyIPDataToFingerprint(win._fingerprint, result);
      rememberEnvironmentFingerprint(win._envId, win._fingerprint);
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.on("browser-get-fingerprint", (event, request = {}) => {
  const payload = typeof request === "string" ? { userAgent: request } : (request || {});
  const senderSessionEnvId = event.sender?.session ? environmentIdsBySession.get(event.sender.session) : "";
  const envId = String(payload.envId || senderSessionEnvId || webviewEnvironmentIds.get(event.sender.id) || "");
  const userAgent = String(payload.userAgent || "");
  const fp = (envId ? fingerprintsByEnvironmentId.get(envId) : null) || fingerprintsByUserAgent.get(userAgent) || normalizeFingerprint(null);
  event.returnValue = fp;
});

ipcMain.on("browser-history-add", (_event, entry) => {
  addHistoryEntry(entry);
});

ipcMain.handle("browser-history-suggestions", async (event, query) => {
  return getHistorySuggestions(query, 8, eventEnvironmentId(event));
});

ipcMain.handle("browser-shortcuts-list", async event => {
  return loadShortcuts(eventEnvironmentId(event));
});

ipcMain.handle("browser-shortcuts-save", async (event, items) => {
  return saveShortcuts(eventEnvironmentId(event), items);
});

ipcMain.handle("browser-top-sites", async (event, limit) => {
  return getTopSites(Number(limit) || 8, eventEnvironmentId(event));
});

ipcMain.on("browser-history-delete-url", (event, url) => {
  deleteHistoryURL(url, eventEnvironmentId(event));
});

ipcMain.handle("browser-bookmarks-list", async (event) => {
  return loadBookmarks(eventEnvironmentId(event));
});

ipcMain.on("browser-bookmark-add-current", (event, entry) => {
  addBookmark(entry, eventEnvironmentId(event));
});

ipcMain.on("browser-bookmark-icon-update", (event, entry) => {
  if (!entry) return;
  updateBookmarkIcon(entry.url, entry.icon, eventEnvironmentId(event));
});

ipcMain.on("bookmark-manager-add", (event, entry) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  addBookmark(entry, win && win._envId);
});

ipcMain.on("bookmark-manager-update", (event, entry) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  updateBookmark(entry, win && win._envId);
});

ipcMain.on("bookmark-manager-add-group", (event, name) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  addBookmarkGroup(name, win && win._envId);
});

ipcMain.on("bookmark-manager-delete", (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  deleteBookmark(id, win && win._envId);
});

ipcMain.on("bookmark-manager-delete-group", (event, id) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  deleteBookmarkGroup(id, win && win._envId);
});

ipcMain.on("bookmark-manager-open", (_event, url) => {
  openURLInActiveBrowser(url);
});

ipcMain.on("browser-show-more", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) console.log("show-more for env:", win._envId);
});

ipcMain.on("browser-show-history", (event) => {
  showHistoryWindow(eventEnvironmentId(event));
});

ipcMain.on("browser-show-bookmarks", (event) => {
  showBookmarkManager(eventEnvironmentId(event));
});

ipcMain.handle("browser-clear-data", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win._envId) return { ok: false, message: "未找到浏览器环境" };
  const ses = session.fromPartition(`persist:env_${win._envId}`);
  await ses.clearStorageData();
  await ses.clearCache();
  await ses.clearAuthCache();
  await ses.clearHostResolverCache();
  await ses.flushStorageData();
  return { ok: true };
});

ipcMain.handle("browser-clear-environment", async (_event, envId) => {
  if (!envId || !browserHelperProcesses.has(envId)) {
    return { ok: false, message: "请先打开该环境" };
  }
  try {
    return await clearEnvironmentDataViaCDP(envId);
  } catch (error) {
    console.error("clear environment data failed:", error);
    return { ok: false, message: error.message || "清理失败" };
  }
});

ipcMain.on("browser-open-downloads", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const dir = win && win._serialNum ? browserDownloadDir(win._serialNum) : app.getPath("downloads");
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle("browser-downloads-list", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return getDownloadsForWindow(win);
});

ipcMain.on("browser-download-open", (_event, targetPath) => {
  if (!targetPath) return;
  shell.showItemInFolder(String(targetPath));
});

ipcMain.on("browser-toggle-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setFullScreen(!win.isFullScreen());
});

// Network capture is explicitly enabled per webview. Chromium's debugger API
// exposes decoded HTTPS request/response metadata without installing a MITM CA.
const networkCaptureOwners = new Map(); // webContentsId -> owner renderer

function networkCaptureTarget(event, rawId) {
  const id = Number(rawId || 0);
  const target = electronWebContents.fromId(id);
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed() || !owner || owner.isDestroyed()) return null;
  // Only allow a browser chrome window to inspect one of its attached webviews.
  if (target.hostWebContents && target.hostWebContents !== owner.webContents) return null;
  return { id, target, owner };
}

ipcMain.handle("browser-network-start", async (event, rawId) => {
  const resolved = networkCaptureTarget(event, rawId);
  if (!resolved) return { ok: false, message: "未找到当前标签页" };
  const { id, target, owner } = resolved;
  try {
    if (!target.debugger.isAttached()) target.debugger.attach("1.3");
    networkCaptureOwners.set(id, owner.webContents);
    if (!target.__networkCaptureListener) {
      target.__networkCaptureListener = (_event, method, params) => {
        const receiver = networkCaptureOwners.get(id);
        if (!receiver || receiver.isDestroyed()) return;
        if (["Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.responseReceivedExtraInfo", "Network.dataReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(method)) {
          receiver.send("browser-network-event", { webContentsId: id, method, params });
        }
      };
      target.debugger.on("message", target.__networkCaptureListener);
      target.once("destroyed", () => networkCaptureOwners.delete(id));
    }
    await target.debugger.sendCommand("Network.enable", { maxTotalBufferSize: 200000000, maxResourceBufferSize: 50000000, maxPostDataSize: 50000000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message || "无法启动抓包" };
  }
});

ipcMain.handle("browser-network-stop", async (event, rawId) => {
  const resolved = networkCaptureTarget(event, rawId);
  if (!resolved) return { ok: true };
  const { id, target } = resolved;
  networkCaptureOwners.delete(id);
  try { if (target.debugger.isAttached()) await target.debugger.sendCommand("Network.disable"); } catch (e) {}
  return { ok: true };
});

ipcMain.handle("browser-network-response-body", async (event, rawId, requestId) => {
  const resolved = networkCaptureTarget(event, rawId);
  if (!resolved || networkCaptureOwners.get(resolved.id) !== event.sender) return { ok: false, message: "抓包未启用" };
  try {
    const body = await resolved.target.debugger.sendCommand("Network.getResponseBody", { requestId: String(requestId) });
    return { ok: true, body: body.body || "", base64Encoded: !!body.base64Encoded };
  } catch (error) {
    return { ok: false, message: error.message || "响应正文不可用" };
  }
});

ipcMain.handle("browser-network-request-body", async (event, rawId, requestId) => {
  const resolved = networkCaptureTarget(event, rawId);
  if (!resolved || networkCaptureOwners.get(resolved.id) !== event.sender) return { ok: false, message: "抓包未启用" };
  try {
    const result = await resolved.target.debugger.sendCommand("Network.getRequestPostData", { requestId: String(requestId) });
    return { ok: true, postData: result.postData || "" };
  } catch (error) {
    return { ok: false, message: error.message || "请求正文不可用" };
  }
});

ipcMain.on("browser-close-self", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

// Home page navigation IPC
ipcMain.on("browser-navigate", (event, url) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.send("browser-nav-to", url);
});

ipcMain.on("browser-go-blank", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.send("browser-nav-to", "about:blank");
});

// ========== App Lifecycle ==========

// ---- Enable Chrome DevTools Protocol for Python automation ----
(function setupRemoteDebugging() {
  const portArg = process.argv.find(a => a.startsWith('--remote-debugging-port='));
  let port = DEBUG_BASE_PORT;
  if (portArg) {
    port = parseInt(portArg.split('=')[1], 10) || port;
  } else if (IS_BROWSER_HELPER && HELPER_ENV_ID) {
    // Allocate unique port per helper process based on env-id hash
    let hash = 0;
    for (let i = 0; i < HELPER_ENV_ID.length; i++) {
      hash = ((hash << 5) - hash) + HELPER_ENV_ID.charCodeAt(i);
      hash |= 0;
    }
    port = DEBUG_BASE_PORT + (Math.abs(hash) % 1000);
  }
  activeDebugPort = port;
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  console.log(`[main] remote-debugging enabled on port ${port}`);
})();

app.whenReady().then(async () => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  if (isCertificateManagerStandalone()) app.setName("码友证书管理");
  const hasCertificateContextPath = isCertificateManagerStandalone() && !!CERTIFICATE_MANAGER_CONTEXT_PATH;
  let pendingCertificateContext = null;
  let pendingCertificateContextError = null;
  if (hasCertificateContextPath) {
    try { pendingCertificateContext = readCertificateManagerLaunchContext(CERTIFICATE_MANAGER_CONTEXT_PATH); }
    catch (error) { pendingCertificateContextError = error; }
  }
  if (pendingCertificateContext) applyCertificateManagerServerContext(pendingCertificateContext);
  if (!await enforceCurrentDesktopVersion(isCertificateManagerStandalone() ? "certificate-manager" : "browser")) return;
  applyApplicationDockIcon();
  installChineseMenu();
  if (IS_BROWSER_HELPER) {
    if (!HELPER_ENV_ID) {
      dialog.showErrorBox("启动失败", "缺少浏览器环境 ID。");
      app.quit();
      return;
    }
    openBrowserEnvironment(HELPER_ENV_ID).catch((e) => {
      dialog.showErrorBox("启动失败", e && e.message ? e.message : "无法启动浏览器。");
      app.quit();
    });
  } else {
    const daemonReady = await ensureDaemonStarted();
    if (!daemonReady) {
      console.warn("daemon is not available; using Electron local environment store");
    }
    if (isCertificateManagerStandalone()) {
      let contextApplied = false;
      if (pendingCertificateContextError) {
        dialog.showErrorBox("启动信息无效", pendingCertificateContextError.message || "无法读取浏览器启动信息");
        app.quit();
        return;
      }
      if (pendingCertificateContext) {
        try {
          contextApplied = await acceptCertificateManagerLaunchPayload(pendingCertificateContext);
          if (contextApplied) removeCertificateManagerLaunchContext(CERTIFICATE_MANAGER_CONTEXT_PATH);
        }
        catch (error) {
          console.warn("apply initial certificate-manager launch context failed:", error.message);
          dialog.showErrorBox("启动信息无效", error.message || "无法读取浏览器启动信息");
          app.quit();
          return;
        }
      } else if (hasCertificateContextPath) {
        dialog.showErrorBox("启动信息无效", "浏览器启动信息无效或已过期");
        app.quit();
        return;
      }
      if (!contextApplied) {
        const identity = independentCertificateManagerIdentity();
        appleDeveloperOwnerKey = identity.key;
        appleDeveloperAuthUserId = String(identity.userId || "").trim();
        appleDeveloperRecordId = "";
        appleDeveloperCertificateEnvironment = null;
        appleDeveloperAccountKey = "standalone-admin";
        if (!hasCertificateContextPath) restoreIndependentDeveloperAccount();
      }
      startCertificateManagerStatusHeartbeat();
      openCertificateManagerWindow(null);
      return;
    }
    createWindow();
    if (OPEN_ENVIRONMENT_ID) {
      openBrowserHelperProcess(OPEN_ENVIRONMENT_ID).catch(error => {
        console.warn("open requested browser environment failed:", error.message);
      });
    } else if (OPEN_CDP_PORT) {
      openBrowserEnvironmentByDebugPort(OPEN_CDP_PORT).catch((error) => {
        console.warn("[main] open by cdp port failed:", error && error.message ? error.message : error);
      });
    }
  }
}).catch(error => {
  console.error("application startup failed:", error && error.stack ? error.stack : error);
  try { dialog.showErrorBox("启动失败", error && error.message ? error.message : "应用启动失败"); } catch {}
  app.quit();
});
app.on("certificate-error", (event, webContents, url, error, certificate, callback) => {
  const owner = BrowserWindow.fromWebContents(webContents);
  const fp = owner && owner._fingerprint;
  const insecureHttpsOptIn = IS_SYNC_TEST_VARIANT || process.env.IPAUPLOADER_ALLOW_INSECURE_HTTPS === "1";
  const ignoreForWindow = insecureHttpsOptIn && !!(fp && fp.ignoreHttpsErrors);
  const ignoreForHelper = insecureHttpsOptIn && process.env.IPAUPLOADER_IGNORE_HTTPS_ERRORS === "1";
  if (ignoreForWindow || ignoreForHelper) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});
app.on("before-quit", event => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  if (!IS_BROWSER_HELPER && !isCertificateManagerStandalone() && !quittingAfterBrowserSync && (browserHelperProcesses.size || snapshotUploadTasks.size)) {
    event.preventDefault();
    if (!browserShutdownSyncPromise) {
      browserShutdownSyncPromise = closeAllBrowserHelpersAndSync()
        .catch(error => console.warn("browser shutdown sync failed:", error.message))
        .finally(() => {
          quittingAfterBrowserSync = true;
          stopManagedDaemon();
          app.quit();
        });
    }
    return;
  }
  closeAllBrowserHelpers();
  stopManagedDaemon();
  if (isCertificateManagerStandalone()) clearCertificateManagerStatus();
});
app.on("window-all-closed", () => {
  if (!HAS_SINGLE_INSTANCE_LOCK) return;
  closeAllBrowserHelpers();
  stopManagedDaemon();
  if (isCertificateManagerStandalone()) clearCertificateManagerStatus();
  // Close all browser windows
  for (const [id, win] of browserWindows) {
    if (!win.isDestroyed()) win.close();
  }
  browserWindows.clear();
  if (IS_BROWSER_HELPER || isCertificateManagerStandalone() || process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (IS_BROWSER_HELPER) return;
  if (BrowserWindow.getAllWindows().length !== 0) return;
  if (isCertificateManagerStandalone()) openCertificateManagerWindow(null);
  else createWindow();
});
