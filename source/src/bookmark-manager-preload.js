"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bookmarkManager", Object.freeze({
  add: (item) => ipcRenderer.send("bookmark-manager-add", item),
  update: (item) => ipcRenderer.send("bookmark-manager-update", item),
  addGroup: (name) => ipcRenderer.send("bookmark-manager-add-group", name),
  deleteBookmark: (id) => ipcRenderer.send("bookmark-manager-delete", id),
  deleteGroup: (id) => ipcRenderer.send("bookmark-manager-delete-group", id),
  open: (url) => ipcRenderer.send("bookmark-manager-open", url),
  onUpdated: (callback) => {
    if (typeof callback === "function") ipcRenderer.on("bookmarks-updated", () => callback());
  },
}));
