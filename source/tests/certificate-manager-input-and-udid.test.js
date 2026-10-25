const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const sourceRoot = path.join(__dirname, "..", "src");
const renderer = fs.readFileSync(path.join(sourceRoot, "certificate-manager.js"), "utf8");
const rendererHTML = fs.readFileSync(path.join(sourceRoot, "certificate-manager.html"), "utf8");
const preload = fs.readFileSync(path.join(sourceRoot, "certificate-preload.js"), "utf8");
const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
const developerAccountManager = fs.readFileSync(path.join(sourceRoot, "developer-account-manager.js"), "utf8");

test("App 专用密码粘贴会替换选中内容并格式化", () => {
  const helperSource = renderer.slice(
    renderer.indexOf("function formatIPAAppPasswordInput"),
    renderer.indexOf("function setIPAAppPasswordField"),
  );
  const sandbox = { input: { value: "old-value", selectionStart: 0, selectionEnd: 9 } };
  vm.runInNewContext(helperSource + '; insertIPAAppPasswordPaste(input, "ABCD EFGH-IJKL MNOP"); result = input.value;', sandbox);
  assert.equal(sandbox.result, "abcd-efgh-ijkl-mnop");
  assert.match(renderer, /addEventListener\("paste"/);
  assert.match(renderer, /event\.preventDefault\(\)/);
});

test("UDID 方式选择器可绑定三个入口的点击事件", () => {
  const block = renderer.slice(renderer.indexOf("function showAddDevice"), renderer.indexOf("function showAddDeviceConfirmation"));
  assert.match(block, /id="device-id-method-tabs"/);
  assert.match(block, /querySelectorAll\("\[data-udid-method\]"\)/);
  assert.match(block, /button\.addEventListener\("click"/);
  assert.match(block, /data-open-udid-method="finder"/);
  assert.match(block, /data-open-udid-method="windows"/);
});

test("UDID 系统入口通过预加载 IPC 调用并返回平台错误", () => {
  assert.match(preload, /openUdidMethod: method => ipcRenderer\.invoke\("device-udid-method-open", method\)/);
  const handler = main.slice(main.indexOf('ipcMain.handle("device-udid-method-open"'), main.indexOf('ipcMain.handle("app-store-connect-delete-media"'));
  assert.match(handler, /process\.platform !== "darwin"/);
  assert.match(handler, /process\.platform !== "win32"/);
  assert.match(handler, /shell\.openPath\("\/System\/Library\/CoreServices\/Finder\.app"\)/);
  assert.match(handler, /ms-windows-store:\/\/pdp\/\?ProductId=9NP83LWLPZ9K/);
});

test("Mac 自动识别只返回在线物理设备并优先有线连接", () => {
  const helpers = main.slice(
    main.indexOf("function normalizedAppleDeviceUdid"),
    main.indexOf("async function detectUSBAppleDevices"),
  );
  const payload = {
    result: {
      devices: [
        {
          deviceProperties: { name: "同网 iPhone", osVersionNumber: "26.1" },
          hardwareProperties: { udid: "0000812000162CEA2698201E", reality: "physical", platform: "iOS", marketingName: "iPhone 14", productType: "iPhone15,2" },
          connectionProperties: { transportType: "localNetwork" },
        },
        {
          deviceProperties: { name: "有线 iPhone", osVersionNumber: "26.3" },
          hardwareProperties: { udid: "0000811000184D011146801E", reality: "physical", platform: "iOS", marketingName: "iPhone 13", productType: "iPhone14,5" },
          connectionProperties: { transportType: "wired" },
        },
        {
          deviceProperties: { name: "离线 iPhone" },
          hardwareProperties: { udid: "00008120000E108C2E63C01E", reality: "physical", platform: "iOS" },
          connectionProperties: { tunnelState: "unavailable" },
        },
        {
          deviceProperties: { name: "模拟器" },
          hardwareProperties: { udid: "000081200000000000000000", reality: "simulated", platform: "iOS" },
          connectionProperties: { transportType: "wired" },
        },
      ],
    },
  };
  const sandbox = { payload };
  vm.runInNewContext(helpers + "; result = coreDeviceRows(payload);", sandbox);
  const rows = JSON.parse(JSON.stringify(sandbox.result));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "有线 iPhone");
  assert.equal(rows[0].connection, "usb");
  assert.equal(rows[0].udid, "00008110-00184D011146801E");
  assert.equal(rows[1].connection, "wifi");
  assert.equal(rows[1].udid, "00008120-00162CEA2698201E");
});

test("Mac 自动识别会定时扫描并回填设备名称与 UDID", () => {
  const block = renderer.slice(renderer.indexOf("function showAddDevice"), renderer.indexOf("function showAddDeviceConfirmation"));
  assert.match(preload, /detectUdidDevices: \(\) => ipcRenderer\.invoke\("device-udid-detect"\)/);
  assert.match(block, /window\.appleDeveloper\.detectUdidDevices\(\)/);
  assert.match(block, /deviceDetectTimer = setInterval/);
  assert.match(block, /udidInput\.value = device\.udid/);
  assert.match(block, /device\.connection === "wifi" \? "同一网络" : "USB"/);
});

test("Mac 自动识别成功后隐藏 Finder 操作并关闭扫码面板", () => {
  const block = renderer.slice(renderer.indexOf("function showAddDevice"), renderer.indexOf("function showAddDeviceConfirmation"));
  assert.match(block, /data-device-empty-actions hidden/);
  assert.match(block, /emptyActions\.hidden = devices\.length > 0/);
  assert.match(block, /list\.innerHTML = devices\.map/);
  assert.match(block, /打开 Finder 完成设置/);
  assert.match(rendererHTML, /\.device-enrollment\[hidden\]\{display:none!important\}/);
});

test("设备注册页在低窗口高度下允许主内容区纵向滚动", () => {
  assert.match(rendererHTML, /\.main:has\(#page-devices\.active \.device-add-page\)\{[^}]*overflow-y:auto/);
  assert.match(rendererHTML, /\.main:has\(#page-devices\.active \.device-add-page\)>#page-devices\.active\{[^}]*height:auto/);
  assert.match(rendererHTML, /\.shell,.main\{min-height:0\}/);
});

test("桌面证书管理提供与其他卡片同样式的一键下载入口", () => {
  const homeBlock = renderer.slice(
    renderer.indexOf("function renderAutomationDownloadDialog"),
    renderer.indexOf("function renderAutomationComingPage"),
  );
  assert.match(homeBlock, /一键下载证书和描述/);
  assert.match(homeBlock, /data-automation="download"/);
  assert.match(homeBlock, /serverCertificatePackageOptions/);
  assert.match(homeBlock, /downloadServerCertificatePackage/);
  assert.match(preload, /downloadServerCertificatePackage: payload => ipcRenderer\.invoke\("apple-developer-download-server-certificate-package", payload\)/);
  assert.match(main, /ipcMain\.handle\("apple-developer-download-server-certificate-package"/);
  assert.doesNotMatch(homeBlock, /automation-home-card-download/);
});

test("证书续费弹窗自动生成付款码并可切换微信支付", async () => {
  assert.match(rendererHTML, /data-access-pay-method="alipay" aria-pressed="true"/);
  assert.match(rendererHTML, /data-access-pay-method="wechat" aria-pressed="false"/);
  const paymentBlock = renderer.slice(renderer.indexOf("function clearAccessPaymentFlow"), renderer.indexOf("function accessRenewalCopy"));
  assert.match(paymentBlock, /pay_method: selectedMethod/);
  assert.doesNotMatch(paymentBlock, /pay_method: "alipay"/);
  assert.match(paymentBlock, /requestId !== accessPaymentRequestId/);
  const dialogBlock = renderer.slice(renderer.indexOf("function showAccessRenewalDialog"), renderer.indexOf("async function refreshAccess"));
  assert.match(dialogBlock, /startAccessPayment\("alipay"\)/);
  const bindingBlock = renderer.slice(renderer.indexOf('const closeAccessDialog'), renderer.indexOf('el\("access-submit"\)'));
  assert.match(bindingBlock, /querySelectorAll\("\[data-access-pay-method\]"\)/);
  assert.match(bindingBlock, /startAccessPayment\(method\)/);
  assert.match(bindingBlock, /checkAccessPaymentStatus\(\{ manual: true \}\)/);

  const paymentSource = renderer.slice(renderer.indexOf("function clearAccessPaymentFlow"), renderer.indexOf("function accessRenewalCopy"));
  const classes = () => ({ add() {}, remove() {}, toggle() {} });
  const area = { classList: classes(), innerHTML: "" };
  const error = { textContent: "" };
  const purchase = { disabled: false, textContent: "" };
  const mask = { classList: { contains: () => true } };
  const payButtons = ["alipay", "wechat"].map(method => ({
    dataset: { accessPayMethod: method },
    classList: classes(),
    setAttribute(name, value) { this[name] = value; },
  }));
  let paymentPayload = null;
  const sandbox = {
    accessPaymentOrderNo: "",
    accessPaymentTimer: null,
    accessPaymentMethod: "alipay",
    accessPaymentRequestId: 0,
    launchAppleId: "demo@example.com",
    launchAccountId: "",
    homeAccountInfo: null,
    browserDesktopAccount: null,
    authenticated: true,
    browserBoundLaunch: false,
    pendingAccessPage: "",
    el: id => ({ "access-payment-area": area, "access-error": error, "access-purchase": purchase, "access-mask": mask }[id] || null),
    document: { querySelectorAll: () => payButtons },
    window: { appleDeveloper: {
      launchContext: async () => ({}),
      accountInfo: async () => ({ success: true, account: { appleId: "demo@example.com" } }),
      createAccessPayment: async payload => {
        paymentPayload = payload;
        return { success: true, order_no: "WX-1", pay_method: "wechat", qr_image: "data:image/png;base64,qr", amount: 99 };
      },
    } },
    escapeHTML: value => String(value),
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(`${paymentSource}; paymentPromise = startAccessPayment("wechat");`, sandbox);
  await sandbox.paymentPromise;
  assert.equal(paymentPayload.pay_method, "wechat");
  assert.equal(payButtons[1]["aria-pressed"], "true");
  assert.match(area.innerHTML, /微信支付二维码/);
  assert.equal(purchase.disabled, false);
});

test("续费支付成功后刷新授权并重绘时间", async () => {
  const finalizeSource = renderer.slice(
    renderer.indexOf("async function finalizeAccessPayment"),
    renderer.indexOf("async function resolveAccessPaymentIdentity"),
  );
  const status = { textContent: "" };
  const home = { classList: { contains: value => value === "active" } };
  let appliedAccess = null;
  let rendered = 0;
  const sandbox = {
    window: { appleDeveloper: {
      revealAccessCode: async () => ({ success: true, code: "PAID123" }),
      activateAccess: async () => ({ success: true, access: { authorizationExpiresAt: "2028-09-05T00:00:00Z", remainingDays: 730 } }),
      access: async () => ({ success: true, access: { authorizationExpiresAt: "2027-09-05T00:00:00Z", remainingDays: 365 } }),
    } },
    el: id => ({ "access-payment-status": status, "page-home": home }[id] || null),
    applyAccess: access => { appliedAccess = access; },
    pendingAccessPage: "home",
    closeAccessDialog: () => {},
    showPage: async () => {},
    renderHomePage: () => { rendered += 1; },
  };
  vm.runInNewContext(`${finalizeSource}; paymentPromise = finalizeAccessPayment("ORDER-1");`, sandbox);
  await sandbox.paymentPromise;

  assert.equal(appliedAccess.authorizationExpiresAt, "2028-09-05T00:00:00Z");
  assert.equal(rendered, 1);
  assert.match(status.textContent, /刷新授权时间/);
  const accountPayment = developerAccountManager.slice(
    developerAccountManager.indexOf("async function finalizeRenewalPayment"),
    developerAccountManager.indexOf("async function checkRenewalPaymentStatus"),
  );
  assert.match(accountPayment, /access: activated\.access \|\| null/);
  assert.match(developerAccountManager, /async function loadAccounts\(accessOverride = null\)/);
  // 执行真实的账户授权合并逻辑，验证新到期时间覆盖旧值，同时保留其他授权字段。
  const mergeStart = developerAccountManager.indexOf('  const overrideAccountId =', developerAccountManager.indexOf('async function loadAccounts'));
  const mergeEnd = developerAccountManager.indexOf('  el("count").textContent', mergeStart);
  const mergeContext = {
    result: { accounts: [
      { id: "account-1", appleId: "first@example.com", access: { authorizationExpiresAt: "2027-09-05T00:00:00Z", remainingDays: 365, canDelete: false } },
      { id: "account-2", appleId: "second@example.com", access: { remainingDays: 30 } },
    ] },
    accessOverride: { accountId: "account-1", access: { authorizationExpiresAt: "2028-09-05T00:00:00Z", remainingDays: 730 } },
    accessWarning: () => false,
  };
  vm.runInNewContext(developerAccountManager.slice(mergeStart, mergeEnd) + "; mergedRows = rows;", mergeContext);
  const renewed = mergeContext.mergedRows.find(row => row.id === "account-1");
  assert.equal(renewed.access.authorizationExpiresAt, "2028-09-05T00:00:00Z");
  assert.equal(renewed.access.canDelete, false);
  assert.equal(mergeContext.mergedRows.find(row => row.id === "account-2").access.remainingDays, 30);
});

test("QQ 联系方式复制成功后按后台号码打开 QQ 并提供官方链接回退", async () => {
  assert.match(rendererHTML, /data-copy-value="1107258605" data-qq-kind="group"/);
  assert.match(rendererHTML, /data-copy-value="1970332242" data-qq-kind="person"/);
  assert.match(renderer, /button\.textContent = "复制成功"/);
  assert.match(renderer, /window\.appleDeveloper\.openQQContact\(\{ kind: qqKind, uin: value \}\)/);
  assert.match(preload, /openQQContact: payload => ipcRenderer\.invoke\("apple-developer-open-qq-contact", payload\)/);
  const handler = main.slice(main.indexOf('ipcMain.handle("apple-developer-open-qq-contact"'), main.indexOf('ipcMain.handle("device-udid-method-open"'));
  assert.match(handler, /mqqapi:\/\/card\/show_pslcard/);
  assert.match(handler, /https:\/\/qm\.qq\.com\/q\/dXT0o28sCs/);
  assert.match(handler, /https:\/\/wpa\.qq\.com\/msgrd/);
  assert.match(handler, /uin === configured\.qq_group_number/);
  assert.match(handler, /uin === configured\.qq_contact_number/);
  let callback;
  const opened = [];
  const sandbox = {
    ipcMain: { handle: (_name, fn) => { callback = fn; } }, URLSearchParams,
    productContactService: { load: async () => ({ success: true, data: {
      qq_group_number: "123456789", qq_contact_number: "987654321", join_url: "https://qm.qq.com/q/configured",
    } }) },
    shell: { openExternal: async url => { opened.push(url); if (url.startsWith("mqqapi:")) throw new Error("QQ unavailable"); } },
  };
  vm.runInNewContext(handler, sandbox);
  const refused = await callback(null, { kind: "group", uin: "1107258605" });
  assert.equal(refused.success, false);
  assert.equal(opened.length, 0);
  assert.equal((await callback(null, { kind: "group", uin: "123456789" })).success, true);
  assert.match(opened[0], /uin=123456789/);
  assert.equal(opened[1], "https://qm.qq.com/q/configured");
});

test("一键创建完成后弹出下载提示，取消会返回一键操作主页", () => {
  const dialogStart = renderer.indexOf("function closeAutomationCompletionDownloadDialog");
  const dialogEnd = renderer.indexOf("function renderOneClickPage", dialogStart);
  const dialog = renderer.slice(dialogStart, dialogEnd);

  assert.match(dialog, /function openAutomationCompletionDownloadDialog\(\)/);
  assert.match(dialog, /证书和描述文件已创建/);
  assert.match(dialog, /是否立即下载 ZIP 文件包？/);
  assert.match(dialog, /data-close-automation-completion-download/);
  assert.match(dialog, /returnToOneClickHomeAfterAutomationDownload/);
  assert.match(dialog, /downloadAutomationArtifacts\(\{ button, errorTarget: status \}\)/);
  assert.equal((renderer.match(/openAutomationCompletionDownloadDialog\(\);/g) || []).length, 3);

  let removed = false;
  let rendered = 0;
  const sandbox = {
    automationCompletionDownloadOpen: true,
    automationDownloadOpen: true,
    automationArtifacts: { certificate: { id: "test" } },
    document: { getElementById: () => ({ remove: () => { removed = true; } }) },
    renderOneClickPage: () => { rendered += 1; },
  };
  const closeAndReturn = renderer.slice(dialogStart, renderer.indexOf("function openAutomationCompletionDownloadDialog", dialogStart));
  vm.runInNewContext(`${closeAndReturn}; returnToOneClickHomeAfterAutomationDownload();`, sandbox);
  assert.equal(removed, true);
  assert.equal(rendered, 1);
  assert.equal(sandbox.automationCompletionDownloadOpen, false);
  assert.equal(sandbox.automationDownloadOpen, false);
  assert.equal(sandbox.automationArtifacts, null);
});

test("描述文件读取超时会结束加载态并提供重试", async () => {
  const helperStart = renderer.indexOf("const PROFILE_LIST_LOAD_TIMEOUT_MS");
  const helperEnd = renderer.indexOf("function cancelProfileBundleLookups", helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  const loadStart = renderer.indexOf("async function loadProfiles()");
  const loadEnd = renderer.indexOf("function profileSelectedType", loadStart);
  const loadProfiles = renderer.slice(loadStart, loadEnd);

  assert.match(helper, /PROFILE_LIST_LOAD_TIMEOUT_MS = 20000/);
  assert.match(helper, /timedOut: true/);
  assert.match(helper, /读取超过 \$\{Math\.ceil\(timeoutMs \/ 1000\)\} 秒，请检查网络后重试/);
  assert.match(loadProfiles, /await readProfilesWithTimeout\(\)/);
  assert.match(loadProfiles, /result\?\.timedOut \? "读取超时" : "读取失败"/);
  assert.match(loadProfiles, /onclick="refreshModule\('profiles'\)"/);

  let timeoutMs = 0;
  const sandbox = {
    window: { appleDeveloper: { profiles: () => new Promise(() => {}) } },
    setTimeout: (callback, ms) => { timeoutMs = ms; callback(); return 1; },
    clearTimeout: () => {},
  };
  vm.runInNewContext(`${helper}; pending = readProfilesWithTimeout();`, sandbox);
  const result = await sandbox.pending;
  assert.equal(timeoutMs, 20000);
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /读取超过 20 秒/);
});

test("一键创建会拦截缺少服务器证书文件的类型，但放行测试证书资料完整的情况", () => {
  const helperStart = renderer.indexOf("const AUTOMATION_CERTIFICATE_REQUIREMENTS");
  const helperEnd = renderer.indexOf("async function prepareServerCertificateRebuild", helperStart);
  const helper = renderer.slice(helperStart, helperEnd);
  const allStart = renderer.indexOf("async function startAllAutomation");
  const testStart = renderer.indexOf("async function startTestAutomation");
  const releaseStart = renderer.indexOf("async function startReleaseAutomation");
  const allAutomation = renderer.slice(allStart, testStart);
  const testAutomation = renderer.slice(testStart, releaseStart);
  const releaseAutomation = renderer.slice(releaseStart, renderer.indexOf("async function downloadAutomationArtifacts", releaseStart));

  assert.match(helper, /function automationCertificateFileGaps/);
  assert.match(helper, /服务器缺少对应的 P12 或私钥文件/);
  assert.match(helper, /请先勾选“\$\{rebuildLabel\}”/);
  assert.equal((renderer.match(/await ensureAutomationCertificateFiles\(/g) || []).length, 3);
  assert.match(allAutomation, /requirements: includeDeviceArtifacts \? \["development", "distribution"\] : \["distribution"\]/);
  assert.match(testAutomation, /requirements: \["development"\]/);
  assert.match(releaseAutomation, /requirements: \["distribution"\]/);
  assert.match(preload, /automationCertificateReadiness: \(\) => ipcRenderer\.invoke\("apple-developer-automation-certificate-readiness"\)/);

  const sandbox = {};
  vm.runInNewContext(`${helper}; gaps = automationCertificateFileGaps;`, sandbox);
  const development = { id: "dev-1", typeId: "83Q87W3TGH", status: "Issued" };
  const distribution = { id: "dist-1", typeId: "WXV89964HE", status: "Issued" };
  const readyDevelopment = [{ certificateId: "dev-1", typeId: "83Q87W3TGH", ready: true }];
  const readyDistribution = [{ certificateId: "dist-1", typeId: "WXV89964HE", ready: true }];

  assert.equal(sandbox.gaps(["development"], [], []).length, 1);
  assert.equal(sandbox.gaps(["development"], [development], readyDevelopment).length, 0);
  const allGaps = sandbox.gaps(["development", "distribution"], [distribution], readyDistribution);
  assert.equal(allGaps.length, 1);
  assert.equal(allGaps[0].key, "development");
});

test("服务器证书资料状态按证书 ID 和私钥或 P12 关联计算", () => {
  const helperStart = main.indexOf("function serverCertificateArtifactReadiness");
  const helperEnd = main.indexOf("async function verifySyncedAppleDeveloperArtifactSet", helperStart);
  const helper = main.slice(helperStart, helperEnd);
  assert.match(main, /ipcMain\.handle\("apple-developer-automation-certificate-readiness"/);
  assert.match(helper, /hasP12 \|\| hasPrivateKey/);
  const sandbox = {};
  vm.runInNewContext(`${helper}; readiness = serverCertificateArtifactReadiness;`, sandbox);
  const rows = [
    { artifact_type: "certificate", artifact_key: "dev-1", metadata: { typeId: "83Q87W3TGH", csrSyncKey: "csr-dev" } },
    { artifact_type: "private_key", artifact_key: "csr-dev", metadata: { csrSyncKey: "csr-dev" } },
    { artifact_type: "certificate", artifact_key: "dist-1", metadata: { typeId: "WXV89964HE", csrSyncKey: "csr-dist" } },
  ];
  const readiness = sandbox.readiness(rows);
  assert.equal(readiness.find(item => item.certificateId === "dev-1").ready, true);
  assert.equal(readiness.find(item => item.certificateId === "dist-1").ready, false);
});

test("失效描述文件恢复会沿用原证书类型，并只在没有可复用资料时要求新 P12 密码", () => {
  const profileTypes = main.slice(main.indexOf("const APPLE_PROFILE_TYPES"), main.indexOf("async function appleProfileContext"));
  const typeHelper = main.slice(main.indexOf("function profileRecoveryDefaultCertificateTypeId"), main.indexOf("function isAppleCertificateUsableForProfileRecovery"));
  const recoveryPlan = main.slice(main.indexOf("async function readAppleProfileRecoveryPlan"), main.indexOf("async function syncAppleDeveloperProfileArtifact"));
  const recoveryHandler = main.slice(main.indexOf('ipcMain.handle("apple-developer-profile-recovery-plan"'), main.indexOf('ipcMain.handle("apple-developer-profile-options"'));
  const profileList = renderer.slice(renderer.indexOf("function profileCanRecoverCertificate"), renderer.indexOf("function profileSelectedType"));
  const automationFinalizer = renderer.slice(renderer.indexOf("async function finalizeAutomationArtifacts"), renderer.indexOf("const AUTOMATION_CERTIFICATE_REQUIREMENTS"));

  const sandbox = {};
  vm.runInNewContext(`${profileTypes}; ${typeHelper}; macDevelopment = profileRecoveryDefaultCertificateTypeId("MAC_APP_DEVELOPMENT"); macStore = profileRecoveryDefaultCertificateTypeId("MAC_APP_STORE"); iosDevelopment = profileRecoveryDefaultCertificateTypeId("IOS_APP_DEVELOPMENT");`, sandbox);
  assert.equal(sandbox.macDevelopment, "749Y1QAGU7");
  assert.equal(sandbox.macStore, "HXZEUKP0FP");
  assert.equal(sandbox.iosDevelopment, "83Q87W3TGH");
  assert.match(recoveryPlan, /originalCertificateTypeId/);
  assert.match(recoveryPlan, /profileType\.certificateTypeIds\.includes\(originalTypeId\)/);
  assert.match(recoveryPlan, /String\(item\.typeId \|\| ""\) === originalTypeId/);
  assert.match(recoveryHandler, /apple-developer-sync-recovery-certificate/);
  assert.match(recoveryHandler, /apple-developer-finalize-profile-recovery/);
  assert.match(preload, /profileRecoveryPlan: payload => ipcRenderer\.invoke\("apple-developer-profile-recovery-plan", payload\)/);
  assert.match(preload, /syncRecoveryCertificate: payload => ipcRenderer\.invoke\("apple-developer-sync-recovery-certificate", payload\)/);
  assert.match(profileList, /profile-recover/);
  assert.match(profileList, /plan\.action === "create"/);
  assert.match(profileList, /p12Password = prompt/);
  assert.match(profileList, /原失效描述文件会自动删除/);
  assert.match(profileList, /deleteProfile\(\{ id: profile\.id \}\)/);
  assert.match(profileList, /id="recover-all-profiles"/);
  assert.match(profileList, /recoverAllInvalidProfiles/);
  assert.match(profileList, /profileRecoveryPurpose/);
  assert.match(profileList, /function recoveredProfileName\(name = ""\) \{\s*return String\(name \|\| "描述文件"\);/);
  assert.match(automationFinalizer, /markAppleDeveloperResourcePagesStale\(\)/);
});
