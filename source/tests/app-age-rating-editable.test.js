"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
function functionSource(name) {
  const start = main.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = main.slice(start + 1).search(/\n(?:async )?function /);
  return main.slice(start, next < 0 ? main.length : start + 1 + next);
}

// Minimal records matching the HAR: published first, editable draft second.
function appInfo(id, state, appId = "app-a") {
  return {
    type: "appInfos", id,
    attributes: { state, appStoreState: state === "READY_FOR_DISTRIBUTION" ? "READY_FOR_SALE" : state },
    relationships: {
      app: { data: { type: "apps", id: appId } },
      ageRatingDeclaration: { data: { type: "ageRatingDeclarations", id: `rating-${id}` } },
    },
  };
}
const published = () => appInfo("published", "READY_FOR_DISTRIBUTION");
const draft = () => appInfo("draft", "PREPARE_FOR_SUBMISSION");
const answers = { advertising: false, ageRatingOverrideV2: "NONE", kidsAgeBand: null, developerAgeRatingInfoUrl: null };
function body(rows = [published(), draft()], saved = false) {
  return {
    data: rows,
    included: rows.map(row => ({
      type: "ageRatingDeclarations", id: `rating-${row.id}`,
      attributes: saved && row.id === "draft" ? { ...answers } : { ...answers, advertising: true },
    })),
  };
}
function context(fetch) {
  const ctx = vm.createContext({
    appStoreConnectFetch: async () => { throw new Error("save must use the fixed account context"); },
    appStoreConnectMutationFetch: () => fetch,
    setTimeout: callback => callback(),
    normalizeTerritoryAgeRatings: response => response.data,
  });
  const constants = main.slice(main.indexOf("const APP_STORE_AGE_RATING_ATTRIBUTE_NAMES"), main.indexOf("function appStoreAgeRatingAttributes"));
  const names = ["jsonApiRows", "jsonApiIncluded", "relationshipData", "findIncluded", "normalizeAppInfoLocalization", "normalizeAppInfo",
    "appStoreAppInfoIsEditable", "selectAppStoreAppInfo", "appStoreAgeRatingAttributes",
    "loadAppStoreConnectAgeRatingAppInfo", "loadAppStoreConnectAgeRating", "saveAppStoreConnectAgeRating"];
  vm.runInContext(constants + names.map(functionSource).join("\n"), ctx);
  return ctx;
}
function payload(appInfoId = "draft") {
  return { appId: "app-a", appInfoId, ageRatingDeclarationId: `rating-${appInfoId}`, attributes: answers };
}

test("App information selects the editable draft regardless of Apple's response order", () => {
  const ctx = context();
  for (const rows of [[published(), draft()], [draft(), published()]]) {
    assert.equal(ctx.selectAppStoreAppInfo(rows).id, "draft");
    assert.equal(ctx.selectAppStoreAppInfo(rows, "published").id, "draft");
  }
  assert.equal(ctx.selectAppStoreAppInfo([published()]).id, "published", "published information remains available for display");
  const detail = functionSource("loadAppStoreConnectAppDetail");
  assert.match(detail, /const appInfo = selectAppStoreAppInfo\(appInfos\)/);
});

for (const selected of ["draft"]) {
  test(`saving from ${selected} patches only the editable declaration and reads back that same record`, async () => {
    const requests = [];
    let saved = false;
    const ctx = context(async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === "PATCH") {
        assert.equal(url, "/iris/v1/ageRatingDeclarations/rating-draft");
        const data = JSON.parse(options.body).data;
        assert.deepEqual(data, { type: "ageRatingDeclarations", id: "rating-draft", attributes: answers });
        saved = true;
        return { body: {} };
      }
      if (url.includes("territoryAgeRatings")) {
        assert.match(url, /appInfos\/draft\/territoryAgeRatings/);
        return { body: { data: [{ territoryId: "USA", appStoreAgeRating: "FOUR_PLUS" }] } };
      }
      return { body: body(saved ? [draft(), published()] : [published(), draft()], saved) };
    });
    const result = await ctx.saveAppStoreConnectAgeRating(payload(selected));
    assert.equal(result.appInfo.id, "draft");
    assert.equal(result.appInfo.ageRatingDeclarationId, "rating-draft");
    assert.equal(requests.length, 4, "one preflight, one PATCH, two age-only refresh requests");
  });
}

test("a foreign app, missing App info, or mismatched declaration never triggers a PATCH", async () => {
  for (const [response, change] of [
    [body(), { ageRatingDeclarationId: "rating-published" }],
    [body(), { appInfoId: "missing" }],
    [body([appInfo("draft", "PREPARE_FOR_SUBMISSION", "other-app")]), {}],
  ]) {
    let writes = 0;
    const ctx = context(async (_url, options = {}) => { if (options.method) writes++; return { body: response }; });
    await assert.rejects(ctx.saveAppStoreConnectAgeRating({ ...payload(), ...change }), /不匹配|未返回/);
    assert.equal(writes, 0);
  }
});

test("a published-only App reports that it is not editable without attempting a write", async () => {
  let writes = 0;
  const ctx = context(async (_url, options = {}) => { if (options.method) writes++; return { body: body([published()]) }; });
  await assert.rejects(ctx.saveAppStoreConnectAgeRating(payload("published")), /不可编辑/);
  assert.equal(writes, 0);
});

test("an old page referencing the published record must be reopened before saving draft answers", async () => {
  let writes = 0;
  const ctx = context(async (_url, options = {}) => { if (options.method) writes++; return { body: body() }; });
  await assert.rejects(ctx.saveAppStoreConnectAgeRating(payload("published")), /重新打开 App 信息页面/);
  assert.equal(writes, 0);
});

test("readback does not fall back to the published record if the draft disappears", async () => {
  let saved = false;
  let writes = 0;
  const ctx = context(async (_url, options = {}) => {
    if (options.method) { writes++; saved = true; }
    return { body: body(saved ? [published()] : [published(), draft()]) };
  });
  await assert.rejects(ctx.saveAppStoreConnectAgeRating(payload()), /未返回/);
  assert.equal(writes, 1);
});

test("stale readback is retried at most three times and never reported as saved or PATCHed again", async () => {
  let writes = 0;
  let reads = 0;
  const ctx = context(async (url, options = {}) => {
    if (options.method) { writes++; return { body: {} }; }
    if (url.includes("territoryAgeRatings")) return { body: { data: [{ territoryId: "USA" }] } };
    reads++;
    return { body: body() };
  });
  await assert.rejects(ctx.saveAppStoreConnectAgeRating(payload()), /暂未确认最新结果/);
  assert.equal(writes, 1);
  assert.equal(reads, 4, "preflight plus three readback attempts");
});

test("preflight and Apple PATCH errors stop saving without retrying the write", async () => {
  for (const failingMethod of [undefined, "PATCH"]) {
    let writes = 0;
    const ctx = context(async (_url, options = {}) => {
      if (options.method) writes++;
      if (options.method === failingMethod) throw new Error("Apple request failed");
      return { body: body() };
    });
    await assert.rejects(ctx.saveAppStoreConnectAgeRating(payload()), /Apple request failed/);
    assert.equal(writes, failingMethod ? 1 : 0);
  }
});
