const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");

function loadFunction(source, name, nextName, context = {}) {
  let start = source.indexOf(`function ${name}(`);
  if (start > 6 && source.slice(start - 6, start) === "async ") start -= 6;
  let end = source.indexOf(`\nfunction ${nextName}(`, start);
  if (end < 0) end = source.indexOf(`\nasync function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source exists`);
  return vm.runInNewContext(`${source.slice(start, end)}\n${name};`, context);
}

test("description counter follows the textarea value", () => {
  const render = loadFunction(renderer, "appStoreTextarea", "appStoreMediaDeviceMatches", {
    escapeHTML: value => String(value ?? ""),
    appStoreHelp: () => "",
  });
  assert.match(render("描述", "localization.description", "", 4000), /data-app-counter-mode="used">0\/4000/);

  const update = loadFunction(renderer, "updateAppStoreFieldCounter", "appStoreTextarea");
  const counter = { dataset: { appCounterMax: "4000", appCounterMode: "used" }, textContent: "0/4000" };
  update({ value: "新版速记单词王，学习更轻松。", parentElement: { querySelector: () => counter } });
  assert.equal(counter.textContent, "14/4000");
});

test("saving a description uses the only localization linked to the selected version", async () => {
  const requests = [];
  const detailCalls = [];
  const save = loadFunction(main, "saveAppStoreConnectAppVersion", "findReadyForReviewSubmissionForAppVersion", {
    loadAppStoreConnectSaveContext: async ({ appId, versionId }) => {
      detailCalls.push([appId, versionId]);
      return { selectedVersion: { id: "version-1", localizationIds: ["locale-1"] }, localizations: [], appInfo: null };
    },
    appStoreConnectMutationFetch: () => async (requestPath, options) => { requests.push({ requestPath, body: JSON.parse(options.body) }); return { body: {} }; },
  });
  await save({ appId: "app-1", versionId: "version-1", localization: { description: "新版速记单词王，学习更轻松。" } });
  assert.deepEqual(detailCalls, [["app-1", "version-1"]]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].requestPath, /appStoreVersionLocalizations\/locale-1$/);
  assert.equal(requests[0].body.data.attributes.description, "新版速记单词王，学习更轻松。");
});

test("saving cannot silently skip a description with no known localization", async () => {
  const save = loadFunction(main, "saveAppStoreConnectAppVersion", "findReadyForReviewSubmissionForAppVersion", {
    loadAppStoreConnectSaveContext: async () => ({ selectedVersion: { id: "version-1", localizationIds: [] }, localizations: [], appInfo: null }),
    appStoreConnectMutationFetch: () => async () => { throw new Error("unexpected write"); },
  });
  await assert.rejects(
    save({ appId: "app-1", versionId: "version-1", localization: { description: "已有足够长的描述内容" } }),
    /本地化版本未读取成功/,
  );
});

test("App information can save without a version localization", async () => {
  const requests = [];
  const save = loadFunction(main, "saveAppStoreConnectAppVersion", "findReadyForReviewSubmissionForAppVersion", {
    loadAppStoreConnectSaveContext: async () => ({
      selectedVersion: { id: "version-1", localizationIds: [] },
      localizations: [],
      appInfo: { id: "info-1", localizations: [{ id: "info-locale-1", name: "旧名称" }] },
      app: {},
    }),
    appStoreConnectMutationFetch: () => async (requestPath, options) => { requests.push({ requestPath, body: JSON.parse(options.body) }); return { body: {} }; },
  });
  await save({
    appId: "app-1",
    versionId: "version-1",
    appInfo: { id: "info-1", localizationId: "info-locale-1", localization: { name: "新名称" } },
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].requestPath, /appInfoLocalizations\/info-locale-1$/);
});

test("a different locale's description error does not mark the visible description", () => {
  const globalMessages = [];
  const fieldMessages = [];
  const show = loadFunction(renderer, "showAppStoreResultErrors", "appStoreReviewRequirementMessage", {
    currentAppStoreDetail: { localizations: [{ id: "zh", locale: "zh-Hans" }, { id: "en", locale: "en-US" }] },
    activeAppStoreLocalization: () => ({ id: "zh" }),
    appStoreReadableError: () => "App 描述至少需要 10 个字符。",
    appStoreFieldFromAppleError: () => "localization.description",
    appStoreErrorLocalePrefix: () => "英语 - ",
    appStoreFieldValue: () => "新版速记单词王，学习更轻松。",
    clearAppStoreValidationErrors: () => {},
    showAppStoreError: message => globalMessages.push(message),
    showAppStoreFieldError: (_field, message) => { fieldMessages.push(message); return true; },
    document: { querySelector: () => null },
  });
  show({ errors: [{ message: "Description must be at least 10 characters", resource: "appStoreVersionLocalizations/en" }] });
  assert.equal(fieldMessages.length, 0);
  assert.deepEqual(globalMessages, ["英语 - App 描述至少需要 10 个字符。"]);
});

test("unrelated Apple description errors keep their original reason", () => {
  const readable = loadFunction(renderer, "appStoreReadableError", "showAppStoreResultErrors");
  assert.equal(readable({ message: "Description cannot be edited at this time" }), "Description cannot be edited at this time");
});
