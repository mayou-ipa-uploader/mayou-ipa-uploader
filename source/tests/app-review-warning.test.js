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

const original = `Hello,
Thank you for submitting an update to the app, 新版速记单词王, for review.
Review Environment
Submission ID: current-submission
Review date: October 12, 2026
Review Device: iPad Air 11-inch (M3)
Version reviewed: 1.0.1 (1011)
Guideline 5.2.3 - Legal
Issue Description
The app provides potentially unauthorized access to third-party audio or video streaming, catalogs, and discovery services.
Next Steps
Please attach documentary evidence.
Resources
- Review guideline 5.2.3 for more information.
Support
- Reply to this message in your preferred language.`;
const submission = { id: "current-submission", submittedDate: "2026-10-11T00:00:00Z", version: { id: "version-a" }, items: [{ id: "item-a", relatedId: "version-a", state: "REJECTED" }] };
const currentMessage = { id: "message-a", author: "Apple", createdDate: "2026-10-12T08:00:00Z", body: original };
const historical = ["3.1.1", "2.5.4", "2.1.0", "5.2.3"].map(reasonCode => ({ reasonCode, reasonDescription: "Historical category", text: `${reasonCode} Historical category` }));
function context(extra = {}) {
  return load(main, ["reviewMessageGuidelineReasons", "latestReviewGuidelineReasons", "loadAppStoreVersionReviewWarning"], {
    loadReviewSubmissionThreads: async () => [{ id: "current-thread", threadType: "REJECTION_REVIEW_SUBMISSION", messages: [currentMessage] }],
    loadReviewRejectionsForThreads: async () => [{ id: "old-categories", relatedIds: ["version-a"], reasons: historical }],
    loadResolutionCenterThreadMessages: async () => [currentMessage],
    ...extra,
  });
}
test("the reported Apple message produces exactly one 5.2.3 rejection in the red banner", async () => {
  const c = context({ loadReviewRejectionsForThreads: () => assert.fail("readable current rejection must not merge historical categories") });
  const warning = await c.loadAppStoreVersionReviewWarning("app-a", "version-a", [submission]);
  assert.deepEqual(Array.from(warning.reasons, row => row.text), ["5.2.3 Legal"]);
  load(renderer, ["renderAppStoreReviewWarning", "appStoreReviewReasonText"], Object.assign(c, { appStoreVersionStatus: () => "REJECTED", escapeHTML: String }));
  const html = c.renderAppStoreReviewWarning({ reviewWarning: warning });
  assert.equal((html.match(/<li>/g) || []).length, 1);
  assert.match(html, /5\.2\.3 Legal/);
  assert.doesNotMatch(html, /3\.1\.1|2\.5\.4|2\.1\.0/);
  assert.match(html, /data-review-submission-id="current-submission"/);
});
test("multiple actual headings are retained and resource links and general advice are excluded", () => {
  const c = context();
  const body = "Guideline 2.1 - Performance\nIssue Description\nBroken UI\nResources\n- Review guideline 2.1 for more information\nGuideline 5.2.3 - Legal\nGuideline 5.2.3 - Legal\nPrevent Common Issues\nGuideline 3.1.1 - Advice";
  assert.deepEqual(Array.from(c.reviewMessageGuidelineReasons({ body }), row => row.reasonCode), ["2.1", "5.2.3"]);
  assert.equal(c.reviewMessageGuidelineReasons({ body: "Resources\n- Review guideline 5.2.3 for more information" }).length, 0);
  assert.deepEqual(Array.from(c.reviewMessageGuidelineReasons({ body: "<h3>Guideline 5.2.3 &nbsp;— Legal</h3><p>Issue</p>" }), row => row.reasonCode), ["5.2.3"]);
});
test("latest Apple rejection ignores historical submissions and developer replies", () => {
  const c = context();
  const summary = c.latestReviewGuidelineReasons([
    { ...currentMessage, createdDate: "2026-10-10T00:00:00Z", body: "Guideline 3.1.1 - Old" },
    currentMessage,
    { ...currentMessage, createdDate: "2026-10-12T09:00:00Z", author: "Developer", body: "Guideline 2.1 - Developer quotation" },
    { ...currentMessage, createdDate: "2026-10-12T10:00:00Z", body: "Submission ID: other-submission\nGuideline 2.5.4 - Other" },
    { ...currentMessage, createdDate: "2026-10-12T11:00:00Z", body: "Thank you for your reply." },
  ], submission);
  assert.equal(summary.message.id, "message-a");
  assert.equal(summary.reasons[0].reasonCode, "5.2.3");
});
test("version fallback reads only the newest relevant rejection thread", async () => {
  const reads = [];
  const c = context({
    loadReviewSubmissionThreads: async () => [],
    appStoreConnectFetch: async () => ({ body: { data: [
      { id: "old", threadType: "REJECTION_BINARY", createdDate: "2026-10-10T00:00:00Z" },
      { id: "latest", threadType: "REJECTION_BINARY", createdDate: "2026-10-12T00:00:00Z" },
      { id: "foreign", submissionId: "other-submission", createdDate: "2026-10-13T00:00:00Z" },
    ] } }), jsonApiRows: body => body.data, normalizeReviewThread: row => row,
    loadResolutionCenterThreadMessages: async id => { reads.push(id); return [currentMessage]; },
  });
  const warning = await c.loadAppStoreVersionReviewWarning("app-a", "version-a", [submission]);
  assert.deepEqual(reads, ["latest"]);
  assert.equal(warning.reasons.length, 1);
});
test("unreadable current messages do not combine ambiguous rejection history", async () => {
  const c = context({ loadReviewSubmissionThreads: async () => [{ id: "current-thread", messages: [] }], loadResolutionCenterThreadMessages: async () => [], loadReviewRejectionsForThreads: async () => [{ id: "old", reasons: historical }, { id: "new", reasons: [] }] });
  const warning = await c.loadAppStoreVersionReviewWarning("app-a", "version-a", [submission]);
  assert.equal(warning.isRejected, true);
  assert.equal(warning.reasons.length, 0);
});
test("a single scoped rejection remains the fallback when its message is unavailable", async () => {
  const c = context({ loadReviewSubmissionThreads: async () => [{ id: "current-thread", messages: [] }], loadResolutionCenterThreadMessages: async () => [], loadReviewRejectionsForThreads: async () => [{ id: "new", relatedIds: ["version-a"], reasons: [historical[3]], attachments: [{ id: "attachment-a" }] }] });
  const warning = await c.loadAppStoreVersionReviewWarning("app-a", "version-a", [submission]);
  assert.equal(warning.reasons.length, 1);
  assert.equal(warning.attachments[0].id, "attachment-a");
});
test("non-rejected items need no warning requests", async () => {
  const c = context({ loadReviewSubmissionThreads: () => assert.fail("no warning request") });
  assert.equal(await c.loadAppStoreVersionReviewWarning("app-a", "version-a", [{ ...submission, items: [{ relatedId: "version-a", state: "READY_FOR_REVIEW" }] }]), null);
});
test("review-message footer prefers its actual headings over broad structured categories", () => {
  const c = context({ jsonApiRows: body => [body.data], relationshipData: (row, key) => row.relationships?.[key]?.data ? [row.relationships[key].data] : [], findIncluded: (body, type, id) => body.included?.find(row => row.type === type && row.id === id), normalizeReviewMessageActor: () => "Apple" });
  load(main, ["reviewMessageText", "normalizeReviewThreadMessages"], c);
  const messages = c.normalizeReviewThreadMessages({ data: { id: "message-a", attributes: { messageBody: original, guideline: "3.1.1; 2.5.4; 2.1.0; 5.2.3" }, relationships: { rejections: { data: { id: "rejection-a", type: "reviewRejections" } } } }, included: [{ type: "reviewRejections", id: "rejection-a", attributes: { reasons: historical } }] });
  assert.equal(messages[0].guideline, "5.2.3 Legal");
  assert.equal(messages[0].body, original);
});
test("submission thread lookup stops at the first usable endpoint and never treats messages as threads", async () => {
  const calls = [];
  const c = load(main, ["loadReviewSubmissionThreads"], {
    reviewThreadRefsFromBody: () => [], findIncluded: () => null,
    appStoreConnectFetch: async url => { calls.push(url); return { body: { data: [{ type: "resolutionCenterMessages", id: "message-a" }] } }; },
    normalizeReviewMessagesFromBody: () => [currentMessage], jsonApiRows: body => body.data,
    normalizeReviewThread: row => row,
  });
  const threads = await c.loadReviewSubmissionThreads("current-submission");
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(threads, row => row.id), ["direct-current-submission"]);
});
