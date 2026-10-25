"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
const saveSource = main.slice(
  main.indexOf("function appStoreIcpDeveloperNameMismatch"),
  main.indexOf("async function saveAppStoreConnectAppVersion(payload = {})"),
);
const handlerSource = main.slice(
  main.indexOf('ipcMain.handle("app-store-connect-save-icp-number"'),
  main.indexOf('ipcMain.handle("app-store-connect-save-app-version"'),
);

function saveContext(fetch) {
  const context = {
    appleDeveloperRecordId: "account-1",
    appStoreConnectFetch: fetch,
    appStoreConnectErrorItems: body => body?.errors || [],
    ipcMain: { handle(name, handler) { context.handler = handler; } },
  };
  vm.runInNewContext(saveSource + handlerSource, context);
  return context;
}

test("ICP PATCH sends the captured Apple payload only after explicit confirmation", async () => {
  const requests = [];
  const context = saveContext(async (requestPath, options) => {
    requests.push({ requestPath, options });
    if (requests.length === 1) {
      const error = new Error("Your developer name does not match MIIT's records.");
      error.body = { errors: [{ detail: error.message }] };
      throw error;
    }
    return { body: {} };
  });
  const payload = { appId: "6813386708", icpNumber: "苏ICP备2026062909号-3A" };
  const first = await context.handler(null, payload);
  assert.equal(first.success, false);
  assert.equal(first.confirmationRequired, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    data: { type: "appIcpNumberDetails", id: payload.appId, attributes: { icpNumber: payload.icpNumber } },
  });

  const confirmed = await context.handler(null, { ...payload, developerNameMismatchConsent: true });
  assert.equal(confirmed.success, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].requestPath, `/iris/v1/appIcpNumberDetails/${payload.appId}`);
  assert.equal(requests[1].options.method, "PATCH");
  assert.equal(requests[1].options.headers.Referer, `https://appstoreconnect.apple.com/apps/${payload.appId}/distribution/info`);
  assert.equal(requests[1].options.headers.Accept, "application/vnd.api+json, application/json, text/csv");
  assert.equal(requests[1].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    data: { type: "appIcpNumberDetails", id: payload.appId, attributes: { icpNumber: payload.icpNumber, developerNameMismatchConsent: true } },
  });
});

test("unrelated ICP errors do not offer developer confirmation", async () => {
  const context = saveContext(async () => {
    const error = new Error("Invalid ICP number");
    error.body = { errors: [{ detail: error.message }] };
    throw error;
  });
  const result = await context.handler(null, { appId: "6813386708", icpNumber: "invalid" });
  assert.equal(result.success, false);
  assert.equal(result.confirmationRequired, false);
  assert.equal(context.appStoreIcpDeveloperNameMismatch({ message: "您的开发人员姓名与工信部的记录不匹配" }), true);
  context.appStoreConnectErrorItems = () => [{ code: "DEVELOPER_NAME_MISMATCH" }];
  assert.equal(context.appStoreIcpDeveloperNameMismatch({ message: "Validation failed" }), true);
  const confirmed = await context.handler(null, { appId: "6813386708", icpNumber: "invalid", developerNameMismatchConsent: true });
  assert.equal(confirmed.confirmationRequired, false);
});

test("ICP modal keeps the confirmation separate from ordinary App saves", () => {
  const modalSource = renderer.slice(renderer.indexOf("function appInfoIcpModal()"), renderer.indexOf("function renderIcpReadableError"));
  const context = { appStoreFieldValue: () => "", escapeHTML: value => value };
  vm.runInNewContext(modalSource, context);
  const markup = context.appInfoIcpModal();
  assert.match(markup, /data-app-icp-confirmation hidden/);
  assert.match(markup, /data-app-icp-back/);
  assert.match(markup, /data-app-icp-confirm/);
  assert.match(preload, /saveAppStoreIcpNumber: payload => ipcRenderer\.invoke\("app-store-connect-save-icp-number", payload\)/);
  const bind = renderer.slice(renderer.indexOf("async function openAppInfoModal"), renderer.indexOf("function closeAppInfoModal"));
  assert.match(bind, /result\?\.confirmationRequired && !consent/);
  assert.match(bind, /consent \? \{ developerNameMismatchConsent: true \} : \{\}/);
  assert.doesNotMatch(bind, /saveAppStoreVersion\(/);
  const genericSave = main.slice(main.indexOf("async function saveAppStoreConnectAppVersion(payload = {})"), main.indexOf("async function updateAppStoreConnectReviewSubmissionItem"));
  assert.doesNotMatch(genericSave, /appIcpNumberDetails/);
});
