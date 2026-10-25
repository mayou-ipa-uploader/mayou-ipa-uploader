"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "certificate-manager.js"), "utf8");

function runHomeAccessInfo(currentAccess, now) {
  const start = source.indexOf("function homeAccessInfo()");
  const end = source.indexOf("function formatHomeBusinessDate(");
  const helper = source.slice(start, end);
  const RealDate = Date;
  function MockDate(...args) {
    if (new.target) {
      return args.length ? new RealDate(...args) : new RealDate(now);
    }
    return args.length ? RealDate(...args) : RealDate(now);
  }
  MockDate.now = () => now;
  MockDate.parse = RealDate.parse;
  MockDate.UTC = RealDate.UTC;
  MockDate.prototype = RealDate.prototype;
  const sandbox = {
    currentAccess,
    Date: MockDate,
    Math,
    Number,
    formatAccessDate(value) {
      const date = new MockDate(value);
      return Number.isNaN(date.getTime()) ? "" : "formatted";
    },
  };
  vm.runInNewContext(`${helper}\nresult = homeAccessInfo();`, sandbox);
  return sandbox.result;
}

test("homepage elapsed days start from first login instead of a 365-day baseline", () => {
  assert.match(source, /access\.firstLoginAt \|\| access\.activatedAt/);
  assert.doesNotMatch(source, /const baseline = activated \? 365/);

  const result = runHomeAccessInfo({
    activated: true,
    allowed: true,
    firstLoginAt: "2026-08-14T00:00:00+00:00",
    activatedAt: "2027-09-05T00:00:00+00:00",
    authorizationExpiresAt: "2028-09-04T00:00:00+00:00",
    remainingDays: 720,
    trialDays: 15,
  }, Date.parse("2026-09-15T12:00:00+08:00"));

  assert.equal(result.elapsedText, "32");
  assert.equal(result.remainingText, "720");
  assert.equal(result.label, "授权版本");
  assert.ok(result.progress > 0);
});

test("homepage ignores a future activation date when computing elapsed days", () => {
  const result = runHomeAccessInfo({
    activated: true,
    allowed: true,
    firstLoginAt: "",
    activatedAt: "2027-09-05T00:00:00+00:00",
    authorizationExpiresAt: "2028-09-04T00:00:00+00:00",
    remainingDays: 720,
    trialDays: 15,
  }, Date.parse("2026-09-15T12:00:00+08:00"));

  assert.equal(result.elapsedText, "0");
  assert.equal(result.remainingText, "720");
});
