const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");

function loadFunction(source, name, nextName, context) {
  let start = source.indexOf(`function ${name}(`);
  if (start > 6 && source.slice(start - 6, start) === "async ") start -= 6;
  let end = source.indexOf(`\nfunction ${nextName}(`, start);
  if (end < 0) end = source.indexOf(`\nasync function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source exists`);
  return vm.runInNewContext(`${source.slice(start, end)}\n${name};`, context);
}

const renderContext = {
  escapeHTML: value => String(value ?? ""),
  formatAppStorePrice: (value, currency) => value == null || value === "" ? "" : `${currency} ${value}`,
  appStoreVersionIsDistributable: version => ["AVAILABLE_FOR_SALE", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(version.state),
  appStorePricingDraft: null,
};
renderContext.renderAppStorePricingExtraSections = loadFunction(renderer, "renderAppStorePricingExtraSections", "renderAppStorePricingPane", renderContext);
const renderAppStorePricingPane = loadFunction(renderer, "renderAppStorePricingPane", "appStorePricingSettingsChanges", renderContext);

test("released App pricing page shows the confirmed three sales states and omits preorder", () => {
  const html = renderAppStorePricingPane({
    app: { status: "AVAILABLE_FOR_SALE" },
    selectedVersion: { state: "AVAILABLE_FOR_SALE" },
    pricing: { hasPrice: true, territoryName: "中国大陆", currency: "CNY", price: "0", priceScheduleLoaded: true, currentPriceTerritoryCount: 175, currentPrices: [{ territoryId: "CHN" }] },
    availability: { exists: true, total: 175, availableCount: 175, statusCount: { available: 2, processing: 146, unavailable: 27, unknown: 0 } },
  });
  assert.match(html, /<strong>2<\/strong> 个可供货/);
  assert.match(html, /<strong>146<\/strong> 个正在处理/);
  assert.match(html, /<strong>27<\/strong> 个无法销售/);
  assert.doesNotMatch(html, /设置预购/);
});

test("pricing page does not invent sales states or a 175-territory price count", () => {
  const html = renderAppStorePricingPane({
    selectedVersion: { state: "AVAILABLE_FOR_SALE" },
    pricing: { hasPrice: true, territoryName: "中国大陆", currency: "CNY", price: "0", priceScheduleLoaded: false, currentPriceTerritoryCount: null },
    availability: { exists: true, total: 175, availableCount: 175, statusCount: { available: 0, processing: 0, unavailable: 0, unknown: 175 } },
  });
  assert.match(html, /<strong>175<\/strong> 个已开启供应/);
  assert.match(html, /Apple 暂未返回各地区的销售处理状态/);
  assert.doesNotMatch(html, /个可供货|175 个国家或地区/);
  assert.match(html, /id="app-pricing-download"[^>]*disabled/);
});

const normalizeAppStorePricing = loadFunction(main, "normalizeAppStorePricing", "loadAppStoreConnectPricingDetail", {
  jsonApiRows: body => body?.data || [],
  jsonApiIncluded: body => body?.included || [],
  relationshipData: (row, key) => {
    const data = row?.relationships?.[key]?.data;
    return data ? (Array.isArray(data) ? data : [data]) : [];
  },
  findIncluded: (body, type, id) => (body?.included || []).find(row => row.type === type && row.id === id),
  appStoreTerritoryName: id => ({ CHN: "中国大陆", USA: "美国", JPN: "日本" })[id] || id,
});

test("current price list includes returned regions and excludes future prices", () => {
  const manual = {
    data: [{ attributes: {}, relationships: { territory: { data: { id: "CHN" } }, appPricePoint: { data: { id: "cny" } } } }],
    included: [{ type: "appPricePoints", id: "cny", attributes: { customerPrice: "0" } }, { type: "territories", id: "CHN", attributes: { currency: "CNY" } }],
  };
  const automatic = {
    data: [
      { attributes: {}, relationships: { territory: { data: { id: "USA" } }, appPricePoint: { data: { id: "usd" } } } },
      { attributes: { startDate: "2999-01-01" }, relationships: { territory: { data: { id: "JPN" } }, appPricePoint: { data: { id: "jpy" } } } },
    ],
    included: [
      { type: "appPricePoints", id: "usd", attributes: { customerPrice: "1.99" } },
      { type: "appPricePoints", id: "jpy", attributes: { customerPrice: "300" } },
      { type: "territories", id: "USA", attributes: { currency: "USD" } },
      { type: "territories", id: "JPN", attributes: { currency: "JPY" } },
    ],
  };
  const pricing = normalizeAppStorePricing(manual, { data: [{ id: "CHN" }] }, automatic);
  assert.equal(pricing.currentPriceTerritoryCount, 2);
  assert.deepEqual(Array.from(pricing.currentPrices, row => row.territoryId).sort(), ["CHN", "USA"]);
  assert.equal(pricing.currentPrices.find(row => row.territoryId === "USA").price, "1.99");
  assert.equal(normalizeAppStorePricing(manual, { data: [{ id: "CHN" }] }, { data: [] }).priceScheduleLoaded, false);
});

test("pricing page keeps the Mac, Vision Pro, distribution, compatible versions, and stop-sale sections", () => {
  const html = renderAppStorePricingPane({
    app: { id: "app-1", status: "AVAILABLE_FOR_SALE" },
    selectedVersion: { platform: "IOS", state: "AVAILABLE_FOR_SALE" },
    versions: [{ platform: "IOS", state: "AVAILABLE_FOR_SALE" }],
    availability: { exists: true, total: 2, availableCount: 2, territories: [{ id: "CHN" }, { id: "USA" }] },
    pricingSettings: {
      mac: { loaded: true, available: true, verified: false, automaticMinVersion: "12.0", minVersion: "", supportedVersions: ["12.0", "13.0"] },
      vision: { loaded: true, available: true },
      distribution: { loaded: true, type: "APP_STORE", educationDiscount: true },
      versionsLoaded: true,
      versions: [{ id: "v1", platform: "IOS", state: "READY_FOR_SALE", version: "1.0.0", downloadable: true }],
    },
  });
  for (const title of ["搭载 Apple 芯片的 Mac", "Apple Vision Pro", "App 分发方式", "上个兼容版本的设置", "停止销售 App"]) assert.match(html, new RegExp(title));
  assert.match(html, /id="app-price-mac-available"[^>]*checked/);
  assert.match(html, /id="app-price-vision-available"[^>]*checked/);
  assert.match(html, /id="app-price-education-discount"[^>]*checked/);
  assert.match(html, /value="CUSTOM"[^>]*disabled/);
});

test("distribution options stay locked while a version is in review", () => {
  const html = renderAppStorePricingPane({
    app: { id: "app-1" },
    selectedVersion: { platform: "IOS", state: "IN_REVIEW" },
    pricingSettings: {
      distribution: { loaded: true, type: "APP_STORE", educationDiscount: false },
      versions: [{ id: "v1", platform: "IOS", state: "IN_REVIEW", downloadable: true }],
    },
  });
  assert.match(html, /value="CUSTOM"[^>]*disabled/);
});

const normalizeAppStorePricingPageSettings = loadFunction(main, "normalizeAppStorePricingPageSettings", "loadAppStoreConnectPricingPageSettings", {
  jsonApiRows: body => body?.data ? (Array.isArray(body.data) ? body.data : [body.data]) : [],
  jsonApiIncluded: body => body?.included || [],
});

test("pricing settings are read from Apple's returned resources, not guessed defaults", () => {
  const settings = normalizeAppStorePricingPageSettings(
    { included: [
      { type: "iosAppToMacAppStoreOptInSetting", id: "app-1", attributes: { isOptedInToDistributeIosAppOnMacAppStore: false, isVerifiedForMacOs: null, supportedMacOsVersions: ["13.0", "12.0"], automaticMinMacOsVersion: "12.0" } },
      { type: "iosAppToAppStoreOnVisionOsOptInSetting", id: "app-1", attributes: { isOptedInToDistributeIosAppToAppStoreOnVisionOs: true } },
    ] },
    { data: { type: "apps", id: "app-1", attributes: { distributionType: "APP_STORE", educationDiscountType: "DISCOUNTED" } } },
    { included: [{ type: "appStoreVersions", id: "v1", attributes: { platform: "IOS", versionString: "1.0.0", downloadable: true } }] },
  );
  assert.equal(settings.mac.available, false);
  assert.equal(settings.vision.available, true);
  assert.equal(settings.distribution.educationDiscount, true);
  assert.equal(settings.versions[0].downloadable, true);
  assert.deepEqual(Array.from(settings.mac.supportedVersions), ["12.0", "13.0"]);
  const unknown = normalizeAppStorePricingPageSettings();
  assert.equal(unknown.mac.loaded, false);
  assert.equal(unknown.vision.loaded, false);
  assert.equal(unknown.distribution.loaded, false);
  const incomplete = normalizeAppStorePricingPageSettings(
    { included: [{ type: "iosAppToMacAppStoreOptInSetting", id: "app-1", attributes: {} }] },
    { data: { type: "apps", id: "app-1", attributes: { distributionType: "APP_STORE" } } },
    { included: [{ type: "appStoreVersions", id: "v1", attributes: { platform: "IOS" } }] },
  );
  assert.equal(incomplete.mac.loaded, false);
  assert.equal(incomplete.distribution.loaded, false);
  assert.equal(incomplete.versionsLoaded, false);
});

test("privacy detail still loads and caches after pricing settings changes", async () => {
  let requestCount = 0;
  const loadPrivacy = loadFunction(main, "loadAppStoreConnectPrivacyDetail", "appStoreLocalizedValue", {
    appStoreConnectValueCache: new Map(),
    APP_STORE_CONNECT_SHORT_CACHE_MS: 60_000,
    appStoreConnectFetch: async () => { requestCount += 1; return { body: { data: [] } }; },
    loadAppStoreConnectL10nMap: async () => ({}),
    jsonApiRows: body => body?.data || [],
    jsonApiIncluded: body => body?.included || [],
    normalizeAppDataUsage: row => row,
    normalizeAppDataUsageCategory: row => row,
    normalizeAppDataUsageGrouping: row => row,
    normalizeAppDataUsagePurpose: row => row,
    normalizeAppInfo: row => row,
  });
  await loadPrivacy("app-1");
  await loadPrivacy("app-1");
  assert.equal(requestCount, 5);
});

test("pricing settings save writes the real Mac, Vision, education and old-version resources", async () => {
  const requests = [];
  const settings = {
    mac: { loaded: true, id: "app-1", available: true, minVersion: "", supportedVersions: ["12.0", "13.0"] },
    vision: { loaded: true, id: "app-1", available: true },
    distribution: { loaded: true, type: "APP_STORE", educationDiscount: true },
    versionsLoaded: true,
    versions: [
      { id: "current", state: "READY_FOR_SALE", downloadable: true },
      { id: "old", state: "REPLACED_WITH_NEW_VERSION", downloadable: true },
    ],
  };
  const save = loadFunction(main, "saveAppStoreConnectPricingPageSettings", "verifyAppStoreConnectMacCompatibility", {
    loadAppStoreConnectPricingPageSettings: async () => settings,
    appStoreConnectFetch: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); },
    clearAppStoreConnectValueCache: () => {},
  });
  await save({ appId: "app-1", mac: { available: false, minVersion: "" }, vision: { available: false }, distribution: { type: "APP_STORE", educationDiscount: false }, versions: [{ id: "old", downloadable: false }] });
  assert.equal(requests.length, 4);
  assert.match(requests[0].path, /iosAppToMacAppStoreOptInSetting/);
  assert.equal(requests[0].body.data.attributes.isOptedInToDistributeIosAppOnMacAppStore, false);
  assert.match(requests[1].path, /iosAppToAppStoreOnVisionOsOptInSetting/);
  assert.equal(requests[1].body.data.attributes.isOptedInToDistributeIosAppToAppStoreOnVisionOs, false);
  assert.equal(requests[2].body.data.attributes.educationDiscountType, "NOT_DISCOUNTED");
  assert.equal(requests[3].body.data.attributes.downloadable, false);
  await assert.rejects(save({ appId: "app-1", versions: [{ id: "current", downloadable: false }] }), /当前 App Store 版本不能/);
});

test("stop sale removes every territory and future-storefront availability", async () => {
  const calls = [];
  const save = loadFunction(main, "saveAppStoreConnectAvailability", "createAppStoreConnectPricing", {
    loadAppStoreConnectTerritories: async () => [{ id: "CHN" }, { id: "USA" }],
    appStoreAvailabilityTemporaryId: (_appId, territoryId) => `tmp-${territoryId}`,
    appStoreConnectFetch: async (_path, options) => { calls.push(JSON.parse(options.body)); },
    clearAppStoreConnectValueCache: () => {},
    loadAppStoreConnectAppDetail: async () => ({}),
  });
  await save({ appId: "app-1", mode: "stop-sale", territoryIds: [] });
  assert.equal(calls[0].data.attributes.availableInNewTerritories, false);
  assert.deepEqual(Array.from(calls[0].included, item => item.attributes.available), [false, false]);
  await assert.rejects(save({ appId: "app-1", territoryIds: [] }), /至少选择一个国家或地区/);
});
