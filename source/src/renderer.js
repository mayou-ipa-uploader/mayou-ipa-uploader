// ========== State ==========
let environments = [];
let editingEnvId = null;
let currentFingerprint = null;
let moreMenuAnchor = null;
let currentHomeURLs = [];
let currentPage = 1;
let pageSize = 10;
const runningEnvIds = new Set();
const runningBrowserDetails = new Map();
let certificateManagerRunning = false;
let certificateManagerRunningAccountId = "";
let certificateManagerAuthenticated = false;
let activeView = "home";
let activeProxyTab = "manage";
let proxies = [];
let editingProxyId = null;
const selectedProxyKeys = new Set();
let windowProxyDropdownItems = [];
let selectedIPAPath = "";
let activeUploadTaskId = "";
let uploadPollTimer = null;
let renderedUploadEventCount = 0;
let uploadAIAnalysisBusy = false;
let uploadProxyDropdownItems = [];
let selectedUploadProxyKey = "";
let currentUser = null;
let developerDownloadAccountId = "";
let developerDownloadP12Password = "123456";
let developerExtendAccountId = "";
let developerExtendAppleId = "";
let editingDeveloperAccount = null;
const DEVELOPER_POLICY_NOTICE_KEY = "mayou-developer-policy-notice-v1";
const DEVELOPER_RENEWAL_NOTICE_KEY_PREFIX = "mayou-developer-renewal-notice-v1";
let pendingDeveloperRenewalNotice = null;
let developerRenewalPaymentTimer = null;
let developerRenewalPaymentOrderNo = "";
let developerRenewalPaymentFlowId = 0;
let developerRenewalPaymentCompleting = false;
let developerRenewalAccountId = "";
let developerAppScanAccountId = "";
let developerAppScanApps = [];
let developerAppRegionCurrentApp = null;
let developerAppRegionQrPayload = null;
let developerAppStatusPollTimer = null;
const developerAppStatusRefreshingIds = new Set();
const installedKernelVersions = new Set();
const lastKernelProgressPercent = new Map();
let kernelDownloadInProgress = "";
const deletingEnvIds = new Set();
const QIANLI_PROXY_URL = "https://qianliip.com/?invitationCode=0O91DXHPFMZDKAPC0SF6";
const SIMILARITY_BASE_URL = "https://similarity.msykeji.com";
let currentServerConfig = null;

function developerAppStatusBool(value) {
  return value === true || value === 1 || value === "1" || String(value || "").toLowerCase() === "true";
}

function normalizeDeveloperAppStatus(row = {}) {
  const syncAge = Number(row.syncAgeSeconds ?? row.sync_age_seconds);
  return {
    id: String(row.id || row.app_id || row.appId || ""),
    name: String(row.name || row.app_name || row.appName || "未命名 App"),
    bundleId: String(row.bundleId || row.bundle_id || ""),
    listed: developerAppStatusBool(row.listed),
    latestVersion: String(row.latestVersion || row.latest_version || ""),
    listedAt: String(row.listedAt || row.listed_at || ""),
    checkedAt: String(row.checkedAt || row.checked_at || ""),
    syncAgeSeconds: Number.isFinite(syncAge) ? syncAge : null,
    needsRefresh: developerAppStatusBool(row.needsRefresh ?? row.needs_refresh),
  };
}

function formatDeveloperAppStatusTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "未同步";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDeveloperAppStatusAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "";
  if (value < 60) return "刚刚";
  if (value < 3600) return `${Math.floor(value / 60)} 分钟前`;
  if (value < 86400) return `${Math.floor(value / 3600)} 小时前`;
  return `${Math.floor(value / 86400)} 天前`;
}

function clearDeveloperAppStatusPoll() {
  if (developerAppStatusPollTimer) {
    clearTimeout(developerAppStatusPollTimer);
    developerAppStatusPollTimer = null;
  }
}

function isDeveloperAppStatusOpen() {
  return document.getElementById("developer-app-scan-overlay")?.classList.contains("show");
}

function renderDeveloperAppStatusEmpty(message) {
  const rows = document.getElementById("developer-app-status-rows");
  if (rows) rows.innerHTML = `<tr><td colspan="6" class="developer-app-status-empty">${escapeDeveloperAccountHTML(message)}</td></tr>`;
}

function renderDeveloperAppStatusRows() {
  const rowsEl = document.getElementById("developer-app-status-rows");
  const summary = document.getElementById("developer-app-status-summary");
  const syncState = document.getElementById("developer-app-status-sync-state");
  if (!rowsEl) return;
  const rows = developerAppScanApps.map(normalizeDeveloperAppStatus).filter(item => /^\d{5,20}$/.test(item.id));
  developerAppScanApps = rows;
  const listed = rows.filter(item => item.listed).length;
  const stale = rows.filter(item => item.needsRefresh).length;
  if (summary) summary.innerHTML = rows.length ? `共 <strong>${rows.length}</strong> 个 AppID · 已上架 <strong>${listed}</strong> · 未上架 <strong>${rows.length - listed}</strong>` : "暂无 AppID";
  if (syncState) syncState.textContent = developerAppStatusRefreshingIds.size ? "正在刷新…" : (stale ? `${stale} 个待同步` : "状态已同步");
  if (!rows.length) {
    renderDeveloperAppStatusEmpty("还未同步账户 App");
    return;
  }
  rowsEl.innerHTML = rows.map(row => {
    const refreshing = developerAppStatusRefreshingIds.has(row.id);
    const statusText = row.listed ? "已上架" : "未上架";
    const versionText = row.listed && row.latestVersion ? row.latestVersion : "—";
    const syncText = formatDeveloperAppStatusTime(row.checkedAt);
    const ageText = refreshing ? "刷新中" : (row.needsRefresh ? "待同步" : formatDeveloperAppStatusAge(row.syncAgeSeconds));
    const regionButton = row.listed
      ? `<button class="developer-app-region-view" type="button" data-app-id="${escapeDeveloperAccountHTML(row.id)}">查看地区</button>`
      : "";
    return `<tr data-app-id="${escapeDeveloperAccountHTML(row.id)}">
      <td class="developer-app-status-name"><b>${escapeDeveloperAccountHTML(row.name || "未命名 App")}</b></td>
      <td class="developer-app-status-id"><code>${escapeDeveloperAccountHTML(row.id)}</code><small>${escapeDeveloperAccountHTML(row.bundleId || "—")}</small></td>
      <td><span class="developer-app-status-pill ${row.listed ? "listed" : "unlisted"}">${statusText}</span></td>
      <td class="developer-app-status-version"><b>${escapeDeveloperAccountHTML(versionText)}</b>${row.listedAt ? `<small>${escapeDeveloperAccountHTML(formatDeveloperAppStatusTime(row.listedAt))}</small>` : ""}</td>
      <td><div class="developer-app-status-sync"><span><b>${escapeDeveloperAccountHTML(syncText)}</b>${ageText ? `<small>${escapeDeveloperAccountHTML(ageText)}</small>` : ""}</span><button class="developer-app-status-refresh" type="button" data-app-id="${escapeDeveloperAccountHTML(row.id)}" ${refreshing ? "disabled" : ""}>${refreshing ? "刷新中…" : "刷新"}</button></div></td>
      <td class="developer-app-status-actions">${regionButton}</td>
    </tr>`;
  }).join("");
  rowsEl.querySelectorAll(".developer-app-status-refresh").forEach(button => {
    button.addEventListener("click", () => refreshDeveloperAppStatus(button.dataset.appId));
  });
  rowsEl.querySelectorAll(".developer-app-region-view").forEach(button => {
    button.addEventListener("click", () => openDeveloperAppRegions(button.dataset.appId));
  });
}

function closeDeveloperAppRegions() {
  document.getElementById("developer-app-regions-overlay")?.classList.remove("show");
  const rows = document.getElementById("developer-app-region-rows");
  if (rows) rows.innerHTML = "";
  const error = document.getElementById("developer-app-region-error");
  if (error) error.textContent = "";
  developerAppRegionCurrentApp = null;
}

function closeDeveloperAppRegionQR() {
  document.getElementById("developer-app-region-qr-overlay")?.classList.remove("show");
  const image = document.getElementById("developer-app-region-qr-image");
  if (image) image.removeAttribute("src");
  const link = document.getElementById("developer-app-region-qr-link");
  if (link) link.textContent = "";
  const error = document.getElementById("developer-app-region-qr-error");
  if (error) error.textContent = "";
  developerAppRegionQrPayload = null;
}

function developerAppStoreFallbackURL(appId, countryCode) {
  const id = String(appId || "").trim();
  const code = String(countryCode || "us").trim().toLowerCase() || "us";
  return `https://apps.apple.com/${encodeURIComponent(code)}/app/id${encodeURIComponent(id)}`;
}

async function copyDeveloperAppRegionLink(url) {
  const text = String(url || "").trim();
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.focus();
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    toast("下载链接已复制");
  } catch {
    toast("复制失败，请手动复制链接");
  }
}

function renderDeveloperAppRegionRows(regionRows, app) {
  const rowsEl = document.getElementById("developer-app-region-rows");
  const summary = document.getElementById("developer-app-region-summary");
  if (!rowsEl) return;
  const listedRows = (Array.isArray(regionRows) ? regionRows : [])
    .filter(row => row && row.listed)
    .map(row => ({
      code: String(row.code || "").trim().toUpperCase(),
      name: String(row.name || row.code || "地区"),
      url: String(row.url || "").trim() || developerAppStoreFallbackURL(app?.id, row.code),
      version: String(row.version || app?.latestVersion || ""),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  if (summary) summary.innerHTML = `已上架 <strong>${listedRows.length}</strong> 个国家或地区`;
  if (!listedRows.length) {
    rowsEl.innerHTML = '<tr><td colspan="4" class="developer-app-status-empty">没有扫描到已上架地区</td></tr>';
    return;
  }
  rowsEl.innerHTML = listedRows.map(row => `<tr>
    <td><b>${escapeDeveloperAccountHTML(row.name)}</b><small>${escapeDeveloperAccountHTML(row.code)}</small></td>
    <td>${escapeDeveloperAccountHTML(row.version || "—")}</td>
    <td><code>${escapeDeveloperAccountHTML(row.url)}</code></td>
    <td><div class="developer-app-region-actions"><button type="button" class="developer-app-copy-link" data-url="${escapeDeveloperAccountHTML(row.url)}">复制链接</button><button type="button" class="developer-app-save-qr" data-url="${escapeDeveloperAccountHTML(row.url)}" data-code="${escapeDeveloperAccountHTML(row.code)}" data-name="${escapeDeveloperAccountHTML(row.name)}">下载二维码</button><button type="button" class="developer-app-view-qr" data-url="${escapeDeveloperAccountHTML(row.url)}" data-code="${escapeDeveloperAccountHTML(row.code)}" data-name="${escapeDeveloperAccountHTML(row.name)}">查看二维码</button></div></td>
  </tr>`).join("");
  rowsEl.querySelectorAll(".developer-app-copy-link").forEach(button => {
    button.addEventListener("click", () => copyDeveloperAppRegionLink(button.dataset.url));
  });
  rowsEl.querySelectorAll(".developer-app-save-qr").forEach(button => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "生成中…";
      const result = await window.developerAccountManager.saveAppRegionQR({
        url: button.dataset.url,
        appName: app?.name || app?.id || "App",
        countryCode: button.dataset.code,
        countryName: button.dataset.name,
      }).catch(error => ({ success: false, error: error.message }));
      button.disabled = false;
      button.textContent = original;
      if (result?.success) toast("二维码已下载");
      else if (!result?.canceled) toast(result?.error || "二维码下载失败");
    });
  });
  rowsEl.querySelectorAll(".developer-app-view-qr").forEach(button => {
    button.addEventListener("click", () => showDeveloperAppRegionQR({
      url: button.dataset.url,
      appName: app?.name || app?.id || "App",
      countryCode: button.dataset.code,
      countryName: button.dataset.name,
    }));
  });
}

async function showDeveloperAppRegionQR(payload = {}) {
  const safePayload = {
    url: String(payload.url || "").trim(),
    appName: String(payload.appName || "App"),
    countryCode: String(payload.countryCode || ""),
    countryName: String(payload.countryName || "地区"),
  };
  developerAppRegionQrPayload = safePayload;
  const overlay = document.getElementById("developer-app-region-qr-overlay");
  const title = document.getElementById("developer-app-region-qr-title");
  const image = document.getElementById("developer-app-region-qr-image");
  const link = document.getElementById("developer-app-region-qr-link");
  const error = document.getElementById("developer-app-region-qr-error");
  if (title) title.textContent = `${safePayload.countryName || safePayload.countryCode || "地区"} · 下载二维码`;
  if (image) image.removeAttribute("src");
  if (link) link.textContent = safePayload.url;
  if (error) error.textContent = "正在生成二维码…";
  overlay?.classList.add("show");
  const result = await window.developerAccountManager.previewAppRegionQR(safePayload).catch(reason => ({ success: false, error: reason.message }));
  if (developerAppRegionQrPayload?.url !== safePayload.url || !document.getElementById("developer-app-region-qr-overlay")?.classList.contains("show")) return;
  if (!result?.success) {
    if (error) error.textContent = result?.error || "二维码生成失败";
    return;
  }
  if (image) image.src = result.qrDataURL;
  if (error) error.textContent = "";
}

function copyDeveloperAppRegionQRLink() {
  copyDeveloperAppRegionLink(developerAppRegionQrPayload?.url || "");
}

async function saveDeveloperAppRegionQRFromPreview() {
  if (!developerAppRegionQrPayload?.url) return;
  const button = document.getElementById("developer-app-region-qr-save");
  if (button) {
    button.disabled = true;
    button.textContent = "生成中…";
  }
  const result = await window.developerAccountManager.saveAppRegionQR(developerAppRegionQrPayload).catch(error => ({ success: false, error: error.message }));
  if (button) {
    button.disabled = false;
    button.textContent = "下载二维码";
  }
  if (result?.success) toast("二维码已下载");
  else if (!result?.canceled) {
    const error = document.getElementById("developer-app-region-qr-error");
    if (error) error.textContent = result?.error || "二维码下载失败";
  }
}

async function openDeveloperAppRegions(appId) {
  const app = developerAppScanApps.find(item => String(item.id || "") === String(appId || ""));
  if (!app?.listed) return;
  developerAppRegionCurrentApp = app;
  const overlay = document.getElementById("developer-app-regions-overlay");
  const title = document.getElementById("developer-app-region-title");
  const rows = document.getElementById("developer-app-region-rows");
  const summary = document.getElementById("developer-app-region-summary");
  const error = document.getElementById("developer-app-region-error");
  if (title) title.textContent = `${app.name || "App"} · 上架地区`;
  if (summary) summary.textContent = "正在扫描 App Store 地区…";
  if (error) error.textContent = "";
  if (rows) rows.innerHTML = '<tr><td colspan="4" class="developer-app-status-empty">正在扫描 App Store 地区…</td></tr>';
  overlay?.classList.add("show");
  const result = await window.developerAccountManager.scanAppRegions({ appId: app.id }).catch(reason => ({ success: false, error: reason.message }));
  if (developerAppRegionCurrentApp?.id !== app.id || !document.getElementById("developer-app-regions-overlay")?.classList.contains("show")) return;
  if (!result?.success) {
    if (summary) summary.textContent = "地区读取失败";
    if (rows) rows.innerHTML = '<tr><td colspan="4" class="developer-app-status-empty">地区读取失败</td></tr>';
    if (error) error.textContent = result?.error || "地区读取失败";
    return;
  }
  renderDeveloperAppRegionRows(result.rows || [], app);
}

function scheduleDeveloperAppStatusPoll(delay = 60000) {
  clearDeveloperAppStatusPoll();
  if (!isDeveloperAppStatusOpen() || !developerAppScanAccountId) return;
  developerAppStatusPollTimer = setTimeout(() => {
    loadDeveloperAppStatusList({ silent: true });
  }, delay);
}

// ========== DOM Refs ==========
const listEl = document.getElementById("list");
const summaryEl = document.getElementById("summary");
const searchEl = document.getElementById("search");
const toastEl = document.getElementById("toast");
const dlgOverlay = document.getElementById("dlg-overlay");
const dlgTitle = document.getElementById("dlg-title");
const dlgDelete = document.getElementById("dlg-delete");
const dlgClose = document.getElementById("dlg-close");
const moreMenuEl = document.getElementById("more-menu");
const noteInput = document.getElementById("dlg-note");
const noteCountEl = document.getElementById("dlg-note-count");
const proxyOverlay = document.getElementById("proxy-overlay");
const authPage = document.getElementById("auth-page");
const authLoginWebview = document.getElementById("auth-login-webview");
const accountMenu = document.getElementById("account-menu");
const similarityWebview = document.getElementById("similarity-webview");
const officialSiteUrl = document.getElementById("official-site-url");
let unifiedLoginPoll = null;
let unifiedLoginSyncTimer = null;

function buildPageURL(baseURL, pagePath = "/") {
  const normalizedBase = String(baseURL || "").trim().replace(/\/+$/, "");
  const rawPath = String(pagePath || "/").trim() || "/";
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath.replace(/^\/+/, "")}`;
  return `${normalizedBase}${normalizedPath}`;
}

function canShowSystemSettings() {
  return currentServerConfig?.systemSettingsEnabled === true;
}

function syncSystemSettingsVisibility() {
  const settingsNav = document.getElementById("nav-settings");
  if (settingsNav) settingsNav.classList.toggle("hidden", !canShowSystemSettings());
  if (!canShowSystemSettings() && activeView === "settings") switchMainView("browser");
}

async function loadServerConfig() {
  currentServerConfig = await window.serverConfig?.get?.() || null;
  if (officialSiteUrl) officialSiteUrl.textContent = currentServerConfig?.currentURL || SIMILARITY_BASE_URL;
  syncSystemSettingsVisibility();
  return currentServerConfig;
}

// ========== Init ==========
window.browser?.onKernelProgress?.(progress => {
  const help = document.getElementById("dlg-kernel-help");
  const version = String(progress?.version || "");
  const selected = document.getElementById("dlg-kernel-version")?.value || "";
  if (help && version === selected) {
    const downloaded = (Number(progress.received || 0) / 1024 / 1024).toFixed(1);
    const total = Number(progress.total || 0) ? ` / ${(Number(progress.total) / 1024 / 1024).toFixed(1)} MB` : " MB";
    setKernelUIState("downloading", version, `正在下载：${downloaded}${total}（${Number(progress.percent || 0)}%）`, Number(progress.percent || 0));
  }
  const percent = Number(progress?.percent || 0);
  const previous = lastKernelProgressPercent.get(version) || -10;
  if (percent >= 100 || percent - previous >= 10) {
    lastKernelProgressPercent.set(version, percent);
    toast(`正在下载 Chromium ${version} 内核：${percent}%`);
  }
});
document.getElementById("create").addEventListener("click", () => {
  if (requireLogin()) showDialog();
});
document.getElementById("user-entry")?.addEventListener("click", () => {
  if (!currentUser) {
    showLoginPage();
    return;
  }
  accountMenu?.classList.toggle("show");
});
document.getElementById("official-site-link")?.addEventListener("click", async () => {
  const config = currentServerConfig || await loadServerConfig();
  const result = await window.externalLink?.open?.(config?.currentURL || SIMILARITY_BASE_URL);
  if (!result?.success) toast(result?.error || "无法打开当前登录地址");
});

async function openDomesticProxyProvider() {
  const result = await window.externalLink?.open?.(QIANLI_PROXY_URL);
  if (!result?.success) toast(result?.error || "无法打开千里代理官网");
}

accountMenu?.addEventListener("click", async event => {
  const item = event.target.closest(".account-item");
  if (!item) return;
  accountMenu.classList.remove("show");
  if (item.dataset.accountAction === "logout") {
    await logout();
    return;
  }
  if (item.dataset.accountAction === "upload") {
    switchMainView("upload");
    return;
  }
  if (item.dataset.accountAction === "certificates") {
    openCertificateManager();
    return;
  }
  if (item.dataset.accountPath) {
    openSimilarityPage(item.dataset.accountPath);
  }
});
document.addEventListener("click", event => {
  if (event.target.closest("#account-menu") || event.target.closest("#user-entry")) return;
  accountMenu?.classList.remove("show");
});
document.getElementById("auth-page-close")?.addEventListener("click", closeLoginPage);
["dom-ready", "did-navigate", "did-navigate-in-page", "did-redirect-navigation", "did-stop-loading"].forEach(eventName => {
  authLoginWebview?.addEventListener(eventName, () => scheduleUnifiedLoginStateCheck(180));
});
document.getElementById("developer-extend-code")?.addEventListener("input", event => {
  event.target.value = event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
});
document.getElementById("developer-renewal-code")?.addEventListener("input", event => {
  event.target.value = event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
});
similarityWebview?.addEventListener("dom-ready", () => {
  const desktopLoggedIn = !!currentUser;
  similarityWebview.executeJavaScript(`
    (() => {
      let style = document.getElementById('desktop-hide-web-account');
      if (!style) {
        style = document.createElement('style');
        style.id = 'desktop-hide-web-account';
        style.textContent = \`
          #userMenuWrap, .user-menu-wrap, .top-avatar, .btn-login, .btn-register { display: none !important; }
          html { overflow-x: hidden !important; }
          body {
            padding: 96px 14px 30px !important;
            overflow-x: hidden !important;
            font-size: 14px !important;
            line-height: 1.5 !important;
          }
          body:has(.container > .top-bar) {
            padding: 0 14px 30px !important;
            background: #fff !important;
          }
          .top-right {
            height: 78px !important;
            min-height: 78px !important;
            padding: 0 clamp(28px, 8.7vw, 80px) !important;
            flex-direction: row !important;
            align-items: center !important;
            gap: 20px !important;
            font-size: 14px !important;
          }
          .nav-actions { width: auto !important; flex: 0 0 auto !important; justify-content: flex-end !important; }
          .nav-brand { gap: 10px !important; }
          .nav-brand-logo { width: 28px !important; height: 28px !important; }
          .nav-brand-name { font-size: 16px !important; }
          .nav-brand-sub { font-size: 12px !important; }
          .platform-switch {
            width: 244px !important;
            min-width: 244px !important;
            height: 52px !important;
            padding: 5px !important;
            overflow: visible !important;
          }
          .platform-switch-btn {
            flex: 1 1 0 !important;
            min-width: 0 !important;
            height: 40px !important;
            padding: 0 12px !important;
            justify-content: center !important;
            font-size: 14px !important;
          }
          .platform-switch-btn svg { width: 20px !important; height: 20px !important; }
          .platform-switch-btn .platform-label { font-size: 14px !important; }
          .container { width: 100% !important; max-width: 1180px !important; margin: 0 auto !important; }
          .header { gap: 22px !important; margin-bottom: 26px !important; }
          .eyebrow { font-size: 13px !important; margin-bottom: 7px !important; }
          .header h1 { font-size: 38px !important; line-height: 1.08 !important; margin-bottom: 12px !important; }
          .header p { font-size: 15px !important; line-height: 1.65 !important; }
          .mode-card { padding: 18px !important; }
          .mode-title { margin-bottom: 12px !important; font-size: 13px !important; }
          .mode-toggle button { min-height: 42px !important; font-size: 14px !important; }
          .upload-card { padding: 18px !important; }
          .card-title { margin-bottom: 14px !important; }
          .title-icon { width: 34px !important; height: 34px !important; font-size: 18px !important; }
          .title-main h2 { font-size: 17px !important; }
          .title-main p { font-size: 12px !important; }
          .badge { padding: 5px 10px !important; font-size: 11px !important; }
          .upload-area { min-height: 300px !important; }
          .upload-icon { width: 90px !important; height: 76px !important; font-size: 34px !important; }
          .upload-button { min-width: 210px !important; min-height: 52px !important; padding: 0 24px !important; font-size: 17px !important; }
          .upload-hint { font-size: 15px !important; }
          body:has(.history-shell) {
            height: 100vh !important;
            min-height: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
          body:has(.history-shell) .app-topbar { display: none !important; }
          body:has(.history-shell) .history-shell {
            width: calc(100% - 28px) !important;
            height: 100vh !important;
            min-height: 0 !important;
            margin: 0 auto !important;
            align-items: stretch !important;
            overflow: hidden !important;
          }
          body:has(.history-shell) .history-panel {
            position: static !important;
            top: auto !important;
            height: 100% !important;
            min-height: 0 !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
          }
          body:has(.history-shell) .history-list {
            flex: 1 1 auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow-y: auto !important;
            overscroll-behavior: contain !important;
          }
          body:has(.history-shell) .workspace {
            width: 100% !important;
            max-width: 100% !important;
            height: 100% !important;
            min-height: 0 !important;
            overflow-y: auto !important;
            overflow-x: hidden !important;
            align-content: start !important;
            overscroll-behavior: contain !important;
          }
          body:has(.history-shell) .empty-detail {
            grid-column: auto !important;
            width: 100% !important;
            height: 100% !important;
            min-height: 0 !important;
          }
          body:has(.history-shell) .workspace > *,
          body:has(.history-shell) .data-panel,
          body:has(.history-shell) .tab-panel,
          body:has(.history-shell) .table-wrap {
            min-width: 0 !important;
            max-width: 100% !important;
          }
          body:has(.history-shell) .tab-nav {
            flex-wrap: wrap !important;
            overflow-x: hidden !important;
          }
          body:has(.history-shell) .table-wrap { overflow-x: hidden !important; }
          body:has(.history-shell) table { table-layout: fixed !important; }
          body:has(.history-shell) th,
          body:has(.history-shell) td {
            overflow-wrap: anywhere !important;
            word-break: break-word !important;
          }
          body:has(.history-shell) .td-path { white-space: normal !important; }
          @media (max-width: 980px) {
            .header { grid-template-columns: 1fr !important; align-items: stretch !important; }
            .mode-card { width: 100% !important; }
            .upload-grid { grid-template-columns: 1fr !important; }
          }
          @media (max-width: 760px) {
            body { padding-left: 10px !important; padding-right: 10px !important; }
            .top-right { padding-left: 18px !important; padding-right: 18px !important; }
            .nav-brand-sub { display: none !important; }
            .platform-switch { width: 228px !important; min-width: 228px !important; }
          }
          @media (max-width: 640px) {
            body { padding: 88px 10px 24px !important; }
            .top-right { min-height: 78px !important; padding: 0 12px !important; }
            .nav-brand-name { display: none !important; }
            .nav-brand-sub { display: none !important; }
            .platform-switch { width: 210px !important; min-width: 210px !important; }
            .header h1 { font-size: 32px !important; }
            .upload-button { min-width: 190px !important; }
          }
        \`;
        document.head.appendChild(style);
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      window.__desktopClientLoggedIn = ${desktopLoggedIn ? "true" : "false"};
      if (location.pathname === '/profile/cards') {
        const selectedPackage = document.querySelector('.package-card.active:not(.sold-out)');
        const firstAvailablePackage = selectedPackage || document.querySelector('.package-card:not(.sold-out)');
        if (!selectedPackage && firstAvailablePackage && typeof window.selectPackage === 'function') {
          window.selectPackage(firstAvailablePackage);
        }
        if (firstAvailablePackage && !window.__cardPaymentAutoStarted && typeof window.createPayment === 'function') {
          window.__cardPaymentAutoStarted = true;
          window.createPayment();
        }
      }
      if (!window.__desktopAuthGuardInstalled) {
        window.__desktopAuthGuardInstalled = true;
        const requestDesktopLogin = event => {
          if (window.__desktopClientLoggedIn) return;
          const protectedButton = event.target && event.target.closest && event.target.closest('#detect-btn, #aab-detect-btn');
          if (!protectedButton) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (window.confirm('该功能需要登录，是否前往登录？')) console.info('__IPAUploader_OPEN_LOGIN__');
        };
        document.addEventListener('click', requestDesktopLogin, true);
        document.addEventListener('submit', event => {
          if (window.__desktopClientLoggedIn || event.target?.id !== 'detect-form') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (window.confirm('该功能需要登录，是否前往登录？')) console.info('__IPAUploader_OPEN_LOGIN__');
        }, true);
      }
    })();
  `).catch(() => {});
});
similarityWebview?.addEventListener("console-message", event => {
  if (String(event.message || "") === "__IPAUploader_OPEN_LOGIN__") showLoginPage();
});
listEl?.addEventListener("click", (event) => {
  const openButton = event.target.closest(".open-btn");
  if (openButton && listEl.contains(openButton)) {
    event.preventDefault();
    event.stopPropagation();
    openEnv(openButton.dataset.envId);
    return;
  }

  const moreButton = event.target.closest(".more-btn");
  if (moreButton && listEl.contains(moreButton)) {
    event.preventDefault();
    event.stopPropagation();
    showMoreMenu(event, moreButton.dataset.envId);
  }
});
dlgClose?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeDialog();
});
dlgClose?.addEventListener("pointerup", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeDialog();
});
dlgDelete?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  deleteEnv();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest || !event.target.closest("#dlg-delete")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  deleteEnv();
}, true);
document.addEventListener("click", (event) => {
  if (!event.target.closest || !event.target.closest("#dlg-close")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeDialog();
}, true);
noteInput?.addEventListener("input", updateNoteCount);
dlgOverlay?.addEventListener("click", (event) => {
  if (event.target === dlgOverlay) closeDialog();
});
window.addEventListener("resize", () => {
  if (moreMenuEl?.classList.contains("show")) positionMoreMenu();
});
window.addEventListener("scroll", () => {
  if (moreMenuEl?.classList.contains("show")) positionMoreMenu();
}, true);
document.addEventListener("click", (event) => {
  if (!moreMenuEl) return;
  if (event.target.closest(".more-btn") || event.target.closest("#more-menu")) return;
  closeMoreMenu();
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".proxy-more-wrap")) return;
  document.getElementById("proxy-more-menu")?.classList.remove("show");
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".window-proxy-detect") || event.target.closest("#window-detect-popover")) return;
  hideWindowDetectPopover();
});
moreMenuEl?.addEventListener("click", (event) => {
  const item = event.target.closest(".menu-item");
  if (!item) return;
  const action = item.dataset.action;
  const envId = item.dataset.envId;
  if (action === "edit") {
    closeMoreMenu();
    editEnv(envId);
  } else if (action === "restart") {
    restartEnv(envId);
  } else if (action === "close") {
    closeEnv(envId);
  } else if (action === "clear-data") {
    clearEnvironmentData(envId);
  }
});
window.browser?.onRunningState?.((data) => {
  if (!data || !data.envId) return;
  setRunningBrowserDetail(data);
  renderList();
});
window.auth?.onLoginSuccess?.(() => {
  syncUnifiedLoginState({ announce: true, goHome: true }).catch(() => {});
});
loadProxies();
hydrateProxyStorage();
(async () => {
  await loadServerConfig();
  await restoreLogin();
  await refresh();
})();

// ========== Account authentication ==========
async function showLoginPage() {
  startUnifiedLoginPolling();
  authPage?.classList.remove("hidden");
  if (authLoginWebview) {
    const config = currentServerConfig || await loadServerConfig();
    const target = `${config?.currentURL || SIMILARITY_BASE_URL}/login?desktop=1`;
    authLoginWebview.removeEventListener("dom-ready", injectDesktopWechatLogin);
    authLoginWebview.addEventListener("dom-ready", injectDesktopWechatLogin);
    if (authLoginWebview.getAttribute("src") === target) {
      try { authLoginWebview.reloadIgnoringCache(); } catch { authLoginWebview.reload(); }
    } else {
      authLoginWebview.setAttribute("src", target);
    }
    setTimeout(injectDesktopWechatLogin, 500);
  }
}

function injectDesktopWechatLogin() {
  if (!authLoginWebview || authLoginWebview.getAttribute("src") === "about:blank") return;
  const script = `(() => {
    if (window.__mayouDesktopWechatQrInjected) return;
    if (new URLSearchParams(location.search).get("desktop") !== "1") return;
    window.__mayouDesktopWechatQrInjected = true;
    const button = document.querySelector(".wechat-login");
    const avatar = document.getElementById("wechatAvatar");
    const name = document.getElementById("wechatName");
    const qr = document.getElementById("wechatQr");
    const note = document.getElementById("wechatQrNote");
    const error = document.getElementById("wechatError");
    if (!qr || !note) return;
    if (button) button.style.display = "none";
    if (avatar) avatar.style.display = "none";
    if (name) name.style.display = "none";
    if (error) { error.textContent = ""; error.style.display = "none"; }
    note.textContent = "正在生成微信扫码登录二维码…";
    note.style.display = "block";
    fetch("/auth/wechat/qr/start", { cache: "no-store" })
      .then(response => response.json().then(data => {
        if (!response.ok) throw new Error(data.error || "二维码生成失败");
        return data;
      }))
      .then(data => {
        qr.src = data.qr_image;
        qr.style.display = "block";
        note.textContent = "请使用手机微信扫码授权登录";
        const poll = setInterval(() => {
          fetch("/auth/wechat/qr/status/" + encodeURIComponent(data.ticket), { cache: "no-store" })
            .then(response => response.json())
            .then(status => {
              if (status.status === "authorized") {
                clearInterval(poll);
                note.textContent = "授权成功，正在登录…";
                if (typeof finishLogin === "function") finishLogin(status.redirect || "/");
                else location.href = status.redirect || "/";
              } else if (status.status === "scanned") {
                note.textContent = "已扫码，请在手机微信中完成授权";
              } else if (status.status === "pending_confirm") {
                note.textContent = "微信已授权，请在手机页面确认登录";
              } else if (status.status === "rejected") {
                clearInterval(poll);
                note.textContent = "手机端已取消授权，请刷新页面重新获取";
              } else if (status.status === "expired") {
                clearInterval(poll);
                note.textContent = "二维码已失效，请刷新页面重新获取";
              } else if (status.status === "error") {
                clearInterval(poll);
                note.textContent = status.error || "微信授权失败，请刷新页面重新获取";
              }
            })
            .catch(() => {});
        }, 1800);
        setTimeout(() => clearInterval(poll), Number(data.expires_in || 300) * 1000 + 5000);
      })
      .catch(err => {
        if (error) {
          error.textContent = err.message || "二维码生成失败";
          error.style.display = "block";
        }
        note.style.display = "none";
      });
  })();`;
  authLoginWebview.executeJavaScript(script, true).catch(() => {});
}

function hideLoginPage() {
  authPage?.classList.add("hidden");
}

function resetLoginWebview() {
  if (authLoginWebview?.getAttribute("src") !== "about:blank") {
    authLoginWebview?.setAttribute("src", "about:blank");
  }
}

function closeLoginPage() {
  hideLoginPage();
  stopUnifiedLoginPolling();
  resetLoginWebview();
}

async function syncAuthCookiesFromLoginWebview() {
  if (!authLoginWebview || authLoginWebview.getAttribute("src") === "about:blank") return false;
  const webContentsId = typeof authLoginWebview.getWebContentsId === "function" ? authLoginWebview.getWebContentsId() : 0;
  if (!webContentsId || !window.auth?.syncLoginCookies) return false;
  const result = await window.auth.syncLoginCookies(webContentsId);
  return !!result?.success;
}

function applyCurrentUser(user) {
  currentUser = user || null;
  const entry = document.getElementById("user-entry");
  const topAvatar = document.getElementById("user-top-avatar");
  const topRole = document.getElementById("user-top-role");
  if (entry) entry.title = currentUser ? `${currentUser.username} · ${currentUser.login_type === "employee" ? "员工" : "老板"}` : "未登录";
  if (topAvatar) topAvatar.childNodes[0].nodeValue = currentUser ? String(currentUser.username || "U").slice(0, 1).toUpperCase() : "U";
  if (topRole) {
    topRole.textContent = currentUser ? (currentUser.login_type === "employee" ? "员工" : "老板") : "";
    topRole.className = `user-top-role${currentUser?.login_type === "employee" ? " employee" : ""}${currentUser ? "" : " hidden"}`;
  }
  accountMenu?.classList.remove("show");
  const createButton = document.getElementById("create");
  if (createButton) {
    createButton.disabled = !currentUser;
    createButton.title = currentUser ? "创建浏览器窗口" : "请先登录";
  }
  syncSystemSettingsVisibility();
  renderList();
  renderHomeDashboard();
  if (!currentUser) return;
  const displayId = currentUser.login_type === "employee" ? currentUser.sub_account_id : currentUser.id;
  document.getElementById("account-avatar").textContent = String(currentUser.username || "U").slice(0, 1).toUpperCase();
  document.getElementById("account-name").textContent = currentUser.username || "用户";
  const membershipLevel = String(currentUser.membership_level || "free");
  const membershipBase = membershipLevel.split("_")[0];
  const membershipLabels = {
    free: "免费用户",
    normal: "普通会员",
    normal_monthly: "普通会员·月度",
    normal_quarterly: "普通会员·季度",
    normal_yearly: "普通会员·年度",
    enterprise: "企业会员",
    enterprise_monthly: "企业会员·月度",
    enterprise_quarterly: "企业会员·季度",
    enterprise_yearly: "企业会员·年度",
  };
  const role = document.getElementById("account-role");
  role.textContent = membershipLabels[membershipLevel] || membershipLabels[membershipBase] || "免费用户";
  role.className = `account-role ${membershipBase}`;
  document.getElementById("account-id").textContent = `ID: ${String(displayId || 0).padStart(8, "0")}`;
  const expire = document.getElementById("account-expire");
  const expireDate = formatMembershipExpireDate(currentUser.membership_expire);
  expire.textContent = expireDate ? `有效期至 ${expireDate}${currentUser.login_type === "employee" ? " · 员工账户" : ""}` : (currentUser.login_type === "employee" ? "员工账户" : "");
}

function reloadSimilarityForAuthChange() {
  if (!similarityWebview) return;
  const src = similarityWebview.getAttribute("src") || "";
  if (!src || src === "about:blank") return;
  try { similarityWebview.reloadIgnoringCache(); } catch { similarityWebview.reload(); }
}

async function restoreLogin() {
  if (!window.auth?.me) return;
  const result = await window.auth.me();
  if (result?.success && result.user) {
    applyCurrentUser(result.user);
    hideLoginPage();
  } else {
    applyCurrentUser(null);
    hideLoginPage();
  }
}

function stopUnifiedLoginPolling() {
  if (unifiedLoginPoll) {
    clearInterval(unifiedLoginPoll);
    unifiedLoginPoll = null;
  }
  if (unifiedLoginSyncTimer) {
    clearTimeout(unifiedLoginSyncTimer);
    unifiedLoginSyncTimer = null;
  }
}

async function syncUnifiedLoginState({ announce = false, goHome = true } = {}) {
  await syncAuthCookiesFromLoginWebview().catch(() => {});
  const result = await window.auth?.me?.();
  if (!result?.success || !result.user) return false;
  const shouldToast = announce && (!currentUser || currentUser.id !== result.user.id || currentUser.login_type !== result.user.login_type || currentUser.username !== result.user.username);
  applyCurrentUser(result.user);
  hideLoginPage();
  stopUnifiedLoginPolling();
  resetLoginWebview();
  if (shouldToast) toast("登录成功");
  reloadSimilarityForAuthChange();
  await refresh();
  if (goHome) switchMainView("home");
  return true;
}

function scheduleUnifiedLoginStateCheck(delay = 180) {
  if (unifiedLoginSyncTimer) clearTimeout(unifiedLoginSyncTimer);
  unifiedLoginSyncTimer = setTimeout(() => {
    unifiedLoginSyncTimer = null;
    syncUnifiedLoginState({ announce: true }).catch(() => {});
  }, delay);
}

function startUnifiedLoginPolling() {
  stopUnifiedLoginPolling();
  const checkLogin = async () => {
    await syncUnifiedLoginState({ announce: true }).catch(() => {});
  };
  checkLogin();
  unifiedLoginPoll = setInterval(checkLogin, 1200);
}

async function logout() {
  await window.auth?.logout?.();
  applyCurrentUser(null);
  environments = [];
  runningEnvIds.clear();
  runningBrowserDetails.clear();
  renderList();
  renderProxyList();
  reloadSimilarityForAuthChange();
  showLoginPage();
}

// ========== Data Loading ==========
async function refresh() {
  try {
    environments = await window.daemon.listEnvironments();
    if (window.browser?.runningList) {
      const runningItems = await window.browser.runningList();
      runningEnvIds.clear();
      runningBrowserDetails.clear();
      (runningItems || []).forEach(item => setRunningBrowserDetail(item));
    }
    if (window.developerAccountManager?.certificateManagerRunning) {
      const status = await window.developerAccountManager.certificateManagerRunning();
      certificateManagerRunning = !!status?.running;
      certificateManagerRunningAccountId = certificateManagerRunning ? String(status?.accountId || "") : "";
      certificateManagerAuthenticated = certificateManagerRunning && status?.authenticated === true;
    }
  } catch (e) {
    environments = [];
    toast("daemon: offline");
  }
  renderList();
  renderProxyList();
  renderHomeDashboard();
  if (activeView === "upload") renderUploadProxyOptions();
}

function setRunningBrowserDetail(item) {
  const detail = typeof item === "string" ? { envId: item, running: true } : (item || {});
  if (!detail.envId) return;
  if (detail.running === false) {
    runningEnvIds.delete(detail.envId);
    runningBrowserDetails.delete(detail.envId);
    return;
  }
  runningEnvIds.add(detail.envId);
  runningBrowserDetails.set(detail.envId, detail);
}

function runningAutomationLabel(envId) {
  const detail = runningBrowserDetails.get(envId);
  if (!detail || !detail.debugPort) return "";
  const mode = detail.mode === "helper" ? "独立进程" : "应用窗口";
  return ` · CDP ${detail.debugPort} · ${mode}`;
}

function configuredAutomationLabel(env) {
  const port = Number(env?.debugPort || 0);
  return port > 0 ? ` · CDP ${port}` : "";
}

function escapeHomeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function homeQuotaText(used, limit) {
  const safeUsed = Math.max(0, Number(used || 0));
  const safeLimit = Math.max(0, Number(limit || 0));
  return safeLimit > 0 ? `${safeUsed} / ${safeLimit}` : `${safeUsed} / 不限`;
}

function homeLimitText(limit, zeroIsUnlimited = true) {
  const value = Number(limit || 0);
  return value < 0 || (value === 0 && zeroIsUnlimited) ? "不限" : String(value);
}


function formatMembershipExpireDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function homeMembershipLabel(user) {
  const labels = { free: "免费用户", normal: "普通会员", enterprise: "企业会员" };
  const level = String(user?.membership_level || "free");
  return labels[level] || labels[level.split("_")[0]] || level;
}

function renderHomeDashboard() {
  const content = document.getElementById("home-content");
  if (!content) return;
  if (!currentUser) {
    content.innerHTML = `<div class="home-login"><div class="home-login-icon">U</div><h2>登录后查看账户总览</h2><p>登录后可以查看会员、检测卡、浏览器环境和月度使用额度。</p><button class="primary" type="button" onclick="showLoginPage()">立即登录</button></div>`;
    return;
  }
  const usage = currentUser.monthly_usage || {};
  const quotas = currentUser.quota_config || {};
  const maxWindows = Math.max(0, Number(currentUser.max_browser_windows ?? 10) || 0);
  const browserLimit = maxWindows > 0 ? String(maxWindows) : "不限";
  const maxDeveloperAccounts = Math.max(0, Number(currentUser.max_developer_accounts || 0) || 0);
  const developerAccountsUsed = Math.max(0, Number(currentUser.developer_accounts_used || 0) || 0);
  const developerAccountLimit = maxDeveloperAccounts > 0 ? String(maxDeveloperAccounts) : "不限";
  const expire = formatMembershipExpireDate(currentUser.membership_expire) || "未开通";
  const serverLabel = currentServerConfig?.buildVariant === "test" ? "测试服务器" : "正式服务器";
  const subMax = Number(quotas.max_sub_accounts || 0);
  const subUsed = Number(currentUser.sub_accounts_used || 0);
  const subText = subMax > 0 ? `${subUsed} / ${subMax}` : (currentUser.is_employee ? "员工账户" : "未开通");
  const aiUsed = Number(usage.ai_analyze_count || 0);
  const uploadUsed = Number(usage.upload_count || 0);
  content.innerHTML = `
    <div class="home-hero"><div><h1>账户总览</h1><p>查看当前账户配置、额度和常用功能。</p></div><div class="home-hero-actions"><button type="button" onclick="switchMainView('browser')">浏览器窗口</button><button class="primary" type="button" onclick="openSimilarityPage('/profile/cards')">购买检测卡</button></div></div>
    <section class="home-identity">
      <div class="home-identity-item"><span class="home-identity-label">当前账户</span><span class="home-identity-value">${escapeHomeHTML(currentUser.username || "用户")}</span></div>
      <div class="home-identity-item"><span class="home-identity-label">身份</span><span class="home-identity-value">${currentUser.login_type === "employee" ? "员工账户" : "主账户"}</span></div>
      <div class="home-identity-item"><span class="home-identity-label">会员等级</span><span class="home-identity-value accent">${escapeHomeHTML(homeMembershipLabel(currentUser))}</span></div>
      <div class="home-identity-item"><span class="home-identity-label">有效期</span><span class="home-identity-value">${escapeHomeHTML(expire)}</span></div>
      <div class="home-identity-item"><span class="home-identity-label">检测卡余额</span><span class="home-identity-value accent">${homeLimitText(currentUser.detect_quota, false)} 次</span></div>
    </section>
    <section class="home-metrics">
      <div class="home-metric"><div class="home-metric-head"><span class="home-metric-label">浏览器环境</span><span class="home-metric-icon">▣</span></div><div class="home-metric-value">${environments.length} / ${browserLimit}</div><div class="home-metric-note">已创建 / 可用额度</div></div>
      <div class="home-metric"><div class="home-metric-head"><span class="home-metric-label">证书管理账户</span><span class="home-metric-icon">A</span></div><div class="home-metric-value">${developerAccountsUsed} / ${developerAccountLimit}</div><div class="home-metric-note">已添加 / 可添加总数</div></div>
      <div class="home-metric"><div class="home-metric-head"><span class="home-metric-label">IPA 上传</span><span class="home-metric-icon">↑</span></div><div class="home-metric-value">${homeQuotaText(uploadUsed, quotas.ipa_upload_count)}</div><div class="home-metric-note">本月已用 / 本月额度</div></div>
      <div class="home-metric"><div class="home-metric-head"><span class="home-metric-label">AI 分析</span><span class="home-metric-icon">✦</span></div><div class="home-metric-value">${homeQuotaText(aiUsed, quotas.ai_analyze_quota)}</div><div class="home-metric-note">本月已用 / 本月额度</div></div>
      <div class="home-metric"><div class="home-metric-head"><span class="home-metric-label">员工账户</span><span class="home-metric-icon">◎</span></div><div class="home-metric-value">${escapeHomeHTML(subText)}</div><div class="home-metric-note">已使用 / 可配置额度</div></div>
    </section>
    <div class="home-columns">
      <section class="home-panel"><div class="home-panel-head"><h2>账户配置</h2><button type="button" onclick="openSimilarityPage('/profile/settings')">个人设置</button></div><div class="home-config-list">
        <div class="home-config-item"><span class="home-config-label">账户 ID</span><span class="home-config-value">${escapeHomeHTML(String(currentUser.login_type === "employee" ? currentUser.sub_account_id : currentUser.id).padStart(8, "0"))}</span></div>
        <div class="home-config-item"><span class="home-config-label">服务器环境</span><span class="home-config-value ok">${serverLabel}</span></div>
        <div class="home-config-item"><span class="home-config-label">检测月额度</span><span class="home-config-value">${homeLimitText(quotas.ipa_detect_quota, false)} 次 / 月</span></div>
        <div class="home-config-item"><span class="home-config-label">上传包名额度</span><span class="home-config-value">${homeLimitText(quotas.ipa_upload_bundles)} 个 / 月</span></div>
        <div class="home-config-item"><span class="home-config-label">开发者账户</span><span class="home-config-value">${currentUser.can_review ? "已开通" : "未开通"}</span></div>
        <div class="home-config-item"><span class="home-config-label">系统设置</span><span class="home-config-value">${currentUser.can_system_settings ? "可用" : "正式包隐藏"}</span></div>
      </div></section>
      <section class="home-panel"><div class="home-panel-head"><h2>常用功能</h2></div><div class="home-quick-list">
        <button class="home-quick" type="button" onclick="switchMainView('browser')"><span class="home-quick-icon">▣</span><span class="home-quick-text"><strong>浏览器窗口</strong><span>创建和管理环境</span></span></button>
        <button class="home-quick" type="button" onclick="openSimilarityPage('/')"><span class="home-quick-icon">⌁</span><span class="home-quick-text"><strong>相似度检测</strong><span>上传 IPA 开始检测</span></span></button>
        <button class="home-quick" type="button" onclick="switchMainView('proxy')"><span class="home-quick-icon">IP</span><span class="home-quick-text"><strong>代理 IP</strong><span>管理和检测代理</span></span></button>
        <button class="home-quick" type="button" onclick="switchMainView('upload')"><span class="home-quick-icon">↑</span><span class="home-quick-text"><strong>IPA 包上传</strong><span>查看上传配置和日志</span></span></button>
      </div></section>
    </div>`;
}

function switchMainView(view, title = "") {
  activeView = ["home", "browser", "proxy", "upload", "similarity", "settings", "developer-accounts", "help", "placeholder"].includes(view) ? view : "placeholder";
  document.getElementById("home-view")?.classList.toggle("hidden", activeView !== "home");
  document.getElementById("browser-view")?.classList.toggle("hidden", activeView !== "browser");
  document.getElementById("proxy-view")?.classList.toggle("hidden", activeView !== "proxy");
  document.getElementById("upload-view")?.classList.toggle("hidden", activeView !== "upload");
  document.getElementById("similarity-view")?.classList.toggle("hidden", activeView !== "similarity");
  document.getElementById("settings-view")?.classList.toggle("hidden", activeView !== "settings");
  document.getElementById("developer-accounts-view")?.classList.toggle("hidden", activeView !== "developer-accounts");
  document.getElementById("help-view")?.classList.toggle("hidden", activeView !== "help");
  document.getElementById("placeholder-view")?.classList.toggle("hidden", activeView !== "placeholder");
  const contentShell = document.querySelector(".content-shell");
  contentShell?.classList.toggle("similarity-active", activeView === "similarity");
  contentShell?.classList.toggle("developer-accounts-active", activeView === "developer-accounts");
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  if (activeView === "home") document.getElementById("nav-home")?.classList.add("active");
  if (activeView === "browser") document.getElementById("nav-browser")?.classList.add("active");
  if (activeView === "proxy") document.getElementById("nav-proxy")?.classList.add("active");
  if (activeView === "similarity") document.getElementById("nav-similarity")?.classList.add("active");
  if (activeView === "upload") {
    document.getElementById("nav-upload")?.classList.add("active");
    refreshUploadView();
  }
  if (activeView === "settings") document.getElementById("nav-settings")?.classList.add("active");
  if (activeView === "developer-accounts") {
    document.getElementById("nav-certificates")?.classList.add("active");
    loadDeveloperAccounts();
  }
  if (activeView === "help") document.getElementById("nav-help")?.classList.add("active");
  if (activeView === "placeholder") {
    const trigger = typeof event === "undefined" ? null : event?.currentTarget;
    trigger?.classList?.add("active");
    const titleEl = document.getElementById("placeholder-title");
    if (titleEl) titleEl.textContent = title ? `${title}开发中` : "功能开发中";
  }
  if (activeView === "proxy") renderProxyList();
}

async function openCertificateManager() {
  if (!currentUser) {
    showLoginPage();
    toast("请先登录后查看我的开发者账户");
    return;
  }
  switchMainView("developer-accounts");
}

function escapeDeveloperAccountHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatDeveloperAccountDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "未注册";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function developerAccessDeadline(access) {
  if (!access?.trialStarted) return "后台未注册";
  return formatDeveloperAccountDate(access.authorizationExpiresAt || access.trialExpiresAt);
}

function developerAccessStatus(access) {
  if (access?.authorizationExpired || (!access?.allowed && access?.trialStarted)) return { text: "已到期", expired: true, warning: true };
  if (!access?.trialStarted) return { text: "未注册", expired: false };
  const remainingDays = Number(access.remainingDays);
  if (Number.isFinite(remainingDays) && remainingDays <= 5) {
    return { text: `剩余 ${Math.max(0, Math.ceil(remainingDays))} 天`, expired: false, warning: true };
  }
  return { text: "可用", expired: false, warning: false };
}

function developerAccessExpired(access) {
  return !!access && (access.allowed === false || access.authorizationExpired === true);
}

function compareDeveloperAccountsByRenewal(left, right) {
  const leftDays = Number(left?.access?.remainingDays);
  const rightDays = Number(right?.access?.remainingDays);
  const leftNeedsRenewal = developerAccessExpired(left?.access) || (Number.isFinite(leftDays) && leftDays > 0 && leftDays <= 5);
  const rightNeedsRenewal = developerAccessExpired(right?.access) || (Number.isFinite(rightDays) && rightDays > 0 && rightDays <= 5);
  if (leftNeedsRenewal !== rightNeedsRenewal) return leftNeedsRenewal ? -1 : 1;
  if (Number.isFinite(leftDays) && Number.isFinite(rightDays) && leftDays !== rightDays) return leftDays - rightDays;
  const leftDate = new Date(left?.access?.authorizationExpiresAt || left?.access?.trialExpiresAt || 0).getTime();
  const rightDate = new Date(right?.access?.authorizationExpiresAt || right?.access?.trialExpiresAt || 0).getTime();
  if (leftDate !== rightDate) return leftDate - rightDate;
  return String(left?.appleId || "").localeCompare(String(right?.appleId || ""));
}

function developerConnectionLabel(row) {
  const mode = String(row?.connectionMode || (row?.proxy ? "custom_proxy" : "direct"));
  if (mode === "browser_proxy") {
    const proxy = row.proxy || {};
    if (proxy.host) return `浏览器代理 · ${(proxy.type || "HTTP").toUpperCase()} ${proxy.host}:${proxy.port || ""}`;
    return row.browserProxyKey ? `浏览器代理 · ${row.browserProxyKey}` : "浏览器代理";
  }
  if (mode === "custom_proxy") {
    const proxy = row.proxy || {};
    return proxy.host ? `自定义代理 · ${(proxy.type || "HTTP").toUpperCase()} ${proxy.host}:${proxy.port || ""}` : "自定义代理";
  }
  return "直连模式";
}

function developerAccountReminderKey(row) {
  const access = row?.access || {};
  return [
    String(row?.id || ""),
    String(access.authorizationExpiresAt || access.trialExpiresAt || ""),
    String(access.remainingDays ?? ""),
  ].join("|");
}

function developerAccountShouldRemind(row) {
  const access = row?.access || {};
  const days = Number(access.remainingDays);
  const trackable = !!(access.trialStarted || access.activated || access.firstLoginAt || access.authorizationExpiresAt || access.trialExpiresAt);
  return trackable && Number.isFinite(days) && days > 0 && days <= 5;
}

function pickDeveloperRenewalTarget(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(developerAccountShouldRemind)
    .sort((left, right) => {
      const leftDays = Number(left?.access?.remainingDays);
      const rightDays = Number(right?.access?.remainingDays);
      if (leftDays !== rightDays) return leftDays - rightDays;
      const leftDate = new Date(left?.access?.authorizationExpiresAt || left?.access?.trialExpiresAt || 0).getTime();
      const rightDate = new Date(right?.access?.authorizationExpiresAt || right?.access?.trialExpiresAt || 0).getTime();
      return leftDate - rightDate;
    })[0] || null;
}

function showDeveloperPolicyDialog() {
  if (sessionStorage.getItem(DEVELOPER_POLICY_NOTICE_KEY) === "1") return false;
  const overlay = document.getElementById("developer-policy-overlay");
  if (!overlay || overlay.classList.contains("show")) return false;
  overlay.classList.add("show");
  return true;
}

function flushDeveloperRenewalNotice() {
  if (!pendingDeveloperRenewalNotice) return;
  const { row, key } = pendingDeveloperRenewalNotice;
  if (sessionStorage.getItem(key) === "1") {
    pendingDeveloperRenewalNotice = null;
    return;
  }
  const overlay = document.getElementById("developer-renewal-overlay");
  if (!overlay) return;
  const access = row?.access || {};
  const remainingDays = Math.max(0, Math.ceil(Number(access.remainingDays) || 0));
  const expired = developerAccessExpired(access);
  document.getElementById("developer-renewal-account").textContent = `${row?.appleId || "该账户"} · ${expired ? "已到期" : `剩余 ${remainingDays} 天`}`;
  document.getElementById("developer-renewal-copy").textContent = expired
    ? `你的账户 ${row?.appleId || "未知账户"} 已到期，到期后无法继续启动证书管理，请先续费。`
    : `你的账户 ${row?.appleId || "未知账户"} 将在 ${remainingDays} 天内到期，到期以后无法进行任何服务，请及时续费。`;
  document.getElementById("developer-renewal-days").textContent = "到期后服务器会按账户有效期策略自动清理证书数据。";
  document.getElementById("developer-renewal-error").textContent = "";
  const codeInput = document.getElementById("developer-renewal-code");
  if (codeInput) codeInput.value = "";
  overlay.classList.add("show");
  sessionStorage.setItem(key, "1");
}

function showDeveloperRenewalDialog(row) {
  if (!row) return;
  const key = `${DEVELOPER_RENEWAL_NOTICE_KEY_PREFIX}:${developerAccountReminderKey(row)}`;
  sessionStorage.removeItem(key);
  pendingDeveloperRenewalNotice = { row, key };
  const paymentArea = document.getElementById("developer-renewal-payment");
  if (paymentArea) {
    paymentArea.classList.remove("show");
    paymentArea.innerHTML = "";
  }
  flushDeveloperRenewalNotice();
  setTimeout(() => {
    if (document.getElementById("developer-renewal-overlay")?.classList.contains("show")) {
      openDeveloperRenewalPurchase("alipay");
    }
  }, 80);
}

function closeDeveloperPolicyDialog() {
  document.getElementById("developer-policy-overlay")?.classList.remove("show");
  sessionStorage.setItem(DEVELOPER_POLICY_NOTICE_KEY, "1");
  flushDeveloperRenewalNotice();
}

function closeDeveloperRenewalDialog() {
  document.getElementById("developer-renewal-overlay")?.classList.remove("show");
  document.getElementById("developer-renewal-error").textContent = "";
  const codeInput = document.getElementById("developer-renewal-code");
  if (codeInput) codeInput.value = "";
  pendingDeveloperRenewalNotice = null;
  developerRenewalAccountId = "";
  developerRenewalPaymentFlowId += 1;
  developerRenewalPaymentCompleting = false;
  developerRenewalPaymentOrderNo = "";
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const paymentArea = document.getElementById("developer-renewal-payment");
  if (paymentArea) {
    paymentArea.classList.remove("show");
    paymentArea.innerHTML = "";
  }
}

function queueDeveloperAccountNotices(rows) {
  const target = pickDeveloperRenewalTarget(rows);
  pendingDeveloperRenewalNotice = target ? { row: target, key: `${DEVELOPER_RENEWAL_NOTICE_KEY_PREFIX}:${developerAccountReminderKey(target)}` } : null;
  if (pendingDeveloperRenewalNotice && sessionStorage.getItem(pendingDeveloperRenewalNotice.key) === "1") {
    pendingDeveloperRenewalNotice = null;
  }
  const policyOverlay = document.getElementById("developer-policy-overlay");
  if (sessionStorage.getItem(DEVELOPER_POLICY_NOTICE_KEY) !== "1") {
    if (policyOverlay?.classList.contains("show")) return;
    if (showDeveloperPolicyDialog()) return;
  }
  flushDeveloperRenewalNotice();
}

function renderDeveloperBrowserPayment(areaId, statusId, result, payMethod) {
  const area = document.getElementById(areaId);
  if (!area) return;
  const amount = Number(result.amount || 0);
  const label = payMethod === "wechat" ? "微信支付" : "支付宝付款";
  const paymentPane = result.payment_flow === "embedded" && result.pay_url
    ? `<iframe src="${escapeDeveloperAccountHTML(result.pay_url)}" title="${label}"></iframe>`
    : result.qr_image
    ? `<img src="${escapeDeveloperAccountHTML(result.qr_image)}" alt="${label}二维码">`
    : `<div class="developer-renewal-payment-fallback">订单已创建，请在付款页面完成支付。</div>`;
  area.innerHTML = `${paymentPane}<span class="developer-renewal-price"><b>${label}</b><strong>¥${amount.toFixed(2)}</strong><small id="${escapeDeveloperAccountHTML(statusId)}">等待支付…</small></span>`;
  area.classList.add("show");
}

function setDeveloperPayMethodActive(prefix, payMethod) {
  document.getElementById(`${prefix}-alipay`)?.classList.toggle("active", payMethod === "alipay");
  document.getElementById(`${prefix}-wechat`)?.classList.toggle("active", payMethod === "wechat");
}

async function refreshDeveloperAccountsAfterRenewal() {
  await loadDeveloperAccounts();
  setTimeout(() => loadDeveloperAccounts(), 1200);
}

function showDeveloperRenewalSuccess(message = "续费成功，账户有效期已更新。") {
  toast("续费成功");
  setTimeout(() => alert(message), 60);
}

async function openDeveloperRenewalPurchase(payMethod = "alipay") {
  const flowId = ++developerRenewalPaymentFlowId;
  developerRenewalPaymentCompleting = false;
  developerRenewalPaymentOrderNo = "";
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const button = document.getElementById("developer-renewal-alipay");
  const wechatButton = document.getElementById("developer-renewal-wechat");
  const activeButton = payMethod === "wechat" ? wechatButton : button;
  setDeveloperPayMethodActive("developer-renewal", payMethod);
  if (button) {
    button.disabled = true;
  }
  if (wechatButton) wechatButton.disabled = true;
  if (activeButton) {
    activeButton.textContent = "生成中…";
  }
  const row = pendingDeveloperRenewalNotice?.row || null;
  const result = await window.developerAccountManager.createRenewalPayment({
    pay_method: payMethod,
    code_type: "normal",
    purchase_source: "certificate_manager_browser",
    developer_account_id: row?.id || developerRenewalAccountId || "",
    developer_apple_id: row?.appleId || "",
  });
  if (flowId !== developerRenewalPaymentFlowId || !document.getElementById("developer-renewal-overlay")?.classList.contains("show")) return;
  if (button) {
    button.disabled = false;
    button.textContent = "支付宝";
  }
  if (wechatButton) {
    wechatButton.disabled = false;
    wechatButton.textContent = "微信";
  }
  if (!result?.success) {
    document.getElementById("developer-renewal-error").textContent = result?.error || "购买页面打开失败";
    return;
  }
  developerRenewalPaymentOrderNo = String(result.order_no || "");
  renderDeveloperBrowserPayment("developer-renewal-payment", "developer-renewal-payment-status", result, payMethod);
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  const orderNo = developerRenewalPaymentOrderNo;
  developerRenewalPaymentTimer = setInterval(async () => {
    if (flowId !== developerRenewalPaymentFlowId || !orderNo || !document.getElementById("developer-renewal-overlay")?.classList.contains("show")) {
      clearInterval(developerRenewalPaymentTimer);
      developerRenewalPaymentTimer = null;
      return;
    }
    const status = await window.developerAccountManager.renewalPaymentStatus(orderNo).catch(error => ({ success: false, error: error?.message || "订单状态查询失败" }));
    if (flowId !== developerRenewalPaymentFlowId || orderNo !== developerRenewalPaymentOrderNo) return;
    const statusNode = document.getElementById("developer-renewal-payment-status");
    const paid = status.status === "paid" || status.paid === true || status.order_status === "paid";
    if (statusNode) statusNode.textContent = paid ? "支付成功，正在开通…" : (status.success === false ? "订单状态查询失败，正在重试…" : "等待支付…");
    if (!paid) return;
    if (developerRenewalPaymentCompleting) return;
    developerRenewalPaymentCompleting = true;
    clearInterval(developerRenewalPaymentTimer);
    developerRenewalPaymentTimer = null;
    const revealed = await window.developerAccountManager.renewalPaymentReveal(orderNo).catch(error => ({ success: false, error: error.message }));
    if (!revealed?.success || !revealed.code) {
      document.getElementById("developer-renewal-error").textContent = revealed?.error || "支付成功，但核验码领取失败";
      developerRenewalPaymentCompleting = false;
      return;
    }
    const activated = await window.developerAccountManager.activate({ accountId: row?.id || developerRenewalAccountId || "", appleId: row?.appleId || "", verificationCode: revealed.code }).catch(error => ({ success: false, error: error.message }));
    if (!activated?.success) {
      document.getElementById("developer-renewal-error").textContent = activated?.error || "支付成功，但账户开通失败";
      developerRenewalPaymentCompleting = false;
      return;
    }
    closeDeveloperRenewalDialog();
    showDeveloperRenewalSuccess();
    await refreshDeveloperAccountsAfterRenewal();
  }, 2000);
}

async function refreshDeveloperRenewalPaymentStatus() {
  if (!developerRenewalPaymentOrderNo) {
    document.getElementById("developer-renewal-error").textContent = "请先生成支付订单";
    return;
  }
  const row = pendingDeveloperRenewalNotice?.row || null;
  const flowId = developerRenewalPaymentFlowId;
  const orderNo = developerRenewalPaymentOrderNo;
  const status = await window.developerAccountManager.renewalPaymentStatus(orderNo).catch(error => ({ success: false, error: error?.message || "订单状态查询失败" }));
  if (flowId !== developerRenewalPaymentFlowId || orderNo !== developerRenewalPaymentOrderNo) return;
  const statusNode = document.getElementById("developer-renewal-payment-status");
  const paid = status.status === "paid" || status.paid === true || status.order_status === "paid";
  if (statusNode) statusNode.textContent = paid ? "支付成功，正在开通…" : "等待支付…";
  if (!paid) {
    document.getElementById("developer-renewal-error").textContent = status.error || "还没有查询到支付成功，请稍后再试";
    return;
  }
  if (developerRenewalPaymentCompleting) return;
  developerRenewalPaymentCompleting = true;
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const revealed = await window.developerAccountManager.renewalPaymentReveal(orderNo).catch(error => ({ success: false, error: error.message }));
  if (!revealed?.success || !revealed.code) {
    document.getElementById("developer-renewal-error").textContent = revealed?.error || "支付成功，但核验码领取失败";
    developerRenewalPaymentCompleting = false;
    return;
  }
  const activated = await window.developerAccountManager.activate({ accountId: row?.id || developerRenewalAccountId || "", appleId: row?.appleId || "", verificationCode: revealed.code }).catch(error => ({ success: false, error: error.message }));
  if (!activated?.success) {
    document.getElementById("developer-renewal-error").textContent = activated?.error || "支付成功，但账户开通失败";
    developerRenewalPaymentCompleting = false;
    return;
  }
  closeDeveloperRenewalDialog();
  showDeveloperRenewalSuccess();
  await refreshDeveloperAccountsAfterRenewal();
}

async function submitDeveloperRenewalCode() {
  const button = document.getElementById("developer-renewal-code-submit");
  const input = document.getElementById("developer-renewal-code");
  const error = document.getElementById("developer-renewal-error");
  const row = pendingDeveloperRenewalNotice?.row || null;
  const accountId = row?.id || developerRenewalAccountId || "";
  const code = String(input?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(code)) {
    if (error) error.textContent = "请输入有效核验码";
    return;
  }
  if (!accountId) {
    if (error) error.textContent = "未找到需要续费的账户";
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "核验中…";
  }
  const result = await window.developerAccountManager.activate({ accountId, appleId: row?.appleId || "", verificationCode: code }).catch(reason => ({ success: false, error: reason.message }));
  if (button) {
    button.disabled = false;
    button.textContent = "核验码续费";
  }
  if (!result?.success) {
    if (error) error.textContent = result?.error || "续费失败";
    return;
  }
  closeDeveloperRenewalDialog();
  showDeveloperRenewalSuccess();
  await refreshDeveloperAccountsAfterRenewal();
}

async function loadDeveloperAppStatusList({ silent = false } = {}) {
  if (!developerAppScanAccountId || !isDeveloperAppStatusOpen()) return;
  const errorEl = document.getElementById("developer-app-status-error");
  if (!silent) {
    clearDeveloperAppStatusPoll();
    if (errorEl) errorEl.textContent = "";
    const summary = document.getElementById("developer-app-status-summary");
    const syncState = document.getElementById("developer-app-status-sync-state");
    if (summary) summary.textContent = "正在读取历史状态…";
    if (syncState) syncState.textContent = "";
    renderDeveloperAppStatusEmpty("正在读取历史状态…");
  }
  const result = await window.developerAccountManager.apps(developerAppScanAccountId);
  if (!isDeveloperAppStatusOpen()) return;
  if (!result?.success) {
    if (!silent) {
      developerAppScanApps = [];
      renderDeveloperAppStatusEmpty("暂无可显示 App");
    }
    if (errorEl) errorEl.textContent = result?.error || "还未同步账户 App，请启动证书管理登录账户并同步 App";
    scheduleDeveloperAppStatusPoll(60000);
    return;
  }
  developerAppScanApps = (result.apps || []).map(normalizeDeveloperAppStatus);
  if (errorEl) errorEl.textContent = "";
  renderDeveloperAppStatusRows();
  const waiting = developerAppScanApps.some(item => item.needsRefresh) || developerAppStatusRefreshingIds.size > 0;
  scheduleDeveloperAppStatusPoll(waiting ? 8000 : 60000);
}

async function openDeveloperAppScan(accountId) {
  developerAppScanAccountId = String(accountId || "");
  developerAppScanApps = [];
  developerAppStatusRefreshingIds.clear();
  clearDeveloperAppStatusPoll();
  const overlay = document.getElementById("developer-app-scan-overlay");
  const headNote = document.getElementById("developer-app-status-head-note");
  if (headNote) headNote.textContent = developerAppScanAccountId ? `账号 ${developerAppScanAccountId}` : "";
  overlay?.classList.add("show");
  renderDeveloperAppStatusEmpty("正在读取历史状态…");
  await loadDeveloperAppStatusList({ silent: false });
}

function closeDeveloperAppScan() {
  clearDeveloperAppStatusPoll();
  document.getElementById("developer-app-scan-overlay")?.classList.remove("show");
}

async function refreshDeveloperAppStatus(appId) {
  const target = String(appId || "").trim();
  if (!target || developerAppStatusRefreshingIds.has(target)) return;
  developerAppStatusRefreshingIds.add(target);
  const errorEl = document.getElementById("developer-app-status-error");
  if (errorEl) errorEl.textContent = "";
  renderDeveloperAppStatusRows();
  const result = await window.developerAccountManager.refreshAppStatus({ accountId: developerAppScanAccountId, appId: target });
  if (result?.app) {
    const row = normalizeDeveloperAppStatus(result.app);
    const index = developerAppScanApps.findIndex(item => String(item.id) === row.id);
    if (index >= 0) developerAppScanApps[index] = { ...developerAppScanApps[index], ...row };
    else developerAppScanApps.push(row);
  }
  developerAppStatusRefreshingIds.delete(target);
  renderDeveloperAppStatusRows();
  if (!result?.success) {
    if (errorEl) errorEl.textContent = result?.error || "刷新失败";
    scheduleDeveloperAppStatusPoll(30000);
    return;
  }
  if (result.warning && errorEl) errorEl.textContent = result.warning;
  scheduleDeveloperAppStatusPoll(60000);
}

async function loadDeveloperAccounts() {
  const content = document.getElementById("developer-account-list");
  if (!content) return;
  content.innerHTML = '<div class="developer-account-empty">正在读取账户…</div>';
  const result = await window.developerAccountManager.list();
  if (!result?.success) {
    content.innerHTML = `<div class="developer-account-error">${escapeDeveloperAccountHTML(result?.error || "账户列表读取失败")}</div>`;
    return;
  }
  const rows = [...(result.accounts || [])].sort(compareDeveloperAccountsByRenewal);
  const used = Math.max(0, Number(result.used ?? rows.length) || 0);
  const maxAccounts = Math.max(0, Number(result.maxDeveloperAccounts || currentUser?.max_developer_accounts || 0) || 0);
  if (currentUser) {
    currentUser.developer_accounts_used = used;
    currentUser.max_developer_accounts = maxAccounts;
  }
  const quotaText = maxAccounts > 0 ? String(maxAccounts) : "不限";
  document.getElementById("developer-account-summary").textContent = `可创建总数：${quotaText} 个 · 已创建：${used} 个`;
  const addButton = document.getElementById("developer-account-add");
  if (addButton) {
    addButton.disabled = maxAccounts > 0 && used >= maxAccounts;
    addButton.title = addButton.disabled ? `开发者账户额度 ${maxAccounts} 个已用完` : "添加开发者账户";
  }
  renderHomeDashboard();
  if (!rows.length) {
    content.innerHTML = '<div class="developer-account-empty"><b>暂无开发者账户</b><span>点击“添加账户”开始绑定</span></div>';
    return;
  }
  content.innerHTML = `<div class="developer-account-head developer-account-grid"><span>Apple ID</span><span>备注</span><span>首次注册</span><span>截止日</span><span>状态</span><span>操作</span></div>${rows.map(row => {
    const accessStatus = developerAccessStatus(row.access);
    const rawStatus = row.syncMissing ? { text: "待后台注册", expired: false } : row.appleAuthenticated && !accessStatus.warning ? { text: "已登录", expired: false, warning: false } : accessStatus;
    const accountId = String(row.id || "");
    const isRunningAccount = certificateManagerRunning && (!certificateManagerRunningAccountId || certificateManagerRunningAccountId === accountId);
    const expired = rawStatus.expired || developerAccessExpired(row.access);
    const status = expired ? { text: "已到期", expired: true, warning: true } : rawStatus;
    const launchBlocked = expired && !row.configurationMissing;
    const launchLabel = row.configurationMissing ? "需配置" : expired ? "已到期" : (isRunningAccount ? "打开" : (certificateManagerRunning ? "切换并打开" : "启动"));
    const canDelete = row.access?.canDelete !== false;
    const deleteButton = canDelete
      ? `<button class="developer-remove" data-id="${escapeDeveloperAccountHTML(accountId)}">删除</button>`
      : "";
    const deleteNotice = canDelete ? "" : `<span class="developer-delete-blocked" title="${escapeDeveloperAccountHTML(row.access?.deleteBlockedReason || "该开发者账户属于当前邮箱对应的码友账户，不能删除")}">邮箱账户绑定，不可删除</span>`;
    return `<div class="developer-account-row developer-account-grid"><div class="developer-account-id"><span class="developer-account-avatar">A</span><span>${escapeDeveloperAccountHTML(row.appleId)}</span></div><div class="developer-account-remark">${escapeDeveloperAccountHTML(row.remark || "—")}<br><small>${escapeDeveloperAccountHTML(row.configurationMissing ? "后台记录 · 本机未配置启动信息" : developerConnectionLabel(row))}</small></div><div class="developer-account-first"><b>${escapeDeveloperAccountHTML(formatDeveloperAccountDate(row.access?.firstLoginAt))}</b></div><div class="developer-account-deadline"><b>${escapeDeveloperAccountHTML(developerAccessDeadline(row.access))}</b><button class="developer-account-help" type="button" title="说明">?</button></div><div><span class="developer-account-status ${status.warning ? "warning" : ""} ${expired ? "expired" : ""}">${escapeDeveloperAccountHTML(status.text)}</span></div><div class="developer-account-actions"><button class="developer-launch ${isRunningAccount ? "running" : ""}" data-id="${escapeDeveloperAccountHTML(accountId)}" data-mode="${escapeDeveloperAccountHTML(row.connectionMode || "")}" data-expired="${expired ? "1" : "0"}" data-configuration-missing="${row.configurationMissing ? "1" : "0"}" ${launchBlocked ? "disabled" : ""}>${launchLabel}</button>${expired ? `<button class="developer-renew" type="button" data-id="${escapeDeveloperAccountHTML(accountId)}">续费</button>` : ""}${isRunningAccount ? `<button class="developer-stop" type="button">停止</button>` : ""}<button class="developer-update-password" type="button" data-id="${escapeDeveloperAccountHTML(accountId)}">更新配置</button><button class="developer-extend" data-id="${escapeDeveloperAccountHTML(accountId)}">${expired ? "续费码" : "延期"}</button><button class="developer-download" data-id="${escapeDeveloperAccountHTML(accountId)}">下载证书</button>${deleteButton}${deleteNotice}</div></div>`;
  }).join("")}`;
  content.querySelectorAll(".developer-update-password").forEach(button => button.addEventListener("click", () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    if (account) showDeveloperAccountDialog(account);
  }));
  content.querySelectorAll(".developer-download").forEach(downloadButton => {
    const scanButton = document.createElement("button");
    scanButton.className = "developer-app-status";
    scanButton.type = "button";
    scanButton.textContent = "App 状态";
    scanButton.dataset.id = downloadButton.dataset.id;
    scanButton.addEventListener("click", () => openDeveloperAppScan(scanButton.dataset.id));
    downloadButton.before(scanButton);
  });
  content.querySelectorAll(".developer-account-help").forEach(button => button.addEventListener("click", () => {
    alert("这里显示的是码友证书管理里配置证书功能的截止时间，用于判断是否还能继续配置证书。它不是 Apple 开发者账户每年 688 元会员资格的续费时间。");
  }));
  content.querySelectorAll(".developer-renew").forEach(button => button.addEventListener("click", () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    developerRenewalAccountId = String(button.dataset.id || "");
    showDeveloperRenewalDialog(account);
  }));
  content.querySelectorAll(".developer-launch").forEach(button => button.addEventListener("click", async () => {
    if (button.dataset.configurationMissing === "1") {
      const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
      if (account) await showDeveloperAccountDialog(account);
      return;
    }
    if (button.dataset.expired === "1") {
      const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
      developerRenewalAccountId = String(button.dataset.id || "");
      showDeveloperRenewalDialog(account);
      return;
    }
    button.disabled = true; button.textContent = button.dataset.mode === "custom_proxy" ? "检测代理中…" : "启动中…";
    const launchResult = await window.developerAccountManager.launch(button.dataset.id);
    if (!launchResult?.success) {
      if (launchResult?.renewalRequired || launchResult?.expired) {
        const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
        developerRenewalAccountId = String(button.dataset.id || "");
        showDeveloperRenewalDialog(account);
      } else {
        toast(launchResult?.error || "启动失败");
      }
      if (launchResult?.passwordRequired) {
        const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
        if (account) showDeveloperAccountDialog(account);
      }
    }
    certificateManagerRunning = !!launchResult?.success || !!launchResult?.running;
    certificateManagerRunningAccountId = certificateManagerRunning ? String(button.dataset.id || "") : "";
    await loadDeveloperAccounts();
  }));
  content.querySelectorAll(".developer-stop").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "停止中…";
    const result = await window.developerAccountManager.forceCloseCertificateManager();
    if (!result?.success) {
      toast(result?.error || "停止失败");
      button.disabled = false;
      button.textContent = "停止";
      return;
    }
    certificateManagerRunning = false;
    certificateManagerRunningAccountId = "";
    toast("码友证书管理已停止");
    await loadDeveloperAccounts();
  }));
  content.querySelectorAll(".developer-download").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "准备中…";
    const result = await window.developerAccountManager.downloadCertificate(button.dataset.id);
    if (!result?.success) toast(result?.error || "下载证书失败");
    else showDeveloperDownloadDialog(button.dataset.id, result.bundles || [], result.p12Password || "123456");
    button.disabled = false; button.textContent = "下载证书";
  }));
  content.querySelectorAll(".developer-extend").forEach(button => button.addEventListener("click", () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    showDeveloperExtendDialog(button.dataset.id, account?.appleId || "");
  }));
  content.querySelectorAll(".developer-remove").forEach(button => button.addEventListener("click", async () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    const appleId = String(account?.appleId || "").trim();
    const releaseMessage = appleId
      ? `确认后，该开发者账户将从当前码友账户解除绑定，并绑定到原邮箱 ${appleId} 对应的码友账户下面。本机只会清除当前配置，开发者账户不会被删除。`
      : "确认后，该开发者账户将从当前码友账户解除绑定，并绑定到原邮箱对应的码友账户下面。本机只会清除当前配置，开发者账户不会被删除。";
    const message = `${releaseMessage}\n\n确定继续吗？`;
    if (!confirm(message)) return;
    const removeResult = await window.developerAccountManager.remove(button.dataset.id);
    if (!removeResult?.success) toast(removeResult?.error || "删除失败");
    else {
      if (removeResult.deleteSyncError) toast(`已从本机列表删除，服务器状态同步失败：${removeResult.deleteSyncError}`);
      else {
        const targetEmail = String(removeResult.releasedToUser?.email || appleId).trim();
        toast(targetEmail ? `已解除绑定，并迁移到 ${targetEmail} 对应的码友账户` : "已解除绑定，并迁移到原邮箱对应的码友账户");
      }
      await loadDeveloperAccounts();
    }
  }));
}

async function pollCertificateManagerRunningState() {
  if (!window.developerAccountManager?.certificateManagerRunning) return;
  try {
    const status = await window.developerAccountManager.certificateManagerRunning();
    const running = !!status?.running;
    const accountId = running ? String(status?.accountId || "") : "";
    const authenticated = running && status?.authenticated === true;
    if (running === certificateManagerRunning && accountId === certificateManagerRunningAccountId && authenticated === certificateManagerAuthenticated) return;
    certificateManagerRunning = running;
    certificateManagerRunningAccountId = accountId;
    certificateManagerAuthenticated = authenticated;
    if (activeView === "developer-accounts") await loadDeveloperAccounts();
  } catch {}
}

setInterval(pollCertificateManagerRunningState, 1500);

function showDeveloperDownloadDialog(accountId, bundles = [], p12Password = "123456") {
  developerDownloadAccountId = String(accountId || "");
  developerDownloadP12Password = String(p12Password || "123456");
  const select = document.getElementById("developer-download-bundle");
  const rows = Array.isArray(bundles) ? bundles : [];
  select.innerHTML = rows.length
    ? `<option value="__all__">全部包名 · ${rows.length} 个包名</option>` + rows.map(item => `<option value="${escapeDeveloperAccountHTML(item.bundleId)}">${escapeDeveloperAccountHTML(item.bundleId)}</option>`).join("")
    : '<option value="">服务器暂无可下载包名</option>';
  document.getElementById("developer-download-error").textContent = rows.length ? "" : "服务器上没有找到这个账户同步过的描述文件，请先启动证书管理创建或同步。";
  document.getElementById("developer-download-confirm").disabled = !rows.length;
  document.getElementById("developer-download-overlay")?.classList.add("show");
}

function closeDeveloperDownloadDialog() {
  document.getElementById("developer-download-overlay")?.classList.remove("show");
  document.getElementById("developer-download-error").textContent = "";
  developerDownloadAccountId = "";
}

async function downloadDeveloperCertificatePackage() {
  const button = document.getElementById("developer-download-confirm");
  const selectedBundle = document.getElementById("developer-download-bundle").value;
  const bundleId = selectedBundle === "__all__" ? "" : selectedBundle;
  if (!selectedBundle) {
    document.getElementById("developer-download-error").textContent = "请选择包名";
    return;
  }
  button.disabled = true;
  button.textContent = "下载中…";
  const result = await window.developerAccountManager.downloadCertificatePackage({ accountId: developerDownloadAccountId, bundleId, mode: "all" });
  button.disabled = false;
  button.textContent = "确认下载";
  if (!result?.success && !result?.canceled) {
    document.getElementById("developer-download-error").textContent = result?.error || "证书文件下载失败";
    return;
  }
  if (result?.success) {
    closeDeveloperDownloadDialog();
    toast("证书文件已下载");
  }
}

function showDeveloperExtendDialog(accountId, appleId = "") {
  developerExtendAccountId = String(accountId || "");
  developerExtendAppleId = String(appleId || "").trim().toLowerCase();
  const input = document.getElementById("developer-extend-code");
  if (input) input.value = "";
  document.getElementById("developer-extend-error").textContent = "";
  const paymentArea = document.getElementById("developer-extend-payment");
  if (paymentArea) {
    paymentArea.classList.remove("show");
    paymentArea.innerHTML = "";
  }
  document.getElementById("developer-extend-overlay")?.classList.add("show");
  setTimeout(() => input?.focus(), 50);
  setTimeout(() => {
    if (document.getElementById("developer-extend-overlay")?.classList.contains("show")) {
      openDeveloperExtendPurchase("wechat");
    }
  }, 80);
}

function closeDeveloperExtendDialog() {
  document.getElementById("developer-extend-overlay")?.classList.remove("show");
  document.getElementById("developer-extend-error").textContent = "";
  developerExtendAccountId = "";
  developerExtendAppleId = "";
  developerRenewalPaymentFlowId += 1;
  developerRenewalPaymentCompleting = false;
  developerRenewalPaymentOrderNo = "";
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const paymentArea = document.getElementById("developer-extend-payment");
  if (paymentArea) {
    paymentArea.classList.remove("show");
    paymentArea.innerHTML = "";
  }
}

async function openDeveloperExtendPurchase(payMethod = "alipay") {
  const flowId = ++developerRenewalPaymentFlowId;
  developerRenewalPaymentCompleting = false;
  developerRenewalPaymentOrderNo = "";
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const error = document.getElementById("developer-extend-error");
  if (error) error.textContent = "";
  setDeveloperPayMethodActive("developer-extend", payMethod);
  const result = await window.developerAccountManager.createRenewalPayment({
    pay_method: payMethod,
    code_type: "normal",
    purchase_source: "certificate_manager_browser",
    developer_account_id: developerExtendAccountId || "",
    developer_apple_id: developerExtendAppleId || "",
  });
  if (flowId !== developerRenewalPaymentFlowId || !document.getElementById("developer-extend-overlay")?.classList.contains("show")) return;
  if (!result?.success) {
    if (error) error.textContent = result?.error || "付款码生成失败";
    return;
  }
  developerRenewalPaymentOrderNo = String(result.order_no || "");
  renderDeveloperBrowserPayment("developer-extend-payment", "developer-extend-payment-status", result, payMethod);
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  const orderNo = developerRenewalPaymentOrderNo;
  developerRenewalPaymentTimer = setInterval(async () => {
    if (flowId !== developerRenewalPaymentFlowId || !orderNo || !document.getElementById("developer-extend-overlay")?.classList.contains("show")) {
      clearInterval(developerRenewalPaymentTimer);
      developerRenewalPaymentTimer = null;
      return;
    }
    const status = await window.developerAccountManager.renewalPaymentStatus(orderNo).catch(() => ({}));
    if (flowId !== developerRenewalPaymentFlowId || orderNo !== developerRenewalPaymentOrderNo) return;
    const statusNode = document.getElementById("developer-extend-payment-status");
    if (statusNode) statusNode.textContent = status.status === "paid" ? "支付成功，正在开通…" : "等待支付…";
    if (status.status !== "paid") return;
    if (developerRenewalPaymentCompleting) return;
    developerRenewalPaymentCompleting = true;
    clearInterval(developerRenewalPaymentTimer);
    developerRenewalPaymentTimer = null;
    const revealed = await window.developerAccountManager.renewalPaymentReveal(orderNo).catch(reason => ({ success: false, error: reason.message }));
    if (!revealed?.success || !revealed.code) {
      if (error) error.textContent = revealed?.error || "支付成功，但核验码领取失败";
      developerRenewalPaymentCompleting = false;
      return;
    }
    const activated = await window.developerAccountManager.activate({ accountId: developerExtendAccountId, appleId: developerExtendAppleId, verificationCode: revealed.code }).catch(reason => ({ success: false, error: reason.message }));
    if (!activated?.success) {
      if (error) error.textContent = activated?.error || "支付成功，但账户开通失败";
      developerRenewalPaymentCompleting = false;
      return;
    }
    closeDeveloperExtendDialog();
    showDeveloperRenewalSuccess();
    refreshDeveloperAccountsAfterRenewal();
  }, 2000);
}

async function refreshDeveloperExtendPaymentStatus() {
  const error = document.getElementById("developer-extend-error");
  if (!developerRenewalPaymentOrderNo) {
    if (error) error.textContent = "请先生成支付订单";
    return;
  }
  const flowId = developerRenewalPaymentFlowId;
  const orderNo = developerRenewalPaymentOrderNo;
  const status = await window.developerAccountManager.renewalPaymentStatus(orderNo).catch(() => ({}));
  if (flowId !== developerRenewalPaymentFlowId || orderNo !== developerRenewalPaymentOrderNo) return;
  const statusNode = document.getElementById("developer-extend-payment-status");
  if (statusNode) statusNode.textContent = status.status === "paid" ? "支付成功，正在开通…" : "等待支付…";
  if (status.status !== "paid") {
    if (error) error.textContent = "还没有查询到支付成功，请稍后再试";
    return;
  }
  if (developerRenewalPaymentCompleting) return;
  developerRenewalPaymentCompleting = true;
  if (developerRenewalPaymentTimer) clearInterval(developerRenewalPaymentTimer);
  developerRenewalPaymentTimer = null;
  const revealed = await window.developerAccountManager.renewalPaymentReveal(orderNo).catch(reason => ({ success: false, error: reason.message }));
  if (!revealed?.success || !revealed.code) {
    if (error) error.textContent = revealed?.error || "支付成功，但核验码领取失败";
    developerRenewalPaymentCompleting = false;
    return;
  }
  const activated = await window.developerAccountManager.activate({ accountId: developerExtendAccountId, appleId: developerExtendAppleId, verificationCode: revealed.code }).catch(reason => ({ success: false, error: reason.message }));
  if (!activated?.success) {
    if (error) error.textContent = activated?.error || "支付成功，但账户开通失败";
    developerRenewalPaymentCompleting = false;
    return;
  }
  closeDeveloperExtendDialog();
  showDeveloperRenewalSuccess();
  refreshDeveloperAccountsAfterRenewal();
}

async function submitDeveloperExtendCode() {
  const button = document.getElementById("developer-extend-submit");
  const input = document.getElementById("developer-extend-code");
  const code = String(input?.value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(code)) {
    document.getElementById("developer-extend-error").textContent = "请输入有效核验码";
    return;
  }
  button.disabled = true;
  button.textContent = "核验中…";
  const result = await window.developerAccountManager.activate({ accountId: developerExtendAccountId, appleId: developerExtendAppleId, verificationCode: code });
  button.disabled = false;
  button.textContent = "立即核验";
  if (!result?.success) {
    document.getElementById("developer-extend-error").textContent = result?.error || "延期失败";
    return;
  }
  closeDeveloperExtendDialog();
  showDeveloperRenewalSuccess("延期成功，账户有效期已更新。");
  refreshDeveloperAccountsAfterRenewal();
}

function resetDeveloperAccountDialogMode() {
  editingDeveloperAccount = null;
  document.getElementById("developer-account-dialog-title").textContent = "添加开发者账户";
  document.getElementById("developer-account-save").textContent = "确认添加";
  document.getElementById("developer-account-apple-id").readOnly = false;
  document.getElementById("developer-account-apple-id").setAttribute("autocomplete", "username");
  document.getElementById("developer-account-password").setAttribute("autocomplete", "current-password");
  document.getElementById("developer-account-password").placeholder = "用于启动时内部登录";
  document.getElementById("developer-account-mode-field")?.classList.remove("hidden");
}

function populateDeveloperAccountDialog(account) {
  if (!account) {
    resetDeveloperAccountDialogMode();
    document.getElementById("developer-account-apple-id").value = "";
    document.getElementById("developer-account-password").value = "";
    document.getElementById("developer-account-remark").value = "";
    document.getElementById("developer-account-proxy-type").value = "http";
    document.getElementById("developer-account-proxy-host").value = "";
    document.getElementById("developer-account-proxy-port").value = "";
    document.getElementById("developer-account-proxy-username").value = "";
    document.getElementById("developer-account-proxy-password").value = "";
    const directMode = document.querySelector('input[name="developer-account-mode"][value="direct"]');
    if (directMode) directMode.checked = true;
    setDeveloperAccountModeUI();
    return;
  }
  editingDeveloperAccount = account;
  document.getElementById("developer-account-dialog-title").textContent = "更新账户配置";
  document.getElementById("developer-account-save").textContent = "确认更新";
  document.getElementById("developer-account-apple-id").value = account.appleId || "";
  document.getElementById("developer-account-password").value = "";
  document.getElementById("developer-account-remark").value = account.remark || "";
  document.getElementById("developer-account-apple-id").readOnly = true;
  document.getElementById("developer-account-apple-id").setAttribute("autocomplete", "off");
  document.getElementById("developer-account-password").setAttribute("autocomplete", "new-password");
  document.getElementById("developer-account-password").placeholder = account.configurationMissing ? "请输入 Apple ID 密码以配置本机" : "留空则不修改 Apple ID 密码";
  document.getElementById("developer-account-mode-field")?.classList.remove("hidden");
  const mode = String(account.connectionMode || "direct");
  const modeInput = document.querySelector(`input[name="developer-account-mode"][value="${mode}"]`) || document.querySelector('input[name="developer-account-mode"][value="direct"]');
  if (modeInput) modeInput.checked = true;
  const proxy = account.proxy || {};
  const browserProxySelect = document.getElementById("developer-account-browser-proxy");
  if (browserProxySelect && account.browserProxyKey) browserProxySelect.value = account.browserProxyKey;
  document.getElementById("developer-account-proxy-type").value = String(proxy.type || "http").toLowerCase() === "socks5" ? "socks5" : "http";
  document.getElementById("developer-account-proxy-host").value = proxy.host || "";
  document.getElementById("developer-account-proxy-port").value = proxy.port || "";
  document.getElementById("developer-account-proxy-username").value = proxy.username || "";
  document.getElementById("developer-account-proxy-password").value = "";
  setDeveloperAccountModeUI();
  const note = document.getElementById("developer-account-note");
  if (note) note.textContent = account.configurationMissing
    ? "该账户已保存在后台，请补充本机启动所需的 Apple ID 密码和代理配置。"
    : "可更新本机保存的 Apple ID 密码、备注，以及启动时使用的连接方式和代理 IP。";
}

async function showDeveloperAccountDialog(account = null) {
  document.getElementById("developer-account-overlay")?.classList.add("show");
  document.getElementById("developer-account-error").textContent = "";
  try { await hydrateProxyStorage(); } catch {}
  renderDeveloperAccountProxyOptions();
  populateDeveloperAccountDialog(account);
  setTimeout(() => document.getElementById(account ? "developer-account-password" : "developer-account-apple-id")?.focus(), 0);
}

function closeDeveloperAccountDialog() {
  document.getElementById("developer-account-overlay")?.classList.remove("show");
  document.getElementById("developer-account-error").textContent = "";
  populateDeveloperAccountDialog(null);
}

function selectedDeveloperAccountMode() {
  return document.querySelector('input[name="developer-account-mode"]:checked')?.value || "direct";
}

function browserProxyOptionLabel(proxy) {
  if (!proxy) return "";
  const type = String(proxy.type || "http").toUpperCase();
  const host = String(proxy.host || "").trim();
  const port = String(proxy.port || "").trim();
  const note = String(proxy.note || "").trim();
  return `${type} ${host}:${port}${note ? ` · ${note}` : ""}`;
}

function renderDeveloperAccountProxyOptions() {
  const select = document.getElementById("developer-account-browser-proxy");
  if (!select) return;
  const items = currentProxyRows().filter(proxy => proxy && proxy.host && proxy.port);
  if (!items.length) {
    select.innerHTML = '<option value="">暂无可用代理，请先到代理管理中添加</option>';
    select.value = "";
    return;
  }
  select.innerHTML = items.map(proxy => `<option value="${escapeDeveloperAccountHTML(proxyKey(proxy))}">${escapeDeveloperAccountHTML(browserProxyOptionLabel(proxy))}</option>`).join("");
  if (!items.some(proxy => proxyKey(proxy) === select.value)) {
    select.value = proxyKey(items[0]);
  }
}

async function refreshDeveloperAccountProxyOptions() {
  await hydrateProxyStorage();
  renderDeveloperAccountProxyOptions();
  toast("已刷新浏览器代理列表");
}

function selectedBrowserProxyOption() {
  const key = document.getElementById("developer-account-browser-proxy")?.value || "";
  return currentProxyRows().find(proxy => proxyKey(proxy) === key) || null;
}

async function persistDeveloperAccountBrowserProxy(proxy) {
  if (!proxy?.host || !proxy?.port) return null;
  const key = proxyKey(proxy);
  let stored = proxies.find(item => proxyKey(item) === key) || null;
  if (!stored) {
    stored = {
      ...proxy,
      id: String(proxy.id || "").startsWith("env-") || !proxy.id
        ? `proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`
        : proxy.id,
    };
    delete stored.derived;
    proxies.unshift(stored);
  }
  return await saveProxies() ? stored : null;
}

function setDeveloperAccountModeUI() {
  const mode = selectedDeveloperAccountMode();
  document.querySelectorAll(".developer-account-mode").forEach(label => {
    const input = label.querySelector("input");
    label.classList.toggle("active", input?.checked);
  });
  document.getElementById("developer-account-browser-proxy-panel")?.classList.toggle("hidden", mode !== "browser_proxy");
  document.getElementById("developer-account-custom-proxy-panel")?.classList.toggle("hidden", mode !== "custom_proxy");
  const note = document.getElementById("developer-account-note");
  if (note) {
    note.textContent = mode === "browser_proxy"
      ? "浏览器代理会直接读取代理管理中的现有代理配置。"
      : mode === "custom_proxy"
        ? "自定义代理会在确认前自动检测是否可用，只有检测通过才允许保存。"
        : "直连模式不使用代理，启动时直接连接 Apple 开发者服务。";
  }
}

document.querySelectorAll('input[name="developer-account-mode"]').forEach(input => {
  input.addEventListener("change", setDeveloperAccountModeUI);
});

async function saveDeveloperAccount() {
  const appleId = document.getElementById("developer-account-apple-id").value.trim();
  const password = document.getElementById("developer-account-password").value;
  const remark = document.getElementById("developer-account-remark").value;
  const button = document.getElementById("developer-account-save");
  const connectionMode = selectedDeveloperAccountMode();
  const browserProxy = selectedBrowserProxyOption();
  const customProxy = {
    enabled: true,
    type: document.getElementById("developer-account-proxy-type").value,
    host: document.getElementById("developer-account-proxy-host").value.trim(),
    port: Number(document.getElementById("developer-account-proxy-port").value),
    username: document.getElementById("developer-account-proxy-username").value.trim(),
    password: document.getElementById("developer-account-proxy-password").value,
  };
  if (connectionMode === "browser_proxy" && !browserProxy) {
    document.getElementById("developer-account-error").textContent = "请先在代理管理中选择一个可用代理";
    return;
  }
  if (connectionMode === "custom_proxy" && (!customProxy.host || !Number.isInteger(customProxy.port) || customProxy.port < 1 || customProxy.port > 65535)) {
    document.getElementById("developer-account-error").textContent = "请填写有效的代理主机和端口";
    return;
  }
  if (connectionMode === "custom_proxy") {
    const detected = await window.browser?.detectIP?.(customProxy);
    if (!detected || !detected.ip || detected.ip === "—") {
      document.getElementById("developer-account-error").textContent = detected?.statusText || "代理检测失败，请检查后重试";
      return;
    }
  }
  let managedBrowserProxy = browserProxy;
  if (connectionMode === "browser_proxy") {
    managedBrowserProxy = await persistDeveloperAccountBrowserProxy(browserProxy);
    if (!managedBrowserProxy) {
      document.getElementById("developer-account-error").textContent = "代理配置保存失败，请刷新代理列表后重试";
      return;
    }
  }
  if (editingDeveloperAccount) {
    if (editingDeveloperAccount.configurationMissing && !password) {
      document.getElementById("developer-account-error").textContent = "请输入 Apple ID 密码";
      return;
    }
    button.disabled = true;
    try {
      const payload = {
        accountId: editingDeveloperAccount.id,
        appleId: editingDeveloperAccount.appleId || appleId,
        password,
        remark,
        connectionMode,
        browserProxyKey: connectionMode === "browser_proxy" ? proxyKey(managedBrowserProxy) : "",
        proxy: connectionMode === "custom_proxy" ? customProxy : null,
        keepProxyPassword: connectionMode === "custom_proxy" && !customProxy.password,
      };
      const result = editingDeveloperAccount.configurationMissing
        ? await window.developerAccountManager.restoreConfig(payload)
        : await window.developerAccountManager.updatePassword(payload);
      if (!result?.success) {
        document.getElementById("developer-account-error").textContent = result?.error || "配置更新失败";
        return;
      }
      toast(`已更新 ${editingDeveloperAccount.appleId || appleId} 的账户配置`);
      closeDeveloperAccountDialog();
      loadDeveloperAccounts();
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (!password) {
    document.getElementById("developer-account-error").textContent = "请输入 Apple ID 密码";
    return;
  }
  button.disabled = true;
  const result = await window.developerAccountManager.add({
    appleId,
    password,
    remark,
    connectionMode,
    browserProxyKey: connectionMode === "browser_proxy" ? proxyKey(managedBrowserProxy) : "",
    proxy: connectionMode === "custom_proxy" ? customProxy : null,
  });
  button.disabled = false;
  if (!result?.success) {
    document.getElementById("developer-account-error").textContent = result?.error || "添加失败";
    return;
  }
  document.getElementById("developer-account-apple-id").value = "";
  document.getElementById("developer-account-password").value = "";
  document.getElementById("developer-account-remark").value = "";
  document.getElementById("developer-account-browser-proxy").value = "";
  document.getElementById("developer-account-proxy-host").value = "";
  document.getElementById("developer-account-proxy-port").value = "";
  document.getElementById("developer-account-proxy-username").value = "";
  document.getElementById("developer-account-proxy-password").value = "";
  const directMode = document.querySelector('input[name="developer-account-mode"][value="direct"]');
  if (directMode) directMode.checked = true;
  setDeveloperAccountModeUI();
  closeDeveloperAccountDialog();
  loadDeveloperAccounts();
}

async function openSimilarityPage(pagePath = "/") {
  switchMainView("similarity");
  const webview = document.getElementById("similarity-webview");
  const target = buildPageURL(SIMILARITY_BASE_URL, pagePath);
  if (webview && webview.getAttribute("src") !== target) webview.setAttribute("src", target);
}

async function openServerSettings() {
  const config = currentServerConfig || await loadServerConfig();
  if (!config?.systemSettingsEnabled) {
    toast("当前安装包已锁定正式服务器");
    return;
  }
  switchMainView("settings");
  const mode = config?.mode === "test" ? "test" : "production";
  const radio = document.querySelector(`input[name="server-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  document.getElementById("server-test-url").value = config?.testURL || "";
  document.getElementById("server-production-url").value = config?.productionURL || "";
  document.getElementById("server-current-url").textContent = `当前服务器：${config?.currentURL || "未配置"}`;
}

async function saveServerSettings() {
  const config = currentServerConfig || await loadServerConfig();
  if (!config?.systemSettingsEnabled) {
    toast("当前安装包已锁定正式服务器");
    return;
  }
  const mode = document.querySelector('input[name="server-mode"]:checked')?.value || "production";
  const result = await window.serverConfig?.save?.({
    mode,
    testURL: document.getElementById("server-test-url").value,
    productionURL: document.getElementById("server-production-url").value,
  });
  if (!result?.success) {
    toast(result?.error || "服务器设置保存失败");
    return;
  }
  currentServerConfig = { ...config, ...result };
  applyCurrentUser(null);
  environments = [];
  runningEnvIds.clear();
  runningBrowserDetails.clear();
  renderList();
  renderProxyList();
  document.getElementById("server-current-url").textContent = `当前服务器：${result.currentURL}`;
  toast("服务器已切换，正在重新启动...");
  setTimeout(() => window.serverConfig?.relaunch?.(), 500);
}

function requireLogin() {
  if (currentUser) return true;
  if (confirm("该功能需要登录，是否前往登录？")) showLoginPage();
  return false;
}

function switchProxyTab(tab) {
  activeProxyTab = tab || "manage";
  document.querySelectorAll(".proxy-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.proxyTab === activeProxyTab);
  });
  ["overseas", "domestic", "manage", "voucher"].forEach(name => {
    document.getElementById(`proxy-page-${name}`)?.classList.toggle("hidden", activeProxyTab !== name);
  });
  if (activeProxyTab === "manage") renderProxyList();
}

function proxyStorageKey() {
  return "ipauploader.proxyPool";
}

function loadProxies() {
  try {
    const saved = JSON.parse(localStorage.getItem(proxyStorageKey()) || "[]");
    proxies = Array.isArray(saved) ? saved : [];
  } catch {
    proxies = [];
  }
  renderDeveloperAccountProxyOptions();
}

function mergeStoredProxies(primary, fallback) {
  const merged = [];
  const seen = new Set();
  [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])].forEach(proxy => {
    if (!proxy || !proxy.host || !proxy.port) return;
    const key = proxyKey(proxy);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(proxy);
  });
  return merged;
}

async function hydrateProxyStorage() {
  if (!window.browser?.loadProxies) return;
  try {
    const result = await window.browser.loadProxies();
    const stored = Array.isArray(result?.proxies) ? result.proxies : [];
    proxies = mergeStoredProxies(stored, proxies);
    localStorage.setItem(proxyStorageKey(), JSON.stringify(proxies));
    if (!stored.length && proxies.length) await saveProxies();
    renderProxyList();
    renderDeveloperAccountProxyOptions();
  } catch (e) {
    console.warn("load proxies failed:", e.message || e);
  }
}

async function saveProxies() {
  localStorage.setItem(proxyStorageKey(), JSON.stringify(proxies));
  if (!window.browser?.saveProxies) return true;
  try {
    const result = await window.browser.saveProxies(proxies);
    if (result?.error) {
      console.warn("save proxies failed:", result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("save proxies failed:", e.message || e);
    return false;
  }
}

function proxyKey(proxy) {
  return `${String(proxy.type || "http").toLowerCase()}://${proxy.host || ""}:${proxy.port || ""}`;
}

function envProxyKey(env) {
  const proxy = env.proxy || {};
  if (!proxy.enabled || !proxy.host || !proxy.port) return "";
  return proxyKey(proxy);
}

function boundProxyCount(proxy) {
  const key = proxyKey(proxy);
  return environments.filter(env => envProxyKey(env) === key).length;
}

function proxyInfo(proxy) {
  return `${proxy.host || "—"}:${proxy.port || "—"}`;
}

function renderProxyList() {
  const table = document.getElementById("proxy-table");
  if (!table) return;
  const keyword = (document.getElementById("proxy-search")?.value || "").toLowerCase();
  const derived = deriveEnvironmentProxies();
  const all = mergeProxyRecords(proxies, derived);
  const filtered = all.filter(proxy => {
    if (!keyword) return true;
    return [proxy.note, proxy.host, proxy.port, proxy.type].filter(Boolean).join(" ").toLowerCase().includes(keyword);
  });
  const filteredKeys = filtered.map(proxyKey);
  const allChecked = filteredKeys.length > 0 && filteredKeys.every(key => selectedProxyKeys.has(key));
  const showValidity = filtered.some(proxy => proxy.detecting || proxy.detectStatus === "checking" || proxy.detectStatus === "ok" || proxy.detectStatus === "fail");
  const header = `
    <div class="proxy-head proxy-grid ${showValidity ? "has-validity" : ""}">
      <div><input class="proxy-check" type="checkbox" ${allChecked ? "checked" : ""} onchange="toggleAllProxySelection(this.checked)" /></div>
      <div>代理类型</div>
      <div>代理信息</div>
      ${showValidity ? "<div>是否有效</div>" : ""}
      <div>出口IP</div>
      <div>绑定窗口</div>
      <div>刷新URL</div>
      <div>备注</div>
      <div>操作</div>
    </div>`;
  if (!filtered.length) {
    table.innerHTML = header + `<div class="proxy-empty">暂无代理</div>`;
    return;
  }
  table.innerHTML = header + filtered.map(proxy => {
    const key = proxyKey(proxy);
    const typeLabel = proxy.type === "socks5" ? "Socks5" : "HTTP";
    const out = proxy.detecting ? "检测中..." : (proxy.outIp || "–");
    const detectClass = proxy.detectStatus === "ok" ? "ok" : proxy.detectStatus === "fail" ? "fail" : "";
    const statusText = proxy.detecting || proxy.detectStatus === "checking" ? "检测中" : proxy.detectStatus === "ok" ? "可用" : proxy.detectStatus === "fail" ? "不可用" : "未检测";
    const statusClass = proxy.detecting || proxy.detectStatus === "checking" ? "checking" : proxy.detectStatus === "ok" ? "ok" : proxy.detectStatus === "fail" ? "fail" : "";
    const bindCount = boundProxyCount(proxy);
    return `
      <div class="proxy-row proxy-grid ${showValidity ? "has-validity" : ""}">
        <div><input class="proxy-check" type="checkbox" ${selectedProxyKeys.has(key) ? "checked" : ""} onchange="toggleProxySelection('${esc(key)}', this.checked)" /></div>
        <div class="proxy-type"><span class="proxy-s-badge">${proxy.type === "socks5" ? "S" : "H"}</span><span>${typeLabel}</span></div>
        <div class="proxy-info">${esc(proxyInfo(proxy))}</div>
        ${showValidity ? `<div><span class="proxy-status ${statusClass}">${statusText}</span></div>` : ""}
        <div class="proxy-out"><span class="proxy-detect ${detectClass}">${esc(out)}</span></div>
        <div><span class="proxy-bind"><span class="proxy-bind-icon">◉</span>${bindCount}</span></div>
        <div>${esc(proxy.refreshUrl || "–")}</div>
        <div class="proxy-note" title="${esc(proxy.note || "")}">${esc(proxy.note || "")}</div>
        <div class="proxy-actions">
          <button class="proxy-action" title="编辑" onclick="showProxyDialog('${proxy.id}')"><img src="./assets/icons/xiugai.png" alt="编辑" /></button>
          <button class="proxy-action danger" title="删除" onclick="deleteProxy('${proxy.id}')"><img src="./assets/icons/a-shanchu1.png" alt="删除" /></button>
        </div>
      </div>`;
  }).join("") + `
    <div class="proxy-pager">
      <span>共 ${filtered.length} 条</span>
      <span>10条/页⌄</span>
      <button>Ⅰ‹</button><button>‹</button><button class="active">1</button><button>›</button><button>›Ⅰ</button>
      <span>前往</span><input style="width:66px;height:36px;text-align:center;border:1px solid #c9cdd4;border-radius:4px" value="1" /><span>页</span>
    </div>`;
}

function currentProxyRows() {
  return mergeProxyRecords(proxies, deriveEnvironmentProxies());
}

function selectedProxyRows() {
  const selected = currentProxyRows().filter(proxy => selectedProxyKeys.has(proxyKey(proxy)));
  return selected.length ? selected : currentProxyRows();
}

function toggleProxySelection(key, checked) {
  if (checked) selectedProxyKeys.add(key);
  else selectedProxyKeys.delete(key);
  renderProxyList();
}

function toggleAllProxySelection(checked) {
  const keyword = (document.getElementById("proxy-search")?.value || "").toLowerCase();
  currentProxyRows().forEach(proxy => {
    const haystack = [proxy.note, proxy.host, proxy.port, proxy.type].filter(Boolean).join(" ").toLowerCase();
    if (keyword && !haystack.includes(keyword)) return;
    const key = proxyKey(proxy);
    if (checked) selectedProxyKeys.add(key);
    else selectedProxyKeys.delete(key);
  });
  renderProxyList();
}

function toggleProxyMoreMenu(event) {
  event.stopPropagation();
  document.getElementById("proxy-more-menu")?.classList.toggle("show");
}

function deleteSelectedProxies() {
  document.getElementById("proxy-more-menu")?.classList.remove("show");
  const selected = currentProxyRows().filter(proxy => selectedProxyKeys.has(proxyKey(proxy)) && !proxy.derived);
  if (!selected.length) {
    toast("请选择可删除的代理");
    return;
  }
  if (!confirm(`确定删除选中的 ${selected.length} 个代理？`)) return;
  const keys = new Set(selected.map(proxyKey));
  proxies = proxies.filter(proxy => !keys.has(proxyKey(proxy)));
  selected.forEach(proxy => selectedProxyKeys.delete(proxyKey(proxy)));
  saveProxies();
  renderProxyList();
  toast("代理已删除");
}

async function exportSelectedProxies() {
  document.getElementById("proxy-more-menu")?.classList.remove("show");
  const rows = selectedProxyRows().map(proxy => ({
    type: proxy.type || "socks5",
    host: proxy.host || "",
    port: proxy.port || "",
    username: proxy.username || "",
    password: proxy.password || "",
    channel: proxy.channel || "",
    refreshUrl: proxy.refreshUrl || "",
    note: proxy.note || "",
    outIp: proxy.outIp || "",
    bindWindows: String(boundProxyCount(proxy)),
  }));
  if (!rows.length) {
    toast("暂无代理可导出");
    return;
  }
  try {
    const result = await window.browser.exportProxies(rows);
    if (result?.canceled) return;
    if (result?.error) {
      toast("导出失败: " + result.error);
      return;
    }
    toast("代理已导出");
  } catch (e) {
    toast("导出失败: " + (e.message || "未知错误"));
  }
}

async function downloadProxyTemplate() {
  document.getElementById("proxy-more-menu")?.classList.remove("show");
  try {
    const result = await window.browser.downloadProxyTemplate();
    if (result?.canceled) return;
    if (result?.error) {
      toast("下载失败: " + result.error);
      return;
    }
    toast("导入模板已下载");
  } catch (e) {
    toast("下载失败: " + (e.message || "未知错误"));
  }
}

async function importProxyFile() {
  document.getElementById("proxy-more-menu")?.classList.remove("show");
  try {
    const result = await window.browser.importProxies();
    if (result?.canceled) return;
    if (result?.error) {
      toast("导入失败: " + result.error);
      return;
    }
    const incoming = Array.isArray(result?.proxies) ? result.proxies : [];
    if (!incoming.length) {
      toast("表格中没有可导入的代理");
      return;
    }
    const existing = new Set(proxies.map(proxyKey));
    let added = 0;
    incoming.forEach(proxy => {
      const normalized = {
        id: "proxy-" + Date.now() + "-" + Math.random().toString(16).slice(2),
        type: String(proxy.type || "socks5").toLowerCase() === "http" ? "http" : "socks5",
        host: String(proxy.host || "").trim(),
        port: String(proxy.port || "").trim(),
        username: String(proxy.username || "").trim(),
        password: String(proxy.password || ""),
        refreshUrl: String(proxy.refreshUrl || "").trim(),
        note: String(proxy.note || "").trim(),
        outIp: String(proxy.outIp || "").trim(),
      };
      const key = proxyKey(normalized);
      if (!normalized.host || !normalized.port || existing.has(key)) return;
      existing.add(key);
      proxies.unshift(normalized);
      added++;
    });
    await saveProxies();
    renderProxyList();
    toast(`已导入 ${added} 个代理`);
  } catch (e) {
    toast("导入失败: " + (e.message || "未知错误"));
  }
}

function deriveEnvironmentProxies() {
  const records = [];
  environments.forEach(env => {
    const proxy = env.proxy || {};
    if (!proxy.enabled || !proxy.host || !proxy.port) return;
    records.push({
      id: "env-" + proxyKey(proxy).replace(/[^a-z0-9]/gi, "-"),
      type: String(proxy.type || "http").toLowerCase(),
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || "",
      password: proxy.password || "",
      refreshUrl: "",
      note: env.note || env.name || "",
      derived: true,
    });
  });
  return records;
}

function mergeProxyRecords(saved, derived) {
  const map = new Map();
  [...derived, ...saved].forEach(proxy => {
    if (!proxy || !proxy.host || !proxy.port) return;
    map.set(proxyKey(proxy), proxy);
  });
  return Array.from(map.values());
}

function showProxyDialog(proxyId = null) {
  if (!requireLogin()) return;
  editingProxyId = proxyId && !String(proxyId).startsWith("env-") ? proxyId : null;
  const proxy = editingProxyId ? proxies.find(item => item.id === editingProxyId) : null;
  document.getElementById("proxy-dialog-title").textContent = proxy ? "编辑代理" : "添加代理";
  clearProxyDetectPanel();
  document.getElementById("proxy-type").value = proxy?.type || "socks5";
  document.getElementById("proxy-host").value = proxy?.host || "";
  document.getElementById("proxy-port").value = proxy?.port || "";
  document.getElementById("proxy-username").value = proxy?.username || "";
  document.getElementById("proxy-password").value = proxy?.password || "";
  document.getElementById("proxy-refresh-url").value = proxy?.refreshUrl || "";
  document.getElementById("proxy-note").value = proxy?.note || "";
  updateProxyCharCounts();
  proxyOverlay?.classList.add("show");
}

function closeProxyDialog() {
  proxyOverlay?.classList.remove("show");
  clearProxyDetectPanel();
  editingProxyId = null;
}

function proxyDialogEl() {
  return document.querySelector(".proxy-dialog");
}

function clearProxyDetectPanel() {
  proxyDialogEl()?.classList.remove("has-detect-result");
  const panel = document.getElementById("proxy-detect-panel");
  if (panel) {
    panel.classList.remove("fail");
    panel.innerHTML = "";
  }
}

function updateProxyCharCounts() {
  [
    ["proxy-username", "proxy-username-count"],
    ["proxy-password", "proxy-password-count"],
    ["proxy-note", "proxy-note-count"],
  ].forEach(([inputId, countId]) => {
    const input = document.getElementById(inputId);
    const count = document.getElementById(countId);
    if (!input || !count) return;
    const max = Number(input.getAttribute("maxlength")) || 200;
    count.textContent = `${String(input.value || "").length}/${max}`;
  });
}

function autofillProxyFromHost() {
  const hostEl = document.getElementById("proxy-host");
  const value = (hostEl?.value || "").trim();
  const match = value.match(/^(https?|socks5):\/\/([^/:]+):(\d+)(?::([^:]+))?(?::(.+))?$/i);
  if (!match) return;
  document.getElementById("proxy-type").value = match[1].toLowerCase() === "socks5" ? "socks5" : "http";
  hostEl.value = match[2];
  document.getElementById("proxy-port").value = match[3];
  document.getElementById("proxy-username").value = match[4] || "";
  document.getElementById("proxy-password").value = match[5] || "";
  updateProxyCharCounts();
}

function readProxyForm() {
  return {
    id: editingProxyId || "proxy-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    type: document.getElementById("proxy-type").value,
    host: document.getElementById("proxy-host").value.trim(),
    port: document.getElementById("proxy-port").value.trim(),
    username: document.getElementById("proxy-username").value.trim(),
    password: document.getElementById("proxy-password").value,
    refreshUrl: document.getElementById("proxy-refresh-url").value.trim(),
    note: document.getElementById("proxy-note").value.trim(),
  };
}

function saveProxy() {
  autofillProxyFromHost();
  const proxy = readProxyForm();
  if (!proxy.host || !proxy.port) {
    toast("请填写代理主机和端口");
    return;
  }
  const existingIndex = proxies.findIndex(item => item.id === proxy.id);
  if (existingIndex >= 0) proxies[existingIndex] = { ...proxies[existingIndex], ...proxy };
  else proxies.unshift(proxy);
  saveProxies();
  closeProxyDialog();
  renderProxyList();
  toast("代理已保存");
}

function deleteProxy(proxyId) {
  if (String(proxyId).startsWith("env-")) {
    toast("该代理来自浏览器窗口配置，请到窗口里修改");
    return;
  }
  if (!confirm("确定删除此代理？")) return;
  proxies = proxies.filter(proxy => proxy.id !== proxyId);
  saveProxies();
  renderProxyList();
  toast("代理已删除");
}

function findProxy(proxyId) {
  return mergeProxyRecords(proxies, deriveEnvironmentProxies()).find(proxy => proxy.id === proxyId);
}

async function detectProxy(proxyId) {
  const proxy = findProxy(proxyId);
  if (!proxy) return;
  proxy.detecting = true;
  const target = proxies.find(item => proxyKey(item) === proxyKey(proxy));
  if (target) {
    target.detecting = true;
    target.detectStatus = "checking";
  }
  renderProxyList();
  try {
    const result = await detectProxyWithApp({
      enabled: true,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || "",
      password: proxy.password || "",
    });
    updateProxyDetection(proxy, result);
  } catch (e) {
    updateProxyDetection(proxy, { error: e.message });
  }
  renderProxyList();
}

async function detectProxyWithApp(proxy) {
  if (window.browser?.detectIP) return window.browser.detectIP(proxy);
  return window.daemon.detectIP(proxy);
}

function formatDetectTime(value) {
  if (!value) return new Date().toLocaleString("zh-CN", { hour12: false });
  return String(value);
}

function renderProxyDetectPanel(result, proxy) {
  const panel = document.getElementById("proxy-detect-panel");
  if (!panel) return;
  proxyDialogEl()?.classList.add("has-detect-result");
  const ok = !!(result && result.ip && result.ip !== "—");
  panel.classList.toggle("fail", !ok);
  if (!ok) {
    panel.innerHTML = `
      <div class="proxy-detect-line"><strong>检测失败</strong></div>
      <div class="proxy-detect-line">${esc(result?.statusText || result?.error || "代理不可达或检测源不可用")}</div>
      <div class="proxy-detect-warning">请检查代理地址、端口、账号密码</div>
    `;
    return;
  }
  const location = [result.country, result.region, result.city].filter(v => v && v !== "—").join(" / ") || "—";
  const coordinate = result.lat !== "—" && result.lon !== "—" ? `${result.lat}/${result.lon}` : "—";
  panel.innerHTML = `
    <div class="proxy-detect-line"><strong>IP：</strong>${esc(result.ip)}</div>
    <div class="proxy-detect-line"><strong>国家/地区：</strong>${esc(location)}</div>
    <div class="proxy-detect-line"><strong>城市：</strong>${esc(result.city || "—")}</div>
    <div class="proxy-detect-line"><strong>经度/纬度：</strong>${esc(coordinate)}</div>
    <div class="proxy-detect-line"><strong>时区：</strong>${esc(result.timezone || "—")}</div>
    <div class="proxy-detect-line"><strong>邮编：</strong>${esc(result.zip || result.postal || "—")}</div>
    <div class="proxy-detect-warning">检测到该IP于最近时间</div>
    <div class="proxy-detect-warning">${esc(formatDetectTime(result.checkedAt))}</div>
    <div class="proxy-detect-danger">在本软件中使用过！</div>
    <div class="proxy-detect-muted">不正确？ <span class="proxy-detect-link">更正</span></div>
  `;
  if (proxy) {
    proxy.outIp = `${result.ip}/${result.country || ""}${result.region && result.region !== "—" ? "(" + result.region + ")" : ""}`;
    proxy.detectStatus = "ok";
  }
}

function updateProxyDetection(proxy, result) {
  const target = proxies.find(item => proxyKey(item) === proxyKey(proxy));
  const patch = {
    outIp: result && result.ip && result.ip !== "—" ? `${result.ip}/${result.country || ""}${result.region ? "(" + result.region + ")" : ""}` : (result.error || result.statusText || "检测失败"),
    detectStatus: result && result.ip && result.ip !== "—" ? "ok" : "fail",
    detecting: false,
  };
  if (target) Object.assign(target, patch);
  else {
    proxies.unshift({
      ...proxy,
      id: "proxy-" + Date.now() + "-" + Math.random().toString(16).slice(2),
      derived: false,
      ...patch,
    });
  }
  saveProxies();
}

async function detectProxyFromDialog() {
  autofillProxyFromHost();
  const proxy = readProxyForm();
  if (!proxy.host || !proxy.port) {
    toast("请填写代理主机和端口");
    return;
  }
  try {
    const result = await detectProxyWithApp({ enabled: true, ...proxy });
    renderProxyDetectPanel(result, proxy);
    if (result && result.ip && result.ip !== "—") toast(`代理可用：${result.ip}`);
    else toast("代理检测失败: " + (result.statusText || result.error || "未知错误"));
  } catch (e) {
    renderProxyDetectPanel({ error: e.message || "未知错误" }, proxy);
    toast("代理检测失败: " + (e.message || "未知错误"));
  }
}

async function batchDetectProxies() {
  const all = mergeProxyRecords(proxies, deriveEnvironmentProxies());
  if (!all.length) {
    toast("暂无代理可检测");
    return;
  }
  toast(`开始批量检测 ${all.length} 个代理`);
  let ok = 0;
  let fail = 0;
  for (const proxy of all) {
    await detectProxy(proxy.id);
    const latest = mergeProxyRecords(proxies, deriveEnvironmentProxies()).find(item => proxyKey(item) === proxyKey(proxy));
    if (latest?.detectStatus === "ok") ok++;
    else if (latest?.detectStatus === "fail") fail++;
  }
  toast(`批量检测完成：可用 ${ok} 个，不可用 ${fail} 个`);
}

// ========== Render ==========
function handleEnvironmentSearch() {
  currentPage = 1;
  renderList();
}

function renderList() {
  if (!currentUser) {
    summaryEl.textContent = "未登录";
    listEl.innerHTML = `
      ${renderListHeader()}
      <div class="env-empty-state login-required">
        <div class="env-empty-icon">⚿</div>
        <div class="env-empty-title">你还未登录</div>
        <div class="env-empty-text">登录后才能查看和管理你的浏览器列表</div>
        <button class="primary env-empty-action" type="button" onclick="showLoginPage()">立即登录</button>
      </div>`;
    return;
  }
  const keyword = (searchEl.value || "").trim().toLowerCase();
  const filtered = environments.filter(env => {
    if (!keyword) return true;
    const haystack = [
      env.name, env.note, env.homeUrl,
      env.proxy?.host, env.proxy?.port
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(keyword);
  }).sort(compareBrowserEnvironmentsNewestFirst);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);
  const maxBrowserWindows = Math.max(0, Number(currentUser?.max_browser_windows ?? 10) || 0);
  const totalText = maxBrowserWindows === 0 ? "不限" : String(maxBrowserWindows);
  summaryEl.innerHTML = `已用 <strong>${environments.length}</strong> / 总数 ${totalText}${keyword ? ` (匹配 ${filtered.length})` : ""}`;

  if (filtered.length === 0) {
    const emptyTitle = keyword ? "没有匹配的浏览器" : "暂无浏览器数据";
    const emptyText = keyword ? "请尝试其他搜索关键词" : "点击左上角“创建窗口”添加第一个浏览器环境";
    listEl.innerHTML = `
      ${renderListHeader()}
      <div class="env-empty-state">
        <div class="env-empty-icon">▣</div>
        <div class="env-empty-title">${emptyTitle}</div>
        <div class="env-empty-text">${emptyText}</div>
      </div>
      ${renderPager(0)}`;
    return;
  }

  listEl.innerHTML = renderListHeader() + pageItems.map((env, i) => {
    const proxy = env.proxy || {};
    const proxyEnabled = proxy.enabled && proxy.host && proxy.port;
    const proxyType = (proxy.type || "HTTP").toUpperCase();
    const proxyMarkClass = proxyEnabled ? (proxy.type === "socks5" ? "socks" : "http") : "direct";
    const proxyMark = proxyEnabled ? (proxy.type === "socks5" ? "S" : "H") : "直";
    const proxyIP = proxyEnabled ? proxy.host : "直连";
    const proxyRegion = proxyEnabled ? `${proxy.port} · ${proxyType}` : "本机网络";
    const created = formatDateTime(env.createdAt);
    const fp = env.fingerprint || {};
    const osLabel = fp.os === "win" ? "Win" : "Mac";
    const configIcon = fp.os === "win"
      ? `<button class="platform-icon android" title="Windows 配置" onclick="toast('Windows 配置入口暂未实现')"><img src="./assets/icons/windows.png" alt="" /></button>`
      : `<button class="platform-icon apple" title="macOS 配置" onclick="toast('macOS 配置入口暂未实现')"></button>`;
    const note = env.note || fp.hostIp || "无备注";
    const isRunning = runningEnvIds.has(env.id);
    const automationLabel = runningAutomationLabel(env.id) || configuredAutomationLabel(env);
    const openClass = isRunning ? "open-btn running" : "open-btn";
    const openLabel = isRunning ? "运行中" : "打开";

    return `
      <div class="env-row env-grid">
        <div class="seq">${esc(env.serialNum || start + i + 1)}</div>
        <div class="window-name">
          <div class="name">${esc(env.name) || "未命名"}</div>
          <div class="meta">${esc(env.id).substring(0, 8)} · ${esc(osLabel)}${esc(automationLabel)}</div>
        </div>
        <div class="proxy-cell">
          <span class="proxy-mark ${proxyMarkClass}">${esc(proxyMark)}</span>
          <div class="proxy-text">
            <div class="ip">${esc(proxyIP)}</div>
            <div class="region">${esc(proxyRegion)}</div>
          </div>
        </div>
        <div><span class="tag-badge">${esc(osLabel)}</span></div>
        <div class="note-cell" title="${esc(note)}">${esc(note)}</div>
        <div class="created-cell">${esc(created)}</div>
        <div class="config-icons">
          ${configIcon}
        </div>
        <div><button class="${openClass}" data-env-id="${esc(env.id)}">${openLabel}</button></div>
        <div class="more-cell"><button class="more-btn" title="更多" data-env-id="${esc(env.id)}">⋮</button></div>
      </div>`;
  }).join("") + renderPager(filtered.length);
}

function compareBrowserEnvironmentsNewestFirst(left, right) {
  const leftCreatedAt = Date.parse(String(left?.createdAt || ""));
  const rightCreatedAt = Date.parse(String(right?.createdAt || ""));
  const leftTime = Number.isFinite(leftCreatedAt) ? leftCreatedAt : 0;
  const rightTime = Number.isFinite(rightCreatedAt) ? rightCreatedAt : 0;
  if (leftTime !== rightTime) return rightTime - leftTime;

  const leftSerial = Number(left?.serialNum || 0);
  const rightSerial = Number(right?.serialNum || 0);
  if (Number.isFinite(leftSerial) && Number.isFinite(rightSerial) && leftSerial !== rightSerial) {
    return rightSerial - leftSerial;
  }
  return String(right?.id || "").localeCompare(String(left?.id || ""));
}

function renderPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const disabledPrev = currentPage <= 1 ? "disabled" : "";
  const disabledNext = currentPage >= totalPages ? "disabled" : "";
  return `
    <div class="pager">
      <span>共 ${total} 条</span>
      <select onchange="changePageSize(this.value)">
        <option value="10" ${pageSize === 10 ? "selected" : ""}>10条/页</option>
        <option value="20" ${pageSize === 20 ? "selected" : ""}>20条/页</option>
        <option value="50" ${pageSize === 50 ? "selected" : ""}>50条/页</option>
      </select>
      <button ${disabledPrev} onclick="gotoPage(1)">|‹</button>
      <button ${disabledPrev} onclick="gotoPage(${currentPage - 1})">‹</button>
      <button class="active">${currentPage}</button>
      <button ${disabledNext} onclick="gotoPage(${currentPage + 1})">›</button>
      <button ${disabledNext} onclick="gotoPage(${totalPages})">›|</button>
      <span>前往</span>
      <input value="${currentPage}" onkeydown="if(event.key==='Enter')gotoPage(this.value)" />
      <span>页</span>
    </div>`;
}

function gotoPage(page) {
  const value = Number(page) || 1;
  currentPage = Math.max(1, value);
  renderList();
}

function changePageSize(value) {
  pageSize = Number(value) || 10;
  currentPage = 1;
  renderList();
}

function renderListHeader() {
  return `
    <div class="env-head env-grid">
      <div><span class="sortable">序号 ↑</span></div>
      <div><span class="sortable">窗口名称 ↓</span></div>
      <div>代理IP</div>
      <div>标签</div>
      <div>备注</div>
      <div><span class="sortable">创建时间 ↓</span></div>
      <div>配置</div>
      <div><span class="sortable">打开 ↓</span></div>
      <div></div>
    </div>`;
}

// ========== Dialog ==========
function showDialog(envId = null) {
  try {
  editingEnvId = envId;
  if (envId) {
    const envIndex = environments.findIndex(e => e.id === envId);
    const env = environments.find(e => e.id === envId);
    if (!env) {
      editingEnvId = null;
      toast("修改配置失败: 未找到这个窗口，请刷新列表后再试");
      return;
    }
    dlgTitle.textContent = `编辑窗口（序号：${env.serialNum || (envIndex >= 0 ? envIndex + 1 : "—")}）`;
    if (dlgDelete) dlgDelete.style.display = "";
    document.getElementById("dlg-name").value = env.name || "";
    document.getElementById("dlg-note").value = env.note || "";
    currentHomeURLs = parseHomeURLs(env.homeUrl || "");
    document.getElementById("dlg-home").value = "";
    renderHomeURLList();
    const p = env.proxy || {};
    loadProxies();
    const selectedKey = p.enabled && p.host && p.port ? proxyKey(p) : "";
    const hasManagedMatch = !!allProxyOptions().find(item => proxyKey(item) === selectedKey);
    renderWindowProxyOptions(selectedKey);
    setWindowProxyMode(selectedKey && hasManagedMatch ? "managed" : "custom");
    fillWindowCustomProxy(p.enabled ? p : { type: "direct" });
    setWindowProxyFields(p, !!(p.enabled && p.host && p.port));
    fillIPGuardForm(env.ipGuard);
    currentFingerprint = normalizeFingerprint(env.fingerprint);
    document.getElementById("dlg-fingerprint-os").value = currentFingerprint.os || inferFingerprintOS(currentFingerprint);
    document.getElementById("dlg-kernel-version").value = currentFingerprint.kernelVersion || "148";
    document.getElementById("dlg-browser-version").value = currentFingerprint.browserVersion || "148";
    document.getElementById("dlg-windows-version").value = currentFingerprint.windowsVersion || "11";
    fillFingerprintForm(currentFingerprint);
  } else {
    dlgTitle.textContent = "创建窗口";
    if (dlgDelete) dlgDelete.style.display = "none";
    document.getElementById("dlg-name").value = "";
    document.getElementById("dlg-note").value = "";
    currentHomeURLs = [];
    document.getElementById("dlg-home").value = "";
    renderHomeURLList();
    loadProxies();
    setWindowProxyMode("managed");
    renderWindowProxyOptions();
    fillWindowCustomProxy({ type: "direct" });
    fillIPGuardForm({ enabled: false, expectedIP: "" });
    document.getElementById("dlg-fingerprint-os").value = "random";
    document.getElementById("dlg-kernel-version").value = "148";
    document.getElementById("dlg-browser-version").value = "148";
    document.getElementById("dlg-windows-version").value = "11";
    currentFingerprint = generateFingerprint("random");
    fillFingerprintForm(currentFingerprint);
  }
  onWindowProxyModeChange();
  updateNoteCount();
  renderFingerprintSummary();
  onFingerprintOSChangeVisibility();
  dlgOverlay.classList.add("show");
  void prepareSelectedKernel();
  } catch (e) {
    editingEnvId = null;
    console.error("showDialog failed:", e);
    toast("打开配置失败: " + (e && e.message ? e.message : "未知错误"));
  }
}

function fillIPGuardForm(ipGuard = {}) {
  const enabled = document.getElementById("dlg-ip-guard-enabled");
  const expected = document.getElementById("dlg-ip-guard-expected");
  if (enabled) enabled.checked = !!ipGuard.enabled;
  if (expected) expected.value = ipGuard.expectedIP || "";
}

function currentIPGuardFromFields() {
  return {
    enabled: !!document.getElementById("dlg-ip-guard-enabled")?.checked,
    expectedIP: (document.getElementById("dlg-ip-guard-expected")?.value || "").trim(),
  };
}

function closeDialog() {
  dlgOverlay.classList.remove("show");
  editingEnvId = null;
}

function setWindowProxyMode(mode) {
  const value = ["custom", "managed"].includes(mode) ? mode : "managed";
  const input = document.querySelector(`input[name="dlg-proxy-mode"][value="${value}"]`);
  if (input) input.checked = true;
}

function getWindowProxyMode() {
  return document.querySelector('input[name="dlg-proxy-mode"]:checked')?.value || "managed";
}

function allProxyOptions() {
  return mergeProxyRecords(proxies, deriveEnvironmentProxies());
}

function renderWindowProxyOptions(selectedKey = "") {
  const input = document.getElementById("dlg-proxy-managed");
  if (!input) return;
  const items = allProxyOptions();
  const selected = items.find(proxy => proxyKey(proxy) === selectedKey) || items[0];
  input.value = selected ? `${selected.host}:${selected.port}` : "";
  renderWindowProxyDropdown();
  if (selected) applyManagedProxySelection(false);
  else clearWindowProxy();
}

function renderWindowProxyDropdown(useFilter = true) {
  const dropdown = document.getElementById("dlg-proxy-dropdown");
  const keyword = useFilter ? (document.getElementById("dlg-proxy-managed")?.value || "").toLowerCase() : "";
  if (!dropdown) return;
  const currentKey = proxyKey(currentWindowProxyFromFields());
  windowProxyDropdownItems = allProxyOptions().filter(proxy => {
    if (!keyword) return true;
    return [proxy.host, proxy.port, proxy.note, proxy.type].filter(Boolean).join(" ").toLowerCase().includes(keyword);
  });
  if (!windowProxyDropdownItems.length) {
    dropdown.innerHTML = `<div class="window-proxy-empty">暂无匹配代理</div>`;
    return;
  }
  dropdown.innerHTML = windowProxyDropdownItems.map((proxy, index) => {
    const key = proxyKey(proxy);
    const count = boundProxyCount(proxy);
    const type = String(proxy.type || "socks5").toLowerCase() === "socks5" ? "S" : "H";
    return `
      <div class="window-proxy-option ${key === currentKey ? "active" : ""}" onmousedown="selectWindowProxyOption(${index})">
        <span class="proxy-select-badge">${type}</span>
        <div class="window-proxy-main">${esc(proxy.host)}:${esc(proxy.port)}</div>
        <div class="window-proxy-bound">已绑定 ${count} 窗口</div>
        <div class="window-proxy-note">备注: ${esc(proxy.note || "无")}</div>
      </div>
    `;
  }).join("");
}

function showWindowProxyDropdown() {
  renderWindowProxyDropdown(false);
  document.getElementById("dlg-proxy-dropdown")?.classList.add("show");
}

function hideWindowProxyDropdown() {
  setTimeout(() => document.getElementById("dlg-proxy-dropdown")?.classList.remove("show"), 120);
}

function toggleWindowProxyDropdown() {
  const dropdown = document.getElementById("dlg-proxy-dropdown");
  if (!dropdown) return;
  if (dropdown.classList.contains("show")) dropdown.classList.remove("show");
  else showWindowProxyDropdown();
}

function selectWindowProxyOption(index) {
  const proxy = windowProxyDropdownItems[index] || allProxyOptions()[index];
  if (!proxy) return;
  setWindowProxyMode("managed");
  setWindowProxyFields(proxy, true);
  renderWindowProxyDropdown(false);
  document.getElementById("dlg-proxy-dropdown")?.classList.remove("show");
}

function setWindowProxyFields(proxy, enabled = true) {
  document.getElementById("dlg-proxy-enabled").value = enabled ? "1" : "";
  document.getElementById("dlg-proxy-type").value = proxy?.type || "socks5";
  document.getElementById("dlg-proxy-host").value = proxy?.host || "";
  document.getElementById("dlg-proxy-port").value = proxy?.port || "";
  document.getElementById("dlg-proxy-username").value = proxy?.username || "";
  document.getElementById("dlg-proxy-password").value = proxy?.password || "";
  const input = document.getElementById("dlg-proxy-managed");
  if (input) input.value = proxy?.host && proxy?.port ? `${proxy.host}:${proxy.port}` : "";
  const badge = document.getElementById("dlg-proxy-badge");
  if (badge) badge.textContent = String(proxy?.type || "socks5").toLowerCase() === "direct" ? "直" : String(proxy?.type || "socks5").toLowerCase() === "socks5" ? "S" : "H";
  const customBadge = document.getElementById("dlg-custom-proxy-badge");
  if (customBadge) customBadge.textContent = String(proxy?.type || "socks5").toLowerCase() === "direct" ? "直" : String(proxy?.type || "socks5").toLowerCase() === "socks5" ? "S" : "H";
}

function currentWindowProxyFromFields() {
  return {
    enabled: document.getElementById("dlg-proxy-enabled").value === "1",
    type: (document.getElementById("dlg-proxy-type").value || "socks5").toLowerCase(),
    host: document.getElementById("dlg-proxy-host").value.trim(),
    port: document.getElementById("dlg-proxy-port").value.trim(),
    username: document.getElementById("dlg-proxy-username").value.trim(),
    password: document.getElementById("dlg-proxy-password").value,
  };
}

function parseProxyInputValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const full = raw.match(/^(https?|socks5):\/\/([^/:]+):(\d+)(?::([^:]+))?(?::(.+))?$/i);
  if (full) {
    return {
      type: full[1].toLowerCase() === "socks5" ? "socks5" : "http",
      host: full[2],
      port: full[3],
      username: full[4] || "",
      password: full[5] || "",
    };
  }
  const simple = raw.match(/^([^/:]+):(\d+)$/);
  if (simple) {
    return { type: "socks5", host: simple[1], port: simple[2], username: "", password: "" };
  }
  return null;
}

function applyWindowProxyInput(enable = true) {
  const input = document.getElementById("dlg-proxy-managed");
  const value = input?.value || "";
  const matched = allProxyOptions().find(item => `${item.host}:${item.port}` === value || proxyKey(item) === value);
  const proxy = matched || parseProxyInputValue(value);
  if (!proxy) {
    document.getElementById("dlg-proxy-enabled").value = "";
    document.getElementById("dlg-proxy-host").value = "";
    document.getElementById("dlg-proxy-port").value = "";
    return;
  }
  if (enable) setWindowProxyMode("managed");
  setWindowProxyFields(proxy, true);
  renderWindowProxyDropdown(false);
}

function applyManagedProxySelection(enable = true) {
  applyWindowProxyInput(enable);
}

function clearWindowProxy() {
  setWindowProxyFields({}, false);
}

function fillWindowCustomProxy(proxy = {}) {
  const type = String(proxy.type || "socks5").toLowerCase();
  document.getElementById("dlg-custom-proxy-type").value = type === "direct" ? "direct" : type === "http" ? "http" : "socks5";
  document.getElementById("dlg-custom-proxy-host").value = proxy.host || "";
  document.getElementById("dlg-custom-proxy-port").value = proxy.port || "";
  document.getElementById("dlg-custom-proxy-username").value = proxy.username || "";
  document.getElementById("dlg-custom-proxy-password").value = proxy.password || "";
  updateWindowCustomProxyCounts();
  syncCustomProxyToHidden();
  toggleCustomProxyDirectMode();
}

function syncCustomProxyToHidden() {
  const type = document.getElementById("dlg-custom-proxy-type")?.value || "socks5";
  if (type === "direct") {
    setWindowProxyFields({ type: "direct" }, false);
    return;
  }
  const proxy = {
    type,
    host: document.getElementById("dlg-custom-proxy-host")?.value.trim() || "",
    port: document.getElementById("dlg-custom-proxy-port")?.value.trim() || "",
    username: document.getElementById("dlg-custom-proxy-username")?.value.trim() || "",
    password: document.getElementById("dlg-custom-proxy-password")?.value || "",
  };
  setWindowProxyFields(proxy, !!(proxy.host && proxy.port));
}

function toggleCustomProxyDirectMode() {
  const isDirect = document.getElementById("dlg-custom-proxy-type")?.value === "direct";
  document.querySelectorAll(".custom-proxy-dependent").forEach(node => {
    node.classList.toggle("direct-hidden", isDirect);
  });
  if (isDirect) setWindowProxyFields({ type: "direct" }, false);
}

function autofillWindowCustomProxy() {
  const hostEl = document.getElementById("dlg-custom-proxy-host");
  const parsed = parseProxyInputValue(hostEl?.value || "");
  if (!parsed) {
    syncCustomProxyToHidden();
    return;
  }
  fillWindowCustomProxy(parsed);
}

function clearWindowCustomHost() {
  document.getElementById("dlg-custom-proxy-host").value = "";
  syncCustomProxyToHidden();
}

function updateWindowCustomProxyCounts() {
  [
    ["dlg-custom-proxy-username", "dlg-custom-proxy-username-count"],
    ["dlg-custom-proxy-password", "dlg-custom-proxy-password-count"],
  ].forEach(([inputId, countId]) => {
    const input = document.getElementById(inputId);
    const count = document.getElementById(countId);
    if (!input || !count) return;
    const max = Number(input.getAttribute("maxlength")) || 200;
    count.textContent = `${String(input.value || "").length}/${max}`;
  });
}

function onWindowProxyModeChange() {
  const mode = getWindowProxyMode();
  document.getElementById("dlg-managed-proxy-section")?.classList.toggle("hidden", mode !== "managed");
  document.getElementById("dlg-custom-proxy-section")?.classList.toggle("hidden", mode !== "custom");
  if (mode === "managed") {
    applyManagedProxySelection(false);
    return;
  }
  syncCustomProxyToHidden();
}

function hideWindowDetectPopover() {
  document.getElementById("window-detect-popover")?.classList.remove("show");
}

function showWindowDetectPopover(event, result) {
  const popover = document.getElementById("window-detect-popover");
  if (!popover) return;
  const ok = !!(result && result.ip && result.ip !== "—");
  popover.classList.toggle("fail", !ok);
  if (!ok) {
    popover.innerHTML = `
      <div><strong>检测失败</strong></div>
      <div>${esc(result?.statusText || result?.error || "代理不可达或检测源不可用")}</div>
    `;
  } else {
    const location = [result.country, result.region, result.city].filter(v => v && v !== "—").join(" / ") || "—";
    const coordinate = result.lat !== "—" && result.lon !== "—" ? `${result.lat}/${result.lon}` : "—";
    popover.innerHTML = `
      <div><strong>IP：</strong>${esc(result.ip)}</div>
      <div><strong>国家/地区：</strong>${esc(location)}</div>
      <div><strong>城市：</strong>${esc(result.city || "—")}</div>
      <div><strong>经度/纬度：</strong>${esc(coordinate)}</div>
      <div><strong>时区：</strong>${esc(result.timezone || "—")}</div>
      <div><strong>邮编：</strong>${esc(result.zip || result.postal || "—")}</div>
      <div class="proxy-detect-warning">检测到该IP于最近时间</div>
      <div class="proxy-detect-warning">${esc(formatDetectTime(result.checkedAt))}</div>
      <div class="proxy-detect-danger">在本软件中使用过！</div>
      <div class="proxy-detect-muted">不正确？ <span class="proxy-detect-link">更正</span></div>
    `;
  }
  const rect = event?.currentTarget?.getBoundingClientRect?.() || { left: window.innerWidth - 240, bottom: 100 };
  popover.style.left = Math.min(window.innerWidth - 214, Math.max(8, rect.left - 118)) + "px";
  popover.style.top = Math.min(window.innerHeight - 260, rect.bottom + 8) + "px";
  popover.classList.add("show");
}

async function detectWindowProxy(event) {
  const proxy = currentWindowProxyFromFields();
  if (!proxy.host || !proxy.port) {
    toast("请选择或填写代理IP");
    return;
  }
  const result = await detectProxyWithApp({ ...proxy, enabled: true });
  showWindowDetectPopover(event, result);
  if (result && result.ip && result.ip !== "—") toast(`代理可用：${result.ip}`);
  else toast("代理检测失败: " + (result?.statusText || result?.error || "未知错误"));
}

async function copyWindowProxy() {
  const proxy = currentWindowProxyFromFields();
  if (!proxy.host || !proxy.port) {
    toast("没有可复制的代理");
    return;
  }
  const text = `${proxy.type}://${proxy.host}:${proxy.port}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("代理已复制");
  } catch {
    toast("复制失败");
  }
}

function toggleProxyFields() {
  onWindowProxyModeChange();
}

function updateNoteCount() {
  if (!noteInput || !noteCountEl) return;
  noteCountEl.textContent = `${noteInput.value.length}/500`;
}

function parseHomeURLs(value) {
  return String(value || "")
    .split(/\n|,/)
    .map(v => v.trim())
    .filter(Boolean);
}

function normalizeHomeURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:\/\/|chrome-extension:\/\/)/i.test(raw)) return raw;
  return "https://" + raw;
}

function renderHomeURLList() {
  const list = document.getElementById("dlg-home-list");
  if (!list) return;
  list.innerHTML = currentHomeURLs.map((url, index) => `
    <div class="url-chip" title="${esc(url)}">
      <span>${esc(url)}</span>
      <button type="button" onclick="removeHomeURL(${index})">×</button>
    </div>
  `).join("");
}

function addHomeURLsFromInput() {
  const input = document.getElementById("dlg-home");
  const incoming = parseHomeURLs(input.value).map(normalizeHomeURL).filter(Boolean);
  incoming.forEach(url => {
    if (!currentHomeURLs.includes(url)) currentHomeURLs.push(url);
  });
  input.value = "";
  renderHomeURLList();
}

function removeHomeURL(index) {
  currentHomeURLs.splice(index, 1);
  renderHomeURLList();
}

function clearHomeURLs() {
  currentHomeURLs = [];
  document.getElementById("dlg-home").value = "";
  renderHomeURLList();
}

function getSavedHomeURLs() {
  const input = document.getElementById("dlg-home");
  const pending = parseHomeURLs(input.value).map(normalizeHomeURL).filter(Boolean);
  const merged = currentHomeURLs.slice();
  pending.forEach(url => {
    if (!merged.includes(url)) merged.push(url);
  });
  currentHomeURLs = merged;
  renderHomeURLList();
  if (input) input.value = "";
  return merged;
}

function scrollConfigSection(name) {
  document.querySelectorAll(".rail-icon").forEach(node => node.classList.remove("active"));
  const index = name === "proxy" ? 1 : name === "fingerprint" ? 2 : 0;
  document.querySelectorAll(".rail-icon")[index]?.classList.add("active");
  document.getElementById("section-" + name)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function copyEditingId() {
  if (!editingEnvId) {
    toast("新窗口保存后才会生成 ID");
    return;
  }
  try {
    await navigator.clipboard.writeText(editingEnvId);
    toast("ID 已复制");
  } catch (e) {
    toast("复制失败");
  }
}

async function saveEnv() {
  if (getWindowProxyMode() === "managed") applyWindowProxyInput(false);
  else syncCustomProxyToHidden();
  const proxy = currentWindowProxyFromFields();
  if (proxy.enabled && (!proxy.host || !proxy.port)) {
    toast("请填写代理地址和端口");
    return;
  }
  const languageFollow = document.getElementById("dlg-language-follow-ip").checked;
  const languageValue = document.getElementById("dlg-language").value;
  if (!languageFollow && !languageValue) {
    document.getElementById("dlg-language-wrap")?.classList.add("invalid");
    document.getElementById("dlg-language-error")?.classList.add("show");
    toast("请选择语言");
    return;
  }
  document.getElementById("dlg-language-wrap")?.classList.remove("invalid");
  document.getElementById("dlg-language-error")?.classList.remove("show");
  const geoFollowIP = document.getElementById("dlg-geo-follow-ip").checked;
  const geoLat = Number(document.getElementById("dlg-geo-latitude").value);
  const geoLon = Number(document.getElementById("dlg-geo-longitude").value);
  if (!geoFollowIP && (!Number.isFinite(geoLat) || geoLat < -90 || geoLat > 90 || !Number.isFinite(geoLon) || geoLon < -180 || geoLon > 180)) {
    toast("请填写正确的地理位置经纬度");
    return;
  }
  const timezoneFollowIP = document.getElementById("dlg-timezone-follow-ip").checked;
  const timezone = document.getElementById("dlg-timezone").value.trim();
  if (!timezoneFollowIP) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch (e) {
      toast("请填写正确的 IANA 时区，例如 Asia/Shanghai");
      return;
    }
  }
  const envData = {
    name: document.getElementById("dlg-name").value.trim() || "未命名环境",
    note: document.getElementById("dlg-note").value.trim(),
    homeUrl: getSavedHomeURLs().join("\n"),
    proxy: proxy,
    ipGuard: currentIPGuardFromFields(),
    fingerprint: syncFingerprintFromForm(),
  };

  try {
    if (!await ensureSelectedKernel(true)) {
      toast("请先下载所选浏览器内核");
      return;
    }
    if (editingEnvId) {
      await window.daemon.updateEnvironment(editingEnvId, envData);
    } else {
      await window.daemon.createEnvironment(envData);
    }
    closeDialog();
    await refresh();
    toast(editingEnvId ? "环境已更新" : "环境已创建");
  } catch (e) {
    console.error("save environment failed:", e, envData);
    toast("保存失败: " + e.message);
  }
}

async function deleteEnv() {
  if (!editingEnvId) {
    toast("当前是创建窗口，没有可删除的环境");
    return;
  }
  if (deletingEnvIds.has(editingEnvId)) return;
  if (!confirm("确定删除此环境？")) return;
  deletingEnvIds.add(editingEnvId);
  try {
    const result = await window.daemon.deleteEnvironment(editingEnvId);
    closeDialog();
    await refresh();
    toast(result?.notFound ? "窗口已不存在，列表已刷新" : "环境已删除");
  } catch (e) {
    toast("删除失败: " + friendlyEnvironmentError(e));
  } finally {
    deletingEnvIds.delete(editingEnvId);
  }
}

function editEnv(envId) {
  if (!envId) {
    toast("修改配置失败: 缺少窗口ID");
    return;
  }
  showDialog(envId);
}

function showMoreMenu(event, envId) {
  event.stopPropagation();
  const anchor = event.currentTarget?.classList?.contains("more-btn")
    ? event.currentTarget
    : event.target?.closest?.(".more-btn");
  const env = environments.find(e => e.id === envId);
  if (!moreMenuEl || !env || !anchor) return;
  moreMenuAnchor = anchor;
  const runningActions = runningEnvIds.has(envId)
    ? `
    <div class="menu-item" data-action="restart" data-env-id="${envId}"><span class="menu-icon">↻</span><span>重启</span></div>
    <div class="menu-item danger" data-action="close" data-env-id="${envId}"><span class="menu-icon">×</span><span>关闭</span></div>`
    : "";
  moreMenuEl.innerHTML = `
    ${runningActions}
    <div class="menu-item" data-action="edit" data-env-id="${envId}"><span class="menu-icon">✎</span><span>修改</span></div>
    <div class="menu-item" onclick="placeholderAction('导入')"><span class="menu-icon">⇣</span><span>导入</span></div>
    <div class="menu-item" onclick="placeholderAction('导出')"><span class="menu-icon">⇡</span><span>导出</span></div>
    <div class="menu-item danger" onclick="deleteEnvById('${envId}')"><span class="menu-icon">⌫</span><span>删除</span></div>
    <div class="menu-item danger" data-action="clear-data" data-env-id="${envId}"><span class="menu-icon">⌘</span><span>清理缓存</span></div>
  `;
  moreMenuEl.style.visibility = "hidden";
  moreMenuEl.classList.add("show");
  positionMoreMenu();
  moreMenuEl.style.visibility = "visible";
}

function positionMoreMenu() {
  if (!moreMenuEl || !moreMenuAnchor || !document.contains(moreMenuAnchor)) return;
  const rect = moreMenuAnchor.getBoundingClientRect();
  const menuWidth = 178;
  const menuHeight = Math.min(moreMenuEl.scrollHeight, window.innerHeight - 16);
  // 右边缘与更多按钮对齐，菜单始终紧挨锚点。
  const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const top = spaceBelow >= menuHeight || spaceBelow >= spaceAbove
    ? Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 4)
    : Math.max(8, rect.top - menuHeight - 4);
  moreMenuEl.style.left = `${left}px`;
  moreMenuEl.style.top = `${top}px`;
}

function closeMoreMenu() {
  moreMenuEl?.classList.remove("show");
  moreMenuAnchor = null;
}

function placeholderAction(name) {
  closeMoreMenu();
  toast(`${name}功能暂未实现`);
}

async function clearEnvironmentData(envId) {
  closeMoreMenu();
  const env = environments.find(e => e.id === envId);
  if (!confirm(`确定清理「${env?.name || envId}」的缓存、Cookie 和站点数据吗？清理后需要重新登录。`)) return;
  try {
    const result = await window.browser.clearEnvironmentData(envId);
    toast(result?.ok ? "已清理缓存和登录数据，请重新登录" : (result?.message || "清理失败"));
  } catch (e) {
    toast("清理失败: " + e.message);
  }
}

async function deleteEnvById(envId) {
  closeMoreMenu();
  const env = environments.find(e => e.id === envId);
  if (deletingEnvIds.has(envId)) return;
  if (!confirm(`确定删除「${env?.name || envId}」？`)) return;
  deletingEnvIds.add(envId);
  try {
    const result = await window.daemon.deleteEnvironment(envId);
    await refresh();
    toast(result?.notFound ? "窗口已不存在，列表已刷新" : "环境已删除");
  } catch (e) {
    toast("删除失败: " + friendlyEnvironmentError(e));
  } finally {
    deletingEnvIds.delete(envId);
  }
}

// ========== Fingerprint ==========
function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, v => v.toString(16).padStart(2, "0")).join("");
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function randomHostIP() {
  return randomChoice([
    `192.168.${randomInt(0, 20)}.${randomInt(2, 240)}`,
    `10.${randomInt(0, 20)}.${randomInt(0, 255)}.${randomInt(2, 240)}`,
    `172.${randomInt(16, 31)}.${randomInt(0, 20)}.${randomInt(2, 240)}`,
  ]);
}

function randomMACAddress() {
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  values[0] = (values[0] | 0x02) & 0xfe;
  return Array.from(values, v => v.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function randomDeviceName(osType) {
  if (osType === "win") return randomChoice(["DESKTOP", "LAPTOP", "WORKSTATION"]) + "-" + randomHex(3).toUpperCase();
  return randomChoice(["MacBook-Pro", "MacBook-Air", "iMac", "Mac-mini"]) + "-" + randomHex(2).toUpperCase();
}

function getSelectedFingerprintOS() {
  return document.getElementById("dlg-fingerprint-os")?.value || "random";
}

function onFingerprintOSChangeVisibility() {
  const row = document.getElementById("dlg-windows-version-row");
  if (row) row.style.display = getSelectedFingerprintOS() === "win" ? "" : "none";
}

function setKernelUIState(state, version, message, percent = 0) {
  const control = document.getElementById("dlg-kernel-control");
  const name = document.getElementById("dlg-kernel-name");
  const badge = document.getElementById("dlg-kernel-badge");
  const help = document.getElementById("dlg-kernel-help");
  const progress = document.getElementById("dlg-kernel-progress");
  const updateButton = document.getElementById("dlg-kernel-update");
  const downloadButton = document.getElementById("dlg-kernel-download");
  const labels = { checking: "检测中", available: "未安装", downloading: "下载中", installed: "已安装", unavailable: "后台未提供", error: "检查失败" };
  if (control) control.dataset.state = state;
  if (name) name.textContent = `Chromium ${version}`;
  if (badge) badge.textContent = labels[state] || state;
  if (help) help.textContent = message || "";
  if (progress) progress.style.width = `${Math.max(0, Math.min(100, Number(percent || 0)))}%`;
  if (updateButton) updateButton.disabled = state === "checking" || state === "downloading";
  if (downloadButton) {
    downloadButton.hidden = state === "installed";
    downloadButton.disabled = state !== "available";
    downloadButton.textContent = state === "downloading" ? "下载中" : "下载并安装";
  }
}

async function refreshKernelStatus(version) {
  setKernelUIState("checking", version, "正在检查本机和服务器内核状态…");
  try {
    const result = await window.browser.kernelStatus();
    installedKernelVersions.clear();
    (result?.kernels || []).filter(item => item.installed).forEach(item => installedKernelVersions.add(String(item.version)));
    const item = (result?.kernels || []).find(row => String(row.version) === String(version));
    const installed = !!item?.installed;
    const available = !!item?.available;
    if (installed) {
      const message = result?.manifestLoaded === false ? `内核可用；${result.manifestError || "暂时无法检查更新"}` : "内核已安装，可直接创建并打开浏览器环境";
      setKernelUIState("installed", version, message);
    } else if (result?.manifestLoaded === false) {
      setKernelUIState("error", version, result.manifestError || "无法读取服务器内核清单，请稍后重试");
    } else if (available) {
      setKernelUIState("available", version, "后台已提供文件，将自动下载并安装");
    } else {
      setKernelUIState("unavailable", version, `服务器尚未提供 Chromium ${version} 内核，请联系管理员上传`);
    }
    return { installed, available, error: result?.manifestError || "" };
  } catch (error) {
    const message = error?.message || "内核状态检测失败，请稍后重试";
    setKernelUIState("error", version, message);
    return { installed: false, available: false, error: message };
  }
}

async function ensureSelectedKernel(interactive = true, knownStatus = null) {
  const version = document.getElementById("dlg-kernel-version")?.value || "148";
  if (kernelDownloadInProgress === version) return false;
  const status = knownStatus || await refreshKernelStatus(version);
  if (status.installed) return true;
  if (!status.available) {
    const message = status.error || `服务器尚未提供 Chromium ${version} 内核`;
    if (interactive) toast(message);
    return false;
  }
  kernelDownloadInProgress = version;
  setKernelUIState("downloading", version, "正在准备下载 Chromium 内核…", 0);
  const result = await window.browser.ensureKernel(version);
  kernelDownloadInProgress = "";
  if (!result?.success) {
    const state = String(result?.error || "").includes("尚未提供") ? "unavailable" : "error";
    setKernelUIState(state, version, result?.error || "内核下载失败，请稍后重试");
    toast(result?.error || "内核下载失败");
    return false;
  }
  installedKernelVersions.add(version);
  setKernelUIState("installed", version, "内核已安装，可直接创建并打开浏览器环境", 100);
  toast(`Chromium ${version} 内核安装完成`);
  return true;
}

async function updateSelectedKernel() {
  const version = document.getElementById("dlg-kernel-version")?.value || "148";
  if (kernelDownloadInProgress) return;
  const status = await refreshKernelStatus(version);
  if (!status.available) {
    toast(status.error || `服务器尚未提供 Chromium ${version} 内核`);
    return;
  }
  kernelDownloadInProgress = version;
  setKernelUIState("downloading", version, "正在下载并更新 Chromium 内核…", 0);
  const result = await window.browser.updateKernel(version);
  kernelDownloadInProgress = "";
  if (!result?.success) {
    const state = String(result?.error || "").includes("尚未提供") ? "unavailable" : "error";
    setKernelUIState(state, version, result?.error || "内核更新失败，请稍后重试");
    toast(result?.error || "内核更新失败");
    return;
  }
  installedKernelVersions.add(version);
  setKernelUIState("installed", version, "已更新到服务器提供的最新内核", 100);
  toast(`Chromium ${version} 内核更新完成`);
}

async function prepareSelectedKernel() {
  const version = document.getElementById("dlg-kernel-version")?.value || "148";
  const status = await refreshKernelStatus(version);
  if (!status.installed && status.available) await ensureSelectedKernel(false, status);
}

async function onKernelVersionChange() {
  const kernel = document.getElementById("dlg-kernel-version")?.value || "148";
  const browser = document.getElementById("dlg-browser-version");
  if (browser && kernel === "148" && browser.value === "147") browser.value = "148";
  renderFingerprintSummary();
  await prepareSelectedKernel();
}

function onBrowserVersionChange() {
  const browser = document.getElementById("dlg-browser-version")?.value || "148";
  const kernel = document.getElementById("dlg-kernel-version")?.value || "148";
  if (browser === "147" && kernel === "148") {
    toast("浏览器版本 147 不能选择 Chromium 148 内核，请先选择兼容内核");
    document.getElementById("dlg-browser-version").value = "148";
  }
  renderFingerprintSummary();
}

function inferFingerprintOS(fp) {
  if (!fp) return "random";
  if (fp.os === "mac" || fp.os === "win") return fp.os;
  if (fp.platform === "Win32" || String(fp.userAgent || "").includes("Windows")) return "win";
  if (fp.platform === "MacIntel" || String(fp.userAgent || "").includes("Macintosh")) return "mac";
  return "random";
}

function getOSProfile(osType) {
  const profiles = {
    mac: {
      os: "mac",
      label: "macOS",
      platform: "MacIntel",
      uaOS: "Macintosh; Intel Mac OS X 10_15_7",
      screen: randomChoice([[1440,900],[1512,982],[1680,1050],[1728,1117],[1920,1080]]),
      webgl: ["Apple Inc.", randomChoice(["Apple M1", "Apple M2", "Apple GPU"])]
    },
    win: {
      os: "win",
      label: "Windows",
      platform: "Win32",
      uaOS: "Windows NT 10.0; Win64; x64",
      screen: randomChoice([[1366,768],[1440,900],[1536,864],[1920,1080],[2560,1440]]),
      webgl: randomChoice([
        ["Google Inc. (Intel)", "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)"],
        ["Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0)"],
        ["Google Inc. (AMD)", "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)"]
      ])
    }
  };
  const selected = osType === "mac" || osType === "win" ? osType : randomChoice(["mac", "win"]);
  return profiles[selected];
}

function generateFingerprint(osType = "random") {
  const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  const chromeBuild = chromeMatch ? chromeMatch[1] : "126.0.6478.127";
  const os = getOSProfile(osType);
  const locale = { language: "zh-CN", languages: "zh-CN,zh,en-US,en", timezone: "Asia/Shanghai" };
  return {
    os: os.os,
    kernelVersion: document.getElementById("dlg-kernel-version")?.value || "148",
    browserVersion: document.getElementById("dlg-browser-version")?.value || "148",
    windowsVersion: document.getElementById("dlg-windows-version")?.value || "11",
    deviceName: randomDeviceName(os.os),
    hostIp: randomHostIP(),
    macAddress: randomMACAddress(),
    portScanProtection: true,
    userAgent: `Mozilla/5.0 (${os.uaOS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeBuild} Safari/537.36`,
    platform: os.platform,
    vendor: "Google Inc.",
    language: locale.language,
    languages: locale.languages,
    languageFollowIP: false,
    uiLanguageFollowIP: true,
    uiLanguage: "",
    timezoneFollowIP: true,
    geoPermission: "block",
    geolocationFollowIP: false,
    geoLatitude: 30.274084,
    geoLongitude: 120.15507,
    geoAccuracy: 50,
    webrtcMode: "hide",
    ignoreHttpsErrors: false,
    windowWidth: os.screen[0],
    windowHeight: os.screen[1],
    timezone: locale.timezone,
    screenWidth: os.screen[0],
    screenHeight: os.screen[1],
    colorDepth: 24,
    hardwareConcurrency: randomChoice([4, 6, 8, 10, 12]),
    deviceMemory: randomChoice([4, 8, 16]),
    webGLVendor: os.webgl[0],
    webGLRenderer: os.webgl[1],
    canvasNoise: randomHex(4),
  };
}

function normalizeFingerprint(fp) {
  if (!fp || !fp.userAgent) return generateFingerprint(getSelectedFingerprintOS());
  const inferredOS = inferFingerprintOS(fp);
  const fallback = generateFingerprint(inferredOS);
  return {
    os: inferredOS === "random" ? fallback.os : inferredOS,
    kernelVersion: ["148", "146", "144", "142"].includes(String(fp.kernelVersion)) ? String(fp.kernelVersion) : "148",
    browserVersion: ["148", "147"].includes(String(fp.browserVersion)) ? String(fp.browserVersion) : "148",
    windowsVersion: ["10", "11"].includes(String(fp.windowsVersion)) ? String(fp.windowsVersion) : "11",
    deviceName: fp.deviceName || fallback.deviceName,
    hostIp: fp.hostIp || fp.hostIP || fallback.hostIp,
    macAddress: fp.macAddress || fallback.macAddress,
    portScanProtection: fp.portScanProtection !== false,
    userAgent: fp.userAgent || fallback.userAgent,
    platform: fp.platform || fallback.platform,
    vendor: fp.vendor || "Google Inc.",
    language: fp.language || fallback.language,
    languages: fp.languages || fallback.languages,
    languageFollowIP: !!fp.languageFollowIP,
    uiLanguageFollowIP: fp.uiLanguageFollowIP !== false,
    uiLanguage: fp.uiLanguage || "",
    timezoneFollowIP: fp.timezoneFollowIP !== false,
    geoPermission: ["ask", "allow", "block"].includes(fp.geoPermission) ? fp.geoPermission : "block",
    geolocationFollowIP: fp.geolocationFollowIP === true,
    geoLatitude: Number(fp.geoLatitude ?? fp.latitude ?? fallback.geoLatitude),
    geoLongitude: Number(fp.geoLongitude ?? fp.longitude ?? fallback.geoLongitude),
    geoAccuracy: Number(fp.geoAccuracy ?? fp.accuracy ?? fallback.geoAccuracy),
    webrtcMode: ["replace", "hide", "allow", "block"].includes(fp.webrtcMode) ? fp.webrtcMode : "hide",
    ignoreHttpsErrors: !!fp.ignoreHttpsErrors,
    windowWidth: Number(fp.windowWidth || fp.browserWidth || fallback.windowWidth || fallback.screenWidth || 1280),
    windowHeight: Number(fp.windowHeight || fp.browserHeight || fallback.windowHeight || fallback.screenHeight || 720),
    timezone: fp.timezone || fallback.timezone,
    screenWidth: Number(fp.screenWidth || fallback.screenWidth),
    screenHeight: Number(fp.screenHeight || fallback.screenHeight),
    colorDepth: Number(fp.colorDepth || 24),
    hardwareConcurrency: Number(fp.hardwareConcurrency || fallback.hardwareConcurrency),
    deviceMemory: Number(fp.deviceMemory || fallback.deviceMemory),
    webGLVendor: fp.webGLVendor || fallback.webGLVendor,
    webGLRenderer: fp.webGLRenderer || fallback.webGLRenderer,
    canvasNoise: fp.canvasNoise || fallback.canvasNoise,
  };
}

function randomizeFingerprint() {
  currentFingerprint = generateFingerprint(getSelectedFingerprintOS());
  fillFingerprintForm(currentFingerprint);
  renderFingerprintSummary();
  toast("已生成随机指纹，保存后生效");
}

function onFingerprintOSChange() {
  currentFingerprint = generateFingerprint(getSelectedFingerprintOS());
  fillFingerprintForm(currentFingerprint);
  onFingerprintOSChangeVisibility();
  renderFingerprintSummary();
  toast("已按操作系统生成新指纹，保存后生效");
}

function fillFingerprintForm(fp) {
  const normalized = normalizeFingerprint(fp);
  document.getElementById("dlg-language-follow-ip").checked = !!normalized.languageFollowIP;
  document.getElementById("dlg-language").value = normalized.language || "";
  document.getElementById("dlg-ui-language-follow-ip").checked = !!normalized.uiLanguageFollowIP;
  document.getElementById("dlg-ui-language").value = normalized.uiLanguage || "";
  document.getElementById("dlg-timezone-follow-ip").checked = normalized.timezoneFollowIP !== false;
  document.getElementById("dlg-timezone").value = normalized.timezone || "Asia/Shanghai";
  const geoPermission = normalized.geoPermission || "allow";
  const geoPermissionInput = document.querySelector(`input[name="dlg-geo-permission"][value="${geoPermission}"]`);
  if (geoPermissionInput) geoPermissionInput.checked = true;
  document.getElementById("dlg-geo-follow-ip").checked = normalized.geolocationFollowIP !== false;
  document.getElementById("dlg-geo-latitude").value = Number.isFinite(normalized.geoLatitude) ? String(normalized.geoLatitude) : "";
  document.getElementById("dlg-geo-longitude").value = Number.isFinite(normalized.geoLongitude) ? String(normalized.geoLongitude) : "";
  document.getElementById("dlg-geo-accuracy").value = Number.isFinite(normalized.geoAccuracy) ? String(normalized.geoAccuracy) : "50";
  const webrtcModeInput = document.querySelector(`input[name="dlg-webrtc-mode"][value="${normalized.webrtcMode || "hide"}"]`);
  if (webrtcModeInput) webrtcModeInput.checked = true;
  document.getElementById("dlg-ignore-https-errors").checked = !!normalized.ignoreHttpsErrors;
  document.getElementById("dlg-window-width").value = Number.isFinite(normalized.windowWidth) ? String(normalized.windowWidth) : "";
  document.getElementById("dlg-window-height").value = Number.isFinite(normalized.windowHeight) ? String(normalized.windowHeight) : "";
  document.getElementById("dlg-device-name").value = normalized.deviceName || "";
  document.getElementById("dlg-host-ip").value = normalized.hostIp || "";
  document.getElementById("dlg-mac-address").value = normalized.macAddress || "";
  document.getElementById("dlg-hardware-concurrency").value = String(normalized.hardwareConcurrency || 8);
  document.getElementById("dlg-device-memory").value = String(normalized.deviceMemory || 8);
  document.getElementById("dlg-port-scan-protection").checked = normalized.portScanProtection !== false;
  toggleLanguageFields();
  toggleGeolocationFields();
  toggleTimezoneFields();
}

function syncFingerprintFromForm() {
  currentFingerprint = normalizeFingerprint(currentFingerprint);
  currentFingerprint.kernelVersion = document.getElementById("dlg-kernel-version")?.value || "148";
  currentFingerprint.browserVersion = document.getElementById("dlg-browser-version")?.value || "148";
  currentFingerprint.windowsVersion = document.getElementById("dlg-windows-version")?.value || "11";
  const languageFollowIP = document.getElementById("dlg-language-follow-ip").checked;
  const selectedLanguage = document.getElementById("dlg-language").value;
  currentFingerprint.languageFollowIP = languageFollowIP;
  if (!languageFollowIP && selectedLanguage) {
    currentFingerprint.language = selectedLanguage;
    currentFingerprint.languages = `${selectedLanguage},${selectedLanguage.split("-")[0]},en-US,en`;
  }
  currentFingerprint.uiLanguageFollowIP = document.getElementById("dlg-ui-language-follow-ip").checked;
  currentFingerprint.uiLanguage = document.getElementById("dlg-ui-language").value;
  currentFingerprint.timezoneFollowIP = document.getElementById("dlg-timezone-follow-ip").checked;
  if (!currentFingerprint.timezoneFollowIP) {
    currentFingerprint.timezone = document.getElementById("dlg-timezone").value.trim() || currentFingerprint.timezone || "Asia/Shanghai";
  }
  currentFingerprint.geoPermission = document.querySelector('input[name="dlg-geo-permission"]:checked')?.value || "allow";
  currentFingerprint.geolocationFollowIP = document.getElementById("dlg-geo-follow-ip").checked;
  currentFingerprint.geoLatitude = Number(document.getElementById("dlg-geo-latitude").value || currentFingerprint.geoLatitude || 30.274084);
  currentFingerprint.geoLongitude = Number(document.getElementById("dlg-geo-longitude").value || currentFingerprint.geoLongitude || 120.15507);
  currentFingerprint.geoAccuracy = Number(document.getElementById("dlg-geo-accuracy").value || currentFingerprint.geoAccuracy || 50);
  currentFingerprint.webrtcMode = document.querySelector('input[name="dlg-webrtc-mode"]:checked')?.value || "hide";
  currentFingerprint.ignoreHttpsErrors = document.getElementById("dlg-ignore-https-errors").checked;
  currentFingerprint.windowWidth = Number(document.getElementById("dlg-window-width").value || currentFingerprint.windowWidth || currentFingerprint.screenWidth || 1280);
  currentFingerprint.windowHeight = Number(document.getElementById("dlg-window-height").value || currentFingerprint.windowHeight || currentFingerprint.screenHeight || 720);
  currentFingerprint.deviceName = document.getElementById("dlg-device-name").value.trim() || currentFingerprint.deviceName;
  currentFingerprint.hostIp = document.getElementById("dlg-host-ip").value.trim() || currentFingerprint.hostIp;
  currentFingerprint.macAddress = document.getElementById("dlg-mac-address").value.trim() || currentFingerprint.macAddress;
  currentFingerprint.hardwareConcurrency = Number(document.getElementById("dlg-hardware-concurrency").value || currentFingerprint.hardwareConcurrency || 8);
  currentFingerprint.deviceMemory = Number(document.getElementById("dlg-device-memory").value || currentFingerprint.deviceMemory || 8);
  currentFingerprint.portScanProtection = document.getElementById("dlg-port-scan-protection").checked;
  return normalizeFingerprint(currentFingerprint);
}

function toggleLanguageFields() {
  const languageFollow = document.getElementById("dlg-language-follow-ip").checked;
  const uiFollow = document.getElementById("dlg-ui-language-follow-ip").checked;
  const languageSelect = document.getElementById("dlg-language");
  const languageWrap = document.getElementById("dlg-language-wrap");
  languageSelect.disabled = languageFollow;
  document.getElementById("dlg-ui-language").disabled = uiFollow;
  if (languageFollow || languageSelect.value) {
    languageWrap?.classList.remove("invalid");
    document.getElementById("dlg-language-error")?.classList.remove("show");
  }
}

function toggleGeolocationFields() {
  const followIP = document.getElementById("dlg-geo-follow-ip").checked;
  const customRow = document.getElementById("dlg-geo-custom-row");
  if (customRow) customRow.style.display = followIP ? "none" : "";
  ["dlg-geo-latitude", "dlg-geo-longitude", "dlg-geo-accuracy"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = followIP;
  });
  const checked = document.querySelector('input[name="dlg-geo-permission"]:checked')?.value || "allow";
  const hint = document.querySelector(".geo-hint");
  if (hint) {
    hint.textContent = checked === "block"
      ? "网站请求获取您当前的位置时，始终被禁止"
      : checked === "ask"
        ? "网站请求获取您当前的位置时，将会询问"
        : "网站请求获取您当前的位置时，始终被允许";
  }
}

function toggleTimezoneFields() {
  const followIP = document.getElementById("dlg-timezone-follow-ip").checked;
  const customRow = document.getElementById("dlg-timezone-custom-row");
  const timezoneInput = document.getElementById("dlg-timezone");
  if (customRow) customRow.style.display = followIP ? "none" : "";
  if (timezoneInput) timezoneInput.disabled = followIP;
}

function renderFingerprintSummary() {
  const box = document.getElementById("dlg-fingerprint-summary");
  if (!box) return;
  syncFingerprintFromForm();
  currentFingerprint = normalizeFingerprint(currentFingerprint);
  const osLabel = currentFingerprint.os === "win" ? "Windows" : "macOS";
  const browserLanguage = currentFingerprint.languageFollowIP ? "基于IP" : currentFingerprint.language;
  const uiLanguage = currentFingerprint.uiLanguageFollowIP ? "基于IP" : (currentFingerprint.uiLanguage || "跟随系统");
  const geoPermissionLabel = { ask: "询问", allow: "允许", block: "禁止" }[currentFingerprint.geoPermission] || "允许";
  const geoLabel = currentFingerprint.geolocationFollowIP
    ? "基于IP"
    : `${currentFingerprint.geoLatitude}, ${currentFingerprint.geoLongitude}`;
  const webrtcLabel = { replace: "替换", hide: "隐私", allow: "允许", block: "禁止" }[currentFingerprint.webrtcMode] || "隐私";
  box.innerHTML = `
    <div><strong>内核:</strong> Chromium ${esc(currentFingerprint.kernelVersion)} · <strong>浏览器版本:</strong> ${esc(currentFingerprint.browserVersion)}${currentFingerprint.os === "win" ? ` · Windows ${esc(currentFingerprint.windowsVersion)}` : ""}</div>
    <div><strong>UA:</strong> ${esc(currentFingerprint.userAgent)}</div>
    <div><strong>设备:</strong> ${esc(currentFingerprint.deviceName)} · ${esc(currentFingerprint.hostIp)} · ${esc(currentFingerprint.macAddress)}</div>
    <div><strong>系统:</strong> ${osLabel} · <strong>平台:</strong> ${esc(currentFingerprint.platform)} · ${esc(browserLanguage)} · 界面 ${esc(uiLanguage)} · 时区 ${currentFingerprint.timezoneFollowIP ? "基于IP" : esc(currentFingerprint.timezone)}</div>
    <div><strong>定位:</strong> ${esc(geoPermissionLabel)} · ${esc(geoLabel)} · 精度 ${currentFingerprint.geoAccuracy || 50}m</div>
    <div><strong>WebRTC:</strong> ${esc(webrtcLabel)} · <strong>HTTPS证书:</strong> ${currentFingerprint.ignoreHttpsErrors ? "忽略错误" : "正常校验"} · <strong>窗口:</strong> ${currentFingerprint.windowWidth}×${currentFingerprint.windowHeight}</div>
    <div><strong>屏幕:</strong> ${currentFingerprint.screenWidth}×${currentFingerprint.screenHeight} · CPU ${currentFingerprint.hardwareConcurrency} 核 · 内存 ${currentFingerprint.deviceMemory}GB · 端口保护 ${currentFingerprint.portScanProtection ? "开" : "关"}</div>
    <div><strong>WebGL:</strong> ${esc(currentFingerprint.webGLVendor)} / ${esc(currentFingerprint.webGLRenderer)}</div>
  `;
}

// ========== Open Browser ==========
async function openEnv(envId) {
  console.log("[renderer] openEnv clicked", envId);
  const env = environments.find(e => e.id === envId);
  if (runningEnvIds.has(envId)) {
    toast("该浏览器正在运行中");
    return;
  }
  toast(`正在启动「${env?.name || envId}」...`);
  try {
    const result = await window.browser.open(envId);
    console.log("[renderer] openEnv result", result);
    if (result.error) {
      toast("启动失败: " + result.error);
      return;
    }
    setRunningBrowserDetail({ ...(result || {}), envId, running: true });
    renderList();
  } catch (e) {
    toast("启动失败: " + e.message);
  }
}

async function closeEnv(envId) {
  closeMoreMenu();
  const env = environments.find(e => e.id === envId);
  if (!runningEnvIds.has(envId)) {
    toast("该浏览器未运行");
    return;
  }
  toast(`正在关闭「${env?.name || envId}」...`);
  try {
    const result = await window.browser.close(envId);
    if (result?.error && result.error !== "not found") {
      toast("关闭失败: " + result.error);
      return;
    }
    runningEnvIds.delete(envId);
    runningBrowserDetails.delete(envId);
    renderList();
    toast("浏览器已关闭");
  } catch (e) {
    toast("关闭失败: " + e.message);
  }
}

async function restartEnv(envId) {
  closeMoreMenu();
  const env = environments.find(e => e.id === envId);
  toast(`正在重启「${env?.name || envId}」...`);
  try {
    if (runningEnvIds.has(envId)) {
      await window.browser.close(envId);
      runningEnvIds.delete(envId);
      runningBrowserDetails.delete(envId);
      renderList();
      await new Promise(resolve => setTimeout(resolve, 450));
    }
    const result = await window.browser.open(envId);
    if (result?.error) {
      toast("重启失败: " + result.error);
      return;
    }
    setRunningBrowserDetail({ ...(result || {}), envId, running: true });
    renderList();
    toast("浏览器已重启");
  } catch (e) {
    toast("重启失败: " + e.message);
  }
}

async function refreshUploadView() {
  renderUploadProxyOptions();
  if (!window.uploader?.transporterStatus) return;
  try {
    const status = await window.uploader.transporterStatus();
    const el = document.getElementById("upload-transporter-status");
    if (el) {
      el.textContent = status?.available
        ? `上传环境可用：${status.source || "iTMSTransporter"}`
        : "上传环境不可用：请确认软件内置 iTMSTransporter 组件完整";
      el.style.color = status?.available ? "#16a34a" : "#e74c3c";
    }
  } catch (e) {
    const el = document.getElementById("upload-transporter-status");
    if (el) {
      el.textContent = "上传环境检测失败";
      el.style.color = "#e74c3c";
    }
  }
}

async function selectIPAFile() {
  if (!requireLogin()) return;
  if (!window.uploader?.selectIPA) return;
  const result = await window.uploader.selectIPA();
  if (result?.canceled) return;
  selectedIPAPath = result.path || "";
  const label = document.getElementById("upload-file-path");
  if (label) label.textContent = result.filename || selectedIPAPath || "已选择 IPA 文件";
}

function renderUploadProxyOptions() {
  const mode = document.getElementById("upload-network")?.value || "direct";
  const wrap = document.getElementById("upload-env-wrap");
  if (wrap) wrap.style.display = mode === "environment" ? "" : "none";
  if (mode !== "environment") {
    document.getElementById("upload-proxy-dropdown")?.classList.remove("show");
    return;
  }
  const items = allProxyOptions().filter(proxy => proxy.host && proxy.port && String(proxy.type || "http").toLowerCase() !== "direct");
  if (!selectedUploadProxyKey || !items.find(proxy => proxyKey(proxy) === selectedUploadProxyKey)) {
    selectedUploadProxyKey = items[0] ? proxyKey(items[0]) : "";
  }
  const selected = items.find(proxy => proxyKey(proxy) === selectedUploadProxyKey) || null;
  setUploadProxySelection(selected, false);
  renderUploadProxyDropdown(false);
}

function changeUploadNetwork() {
  const select = document.getElementById("upload-network");
  if (select?.value === "environment" && !requireLogin()) select.value = "direct";
  renderUploadProxyOptions();
}

function setUploadProxySelection(proxy, rerender = true) {
  const input = document.getElementById("upload-env-proxy");
  const badge = document.getElementById("upload-proxy-badge");
  if (proxy && proxy.host && proxy.port) {
    selectedUploadProxyKey = proxyKey(proxy);
    if (input) input.value = `${proxy.host}:${proxy.port}`;
    if (badge) {
      const type = String(proxy.type || "socks5").toLowerCase();
      badge.textContent = type === "socks5" ? "S" : "H";
    }
  } else {
    selectedUploadProxyKey = "";
    if (input) input.value = "";
    if (badge) badge.textContent = "S";
  }
  if (rerender) renderUploadProxyDropdown(false);
}

function renderUploadProxyDropdown(useFilter = true) {
  const dropdown = document.getElementById("upload-proxy-dropdown");
  if (!dropdown) return;
  const keyword = useFilter ? (document.getElementById("upload-env-proxy")?.value || "").toLowerCase() : "";
  uploadProxyDropdownItems = allProxyOptions().filter(proxy => {
    if (!proxy.host || !proxy.port || String(proxy.type || "http").toLowerCase() === "direct") return false;
    if (!keyword) return true;
    return [proxy.host, proxy.port, proxy.note, proxy.type].filter(Boolean).join(" ").toLowerCase().includes(keyword);
  });
  if (!uploadProxyDropdownItems.length) {
    dropdown.innerHTML = `<div class="window-proxy-empty">暂无匹配代理</div>`;
    return;
  }
  dropdown.innerHTML = uploadProxyDropdownItems.map((proxy, index) => {
    const key = proxyKey(proxy);
    const count = boundProxyCount(proxy);
    const type = String(proxy.type || "socks5").toLowerCase() === "socks5" ? "S" : "H";
    return `
      <div class="window-proxy-option ${key === selectedUploadProxyKey ? "active" : ""}" onmousedown="selectUploadProxyOption(${index})">
        <span class="proxy-select-badge">${type}</span>
        <div class="window-proxy-main">${esc(proxy.host)}:${esc(proxy.port)}</div>
        <div class="window-proxy-bound">已绑定 ${count} 窗口</div>
        <div class="window-proxy-note">备注: ${esc(proxy.note || "无")}</div>
      </div>
    `;
  }).join("");
}

function showUploadProxyDropdown() {
  if (!requireLogin()) {
    document.getElementById("upload-env-proxy")?.blur();
    return;
  }
  renderUploadProxyDropdown(false);
  document.getElementById("upload-proxy-dropdown")?.classList.add("show");
}

function hideUploadProxyDropdown() {
  setTimeout(() => {
    const selected = allProxyOptions().find(proxy => proxyKey(proxy) === selectedUploadProxyKey);
    setUploadProxySelection(selected || null, false);
    document.getElementById("upload-proxy-dropdown")?.classList.remove("show");
  }, 120);
}

function toggleUploadProxyDropdown() {
  const dropdown = document.getElementById("upload-proxy-dropdown");
  if (!dropdown) return;
  if (dropdown.classList.contains("show")) dropdown.classList.remove("show");
  else showUploadProxyDropdown();
}

function selectUploadProxyOption(index) {
  if (!requireLogin()) return;
  const proxy = uploadProxyDropdownItems[index];
  if (!proxy) return;
  setUploadProxySelection(proxy);
  document.getElementById("upload-proxy-dropdown")?.classList.remove("show");
}

function selectedUploadProxy() {
  const mode = document.getElementById("upload-network")?.value || "direct";
  if (mode !== "environment") return { enabled: false };
  const proxy = allProxyOptions().find(item => proxyKey(item) === selectedUploadProxyKey);
  if (!proxy || !proxy.host || !proxy.port) return { enabled: false };
  return { ...proxy, enabled: true };
}

function appendUploadLog(level, message, time = "") {
  const box = document.getElementById("upload-log");
  if (!box) return;
  const line = document.createElement("div");
  line.className = `upload-log-line ${level || "info"}`;
  line.textContent = `${time ? `[${time}] ` : ""}${message || ""}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearUploadLog() {
  const box = document.getElementById("upload-log");
  if (box) box.innerHTML = "";
  renderedUploadEventCount = 0;
  document.getElementById("upload-task-state").textContent = activeUploadTaskId ? "日志已清空" : "待上传";
}

async function startIPAUpload() {
  if (!requireLogin()) return;
  const appleId = document.getElementById("upload-apple-id")?.value.trim() || "";
  const password = document.getElementById("upload-password")?.value || "";
  if (!selectedIPAPath) {
    toast("请选择 IPA 文件");
    return;
  }
  if (!appleId || !password) {
    toast("请填写 Apple ID 和 App 专用密码");
    return;
  }
  clearUploadLog();
  const uploadProxy = selectedUploadProxy();
  if ((document.getElementById("upload-network")?.value || "direct") === "environment" && !uploadProxy.enabled) {
    appendUploadLog("error", "请选择一个有效的代理配置。");
    toast("请选择代理");
    return;
  }
  if (uploadProxy.enabled) {
    appendUploadLog("info", "正在检测所选代理是否可用...");
    try {
      const detected = await detectProxyWithApp(uploadProxy);
      if (!detected?.ip || detected.ip === "—") {
        const reason = detected?.statusText || "代理连接失败";
        appendUploadLog("error", `代理不可用：${reason}`);
        toast("代理不可用，已停止上传");
        return;
      }
      appendUploadLog("success", `代理检测通过，出口 IP：${detected.ip}`);
    } catch (e) {
      appendUploadLog("error", `代理检测失败：${e.message || "未知错误"}`);
      toast("代理检测失败，已停止上传");
      return;
    }
  } else {
    appendUploadLog("info", "未选择代理，将使用本机网络直接上传。");
  }
  appendUploadLog("info", "准备启动上传任务...");
  try {
    const result = await window.uploader.start({
      ipaPath: selectedIPAPath,
      appleId,
      password,
      proxy: uploadProxy,
    });
    if (result?.error) {
      appendUploadLog("error", result.error);
      toast("上传启动失败: " + result.error);
      return;
    }
    activeUploadTaskId = result.taskId;
    renderedUploadEventCount = 0;
    document.getElementById("upload-task-state").textContent = "上传中";
    pollUploadStatus();
    if (uploadPollTimer) clearInterval(uploadPollTimer);
    uploadPollTimer = setInterval(pollUploadStatus, 1200);
  } catch (e) {
    appendUploadLog("error", e.message);
    toast("上传启动失败: " + e.message);
  }
}

async function pollUploadStatus() {
  if (!activeUploadTaskId || !window.uploader?.status) return;
  const task = await window.uploader.status(activeUploadTaskId);
  if (task?.error && !task.events) {
    appendUploadLog("error", task.error);
    clearInterval(uploadPollTimer);
    uploadPollTimer = null;
    return;
  }
  const events = Array.isArray(task.events) ? task.events : [];
  events.slice(renderedUploadEventCount).forEach(event => appendUploadLog(event.level, event.message, event.time));
  renderedUploadEventCount = events.length;
  const stateEl = document.getElementById("upload-task-state");
  if (stateEl) {
    stateEl.textContent = task.statusText || (task.status === "error" ? "上传失败" : task.status === "running" ? "上传中" : "处理结果未确认");
    stateEl.style.color = ({ success: "#22c55e", error: "#ef4444", warning: "#eab308", info: "#d1d5db" })[task.statusLevel] || "#d1d5db";
  }
  if (task.status !== "running" && !task.monitorActive) {
    if (uploadPollTimer) clearInterval(uploadPollTimer);
    uploadPollTimer = null;
    if (task.error) appendUploadLog("error", task.error);
  }
}

async function analyzeUploadLogs() {
  if (uploadAIAnalysisBusy) return;
  if (!requireLogin()) return;
  const button = document.querySelector(".upload-ai-btn");
  const previousText = button?.textContent || "AI 解析上传错误";
  const logLines = Array.from(document.querySelectorAll("#upload-log .upload-log-line"))
    .map(node => String(node.textContent || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!logLines) {
    toast("请先保留一段上传日志再解析");
    return;
  }
  uploadAIAnalysisBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = "解析中…";
  }
  try {
    const result = await (window.uploader?.analyzeUploadLogs?.({ error_logs: logLines }) || window.uploader?.analyzeUploadError?.({ error_logs: logLines }));
    if (!result?.success) throw new Error(result?.error || "AI 解析失败");
    appendUploadLog("success", "AI 解析结果：");
    String(result.analysis || "未返回分析结果").split(/\r?\n/).forEach(line => appendUploadLog("info", line));
  } catch (error) {
    appendUploadLog("error", `AI 解析失败：${error.message || "未知错误"}`);
    toast("AI 解析失败: " + (error.message || "未知错误"));
  } finally {
    uploadAIAnalysisBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

// ========== Utils ==========
function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).substring(0, 16);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hh}:${mm}`;
}

function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function friendlyEnvironmentError(error) {
  const raw = String(error?.message || error || "未知错误")
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  if (/environment not found/i.test(raw)) return "窗口已不存在，请刷新列表后再试";
  return raw || "未知错误";
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2500);
}

const browserFloatingContact = document.getElementById("browser-floating-contact");
const browserFloatingContactTrigger = document.getElementById("browser-floating-contact-trigger");
const browserFloatingContactPanel = document.getElementById("browser-floating-contact-panel");
const BROWSER_FLOATING_CONTACT_POSITION_KEY = "browser-floating-contact-position-v1";
const BROWSER_FLOATING_CONTACT_EDGE = 10;
let browserFloatingContactDrag = null;
let suppressBrowserFloatingContactClick = false;

function clampBrowserFloatingContactPosition(left, top) {
  const width = browserFloatingContact.offsetWidth;
  const height = browserFloatingContact.offsetHeight;
  const maxLeft = Math.max(BROWSER_FLOATING_CONTACT_EDGE, window.innerWidth - width - BROWSER_FLOATING_CONTACT_EDGE);
  const maxTop = Math.max(BROWSER_FLOATING_CONTACT_EDGE, window.innerHeight - height - BROWSER_FLOATING_CONTACT_EDGE);
  return {
    left: Math.min(Math.max(BROWSER_FLOATING_CONTACT_EDGE, Number.isFinite(left) ? left : BROWSER_FLOATING_CONTACT_EDGE), maxLeft),
    top: Math.min(Math.max(BROWSER_FLOATING_CONTACT_EDGE, Number.isFinite(top) ? top : BROWSER_FLOATING_CONTACT_EDGE), maxTop)
  };
}

function placeBrowserFloatingContact(left, top, persist = false) {
  const position = clampBrowserFloatingContactPosition(left, top);
  browserFloatingContact.style.left = `${Math.round(position.left)}px`;
  browserFloatingContact.style.top = `${Math.round(position.top)}px`;
  browserFloatingContact.style.right = "auto";
  browserFloatingContact.style.transform = "none";
  if (persist) {
    try { localStorage.setItem(BROWSER_FLOATING_CONTACT_POSITION_KEY, JSON.stringify(position)); }
    catch {}
  }
  return position;
}

function placeBrowserFloatingContactPanel() {
  if (browserFloatingContactPanel.hidden) return;
  const edge = 12;
  const gap = 12;
  const triggerRect = browserFloatingContactTrigger.getBoundingClientRect();
  const panelRect = browserFloatingContactPanel.getBoundingClientRect();
  const maxPanelLeft = Math.max(edge, window.innerWidth - panelRect.width - edge);
  const maxPanelTop = Math.max(edge, window.innerHeight - panelRect.height - edge);
  const fitsRight = triggerRect.right + gap + panelRect.width <= window.innerWidth - edge;
  const fitsLeft = triggerRect.left - gap - panelRect.width >= edge;
  let left;
  if (fitsRight) left = triggerRect.right + gap;
  else if (fitsLeft) left = triggerRect.left - gap - panelRect.width;
  else if (triggerRect.left < window.innerWidth / 2) left = triggerRect.right + gap;
  else left = triggerRect.left - gap - panelRect.width;
  left = Math.min(Math.max(edge, left), maxPanelLeft);
  const top = Math.min(
    Math.max(edge, triggerRect.top + (triggerRect.height - panelRect.height) / 2),
    maxPanelTop
  );
  browserFloatingContactPanel.style.left = `${Math.round(left)}px`;
  browserFloatingContactPanel.style.top = `${Math.round(top)}px`;
  browserFloatingContactPanel.style.right = "auto";
  browserFloatingContactPanel.style.transform = "none";
}

function restoreBrowserFloatingContactPosition() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(BROWSER_FLOATING_CONTACT_POSITION_KEY) || "null"); }
  catch {}
  if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
    placeBrowserFloatingContact(saved.left, saved.top);
    return;
  }
  const rect = browserFloatingContact.getBoundingClientRect();
  placeBrowserFloatingContact(rect.left, rect.top);
}

function setBrowserFloatingContactOpen(open) {
  browserFloatingContactPanel.hidden = !open;
  browserFloatingContactTrigger.setAttribute("aria-expanded", String(open));
  if (open) placeBrowserFloatingContactPanel();
}
browserFloatingContactTrigger.addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  const rect = browserFloatingContact.getBoundingClientRect();
  placeBrowserFloatingContact(rect.left, rect.top);
  browserFloatingContactDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    moved: false
  };
  browserFloatingContact.classList.add("dragging");
  browserFloatingContactTrigger.setPointerCapture?.(event.pointerId);
});
browserFloatingContactTrigger.addEventListener("pointermove", event => {
  const drag = browserFloatingContactDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const deltaX = event.clientX - drag.startX;
  const deltaY = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
  if (!drag.moved) setBrowserFloatingContactOpen(false);
  drag.moved = true;
  placeBrowserFloatingContact(drag.startLeft + deltaX, drag.startTop + deltaY);
  event.preventDefault();
});
function finishBrowserFloatingContactDrag(event) {
  const drag = browserFloatingContactDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  browserFloatingContactDrag = null;
  browserFloatingContact.classList.remove("dragging");
  if (browserFloatingContactTrigger.hasPointerCapture?.(event.pointerId)) {
    browserFloatingContactTrigger.releasePointerCapture(event.pointerId);
  }
  if (!drag.moved) return;
  const rect = browserFloatingContact.getBoundingClientRect();
  placeBrowserFloatingContact(rect.left, rect.top, true);
  suppressBrowserFloatingContactClick = true;
  setTimeout(() => { suppressBrowserFloatingContactClick = false; }, 0);
}
browserFloatingContactTrigger.addEventListener("pointerup", finishBrowserFloatingContactDrag);
browserFloatingContactTrigger.addEventListener("pointercancel", finishBrowserFloatingContactDrag);
browserFloatingContactTrigger.addEventListener("click", event => {
  event.stopPropagation();
  if (suppressBrowserFloatingContactClick) {
    event.preventDefault();
    return;
  }
  setBrowserFloatingContactOpen(browserFloatingContactPanel.hidden);
});
document.getElementById("browser-floating-contact-close").addEventListener("click", () => setBrowserFloatingContactOpen(false));
browserFloatingContactPanel.addEventListener("click", event => event.stopPropagation());
document.querySelectorAll("[data-browser-contact-copy]").forEach(button => button.addEventListener("click", async () => {
  const value = String(button.dataset.browserContactCopy || "").trim();
  if (!value) return;
  try { await navigator.clipboard.writeText(value); }
  catch { const input = document.createElement("textarea"); input.value = value; input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove(); }
  const original = button.textContent;
  button.textContent = "已复制";
  button.classList.add("copied");
  setTimeout(() => { button.textContent = original; button.classList.remove("copied"); }, 1200);
}));
document.addEventListener("click", event => {
  if (!browserFloatingContactPanel.hidden && !browserFloatingContact.contains(event.target)) setBrowserFloatingContactOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") setBrowserFloatingContactOpen(false);
});
window.addEventListener("resize", () => {
  const rect = browserFloatingContact.getBoundingClientRect();
  placeBrowserFloatingContact(rect.left, rect.top);
  placeBrowserFloatingContactPanel();
});
restoreBrowserFloatingContactPosition();
