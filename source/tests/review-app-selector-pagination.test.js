const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = file => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");

test("App 选择器每页 20 个并在全部 App 中搜索", () => {
  const renderer = src("certificate-manager.js");
  const helper = renderer.slice(
    renderer.indexOf("const REVIEW_GUIDANCE_PAGE_SIZE"),
    renderer.indexOf("async function openReviewGuidance"),
  );
  const sandbox = {};
  vm.runInNewContext(`${helper}; result = reviewGuidancePage(Array.from({ length: 45 }, (_, index) => ({ id: index + 1, name: index === 34 ? "Target App" : "App " + (index + 1), bundleId: "com.test." + (index + 1) })), "", 3); searched = reviewGuidancePage(Array.from({ length: 45 }, (_, index) => ({ id: index + 1, name: index === 34 ? "Target App" : "App " + (index + 1), bundleId: "com.test." + (index + 1) })), "target", 1);`, sandbox);
  const page = JSON.parse(JSON.stringify(sandbox.result));
  const searched = JSON.parse(JSON.stringify(sandbox.searched));
  assert.equal(page.indexes.length, 5);
  assert.equal(page.page, 3);
  assert.equal(page.totalPages, 3);
  assert.deepEqual(searched.indexes, [34]);
});

test("App 选择弹窗保持固定操作区、独立滚动列表和分页控件", () => {
  const renderer = src("certificate-manager.js");
  const html = src("certificate-manager.html");
  assert.match(renderer, /id="review-guidance-pager"/);
  assert.match(renderer, /reviewGuidancePage\(reviewApps, searchKeyword, currentPage\)/);
  assert.match(renderer, /mayou\.reviewGuidance\.lastAppId/);
  assert.match(html, /#review-guidance-apps\{flex:1;min-height:0;overflow-y:auto/);
  assert.match(html, /\.review-select-head\{height:78px;flex:none/);
  assert.match(html, /\.review-select-actions\{height:68px;min-height:68px;flex:none/);
});
