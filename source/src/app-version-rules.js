(function (root) {
  function isUpdateVersion(detail = {}, selected = detail.selectedVersion || {}) {
    const released = /^(READY_FOR_SALE|READY_FOR_DISTRIBUTION|AVAILABLE_FOR_SALE|REPLACED_WITH_NEW_VERSION|REMOVED_FROM_SALE|DEVELOPER_REMOVED_FROM_SALE|PREORDER_READY_FOR_SALE)$/;
    const history = detail.history || [];
    const versions = [...(detail.versions || []), ...history.map(item => item.version).filter(Boolean)];
    return versions.some(version => {
      if (!version.id || version.id === selected.id || version.platform !== selected.platform) return false;
      const order = String(version.versionString || "").localeCompare(String(selected.versionString || ""), "en", { numeric: true });
      if (order >= 0) return false;
      return [version.state, version.appStoreState, version.appVersionState].some(state => released.test(String(state || "")))
        || history.some(item => item.version?.id === version.id && (item.changes || []).some(change => released.test(change.state)));
    });
  }
  const api = { isUpdateVersion };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AppVersionRules = api;
})(typeof window === "object" ? window : globalThis);
