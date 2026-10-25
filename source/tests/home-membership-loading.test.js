"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const account = id => ({ success: true, account: { name: `Member ${id}`, appleId: `${id}@example.com` }, selectedTeamId: id, teams: [{ id, name: `Team ${id}`, status: "active" }] });

function rendererContext(fetch) {
  const timers = new Map();
  const frames = [];
  const context = {
    authenticated: true,
    homeOverviewGeneration: 0,
    homeStatusLoading: false,
    homeAccountInfoPromise: null,
    homeAccountInfo: null,
    homeTermsStatus: null,
    homeDeveloperAgreementStatus: null,
    homeBusinessStatus: null,
    launchAppleId: "current@example.com",
    homeOverviewCache: Object.fromEntries(["terms", "developerAgreement", "business", "account"].map(key => [key, { loaded: false, failed: false, loading: false }])),
    window: { appleDeveloper: { accountInfo: fetch } },
    setTimeout: (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    escapeHTML: value => String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    formatAccountDate: value => value || "—",
    accountStatusText: value => value || "—",
    readAppStoreTermsStatus: async () => ({ success: true }),
    readDeveloperAgreementStatus: async () => ({ success: true }),
    warmAppStoreBusinessStatus: async () => ({ success: true }),
    refreshAccess: async () => false,
    cacheAppStoreBusinessStatus() {},
    syncHomeTaxStateFromBusiness() {},
    applyStatus: status => { context.authenticated = status.authenticated; },
    applyTopAccountStatus() {},
    el: () => null,
    renderHomePage: () => frames.push(context.renderHomeMembershipDetails()),
    timers,
    frames,
  };
  const helpers = renderer.slice(renderer.indexOf("async function loadHomeAccountInfo("), renderer.indexOf("function defaultHomeTaxState()"));
  const membership = renderer.slice(renderer.indexOf("function homeMembershipTeam()"), renderer.indexOf("function formatHomeComplianceDate("));
  const overview = renderer.slice(renderer.indexOf("function resetHomeOverviewCache()"), renderer.indexOf("function bindHomeEvents()"));
  const topAccount = renderer.slice(renderer.indexOf("async function refreshTopDeveloperAccount()"), renderer.indexOf("function applyAccess("));
  vm.runInNewContext(`${helpers}\n${membership}\n${overview}\n${topAccount}`, context);
  return context;
}

test("a hanging membership request stops the spinner and can be retried while business is still loading", async () => {
  let calls = 0;
  let finishLate;
  let finishBusiness;
  const context = rendererContext(() => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finishLate = resolve; }) : Promise.resolve(account("new"));
  });
  context.warmAppStoreBusinessStatus = () => new Promise(resolve => { finishBusiness = resolve; });
  const overview = context.loadHomeOverview();
  await flush();
  assert.match(context.frames.at(-1), /home-membership-loading/);
  const deadline = [...context.timers.values()][0];
  assert.equal(deadline.ms, 20000);
  deadline.callback();
  await flush();
  assert.equal(context.homeStatusLoading, true);
  assert.equal(context.homeOverviewCache.account.loading, false);
  assert.equal(context.homeOverviewCache.account.failed, true);
  assert.match(context.frames.at(-1), /读取超时.*retry-membership/);
  assert.doesNotMatch(context.frames.at(-1), /loading-spinner/);
  assert.equal(context.homeAccountInfoPromise, null);

  await context.refreshHomeMembershipDetails();
  assert.equal(calls, 2);
  assert.equal(context.homeOverviewCache.account.failed, false);
  assert.match(context.frames.at(-1), /Member new/);
  finishLate(account("old"));
  finishBusiness({ success: true });
  await overview;
  assert.equal(context.homeAccountInfo.selectedTeamId, "new");
  assert.equal(context.timers.size, 0);
});

test("simultaneous home and top-account readers share one request and successful data can be reused", async () => {
  let calls = 0;
  let finish;
  const context = rendererContext(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const overview = context.loadHomeOverview();
  const topAccount = context.refreshTopDeveloperAccount();
  await flush();
  assert.equal(calls, 1);
  finish(account("shared"));
  await Promise.all([overview, topAccount]);
  assert.equal(context.launchAppleId, "shared@example.com");
  assert.equal((await context.loadHomeAccountInfo()).selectedTeamId, "shared");
  assert.equal(calls, 1);
  assert.equal(context.timers.size, 0);
});

test("a failed refresh keeps previous membership details and the next retry replaces them", async () => {
  let succeed = false;
  const context = rendererContext(async () => succeed ? account("fresh") : { success: false, error: "网络不可用" });
  context.homeAccountInfo = account("cached");
  context.homeOverviewCache.account.loaded = true;
  await context.refreshHomeMembershipDetails();
  assert.match(context.frames[0], /更新中.*Member cached/s);
  assert.match(context.frames.at(-1), /更新失败.*网络不可用.*retry-membership.*Member cached/s);
  succeed = true;
  await context.refreshHomeMembershipDetails();
  assert.match(context.frames.at(-1), /Member fresh/);
  assert.doesNotMatch(context.frames.at(-1), /更新失败|网络不可用|Member cached/);
});

test("account or team resets allow a new load and prevent old requests from changing its state", async () => {
  const finishes = [];
  const context = rendererContext(() => new Promise(resolve => finishes.push(resolve)));
  const oldOverview = context.loadHomeOverview();
  const oldTopAccount = context.refreshTopDeveloperAccount();
  await flush();
  context.resetHomeOverviewCache();
  context.homeAccountInfo = null;
  const newOverview = context.loadHomeOverview();
  await flush();
  const newPromise = context.homeAccountInfoPromise;
  assert.equal(finishes.length, 2);
  finishes[0](account("old"));
  await Promise.all([oldOverview, oldTopAccount]);
  assert.equal(context.homeStatusLoading, true);
  assert.equal(context.homeOverviewCache.account.loading, true);
  assert.equal(context.homeAccountInfo, null);
  assert.equal(context.launchAppleId, "current@example.com");
  assert.equal(context.homeAccountInfoPromise, newPromise);
  finishes[1](account("current"));
  await newOverview;
  assert.equal(context.homeStatusLoading, false);
  assert.match(context.frames.at(-1), /Member current/);
  assert.equal(context.timers.size, 0);
});

test("an IPC exception becomes a retryable error instead of leaving the loading state active", async () => {
  const context = rendererContext(() => { throw new Error("IPC unavailable <script>"); });
  await context.loadHomeOverview();
  assert.equal(context.homeStatusLoading, false);
  assert.match(context.frames.at(-1), /读取失败.*IPC unavailable &lt;script&gt;.*retry-membership/);
  assert.doesNotMatch(context.frames.at(-1), /loading-spinner/);
  assert.equal(context.timers.size, 0);
});

function mainContext(fetch) {
  let handler;
  const deadlines = [];
  const partitions = [];
  const context = {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    appleDeveloperAccountKey: "account-a",
    appleDeveloperContextGeneration: 1,
    appleDeveloperAuthenticated: true,
    appleDeveloperLaunchAppleId: "member@example.com",
    appleDeveloperContextIsCurrent: (generation, key) => generation === context.appleDeveloperContextGeneration && key === context.appleDeveloperAccountKey,
    readAppleDeveloperStatus: async () => { throw new Error("authenticated requests must not repeat login validation"); },
    readSelectedAppleDeveloperTeam: () => ({ id: "TEAM" }),
    appleDeveloperPartitionForAccount: key => `partition:${key}`,
    session: { fromPartition: partition => { partitions.push(partition); return { fetch }; } },
    AbortSignal: { timeout: ms => { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; } },
    appleDeveloperServiceError: body => body.resultString || "",
    deadlines,
    partitions,
  };
  const normalize = main.slice(main.indexOf("function normalizeAppleDeveloperTeamDetails("), main.indexOf("function appleDeveloperDeviceRenewalRequired("));
  const source = main.slice(main.indexOf('ipcMain.handle("apple-developer-account-info",'), main.indexOf("function normalizeAppleAgreement("));
  vm.runInNewContext(`${normalize}\n${source}`, context);
  context.handler = handler;
  return context;
}

const teamResponse = () => Response.json({ teams: [{ teamId: "TEAM", name: "Example Org", status: "active", entityType: "c", program: { name: "Apple Developer Program", dateExpires: 1800000000000, autoRenewPrice: "¥688" }, userRoles: ["Account Holder"] }] });

test("a user-profile failure still returns complete membership data from the current account partition", async () => {
  const context = mainContext(async url => url.endsWith("getTeams") ? teamResponse() : Response.json({ resultCode: 500, resultString: "Profile unavailable" }, { status: 503 }));
  const result = await context.handler();
  assert.equal(result.success, true);
  assert.equal(result.account.appleId, "member@example.com");
  assert.equal(result.teams[0].expirationDate, 1800000000000);
  assert.equal(result.teams[0].fee, "¥688");
  assert.equal(result.teams[0].identityType, "组织");
  assert.deepEqual([...result.teams[0].roles], ["Account Holder"]);
  assert.deepEqual(context.partitions, ["partition:account-a"]);
  assert.deepEqual(context.deadlines.map(value => value.ms), [12000, 6000]);
});

test("a profile timeout cannot turn a successful membership response into an error", async () => {
  const context = mainContext((url, options) => url.endsWith("getTeams") ? Promise.resolve(teamResponse()) : new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))));
  const pending = context.handler();
  const deadline = context.deadlines.find(value => value.ms === 6000);
  deadline.controller.abort(new DOMException("Profile timed out", "TimeoutError"));
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.teams[0].id, "TEAM");
});

test("team errors and login HTML return a useful error instead of pretending there are no memberships", async () => {
  for (const response of [
    () => Response.json({ resultCode: 42, resultString: "Team denied" }, { status: 403 }),
    () => new Response("<html>Login</html>"),
  ]) {
    const context = mainContext(async url => url.endsWith("getTeams") ? response() : Response.json({ userProfile: {} }));
    const result = await context.handler();
    assert.equal(result.success, false);
    assert.match(result.error, /Team denied|未返回有效资料/);
  }
});

test("team network timeout reports a retryable message", async () => {
  const context = mainContext(async url => {
    if (url.endsWith("getTeams")) throw new DOMException("Timed out", "TimeoutError");
    return Response.json({ userProfile: {} });
  });
  const result = await context.handler();
  assert.equal(result.success, false);
  assert.match(result.error, /会员信息读取超时.*重试/);
});

test("an unauthenticated request validates login before requesting membership data", async () => {
  const context = mainContext(() => { throw new Error("expired login must not read membership data"); });
  context.appleDeveloperAuthenticated = false;
  context.readAppleDeveloperStatus = async () => ({ authenticated: false });
  const result = await context.handler();
  assert.equal(result.authenticated, false);
  assert.deepEqual(context.partitions, []);
});

test("a response from an old account is discarded after an account switch", async () => {
  let finish;
  const context = mainContext(url => url.endsWith("getTeams") ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(Response.json({ userProfile: { email: "old@example.com" } })));
  const pending = context.handler();
  context.appleDeveloperAccountKey = "account-b";
  context.appleDeveloperContextGeneration++;
  finish(teamResponse());
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.stale, true);
  assert.equal(result.account, undefined);
});
