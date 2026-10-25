const { contextBridge, ipcRenderer } = require("electron");

async function daemonRequest(path, options = {}) {
  return ipcRenderer.invoke("daemon-request", path, options);
}

contextBridge.exposeInMainWorld("daemon", {
  health: () => daemonRequest("/health"),
  browserCoreStatus: () => daemonRequest("/browser-core/status"),
  detectIP: (proxy) => daemonRequest("/proxy/detect", {
    method: "POST",
    body: JSON.stringify({ proxy: proxy || { enabled: false } })
  }),
  listEnvironments: () => ipcRenderer.invoke("environments-list"),
  createEnvironment: (env) => ipcRenderer.invoke("environments-create", env),
  updateEnvironment: (id, env) => ipcRenderer.invoke("environments-update", id, env),
  deleteEnvironment: (id) => ipcRenderer.invoke("environments-delete", id),
});

// Browser window IPC (managed by Electron main process)
contextBridge.exposeInMainWorld("browser", {
  open: (envId) => ipcRenderer.invoke("open-browser", envId),
  close: (envId) => ipcRenderer.invoke("close-browser", envId),
  detectIP: (proxy) => ipcRenderer.invoke("detect-ip", proxy),
  loadProxies: () => ipcRenderer.invoke("load-proxies"),
  saveProxies: (proxies) => ipcRenderer.invoke("save-proxies", proxies),
  exportProxies: (proxies) => ipcRenderer.invoke("export-proxies", proxies),
  downloadProxyTemplate: () => ipcRenderer.invoke("download-proxy-template"),
  importProxies: () => ipcRenderer.invoke("import-proxies"),
  runningList: () => ipcRenderer.invoke("browser-running-list"),
  clearEnvironmentData: (envId) => ipcRenderer.invoke("browser-clear-environment", envId),
  kernelStatus: () => ipcRenderer.invoke("browser-kernels-status"),
  ensureKernel: version => ipcRenderer.invoke("browser-kernel-ensure", version),
  updateKernel: version => ipcRenderer.invoke("browser-kernel-update", version),
  onKernelProgress: callback => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("browser-kernel-download-progress", listener);
    return () => ipcRenderer.removeListener("browser-kernel-download-progress", listener);
  },
  onRunningState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("browser-running-state", listener);
    return () => ipcRenderer.removeListener("browser-running-state", listener);
  },
});

contextBridge.exposeInMainWorld("uploader", {
  selectIPA: () => ipcRenderer.invoke("upload-select-ipa"),
  selectDescription: () => ipcRenderer.invoke("upload-select-description"),
  transporterStatus: () => ipcRenderer.invoke("upload-transporter-status"),
  start: (payload) => ipcRenderer.invoke("upload-start", payload),
  status: (taskId) => ipcRenderer.invoke("upload-status", taskId),
  analyzeUploadLogs: (payload) => ipcRenderer.invoke("deepseek-upload-analyze", payload),
  analyzeUploadError: (payload) => ipcRenderer.invoke("deepseek-upload-analyze", payload),
});

contextBridge.exposeInMainWorld("appWindow", {
  close: () => ipcRenderer.send("app-window-control", "close"),
  minimize: () => ipcRenderer.send("app-window-control", "minimize"),
  toggleMaximize: () => ipcRenderer.send("app-window-control", "toggle-maximize"),
});

contextBridge.exposeInMainWorld("auth", {
  login: (payload) => ipcRenderer.invoke("auth-login", payload),
  me: () => ipcRenderer.invoke("auth-me"),
  syncLoginCookies: (webContentsId) => ipcRenderer.invoke("auth-sync-login-cookies", webContentsId),
  logout: () => ipcRenderer.invoke("auth-logout"),
  openPage: (path) => ipcRenderer.invoke("auth-open-page", path),
  onLoginSuccess: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("auth-login-success", listener);
    return () => ipcRenderer.removeListener("auth-login-success", listener);
  },
});

contextBridge.exposeInMainWorld("externalLink", {
  open: (url) => ipcRenderer.invoke("external-open-url", url),
});

contextBridge.exposeInMainWorld("developerAccountManager", {
  openApp: () => ipcRenderer.invoke("certificate-manager-open"),
  list: () => ipcRenderer.invoke("developer-accounts-list"),
  add: (payload) => ipcRenderer.invoke("developer-accounts-add", payload),
  remove: (id) => ipcRenderer.invoke("developer-accounts-remove", id),
  launch: (id) => ipcRenderer.invoke("developer-accounts-launch", id),
  certificateManagerRunning: () => ipcRenderer.invoke("developer-accounts-certificate-manager-running"),
  forceCloseCertificateManager: () => ipcRenderer.invoke("developer-accounts-certificate-manager-force-close"),
  downloadCertificate: (id) => ipcRenderer.invoke("developer-accounts-download-certificate", id),
  downloadCertificatePackage: (payload) => ipcRenderer.invoke("developer-accounts-download-certificate-package", payload),
  updateP12Password: (payload) => ipcRenderer.invoke("developer-accounts-update-p12-password", payload),
  updatePassword: (payload) => ipcRenderer.invoke("developer-accounts-update-password", payload),
  restoreConfig: (payload) => ipcRenderer.invoke("developer-accounts-restore-config", payload),
  activate: (payload) => ipcRenderer.invoke("developer-accounts-activate", payload),
  createRenewalPayment: (payload) => ipcRenderer.invoke("developer-accounts-payment-create", payload),
  openPurchase: (payload) => ipcRenderer.invoke("developer-accounts-payment-create", payload),
  renewalPaymentStatus: (orderNo) => ipcRenderer.invoke("developer-accounts-payment-status", orderNo),
  renewalPaymentReveal: (orderNo) => ipcRenderer.invoke("developer-accounts-payment-reveal", orderNo),
  apps: (accountId) => ipcRenderer.invoke("developer-account-apps", accountId),
  refreshAppStatus: (payload) => ipcRenderer.invoke("developer-account-app-status-refresh", payload),
  scanAppRegions: (payload) => ipcRenderer.invoke("developer-account-app-region-scan", payload),
  saveAppRegionQR: (payload) => ipcRenderer.invoke("developer-account-app-region-qr-save", payload),
  previewAppRegionQR: (payload) => ipcRenderer.invoke("developer-account-app-region-qr-preview", payload),
});

contextBridge.exposeInMainWorld("serverConfig", {
  get: () => ipcRenderer.invoke("server-config-get"),
  save: (payload) => ipcRenderer.invoke("server-config-save", payload),
  relaunch: () => ipcRenderer.invoke("server-config-relaunch"),
  openHelp: () => ipcRenderer.invoke("desktop-open-help"),
});

contextBridge.exposeInMainWorld('productContacts', {
  load: product => ipcRenderer.invoke('product-contacts-load', product),
  openGroup: product => ipcRenderer.invoke('product-contact-open-group', product),
});
