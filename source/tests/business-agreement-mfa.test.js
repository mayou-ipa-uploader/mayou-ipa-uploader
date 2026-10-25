const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const variants = [
  ["browser", path.join(__dirname, "../src")],
  ["standalone", path.join(__dirname, "../src")],
];

function source(root, name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

for (const [variant, root] of variants) {
  test(`${variant}: 付费协议使用 Apple 官方提交格式`, () => {
    const main = source(root, "main.js");
    const accept = main.slice(
      main.indexOf("async function acceptAppStoreConnectBusinessAgreement"),
      main.indexOf("async function downloadAppStoreConnectBusinessAgreementDocument"),
    );
    assert.match(accept, /const termsData = \{\s*agreeToTerms: true,\s*agreeToFamilyShare: payload\.agreeToFamilyShare !== false,\s*\}/);
    assert.match(accept, /method: "POST",\s*body: termsData,\s*headers/);
    assert.match(accept, /skipSessionRefresh: true/);
    assert.match(accept, /"X-CSRF-ITC": "agreements-ui"/);
    assert.doesNotMatch(accept, /body: \{ data: termsData \}/);
    assert.doesNotMatch(accept, /method: "PUT"|termsPath\}\/agree/);
  });

  test(`${variant}: 协议和验证码会话跟随当前 Apple 账户`, () => {
    const main = source(root, "main.js");
    const request = main.slice(
      main.indexOf("async function appStoreConnectBusinessAgreementRequest"),
      main.indexOf("async function fetchAppStoreConnectBusinessAgreementDetail"),
    );
    const invalidate = main.slice(
      main.indexOf("function invalidateAppleDeveloperRuntimeForAccountSwitch"),
      main.indexOf("function appleDeveloperContextIsCurrent"),
    );
    assert.match(request, /await fetchAppStoreConnectCurrentProvider\(\)/);
    assert.doesNotMatch(request, /accountIdHint/);
    assert.match(request, /\/legalEntities/);
    assert.match(invalidate, /appStoreConnectBusinessAgreementMfa = null/);
    assert.match(invalidate, /appStoreConnectBankMfa = null/);
  });

  test(`${variant}: 重发失败保留旧验证码，输错可继续重试`, () => {
    const main = source(root, "main.js");
    const flow = main.slice(
      main.indexOf("async function resendAppStoreConnectBusinessAgreementMfaCode"),
      main.indexOf("function appStoreConnectBankMfaIsCurrent"),
    );
    assert.match(flow, /const previousSecondFactor = state\.authClient\.secondFactor/);
    assert.match(flow, /previousSecondFactor\?\.method === "sms"[\s\S]*state\.authClient\.secondFactor = previousSecondFactor/);
    const verifyAt = flow.indexOf("await state.authClient.verifyCode");
    const clearAt = flow.indexOf("appStoreConnectBusinessAgreementMfa = null", verifyAt);
    assert.ok(verifyAt >= 0 && clearAt > verifyAt, "只有 Apple 接受验证码后才能清理会话");
    assert.match(flow, /await state\.authClient\.verifyCode\(String\(code\)\);\s*try \{/);
    assert.match(flow, /finally \{\s*appStoreConnectBusinessAgreementMfa = null/);
  });

  test(`${variant}: 切换账户时清理付费协议弹窗数据`, () => {
    const renderer = source(root, "certificate-manager.js");
    const reset = renderer.slice(
      renderer.indexOf("function initializeInterfaceAfterLogin"),
      renderer.indexOf("function applyStatus"),
    );
    assert.match(reset, /currentPaidAppAgreement = null/);
  });

  test(`${variant}: ASC 401 恢复暂停请求并限制为单并发`, () => {
    const main = source(root, "main.js");
    const queue = main.slice(
      main.indexOf("const APP_STORE_CONNECT_REQUEST_CONCURRENCY"),
      main.indexOf("function isCertificateManagerStandalone"),
    );
    assert.match(queue, /APP_STORE_CONNECT_REQUEST_CONCURRENCY = 1/);
    assert.match(queue, /APP_STORE_CONNECT_REQUEST_INTERVAL_MS = 120/);
    assert.match(queue, /appStoreConnectRequestQueuePaused/);
    assert.match(queue, /async function pauseAppStoreConnectRequestQueue/);
    assert.match(queue, /function resumeAppStoreConnectRequestQueue/);
  });

  test(`${variant}: ASC 无感恢复只清理短期会话并保留可信登录`, () => {
    const main = source(root, "main.js");
    const recovery = main.slice(
      main.indexOf("const APP_STORE_CONNECT_SHORT_SESSION_COOKIE_NAMES"),
      main.indexOf("function appStoreConnectBusinessHeaders"),
    );
    for (const name of ["itctx", "itcdq", "wosid", "woinst"]) {
      assert.match(recovery, new RegExp(`"${name}"`));
    }
    assert.match(recovery, /name\.startsWith\("dq-auth-retry:"\)/);
    assert.match(recovery, /preservedAppleLogin:[\s\S]*myacinfo/);
    assert.match(recovery, /preservedTrustedDevice:[\s\S]*aidshd[\s\S]*\^DES/);
    assert.doesNotMatch(recovery, /clearStorageData/);
    assert.match(recovery, /iris\/v1\/userPreferences/);
    assert.match(recovery, /await pauseAppStoreConnectRequestQueue\(\)/);
    assert.match(recovery, /finally \{\s*resumeAppStoreConnectRequestQueue\(\)/);
  });

  test(`${variant}: ASC 无感恢复失败后完整登录绕过旧缓存`, () => {
    const main = source(root, "main.js");
    const recovery = main.slice(
      main.indexOf("function appStoreConnectLoginRequiredError"),
      main.indexOf("function appStoreConnectBusinessHeaders"),
    );
    const login = main.slice(
      main.indexOf('ipcMain.handle("apple-developer-login"'),
      main.indexOf('ipcMain.handle("apple-developer-2fa-method"'),
    );
    const verify = main.slice(
      main.indexOf('ipcMain.handle("apple-developer-2fa"'),
      main.indexOf('ipcMain.handle("apple-developer-logout"'),
    );
    assert.match(recovery, /appStoreConnectForceFullLoginRequired = true/);
    assert.match(recovery, /appStoreConnectAuthenticationRequired: true/);
    assert.match(login, /appStoreConnectForceFullLoginRequired \|\| passwordChanged\s*\? \{ authenticated: false \}/);
    assert.match(login, /payload\.forceRefresh === true \|\| appStoreConnectForceFullLoginRequired/);
    assert.equal((login.match(/appStoreConnectForceFullLoginRequired = false/g) || []).length, 2);
    assert.equal((verify.match(/appStoreConnectForceFullLoginRequired = false/g) || []).length, 1);
  });

  test(`${variant}: ASC 完整登录优先使用本机密码且仅按 Apple 要求进入验证码`, () => {
    const renderer = source(root, "certificate-manager.js");
    const status = renderer.slice(
      renderer.indexOf("function applyStatus"),
      renderer.indexOf("function showLogoutDialog"),
    );
    const recovery = renderer.slice(
      renderer.indexOf("async function recoverAppStoreConnectAuthentication"),
      renderer.indexOf("async function refreshSavedAccountHistory"),
    );
    assert.match(renderer, /let appStoreConnectLoginRecoveryInFlight = false/);
    assert.match(status, /status\?\.appStoreConnectAuthenticationRequired/);
    assert.match(status, /recoverAppStoreConnectAuthentication\(\)/);
    assert.match(recovery, /appStoreConnectLoginRecoveryInFlight \|\| appleLoginInProgress/);
    assert.match(recovery, /window\.appleDeveloper\.autoLogin\(\{[\s\S]*forceRefresh: true/);
    assert.match(recovery, /result\?\.passwordRequired/);
    assert.match(recovery, /await handleAppleLoginResult\(result\)/);
    assert.match(recovery, /finally \{[\s\S]*appStoreConnectLoginRecoveryInFlight = false/);
  });
}
