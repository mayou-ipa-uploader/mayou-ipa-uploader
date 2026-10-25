const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("developerAccounts", {
  list: () => ipcRenderer.invoke("developer-accounts-list"),
  add: payload => ipcRenderer.invoke("developer-accounts-add", payload),
  updatePassword: payload => ipcRenderer.invoke("developer-accounts-update-password", payload),
  remove: id => ipcRenderer.invoke("developer-accounts-remove", id),
  launch: id => ipcRenderer.invoke("developer-accounts-launch", id),
  certificateManagerRunning: () => ipcRenderer.invoke("developer-accounts-certificate-manager-running"),
  forceCloseCertificateManager: () => ipcRenderer.invoke("developer-accounts-certificate-manager-force-close"),
  downloadCertificate: id => ipcRenderer.invoke("developer-accounts-download-certificate", id),
  activate: payload => ipcRenderer.invoke("developer-accounts-activate", payload),
  createRenewalPayment: payload => ipcRenderer.invoke("developer-accounts-payment-create", payload),
  openPurchase: payload => ipcRenderer.invoke("developer-accounts-payment-create", payload),
  renewalPaymentStatus: orderNo => ipcRenderer.invoke("developer-accounts-payment-status", orderNo),
  renewalPaymentReveal: orderNo => ipcRenderer.invoke("developer-accounts-payment-reveal", orderNo),
});

contextBridge.exposeInMainWorld("browserProxy", {
  loadProxies: () => ipcRenderer.invoke("load-proxies"),
  detectIP: proxy => ipcRenderer.invoke("detect-ip", proxy),
});
