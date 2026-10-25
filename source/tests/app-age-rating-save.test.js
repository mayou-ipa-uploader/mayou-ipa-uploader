const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const variants = [
  ["browser", path.join(__dirname, "../src")],
  ["standalone", path.join(__dirname, "../src")],
];

function source(root, name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

for (const [variant, root] of variants) {
  test(`${variant}: 年龄弹窗保存直接调用专用 IPC`, () => {
    const renderer = source(root, "certificate-manager.js");
    const preload = source(root, "certificate-preload.js");
    const bind = renderer.slice(
      renderer.indexOf("function bindAgeRatingModal"),
      renderer.indexOf("function currentAgeRatingAttributes"),
    );
    assert.match(preload, /saveAppStoreAgeRating: payload => ipcRenderer\.invoke\("app-store-connect-save-age-rating", payload\)/);
    assert.match(bind, /window\.appleDeveloper\.saveAppStoreAgeRating\(\{/);
    assert.match(bind, /appInfoId: currentAppStoreDetail\?\.appInfo\?\.id/);
    assert.match(bind, /ageRatingDeclarationId: currentAppStoreDetail\?\.appInfo\?\.ageRatingDeclarationId/);
    assert.doesNotMatch(bind, /markAppStoreDetailDirty|appInfo\.ageRatingAttributes/);
  });

  test(`${variant}: 年龄接口按 Apple 官方格式保存并只读回年龄数据`, () => {
    const main = source(root, "main.js");
    const save = main.slice(
      main.indexOf("const APP_STORE_AGE_RATING_ATTRIBUTE_NAMES"),
      main.indexOf("async function loadAppStoreConnectL10nMap"),
    );
    const handler = main.slice(
      main.indexOf('ipcMain.handle("app-store-connect-save-age-rating"'),
      main.indexOf('ipcMain.handle("app-store-connect-create-app-version"'),
    );
    assert.match(save, /ageRatingDeclarations\/\$\{encodeURIComponent\(declarationId\)\}/);
    assert.match(save, /method: "PATCH"/);
    assert.match(save, /Accept: "application\/vnd\.api\+json, application\/json, text\/csv"/);
    assert.match(save, /distribution\/info/);
    assert.match(save, /type: "ageRatingDeclarations", id: declarationId, attributes/);
    assert.match(save, /appInfos\?include=ageRatingDeclaration,app/);
    assert.match(save, /territoryAgeRatings\?include=territory&limit=500/);
    assert.match(save, /attempt < 3/);
    assert.match(save, /declarationMatches && ageRating\.territoryAgeRatings\.length/);
    assert.doesNotMatch(save, /loadAppStoreConnectAppDetail/);
    assert.doesNotMatch(save, /^\s*"ageRatingOverride",\s*$/m);
    assert.match(handler, /saveAppStoreConnectAgeRating\(payload\)/);
  });

  test(`${variant}: 保存后只替换年龄摘要而不重绘 App 页面`, () => {
    const renderer = source(root, "certificate-manager.js");
    const refresh = renderer.slice(
      renderer.indexOf("function refreshAppStoreAgeRatingSummary"),
      renderer.indexOf("function appAgeRatingText"),
    );
    assert.match(renderer, /id="app-age-rating-summary"/);
    assert.match(refresh, /summary\.innerHTML = renderAgeRatingSummary\(currentAppStoreDetail\)/);
    assert.match(refresh, /territoryAgeRatings:/);
    assert.match(refresh, /ageRatingDeclaration:/);
    assert.doesNotMatch(refresh, /switchAppStorePane|loadAppStoreConnectAppDetail|appStoreAppDetail/);
  });
}
