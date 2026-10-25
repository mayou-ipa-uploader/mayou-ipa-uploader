const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const variants = [
  ["browser", path.join(__dirname, "../src")],
  ["standalone", path.join(__dirname, "../src")],
];

function source(root, name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("个人未签署 W-8BEN 与已签署表单按服务端状态区分，公司使用 W-8BEN-E", () => {
  const renderer = source(variants[0][1], "certificate-manager.js");
  const taxFunctions = renderer.slice(renderer.indexOf("function homeTaxW8FormTypeForAccount"), renderer.indexOf("function realTaxCountries"));
  const survey = { taxFormType: "USA_FOREIGN_ENTITY_QUESTIONNAIRE", raw: { taxFormQuestionnaire: { taxFormTypes: ["USA_1042S", "USA_W8BEN"] } } };
  const state = {
    added: true, selectedJurisdictions: ["US"], usSurveyComplete: false, usTaxFormTypes: [],
    w8ben: { submitted: true }, usa1042: { submitted: true },
  };
  const business = {
    success: true, legalEntity: { isOrganization: false }, taxFormsLoaded: true,
    taxCountries: [{ country: "USA", isSelected: true }],
    taxRequirements: [{ taxFormType: "USA_FOREIGN_ENTITY_QUESTIONNAIRE", childTaxFormTypes: ["USA_1042S", "USA_W8BEN"] }],
    taxForms: [{ taxFormType: "USA_1042S", taxStatus: "ACTIVE" }, survey],
  };
  const context = {
    homeTaxState: state, homeBusinessStatus: business,
    activateHomeTaxStateScope() {}, saveHomeTaxState() {},
    taxStateCodeForCountry: () => "US", homeTaxJurisdictions: () => new Set(["US"]),
  };
  vm.runInNewContext(taxFunctions, context);
  context.syncHomeTaxStateFromBusiness();
  assert.equal(state.w8ben.submitted, false);
  assert.equal(context.homeTaxRows().find(row => row.id === "w8ben")?.statusText, "缺少税务信息");
  assert.equal(context.homeTaxRows().some(row => row.id === "w8bene"), false);

  business.taxForms.push({ taxFormType: "USA_W8BEN", taxStatus: "ACTIVE", isSubmitted: true });
  context.syncHomeTaxStateFromBusiness();
  assert.equal(state.w8ben.submitted, true);
  assert.equal(context.homeTaxRows().find(row => row.id === "w8ben")?.statusText, "使用中");

  business.legalEntity.isOrganization = true;
  survey.raw.taxFormQuestionnaire.taxFormTypes.push("USA_W8BENE");
  context.syncHomeTaxStateFromBusiness();
  assert.equal(state.w8ben.submitted, false);
  assert.equal(context.homeTaxRows().some(row => row.id === "w8ben"), false);
  assert.equal(context.homeTaxRows().find(row => row.id === "w8bene")?.statusText, "缺少税务信息");
});

test("个人未签署 W-8BEN 的可编辑字段和认证可操作，ACTIVE 表单锁定", () => {
  const renderer = source(variants[0][1], "certificate-manager.js");
  const editable = renderer.slice(renderer.indexOf("function homeTaxMetadataFieldEditable"), renderer.indexOf("function homeTax1042BeneficialTypeValue"));
  const render = renderer.slice(renderer.indexOf("function renderHomeTaxDetailPage"), renderer.indexOf("function closeHomeTaxNicknameDialog"));
  const constraints = Object.fromEntries(["taxpayerNumber", "foreignTaxId", "certify9a", "mailingAddress", "useIncomeTypeOther"].map((attribute, index) => [String(index), { attributeName: `taxFormUsaW8Ben.${attribute}`, isEditable: true }]));
  constraints.name = { attributeName: "taxFormUsaW8Ben.name", required: true };
  const context = {
    homeTaxState: { w8ben: { name: "Sample", country: "中国大陆", submitted: false } },
    homeTaxW8Metadata: { taxFormType: "USA_W8BEN", data: { taxFormUsaW8Ben: { name: "Sample" } }, raw: { constraints } },
    homeTaxW8MetadataLoading: false, homeTaxW8MetadataError: "",
    homeTaxDetailOpen: "w8ben", homeBusinessStatus: { provider: { id: "account" } },
    defaultHomeTaxState: () => ({ w8ben: {} }),
    homeTaxAddressLinesFrom: () => "address", renderHomeTaxNickNameMeta: () => "",
    escapeHTML: value => String(value ?? ""),
  };
  vm.runInNewContext(editable + render, context);
  const page = { innerHTML: "" };
  const tag = (field, kind = "field") => page.innerHTML.match(new RegExp(`<input[^>]*data-home-tax-${kind}="${field}"[^>]*>`))?.[0] || "";
  const metadata = context.homeTaxW8Metadata;
  context.homeTaxW8Metadata = null;
  context.homeTaxW8MetadataLoading = true;
  context.renderHomeTaxDetailPage(page);
  assert.match(page.innerHTML, /正在读取 Apple 税务表及可编辑字段/);
  assert.match(tag("tin"), /\bdisabled\b/);
  context.homeTaxW8MetadataLoading = false;
  context.homeTaxW8MetadataError = "接口暂时不可用";
  context.renderHomeTaxDetailPage(page);
  assert.match(page.innerHTML, /接口暂时不可用/);
  assert.match(page.innerHTML, /data-home-tax-action="retry-w8-metadata"/);
  context.homeTaxW8Metadata = metadata;
  context.homeTaxW8MetadataError = "";
  context.renderHomeTaxDetailPage(page);
  assert.match(page.innerHTML, /表单已就绪/);
  assert.match(tag("name"), /\bdisabled\b/);
  assert.doesNotMatch(tag("tin"), /\bdisabled\b/);
  assert.doesNotMatch(tag("foreignTaxId"), /\bdisabled\b/);
  assert.doesNotMatch(tag("line9", "check"), /\bdisabled\b/);
  assert.doesNotMatch(tag("certificationPrimary", "check"), /\bdisabled\b/);
  context.homeTaxState.w8ben.certificationPrimary = true;
  context.renderHomeTaxDetailPage(page);
  assert.doesNotMatch(page.innerHTML.match(/<button[^>]*data-home-tax-action="submit-w8"[^>]*>/)?.[0] || "", /\bdisabled\b/);
  context.homeTaxState.w8ben.submitted = true;
  context.homeTaxW8Metadata.data.taxStatus = "ACTIVE";
  context.renderHomeTaxDetailPage(page);
  assert.match(tag("tin"), /\bdisabled\b/);
  assert.match(tag("line9", "check"), /\bdisabled\b/);
  assert.match(tag("certificationPrimary", "check"), /\bdisabled\b/);
});

test("W-8BEN 保存前复查签署状态，并拒绝重复及并发提交", async () => {
  const main = source(variants[0][1], "main.js");
  const saveHandlerSource = main.slice(
    main.indexOf("const pendingTaxFormSubmissions = new Set();"),
    main.indexOf('ipcMain.handle("app-store-connect-delete-tax-form"'),
  );
  let handler;
  let forms = [];
  let failRead = false;
  let releaseRead;
  let scope = "scope";
  const methods = [];
  vm.runInNewContext(saveHandlerSource, {
    ipcMain: { handle(_name, fn) { handler = fn; } },
    appleDeveloperRecordId: "record",
    fetchAppStoreConnectCurrentProvider: async () => ({ id: "account" }),
    appStoreConnectTaxContext: async () => ({ accountId: "account", vendorId: "vendor", vendorScopeId: scope, legalEntityId: "entity" }),
    appStoreConnectBusinessFetch: async (_accountId, _path, options = {}) => {
      const method = options.method || "GET";
      methods.push(method);
      if (method === "POST") return { body: {} };
      if (failRead) throw new Error("税表读取失败");
      if (releaseRead) await new Promise(resolve => { releaseRead = resolve; });
      return { body: { data: forms } };
    },
  });
  const payload = { taxFormType: "USA_W8BEN", formData: { taxFormType: "USA_W8BEN", optimisticLock: "version" } };

  forms = [{ taxFormType: "USA_W8BEN", taxStatus: "ACTIVE" }];
  const signed = await handler(null, payload);
  assert.equal(signed.alreadySubmitted, true);
  assert.match(signed.error, /已提交/);
  assert.deepEqual(methods, ["GET"]);

  forms = [{ taxFormType: "USA_1042S", taxStatus: "ACTIVE" }];
  scope = "unsigned";
  assert.equal((await handler(null, payload)).success, true);
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
  assert.equal((await handler(null, payload)).alreadySubmitted, true);
  assert.deepEqual(methods, ["GET", "GET", "POST"]);

  scope = "read-failure";
  failRead = true;
  assert.match((await handler(null, payload)).error, /税表读取失败/);
  assert.deepEqual(methods, ["GET", "GET", "POST", "GET"]);
  failRead = false;

  scope = "concurrent";
  releaseRead = true;
  const first = handler(null, payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.match((await handler(null, payload)).error, /正在提交/);
  releaseRead();
  assert.equal((await first).success, true);

  const renderer = source(variants[0][1], "certificate-manager.js");
  const submit = renderer.slice(renderer.indexOf('page.querySelector(\'[data-home-tax-action="submit-w8"]\')?.addEventListener'), renderer.indexOf("function homeNeedsTaxForm"));
  assert.ok(submit.indexOf("homeTaxW8IsSubmitted(validation.data)") < submit.indexOf("const result = await window.appleDeveloper.saveAppStoreTaxForm"));
  assert.match(submit, /if \(result\?\.alreadySubmitted\) \{\s*w8\.submitted = true/);
  assert.match(renderer, /async function refreshHomeBusinessAfterTaxSubmit\(\) \{\s*if \(appStoreBusinessStatusPromise\) await appStoreBusinessStatusPromise;\s*const result = await warmAppStoreBusinessStatus\(\{ force: true \}\)/);
});

test("税表提交后等待旧请求并用新商务数据重绘首页协议列表", async () => {
  const renderer = source(variants[0][1], "certificate-manager.js");
  const refreshSource = renderer.slice(
    renderer.indexOf("async function refreshHomeBusinessAfterTaxSubmit"),
    renderer.indexOf("function ensureHomeTaxAddDialog"),
  );
  let finishOldRequest;
  const oldRequest = new Promise(resolve => { finishOldRequest = resolve; });
  const freshStatus = { success: true, businessAgreements: [{ title: "已更新协议" }], taxForms: [{ taxFormType: "USA_W8BEN", taxStatus: "ACTIVE" }] };
  const calls = [];
  const rendered = [];
  const context = {
    homeTaxDetailOpen: "w8ben",
    appStoreBusinessStatusPromise: oldRequest,
    homeBusinessStatus: { success: true, businessAgreements: [{ title: "旧协议" }] },
    homeOverviewCache: { business: { loaded: false, failed: true } },
    warmAppStoreBusinessStatus: async options => { calls.push(options.force); return freshStatus; },
    homeOverviewResultFailed: result => !result?.success,
    syncHomeTaxStateFromBusiness: () => { calls.push("sync"); },
    renderHomePage: () => { rendered.push(context.homeBusinessStatus.businessAgreements[0].title); },
    console,
    alert: () => { throw new Error("不应提示刷新失败"); },
  };
  vm.runInNewContext(refreshSource, context);
  const refreshing = context.returnHomeAfterTaxSubmit();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.deepEqual(rendered, ["旧协议"]);
  assert.equal(context.homeOverviewCache.business.loading, true);
  finishOldRequest();
  await refreshing;
  assert.equal(context.homeTaxDetailOpen, false);
  assert.deepEqual(calls, [true, "sync"]);
  assert.deepEqual(rendered, ["旧协议", "已更新协议"]);
  assert.equal(context.homeOverviewCache.business.loaded, true);
  assert.equal(context.homeOverviewCache.business.failed, false);
  assert.equal(context.homeOverviewCache.business.loading, false);
});

for (const [variant, root] of variants) {
  test(`${variant}: 税务接口使用 vendorId 与 vendorScopeId`, () => {
    const main = source(root, "main.js");
    assert.match(main, /vendorScopeId: String\(vendorScopes\[0\]\?\.vendorScopeId/);
    assert.match(main, /vendors\/\$\{encodeURIComponent\(taxVendorId\)\}\/vendorScopes\/\$\{encodeURIComponent\(taxVendorScopeId\)\}\/taxForms/);
    const handlers = main.slice(main.indexOf('ipcMain.handle("app-store-connect-tax-questionnaire-metadata"'), main.indexOf('ipcMain.handle("app-store-connect-bank-metadata"'));
    assert.match(main, /async function appStoreConnectTaxContext/);
    assert.match(main, /appStoreConnectBusinessFetch\(accountId, "\/ppm\/v1\/accounts\/\{accountId\}\/legalEntities"\)/);
    assert.match(handlers, /await appStoreConnectTaxContext\(payload, provider\)/);
    assert.match(handlers, /encodeURIComponent\(vendorId\).*encodeURIComponent\(vendorScopeId\).*taxForms/s);
    assert.match(handlers, /taxFormType === "USA_FOREIGN_ENTITY_QUESTIONNAIRE"\s*\? appStoreConnectBusinessFetch\(accountId, "\/ppm\/l10n"\)\s*: Promise\.resolve\(null\)/);
  });

  test(`${variant}: 问卷题目和答案由 metadata 驱动`, () => {
    const renderer = source(root, "certificate-manager.js");
    const survey = renderer.slice(renderer.indexOf("async function loadHomeTaxSurveyMetadata"), renderer.indexOf("function closeHomeTaxMenu"));
    assert.match(survey, /draft\.metadata = result/);
    assert.match(survey, /draft\.metadata\?\.questionnaire/);
    assert.match(survey, /answer\?\.subsequentQuestionKey/);
    assert.match(survey, /answer\?\.taxFormTypes/);
    assert.doesNotMatch(survey, /: fallbackHomeTaxQuestions\(\)/);
    assert.match(survey, /home-tax-survey-loading/);
    assert.match(survey, /loading: true/);
    assert.match(survey, /const controlsDisabled = loading \|\| !question/);
    assert.match(survey, /data-home-tax-survey="cancel" \$\{controlsDisabled \? "disabled" : ""\}/);
    assert.match(survey, /terminalQuestion/);
    assert.match(survey, /hasPreviousQuestion \|\| terminalQuestion/);
    assert.match(survey, /if \(!currentTaxSurveyDraft\.history\?\.length && answer\?\.subsequentQuestionKey\)/);
    assert.match(survey, /"\u4fdd\u5b58"/);
  });

  test(`${variant}: 公司表单与账户缓存不会串用个人旧数据`, () => {
    const renderer = source(root, "certificate-manager.js");
    assert.doesNotMatch(renderer, /Wenzhi Wang/);
    assert.match(renderer, /USA_W8BENE/);
    assert.match(renderer, /taxFormUsaW8BenE/);
    assert.match(renderer, /U\.S\. Substitute Form W-8BEN-E/);
    assert.match(renderer, /\$\{HOME_TAX_STATE_KEY\}\.\$\{accountId\}\.\$\{legalEntityId\}/);
    assert.match(renderer, /homeTaxState\.usSurveyComplete = false;\s*homeTaxState\.w8ben\.submitted = false;/);
  });

  test(`${variant}: W-8BEN-E 只读字段遵循 metadata constraints`, () => {
    const renderer = source(root, "certificate-manager.js");
    assert.match(renderer, /homeTaxMetadataFieldEditable/);
    assert.match(renderer, /taxFormUsaW8BenE\.name/);
    assert.match(renderer, /taxFormUsaW8BenE\.country/);
    assert.match(renderer, /Country or region of incorporation or organization/);
    assert.match(renderer, /Chapter 3 Status \(entity type\)/);
    assert.match(renderer, /certify14bLimitationType/);
    assert.match(renderer, /Part III: Claim of Tax Treaty Benefits \(If Applicable\)/);
    assert.match(renderer, /Part XXX: Certification/);
    assert.match(renderer, /taxFormUsaW8BenE/);
  });

  test(`${variant}: 已签署个人 W-8BEN 根据 ACTIVE 状态锁定`, () => {
    const renderer = source(root, "certificate-manager.js");
    assert.match(renderer, /homeTaxW8IsSubmitted\(result\.data\)/);
    assert.match(renderer, /const locked = w8\.submitted === true \|\|/);
    assert.match(renderer, /serverSubmitted/);
  });

  test(`${variant}: 重设问卷删除服务端返回的 taxFormId`, () => {
    const main = source(root, "main.js");
    const renderer = source(root, "certificate-manager.js");
    const preload = source(root, "certificate-preload.js");
    assert.match(main, /app-store-connect-delete-tax-form/);
    assert.match(main, /taxForms\/\$\{encodeURIComponent\(taxFormId\)\}`.*method: "DELETE"/s);
    assert.match(preload, /deleteAppStoreTaxForm/);
    assert.match(renderer, /homeTaxQuestionnaireIds/);
    assert.match(renderer, /row\.taxFormId \|\| row\.id/);
    assert.match(renderer, /await window\.appleDeveloper\.deleteAppStoreTaxForm\(\{ \.\.\.context, taxFormId \}\)/);
  });

  test(`${variant}: 邮寄地址使用当前账户的关联参数和 Apple 原生接口`, () => {
    const main = source(root, "main.js");
    const renderer = source(root, "certificate-manager.js");
    const preload = source(root, "certificate-preload.js");
    const handlers = main.slice(main.indexOf('function taxAddressPath'), main.indexOf('ipcMain.handle("app-store-connect-save-tax-countries"'));
    const addressUi = renderer.slice(renderer.indexOf("function homeTaxAddressFormType"), renderer.indexOf("function renderHomeTaxCertificatePage"));
    assert.match(handlers, /requestedAccountId.*requestedAccountId !== accountId/s);
    assert.match(handlers, /appStoreConnectTaxContext\(payload, provider\)/);
    assert.match(handlers, /vendors\/\$\{encodeURIComponent\(vendorId\)\}\/taxAddresses/);
    assert.match(handlers, /metadata\?taxFormType=\$\{encodeURIComponent\(context\.taxFormType\)\}/);
    assert.match(handlers, /method: "POST", body: address/);
    assert.match(preload, /appStoreTaxAddresses/);
    assert.match(preload, /appStoreTaxAddressMetadata/);
    assert.match(preload, /createAppStoreTaxAddress/);
    assert.match(addressUi, /context\.accountId, context\.legalEntityId, context\.vendorId, context\.vendorScopeId, formType/);
    assert.match(addressUi, /homeTaxAddressRequestSeq/);
    assert.match(addressUi, /添加新地址/);
    assert.match(addressUi, /选取现有地址/);
    assert.match(addressUi, /metadata\?\.data\?\.\[key\]/);
    assert.match(renderer, /mailingAddress = clonePlainObject\(address\)/);
    assert.match(renderer, /formData\.mailingAddress|taxFormUsaW8Ben\.mailingAddress/);
  });

  test(`${variant}: 地址弹窗防重复、列表字段及保存请求与官方一致`, () => {
    const main = source(root, "main.js");
    const renderer = source(root, "certificate-manager.js");
    const addressUi = renderer.slice(renderer.indexOf("function homeTaxAddressLabel"), renderer.indexOf("function renderHomeTaxCertificatePage"));
    const label = addressUi.slice(addressUi.indexOf("function homeTaxAddressLabel"), addressUi.indexOf("function homeTaxAddressCountryLabel"));
    assert.match(label, /address\.addressLine1/);
    assert.doesNotMatch(label, /address\.addressLine2|address\.addressLine3/);
    assert.match(addressUi, /document\.querySelector\("\.home-tax-address-mask"\)/);
    assert.match(addressUi, /正在读取地址信息/);
    assert.match(addressUi, /loadHomeTaxAddresses\(mode\)/);
    assert.match(addressUi, /async function saveHomeTaxMailingAddress/);
    assert.match(addressUi, /appStoreTaxQuestionnaireMetadata\(\{ \.\.\.context, taxCountry: "USA", taxFormType: formType, formData \}\)/);
    const metadataHandler = main.slice(main.indexOf('ipcMain.handle("app-store-connect-tax-questionnaire-metadata"'), main.indexOf("function taxAddressPath"));
    assert.match(metadataHandler, /payload\.formData/);
    assert.match(metadataHandler, /body\.accountId = accountId/);
    assert.match(metadataHandler, /method: "POST", body(?:, headers: \{ Referer: `[^`]+` \})? \}/);
  });

  test(`${variant}: 税表提交先刷新版本再调用最终提交接口`, () => {
    const main = source(root, "main.js");
    const renderer = source(root, "certificate-manager.js");
    const submit = renderer.slice(renderer.indexOf("function bindHomeTaxDetailEvents"), renderer.indexOf("function homeNeedsTaxForm"));
    assert.ok(submit.indexOf("appStoreTaxQuestionnaireMetadata") < submit.lastIndexOf("saveAppStoreTaxForm"));
    assert.match(submit, /taxFormType,\s*formData: buildHomeTaxW8Payload/);
    assert.match(submit, /homeTaxAddressContextKey\(validation\.context, taxFormType\)/);
    const saveHandler = main.slice(main.indexOf('ipcMain.handle("app-store-connect-save-tax-form"'), main.indexOf('ipcMain.handle("app-store-connect-delete-tax-form"'));
    assert.match(saveHandler, /body\.accountId = accountId/);
    assert.match(saveHandler, /body\.taxFormType = requestedTaxFormType/);
    assert.match(saveHandler, /body\.optimisticLock/);
    assert.match(saveHandler, /business\/atb\/\$\{encodeURIComponent\(context\.legalEntityId\)\}/);
  });

  test(`${variant}: 首页报税表状态使用接口值`, () => {
    const main = source(root, "main.js");
    const renderer = source(root, "certificate-manager.js");
    assert.match(main, /\["ACTIVE", "COMPLETE", "SUBMITTED"\]\.includes\(String\(row\.taxStatus/);
    assert.match(renderer, /function homeTaxStatusPresentation/);
    assert.match(renderer, /ACTIVE: "使用中"/);
    assert.match(renderer, /statusText: status\.text/);
    assert.match(renderer, /escapeHTML\(row\.statusText\)/);
    assert.doesNotMatch(renderer, /taxFormUsa1042\.beneficialType = "Individual"/);
    const statusSource = renderer.slice(
      renderer.indexOf("function homeTaxStatusPresentation"),
      renderer.indexOf("function syncHomeTaxStateFromBusiness"),
    );
    const statusPresentation = Function(`${statusSource}; return homeTaxStatusPresentation;`)();
    assert.deepEqual(statusPresentation({ taxStatus: "ACTIVE" }), { submitted: true, text: "使用中" });
    assert.deepEqual(statusPresentation({ status: "PENDING" }), { submitted: false, text: "处理中" });
    assert.deepEqual(statusPresentation(null), { submitted: false, text: "缺少税务信息" });
  });

  test(`${variant}: 1042 受益所有人类型来自 metadata 约束并保存选择`, () => {
    const renderer = source(root, "certificate-manager.js");
    const main = source(root, "main.js");
    assert.match(renderer, /taxFormUsa1042\.beneficialType/);
    assert.match(renderer, /beneficialConstraint\?\.options/);
    assert.match(renderer, /beneficialConstraint\?\.isEditable !== true/);
    assert.match(renderer, /appStoreTaxQuestionnaireMetadata\(\{[\s\S]*taxFormType: "USA_1042S"[\s\S]*buildHomeTax1042Payload/);
    assert.match(renderer, /homeTax1042BeneficialTypeValue\(cert\.beneficialType/);
    assert.doesNotMatch(renderer, /<option[^>]*>Individual\/Sole proprietor<\/option>[^]*<option[^>]*>Corporation/);
    assert.match(main, /Referer: `https:\/\/appstoreconnect\.apple\.com\/business\/atb\/\$\{encodeURIComponent\(context\.legalEntityId\)\}`/);
  });

  test(`${variant}: 税表提交后返回首页并刷新协议与报税表`, () => {
    const renderer = source(root, "certificate-manager.js");
    const finish = renderer.slice(renderer.indexOf("async function returnHomeAfterTaxSubmit"), renderer.indexOf("function ensureHomeTaxAddDialog"));
    assert.match(finish, /homeTaxDetailOpen = false/);
    assert.match(finish, /await refreshHomeBusinessAfterTaxSubmit\(\)/);
    assert.match(renderer, /async function refreshHomeBusinessAfterTaxSubmit\(\)[\s\S]*syncHomeTaxStateFromBusiness\(\);\s*renderHomePage\(\)/);
    const submit = renderer.slice(renderer.indexOf("function bindHomeTaxDetailEvents"), renderer.indexOf("function homeNeedsTaxForm"));
    assert.equal((submit.match(/await returnHomeAfterTaxSubmit\(\)/g) || []).length, 2);
  });
}
