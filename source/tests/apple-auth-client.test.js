const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { AppleAuthClient } = require("../src/apple-auth-client");

const AUTH_BASE = "https://idmsa.apple.com/appleauth/auth";

function result(status, body = {}) {
  return { response: { status, ok: status >= 200 && status < 300, headers: new Headers() }, body };
}

class ScriptedClient extends AppleAuthClient {
  constructor(script = [], options = {}) {
    super({ getUserAgent: () => "Unit Test" }, { skipTrust: options.skipTrust !== false });
    this.script = [...script];
    this.calls = [];
  }

  async bootstrap() {}

  async request(requestPath, options = {}) {
    this.calls.push({ path: requestPath, ...options });
    const next = this.script.shift();
    if (!next) throw new Error(`unexpected request: ${requestPath}`);
    if (typeof next === "function") return next(requestPath, options);
    return next;
  }
}

function authInfo(phones = [{ id: 1, lastTwoDigits: "01" }]) {
  return {
    twoSV: {
      referrerQuery: "?referrer=%2Faccount",
      phoneNumberVerification: { trustedPhoneNumbers: phones },
    },
  };
}

test("Developer login reads widget and callback parameters from the IDMS page", async () => {
  const callback = new URL("https://idmsa.apple.com/signin");
  callback.search = new URLSearchParams({ language: "CN-ZH", path: "/login/?return=%2Fcn%2F", appIdKey: "a".repeat(64) }).toString();
  const developerHtml = `<script type="application/json" id="embed_login_boot_args">${JSON.stringify({ direct: {
    authWidgetConfig: { authWidgetURL: "https://idmsa.apple.com/appleauth", widgetKey: "b".repeat(64), skVersion: "7" },
    iframeId: "daw-test-frame", appId: 632, locale: "CN-ZH", signInRequestUrl: encodeURIComponent(callback.toString()),
  } })}</script>`;
  const requests = [];
  const client = new AppleAuthClient({
    getUserAgent: () => "Unit Test",
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return new Response(requests.length === 1 ? developerHtml : '<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>', { status: 200 });
    },
  });
  await client.bootstrap();
  assert.equal(requests[0].url.pathname, "/IDMSWebAuth/signin.html");
  assert.equal(requests[0].options.headers.Referer, undefined);
  assert.equal(requests[1].url.searchParams.get("widgetKey"), "b".repeat(64));
  assert.equal(new URL(requests[1].options.headers.Referer).origin, "https://idmsa.apple.com");
  assert.equal(requests[1].url.searchParams.get("iframeId"), "daw-test-frame");
  assert.equal(requests[1].url.searchParams.get("appId"), "632");
  assert.equal(client.headers()["X-Apple-Widget-Key"], "b".repeat(64));
  assert.equal(client.headers()["X-Apple-App-Id"], "632");
  assert.equal(client.headers()["X-Apple-Locale"], "CN-ZH");
  assert.equal(client.headers()["X-Apple-Trusted-Domain"], "https://idmsa.apple.com");
  assert.equal(client.headers()["X-Apple-Frame-Id"], "daw-test-frame");
  assert.equal(client.headers()["X-Apple-Domain-Id"], undefined);
  assert.equal(client.developerLoginConfig.callbackPath, "/login/?return=%2Fcn%2F");
  assert.equal(client.developerLoginConfig.callbackAppIdKey, "a".repeat(64));
});

test("Developer login rejects missing page parameters before sending credentials", async () => {
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async () => new Response("<html></html>") });
  await assert.rejects(() => client.bootstrap(), /无法读取 Apple Developer 登录页的认证参数/);
});

test("blocked Developer bootstrap identifies the failed GET before password submission", async () => {
  const callback = new URL("https://idmsa.apple.com/signin");
  callback.search = new URLSearchParams({ path: "/login/", appIdKey: "a".repeat(64) }).toString();
  const html = `<script id="embed_login_boot_args">${JSON.stringify({ direct: {
    authWidgetConfig: { authWidgetURL: "https://idmsa.apple.com/appleauth", widgetKey: "b".repeat(64) },
    iframeId: "daw-test", appId: 632, locale: "CN-ZH", signInRequestUrl: encodeURIComponent(callback.toString()),
  } })}</script>`;
  for (const blockedRequest of [1, 2]) {
    let requests = 0;
    const diagnostics = [];
    const client = new AppleAuthClient({
      getUserAgent: () => "Unit Test",
      fetch: async () => {
        requests++;
        if (requests === blockedRequest) throw new Error("net::ERR_BLOCKED_BY_CLIENT https://idmsa.apple.com/signin?token=secret");
        return new Response(html);
      },
    }, { logger: (event, payload) => diagnostics.push({ event, ...payload }) });
    await assert.rejects(() => client.login("person@example.com", "password"), error => {
      assert.equal(error.appleBootstrapBlocked, true);
      assert.equal(error.appleBootstrapStep, blockedRequest === 1 ? "developer-signin-page" : "developer-auth-widget");
      return true;
    });
    assert.equal(requests, blockedRequest);
    const failed = diagnostics.find(item => item.event === "bootstrap-error");
    assert.ok(failed);
    assert.equal(failed.step, blockedRequest === 1 ? "developer-signin-page" : "developer-auth-widget");
    assert.doesNotMatch(failed.error, /token=secret/);
  }
});

function recoveryHarness(outcomes) {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const source = main.slice(
    main.indexOf("async function loginAppleDeveloperWithBootstrapRecovery"),
    main.indexOf("async function tryRestoreAppleDeveloperRememberedSession"),
  );
  const events = [];
  const session = { clearAuthCache: async () => events.push("clear-auth-cache") };
  const context = {
    appleAuthClient: null,
    createAppleDeveloperAuthClient: () => {
      events.push("create-client");
      return {
        accountKey: "current", contextGeneration: 1,
        login: async () => {
          events.push("login");
          const outcome = outcomes.shift();
          if (outcome instanceof Error) throw outcome;
          return outcome;
        },
      };
    },
    appleAuthClientIsCurrent: client => client.accountKey === "current" && client.contextGeneration === 1,
    appleDeveloperContextIsCurrent: (generation, accountKey) => generation === 1 && accountKey === "current",
    resetAppleDeveloperLoginTransaction: async (_session, options) => events.push(`reset:${options.preserveTrustedCookies}`),
    logAppleDeveloperDiagnostic: event => events.push(event),
  };
  const login = vm.runInNewContext(`${source}; loginAppleDeveloperWithBootstrapRecovery`, context);
  return { login: () => login(session, "fingerprint", "person@example.com", "password"), events, context };
}

test("blocked bootstrap clears current account and retries login once", async () => {
  const blocked = Object.assign(new Error("net::ERR_BLOCKED_BY_CLIENT"), {
    appleBootstrapBlocked: true, appleBootstrapStep: "developer-signin-page",
  });
  const harness = recoveryHarness([blocked, { requires2FA: true }]);
  const { result } = await harness.login();
  assert.equal(result.requires2FA, true);
  assert.deepEqual(harness.events, ["create-client", "login", "auth-bootstrap-recovery", "reset:false", "clear-auth-cache", "create-client", "login"]);
});

test("blocked request after bootstrap never repeats a password attempt", async () => {
  const harness = recoveryHarness([new Error("net::ERR_BLOCKED_BY_CLIENT")]);
  await assert.rejects(harness.login, /ERR_BLOCKED_BY_CLIENT/);
  assert.deepEqual(harness.events, ["create-client", "login"]);
});

test("persistent bootstrap block stops after one reset with a local interception message", async () => {
  const blocked = () => Object.assign(new Error("net::ERR_BLOCKED_BY_CLIENT"), {
    appleBootstrapBlocked: true, appleBootstrapStep: "developer-auth-widget",
  });
  const harness = recoveryHarness([blocked(), blocked()]);
  await assert.rejects(harness.login, /已清理当前账户缓存并重试/);
  assert.equal(harness.events.filter(event => event === "login").length, 2);
  assert.equal(harness.events.filter(event => event === "reset:false").length, 1);
  assert.equal(harness.context.appleAuthClient, null);
});

test("409 password result initializes HSA2 and exposes the automatically sent device code", async () => {
  const client = new ScriptedClient([
    result(200),
    result(200, {
      iteration: 1,
      b: Buffer.alloc(256, 2).toString("base64"),
      salt: Buffer.alloc(16, 3).toString("base64"),
      protocol: "s2k",
      c: "challenge",
    }),
    result(409, { authType: "hsa2" }),
    result(200, { ...authInfo([{ id: 3, lastTwoDigits: "03" }]), hasTrustedDevices: true }),
  ]);

  const login = await client.login("person@example.com", "password", true);
  assert.equal(login.requires2FA, true);
  assert.equal(login.initial2FAMethod, "device");
  assert.equal(login.initialCodeAutomaticallySent, true);
  assert.equal(client.calls.at(-1).path, AUTH_BASE);
  assert.equal(client.calls.at(-1).accept, "text/html");
  assert.equal(client.calls.at(-1).xmlHttpRequest, false);
  assert.equal(client.calls.at(-1).origin, false);
  assert.equal(client.secondFactorAuthInitialized, true);
  assert.deepEqual(client.secondFactor, { method: "device" });
  assert.deepEqual(login.trustedPhones.map(phone => phone.id), [3]);
});

test("409 password result recognizes Apple's automatically sent SMS and verifies it without resending", async () => {
  const client = new ScriptedClient([
    result(200),
    result(200, {
      iteration: 1,
      b: Buffer.alloc(256, 2).toString("base64"),
      salt: Buffer.alloc(16, 3).toString("base64"),
      protocol: "s2k",
      c: "challenge",
    }),
    result(409, { authType: "hsa2" }),
    result(200, {
      hasTrustedDevices: false,
      twoSV: {
        referrerQuery: "?referrer=%2Faccount",
        phoneNumberVerification: {
          mode: "sms",
          noTrustedDevices: true,
          phoneNumber: { id: 1 },
          trustedPhoneNumbers: [{ id: 1, lastTwoDigits: "13", pushMode: "sms" }],
        },
      },
    }),
    result(204),
  ]);

  const login = await client.login("person@example.com", "password", true);
  assert.equal(login.initial2FAMethod, "sms");
  assert.equal(login.initialCodeAutomaticallySent, true);
  assert.equal(login.initialPhoneId, 1);
  assert.deepEqual(client.secondFactor, { method: "sms", phoneId: 1 });
  assert.equal(client.calls.length, 4);
  await client.verifyCode("123456");
  assert.deepEqual(client.calls[4], {
    path: "/verify/phone/securitycode?referrer=%2Faccount",
    method: "POST",
    data: { phoneNumber: { id: 1 }, securityCode: { code: "123456" }, mode: "sms" },
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
  });
});

test("phone-only login without an auto-delivery mode requires an explicit SMS request", async () => {
  const client = new ScriptedClient([
    result(200),
    result(200, {
      iteration: 1, b: Buffer.alloc(256, 2).toString("base64"),
      salt: Buffer.alloc(16, 3).toString("base64"), protocol: "s2k", c: "challenge",
    }),
    result(409, { authType: "hsa2" }),
    result(200, { hasTrustedDevices: false, twoSV: { phoneNumberVerification: { trustedPhoneNumbers: [{ id: 1 }] } } }),
  ]);
  const login = await client.login("person@example.com", "password");
  assert.equal(login.initial2FAMethod, "sms");
  assert.equal(login.initialCodeAutomaticallySent, false);
  assert.equal(client.secondFactor, null);
});

test("first explicit device click initializes /auth once; later click uses resend PUT", async () => {
  const client = new ScriptedClient([
    result(200, authInfo()),
    result(204),
  ]);

  const first = await client.requestDeviceCode();
  assert.equal(first.initialPush, true);
  assert.deepEqual(client.calls.map(call => [call.path, call.method || "GET"]), [[AUTH_BASE, "GET"]]);
  assert.equal(client.calls[0].accept, "text/html");
  assert.equal(client.calls[0].xmlHttpRequest, false);
  assert.equal(client.calls[0].origin, false);
  assert.deepEqual(client.secondFactor, { method: "device" });

  const second = await client.requestDeviceCode();
  assert.equal(second.initialPush, false);
  assert.deepEqual(client.calls[1], {
    path: "/verify/trusteddevice/securitycode",
    method: "PUT",
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
  });
});

test("failed device resend keeps the automatically sent code verifiable", async () => {
  const client = new ScriptedClient([result(403)]);
  client.secondFactorAuthInitialized = true;
  client.secondFactor = { method: "device" };
  await assert.rejects(() => client.requestDeviceCode(), /设备验证码发送失败 \(403\)/);
  assert.deepEqual(client.secondFactor, { method: "device" });
});

test("trusted phones are discovered in nested Apple boot payloads", async () => {
  const client = new ScriptedClient([result(204)]);
  client.state.twoFactorAuthApp = "tfaa-token";
  client.authInfo = {
    direct: {
      flow: {
        trustedDeviceVerification: {
          phoneNumberVerification: {
            trustedPhoneNumbers: [{ phoneNumberId: 12, phoneNumber: { obfuscatedNumber: "(***) ***-1212" } }],
          },
        },
      },
    },
  };
  client.secondFactorAuthInitialized = true;

  const sent = await client.requestSMS(12);
  assert.equal(sent.phoneId, 12);
  assert.equal(sent.trustedPhones[0].obfuscatedNumber, "(***) ***-1212");
  assert.equal(client.calls[0].path, "/verify/phone");
});

test("SMS first click discovers multiple trusted numbers without sending", async () => {
  const phones = [{ id: 7, lastTwoDigits: "07" }, { id: 9, lastTwoDigits: "09" }];
  const client = new ScriptedClient([result(200, authInfo(phones)), result(204)]);
  client.state.twoFactorAuthApp = "tfaa-token";

  const discovery = await client.requestSMS("");
  assert.equal(discovery.selectionRequired, true);
  assert.deepEqual(discovery.trustedPhones.map(phone => phone.id), [7, 9]);
  assert.equal(client.calls.length, 1);
  assert.equal(client.secondFactor, null);

  const sent = await client.requestSMS("9");
  assert.equal(sent.phoneId, 9);
  assert.deepEqual(client.calls[1], {
    path: "/verify/phone",
    method: "PUT",
    data: { phoneNumber: { id: 9 }, mode: "sms" },
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
  });
  assert.deepEqual(client.secondFactor, { method: "sms", phoneId: 9 });
});

test("password-login SMS uses Apple's current phone endpoint without tfaa", async () => {
  const client = new ScriptedClient([result(204)]);
  client.authInfo = {
    twoSV: {
      twoFactorAuthAppKey: "boot-app-key",
      twoFactorAuthEnv: "1",
      phoneNumberVerification: { trustedPhoneNumbers: [{ id: 18, lastTwoDigits: "18" }] },
    },
  };
  client.secondFactorAuthInitialized = true;

  const sent = await client.requestSMS("18");
  assert.equal(sent.phoneId, 18);
  assert.equal(client.calls[0].path, "/verify/phone");
});

test("on-demand MFA SMS keeps the tfaa-bound phone endpoint", async () => {
  const client = new ScriptedClient([result(204)]);
  client.onDemand2FAAppKey = "boot-app-key";
  client.authInfo = {
    twoSV: {
      twoFactorAuthAppKey: "boot-app-key",
      twoFactorAuthEnv: "1",
      phoneNumberVerification: { trustedPhoneNumbers: [{ id: 18, lastTwoDigits: "18" }] },
    },
  };
  client.secondFactorAuthInitialized = true;

  const sent = await client.requestSMS("18");
  const expectedTfaa = Buffer.from("boot-app-key:1::true::false::::::", "utf8").toString("base64");
  assert.equal(sent.phoneId, 18);
  assert.equal(client.calls[0].path, `/verify/phone?tfaa=${encodeURIComponent(expectedTfaa)}`);
});

test("SMS delivery accepts Apple's asynchronous 202 response", async () => {
  const client = new ScriptedClient([result(202)]);
  client.authInfo = authInfo([{ id: 21, lastTwoDigits: "21" }]);
  client.secondFactorAuthInitialized = true;

  const sent = await client.requestSMS("21");
  assert.equal(sent.status, 202);
  assert.deepEqual(client.secondFactor, { method: "sms", phoneId: 21 });
});

test("failed SMS resend keeps the automatically sent SMS verifiable", async () => {
  const client = new ScriptedClient([result(403)]);
  client.authInfo = authInfo([{ id: 1 }]);
  client.secondFactorAuthInitialized = true;
  client.secondFactor = { method: "sms", phoneId: 1 };
  await assert.rejects(() => client.requestSMS(1), /短信验证码发送失败 \(403\)/);
  assert.deepEqual(client.secondFactor, { method: "sms", phoneId: 1 });
});

test("Fresh MFA challenge sends the first SMS before returning", async () => {
  const client = new ScriptedClient([result(204)]);
  const bootHtml = '<script class="boot_args">{"direct":{"twoFactorAuthAppKey":"app-key","twoFactorAuthEnv":"1"}}</script>';
  let fetchStep = 0;
  client.session.fetch = async (url, options) => {
    fetchStep += 1;
    assert.match(url, fetchStep === 1 ? /\/olympus\/v1\/mfaChallenges$/ : /\/appleauth\/auth\/signin\?/);
    if (fetchStep === 1) {
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        text: async () => JSON.stringify({ data: { attributes: { token: "challenge-token" } } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "x-apple-2fa-app": "header-tfaa" }),
      text: async () => bootHtml,
    };
  };
  client.initializeSecondFactorAuth = async () => {
    client.authInfo = authInfo([{ id: 8, lastTwoDigits: "08" }]);
    client.secondFactorAuthInitialized = true;
    return { initializedNow: true, trustedPhones: [{ id: 8, lastTwoDigits: "08" }] };
  };
  client.requestSMS = async function requestSMS(phoneId) {
    this.calls.push({ path: `/verify/phone?tfaa=${encodeURIComponent(this.state.twoFactorAuthApp)}`, method: "PUT", data: { phoneNumber: { id: phoneId }, mode: "sms" } });
    return { status: 204, phoneId: String(phoneId), trustedPhones: [{ id: phoneId, lastTwoDigits: "08" }] };
  };
  const delivery = await client.beginMfaChallenge();
  assert.equal(delivery.initialSMS, true);
  assert.equal(delivery.phoneId, "8");
  assert.equal(client.calls.at(-1).path, "/verify/phone?tfaa=header-tfaa");
});

test("SMS rejects arbitrary phone id and a real 403 never marks delivery ready", async () => {
  const unknown = new ScriptedClient([]);
  unknown.authInfo = authInfo([{ id: 4 }]);
  unknown.secondFactorAuthInitialized = true;
  await assert.rejects(() => unknown.requestSMS("123456"), /Apple 返回的受信任手机号/);
  assert.equal(unknown.calls.length, 0);
  assert.equal(unknown.secondFactor, null);

  const rejected = new ScriptedClient([result(403, { service_errors: [{ message: "Forbidden" }] })]);
  rejected.state.twoFactorAuthApp = "tfaa-token";
  rejected.authInfo = authInfo([{ id: 4 }]);
  rejected.secondFactorAuthInitialized = true;
  await assert.rejects(() => rejected.requestSMS("4"), /Forbidden/);
  assert.equal(rejected.secondFactor, null);
});

test("verification POST uses the method endpoint and transaction referrer query", async () => {
  const client = new ScriptedClient([result(204), result(204)]);
  client.referrerQuery = "?referrer=%2Faccount";
  client.secondFactor = { method: "sms", phoneId: 9 };
  await client.verifyCode("123456");
  assert.deepEqual(client.calls[0], {
    path: "/verify/phone/securitycode?referrer=%2Faccount",
    method: "POST",
    data: { phoneNumber: { id: 9 }, securityCode: { code: "123456" }, mode: "sms" },
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
  });
});

test("valid SMS code with Apple's 412 repair flow completes repair before trust", async () => {
  const client = new ScriptedClient([
    result(412, { securityCode: { valid: true } }),
    result(204),
    result(204),
  ], { skipTrust: false });
  client.secondFactor = { method: "sms", phoneId: 1 };
  await client.verifyCode("123456");
  assert.deepEqual(client.calls.map(call => [call.path, call.method || "GET"]), [
    ["/verify/phone/securitycode", "POST"],
    ["/repair/complete", "POST"],
    ["/2sv/trust", "GET"],
  ]);
  assert.equal(client.calls[1].data, undefined);
  assert.equal(client.calls[1].accept, "application/json;charset=utf-8");
});

test("412 without a valid SMS code does not complete repair or trust", async () => {
  const client = new ScriptedClient([result(412, { securityCode: { valid: false } })], { skipTrust: false });
  client.secondFactor = { method: "sms", phoneId: 1 };
  await assert.rejects(() => client.verifyCode("123456"), /验证码校验失败 \(412\)/);
  assert.equal(client.calls.length, 1);
});

test("verification trust step mirrors Apple 2SV headers", async () => {
  const client = new ScriptedClient([result(204), result(204)], { skipTrust: false });
  client.secondFactor = { method: "device" };
  await client.verifyCode("123456");
  assert.deepEqual(client.calls[0], {
    path: "/verify/trusteddevice/securitycode",
    method: "POST",
    data: { securityCode: { code: "123456" } },
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
  });
  assert.deepEqual(client.calls[1], {
    path: "/2sv/trust",
    accept: "application/json, text/plain, */*",
    xmlHttpRequest: false,
    origin: false,
  });
});

test("an incorrect verification code rotates scnt before the next attempt", async () => {
  const sentScnt = [];
  const responseScnt = ["scnt-after-first-error", "scnt-after-second-error"];
  const client = new AppleAuthClient({
    getUserAgent: () => "Unit Test",
    fetch: async (_url, options = {}) => {
      sentScnt.push(String(options.headers?.scnt || ""));
      return new Response(JSON.stringify({
        service_errors: [{ code: "-21669", message: "验证码不正确" }],
        hasError: true,
      }), {
        status: 400,
        headers: { "content-type": "application/json", scnt: responseScnt.shift() },
      });
    },
  }, { skipTrust: true });
  client.state.scnt = "scnt-before-first-attempt";
  client.secondFactor = { method: "device" };

  await assert.rejects(() => client.verifyCode("111111"), /验证码不正确/);
  await assert.rejects(() => client.verifyCode("222222"), /验证码不正确/);

  assert.deepEqual(sentScnt, ["scnt-before-first-attempt", "scnt-after-first-error"]);
  assert.equal(client.state.scnt, "scnt-after-second-error");
});

test("Apple's 423 security code lock gives a cooldown message and does not trust the session", async () => {
  const client = new ScriptedClient([result(423, { securityCode: { securityCodeLocked: true } })], { skipTrust: false });
  client.secondFactor = { method: "device" };
  await assert.rejects(() => client.verifyCode("123456"), /验证码输入错误次数过多.*稍后再试/);
  assert.equal(client.calls.length, 1);
});

test("password attempt limit is returned instead of a generic signin error", async () => {
  const client = new ScriptedClient([
    result(200),
    result(200, { iteration: 1, b: Buffer.alloc(256, 2).toString("base64"), salt: Buffer.alloc(16, 3).toString("base64"), protocol: "s2k", c: "challenge" }),
    result(423),
  ]);
  await assert.rejects(() => client.login("person@example.com", "password"), /登录尝试次数过多或账户暂时受限，请稍后再试/);
  const earlyLimit = new ScriptedClient([result(429)]);
  await assert.rejects(() => earlyLimit.login("person@example.com", "password"), /登录尝试次数过多或账户暂时受限，请稍后再试/);
});

test("bank save derives vendor royalty assignments from Apple's legal-entity response", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const match = main.match(/function appStoreConnectBankRoyaltyAssignmentsFromLegalEntity[\s\S]*?\n}\n\nasync function fetchAppStoreConnectBankRoyaltyAssignments/);
  assert.ok(match, "bank royalty assignment helper must exist");
  const functionSource = match[0].replace(/\n\nasync function fetchAppStoreConnectBankRoyaltyAssignments$/, "");
  const derive = vm.runInNewContext(`(${functionSource})`);
  const assignments = derive({
    legalEntityId: "legal-entity-id",
    vendorId: "vendor-id-from-apple",
    vendorScope: [{
      vendorScopeId: "vendor-scope-id-from-apple",
      royalty: [
        { royalty: { value: "USD" }, assignable: true },
        { royalty: { value: "EUR" }, assignable: false },
      ],
    }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(assignments)), [{
    legalEntityId: "legal-entity-id",
    vendorId: "vendor-id-from-apple",
    vendorScopeId: "vendor-scope-id-from-apple",
    royalties: ["USD"],
  }]);
  assert.doesNotMatch(main, /vendorId:\s*legalEntityId[\s\S]{0,100}vendorScopeId:\s*legalEntityId/);
});

test("company bank save refreshes the legal entity optimistic lock before submission", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const match = main.match(/function appStoreConnectBankSaveRequest[\s\S]*?\n}\n\nasync function appStoreConnectCreateBankAccount/);
  assert.ok(match, "bank save request helper must exist");
  const functionSource = match[0].replace(/\n\nasync function appStoreConnectCreateBankAccount$/, "");
  const buildRequest = vm.runInNewContext(`(${functionSource})`, {
    appStoreConnectBankMetadataBody: value => ({ ...value, accountHolderAddress: { ...(value.accountHolderAddress || {}) } }),
  });
  const assignments = [{
    legalEntityId: "legal-entity-id",
    vendorId: "vendor-id",
    vendorScopeId: "vendor-scope-id",
    royalties: ["USD"],
  }];

  const request = buildRequest({
    accountId: "account-id",
    legalEntityId: "legal-entity-id",
    selectedCountry: "CHN",
    selectedCurrency: "CNY",
    optimisticLock: "stale-lock-from-form-metadata",
    accountHolderName: "Lifen Wang",
    accountHolderAddress: { country: "CHN", addressLine1: "Finance address" },
    accountNumber: "6214 8335 2031 9818",
    bankBranchIdentification1: "308305008076",
    bankBranchIdentification2: "666829B",
  }, { id: "account-id" }, assignments, {
    legalEntityId: "legal-entity-id",
    isOrganization: "true",
    optimisticLock: "fresh-lock-from-legal-entity",
  });

  assert.equal(request.body.optimisticLock, "fresh-lock-from-legal-entity");
  assert.equal(request.body.accountHolderType, "CORPORATION");
  assert.equal(request.body.accountNumber, "6214833520319818");
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.vendorRoyaltiesUsedByBank)), assignments);
});

test("bank statuses follow App Store Connect's Chinese banking labels", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const match = main.match(/function normalizeBankStatusText[\s\S]*?\n}\n\nfunction normalizeBankAccount/);
  assert.ok(match, "bank status normalizer must exist");
  const functionSource = match[0].replace(/\n\nfunction normalizeBankAccount$/, "");
  const normalize = vm.runInNewContext(`(${functionSource})`);

  assert.equal(normalize("CLEARED", false, { status: "CLEARED", assignable: true }), "正在处理");
  assert.equal(normalize("waitingDecision", false, { status: "waitingDecision" }), "正在验证");
  assert.equal(normalize("collectInfo", false, { status: "collectInfo" }), "等待用户信息");
  assert.equal(normalize("CLEARED", false, { editable: true, vendorRoyaltiesUsedByBank: [] }), "可用");
  assert.equal(normalize("CLEARED", false, { editable: true }), "不在使用中");
  assert.equal(normalize("CLEARED", true, { status: "CLEARED" }), "待处理");
});

test("renderer method changes do not send codes and main validates stale clients", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  assert.match(renderer, /addEventListener\("change", renderTwoFAMethod\)/);
  assert.match(renderer, /initialCodeAutomaticallySent[\s\S]{0,700}twoFAMethodReady = true/);
  assert.doesNotMatch(renderer, /addEventListener\("change", async \(\) =>[\s\S]{0,800}choose2FA/);
  assert.match(main, /if \(!appleAuthClientIsCurrent\(authClient\)\)/);
  assert.match(main, /appleAuthClient !== authClient/);
  const verifyHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-2fa",'),
    main.indexOf('ipcMain.handle("apple-developer-logout",'),
  );
  const staleGuard = String.raw`if \(!appleAuthClientIsCurrent\(authClient\) \|\| appleAuthClient !== authClient\) throw new Error\("验证期间 Apple 账户已切换，请重新登录"\);`;
  assert.match(verifyHandler, new RegExp(String.raw`await ses\.flushStorageData\(\);\s*${staleGuard}\s*const serviceValidation = await establishAppleDeveloperWebSession\(ses\);\s*${staleGuard}\s*let status = await readAppleDeveloperStatus\(\)`));
  assert.match(verifyHandler, new RegExp(String.raw`await ses\.flushStorageData\(\);\s*${staleGuard}\s*await persistAppleDeveloperCookies`));
});

test("renderer opens the delivered SMS method with its input ready", async () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const renderMethod = renderer.slice(
    renderer.indexOf("function renderTwoFAMethod("),
    renderer.indexOf("function setTwoFADeliveryControlsDisabled("),
  );
  const loginResult = renderer.slice(
    renderer.indexOf("async function handleAppleLoginResult("),
    renderer.indexOf("async function recoverAppStoreConnectAuthentication("),
  );
  const selected = { device: { checked: false }, sms: { checked: false } };
  const elements = Object.fromEntries([
    "twofa-panel-title", "twofa-panel-copy", "twofa-phone-field", "twofa-code",
    "twofa-status", "request-twofa",
  ].map(id => [id, { textContent: "", disabled: true, hidden: false, focus() { this.focused = true; } }]));
  let preferredPhoneId;
  const context = {
    document: { querySelector: selector => selected[selector.includes('[value="sms"]') ? "sms" : "device"] },
    el: id => elements[id],
    twoFAMethod: () => selected.sms.checked ? "sms" : "device",
    trustedTwoFAPhones: [],
    twoFAMethodReady: false,
    twoFARetryBlocked: false,
    resetTwoFADelivery() { this.twoFAMethodReady = false; elements["twofa-code"].disabled = true; },
    setTrustedTwoFAPhones(phones, phoneId) { this.trustedTwoFAPhones = phones; preferredPhoneId = phoneId; },
    setTwoFARequestButtonLabel(label) { elements["request-twofa"].textContent = label; },
    updateTwoFASubmit() {},
    showVerifyStep() {},
  };
  const handle = vm.runInNewContext(`${renderMethod}\n${loginResult}\nhandleAppleLoginResult`, context);
  await handle({
    success: true, requires2FA: true, initial2FAMethod: "sms",
    initialCodeAutomaticallySent: true, initialPhoneId: 1,
    trustedPhones: [{ id: 1, lastTwoDigits: "13" }],
  });
  assert.equal(selected.sms.checked, true);
  assert.equal(preferredPhoneId, 1);
  assert.equal(elements["twofa-panel-title"].textContent, "输入短信验证码");
  assert.equal(elements["twofa-code"].disabled, false);
  assert.equal(elements["twofa-code"].focused, true);
  assert.equal(elements["request-twofa"].textContent, "重新发送");
});

test("forget-and-close removes every account-scoped session and device profile", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const cacheCleanup = main.slice(
    main.indexOf("async function clearPersistentSessionData"),
    main.indexOf("function invalidateAppleDeveloperRuntimeForAccountSwitch"),
  );
  const logout = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-logout",'),
    main.indexOf('ipcMain.handle("auth-open-page",'),
  );

  assert.match(cacheCleanup, /targetSession\.clearData\(\)/);
  assert.match(cacheCleanup, /targetSession\.clearStorageData\(\)/);
  assert.match(cacheCleanup, /targetSession\.clearCache\(\)/);
  assert.match(cacheCleanup, /targetSession\.clearCodeCaches\(\{\}\)/);
  assert.match(cacheCleanup, /targetSession\.clearAuthCache\(\)/);
  assert.match(cacheCleanup, /targetSession\.cookies\.get\(\{\}\)/);
  assert.match(cacheCleanup, /appleDeveloperPartitionForAccount\(key\)/);
  assert.match(cacheCleanup, /appleAccountPartitionForAccount\(key\)/);
  assert.match(cacheCleanup, /appleDeveloperAccountStorageDir\(key\)/);
  assert.match(cacheCleanup, /transporter-accounts/);
  assert.match(cacheCleanup, /persistentPartitionDataDir\(partitionName\)/);

  assert.match(logout, /await clearDeveloperAccountCaches\(forgottenAccountKey, forgottenAppleId\)/);
  assert.match(logout, /deleteCertificateManagerAccountEnvironment\(forgottenOwnerKey, forgottenAccountKey\)/);
  assert.match(logout, /stopLocalProxyTunnel\(`apple-account-\$\{forgottenAccountKey\}`\)/);
  assert.match(main, /DELETE FROM certificate_environments WHERE owner_key=\? AND account_key=\?/);
});

test("manual and saved-account login restore cookies before discarding stale Apple transactions", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const resetHelper = main.slice(
    main.indexOf("async function resetAppleDeveloperLoginTransaction"),
    main.indexOf('ipcMain.handle("apple-developer-login",'),
  );
  assert.match(resetHelper, /const trustedCookies = preserveTrustedCookies[\s\S]*isAppleTrustedSessionCookie/);
  assert.match(resetHelper, /clearStorageData\(\{ storages: \["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"\] \}\)/);
  assert.match(resetHelper, /await ses\.clearCache\(\)\.catch/);
  assert.match(resetHelper, /restoreAppleCookieDetails\(ses, trustedCookies\)/);
  assert.match(resetHelper, /await ses\.closeAllConnections\(\)/);
  assert.doesNotMatch(resetHelper, /deleteAppleDeveloperSessionFile\(\)/);
  assert.match(resetHelper, /appleDeveloperCookiesRestoreAttempted = true/);
  assert.match(resetHelper, /ensureAppleDeveloperUserAgent\(ses\)/);
  assert.doesNotMatch(resetHelper, /rotate: true/);
  assert.match(main, /function createAppleDeveloperAuthClient/);

  const manualLogin = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-login",'),
    main.indexOf('ipcMain.handle("apple-developer-auto-login",'),
  );
  const autoLogin = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-auto-login",'),
    main.indexOf('ipcMain.handle("apple-developer-2fa-method",'),
  );
  assert.match(manualLogin, /await tryRestoreAppleDeveloperRememberedSession\(ses, "manual-login"\);[\s\S]*if \(restored\.authenticated\)[\s\S]*await resetAppleDeveloperLoginTransaction\(ses, \{ preserveTrustedCookies: !passwordChanged \}\);/);
  assert.match(manualLogin, /appStoreConnectForceFullLoginRequired \|\| passwordChanged/);
  assert.match(manualLogin, /await resetAppleDeveloperLoginTransaction\(ses, \{ preserveTrustedCookies: !passwordChanged \}\);[\s\S]*loginAppleDeveloperWithBootstrapRecovery\(ses, clientFingerprint/);
  assert.match(manualLogin, /loginAppleDeveloperWithBootstrapRecovery\(ses, clientFingerprint, appleId, password\)/);
  assert.match(autoLogin, /await tryRestoreAppleDeveloperRememberedSession\(ses, "auto-login"\);[\s\S]*if \(restored\.authenticated\)[\s\S]*await resetAppleDeveloperLoginTransaction\(ses, \{ preserveTrustedCookies: true \}\);/);
  assert.match(autoLogin, /if \(current\.authenticated\)[\s\S]*await resetAppleDeveloperLoginTransaction\(ses, \{ preserveTrustedCookies: true \}\);[\s\S]*loginAppleDeveloperWithBootstrapRecovery\(ses, clientFingerprint/);
  assert.match(autoLogin, /loginAppleDeveloperWithBootstrapRecovery\(ses, clientFingerprint, appleDeveloperLaunchAppleId, appleDeveloperLaunchPassword\)/);
});

test("certificate manager version is a minimum gate rather than an exact match", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const compareSource = main.slice(
    main.indexOf("function compareVersion"),
    main.indexOf("function currentDesktopAppVersion"),
  ).trim();
  const compareVersion = vm.runInNewContext(`(${compareSource})`);
  assert.equal(compareVersion("0.1.98", "0.1.99") < 0, true);
  assert.equal(compareVersion("0.1.99", "0.1.99"), 0);
  assert.equal(compareVersion("0.1.100", "0.1.99") > 0, true);
  const launchContext = main.slice(
    main.indexOf("function readCertificateManagerLaunchContext"),
    main.indexOf("async function acceptCertificateManagerLaunchContext"),
  );
  const openStandalone = main.slice(
    main.indexOf("async function openStandaloneCertificateManager"),
    main.indexOf("function isStandaloneCertificateManagerRunning"),
  );
  assert.match(launchContext, /compareVersion\(currentVersion, payload\.requiredAppVersion\) < 0/);
  assert.match(openStandalone, /policy\?\.forceUpgrade[\s\S]*compareVersion\(metadata\.version, backendRequiredVersion\) < 0/);
  assert.match(openStandalone, /compareVersion\(metadata\.version, CERTIFICATE_MANAGER_REQUIRED_VERSION\) < 0/);
  assert.doesNotMatch(launchContext, /compareVersion\(currentVersion, payload\.requiredAppVersion\) !== 0/);
  assert.doesNotMatch(openStandalone, /compareVersion\(metadata\.version, CERTIFICATE_MANAGER_REQUIRED_VERSION\) !== 0/);
});

test("certificate manager browser launch context never transports cookies", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const openStandalone = main.slice(
    main.indexOf("async function openStandaloneCertificateManager"),
    main.indexOf("function isStandaloneCertificateManagerRunning"),
  );
  const applyContext = main.slice(
    main.indexOf("async function applyCertificateManagerLaunchContext"),
    main.indexOf("async function requireDesktopUserIdentity"),
  );

  assert.doesNotMatch(openStandalone, /authCookies/);
  assert.doesNotMatch(openStandalone, /defaultSession\.cookies\.get/);
  assert.doesNotMatch(applyContext, /authCookies/);
  assert.doesNotMatch(applyContext, /defaultSession\.cookies\.set/);
});

test("macOS launches certificate manager through LaunchServices", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const openStandalone = main.slice(
    main.indexOf("async function openStandaloneCertificateManager"),
    main.indexOf("function isStandaloneCertificateManagerRunning"),
  );

  assert.match(openStandalone, /process\.platform === "darwin" \? "\/usr\/bin\/open" : executable/);
  assert.match(openStandalone, /\["-n", appPath, "--args", "--certificate-manager-context", contextPath\]/);
  assert.match(openStandalone, /delete env\.ELECTRON_RUN_AS_NODE/);
});

test("standalone certificate manager restores remembered account and migrates older Apple sessions", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const startupStart = main.indexOf("app.whenReady().then(async () => {");
  const startup = main.slice(
    startupStart,
    main.indexOf("createWindow();", startupStart),
  );
  const migrationHelpers = main.slice(
    main.indexOf("function appleDeveloperSessionMigrationCandidateKeys"),
    main.indexOf("async function persistAppleDeveloperCookies"),
  );
  const cookieRestore = main.slice(
    main.indexOf("async function restoreAppleDeveloperCookies"),
    main.indexOf("function deleteAppleDeveloperSessionFile"),
  );
  const softRestore = main.slice(
    main.indexOf("async function tryRestoreAppleDeveloperRememberedSession"),
    main.indexOf("function isApplePasswordMismatchError"),
  );

  assert.match(startup, /if \(!hasCertificateContextPath\) restoreIndependentDeveloperAccount\(\);/);
  assert.match(migrationHelpers, /WHERE apple_id=\? AND owner_key IN/);
  assert.match(migrationHelpers, /isCertificateManagerIndependent\(\)[\s\S]*"standalone-admin"[\s\S]*"legacy"/);
  assert.match(cookieRestore, /migrateAppleDeveloperSessionSnapshotIfNeeded\(\);[\s\S]*appleDeveloperCookiesRestoreAttempted = true/);
  assert.match(softRestore, /const migration = migrateAppleDeveloperSessionSnapshotIfNeeded\(accountKey\)/);
  assert.match(main, /const restoredProxy = accountProxy \|\| normalizeDeveloperAccountProxy\(readAppleDeveloperNetworkFile/);
  assert.match(main, /connection_mode='custom_proxy'/);
});

test("standalone login accepts the canonical binding returned by the server", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    const identityHelper = main.slice(
      main.indexOf("function independentCertificateManagerIdentity"),
      main.indexOf("function certificateManagerLaunchContextDir"),
    );
    const standaloneAccount = main.slice(
      main.indexOf("function ensureStandaloneDeveloperAccount"),
      main.indexOf("function appStoreConnectSession"),
    );
    const accessCheck = main.slice(
      main.indexOf('ipcMain.handle("apple-developer-access-check"'),
      main.indexOf('ipcMain.handle("apple-developer-access-activate"'),
    );
    const usageSync = main.slice(
      main.indexOf("async function syncDeveloperAccountUsageByRecord"),
      main.indexOf("function scheduleDeveloperAccountUsageSync"),
    );

    assert.match(identityHelper, /readDesktopUserIdentity\(\)/);
    assert.match(identityHelper, /\^\(boss\|employee\):\\d\+\$/);
    assert.match(standaloneAccount, /let ownerKey = identity\.key/);
    assert.match(standaloneAccount, /owner_key='boss:1'/);
    assert.match(standaloneAccount, /UPDATE developer_accounts SET owner_key=\?/);
    assert.match(standaloneAccount, /WHERE apple_id=\? ORDER BY created_at DESC LIMIT 1/);
    assert.match(usageSync, /body\.binding\?\.ownerKey/);
    assert.match(usageSync, /appleDeveloperOwnerKey = bindingOwnerKey/);
    assert.match(usageSync, /resolvedBindingUserId = bindingUserId \|\| ownerIdMatch/);
    assert.match(usageSync, /appleDeveloperAuthUserId = resolvedBindingUserId/);
    assert.match(usageSync, /bindingOwnerKey[\s\S]*appleDeveloperRecordId = canonicalAccountId[\s\S]*return \{ success: true/);
    assert.doesNotMatch(usageSync, /return \{ success: true[\s\S]*appleDeveloperRecordId = canonicalAccountId/);
    assert.match(accessCheck, /throw new Error\(synced\?\.error \|\| "无法同步账户使用期限/);
  }
});

test("temporary UDID enrollment is scoped to the current developer account", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const enrollmentHandlers = main.slice(
    main.indexOf('ipcMain.handle("device-enrollment-start",'),
    main.indexOf('ipcMain.handle("review-guidance-send",'),
  );

  assert.match(enrollmentHandlers, /if \(!appleDeveloperRecordId\) return \{ success: false/);
  assert.match(enrollmentHandlers, /JSON\.stringify\(\{ account_id: appleDeveloperRecordId \}\)/);
  assert.match(enrollmentHandlers, /device-enrollment\/sessions\/\$\{encodeURIComponent\(String\(token \|\| ""\)\)\}\?\$\{query\}/);
  assert.match(enrollmentHandlers, /temporary-udids\?account_id=\$\{encodeURIComponent\(appleDeveloperRecordId\)\}/);
  assert.match(enrollmentHandlers, /temporary-udids\/\$\{recordId\}\?account_id=\$\{encodeURIComponent\(appleDeveloperRecordId\)\}/);
});

test("existing App detail saves never patch Bundle ID", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const saveAppVersion = main.slice(
    main.indexOf("async function saveAppStoreConnectAppVersion"),
    main.indexOf("async function submitAppStoreConnectReview"),
  );

  assert.doesNotMatch(saveAppVersion, /appAttributes\.bundleId\s*=/);
  assert.match(renderer, /data-app-field="appInfo\.bundleId" disabled/);
});

test("App privacy page mirrors App Store Connect overview and publish flow", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");

  assert.match(renderer, /id="app-privacy-publish"/);
  assert.match(renderer, /data-privacy-edit-policy/);
  assert.match(renderer, /产品页面预览/);
  assert.match(renderer, /数据类型/);
  assert.match(renderer, /function openAppStorePrivacyPolicyModal/);
  assert.match(renderer, /window\.appleDeveloper\.publishAppStorePrivacy/);
  assert.doesNotMatch(renderer, /id="app-privacy-save"/);
  assert.match(preload, /publishAppStorePrivacy: payload => ipcRenderer\.invoke\("app-store-connect-publish-privacy", payload\)/);
  assert.match(main, /app-store-connect-publish-privacy/);
  assert.match(main, /appDataUsagesPublishState/);
  assert.match(main, /attributes:\s*\{\s*published:\s*true\s*\}/);
});

test("Bundle ID edit capabilities are loaded from Apple's capability catalog", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const createHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-create-bundle-id",'),
    main.indexOf('function normalizeAppleCapabilitySettings'),
  );
  const updateHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-update-bundle-id",'),
    main.indexOf('ipcMain.handle("apple-developer-delete-bundle-id",'),
  );

  assert.match(main, /capabilities\?filter\[capabilityType\]=capability,service&filter\[includeRequestable\]=true/);
  assert.match(main, /normalizeAppleCapabilityCatalog/);
  assert.match(main, /fetchAppleBundleCapabilityCatalog/);
  assert.match(main, /normalizeAppleBundleCreateCapabilities/);
  assert.match(main, /normalizeAppleBundleIds/);
  assert.match(main, /findAppleBundleIdByIdentifier/);
  assert.match(main, /fetchExistingAppleBundleIdByIdentifier/);
  assert.match(main, /appleBundleIdentifierUnavailableError/);
  assert.match(main, /apple-developer-bundle-capabilities/);
  assert.match(main, /settingsSchema/);
  assert.match(preload, /bundleCapabilities: \(\) => ipcRenderer\.invoke\("apple-developer-bundle-capabilities"\)/);
  assert.match(html, /\.main:has\(#page-apps\.active\)>\.crumb,\.main:has\(#page-bundle\.active\)>\.crumb,\.main:has\(#page-profiles\.active\)>\.crumb,\.main:has\(#page-certificates\.active\)>\.crumb\{display:none\}/);
  assert.match(html, /\.main:has\(#page-bundle\.active\),\.main:has\(#page-profiles\.active\),\.main:has\(#page-certificates\.active\)\{height:100%;overflow:hidden/);
  assert.match(html, /\.bundle-table-wrap,\.profile-table-wrap,\.certificate-table-wrap\{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain\}/);
  assert.match(html, /id="bundle-create-capabilities"/);
  assert.doesNotMatch(html, /cap-in-app-purchase/);
  assert.doesNotMatch(html, /cap-associated-domains/);
  assert.doesNotMatch(html, /cap-push-placeholder/);
  assert.doesNotMatch(html, /cap-push-broadcast/);
  assert.match(createHandler, /Array\.isArray\(payload\.capabilities\)/);
  assert.match(createHandler, /requestedCapabilities/);
  assert.match(createHandler, /setPushBroadcastSetting/);
  assert.match(createHandler, /warmupBundleIds/);
  assert.match(createHandler, /existingBeforeCreate/);
  assert.match(createHandler, /identifierUnavailable: true/);
  assert.match(createHandler, /appleBundleIdentifierDuplicateError/);
  assert.match(createHandler, /appleBundleIdentifierUnavailableError/);
  assert.doesNotMatch(createHandler, /allowedCapabilities\s*=\s*new Set\(\["IN_APP_PURCHASE",\s*"ASSOCIATED_DOMAINS",\s*"PUSH_NOTIFICATIONS"\]\)/);
  assert.doesNotMatch(createHandler, /const duplicate = responseStatus === 409/);
  assert.match(updateHandler, /Array\.isArray\(payload\.capabilities\)/);
  assert.match(updateHandler, /defaultSettingsForCapability/);
  assert.doesNotMatch(updateHandler, /knownStates/);
  assert.match(renderer, /renderBundleCapabilityEditor/);
  assert.match(renderer, /bundleCapabilityPayloadFromEditor/);
  assert.match(renderer, /<div class="bundle-table-wrap">/);
  assert.match(renderer, /<table class="data-table bundle-table">/);
  assert.match(renderer, /window\.appleDeveloper\.bundleCapabilities\(\)/);
  assert.match(renderer, /bundleCapabilityPayloadFromEditor\("bundle-create-capabilities"\)/);
  assert.match(renderer, /bindBundleCapabilityEditor\("bundle-create-capabilities", \{ allowPushConfigure: false \}\)/);
  assert.match(renderer, /class="bundle-capability-toggle"/);
  assert.match(renderer, /BUNDLE_CAPABILITY_LANGUAGE_KEY/);
  assert.match(renderer, /BUNDLE_CAPABILITY_COMMON_ORDER/);
  assert.match(renderer, /BUNDLE_CAPABILITY_ZH/);
  assert.match(renderer, /苹果登录/);
  assert.match(renderer, /Associated Domains/);
  assert.match(renderer, /关联和回调能力/);
  assert.match(renderer, /Associated Domains（MDM 管理）/);
  assert.match(renderer, /推送通知/);
  assert.match(renderer, /bundleCapabilityIsManagedAssociatedDomains/);
  assert.match(renderer, /"ASSOCIATED_DOMAINS",\s*"IN_APP_PURCHASE"/);
  assert.match(renderer, /bundleCapabilityLanguage === "en"/);
  assert.match(renderer, /sortedBundleCapabilities/);
  assert.doesNotMatch(renderer, /edit-cap-associated/);
  assert.doesNotMatch(renderer, /edit-cap-push/);
});

test("developer account edit updates network settings and locally encrypted password", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/renderer.js"), "utf8");
  const manager = fs.readFileSync(path.join(__dirname, "../src/developer-account-manager.js"), "utf8");
  const updateHandler = main.slice(
    main.indexOf('ipcMain.handle("developer-accounts-update-password",'),
    main.indexOf('ipcMain.handle("developer-accounts-download-certificate-package",'),
  );
  const rendererSave = renderer.slice(
    renderer.indexOf("async function saveDeveloperAccount"),
    renderer.indexOf("async function openSimilarityPage"),
  );
  const managerSubmit = manager.slice(
    manager.indexOf('el("form").addEventListener("submit",'),
    manager.lastIndexOf("loadAccounts();"),
  );

  assert.match(updateHandler, /const storedPassword = password \? encryptLocalSecret\(password\)/);
  assert.match(updateHandler, /UPDATE developer_accounts SET password=\?, remark=\?, proxy_json=\?, browser_proxy_key=\?, connection_mode=\?/);
  assert.match(updateHandler, /keepProxyPassword/);
  assert.match(updateHandler, /saveAppleDeveloperNetwork\(row\.proxy \|\| \{ enabled: false \}\)/);
  assert.doesNotMatch(rendererSave.slice(0, rendererSave.indexOf("if (editingDeveloperAccount)")), /请输入 Apple ID 密码/);
  assert.match(rendererSave, /connectionMode/);
  assert.match(rendererSave, /browserProxyKey/);
  assert.match(rendererSave, /keepProxyPassword/);
  assert.match(managerSubmit, /if \(editingAccount\)[\s\S]*connectionMode[\s\S]*browserProxyKey[\s\S]*keepProxyPassword/);
  assert.match(manager, /el\("password"\)\.required = false/);
});

test("browser proxy launch checks the selected proxy through proxy mode", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const launchHandler = main.slice(
    main.indexOf('ipcMain.handle("developer-accounts-launch",'),
    main.indexOf('ipcMain.handle("developer-account-certificate-status",'),
  );

  assert.match(launchHandler, /const proxy = \{ \.\.\.launchProxy, enabled: true \};/);
  assert.match(launchHandler, /const detected = await detectIPStandalone\(proxy\);/);
  assert.match(launchHandler, /if \(!isProxyDetectOK\(detected\)\)/);
  assert.match(launchHandler, /readAppleDeveloperNetworkFile\(developerAccountKey\(identity\.key, row\.id, row\.apple_id\)\)/);
  assert.match(launchHandler, /connectionMode = "custom_proxy"/);
});

test("one-click certificate automation can add devices and create APNs push certificate", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.html"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
  const artifactSyncHelper = main.slice(
    main.indexOf("async function syncAppleDeveloperArtifact"),
    main.indexOf("async function syncDeveloperAccountP12Password"),
  );
  const createCertificateHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-create-certificate",'),
    main.indexOf('ipcMain.handle("apple-developer-download-certificate",'),
  );
  const profileListHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-profiles",'),
    main.indexOf('ipcMain.handle("apple-developer-profile-bundle",'),
  );
  const profileBundleHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-profile-bundle",'),
    main.indexOf('ipcMain.handle("apple-developer-profile-options",'),
  );
  const syncLocalCertificateHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-sync-local-certificate-artifacts",'),
    main.indexOf('ipcMain.handle("apple-developer-download-automation-zip",'),
  );
  const downloadAutomationZipHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-download-automation-zip",'),
    main.indexOf('ipcMain.handle("apple-developer-revoke-certificate",'),
  );

  assert.match(main, /X-Desktop-Owner-Key/);
  assert.match(artifactSyncHelper, /authServerFetch\(requestPath/);
  assert.match(preload, /syncLocalCertificateArtifacts/);
  assert.match(preload, /profileBundle: payload => ipcRenderer\.invoke\("apple-developer-profile-bundle", payload\)/);
  assert.match(renderer, /startProfileBundleLookups/);
  assert.match(renderer, /waitProfileBundleLookup\(1000, token\)/);
  assert.match(renderer, /cancelProfileBundleLookups/);
  assert.match(renderer, /name !== "profiles"\) cancelProfileBundleLookups\(\)/);
  assert.match(html, /\.main:has\(#page-bundle\.active\),\.main:has\(#page-profiles\.active\),\.main:has\(#page-certificates\.active\)\{height:100%;overflow:hidden/);
  assert.match(html, /\.bundle-table-wrap,\.profile-table-wrap,\.certificate-table-wrap\{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain\}/);
  assert.match(html, /\.bundle-table-wrap \.bundle-table thead th,\.profile-table-wrap \.profile-table thead th,\.certificate-table-wrap \.certificate-table thead th\{position:sticky;top:0;z-index:1\}/);
  assert.match(renderer, /<div class="profile-table-wrap"><table class="data-table profile-table">/);
  assert.match(renderer, /<div class="certificate-table-wrap">/);
  assert.match(renderer, /id="certificates-refresh" type="button" title="刷新" aria-label="刷新"/);
  assert.match(renderer, /el\("certificates-refresh"\)\?\.addEventListener\("click", \(\) => refreshModule\("certificates"\)\)/);
  assert.doesNotMatch(renderer, /id="add-certificate" style=/);
  assert.doesNotMatch(renderer, /onclick="refreshModule\('certificates'\)">刷新/);
  assert.doesNotMatch(renderer, /<div style="overflow:auto"><table class="data-table profile-table">/);
  assert.match(renderer, /<div class="module-actions"><button class="secondary" id="add-profile"/);
  assert.match(renderer, /id="profiles-refresh" type="button" title="刷新" aria-label="刷新"/);
  assert.match(renderer, /el\("profiles-refresh"\)\?\.addEventListener\("click", \(\) => refreshModule\("profiles"\)\)/);
  assert.match(html, /id="profile-bundle-search"/);
  assert.match(html, /id="profile-certificate-search"/);
  assert.match(html, /profile-create-selection/);
  assert.match(html, /每个描述文件只能绑定一张证书/);
  assert.match(renderer, /function renderProfileBundleOptions\(\)/);
  assert.match(renderer, /function renderProfileCertificateOptions\(\)/);
  assert.match(renderer, /type="radio" name="profile-certificate"/);
  assert.match(renderer, /profileSelectedCertificateId \? \[profileSelectedCertificateId\] : \[\]/);
  assert.match(renderer, /id="automation-create-push"/);
  assert.match(renderer, /同时创建推送证书/);
  assert.match(renderer, /createAutomationPushCertificate/);
  assert.match(renderer, /assertAutomationServerSync/);
  assert.match(renderer, /syncAutomationCertificatesToServer/);
  assert.match(renderer, /ensureAutomationPushCapability/);
  assert.match(renderer, /window\.appleDeveloper\.updateBundleId\(\{ id: bundleId/);
  assert.match(renderer, /PUSH_NOTIFICATIONS/);
  assert.match(renderer, /window\.appleDeveloper\.createCertificate\(\{ typeId: "UPV3DW712I", appIdId: bundleId \}\)/);
  assert.match(renderer, /function automationProfileTypeId\(profile = \{\}\)/);
  assert.match(renderer, /async function removeExistingAutomationProfiles\(\{ profiles = \[\], bundleId = "", bundleIdentifier = "", specs = \[\], certificateIds = \[\] \} = \{\}\)/);
  assert.match(renderer, /window\.appleDeveloper\.profileBundle\(\{/);
  assert.match(renderer, /targetTypes\.has\(automationProfileTypeId\(profile\)\)/);
  assert.match(renderer, /profileBundleId === targetBundleId/);
  assert.match(renderer, /targetCertificateIds\.has\(String\(id\)\.trim\(\)\)/);
  assert.match(renderer, /certificateIds: rebuiltCertificateIds/);
  assert.equal((renderer.match(/await removeExistingAutomationProfiles\(\{/g) || []).length, 3);
  assert.doesNotMatch(renderer, /item\.name === spec\.name/);
  assert.match(renderer, /id="automation-add-device"/);
  assert.match(renderer, /openAutomationAddDevice/);
  assert.match(renderer, /openDeviceAddAfterDeviceLoad/);
  assert.match(renderer, /showAddDevice\(result\);\s*return;/);
  assert.match(renderer, /当前组织没有可用测试设备，将只创建 App Store 描述文件/);
  assert.match(html, /automation-add-device/);
  assert.match(html, /automation-push-option/);
  assert.match(profileListHandler, /const profileResult = await appleProfileJSON/);
  assert.match(profileListHandler, /bundleLookupDeferred: true/);
  assert.match(profileListHandler, /relationshipIds/);
  assert.doesNotMatch(profileListHandler, /syncAppleDeveloperProfileArtifact/);
  assert.doesNotMatch(profileListHandler, /enrichAppleProfileBundle/);
  assert.match(profileBundleHandler, /enrichAppleProfileBundle/);
  assert.match(profileBundleHandler, /描述文件包名读取失败/);
  assert.match(syncLocalCertificateHandler, /syncLocalAppleCertificateArtifacts/);
  assert.match(syncLocalCertificateHandler, /syncDeveloperAccountP12Password/);
  assert.match(createCertificateHandler, /UPV3DW712I:\s*"APPLE_PUSH_SERVICES"/);
  assert.match(createCertificateHandler, /ownerId: appIdId/);
  assert.match(createCertificateHandler, /normalizedCertificate/);
  assert.match(downloadAutomationZipHandler, /const isPush = \["JKG5JZ54H7", "UPV3DW712I", "BKLRAVXMGM"\]/);
  assert.match(downloadAutomationZipHandler, /isPush \? "推送证书"/);
});

test("one-click certificate automation uses Mac certificate endpoints", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    const downloadHelper = main.slice(
      main.indexOf("async function fetchAppleCertificateContent"),
      main.indexOf("function forgePublicKeyIdentity"),
    );
    const createCertificateHandler = main.slice(
      main.indexOf('ipcMain.handle("apple-developer-create-certificate",'),
      main.indexOf('ipcMain.handle("apple-developer-download-certificate",'),
    );

    assert.match(main, /APPLE_MAC_CERTIFICATE_TYPE_IDS = new Set\(\["749Y1QAGU7", "HXZEUKP0FP", "2PQI8IDXNH", "OYVN2GW35E", "W0EURJRMC5"\]\)/);
    assert.match(main, /function appleCertificateLegacyPlatform\(typeId\)/);
    assert.match(main, /APPLE_MAC_CERTIFICATE_TYPE_IDS\.has\(String\(typeId \|\| ""\)\) \? "mac" : "ios"/);
    assert.match(main, /function appleCertificateLegacyEndpoint\(typeId, action, platform = ""\)/);
    assert.match(main, /normalizedPlatform === "mac" \|\| normalizedPlatform === "macos" \? "mac"/);
    assert.match(main, /findAppleCertificateCreateType\(certificateCreateBody, typeId\)/);
    assert.match(downloadHelper, /appleCertificateLegacyEndpoint\(typeId, "downloadCertificateContent\.action"\)/);
    assert.match(createCertificateHandler, /certificateCreate\.json/);
    assert.match(createCertificateHandler, /appleCertificateLegacyEndpoint\(typeId, "submitCertificateRequest\.action", appleCreatePlatform\)/);
    assert.doesNotMatch(createCertificateHandler, /account\/ios\/certificate\/submitCertificateRequest\.action/);
  }
});

test("one-click certificate SOCKS requests use a Windows-compatible curl executable", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    assert.match(main, /function curlExecutable\(\)\s*\{[\s\S]*process\.platform === "win32" \? "curl\.exe" : "\/usr\/bin\/curl"/);
    assert.match(main, /execFile\(curlExecutable\(\), \["--config", configPath\]/);
    assert.doesNotMatch(main, /execFile\("\/usr\/bin\/curl", \["--config", configPath\]/);
    assert.match(main, /function generateAppleCSR\(email = ""\)/);
    assert.match(main, /no macOS security\/openssl command is involved/);
    assert.match(main, /syncAppleDeveloperArtifact\(\{ teamId: team\.id, artifactType: "csr"/);
    assert.match(main, /function appleDeveloperCSRSubjectEmail\(\)/);
    assert.match(main, /name: "emailAddress", value: email/);
    assert.match(main, /const syncKey = "shared-csr-email-v1"/);
    assert.match(main, /legacy shared-csr untouched/);
  }
});

test("existing server certificates restore their private key on a new desktop", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    const restoreStart = main.indexOf("async function restoreAppleCertificatePrivateKeyFromServer");
    const restoreHelper = main.slice(restoreStart, main.indexOf("async function syncLocalAppleCertificateArtifacts", restoreStart));
    const syncStart = main.indexOf("async function syncLocalAppleCertificateArtifacts");
    const syncHelper = main.slice(syncStart, main.indexOf("function findAppleCertificateRecord", syncStart));
    const zipStart = main.indexOf('ipcMain.handle("apple-developer-download-automation-zip",');
    const zipHandler = main.slice(zipStart, main.indexOf('ipcMain.handle("apple-developer-revoke-certificate",', zipStart));

    assert.ok(restoreStart >= 0);
    assert.match(restoreHelper, /artifacts\.find\(item => item\.artifact_type === "certificate"/);
    assert.match(restoreHelper, /item\.artifact_type === "private_key"/);
    assert.match(restoreHelper, /forgePublicKeyIdentity\(parsedCertificate\.publicKey\) !== forgePublicKeyIdentity\(parsedPrivateKey\)/);
    assert.match(restoreHelper, /restoredFromServerAt/);
    assert.match(syncHelper, /await restoreAppleCertificatePrivateKeyFromServer/);
    assert.match(zipHandler, /createZipFromDirectory\(folder\)/);
    assert.doesNotMatch(zipHandler, /\/usr\/bin\/ditto/);
  }
});

test("one-click certificate password fields do not retain stale disabled state", () => {
  const rendererFiles = [
    path.join(__dirname, "../src/certificate-manager.js"),
    path.join(__dirname, "../src/certificate-manager.js"),
  ];

  for (const rendererFile of rendererFiles) {
    const renderer = fs.readFileSync(rendererFile, "utf8");
    const helperStart = renderer.indexOf("function updateAutomationPasswordFields");
    const helper = renderer.slice(helperStart, renderer.indexOf("async function ensureAutomationPushCapability", helperStart));
    assert.match(helper, /p12Input\.disabled = false/);
    assert.match(helper, /pushInput\.disabled = false/);
    assert.match(renderer, /change", event => \{ updateAutomationPasswordFields\(\); confirmAutomationRebuildCheckbox/);
  }
});

test("certificate ZIP bundle folders never use the macOS app suffix", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    const helperStart = main.indexOf("function safeBundleFolderName");
    const helperEnd = main.indexOf("\n}\n", helperStart) + 3;
    const safeBundleFolderName = vm.runInNewContext(
      `${main.slice(helperStart, helperEnd)}; safeBundleFolderName`,
    );

    assert.equal(safeBundleFolderName("xiaojingpinci.com.app"), "xiaojingpincicomapp");
    assert.doesNotMatch(safeBundleFolderName("xiaojingpinci.com.app"), /\.app$/i);
    assert.match(main, /const bundleFolderName = safeBundleFolderName\(bundleIdentifier\)/);
  }
});

test("standalone certificate automation verifies then prunes superseded cloud artifacts", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
  const finalizeHandler = main.slice(
    main.indexOf('ipcMain.handle("apple-developer-finalize-automation-artifacts",'),
    main.indexOf('ipcMain.handle("apple-developer-clear-server-certificate-artifacts",'),
  );

  assert.match(main, /artifacts\/prune/);
  assert.match(main, /response\.status === 404/);
  assert.match(main, /pruneSyncedAppleDeveloperArtifactSetLegacy/);
  assert.match(main, /deleteSyncedAppleDeveloperArtifact/);
  assert.match(finalizeHandler, /verifySyncedAppleDeveloperArtifactSet/);
  assert.match(finalizeHandler, /pruneSyncedAppleDeveloperArtifactSet/);
  assert.match(finalizeHandler, /finalVerification/);
  assert.match(finalizeHandler, /certificateScopes/);
  assert.match(finalizeHandler, /profileScopes/);
  assert.equal((renderer.match(/await finalizeAutomationArtifacts\(\{/g) || []).length, 3);
  assert.match(preload, /finalizeAutomationArtifacts/);
});

test("pending developer release shows the Apple release controls and posts the captured request shape", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
  const releaseHelperStart = main.indexOf("async function releaseAppStoreConnectAppVersion");
  const releaseHelper = main.slice(
    releaseHelperStart,
    main.indexOf("async function saveAppStoreConnectAppVersion", releaseHelperStart),
  );
  const releaseModal = renderer.slice(
    renderer.indexOf("async function openAppStoreVersionReleaseModal"),
    renderer.indexOf("const APP_STORE_TERRITORY_REGIONS"),
  );

  assert.match(releaseHelper, /\/iris\/v1\/appStoreVersionReleaseRequests/);
  assert.match(releaseHelper, /type:\s*"appStoreVersionReleaseRequests"/);
  assert.match(releaseHelper, /appStoreVersion:\s*\{\s*data:\s*\{\s*type:\s*"appStoreVersions",\s*id:\s*versionId/);
  assert.match(preload, /releaseAppStoreVersion:\s*payload\s*=>\s*ipcRenderer\.invoke\("app-store-connect-release-app-version",\s*payload\)/);
  assert.match(preload, /cancelAppStoreVersionRelease:\s*payload\s*=>\s*ipcRenderer\.invoke\("app-store-connect-cancel-app-version-release",\s*payload\)/);
  assert.match(renderer, /PENDING_DEVELOPER_RELEASE/);
  assert.match(renderer, /id="app-detail-save" type="button" disabled>保存/);
  assert.match(renderer, /id="app-detail-release" type="button">发布此版本/);
  assert.match(renderer, /你的版本正在等待开发者发布，你只能编辑部分信息/);
  assert.match(renderer, /以下素材和元数据将在你 App 的产品页面上显示/);
  assert.match(renderer, /是否取消发布版本/);
  assert.match(renderer, /发生错误。请稍后重试。/);
  assert.match(main, /\/iris\/v1\/appStoreVersionSubmissions\/\$\{encodeURIComponent\(versionId\)\}/);
  assert.match(main, /method:\s*"DELETE"/);
  assert.match(releaseModal, /territories\s*=\s*\(availability\?\.territories\s*\|\|\s*\[\]\)\.filter\(item\s*=>\s*item\.available\)/);
  assert.match(releaseModal, /territories\.map\(item\s*=>/);
  assert.match(releaseModal, /releaseAppStoreVersion\(\{\s*appId,\s*versionId\s*\}\)/);
  assert.match(releaseModal, /clearAppStoreDetailCache\(appId\)/);
  assert.match(releaseModal, /loadAppStoreDetail\(nextApp,\s*"release",\s*versionId,\s*\{\s*force:\s*true\s*\}\)/);
});

test("App detail preserves content rights from singular JSON API responses", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const normalizerStart = main.indexOf("function normalizeAppStoreApps");
  const normalizerEnd = main.indexOf("function normalizeAppIcpNumberDetail", normalizerStart);

  assert.match(main.slice(normalizerStart, normalizerEnd), /jsonApiRows\(body\)\.filter\(row => row\?\.type === "apps"\)/);
  assert.match(renderer, /DOES_NOT_USE_THIRD_PARTY_CONTENT/);
  assert.match(renderer, /否，此 App 不包含、显示或访问第三方内容。/);
  assert.match(renderer, /class="app-info-readonly"><label>内容版权/);
});

test("App review drafts use submission counts, the official submit panel, and item deletion", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/certificate-preload.js"), "utf8");
  const submitStart = renderer.indexOf("async function submitAppStoreReview");
  const submitFlow = renderer.slice(submitStart, renderer.indexOf("async function deleteAppStoreMediaItem", submitStart));
  const removeStart = main.indexOf("async function removeReviewSubmissionItem");
  const removeFlow = main.slice(removeStart, main.indexOf("async function loadAppStoreConnectInAppPurchaseDetail", removeStart));
  const removeDialogStart = renderer.indexOf("function openAppStoreReviewDraftRemoveConfirmation");
  const removeDialog = renderer.slice(removeDialogStart, renderer.indexOf("function openAppStoreVersionReviewDraftDetailPanel", removeDialogStart));

  assert.match(renderer, /appStoreReviewDraftCount = appStoreReviewDraftRows\(\)\.length/);
  assert.match(submitFlow, /openAppStoreVersionReviewDraftAfterCreate\(result\.reviewSubmissionId\)/);
  assert.doesNotMatch(submitFlow, /openAppStoreReviewIPAPanel/);
  assert.doesNotMatch(submitFlow, /refreshCurrentAppStoreView\(\)/);
  assert.match(submitFlow, /result\.reviewSubmissionId/);
  assert.match(renderer, /data-item-id/);
  assert.match(renderer, /removeAppStoreReviewSubmissionItem/);
  assert.match(preload, /app-store-connect-remove-review-submission-item/);
  assert.match(main, /ipcMain\.handle\("app-store-connect-remove-review-submission-item"/);
  assert.match(removeFlow, /\/iris\/v1\/reviewSubmissionItems\/\$\{encodeURIComponent\(itemId\)\}/);
  assert.match(removeFlow, /method: "DELETE"/);
  assert.match(removeFlow, /\/iris\/v1\/reviewSubmissions\/\$\{encodeURIComponent\(submissionId\)\}/);
  assert.match(removeDialog, /app-review-draft-remove-modal/);
  assert.match(removeDialog, /data-remove/);
  assert.doesNotMatch(removeDialog, /\bconfirm\(/);
  assert.match(main, /platform: String\(attrs\.platform \|\| platforms\[0\] \|\| ""\)/);
  assert.match(main, /const appVersionRef = relationshipData\(item, "appStoreVersion"\)\[0\]/);
  assert.match(main, /type: purchaseVersionRef \? "IN_APP_PURCHASE" : \(appVersionRef \? "APP_STORE_VERSION" : "OTHER"\)/);
  assert.match(renderer, /return items\.some\(item => item\.version\?\.versionString/);
  assert.match(renderer, /return "草稿提交"/);
  assert.match(renderer, /提交草稿 \(\$\{count\}\)/);
  assert.match(renderer, /name: item\.name \|\| existing\.name \|\| ""/);
  assert.match(renderer, /productId: item\.productId \|\| existing\.productId \|\| ""/);
  assert.match(renderer, /purchaseType: item\.purchaseType \|\| existing\.purchaseType \|\| ""/);

  const helperStart = renderer.indexOf("function appStoreReviewSubmissionItems");
  const helperEnd = renderer.indexOf("function appStoreReviewDraftMeta", helperStart);
  const titleFor = vm.runInNewContext(
    `${renderer.slice(helperStart, helperEnd)}; appStoreReviewDraftTitle`,
    { appStoreReviewDraftPlatform: "IOS", appStorePlatformText: platform => platform === "IOS" ? "iOS" : platform },
  );
  assert.equal(titleFor({
    platform: "IOS",
    version: { versionString: "2.1.4" },
    itemCount: 1,
    items: [{ type: "APP_STORE_VERSION", itemType: "appStoreVersions", version: { versionString: "2.1.4" } }],
  }), "iOS 提交草稿 (1)");
  assert.equal(titleFor({
    platform: "",
    version: { versionString: "2.1.3" },
    itemCount: 2,
    items: [{ type: "IN_APP_PURCHASE", itemType: "inAppPurchaseVersions", productId: "dynamic.product" }],
  }), "iOS 提交草稿 (2)");

  const detailTitleStart = renderer.indexOf("function appStoreReviewDraftDetailTitle");
  const detailTitleEnd = renderer.indexOf("function appStoreReviewDraftTypeLabel", detailTitleStart);
  const detailTitleFor = vm.runInNewContext(
    `${renderer.slice(detailTitleStart, detailTitleEnd)}; appStoreReviewDraftDetailTitle`,
    {
      appStoreReviewSubmissionHasAppVersion: submission => submission.items.some(item => item.itemType === "appStoreVersions"),
      appStorePlatformText: platform => platform === "IOS" ? "iOS" : platform,
    },
  );
  assert.equal(detailTitleFor({
    platform: "IOS",
    items: [{ itemType: "appStoreVersions" }],
  }), "草稿提交");
  assert.equal(detailTitleFor({
    platform: "",
    items: [{ itemType: "inAppPurchaseVersions" }],
  }), "草稿提交");
});

test("IAP review batches reuse one dynamic submission and refresh after mutation", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.html"), "utf8");
  const addMainStart = main.indexOf("async function addInAppPurchaseToReview");
  const addMain = main.slice(addMainStart, main.indexOf("async function removeInAppPurchaseFromReview", addMainStart));
  const addBatchStart = renderer.indexOf("async function addSelectedInAppPurchasesToReview");
  const addBatch = renderer.slice(addBatchStart, renderer.indexOf("function appStoreReviewDraftRows", addBatchStart));

  assert.match(addBatch, /Promise\.all\(selected\.map/);
  assert.match(addBatch, /let sharedSubmissionId = ""/);
  assert.match(addBatch, /submissionId: sharedSubmissionId/);
  assert.match(addBatch, /sharedSubmissionId \|\|= String\(result\.reviewDraft\?\.submissionId/);
  assert.match(addBatch, /refreshAppStoreAfterInAppPurchaseReviewChange\(sharedSubmissionId, added\)/);
  assert.doesNotMatch(addBatch, /submissionId:\s*["'][0-9a-f-]{20,}["']/i);

  assert.match(addMain, /const preferredSubmissionId = String\(payload\.submissionId/);
  assert.match(addMain, /let submissionId = preferredSubmissionId/);
  assert.match(main, /async function findReadyForReviewInAppPurchaseSubmission/);
  assert.match(main, /\/items\?include=inAppPurchaseVersion,appStoreVersion/);
  assert.match(main, /hasInAppPurchase && !hasAppVersion/);
  assert.match(addMain, /findReadyForReviewInAppPurchaseSubmission\(appId\)/);
  assert.match(addMain, /const createdItem = await appStoreConnectFetch\("\/iris\/v1\/reviewSubmissionItems"/);
  assert.match(addMain, /refreshRequired: true/);
  assert.match(addMain, /catch \(error\) \{\s*return \{ \.\.\.mutationResult, refreshRequired: true/s);

  assert.match(html, /\.app-detail \.app-review-draft-panel\{width:min\(380px/);
  assert.match(html, /overflow-y:auto;scrollbar-gutter:stable/);
  assert.match(html, /\.app-iap-remove-review-modal \.app-iap-remove-review-dialog\{width:min\(420px/);
  assert.match(html, /body:has\(\.app-review-draft-overlay,\.app-iap-remove-review-modal\) \.review-guidance-float\{display:none\}/);
});

test("App Store Connect session errors are not presented as unsigned terms", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const submitStart = main.indexOf("async function submitAppStoreConnectReview");
  const submitHelper = main.slice(submitStart, main.indexOf("async function submitInAppPurchaseReviewDraft", submitStart));

  assert.match(renderer, /function showAppStoreAccessErrorState/);
  assert.match(renderer, /App Store Connect 会话已过期/);
  assert.match(renderer, /id="app-store-access-retry"/);
  assert.match(submitHelper, /return \{ reviewSubmissionId, detail: await loadAppStoreConnectAppDetail\(appId\) \}/);
  assert.match(submitHelper, /appStoreConnectFetch\("\/iris\/v1\/reviewSubmissionItems"/);
});

test("App Store Connect business requests initialize the dynamic PPM account context", () => {
  const mainFiles = [
    path.join(__dirname, "../src/main.js"),
    path.join(__dirname, "../src/main.js"),
  ];

  for (const mainFile of mainFiles) {
    const main = fs.readFileSync(mainFile, "utf8");
    const businessFetchStart = main.indexOf("async function appStoreConnectBusinessFetch");
    const businessFetch = main.slice(
      businessFetchStart,
      main.indexOf("function normalizeBusinessMessage", businessFetchStart),
    );
    const statusStart = main.indexOf("async function fetchAppStoreConnectBusinessStatus");
    const statusFlow = main.slice(
      statusStart,
      main.indexOf("function appStoreConnectComplianceFormRequest", statusStart),
    );

    assert.match(businessFetch, /"X-CSRF-ITC": "agreements-ui"/);
    assert.match(businessFetch, /sessionRefreshPath: "\/business"/);
    assert.match(businessFetch, /accountLookup\/teamTypes\/ITC\/teamIds\/\$\{encodeURIComponent\(normalizedAccountId\)\}/);
    assert.match(statusFlow, /await initializeAppStoreConnectBusinessContext\(accountId\)/);
    assert.match(main, /establishAppStoreConnectWebSession\(primarySession, options\.sessionRefreshPath \|\| "\/apps", \{/);
  }
});

test("home status refresh runs in parallel and cannot overlap", () => {
  const rendererFiles = [
    path.join(__dirname, "../src/certificate-manager.js"),
    path.join(__dirname, "../src/certificate-manager.js"),
  ];

  for (const rendererFile of rendererFiles) {
    const renderer = fs.readFileSync(rendererFile, "utf8");
    const overviewStart = renderer.indexOf("async function loadHomeOverview");
    const overview = renderer.slice(
      overviewStart,
      renderer.indexOf("function bindHomeEvents", overviewStart),
    );

    assert.match(overview, /if \(homeStatusLoading\) return/);
    assert.match(overview, /await Promise\.all\(/);
    assert.match(overview, /warmAppStoreBusinessStatus\(\{ force \}\)/);
    assert.match(overview, /loadHomeAccountInfo/);
    assert.match(overview, /readDeveloperAgreementStatus/);
    assert.doesNotMatch(overview, /const termsResult = await settle/);
    assert.doesNotMatch(overview, /try \{ await refreshAccess\(false\); \} catch \{\}/);
  }
});

test("in-app purchase review warning follows Apple submission status", () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");

  assert.match(main, /\/iaps\/submissionStatus/);
  assert.match(main, /filter\[stateGroup\]=APPROVED&filter\[inAppPurchaseType\]=CONSUMABLE/);
  assert.match(main, /hasApprovedConsumableIAP/);
  assert.match(main, /missingRequiredPrivacyPolicyData/);
  assert.match(renderer, /currentAppStoreDetail\?\.iapSubmissionStatus/);
  assert.match(renderer, /首个消耗型 App 内购买项目必须随新 App 版本提交。/);
  assert.match(renderer, /<button class="app-review-draft-submit" type="button" \$\{canSubmit \? "" : "disabled"\}>提交以供审核/);

  const helperStart = renderer.indexOf("function appStoreInAppPurchaseDraftWarning");
  const helperEnd = renderer.indexOf("function openInAppPurchaseReviewDraftDetailPanel", helperStart);
  const context = { currentAppStoreDetail: { iapSubmissionStatus: { hasApprovedConsumableIAP: false, missingRequiredPrivacyPolicyData: false } } };
  const warningFor = vm.runInNewContext(`${renderer.slice(helperStart, helperEnd)}; appStoreInAppPurchaseDraftWarning`, context);
  assert.equal(warningFor([{ purchaseType: "CONSUMABLE" }], true), "首个消耗型 App 内购买项目必须随新 App 版本提交。");
  context.currentAppStoreDetail.iapSubmissionStatus.hasApprovedConsumableIAP = true;
  assert.equal(warningFor([{ purchaseType: "CONSUMABLE" }], true), "");
  assert.equal(warningFor([{ purchaseType: "NON_CONSUMABLE" }], false), "若要提交项目以供审核，请为所选平台添加 App 版本。");
});

test("App history uses compact official rows and state-driven status icons", () => {
  const rendererFiles = [
    path.join(__dirname, "../src/certificate-manager.js"),
    path.join(__dirname, "../src/certificate-manager.js"),
  ];
  const htmlFiles = [
    path.join(__dirname, "../src/certificate-manager.html"),
    path.join(__dirname, "../src/certificate-manager.html"),
  ];

  for (const rendererFile of rendererFiles) {
    const renderer = fs.readFileSync(rendererFile, "utf8");
    const historyStart = renderer.indexOf("function renderAppStoreHistoryPane");
    const history = renderer.slice(historyStart, renderer.indexOf("function appStoreHelp", historyStart));
    assert.match(renderer, /function appStoreHistoryStatusText/);
    assert.match(renderer, /function appStoreHistoryDate/);
    assert.match(renderer, /PROCESSING_FOR_DISTRIBUTION:\s*"正在处理以供分发"/);
    assert.match(history, /appStoreStateClass\(item\.state\)/);
    assert.match(history, /appStoreHistoryDate\(item\.date\)/);
    assert.match(history, /app-history-state \$\{escapeHTML\(stateClass\)\}/);
  }

  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, "utf8");
    assert.match(html, /\.app-history-page>h2\{display:none\}/);
    assert.match(html, /\.app-history-row\{[^}]*min-height:51px/);
    assert.match(html, /\.app-history-row\.head\{min-height:35px/);
    assert.match(html, /\.app-history-row strong\.app-history-state\.ok i\{background:#07972f\}/);
  }
});

test("review guidance sync keeps App history separate from review submissions", () => {
  const rendererFiles = [
    path.join(__dirname, "../src/certificate-manager.js"),
    path.join(__dirname, "../src/certificate-manager.js"),
  ];

  for (const rendererFile of rendererFiles) {
    const renderer = fs.readFileSync(rendererFile, "utf8");
    const snapshotStart = renderer.indexOf("async function buildReviewGuidanceAppSnapshot");
    const snapshot = renderer.slice(snapshotStart, renderer.indexOf("function normalizeReviewGuidanceSubmission", snapshotStart));
    assert.match(snapshot, /appHistory:\s*Array\.isArray\(detail\.history\)\s*\?\s*detail\.history\s*:\s*\[\]/);
    assert.match(snapshot, /reviewHistory:\s*detail\.reviewSubmissions\s*\|\|\s*\[\]/);
  }
});
