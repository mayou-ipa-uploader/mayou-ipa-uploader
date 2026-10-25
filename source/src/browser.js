// ========== State ==========
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let envConfig = {};
let ipInfo = null;
let baseIP = null;          // baseline IP for guard
let runtimeBaseIPInitialized = false;
let ipGuardTimer = null;    // periodic check timer
let ipChanged = false;      // guard triggered
const recentOpenedTabs = new Map();
const recentHistoryRecords = new Map();
const IP_GUARD_INTERVAL_MS = 10000;
const IP_GUARD_RECOVERY_INTERVAL_MS = 5000;
const historyTimers = new Map();
let bookmarkData = { groups: [], bookmarks: [] };
let zoomFactor = 1;
let downloadEntries = [];
let urlSuggestions = [];
let urlSuggestionIndex = -1;
let startupURLsOpened = false;
let topSitesExpanded = false;
let networkRequests = new Map();
let networkRecordingWebContentsId = 0;
let selectedNetworkRequestId = "";

// ========== IP Home Page HTML template ==========
function buildHomeHTML(cfg, ip) {
  const c = cfg || {};
  const p = ip || {};
  const hasIP = p.ip && p.ip !== "—";
  const src = p.source || "检测中…";
  const ca = (p.checkedAt || "").substring(0, 19) || "—";
  const co = p.country || "—", re = p.region || "—", ci = p.city || "—";
  const px = c.proxy || {};
  const account = c.desktopAccount && c.desktopAccount.username ? c.desktopAccount : null;
  const accountText = account
    ? esc(account.username) + "&nbsp;&nbsp;/&nbsp;&nbsp;" + (account.loginType === "employee" ? "员工" : "老板")
    : '<span class="login-placeholder">— 未登录 —</span>';
  const pl = px.enabled ? ((px.type||"HTTP").toUpperCase()+" "+(px.host||"")+":"+(px.port||"")) : "直连";
  return '<div class="home-wrap" id="home-page-' + (c.envId||"") + '">' +
    '<div class="topline"></div>' +
    '<div class="ad">' +
      '<span class="home-icon" style="font-size:20px;margin-right:8px;vertical-align:middle" title="IP 检测首页">⌂</span>' +
      '实时出口 IP 检测 · ' + esc(src) + ' · ' + esc(ca) +
    '</div>' +
    '<div class="blue">' +
    '<div class="ip-text"><span>' + esc(hasIP ? p.ip : "—") + '</span><span class="copy" title="复制IP" onclick="copyIP(\'' + esc(hasIP ? p.ip : "—") + '\')"></span></div>' +
    '<div class="btns"><span class="mini" onclick="refreshIP()">刷新网络信息</span><span class="mini">' + esc(p.statusText || "检测中…") + '</span></div>' +
    '<div class="pill">（仅供参考）' + esc(co) + ' / ' + esc(re) + ' / ' + esc(ci) + '</div>' +
    '<div><div class="meta"><span>时区: ' + esc(p.timezone||"—") + '</span><span>经度/纬度: ' + esc(p.lon||"—") + '/' + esc(p.lat||"—") + '</span><span>语言: zh-CN</span></div></div>' +
    '<div class="checks"><span>指纹检测: <a>ToDetect</a> <a>BrowserLeaks</a></span></div></div>' +
    '<div class="table">' +
    '<div class="row"><div class="lbl">序号</div><div class="val">' + esc(c.serialNum||"—") + ' <span class="muted">（启动时间: ' + esc(c.startedAt||"—") + '）</span></div></div>' +
    '<div class="row"><div class="lbl">账号状态:</div><div class="val">' + accountText + '</div></div>' +
    '<div class="row"><div class="lbl">代理:</div><div class="val">' + esc(pl) + '</div></div>' +
    '<div class="row"><div class="lbl">名称:</div><div class="val">' + esc(c.name||"—") + '</div></div>' +
    '<div class="row"><div class="lbl">2FA验证码:</div><div class="val">未设置2FA秘钥</div></div>' +
    '<div class="row"><div class="lbl">备注:</div><div class="val muted">' + esc(c.note||"无备注") + '</div></div>' +
    '<div class="row"><div class="lbl">内核版本:</div><div class="val">Chromium Electron</div></div>' +
    '<div class="row"><div class="lbl">运营商:</div><div class="val">' + esc(p.isp||"—") + '</div></div>' +
    '<div class="row"><div class="lbl">检测来源:</div><div class="val">' + esc(src) + '</div></div></div>' +
    '<div class="footer">工作台已就绪。点击顶部 ⌂ 图标返回首页 · 点击 + 新建标签页</div></div>';
}

function renderHomeTab(tab) {
  const container = document.getElementById("content-" + tab.id);
  if (!container) return;
  container.innerHTML = buildHomeHTML(envConfig, ipInfo);
  // Set up global handlers for this tab
  window.copyIP = function(text) {
    if (text && text !== "—" && text !== "…") { navigator.clipboard.writeText(text); showToast("IP 已复制: "+text); }
  };
}

function renderActiveHome() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && tab._isHome) renderHomeTab(tab);
}

function customShortcutKey() {
  return "ipauploader.topSites.shortcuts." + (envConfig.envId || "default");
}

function loadCustomShortcuts() {
  try {
    const value = localStorage.getItem(customShortcutKey());
    const items = JSON.parse(value || "[]");
    return Array.isArray(items) ? items.filter(item => item && item.url) : [];
  } catch (e) {
    return [];
  }
}

function saveCustomShortcuts(items) {
  const saved = (items || []).slice(0, 24);
  localStorage.setItem(customShortcutKey(), JSON.stringify(saved));
  window.browserBridge?.saveShortcuts?.(saved).catch(() => {});
}

function normalizeShortcutURL(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:\/\/|chrome-extension:\/\/)/i.test(raw)) return raw;
  return "https://" + raw;
}

function mergeTopSites(shortcuts, sites) {
  const seen = new Set();
  const result = [];
  [...(shortcuts || []), ...(sites || [])].forEach((site) => {
    const url = normalizeShortcutURL(site.url);
    if (!url) return;
    let key = url;
    try {
      key = new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {}
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ...site, url, title: site.title || compactURL(url), custom: !!site.custom });
  });
  return result;
}

function faviconCandidates(url, savedIcon) {
  const candidates = [];
  if (savedIcon) candidates.push(savedIcon);
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "baidu.com" || host.endsWith(".baidu.com")) {
      candidates.push("https://www.baidu.com/favicon.ico");
    }
    candidates.push(parsed.origin + "/favicon.ico");
    candidates.push("https://www.google.com/s2/favicons?domain=" + encodeURIComponent(parsed.hostname) + "&sz=64");
  } catch (e) {
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function topSiteIconHTML(site) {
  const title = site.title || site.url || "网站";
  const icons = faviconCandidates(site.url, site.icon);
  const initial = esc(siteInitial(title));
  if (!icons.length) return '<span class="top-site-fallback">' + initial + '</span>';
  return '<img src="' + esc(icons[0]) + '" data-icons=\'' + esc(JSON.stringify(icons)) + '\' data-icon-index="0" alt="" onerror="advanceTopSiteIcon(this)"><span class="top-site-fallback" style="display:none">' + initial + '</span>';
}

function advanceTopSiteIcon(img) {
  let icons = [];
  try { icons = JSON.parse(img.dataset.icons || "[]"); } catch (e) {}
  const nextIndex = Number(img.dataset.iconIndex || 0) + 1;
  if (icons[nextIndex]) {
    img.dataset.iconIndex = String(nextIndex);
    img.src = icons[nextIndex];
    return;
  }
  img.style.display = "none";
  if (img.nextElementSibling) img.nextElementSibling.style.display = "flex";
}

function renderTopSiteButton(site) {
  const title = site.title || site.url || "网站";
  return '<button class="top-site" title="' + esc(site.url) + '" onclick="navigateTo(\'' + jsString(site.url) + '\')">' +
    '<span class="top-site-icon">' + topSiteIconHTML(site) + '</span>' +
    '<span class="top-site-title">' + esc(title) + '</span></button>';
}

function addTopSiteShortcut() {
  const name = window.prompt("快捷方式名称");
  if (name === null) return;
  const urlInput = window.prompt("快捷方式网址");
  if (urlInput === null) return;
  const url = normalizeShortcutURL(urlInput);
  if (!url) {
    showToast("请输入网址");
    return;
  }
  const shortcuts = loadCustomShortcuts().filter(item => normalizeShortcutURL(item.url) !== url);
  shortcuts.unshift({ title: String(name || compactURL(url)).trim() || compactURL(url), url, custom: true });
  saveCustomShortcuts(shortcuts);
  renderActiveHome();
}

function toggleTopSitesExpanded() {
  topSitesExpanded = !topSitesExpanded;
  renderActiveHome();
}

function normalizeNewTabSearch(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("://")) return text;
  if (text.includes(".") && !/\s/.test(text)) return "https://" + text;
  return "https://www.baidu.com/s?wd=" + encodeURIComponent(text);
}

function submitNewTabSearch(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector(".newtab-search-input");
  const url = normalizeNewTabSearch(input && input.value);
  if (url) navigateTo(url);
}

async function renderNewTab(tab) {
  const container = document.getElementById("content-" + tab.id);
  if (!container) return;
  let sites = [];
  try {
    sites = window.browserBridge.getTopSites ? await window.browserBridge.getTopSites(topSitesExpanded ? 30 : 8) : [];
  } catch (e) {}
  let shortcuts = loadCustomShortcuts();
  try {
    const synced = await window.browserBridge?.getShortcuts?.();
    if (Array.isArray(synced) && synced.length) {
      shortcuts = synced;
      localStorage.setItem(customShortcutKey(), JSON.stringify(synced));
    } else if (shortcuts.length) {
      // One-time migration for shortcuts created before file-based cloud sync.
      window.browserBridge?.saveShortcuts?.(shortcuts).catch(() => {});
    }
  } catch (e) {}
  const merged = mergeTopSites(shortcuts, sites || []);
  const visible = merged.slice(0, topSitesExpanded ? 24 : 6);
  const items = visible.map(renderTopSiteButton).join("");
  const fallback = '<button class="top-site" onclick="navigateTo(\'https://www.google.com\')"><span class="top-site-icon">' + topSiteIconHTML({ url: "https://www.google.com", title: "Google" }) + '</span><span class="top-site-title">Google</span></button>';
  container.innerHTML = '<div class="newtab-page"><div class="newtab-center">' +
    '<div class="newtab-brand">码尚友</div>' +
    '<form class="newtab-search" onsubmit="submitNewTabSearch(event)">' +
      '<span class="newtab-search-plus">+</span>' +
      '<input class="newtab-search-input" type="text" autocomplete="off" placeholder="输入网址或搜索内容" />' +
      '<button class="newtab-search-submit" type="submit">搜索</button>' +
    '</form>' +
    '<div class="top-sites">' +
    (items || fallback) +
    '<button class="top-site add-shortcut" onclick="addTopSiteShortcut()"><span class="top-site-icon">+</span><span class="top-site-title">添加快捷方式</span></button>' +
    '<button class="top-site expand" onclick="toggleTopSitesExpanded()"><span class="top-site-icon">' + (topSitesExpanded ? "⌜" : "⌗") + '</span><span class="top-site-title">' + (topSitesExpanded ? "收起" : "展开") + '</span></button>' +
    '</div></div></div>';
}

// ========== Init ==========
window.addEventListener("load", () => {
  const cfg = window.browserBridge.getConfig();
  envConfig = cfg.config || {};
  ipInfo = cfg.ipInfo || null;
  addTab("about:ipinfo", "首页");
  updateBrowserBadge();
  updateIPButton();
  if (window.browserBridge.onOpenTab) {
    window.browserBridge.onOpenTab((url) => openURLInNewTab(url));
  }
  if (window.browserBridge.onBookmarksUpdated) {
    window.browserBridge.onBookmarksUpdated((data) => {
      bookmarkData = data || { groups: [], bookmarks: [] };
      renderBookmarkBar();
    });
  }
  if (window.browserBridge.onToast) {
    window.browserBridge.onToast((message) => showToast(message));
  }
  if (window.browserBridge.onDownloadsUpdated) {
    window.browserBridge.onDownloadsUpdated((entries) => {
      downloadEntries = Array.isArray(entries) ? entries : [];
      renderDownloadsPanel();
    });
  }
  refreshBookmarks();
  refreshDownloads();

  window.addEventListener("message", (e) => {
    if (!e.data) return;
    const d = e.data;
    if (d.type === "browser-config-updated") {
      resetIPGuardState();
      envConfig = d.config || {};
      ipInfo = d.ipInfo || null;
      updateBrowserBadge();
      updateIPButton();
      renderActiveHome();
      startIPGuard();
      openStartupPages();
    }
    if (d.type === "browser-update-ip") {
      ipInfo = d.data || null;
      updateIPButton();
      renderActiveHome();
    }
    if (d.type === "browser-nav-to") navigateTo(d.url);
    if (d.type === "browser-open-tab") openURLInNewTab(d.url);
    if (d.type === "browser-go-home") goHome();
    if (d.type === "browser-go-back") goBack();
    if (d.type === "browser-go-forward") goForward();
    if (d.type === "browser-request-current-bookmark") addCurrentBookmark();
    if (d.type === "__openTab") openURLInNewTab(d.url);
  });

  renderActiveHome();
  openStartupPages();
  startIPGuard();
});

function updateBrowserBadge() {
  const serial = document.getElementById("browser-serial");
  const badge = document.getElementById("browser-badge");
  const value = envConfig.serialNum || "—";
  if (serial) serial.textContent = value;
  if (badge) badge.title = "浏览器序列号: " + value;
}

function parseStartupURLs(value) {
  return String(value || "")
    .split(/\n|,/)
    .map(v => v.trim())
    .filter(Boolean);
}

function openStartupPages() {
  if (startupURLsOpened) return;
  const urls = parseStartupURLs(envConfig.homeUrl).filter(url => url && url !== "about:blank" && url !== "about:ipinfo");
  if (!urls.length) return;
  startupURLsOpened = true;
  urls.forEach(url => openURLInNewTab(url));
}

function updateIPButton() {
  const btn = document.getElementById("btn-ip");
  if (!btn) return;
  if (ipChanged) { btn.classList.add("changed"); btn.title = "IP已变化！"; return; }
  if (ipInfo && ipInfo.ip && ipInfo.ip !== "—") {
    const label = ipInfo.proxyText === "代理/VPN" ? "代理" : "直连";
    btn.textContent = label + ": " + ipInfo.ip;
    btn.style.color = ipInfo.proxyText === "代理/VPN" ? "#2e7d32" : "#1565c0";
  }
}

// ========== IP Guard ==========
const IP_BLOCK_SCRIPT = "(function(){if(window.__ipGuardInstalled)return;window.__ipGuardInstalled=true;window.__ipGuardBlocked=false;window.__ipGuardSetBlocked=function(m){window.__ipGuardBlocked=true;window.__ipGuardBlockedMessage=m||'出口 IP 已变化，请求已拦截。';};function assertAllowed(){if(window.__ipGuardBlocked)throw new Error(window.__ipGuardBlockedMessage||'出口 IP 已变化，请求已拦截。');}var rf=window.fetch;if(rf)window.fetch=function(i,o){try{assertAllowed();}catch(e){return Promise.reject(e);}return rf.call(this,i,o);};var RX=window.XMLHttpRequest;window.XMLHttpRequest=function(){try{assertAllowed();}catch(e){throw e;}return new RX();};window.XMLHttpRequest.prototype=RX.prototype;if(window.WebSocket){var RW=window.WebSocket;var GW=function(u,p){try{assertAllowed();}catch(e){throw e;}return p===undefined?new RW(u):new RW(u,p);};GW.prototype=RW.prototype;Object.setPrototypeOf(GW,RW);window.WebSocket=GW;}var ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif';ov.innerHTML='<div style=background:#fff;border-radius:12px;padding:32px 48px;text-align:center;max-width:460px;box-shadow:0 8px 30px rgba(0,0,0,.3)><div style=font-size:48px;margin-bottom:12px>⚠️</div><div style=font-size:18px;font-weight:700;color:#e74c3c;margin-bottom:8px>出口 IP 已变化</div><div style=font-size:14px;color:#4a5568;margin-bottom:4px>当前页面的网络请求已被拦截。</div><div style=font-size:12px;color:#86868b>请返回工作台重新检测 IP，确认安全后再继续操作。</div></div>';(document.body||document.documentElement).appendChild(ov);})();";

let cachedGuardIP = null;    // latest IP from fast polling
let lastGuardCheck = 0;

function validIP(info) {
  return !!(info && info.ip && info.ip !== "—");
}

function ipGuardConfig() {
  return envConfig && envConfig.ipGuard && typeof envConfig.ipGuard === "object" ? envConfig.ipGuard : {};
}

function isIPGuardEnabled() {
  return !!ipGuardConfig().enabled;
}

function configuredExpectedIP() {
  return String(ipGuardConfig().expectedIP || "").trim();
}

function resetIPGuardState() {
  if (ipGuardTimer) clearInterval(ipGuardTimer);
  ipGuardTimer = null;
  baseIP = null;
  cachedGuardIP = null;
  runtimeBaseIPInitialized = false;
  ipChanged = false;
  document.getElementById("ip-guard-modal")?.style && (document.getElementById("ip-guard-modal").style.display = "none");
  document.getElementById("ip-guard-banner")?.classList.remove("show");
}

function initializeRuntimeBaseIP(info, reason) {
  if (runtimeBaseIPInitialized) return false;
  const expectedIP = configuredExpectedIP();
  const candidateIP = expectedIP || (validIP(info) ? info.ip : "");
  if (!candidateIP) return false;
  baseIP = candidateIP;
  if (!expectedIP) cachedGuardIP = candidateIP;
  runtimeBaseIPInitialized = true;
  console.log("[ip-guard] runtime base IP initialized", {
    envId: envConfig.envId,
    serialNum: envConfig.serialNum,
    guardSessionId: envConfig.guardSessionId,
    baseIP,
    reason: expectedIP ? "configured-expected-ip" : reason
  });
  return true;
}

function startIPGuard() {
  if (ipGuardTimer) clearInterval(ipGuardTimer);
  ipGuardTimer = null;
  if (!isIPGuardEnabled()) return;
  initializeRuntimeBaseIP(null, "configured-expected-ip");
  ipGuardTimer = setInterval(pollGuardIP, IP_GUARD_INTERVAL_MS);
  pollGuardIP();
}

async function pollGuardIP() {
  try {
    const result = await window.browserBridge.refreshIP();
    if (!result || !result.ip || result.ip === "—") return;
    ipInfo = result;
    updateIPButton();
    renderActiveHome();
    if (result.ipMismatch) {
      if (!baseIP) initializeRuntimeBaseIP(result, "first-browser-poll");
      cachedGuardIP = result.ip;
      lastGuardCheck = Date.now();
      onIPChanged(baseIP || configuredExpectedIP() || "未建立基准IP", result.mismatchIPs || result.ip, "多个检测源返回不同出口 IP");
      return;
    }
    if (initializeRuntimeBaseIP(result, "first-browser-poll")) return;
    if (!baseIP) return;
    cachedGuardIP = result.ip;
    lastGuardCheck = Date.now();

    if (ipChanged) {
      // IP was changed — check if it has recovered back to baseline
      if (baseIP && result.ip === baseIP) {
        onIPRecovered(baseIP);
      }
      return;
    }

    if (baseIP && result.ip !== baseIP) onIPChanged(baseIP, result.ip);
  } catch(e) {}
}

// Pre-navigation: compare cached IP (0ms, no network wait)
function guardBeforeNavigate(e) {
  if (!isIPGuardEnabled()) return;
  if (ipChanged) { e.preventDefault(); return; }
  if (cachedGuardIP && baseIP && cachedGuardIP !== baseIP) {
    e.preventDefault();
    onIPChanged(baseIP, cachedGuardIP);
    return;
  }
  // cache stale, allow nav but trigger re-poll
  pollGuardIP();
}

function onIPChanged(oldIP, newIP, reason = "出口 IP 已变化") {
  if (!isIPGuardEnabled()) return;
  ipChanged = true;
  // Slow polling to 2s while waiting for IP recovery
  if (ipGuardTimer) { clearInterval(ipGuardTimer); }
  ipGuardTimer = setInterval(pollGuardIP, IP_GUARD_RECOVERY_INTERVAL_MS);

  // 1) Immediately stop + clear all webview tabs — kill existing connections
  killAllWebviews();

  // 2) Show full-screen modal
  const modal = document.getElementById("ip-guard-modal");
  const msg = document.getElementById("ip-guard-msg");
  if (modal) {
    msg.textContent = "检测到" + reason + ": " + oldIP + " → " + newIP + "，浏览器已停止所有网络请求。";
    modal.style.display = "flex";
  }

  // 3) Red banner + blinking IP button
  const banner = document.getElementById("ip-guard-banner");
  if (banner) { banner.querySelector("span").textContent = "⚠ " + reason + ": " + oldIP + " → " + newIP; banner.classList.add("show"); }
  updateIPButton();
  renderActiveHome();
  setStatus("⚠ " + reason + "，浏览器已锁定");
}

// ===== IP auto-recovered — hide all warnings and resume =====
function onIPRecovered(ip) {
  ipChanged = false;

  // Hide modal
  const modal = document.getElementById("ip-guard-modal");
  if (modal) modal.style.display = "none";

  // Hide banner
  const banner = document.getElementById("ip-guard-banner");
  if (banner) banner.classList.remove("show");

  // Restore IP button
  updateIPButton();
  renderActiveHome();
  setStatus("✅ IP 已恢复 (" + ip + ")，守卫正常");

  // Resume fast polling
  startIPGuard();
}

// ===== Close browser via IPC =====
window.__closeBrowser = function() {
  window.browserBridge.closeBrowser();
};

function killAllWebviews() {
  tabs.forEach(t => {
    if (t.webview) {
      // Inject block script to kill in-flight requests
      t.webview.executeJavaScript(IP_BLOCK_SCRIPT).catch(()=>{});
      // Replace page content with blank overlay so no more network activity
      t.webview.stop();
      t.webview.loadURL("about:blank");
    }
  });
}

window.dismissGuard = function() {
  ipChanged = false;
  document.getElementById("ip-guard-banner")?.classList.remove("show");
  updateIPButton();
  setStatus("IP 守卫已解除（手动忽略）");
  const expectedIP = configuredExpectedIP();
  if (expectedIP) {
    baseIP = expectedIP;
    cachedGuardIP = expectedIP;
    runtimeBaseIPInitialized = true;
  } else if (validIP(ipInfo)) {
    baseIP = ipInfo.ip;
    cachedGuardIP = ipInfo.ip;
    runtimeBaseIPInitialized = true;
  }
  startIPGuard();
};

window.refreshGuardIP = async function() {
  try {
    const result = await window.browserBridge.refreshIP();
    ipInfo = result;
    const expectedIP = configuredExpectedIP();
    if (expectedIP) {
      baseIP = expectedIP;
      cachedGuardIP = validIP(result) ? result.ip : expectedIP;
      runtimeBaseIPInitialized = true;
    } else if (validIP(result)) {
      baseIP = result.ip;
      cachedGuardIP = result.ip;
      runtimeBaseIPInitialized = true;
    }
    ipChanged = false;
    document.getElementById("ip-guard-banner")?.classList.remove("show");
    updateIPButton(); renderActiveHome(); setStatus("IP 已重新检测，守卫已恢复"); startIPGuard();
  } catch(e) {}
};

// ========== Loading Progress Bar ==========
let progressTimer = null;
function getTabById(id) {
  return tabs.find(t => t.id === id);
}
function updateProgressUI(tab) {
  const bar = document.getElementById("progress-bar");
  const fill = bar && bar.querySelector(".fill");
  const chip = document.getElementById("loading-chip");
  const text = document.getElementById("progress-text");
  if (!bar || !fill || !chip || !text) return;

  if (!tab || !tab.loading) {
    bar.classList.remove("loading");
    bar.classList.add("done");
    chip.classList.remove("show");
    return;
  }

  const pct = Math.max(1, Math.min(99, Math.round(tab.progress || 1)));
  fill.style.width = pct + "%";
  text.textContent = pct + "%";
  bar.classList.remove("done");
  bar.classList.add("loading");
  chip.classList.add("show");
}
function runProgressTimer() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const active = getTabById(activeTabId);
    if (!active || !active.loading) {
      clearInterval(progressTimer);
      progressTimer = null;
      updateProgressUI(active);
      return;
    }
    const current = active.progress || 6;
    const limit = current < 70 ? 70 : 94;
    const step = current < 70 ? 4 + Math.random() * 7 : 0.6 + Math.random() * 2.2;
    active.progress = Math.min(limit, current + step);
    updateProgressUI(active);
  }, 450);
}
function startProgress(tabId) {
  const tab = getTabById(tabId);
  if (!tab) return;
  tab.loading = true;
  tab.progress = Math.max(tab.progress || 0, 6);
  tab.progressStartedAt = Date.now();
  if (tabId !== activeTabId) return;
  updateProgressUI(tab);
  runProgressTimer();
}
function bumpProgress(tabId, pct) {
  const tab = getTabById(tabId);
  if (!tab || !tab.loading) return;
  tab.progress = Math.max(tab.progress || 1, pct);
  if (tabId === activeTabId) updateProgressUI(tab);
}
function completeProgress(tabId) {
  const tab = getTabById(tabId);
  const bar = document.getElementById("progress-bar");
  const fill = bar && bar.querySelector(".fill");
  const chip = document.getElementById("loading-chip");
  const text = document.getElementById("progress-text");
  if (!tab || !bar || !fill || !chip || !text) return;

  tab.loading = false;
  tab.progress = 100;
  if (tabId !== activeTabId) return;

  clearTimeout(progressTimer);
  progressTimer = null;
  fill.style.width = "100%";
  text.textContent = "100%";
  chip.classList.add("show");
  bar.classList.add("loading");
  progressTimer = setTimeout(() => {
    bar.classList.remove("loading");
    bar.classList.add("done");
    chip.classList.remove("show");
    progressTimer = setTimeout(() => {
      fill.style.width = "0";
      bar.classList.remove("done");
    }, 350);
  }, 280);
}

// ========== Tab Management ==========
function tabInitial(tab) {
  const source = tab && (tab.title || tab.url) || "";
  try {
    if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
      return new URL(tab.url).hostname.replace(/^www\./, "").charAt(0).toUpperCase() || "•";
    }
  } catch (e) {}
  return String(source).trim().charAt(0).toUpperCase() || "•";
}

function tabIconHTML(tab) {
  if (tab && tab.icon) {
    return '<img class="tab-favicon" src="' + esc(tab.icon) + '" alt="" onerror="replaceTabIconWithFallback(this)">';
  }
  return '<span class="tab-favicon fallback">' + esc(tabInitial(tab)) + '</span>';
}

function replaceTabIconWithFallback(img) {
  const header = img && img.closest ? img.closest(".tab") : null;
  const id = header && header.id ? header.id.replace("tab-header-", "") : "";
  const tab = tabs.find(item => item.id === id);
  const fallback = document.createElement("span");
  fallback.className = "tab-favicon fallback";
  fallback.textContent = tabInitial(tab);
  img.replaceWith(fallback);
}

function updateTabIcon(tab) {
  if (!tab || tab._isHome) return;
  const header = document.getElementById("tab-header-" + tab.id);
  if (!header) return;
  const oldIcon = header.querySelector(".tab-favicon");
  if (!oldIcon) return;
  const wrapper = document.createElement("span");
  wrapper.innerHTML = tabIconHTML(tab);
  oldIcon.replaceWith(wrapper.firstElementChild);
}

function updateTabSizing() {
  const tabbar = document.getElementById("tabbar");
  if (!tabbar) return;
  const normalNodes = Array.from(tabbar.querySelectorAll(".tab:not(.home-tab)"));
  const activeNode = normalNodes.find(node => node.classList.contains("active")) || null;
  const addTab = document.getElementById("add-tab");
  const homeNodes = Array.from(tabbar.querySelectorAll(".home-tab"));
  const style = getComputedStyle(tabbar);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const reservedWidth = padding
    + (addTab ? addTab.getBoundingClientRect().width : 0)
    + homeNodes.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
    + Math.max(0, tabbar.children.length - 1) * gap;
  const availableWidth = Math.max(0, tabbar.clientWidth - reservedWidth);
  const selectedWidth = 148;
  const maxTabWidth = 148;
  const minTabWidth = 38;
  let otherWidth = maxTabWidth;

  if (normalNodes.length > 1 && activeNode) {
    otherWidth = (availableWidth - selectedWidth) / (normalNodes.length - 1);
  } else if (normalNodes.length === 1) {
    otherWidth = selectedWidth;
  }
  otherWidth = Math.max(minTabWidth, Math.min(maxTabWidth, Math.floor(otherWidth)));

  normalNodes.forEach(node => {
    const width = node === activeNode ? selectedWidth : otherWidth;
    node.style.width = `${width}px`;
    node.style.minWidth = `${width}px`;
    node.style.maxWidth = `${width}px`;
    node.classList.toggle("icon-only", node !== activeNode && width <= 52);
  });
}

function keepActiveTabVisible() {
  const tabbar = document.getElementById("tabbar");
  const active = document.getElementById("tab-header-" + activeTabId);
  if (!tabbar || !active) return;
  if (active && active.classList.contains("home-tab")) return;
  const style = getComputedStyle(tabbar);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const home = tabbar.querySelector(".home-tab");
  const addTab = document.getElementById("add-tab");
  const fixedLeft = paddingLeft + (home ? home.getBoundingClientRect().width : 0) + gap;
  const fixedRight = paddingRight + (addTab ? addTab.getBoundingClientRect().width : 0) + gap;
  const leftEdge = tabbar.scrollLeft + fixedLeft;
  const rightEdge = tabbar.scrollLeft + tabbar.clientWidth - fixedRight;
  const activeLeft = active.offsetLeft;
  const activeRight = active.offsetLeft + active.offsetWidth;

  if (activeLeft < leftEdge) {
    tabbar.scrollLeft = Math.max(0, activeLeft - fixedLeft);
  } else if (activeRight > rightEdge) {
    tabbar.scrollLeft = activeRight - tabbar.clientWidth + fixedRight;
  }
}

function addTab(url, title) {
  const id = "tab-" + (++tabCounter);
  const tab = { id, url: url, title: title || "新标签页", webview: null, webviewReady: false, _isHome: (url === "about:ipinfo"), _isNewTab: (url === "about:blank") };
  tabs.push(tab);

  const tabbar = document.getElementById("tabbar");
  const tabEl = document.createElement("div");
  tabEl.className = tab._isHome ? "tab home-tab" : "tab";
  tabEl.id = "tab-header-" + id;
  if (tab._isHome) {
    tabEl.textContent = "⌂";
    tabEl.title = "IP 检测首页";
  } else {
    tabEl.innerHTML = tabIconHTML(tab) + '<span class="title">' + esc(title || url) + '</span><span class="close" onclick="closeTab(event,\'' + id + '\')">×</span>';
  }
  tabEl.onclick = (e) => { if (!e.target.classList.contains("close")) switchTab(id); };
  const addBtnEl = document.getElementById("add-tab");
  if (addBtnEl) tabbar.insertBefore(tabEl, addBtnEl);
  else tabbar.appendChild(tabEl);

  const content = document.getElementById("content");
  const container = document.createElement("div");
  container.className = "tab-content";
  container.id = "content-" + id;

  if (url === "about:ipinfo" || url === "about:blank") {
    // Home: plain DOM, no webview
    container.style.cssText = url === "about:blank"
      ? "overflow-y:auto;background:#fff;justify-content:flex-start;"
      : "overflow-y:auto;background:#fff;justify-content:flex-start;";
  } else {
    const webview = document.createElement("webview");
    // 使用与 BrowserWindow 相同的 partition，确保代理设置生效（必须在 src 之前设置）
    if (envConfig.envId) {
      webview.setAttribute("partition", "persist:env_" + envConfig.envId);
    }
    webview.setAttribute("preload", new URL("./webview-preload.js", window.location.href).href);
    if (envConfig.fingerprint && envConfig.fingerprint.userAgent) {
      webview.setAttribute("useragent", envConfig.fingerprint.userAgent);
    }
    webview.setAttribute("allowpopups", "");  // needed for new-window event
    // 保持 Chromium 默认同源与 Cookie 安全策略；关闭 disablewebsecurity
    // 会让 webview 与正常 Chrome 的跨站鉴权行为产生差异。
    webview.src = url;
    webview.addEventListener("focus", () => {
      closeMoreMenu();
      closeDownloadsPanel();
      hideURLSuggestions();
    });
    webview.addEventListener("dom-ready", () => {
      tab.webviewReady = true;
      updateNavButtons(id);
      webview.executeJavaScript("try{document.documentElement.style.background='#fff';document.body&&(document.body.style.background='#fff');}catch(e){}").catch(()=>{});
      webview.executeJavaScript("document.addEventListener('mousedown',function(){window.dispatchEvent(new Event('__ipauploader-webview-click'));},true);").catch(()=>{});
    });
    webview.addEventListener("ipc-message", (e) => {
      if (e.channel === "open-tab") openURLInNewTab(e.args && e.args[0]);
      if (e.channel === "webview-click") {
        closeMoreMenu();
        closeDownloadsPanel();
        hideURLSuggestions();
      }
    });
    // 小红书登录依赖原生 opener/SSO 回调；其他弹窗仍转成浏览器标签页。
    webview.addEventListener("new-window", (e) => {
      try {
        const host = new URL(e.url).hostname.toLowerCase();
        if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) return;
      } catch (error) {}
      e.preventDefault();
      openURLInNewTab(e.url);
    });
    webview.addEventListener("did-create-window", (e) => {
      try {
        const host = new URL(e.url).hostname.toLowerCase();
        if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) return;
      } catch (error) {}
      if (e.window && !e.window.closed) e.window.close();
      openURLInNewTab(e.url);
    });
    webview.addEventListener("will-navigate", guardBeforeNavigate);
    webview.addEventListener("will-redirect", guardBeforeNavigate);

    webview.addEventListener("did-start-loading", () => { updateNavButtons(id); if (id === activeTabId) setStatus("正在加载…"); startProgress(id); });
    webview.addEventListener("dom-ready", () => { bumpProgress(id, 82); });
    webview.addEventListener("did-stop-loading", () => { updateNavButtons(id); completeProgress(id); scheduleHistoryRecord(id, webview, 400); });
    webview.addEventListener("did-fail-load", () => { updateNavButtons(id); completeProgress(id); if (id === activeTabId) setStatus("加载失败"); });
    webview.addEventListener("page-title-updated", (e) => {
      tab.title = e.title;
      const h = document.getElementById("tab-header-" + id);
      if (h) h.querySelector(".title").textContent = esc(e.title).substring(0, 30);
      scheduleHistoryRecord(id, webview, 700);
    });
    webview.addEventListener("page-favicon-updated", (e) => {
      updateBookmarkFavicon(tab, e.favicons);
      updateTabIcon(tab);
    });
    webview.addEventListener("did-navigate", (e) => { tab.url = e.url; if (id === activeTabId) updateUrlBar(e.url); updateNavButtons(id); scheduleHistoryRecord(id, webview, 500); });
    webview.addEventListener("did-navigate-in-page", (e) => { if (e.isMainFrame) { tab.url = e.url; if (id === activeTabId) updateUrlBar(e.url); scheduleHistoryRecord(id, webview, 500); } });
    webview.addEventListener("did-finish-load", () => {
      setStatus("加载完成"); updateNavButtons(id); if (id === activeTabId) updateUrlBar(tab.url); completeProgress(id);
      scheduleHistoryRecord(id, webview, 200);
    });
    container.appendChild(webview);
    tab.webview = webview;
  }

  content.appendChild(container);
  switchTab(id);

  if (tab._isHome) renderHomeTab(tab);
  if (tab._isNewTab) renderNewTab(tab);
}

function switchTab(id) {
  if (activeTabId) {
    const prevH = document.getElementById("tab-header-" + activeTabId);
    const prevC = document.getElementById("content-" + activeTabId);
    if (prevH) prevH.classList.remove("active");
    if (prevC) prevC.classList.remove("active");
  }
  activeTabId = id;
  const h = document.getElementById("tab-header-" + id);
  const c = document.getElementById("content-" + id);
  if (h) h.classList.add("active");
  if (c) c.classList.add("active");
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    updateUrlBar(tab.url);
    updateNavButtons(id);
    setStatus("当前标签: " + esc(tab.title));
    // 首页不可编辑 URL 栏
    const urlBar = document.getElementById("url-bar");
    if (urlBar) {
      if (tab._isHome) {
        urlBar.readOnly = true;
        urlBar.classList.add("readonly");
      } else {
        urlBar.readOnly = false;
        urlBar.classList.remove("readonly");
      }
    }
    if (tab._isHome) { renderHomeTab(tab); }
    updateUrlBar(tab.url);
    updateNavButtons(id);
    updateProgressUI(tab);
    if (tab.loading) runProgressTimer();
    else { clearInterval(progressTimer); progressTimer = null; }
    setStatus("当前标签: " + esc(tab.title));
  }
  updateTabSizing();
  keepActiveTabVisible();
}

function closeTab(e, id) {
  e.stopPropagation();
  if (tabs.length <= 1) return;
  clearTimeout(historyTimers.get(id));
  historyTimers.delete(id);
  const tab = tabs.find(t => t.id === id);
  if (tab && tab.webview && networkRecordingWebContentsId) {
    let closingWebContentsId = 0;
    try { closingWebContentsId = Number(tab.webview.getWebContentsId()); } catch (error) {}
    if (closingWebContentsId === networkRecordingWebContentsId) {
      window.browserBridge.stopNetworkCapture(networkRecordingWebContentsId).catch(() => {});
      networkRecordingWebContentsId = 0;
      const recordButton = document.getElementById("network-record");
      if (recordButton) { recordButton.classList.remove("recording"); recordButton.textContent = "● 开始抓包"; }
    }
  }
  if (tab && tab.webview) try { tab.webview.stop(); } catch(e) {}
  tabs = tabs.filter(t => t.id !== id);
  const h = document.getElementById("tab-header-" + id);
  const c = document.getElementById("content-" + id);
  if (h) h.remove(); if (c) c.remove();
  if (activeTabId === id) { const r = tabs[tabs.length - 1]; if (r) switchTab(r.id); }
  updateTabSizing();
}

function navigateTo(rawUrl) {
  hideURLSuggestions();
  const url = normalizeURL(rawUrl);
  if (!url) return;
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && (tab._isHome || tab._isNewTab) && url !== "about:ipinfo" && url !== "about:blank") {
    // Replace home DOM tab with webview tab
    const idx = tabs.indexOf(tab);
    document.getElementById("tab-header-" + activeTabId)?.remove();
    document.getElementById("content-" + activeTabId)?.remove();
    tabs.splice(idx, 1);
    addTab(url, url);
  } else if (tab && tab.webview) {
    tab.url = url; tab.webview.loadURL(url);
    document.getElementById("url-bar").value = url;
  }
}

function openURLInNewTab(rawUrl) {
  const url = normalizeURL(rawUrl);
  if (!url || url === "about:blank") return;
  const now = Date.now();
  const lastOpenedAt = recentOpenedTabs.get(url) || 0;
  if (now - lastOpenedAt < 800) return;
  recentOpenedTabs.set(url, now);
  for (const [openedUrl, openedAt] of recentOpenedTabs) {
    if (now - openedAt > 5000) recentOpenedTabs.delete(openedUrl);
  }
  addTab(url, url);
}

function webviewNavigationState(tab) {
  if (!tab || !tab.webview || !tab.webviewReady) return { canBack: false, canForward: false };
  try {
    return { canBack: !!tab.webview.canGoBack(), canForward: !!tab.webview.canGoForward() };
  } catch (error) {
    return { canBack: false, canForward: false };
  }
}
function goBack() {
  const tab = tabs.find(item => item.id === activeTabId);
  if (webviewNavigationState(tab).canBack) try { tab.webview.goBack(); } catch (error) {}
}
function goForward() {
  const tab = tabs.find(item => item.id === activeTabId);
  if (webviewNavigationState(tab).canForward) try { tab.webview.goForward(); } catch (error) {}
}
function reload() {
  const t = tabs.find(t => t.id === activeTabId);
  if (t && t.webview && t.webviewReady) try { t.webview.reload(); } catch (error) {}
  else if (t && t._isHome) { renderHomeTab(t); setStatus("首页已刷新"); }
}
function goHome() { const t = tabs.find(t => t.id === activeTabId); if (!t || !t._isHome) addTab("about:ipinfo", "首页"); }
function updateNavButtons(tabId) {
  const t = tabs.find(t => t.id === tabId);
  const { canBack, canForward } = webviewNavigationState(t);
  document.getElementById("btn-back").disabled = !canBack;
  document.getElementById("btn-forward").disabled = !canForward;
  const backIcon = document.getElementById("icon-back");
  const forwardIcon = document.getElementById("icon-forward");
  if (backIcon) backIcon.src = canBack ? "./assets/icons/back-enabled.png" : "./assets/icons/back-disabled.png";
  if (forwardIcon) forwardIcon.src = canForward ? "./assets/icons/forward-enabled.png" : "./assets/icons/forward-disabled.png";
}
function updateUrlBar(url) {
  const bar = document.getElementById("url-bar");
  const isHome = url === "about:ipinfo";
  const isNewTab = url === "about:blank";
  bar.value = isHome ? "首页 · IP 检测" : (isNewTab ? "" : (url || ""));
  if (isHome) {
    bar.readOnly = true;
    bar.classList.add("readonly");
  } else {
    bar.readOnly = false;
    bar.classList.remove("readonly");
  }
  updateURLClearState();
}

function showIPInfo() {
  if (ipInfo && ipInfo.ip && ipInfo.ip !== "—")
    alert("出口IP: " + ipInfo.ip + "\n类型: " + (ipInfo.proxyText||"未知") + "\n地区: " + (ipInfo.country||"—") + " " + (ipInfo.region||"—") + " " + (ipInfo.city||"—") + "\nISP: " + (ipInfo.isp||"—"));
  else alert("IP 检测中…请等待检测完成后查看");
}
async function refreshIP() {
  try { ipInfo = await window.browserBridge.refreshIP(); updateIPButton(); renderActiveHome(); } catch(e) {}
}
function showMore(event) {
  if (event) event.stopPropagation();
  closeDownloadsPanel();
  renderMoreMenu();
  const menu = document.getElementById("browser-more-menu");
  const btn = document.getElementById("btn-more");
  if (!menu || !btn) return;
  const willShow = !menu.classList.contains("show");
  menu.classList.toggle("show", willShow);
  btn.classList.toggle("active", willShow);
  if (willShow && window.browserBridge.showMoreMenu) window.browserBridge.showMoreMenu();
}

function closeMoreMenu() {
  document.getElementById("browser-more-menu")?.classList.remove("show");
  document.getElementById("btn-more")?.classList.remove("active");
}

function renderMoreMenu() {
  const menu = document.getElementById("browser-more-menu");
  if (!menu) return;
  const profileName = esc(envConfig.name || "浏览器");
  const account = envConfig.desktopAccount && envConfig.desktopAccount.username ? envConfig.desktopAccount : null;
  const accountName = account ? esc(account.username) : "— 未登录 —";
  const accountStatus = account ? (account.loginType === "employee" ? "员工" : "老板") : "";
  const accountAvatar = account ? esc(String(account.username).charAt(0).toUpperCase()) : "?";
  menu.innerHTML = `
    <div class="more-section">
      ${moreRow("▱", "打开新的标签页", "⌘T", "menuNewTab()")}
      ${moreRow("□", "打开新的窗口", "⌘N", "", true)}
      ${moreRow("⌁", "打开新的无痕窗口", "⇧⌘N", "", true)}
    </div>
    <div class="more-section">
      <div class="more-profile" onclick="showIPInfo();closeMoreMenu()" title="${profileName}"><span class="more-avatar">${accountAvatar}</span><span>${accountName}</span><span class="more-sub">${accountStatus}</span><span>›</span></div>
      ${moreRow("⚿", "密码和自动填充", "›", "", true)}
      ${moreRow("↺", "历史记录", "›", "menuShowHistory()")}
      ${moreRow("↓", "下载内容", "⌥⌘L", "menuOpenDownloads()")}
      ${moreRow("☆", "书签和清单", "›", "menuShowBookmarks()")}
      ${moreRow("▦", "标签页分组", "›", "", true)}
      ${moreRow("▣", "扩展程序", "›", "", true)}
      ${moreRow("⌫", "删除浏览数据…", "⇧⌘⌫", "menuClearData()")}
    </div>
    <div class="more-section">
      <div class="zoom-row"><span class="more-icon">⌕</span><span>缩放</span><button class="zoom-btn" onclick="changeZoom(-0.1)">−</button><span class="zoom-value">${Math.round(zoomFactor * 100)}%</span><button class="zoom-btn" onclick="changeZoom(0.1)">+</button><button class="zoom-btn" title="全屏" onclick="toggleFullscreen()">⛶</button></div>
    </div>
    <div class="more-section">
      ${moreRow("▣", "打印…", "⌘P", "menuPrint()")}
      ${moreRow("◉", "使用 Google 智能镜头搜索此标签页", "", "", true)}
      ${moreRow("文", "翻译…", "", "menuTranslatePage()")}
      ${moreRow("⌕", "查找和修改", "›", "openFindBox()")}
      ${moreRow("⇩", "投放、保存和分享", "›", "", true)}
      ${moreRow("◉", "网络抓包", "", "openNetworkPanel()")}
      ${moreRow("‹›", "开发者工具", "⌥⌘I", "menuOpenDevTools()")}
    </div>
    <div class="more-section">
      ${moreRow("?", "帮助", "›", "menuHelp()")}
      ${moreRow("⚙", "设置", "⌘,", "menuSettings()")}
    </div>`;
}

function moreRow(icon, label, shortcut, action, disabled) {
  const cls = disabled ? "more-row disabled" : "more-row";
  const click = disabled ? "" : ` onclick="${action};closeMoreMenu()"`;
  return `<div class="${cls}"${click}><span class="more-icon">${icon}</span><span>${label}</span><span class="more-shortcut">${shortcut || ""}</span></div>`;
}

function menuNewTab() { addTab("about:blank", "新标签页"); }
function menuShowHistory() { if (window.browserBridge.showHistory) window.browserBridge.showHistory(); }
function menuShowBookmarks() { if (window.browserBridge.showBookmarks) window.browserBridge.showBookmarks(); }
function menuOpenDownloads() { toggleDownloadsPanel(); }

async function refreshDownloads() {
  if (!window.browserBridge.getDownloads) return;
  try {
    const entries = await window.browserBridge.getDownloads();
    downloadEntries = Array.isArray(entries) ? entries : [];
    renderDownloadsPanel();
  } catch (e) {}
}

function toggleDownloadsPanel(event) {
  if (event) event.stopPropagation();
  closeMoreMenu();
  refreshDownloads();
  const panel = document.getElementById("download-panel");
  const btn = document.getElementById("btn-downloads");
  if (!panel || !btn) return;
  const willShow = !panel.classList.contains("show");
  panel.classList.toggle("show", willShow);
  btn.classList.toggle("active", willShow);
}

function closeDownloadsPanel() {
  document.getElementById("download-panel")?.classList.remove("show");
  document.getElementById("btn-downloads")?.classList.remove("active");
}

function renderDownloadsPanel() {
  const list = document.getElementById("download-list");
  const count = document.getElementById("download-count");
  updateDownloadButton();
  if (!list) return;
  if (count) count.textContent = String(downloadEntries.length);
  if (!downloadEntries.length) {
    list.innerHTML = '<div class="download-empty">暂无下载记录</div>';
    return;
  }
  list.innerHTML = downloadEntries.map(entry => {
    const pct = downloadPercent(entry);
    const state = downloadStateText(entry.state, pct);
    const size = formatBytes(entry.receivedBytes || entry.totalBytes || 0) + (entry.totalBytes ? " / " + formatBytes(entry.totalBytes) : "");
    const completed = entry.state === "completed";
    const folderButton = completed
      ? '<button class="download-folder" title="打开所在文件夹" onclick="openDownloadItem(\'' + jsString(entry.path) + '\',event)"><img src="./assets/icons/folder.png" alt="" /></button>'
      : '';
    return '<div class="download-item" onclick="openDownloadItem(\'' + jsString(entry.path) + '\')" title="' + esc(entry.path || "") + '">' +
      '<div class="download-file-icon">' + esc(fileExt(entry.fileName)) + '</div>' +
      '<div><div class="download-title">' + esc(entry.fileName || "未命名文件") + '</div><div class="download-meta">' + esc(size) + ' · ' + esc(formatDownloadTime(entry.updatedAt || entry.startedAt)) + '</div><div class="download-progress"><span style="width:' + pct + '%"></span></div></div>' +
      '<div class="download-actions"><span class="download-state">' + esc(state) + '</span>' + folderButton + '</div></div>';
  }).join("");
}

function updateDownloadButton() {
  const btn = document.getElementById("btn-downloads");
  if (!btn) return;
  const active = downloadEntries.filter(entry => entry.state === "progressing" || entry.state === "interrupted");
  const latest = downloadEntries[0];
  btn.classList.remove("downloading", "done");
  btn.style.removeProperty("--download-progress");
  if (active.length) {
    const known = active.filter(entry => entry.totalBytes > 0);
    const progress = known.length
      ? Math.round(known.reduce((sum, entry) => sum + downloadPercent(entry), 0) / known.length)
      : 12;
    btn.classList.add("downloading");
    btn.style.setProperty("--download-progress", progress + "%");
    btn.title = "下载中 " + progress + "%";
  } else if (latest && latest.state === "completed") {
    btn.classList.add("done");
    btn.title = "下载完成";
  } else {
    btn.title = "下载内容";
  }
}

function downloadPercent(entry) {
  if (!entry || !entry.totalBytes) return entry && entry.state === "completed" ? 100 : 0;
  if (entry.state === "completed") return 100;
  return Math.max(0, Math.min(100, Math.round((entry.receivedBytes || 0) / entry.totalBytes * 100)));
}

function fileExt(fileName) {
  const match = String(fileName || "").match(/\.([^.]{1,4})$/);
  return match ? match[1].toUpperCase() : "文件";
}

function downloadStateText(state, pct) {
  if (state === "completed") return "完成";
  if (state === "cancelled") return "已取消";
  if (state === "interrupted") return "中断";
  return pct ? pct + "%" : "下载中";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

function formatDownloadTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + " " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

function openDownloadItem(targetPath, event) {
  if (event) event.stopPropagation();
  if (!targetPath) return;
  if (window.browserBridge.openDownloadItem) window.browserBridge.openDownloadItem(targetPath);
}

function openDownloadsFolder() {
  if (window.browserBridge.openDownloads) window.browserBridge.openDownloads();
}

async function menuClearData() {
  if (!confirm("确定要删除当前浏览器环境的缓存、Cookie 和站点数据吗？")) return;
  try {
    const result = await window.browserBridge.clearBrowsingData();
    showToast(result && result.ok ? "浏览数据已删除" : "删除浏览数据失败");
  } catch (e) {
    showToast("删除浏览数据失败");
  }
}

function getActiveWebview() {
  const tab = tabs.find(t => t.id === activeTabId);
  return tab && tab.webview ? tab.webview : null;
}

function applyZoom() {
  const webview = getActiveWebview();
  if (webview && webview.setZoomFactor) webview.setZoomFactor(zoomFactor);
  renderMoreMenu();
}

function changeZoom(delta) {
  zoomFactor = Math.max(0.25, Math.min(5, Math.round((zoomFactor + delta) * 10) / 10));
  applyZoom();
}

function toggleFullscreen() {
  if (window.browserBridge.toggleFullscreen) window.browserBridge.toggleFullscreen();
}

function menuPrint() {
  const webview = getActiveWebview();
  if (webview && webview.print) webview.print();
  else window.print();
}

function menuTranslatePage() {
  const tab = tabs.find(t => t.id === activeTabId);
  const url = tab && tab.webview && tab.webview.getURL ? tab.webview.getURL() : tab && tab.url;
  if (!url || url === "about:ipinfo" || url === "about:blank") {
    showToast("当前页面不能翻译");
    return;
  }
  openURLInNewTab("https://translate.google.com/translate?sl=auto&tl=zh-CN&u=" + encodeURIComponent(url));
}

function menuOpenDevTools() {
  const webview = getActiveWebview();
  if (webview && webview.openDevTools) {
    webview.openDevTools();
    return;
  }
  showToast("当前标签页无法打开开发者工具");
}

// ========== Network Capture ==========
function openNetworkPanel() {
  document.getElementById("network-panel")?.classList.add("show");
  renderNetworkRows();
}

async function closeNetworkPanel() {
  document.getElementById("network-panel")?.classList.remove("show");
}

function activeWebContentsId() {
  const webview = getActiveWebview();
  try { return webview && webview.getWebContentsId ? Number(webview.getWebContentsId()) : 0; }
  catch (e) { return 0; }
}

async function toggleNetworkRecording() {
  const button = document.getElementById("network-record");
  if (networkRecordingWebContentsId) {
    await window.browserBridge.stopNetworkCapture(networkRecordingWebContentsId);
    networkRecordingWebContentsId = 0;
    if (button) { button.classList.remove("recording"); button.textContent = "● 开始抓包"; }
    return;
  }
  const id = activeWebContentsId();
  if (!id) { showToast("请先打开一个网页标签"); return; }
  const result = await window.browserBridge.startNetworkCapture(id);
  if (!result || !result.ok) { showToast(result?.message || "抓包启动失败"); return; }
  networkRecordingWebContentsId = id;
  if (button) { button.classList.add("recording"); button.textContent = "● 正在抓包"; }
  showToast("已开始抓取当前标签页请求");
}

function onNetworkEvent(event) {
  if (!event || Number(event.webContentsId) !== networkRecordingWebContentsId) return;
  const p = event.params || {};
  const id = String(p.requestId || "");
  if (!id) return;
  const current = networkRequests.get(id) || { id, startedAt: Date.now() };
  if (event.method === "Network.requestWillBeSent") {
    current.url = p.request?.url || current.url || "";
    current.method = p.request?.method || "GET";
    current.requestHeaders = p.request?.headers || {};
    current.postData = p.request?.hasPostData ? (p.request.postData || "[请求体未由 Chromium 返回]") : "";
    current.resourceType = p.type || "Other";
    current.wallTime = p.wallTime || 0;
    current.timestamp = p.timestamp || 0;
  } else if (event.method === "Network.responseReceived") {
    current.status = p.response?.status || 0;
    current.statusText = p.response?.statusText || "";
    current.responseHeaders = p.response?.headers || {};
    current.mimeType = p.response?.mimeType || "";
    current.protocol = p.response?.protocol || "";
    current.remoteIPAddress = p.response?.remoteIPAddress || "";
    current.responseTimestamp = p.timestamp || 0;
    current.resourceType = p.type || current.resourceType || "Other";
  } else if (event.method === "Network.loadingFinished") {
    current.finishedTimestamp = p.timestamp || 0;
    current.encodedDataLength = p.encodedDataLength || 0;
  } else if (event.method === "Network.loadingFailed") {
    current.failed = true;
    current.errorText = p.errorText || "加载失败";
    current.finishedTimestamp = p.timestamp || 0;
  }
  networkRequests.set(id, current);
  renderNetworkRows();
  if (selectedNetworkRequestId === id) renderNetworkDetail(id, false);
  if (event.method === "Network.loadingFinished") captureNetworkResponseBody(current);
}

async function captureNetworkResponseBody(row) {
  if (!row || row.body !== undefined || row.bodyLoading || !networkRecordingWebContentsId) return;
  const textLike = /json|text|javascript|xml|html|x-www-form-urlencoded/i.test(row.mimeType || "");
  if (!textLike || Number(row.encodedDataLength || 0) > 10 * 1024 * 1024) return;
  row.bodyLoading = true;
  const result = await window.browserBridge.getNetworkResponseBody(networkRecordingWebContentsId, row.id);
  row.bodyLoading = false;
  if (result?.ok) row.body = result.base64Encoded ? `[Base64 响应体]\n${result.body}` : result.body;
  else row.bodyError = result?.message || "响应正文不可用";
  if (selectedNetworkRequestId === row.id) renderNetworkDetail(row.id, false);
}

function networkDuration(row) {
  const end = row.finishedTimestamp || row.responseTimestamp;
  return end && row.timestamp ? Math.max(0, Math.round((end - row.timestamp) * 1000)) : 0;
}

function renderNetworkRows() {
  const list = document.getElementById("network-list");
  if (!list) return;
  const filter = String(document.getElementById("network-filter")?.value || "").toLowerCase();
  const rows = Array.from(networkRequests.values()).filter(row =>
    !filter || [row.url, row.method, row.status, row.resourceType, row.mimeType].join(" ").toLowerCase().includes(filter));
  list.innerHTML = rows.map(row => {
    let name = row.url || "";
    try { const parsed = new URL(name); name = parsed.pathname.split("/").pop() || parsed.hostname; } catch (e) {}
    return `<div class="network-grid network-row ${selectedNetworkRequestId === row.id ? "active" : ""}" onclick="selectNetworkRequest('${jsString(row.id)}')" title="${esc(row.url || "")}">` +
      `<span class="network-cell network-method">${esc(row.method || "")}</span><span class="network-cell">${esc(name)}</span>` +
      `<span class="network-cell network-status ${(row.failed || row.status >= 400) ? "bad" : ""}">${esc(row.failed ? "失败" : (row.status || "…"))}</span>` +
      `<span class="network-cell">${esc(row.resourceType || "")}</span><span class="network-cell">${networkDuration(row) || "…"} ms</span></div>`;
  }).join("");
  const count = document.getElementById("network-count");
  if (count) count.textContent = `${rows.length} / ${networkRequests.size} 个请求`;
}

function redactNetworkHeaders(headers) {
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key, sensitive.test(key) ? "[REDACTED]" : value]));
}

function redactNetworkBody(body) {
  const text = String(body || "");
  if (!text) return text;
  const sensitiveKey = /^(password|passwd|pwd|token|access_token|refresh_token|id_token|secret|client_secret|authorization|cookie|session|sessionid)$/i;
  try {
    const parsed = JSON.parse(text);
    const walk = value => {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : walk(item)]));
    };
    return JSON.stringify(walk(parsed), null, 2);
  } catch (e) {
    return text.replace(/(^|&)((?:password|passwd|pwd|token|access_token|refresh_token|secret|client_secret|authorization|cookie|sessionid)=)[^&]*/gi, "$1$2[REDACTED]");
  }
}

async function selectNetworkRequest(id) {
  selectedNetworkRequestId = id;
  renderNetworkRows();
  await renderNetworkDetail(id, true);
}

async function renderNetworkDetail(id, loadBody) {
  const row = networkRequests.get(String(id));
  const detail = document.getElementById("network-detail");
  if (!row || !detail) return;
  if (loadBody && row.body === undefined && row.finishedTimestamp && networkRecordingWebContentsId) {
    detail.textContent = "正在读取响应正文…";
    await captureNetworkResponseBody(row);
  }
  const data = {
    url: row.url, method: row.method, status: row.status || (row.failed ? "FAILED" : "PENDING"),
    type: row.resourceType, mimeType: row.mimeType, protocol: row.protocol,
    durationMs: networkDuration(row), remoteIPAddress: row.remoteIPAddress,
    requestHeaders: redactNetworkHeaders(row.requestHeaders), postData: redactNetworkBody(row.postData),
    responseHeaders: redactNetworkHeaders(row.responseHeaders),
    responseBody: row.body !== undefined ? redactNetworkBody(row.body) : (row.bodyError || "[点击请求后加载]"), error: row.errorText || ""
  };
  detail.textContent = JSON.stringify(data, null, 2);
}

function clearNetworkLog() {
  networkRequests.clear(); selectedNetworkRequestId = "";
  renderNetworkRows();
  const detail = document.getElementById("network-detail");
  if (detail) detail.textContent = "已清空。";
}

function exportNetworkHAR() {
  const entries = Array.from(networkRequests.values()).map(row => ({
    startedDateTime: row.wallTime ? new Date(row.wallTime * 1000).toISOString() : new Date(row.startedAt).toISOString(),
    time: networkDuration(row),
    request: { method: row.method || "GET", url: row.url || "", httpVersion: row.protocol || "", headers: Object.entries(redactNetworkHeaders(row.requestHeaders)).map(([name,value]) => ({name,value:String(value)})), queryString: [], cookies: [], headersSize: -1, bodySize: row.postData ? row.postData.length : 0, postData: row.postData ? { mimeType: "", text: redactNetworkBody(row.postData) } : undefined },
    response: { status: Number(row.status || 0), statusText: row.statusText || row.errorText || "", httpVersion: row.protocol || "", headers: Object.entries(redactNetworkHeaders(row.responseHeaders)).map(([name,value]) => ({name,value:String(value)})), cookies: [], content: { size: Number(row.encodedDataLength || 0), mimeType: row.mimeType || "", text: redactNetworkBody(row.body) }, redirectURL: "", headersSize: -1, bodySize: Number(row.encodedDataLength || 0) },
    cache: {}, timings: { send: 0, wait: networkDuration(row), receive: 0 }
  }));
  const har = { log: { version: "1.2", creator: { name: "IPAUploader Network Capture", version: "1.0" }, entries } };
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `network-${new Date().toISOString().replace(/[:.]/g, "-")}.har`; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

if (window.browserBridge?.onNetworkEvent) window.browserBridge.onNetworkEvent(onNetworkEvent);

function menuHelp() {
  alert("帮助\n\n可使用右上角更多菜单管理标签页、历史记录、书签、缩放、打印和翻译。");
}

function menuSettings() {
  showIPInfo();
}

function updateURLClearState() {
  const shell = document.getElementById("url-shell");
  const bar = document.getElementById("url-bar");
  if (!shell || !bar) return;
  shell.classList.toggle("has-value", !!bar.value && !bar.readOnly);
}

function clearURLBar(event) {
  if (event) event.stopPropagation();
  const bar = document.getElementById("url-bar");
  if (!bar || bar.readOnly) return;
  bar.value = "";
  updateURLClearState();
  hideURLSuggestions();
  bar.focus();
}

function onURLFocus() {
  updateURLClearState();
  updateURLSuggestions();
}

function onURLInput() {
  updateURLClearState();
  updateURLSuggestions();
}

async function updateURLSuggestions() {
  const bar = document.getElementById("url-bar");
  if (!bar || bar.readOnly || !window.browserBridge.getHistorySuggestions) return;
  const value = bar.value.trim();
  try {
    urlSuggestions = await window.browserBridge.getHistorySuggestions(value);
  } catch (e) {
    urlSuggestions = [];
  }
  urlSuggestionIndex = urlSuggestions.length ? 0 : -1;
  renderURLSuggestions(value);
}

function renderURLSuggestions(query) {
  const box = document.getElementById("url-suggestions");
  if (!box) return;
  const rows = [];
  if (query) {
    rows.push('<div class="suggestion-row search-row" onclick="navigateTo(\'' + jsString(query) + '\')"><span class="suggestion-icon">⌕</span><div class="suggestion-title">' + esc(query) + ' - Google 搜索</div><span></span></div>');
  }
  urlSuggestions.forEach((entry, index) => {
    rows.push('<div class="suggestion-row ' + (index === urlSuggestionIndex ? "active" : "") + '" onclick="navigateTo(\'' + jsString(entry.url) + '\')" title="' + esc(entry.url) + '">' +
      '<span class="suggestion-icon">↻</span><div class="suggestion-title">' + esc(entry.title || entry.url) + '<span class="suggestion-url"> - ' + esc(compactURL(entry.url)) + '</span></div>' +
      '<button class="suggestion-delete" title="删除" onclick="deleteURLSuggestion(\'' + jsString(entry.url) + '\',event)">×</button></div>');
  });
  box.innerHTML = rows.join("");
  box.classList.toggle("show", rows.length > 0);
}

function hideURLSuggestions() {
  document.getElementById("url-suggestions")?.classList.remove("show");
  urlSuggestionIndex = -1;
}

function handleURLKeydown(event) {
  if (event.key === "Enter") {
    const selected = urlSuggestionIndex >= 0 ? urlSuggestions[urlSuggestionIndex] : null;
    hideURLSuggestions();
    navigateTo(selected ? selected.url : event.currentTarget.value);
    return;
  }
  if (event.key === "Escape") {
    hideURLSuggestions();
    return;
  }
  if (event.key === "ArrowDown" && urlSuggestions.length) {
    event.preventDefault();
    urlSuggestionIndex = Math.min(urlSuggestions.length - 1, urlSuggestionIndex + 1);
    renderURLSuggestions(event.currentTarget.value.trim());
    return;
  }
  if (event.key === "ArrowUp" && urlSuggestions.length) {
    event.preventDefault();
    urlSuggestionIndex = Math.max(0, urlSuggestionIndex - 1);
    renderURLSuggestions(event.currentTarget.value.trim());
  }
}

async function deleteURLSuggestion(url, event) {
  if (event) event.stopPropagation();
  if (window.browserBridge.deleteHistoryURL) window.browserBridge.deleteHistoryURL(url);
  urlSuggestions = urlSuggestions.filter(item => item.url !== url);
  renderURLSuggestions(document.getElementById("url-bar")?.value.trim() || "");
}

function openFindBox() {
  const box = document.getElementById("find-box");
  const input = document.getElementById("find-input");
  if (!box || !input) return;
  box.classList.add("show");
  input.focus();
  input.select();
}

function closeFindBox() {
  const webview = getActiveWebview();
  if (webview && webview.stopFindInPage) webview.stopFindInPage("clearSelection");
  document.getElementById("find-box")?.classList.remove("show");
}

function handleFindKey(event) {
  if (event.key === "Enter") {
    if (event.shiftKey) findPrevious();
    else findNext();
  }
  if (event.key === "Escape") closeFindBox();
}

function findNext() {
  const input = document.getElementById("find-input");
  const webview = getActiveWebview();
  const text = input ? input.value.trim() : "";
  if (webview && text) webview.findInPage(text, { forward: true, findNext: false });
}

function findPrevious() {
  const input = document.getElementById("find-input");
  const webview = getActiveWebview();
  const text = input ? input.value.trim() : "";
  if (webview && text) webview.findInPage(text, { forward: false, findNext: false });
}

async function refreshBookmarks() {
  if (!window.browserBridge.getBookmarks) return;
  try {
    bookmarkData = await window.browserBridge.getBookmarks();
    renderBookmarkBar();
  } catch (e) {}
}

function renderBookmarkBar() {
  const bar = document.getElementById("bookmarkbar");
  if (!bar) return;
  const groups = bookmarkData.groups || [];
  const bookmarks = bookmarkData.bookmarks || [];
  const direct = bookmarks.filter(b => !b.groupId || b.groupId === "other").slice(0, 14);
  const realGroups = groups.filter(g => g.id !== "other");
  const parts = [];
  parts.push('<button class="bookmark-apps" title="应用">▦</button><span class="bookmark-divider"></span>');
  direct.forEach(bookmark => {
    parts.push('<button class="bookmark-item" title="' + esc(bookmark.url) + '" onclick="openURLInNewTab(\'' + jsString(bookmark.url) + '\')">' + bookmarkIconHTML(bookmark) + '<span class="bookmark-title">' + esc(bookmark.title) + '</span></button>');
  });
  realGroups.forEach(group => {
    const children = bookmarks.filter(b => b.groupId === group.id);
    if (!children.length) return;
    const items = children.map(b => '<div onclick="openURLInNewTab(\'' + jsString(b.url) + '\')">' + bookmarkIconHTML(b) + '<span class="bookmark-title">' + esc(b.title) + '</span></div>').join("");
    parts.push('<div class="bookmark-folder" onclick="toggleBookmarkFolder(event,this)"><span class="bookmark-folder-icon"></span><span class="bookmark-title">' + esc(group.name) + '</span><div class="bookmark-menu">' + items + '</div></div>');
  });
  const allItems = bookmarks.map(b => '<div onclick="openURLInNewTab(\'' + jsString(b.url) + '\')">' + bookmarkIconHTML(b) + '<span class="bookmark-title">' + esc(b.title) + '</span></div>').join("");
  parts.push('<span class="bookmark-spacer"></span><span class="bookmark-divider"></span><div class="bookmark-folder bookmark-all" onclick="toggleBookmarkFolder(event,this)"><span class="bookmark-folder-icon"></span><span class="bookmark-title">所有书签</span><div class="bookmark-menu" style="left:auto;right:0">' + (allItems || '<div>暂无书签</div>') + '</div></div>');
  bar.innerHTML = parts.join("");
}

function bookmarkIconHTML(bookmark) {
  if (bookmark && bookmark.icon) {
    return '<img class="bookmark-icon" src="' + esc(bookmark.icon) + '" alt="" onerror="this.replaceWith(createBookmarkFallback(this.parentNode && this.parentNode.textContent))">';
  }
  const letter = ((bookmark && bookmark.title) || "站").trim().charAt(0) || "站";
  return '<span class="bookmark-fallback">' + esc(letter.toUpperCase()) + '</span>';
}

window.createBookmarkFallback = function(text) {
  const span = document.createElement("span");
  span.className = "bookmark-fallback";
  const value = String(text || "站").trim();
  span.textContent = (value.charAt(0) || "站").toUpperCase();
  return span;
};

function toggleBookmarkFolder(event, el) {
  event.stopPropagation();
  document.querySelectorAll(".bookmark-folder.open").forEach(node => {
    if (node !== el) node.classList.remove("open");
  });
  el.classList.toggle("open");
}

document.addEventListener("click", (event) => {
  if (event.target && event.target.closest && event.target.closest("#browser-more-menu,#btn-more,#find-box,#download-panel,#btn-downloads,#url-shell,#url-suggestions")) return;
  closeMoreMenu();
  closeDownloadsPanel();
  hideURLSuggestions();
  document.querySelectorAll(".bookmark-folder.open").forEach(node => node.classList.remove("open"));
});

function addCurrentBookmark() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab || tab._isHome || !tab.webview || !window.browserBridge.addBookmark) {
    showToast("当前页面不能添加书签");
    return;
  }
  const url = tab.webview.getURL ? tab.webview.getURL() : tab.url;
  const title = (tab.webview.getTitle && tab.webview.getTitle()) || tab.title || url;
  if (!url || url === "about:blank") {
    showToast("当前页面不能添加书签");
    return;
  }
  window.browserBridge.addBookmark({ title, url, groupId: "other", icon: tab.icon || "" });
  showToast("已添加书签: " + title);
}

function updateBookmarkFavicon(tab, favicons) {
  if (!tab || tab._isHome || !window.browserBridge.updateBookmarkIcon) return;
  const icon = Array.isArray(favicons) ? favicons.find(Boolean) : "";
  const url = tab.webview && tab.webview.getURL ? tab.webview.getURL() : tab.url;
  if (!icon || !url || url === "about:blank") return;
  tab.icon = icon;
  window.browserBridge.updateBookmarkIcon({ url, icon });
}

function scheduleHistoryRecord(tabId, webview, delay) {
  clearTimeout(historyTimers.get(tabId));
  historyTimers.set(tabId, setTimeout(() => {
    historyTimers.delete(tabId);
    const tab = tabs.find(t => t.id === tabId);
    recordHistory(tab, webview);
  }, delay));
}

function recordHistory(tab, webview) {
  if (!tab || tab._isHome || !webview || !window.browserBridge.recordHistory) return;
  const url = webview.getURL ? webview.getURL() : tab.url;
  if (!url || url === "about:blank" || url === "about:ipinfo") return;
  const title = (webview.getTitle && webview.getTitle()) || tab.title || url;
  const key = url;
  const now = Date.now();
  const last = recentHistoryRecords.get(key) || 0;
  if (now - last < 3000) return;
  recentHistoryRecords.set(key, now);
  for (const [k, t] of recentHistoryRecords) {
    if (now - t > 30000) recentHistoryRecords.delete(k);
  }
  window.browserBridge.recordHistory({
    envId: envConfig.envId || "",
    envName: envConfig.name || "",
    title: title,
    url: url,
    icon: tab.icon || "",
    visitedAt: new Date().toISOString(),
  });
}

// ========== Utils ==========
function normalizeURL(raw) {
  const t = (raw || "").trim(); if (!t) return "";
  if (t === "about:ipinfo" || t === "about:blank") return t;
  if (t.includes("://")) return t;
  if (t.includes(".") && !t.includes(" ")) return "https://" + t;
  return "https://www.google.com/search?q=" + encodeURIComponent(t);
}
function esc(str) { return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function jsString(str) { return String(str ?? "").replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/\n/g,"\\n").replace(/\r/g,""); }
function compactURL(url) {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch (e) {
    return String(url || "");
  }
}
function siteInitial(title) {
  const clean = String(title || "站").trim();
  return (clean.charAt(0) || "站").toUpperCase();
}
function setStatus(msg) { document.getElementById("status").textContent = msg; }
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2000);
}

(function initTabbar() {
  const tabbar = document.getElementById("tabbar");
  const a = document.createElement("span");
  a.id = "add-tab"; a.textContent = "+"; a.title = "新建标签页";
  a.onclick = () => addTab("about:blank", "新标签页");
  tabbar.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    tabbar.scrollLeft += event.deltaY;
  }, { passive: false });
  window.addEventListener("resize", () => {
    updateTabSizing();
    keepActiveTabVisible();
  });
  tabbar.appendChild(a);
})();
