"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
function code(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}
function load(source, names, context) {
  vm.createContext(context);
  vm.runInContext(names.map(name => code(source, name)).join("\n"), context);
  return context;
}
function appleBody(appId = "app-a") {
  return {
    data: { type: "appStoreVersions", id: "version-a", attributes: { versionString: "3.4", appStoreState: "PREPARE_FOR_SUBMISSION" }, relationships: {
      app: { data: { type: "apps", id: appId } },
      appStoreVersionLocalizations: { data: [{ type: "appStoreVersionLocalizations", id: "locale-a" }] },
      appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: "review-a" } },
    } },
    included: [
      { type: "appStoreVersionLocalizations", id: "locale-a", attributes: { description: "original", keywords: "old", whatsNew: "old notes" } },
      { type: "appStoreReviewDetails", id: "review-a", attributes: { notes: "original" } },
    ],
  };
}
function saveContext(fetch) {
  return load(main, ["loadAppStoreConnectSaveContext", "saveAppStoreConnectAppVersion", "normalizeAppStoreVersion", "normalizeVersionLocalization", "normalizeReviewDetail"], {
    appStoreConnectMutationFetch: () => fetch,
    loadAppStoreConnectAppDetail: () => { throw new Error("full detail must never run during save"); },
    jsonApiRows: body => Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [],
    relationshipData: (row, name) => { const data = row?.relationships?.[name]?.data; return Array.isArray(data) ? data : data ? [data] : []; },
    findIncluded: (body, type, id) => (body?.included || []).find(row => row.type === type && row.id === id),
    appStoreIconURL: () => "",
  });
}
const payload = { appId: "app-a", versionId: "version-a", localizationId: "locale-a", localization: { description: "new description" } };

test("a description save reads only its version and returns immediately after Apple's PATCH acknowledgement", async () => {
  const requests = [];
  let acknowledge;
  const context = saveContext(async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method) return { body: appleBody() };
    return new Promise(resolve => { acknowledge = resolve; });
  });
  let finished = false;
  const saving = context.saveAppStoreConnectAppVersion(payload).then(value => { finished = true; return value; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /appStoreVersions\/version-a\?include=app,appStoreVersionLocalizations/);
  assert.equal(requests[1].url, "/iris/v1/appStoreVersionLocalizations/locale-a");
  assert.deepEqual(JSON.parse(requests[1].options.body).data.attributes, payload.localization);
  acknowledge({ body: { data: { attributes: { description: "new description" } } } });
  const saved = await saving;
  assert.equal(saved.localizations[0].description, "new description");
  assert.equal(requests.length, 2, "no queries after the write");
});

test("Apple failures, including uneditable whatsNew, are not silently reported as saved", async () => {
  let writes = 0;
  const context = saveContext(async (_url, options = {}) => {
    if (!options.method) return { body: appleBody() };
    writes++;
    throw new Error("whatsNew cannot be edited at this time");
  });
  await assert.rejects(context.saveAppStoreConnectAppVersion({ ...payload, localization: { whatsNew: "new" } }), /cannot be edited/);
  assert.equal(writes, 1);
});

test("saving rejects a different app, localization or review resource before any write", async () => {
  for (const [body, change] of [[appleBody("other-app"), {}], [appleBody(), { localizationId: "other-locale" }], [appleBody(), { reviewDetailId: "other-review", reviewDetail: { notes: "new" } }]]) {
    let writes = 0;
    const context = saveContext(async (_url, options = {}) => { if (options.method) writes++; return { body }; });
    await assert.rejects(context.saveAppStoreConnectAppVersion({ ...payload, ...change }), /不匹配/);
    assert.equal(writes, 0);
  }
});

test("the first successful write does not mask failure of another changed section", async () => {
  let writes = 0;
  const context = saveContext(async (_url, options = {}) => {
    if (!options.method) return { body: appleBody() };
    if (++writes === 2) throw new Error("review notes rejected");
    return { body: {} };
  });
  await assert.rejects(context.saveAppStoreConnectAppVersion({ ...payload, reviewDetailId: "review-a", reviewDetail: { notes: "new" } }), /review notes rejected/);
  assert.equal(writes, 2);
});

test("resubmit waits for the real Apple write and performs no full detail read", async () => {
  let acknowledge;
  const context = load(main, ["resubmitAppStoreConnectReview"], {
    appStoreConnectMutationFetch: () => (url, options) => {
      assert.equal(url, "/iris/v1/reviewSubmissions/submission-dynamic");
      assert.equal(JSON.parse(options.body).data.attributes.submitted, true);
      return new Promise(resolve => { acknowledge = resolve; });
    },
    loadAppStoreConnectAppDetail: () => { throw new Error("must not refresh here"); },
  });
  let finished = false;
  const pending = context.resubmitAppStoreConnectReview({ appId: "app-a", submissionId: "submission-dynamic" }).then(result => { finished = true; return result; });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  acknowledge({ body: { data: { attributes: { state: "WAITING_FOR_REVIEW" } } } });
  assert.equal((await pending).state, "WAITING_FOR_REVIEW");
});

function rendererContext() {
  const notices = [], errors = [];
  const button = { disabled: false, textContent: "保存", dataset: {}, isConnected: true };
  const context = {
    appStoreDetailRequestSeq: 0, appStoreSaveInFlight: false, appStoreEditRevision: 0,
    currentAppStoreApp: { id: "app-a" },
    currentAppStoreDetail: { app: { id: "app-a" }, selectedVersion: { id: "version-a" }, localizations: [{ id: "locale-a", description: "original", screenshotSetIds: ["screenshots"] }], screenshotSets: [{ id: "screenshots" }], reviewSubmissions: [] },
    currentReviewSubmissionDetail: { id: "submission-a", state: "UNRESOLVED_ISSUES", items: [] },
    document: { querySelector: selector => selector === ".app-detail" ? { dataset: { pane: "release" } } : null },
    el: () => button, appStoreVersionEditable: () => true, validateAppStoreBeforeSave: () => true,
    appStoreVersionPayload: () => payload, clearAppStoreDetailCache: () => {},
    setBusy: (button, busy, text) => { button.disabled = busy; button.textContent = busy ? text : "保存"; },
    updateCurrentAppStoreDetail: detail => { context.currentAppStoreDetail = detail; },
    switchAppStorePane: () => { context.renders++; }, renders: 0,
    showAppStoreNotice: (...args) => notices.push(args),
    showAppStoreResultErrors: error => errors.push(error), showAppStoreError: error => errors.push(error), appStoreFieldFromAppleError: () => "",
    window: { appleDeveloper: {} },
  };
  load(renderer, ["mergeSavedAppStoreFields", "saveAppStoreDetail", "refreshAcceptedAppStoreSubmission", "resubmitAppStoreReviewSubmission"], context);
  return { context, notices, errors, button };
}

test("saving merges only confirmed fields and preserves media without another detail request", async () => {
  const { context, notices, button } = rendererContext();
  context.window.appleDeveloper.saveAppStoreVersion = async () => ({ success: true, detail: { localizations: [{ id: "locale-a", description: "new", screenshotSetIds: [] }] } });
  await context.saveAppStoreDetail();
  assert.equal(notices[0][0], "保存成功。");
  assert.equal(context.currentAppStoreDetail.localizations[0].description, "new");
  assert.deepEqual(context.currentAppStoreDetail.localizations[0].screenshotSetIds, ["screenshots"]);
  assert.deepEqual(context.currentAppStoreDetail.screenshotSets, [{ id: "screenshots" }]);
  assert.equal(button.disabled, true);
});

test("edits typed during a save remain on screen and need another save", async () => {
  const { context, notices, button } = rendererContext();
  context.window.appleDeveloper.saveAppStoreVersion = async () => {
    context.appStoreEditRevision++;
    return { success: true, detail: { localizations: [{ id: "locale-a", description: "saved" }] } };
  };
  await context.saveAppStoreDetail();
  assert.equal(context.renders, 0);
  assert.match(notices[0][0], /新增的修改尚未保存/);
  assert.equal(button.disabled, false);
});

test("a save response from a previous app cannot repaint the new app", async () => {
  const { context, notices } = rendererContext();
  context.window.appleDeveloper.saveAppStoreVersion = async () => {
    context.currentAppStoreApp = { id: "app-b" };
    return { success: true, detail: {} };
  };
  await context.saveAppStoreDetail();
  assert.equal(context.renders, 0);
  assert.equal(notices.length, 0);
});

test("submit feedback is immediate even when background status refresh never finishes", async () => {
  const { context, notices, button } = rendererContext();
  button.dataset.reviewSubmissionId = "submission-a";
  context.window.appleDeveloper.resubmitAppStoreReview = async () => ({ success: true, submitted: true });
  context.window.appleDeveloper.appStoreReviewSubmissionStatus = () => new Promise(() => {});
  await context.resubmitAppStoreReviewSubmission(button);
  assert.match(notices[0][0], /^提交审核成功/);
  assert.equal(button.textContent, "已提交");
  assert.equal(button.disabled, true);
  assert.equal(context.currentReviewSubmissionDetail.submissionAccepted, true);
});

test("failed status refresh never changes a successful submission into a submission error", async () => {
  const { context, notices, errors, button } = rendererContext();
  button.dataset.reviewSubmissionId = "submission-a";
  context.window.appleDeveloper.resubmitAppStoreReview = async () => ({ success: true, submitted: true });
  context.window.appleDeveloper.appStoreReviewSubmissionStatus = async () => ({ success: false, error: "network timeout" });
  await context.resubmitAppStoreReviewSubmission(button);
  await new Promise(setImmediate);
  assert.equal(errors.length, 0);
  assert.match(notices.at(-1)[0], /提交审核已成功.*暂未刷新/);
  assert.equal(notices.at(-1)[1], "warning");
});

test("a rejected submit restores the button and does not query status", async () => {
  const { context, notices, errors, button } = rendererContext();
  button.dataset.reviewSubmissionId = "submission-a";
  context.window.appleDeveloper.resubmitAppStoreReview = async () => ({ success: false, error: "Apple validation error" });
  context.window.appleDeveloper.appStoreReviewSubmissionStatus = () => { throw new Error("must not refresh"); };
  await context.resubmitAppStoreReviewSubmission(button);
  assert.equal(button.disabled, false);
  assert.equal(notices.length, 0);
  assert.equal(errors[0], "Apple validation error");
});

test("common-issues guidelines keep body size while the actual rejection heading remains a heading", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  const html = context.appStoreReviewMessageHTML({ body: "Guideline 3.1.1 - Issue\n\nActual rejection\n\nPrevent Common Issues\n\nGuideline 2.1 - Bugs and crashes:\n\nGeneral advice" });
  assert.match(html, /<h4>Guideline 3\.1\.1 - Issue<\/h4>/);
  assert.match(html, /<p><strong>Guideline 2\.1 - Bugs and crashes:<\/strong><\/p>/);
});

test("review prose flows across single source newlines while headings and paragraphs stay separate", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  const html = context.appStoreReviewMessageHTML({ body: "Guideline 5.2.3 - Legal\nIssue Description\nThe app contains content or features\nthat may violate third-party rights.\n\nA separate paragraph." });
  assert.match(html, /<h4 class="app-review-issue-heading"><span>Guideline 5\.2\.3 - Legal<\/span><span>Issue Description<\/span><\/h4>/);
  assert.match(html, /<p>The app contains content or features that may violate third-party rights\.<\/p><p>A separate paragraph\.<\/p>/);
  assert.doesNotMatch(html, /<br>/);
});

test("inline bold content does not introduce paragraphs or hard line breaks", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  const html = context.appStoreReviewMessageHTML({ body: "<p>Please attach <b>documentary evidence</b> to confirm <strong>all necessary rights</strong>.</p>" });
  assert.equal(html, "<p>Please attach documentary evidence to confirm all necessary rights.</p>");
});

test("review fields and list entries keep their lines while list continuations wrap naturally", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  const html = context.appStoreReviewMessageHTML({ body: "Review Environment\nSubmission ID: example\nReview date: October 12, 2026\nReview Device: iPad Air\nVersion reviewed: 1.0.1 (1011)\n\nResources\n- Review guideline 5.2.3\nfor more information.\n- Review App Store Connect Help." });
  assert.match(html, /Submission ID: example<br>Review date: October 12, 2026<br>Review Device: iPad Air<br>Version reviewed: 1\.0\.1 \(1011\)/);
  assert.match(html, /<p>- Review guideline 5\.2\.3 for more information\.<br>- Review App Store Connect Help\.<\/p>/);
});

test("interactive requests overtake queued background reads without running concurrently", async () => {
  let now = 1000, release;
  const order = [];
  const context = vm.createContext({ Date: { now: () => now += 200 }, setTimeout, clearTimeout });
  vm.runInContext(main.slice(main.indexOf("const APP_STORE_CONNECT_REQUEST_CONCURRENCY"), main.indexOf("function isCertificateManagerStandalone")), context);
  const first = context.enqueueAppStoreConnectRequest(() => { order.push("running"); return new Promise(resolve => { release = resolve; }); });
  await new Promise(setImmediate);
  const queued = context.enqueueAppStoreConnectRequest(() => order.push("background"));
  const save = context.enqueueAppStoreConnectRequest(() => order.push("save"), true);
  const submit = context.enqueueAppStoreConnectRequest(() => order.push("submit"), true);
  assert.deepEqual(order, ["running"]);
  release();
  await Promise.all([first, queued, save, submit]);
  assert.deepEqual(order, ["running", "save", "submit", "background"]);
});

test("saving App information only queries that app's information and retains the saved name", async () => {
  const requests = [];
  const context = saveContext(async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method) return { body: {} };
    return { body: {
      data: [{ type: "appInfos", id: "info-a" }],
      included: [{ type: "apps", id: "app-a", attributes: { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } }],
    } };
  });
  context.normalizeAppInfo = () => ({ id: "info-a", localizations: [{ id: "info-locale-a", name: "Original" }] });
  const saved = await context.saveAppStoreConnectAppVersion({ appId: "app-a", versionId: "version-a", appInfo: {
    id: "info-a", localizationId: "info-locale-a", localization: { name: "Changed" },
  } });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /^\/iris\/v1\/apps\/app-a\/appInfos\?/);
  assert.equal(requests[1].url, "/iris/v1/appInfoLocalizations/info-locale-a");
  assert.equal(saved.appInfo.localizations[0].name, "Changed");
});

test("save requests keep the account session and stop subsequent writes after an account switch", async () => {
  const ses = {};
  let calls = 0;
  const context = {
    appleDeveloperContextGeneration: 1, appleDeveloperAccountKey: "account-a",
    readSelectedAppleDeveloperTeam: () => ({ id: "team-a" }),
    appleDeveloperContextIsCurrent: (generation, key) => generation === context.appleDeveloperContextGeneration && key === context.appleDeveloperAccountKey,
    appleDeveloperPartitionForAccount: key => key,
    session: { fromPartition: key => { assert.equal(key, "account-a"); return ses; } },
    appStoreConnectFetch: async (_url, options) => {
      calls++;
      assert.equal(options.session, ses);
      assert.equal(options.priority, "interactive");
      context.appleDeveloperContextGeneration++;
      return { body: {} };
    },
  };
  load(main, ["appStoreConnectMutationFetch"], context);
  const fetch = context.appStoreConnectMutationFetch();
  await assert.rejects(fetch("/iris/v1/appStoreVersions/version-a"), /账户或团队已切换/);
  await assert.rejects(fetch("/iris/v1/appStoreVersions/version-a", { method: "PATCH" }), /账户或团队已切换/);
  assert.equal(calls, 1);
});

test("late successful status refresh updates neither a different app nor fresh unsaved input", async () => {
  for (const switchApp of [false, true]) {
    const { context } = rendererContext();
    context.window.appleDeveloper.appStoreReviewSubmissionStatus = async () => {
      context.appStoreEditRevision++;
      if (switchApp) context.currentAppStoreApp = { id: "app-b" };
      return { success: true, submission: { id: "submission-a", state: "WAITING_FOR_REVIEW", items: [] } };
    };
    await context.refreshAcceptedAppStoreSubmission("app-a", "submission-a", 0);
    assert.equal(context.renders, 0);
    assert.equal(context.currentReviewSubmissionDetail.state, switchApp ? "UNRESOLVED_ISSUES" : "WAITING_FOR_REVIEW");
  }
});


test("Apple's actual h3/br/b rejection format keeps the issue headings together", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  // Captured from resolutionCenterMessages.attributes.messageBody on 2026-10-12.
  const body = '<h3>Guideline 5.2.3 - Legal</h3><br><b>Issue Description</b><br><br>The app contains content or features that may violate the rights of one or more third parties. Specifically, the app provides potentially unauthorized access to third-party audio or video streaming, catalogs, and discovery services. <br><br>The app and its contents should not infringe upon the rights of another party.<br><br><b>Next Steps</b><br><br>Please attach documentary evidence.';
  const html = context.appStoreReviewMessageHTML({ body });
  assert.match(html, /<h4 class="app-review-issue-heading"><span>Guideline 5\.2\.3 - Legal<\/span><span>Issue Description<\/span><\/h4><p>The app contains/);
  assert.equal((html.match(/Issue Description/g) || []).length, 1);
  assert.match(html, /<\/p><h4>Next Steps<\/h4><p>Please attach documentary evidence\.<\/p>/);
  assert.doesNotMatch(html, /<br>/);
});

test("separate guideline issues stay paired without merging their paragraphs", () => {
  const context = load(renderer, ["appStoreReviewPlainText", "appStoreReviewMessageHTML"], { escapeHTML: s => String(s) });
  const html = context.appStoreReviewMessageHTML({ body: 'Guideline 5.2.3 - Legal\nIssue Description\nFirst issue.\n\nGuideline 2.1 - Performance\nIssue Description\nSecond issue.' });
  assert.equal((html.match(/app-review-issue-heading/g) || []).length, 2);
  assert.match(html, /<p>First issue\.<\/p><h4/);
  assert.match(html, /<p>Second issue\.<\/p>/);
});
