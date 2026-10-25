"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("bookmark manager is isolated from Node and escapes script delimiters", () => {
  assert.match(source, /bookmark-manager-preload.js/);
  assert.ok(source.includes("nodeIntegration: false"));
  assert.ok(source.includes("contextIsolation: true"));
  assert.ok(source.includes("sandbox: true"));
  assert.ok(source.includes('JSON.stringify(data.bookmarks).replace(/</g, "\\u003c")'));
  assert.doesNotMatch(source, /openBookmark('${escHTML(b.url)}')/);
});
