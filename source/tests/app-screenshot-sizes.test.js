const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");

const mainStart = main.indexOf("function appStoreScreenshotRequirements(");
const mainEnd = main.indexOf("function emitAppStoreScreenshotProgress(", mainStart);
assert.ok(mainStart >= 0 && mainEnd > mainStart);
const screenshotSizes = vm.runInNewContext(`${main.slice(mainStart, mainEnd)}; ({ appStoreScreenshotRequirements, appStoreScreenshotMatchesRequirements, appStoreScreenshotRecommendedSize })`);

test("iPhone and iPad screenshots accept both supported sizes in either orientation", () => {
  const { appStoreScreenshotRequirements: requirements, appStoreScreenshotMatchesRequirements: matches } = screenshotSizes;
  for (const [device, dimensions] of [
    ["iphone", [[1290, 2796], [1242, 2688]]],
    ["ipad", [[2064, 2752], [2048, 2732]]],
  ]) {
    const sizes = requirements(device);
    for (const [width, height] of dimensions) {
      assert.equal(matches(sizes, { width, height }), true);
      assert.equal(matches(sizes, { width: height, height: width }), true);
    }
    assert.equal(matches(sizes, { width: 1000, height: 2000 }), false);
  }
});

test("resize recommendation keeps the source orientation and nearest size", () => {
  const { appStoreScreenshotRequirements: requirements, appStoreScreenshotRecommendedSize: recommend } = screenshotSizes;
  const iphone = requirements("iphone");
  assert.equal(recommend(iphone, { width: 1230, height: 2660 }).width, 1242);
  assert.equal(recommend(iphone, { width: 2800, height: 1300 }).width, 2796);
  const ipad = requirements("ipad");
  assert.equal(recommend(ipad, { width: 2040, height: 2720 }).height, 2732);
});

test("resize dialog shows every size and selects the recommended one", () => {
  const start = renderer.indexOf("function openAppStoreScreenshotResizeModal(");
  const end = renderer.indexOf("function markAppStoreDetailDirty(", start);
  assert.ok(start >= 0 && end > start);
  const modal = {
    innerHTML: "",
    querySelector: () => ({ addEventListener() {} }),
    addEventListener() {},
  };
  const open = vm.runInNewContext(`${renderer.slice(start, end)}; openAppStoreScreenshotResizeModal`, {
    document: { getElementById: () => null, createElement: () => modal },
    appendAppStoreModal() {},
    escapeHTML: value => String(value),
  });
  open({ requirements: screenshotSizes.appStoreScreenshotRequirements("iphone"), recommendations: [{ width: 1242, height: 2688 }] });
  assert.match(modal.innerHTML, /竖屏（1290 × 2796）/);
  assert.match(modal.innerHTML, /竖屏（1242 × 2688）/);
  assert.match(modal.innerHTML, /横屏（2796 × 1290）/);
  assert.match(modal.innerHTML, /横屏（2688 × 1242）/);
  assert.match(modal.innerHTML, /value="1" checked/);
});
