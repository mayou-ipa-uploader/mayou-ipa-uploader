"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const sourceRoot = path.join(__dirname, "..", "src");
const renderer = fs.readFileSync(path.join(sourceRoot, "certificate-manager.js"), "utf8");
const rendererHTML = fs.readFileSync(path.join(sourceRoot, "certificate-manager.html"), "utf8");

test("sidebar page switch paints immediately and keeps the menu clickable while content loads", () => {
  const helpers = renderer.slice(
    renderer.indexOf("function yieldToPaint()"),
    renderer.indexOf("async function showPage("),
  );
  const showPage = renderer.slice(
    renderer.indexOf("async function showPage("),
    renderer.indexOf("function initializeInterfaceAfterLogin"),
  );

  assert.match(rendererHTML, /id="page-loading-overlay"/);
  assert.match(rendererHTML, /id="page-loading-text"/);
  assert.match(rendererHTML, /\.page-loading-overlay\{[^}]*grid-column:2/);
  assert.match(rendererHTML, /\.side\{[^}]*z-index:5/);
  assert.match(rendererHTML, /\.loading-state:before\{/);
  assert.match(rendererHTML, /\.app-detail-loading-mask\{position:absolute;inset:0/);
  assert.match(rendererHTML, /\.app-detail-loading-panel\{/);

  assert.match(helpers, /function activatePage\(name\)/);
  assert.match(helpers, /function showPageLoading\(/);
  assert.match(helpers, /function hidePageLoading\(/);
  assert.match(showPage, /await yieldToPaint\(\)/);

  const activateIndex = showPage.indexOf("activatePage(name)");
  const overlayIndex = showPage.indexOf("showPageLoading(token");
  const accessIndex = showPage.indexOf("refreshAccess(true, name)");
  assert.ok(activateIndex >= 0 && overlayIndex > activateIndex && accessIndex > overlayIndex);

  assert.match(renderer, /target\.closest\("[^"]*\.side"\)/);
  assert.match(renderer, /querySelector\("#page-apps > \.module"\)/);
  assert.match(renderer, /appStoreDetailLoadingHTML/);
  assert.doesNotMatch(renderer, /min-height:420px/);
});

test("content loading overlay sits beside the sidebar instead of covering it", () => {
  const overlayStart = rendererHTML.indexOf('<div class="page-loading-overlay" id="page-loading-overlay"');
  const asideStart = rendererHTML.indexOf('<aside class="side">');
  const mainStart = rendererHTML.indexOf('<main class="main">');
  const shellEnd = rendererHTML.indexOf("</div>\n<button class=\"review-guidance-float\"");

  assert.ok(asideStart > 0 && mainStart > asideStart);
  assert.ok(overlayStart > mainStart && overlayStart < shellEnd);
  assert.match(rendererHTML, /<aside class="side">[\s\S]*<\/aside>\s*<main class="main">/);
  assert.doesNotMatch(rendererHTML, /<aside class="side">[\s\S]*id="page-loading-overlay"[\s\S]*<\/aside>/);
});
