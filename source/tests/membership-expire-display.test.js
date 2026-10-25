"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");

test("desktop membership expiry is formatted in Asia/Shanghai", () => {
  const start = source.indexOf("function formatMembershipExpireDate(");
  const end = source.indexOf("function homeMembershipLabel(");
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const sandbox = { Intl, Date, String, Number };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = formatMembershipExpireDate("2026-12-19T16:00:00+00:00");`, sandbox);
  assert.equal(sandbox.result, "2026-12-20");
});
