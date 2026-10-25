const { contextBridge, ipcRenderer } = require("electron");

let _config = {};
let _ipInfo = null;
const openTabListeners = new Set();
const bookmarkListeners = new Set();
const toastListeners = new Set();
const downloadListeners = new Set();
const networkListeners = new Set();

// When browser-config arrives, also postMessage so browser.js can pick it up immediately
ipcRenderer.on("browser-config", (e, data) => {
  _config = data.config || {};
  _ipInfo = data.ipInfo || null;
  window.postMessage({ type: "browser-config-updated", config: _config, ipInfo: _ipInfo }, "*");
});

// Forward IPC messages to renderer
ipcRenderer.on("browser-nav-to", (e, url) => {
  window.postMessage({ type: "browser-nav-to", url: url }, "*");
});
ipcRenderer.on("browser-open-tab", (e, url) => {
  openTabListeners.forEach((listener) => {
    try { listener(url); } catch (e) {}
  });
});
ipcRenderer.on("browser-go-home", () => {
  window.postMessage({ type: "browser-go-home" }, "*");
});
ipcRenderer.on("browser-go-back", () => {
  window.postMessage({ type: "browser-go-back" }, "*");
});
ipcRenderer.on("browser-go-forward", () => {
  window.postMessage({ type: "browser-go-forward" }, "*");
});
ipcRenderer.on("browser-request-current-bookmark", () => {
  window.postMessage({ type: "browser-request-current-bookmark" }, "*");
});
ipcRenderer.on("browser-update-ip", (e, data) => {
  _ipInfo = data;
  window.postMessage({ type: "browser-update-ip", data: data }, "*");
});
ipcRenderer.on("browser-bookmarks-updated", (_e, data) => {
  bookmarkListeners.forEach((listener) => {
    try { listener(data); } catch (e) {}
  });
});
ipcRenderer.on("browser-toast", (_e, message) => {
  toastListeners.forEach((listener) => {
    try { listener(message); } catch (e) {}
  });
});
ipcRenderer.on("browser-downloads-updated", (_e, entries) => {
  downloadListeners.forEach((listener) => {
    try { listener(entries); } catch (e) {}
  });
});
ipcRenderer.on("browser-network-event", (_e, data) => {
  networkListeners.forEach((listener) => {
    try { listener(data); } catch (e) {}
  });
});

contextBridge.exposeInMainWorld("browserBridge", {
  getConfig: () => ({
    config: { ..._config, electronVer: process.versions.electron || "—" },
    ipInfo: _ipInfo
  }),
  refreshIP: async () => {
    try { const r = await ipcRenderer.invoke("browser-refresh-ip"); _ipInfo = r; return r; }
    catch(e) { throw e; }
  },
  navigate: (url) => ipcRenderer.send("browser-navigate", url),
  onOpenTab: (callback) => {
    if (typeof callback !== "function") return () => {};
    openTabListeners.add(callback);
    return () => openTabListeners.delete(callback);
  },
  sendGoBlank: () => ipcRenderer.send("browser-go-blank"),
  showMoreMenu: () => ipcRenderer.send("browser-show-more"),
  showHistory: () => ipcRenderer.send("browser-show-history"),
  showBookmarks: () => ipcRenderer.send("browser-show-bookmarks"),
  clearBrowsingData: () => ipcRenderer.invoke("browser-clear-data"),
  openDownloads: () => ipcRenderer.send("browser-open-downloads"),
  getDownloads: () => ipcRenderer.invoke("browser-downloads-list"),
  openDownloadItem: (targetPath) => ipcRenderer.send("browser-download-open", targetPath),
  toggleFullscreen: () => ipcRenderer.send("browser-toggle-fullscreen"),
  recordHistory: (entry) => ipcRenderer.send("browser-history-add", entry),
  getHistorySuggestions: (query) => ipcRenderer.invoke("browser-history-suggestions", query),
  getTopSites: (limit) => ipcRenderer.invoke("browser-top-sites", limit),
  getShortcuts: () => ipcRenderer.invoke("browser-shortcuts-list"),
  saveShortcuts: (items) => ipcRenderer.invoke("browser-shortcuts-save", items),
  deleteHistoryURL: (url) => ipcRenderer.send("browser-history-delete-url", url),
  getBookmarks: () => ipcRenderer.invoke("browser-bookmarks-list"),
  addBookmark: (entry) => ipcRenderer.send("browser-bookmark-add-current", entry),
  updateBookmarkIcon: (entry) => ipcRenderer.send("browser-bookmark-icon-update", entry),
  onBookmarksUpdated: (callback) => {
    if (typeof callback !== "function") return () => {};
    bookmarkListeners.add(callback);
    return () => bookmarkListeners.delete(callback);
  },
  onToast: (callback) => {
    if (typeof callback !== "function") return () => {};
    toastListeners.add(callback);
    return () => toastListeners.delete(callback);
  },
  onDownloadsUpdated: (callback) => {
    if (typeof callback !== "function") return () => {};
    downloadListeners.add(callback);
    return () => downloadListeners.delete(callback);
  },
  startNetworkCapture: (webContentsId) => ipcRenderer.invoke("browser-network-start", webContentsId),
  stopNetworkCapture: (webContentsId) => ipcRenderer.invoke("browser-network-stop", webContentsId),
  getNetworkOffline: (webContentsId) => ipcRenderer.invoke("browser-network-offline-status", webContentsId),
  setNetworkOffline: (webContentsId, enabled) => ipcRenderer.invoke("browser-network-offline", webContentsId, enabled),
  getNetworkResponseBody: (webContentsId, requestId) => ipcRenderer.invoke("browser-network-response-body", webContentsId, requestId),
  getNetworkRequestBody: (webContentsId, requestId) => ipcRenderer.invoke("browser-network-request-body", webContentsId, requestId),
  onNetworkEvent: (callback) => {
    if (typeof callback !== "function") return () => {};
    networkListeners.add(callback);
    return () => networkListeners.delete(callback);
  },
  closeBrowser: () => ipcRenderer.send("browser-close-self"),
});
