const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { AppleAuthClient } = require("../src/apple-auth-client");

function loginHTML() {
  const callback = new URL("https://idmsa.apple.com/signin");
  callback.search = new URLSearchParams({ path: "/login/", appIdKey: "a".repeat(64) }).toString();
  return `<script id="embed_login_boot_args">${JSON.stringify({ direct: {
    authWidgetConfig: { authWidgetURL: "https://idmsa.apple.com/appleauth", widgetKey: "b".repeat(64) },
    iframeId: "daw-test-frame", appId: 632, locale: "CN-ZH", signInRequestUrl: encodeURIComponent(callback.toString()),
  } })}</script>`;
}

test("bootstrap follows exposed 301/302 redirects in the same session for both pages", async () => {
  const calls = [];
  const replies = [
    new Response(null, { status: 301, headers: { Location: "/IDMSWebAuth/signin.html?fresh=1" } }),
    new Response(null, { status: 302, headers: { Location: "https://idmsa.apple.com/IDMSWebAuth/signin.html?fresh=2" } }),
    new Response(loginHTML()),
    new Response(null, { status: 307, headers: { Location: "/appleauth/auth/signin?fresh=3" } }),
    new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true,"authAttributes":"fresh-auth"}}</script>'),
  ];
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return replies.shift();
  } });
  await client.bootstrap();
  assert.equal(calls.length, 5);
  assert.equal(calls[1].url.searchParams.get("fresh"), "1");
  assert.equal(calls[2].url.searchParams.get("fresh"), "2");
  assert.equal(calls[4].url.searchParams.get("fresh"), "3");
  assert.ok(calls.every(({ options }) => options.credentials === "include" && options.cache === "no-store"));
  assert.ok(calls.every(({ options }) => !options.body));
  assert.equal(client.state.authAttributes, "fresh-auth");
});

test("bootstrap rejects missing, looping and non-Apple redirect targets before password submission", async () => {
  for (const [location, expected, count] of [
    [null, /跳转缺少目标地址/, 1],
    ["https://example.com/steal", /无效的跳转地址/, 1],
    ["https://idmsa.apple.com.evil.example/", /无效的跳转地址/, 1],
    ["http://idmsa.apple.com/signin", /无效的跳转地址/, 1],
    ["https://name:secret@idmsa.apple.com/signin", /无效的跳转地址/, 1],
    ["/repeat", /跳转循环/, 2],
  ]) {
    let requests = 0;
    const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async () => {
      requests++;
      return new Response(null, { status: 301, headers: location ? { Location: location } : {} });
    } });
    await assert.rejects(() => client.login("person@example.com", "new-password"), expected);
    assert.equal(requests, count);
  }
});

test("bootstrap bounds an endless chain of distinct redirects", async () => {
  let requests = 0;
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { Location: `/signin?hop=${requests}` } });
  } });
  await assert.rejects(() => client.bootstrap(), /跳转次数过多/);
  assert.equal(requests, 9);
});

test("an expired session that redirects past the login widget requests one cache reset", async () => {
  let requests = 0;
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async () => {
    requests++;
    return requests === 1
      ? new Response(null, { status: 301, headers: { Location: "https://developer.apple.com/account/" } })
      : new Response("<html>Expired remembered session</html>");
  } });
  await assert.rejects(() => client.bootstrap(), error => {
    assert.equal(error.appleBootstrapStaleSession, true);
    return true;
  });
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const source = main.slice(main.indexOf("async function loginAppleDeveloperWithBootstrapRecovery"), main.indexOf("async function tryRestoreAppleDeveloperRememberedSession"));
  let attempts = 0;
  let resets = 0;
  const context = {
    appleAuthClient: null,
    createAppleDeveloperAuthClient: () => ({ accountKey: "test", contextGeneration: 1, login: async () => {
      if (++attempts === 1) throw Object.assign(new Error("Missing widget"), { appleBootstrapStaleSession: true });
      return { requires2FA: true };
    } }),
    appleAuthClientIsCurrent: () => true,
    appleDeveloperContextIsCurrent: () => true,
    logAppleDeveloperDiagnostic() {},
    resetAppleDeveloperLoginTransaction: async (_session, options) => {
      assert.equal(options.preserveTrustedCookies, false);
      resets++;
    },
  };
  const login = vm.runInNewContext(`${source}; loginAppleDeveloperWithBootstrapRecovery`, context);
  assert.equal((await login({}, "fingerprint", "person@example.com", "new-password")).result.requires2FA, true);
  assert.equal(attempts, 2);
  assert.equal(resets, 1);
});

test("a changed password bypasses remembered authentication and starts a fresh login", async () => {
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const source = main.slice(main.indexOf('ipcMain.handle("apple-developer-login",'), main.indexOf('ipcMain.handle("apple-developer-auto-login",'));
  let handler;
  let restores = 0;
  let freshLogins = 0;
  const authClient = {};
  const context = {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    appleDeveloperLaunchAppleId: "person@example.com", appleDeveloperLaunchPassword: "old-password",
    appleDeveloperLoginInFlight: false, appleDeveloperLoginCompletionPromise: null, appleAuthClient: null,
    appStoreConnectForceFullLoginRequired: false, appleDeveloperOwnerKey: "test", appleDeveloperRecordId: "1",
    waitForAppleContextRefreshes: async () => {},
    isCertificateManagerIndependent: () => false,
    configureAppleDeveloperNetwork: async () => ({}),
    session: { fromPartition: () => ({}) }, appleDeveloperPartition: () => "test",
    tryRestoreAppleDeveloperRememberedSession: async () => { restores++; return { authenticated: true }; },
    resetAppleDeveloperLoginTransaction: async (_session, options) => assert.equal(options.preserveTrustedCookies, false),
    loginAppleDeveloperWithBootstrapRecovery: async (_session, _fingerprint, _appleId, password) => {
      assert.equal(password, "new-password"); freshLogins++; context.appleAuthClient = authClient;
      return { authClient, result: { requires2FA: true } };
    },
    appleAuthClientIsCurrent: () => true,
  };
  vm.runInNewContext(source, context);
  const response = await handler(null, { appleId: "person@example.com", password: "new-password", clientFingerprint: "A".repeat(80) });
  assert.equal(response.success, true, response.error);
  assert.equal(response.requires2FA, true);
  assert.equal(restores, 0);
  assert.equal(freshLogins, 1);
});

test("HTTP 403 during either bootstrap GET is identified before credential requests", async () => {
  for (const deniedRequest of [1, 2]) {
    let requests = 0;
    const diagnostics = [];
    const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async (_url, options) => {
      assert.equal(options.body, undefined);
      requests++;
      return requests === deniedRequest ? new Response("Forbidden", { status: 403 }) : new Response(loginHTML());
    } }, { logger: (event, payload) => diagnostics.push({ event, ...payload }) });
    await assert.rejects(() => client.login("person@example.com", "new-password"), error => {
      assert.equal(error.appleBootstrapAccessDenied, true);
      assert.equal(error.appleBootstrapStep, deniedRequest === 1 ? "developer-signin-page" : "developer-auth-widget");
      assert.match(error.message, /尚未进行密码验证/);
      return true;
    });
    assert.equal(requests, deniedRequest);
    assert.equal(diagnostics.find(item => item.event === "bootstrap-response" && item.status === 403)?.step, deniedRequest === 1 ? "developer-signin-page" : "developer-auth-widget");
    assert.doesNotMatch(JSON.stringify(diagnostics), /person@example\.com|new-password/);
  }
});

function bootstrapRecoverySession(replies, { nativePages, afterBootstrapError } = {}) {
  const calls = [];
  const session = {
    getUserAgent: () => "Unit Test",
    clearAuthCache: async () => calls.push({ action: "clear-auth-cache" }),
    fetch: async (url, options) => {
      calls.push({ action: "get", url: new URL(url), options });
      assert.equal(options.body, undefined);
      const response = replies.shift();
      assert.ok(response, "unexpected extra request");
      return response;
    },
  };
  let clients = 0;
  const context = {
    appleAuthClient: null,
    createAppleDeveloperAuthClient: (ses, _fingerprint, options = {}) => {
      clients++;
      const client = new AppleAuthClient(ses, {
        ...options,
        ...(nativePages ? { developerLoginPageLoader: async () => {
          calls.push({ action: "native-entry" });
          const page = nativePages.shift();
          assert.ok(page, "unexpected extra native navigation");
          return page;
        } } : {}),
      });
      client.accountKey = "test"; client.contextGeneration = 1;
      client.login = async () => {
        await client.bootstrap();
        if (afterBootstrapError) throw afterBootstrapError;
        return { requires2FA: true };
      };
      return client;
    },
    appleAuthClientIsCurrent: () => true,
    appleDeveloperContextIsCurrent: () => true,
    logAppleDeveloperDiagnostic() {},
    resetAppleDeveloperLoginTransaction: async (_session, options) => {
      assert.equal(options.preserveTrustedCookies, false);
      calls.push({ action: "reset-session" });
    },
  };
  const main = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const source = main.slice(main.indexOf("async function loginAppleDeveloperWithBootstrapRecovery"), main.indexOf("async function tryRestoreAppleDeveloperRememberedSession"));
  const login = vm.runInNewContext(`${source}; loginAppleDeveloperWithBootstrapRecovery`, context);
  return { login: () => login(session, "fingerprint", "person@example.com", "new-password"), calls, clients: () => clients };
}

test("HTTP 403 resets only the current session and retries through the official Developer entry", async () => {
  const harness = bootstrapRecoverySession([
    new Response("Forbidden", { status: 403 }),
    new Response(null, { status: 302, headers: { Location: "https://idmsa.apple.com/IDMSWebAuth/signin.html?fresh=1" } }),
    new Response(loginHTML()),
    new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>'),
  ]);
  assert.equal((await harness.login()).result.requires2FA, true);
  assert.equal(harness.clients(), 2);
  assert.deepEqual(harness.calls.slice(0, 3).map(call => call.action), ["get", "reset-session", "clear-auth-cache"]);
  const gets = harness.calls.filter(call => call.action === "get");
  assert.equal(gets[0].url.origin, "https://idmsa.apple.com");
  assert.equal(gets[1].url.origin, "https://developer.apple.com");
  assert.equal(gets[1].url.pathname, "/login/");
  assert.equal(gets[2].url.origin, "https://idmsa.apple.com");
});

test("persistent HTTP 403 stops after one recovery with a network explanation", async () => {
  const harness = bootstrapRecoverySession([
    new Response("Forbidden", { status: 403 }), new Response("Forbidden", { status: 403 }),
  ]);
  await assert.rejects(harness.login, /已清理当前账户会话.*官方入口重试.*尚未验证密码/);
  assert.equal(harness.clients(), 2);
  assert.equal(harness.calls.filter(call => call.action === "reset-session").length, 1);
  assert.equal(harness.calls.filter(call => call.action === "get").length, 2);
});

test("native Developer entry uses the returned widget parameters in the same session", async () => {
  let loads = 0;
  const requests = [];
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>');
  } }, {
    useDeveloperLoginEntry: true,
    developerLoginPageLoader: async () => {
      loads++;
      return { status: 200, ok: true, redirected: true, url: "https://idmsa.apple.com/IDMSWebAuth/signin.html?fresh=1", html: loginHTML() };
    },
  });
  await client.bootstrap();
  assert.equal(loads, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/appleauth/auth/signin");
  assert.equal(requests[0].url.searchParams.get("widgetKey"), "b".repeat(64));
  assert.equal(requests[0].options.headers.Referer, "https://idmsa.apple.com/IDMSWebAuth/signin.html?fresh=1");
});

test("403 from native Developer entry is reported before any credential or widget request", async () => {
  const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async () => assert.fail("no credentials should be sent") }, {
    useDeveloperLoginEntry: true,
    developerLoginPageLoader: async () => ({ status: 403, ok: false, url: "https://developer.apple.com/login/", html: "Forbidden" }),
  });
  await assert.rejects(() => client.login("person@example.com", "new-password"), error => {
    assert.equal(error.appleBootstrapAccessDenied, true);
    return true;
  });
});

test("empty and invalid bootstrap pages are identified before credential requests", async () => {
  for (const step of ["developer-signin-page", "developer-auth-widget"]) {
    for (const status of [204, 200]) {
      const diagnostics = [];
      let gets = 0;
      const client = new AppleAuthClient({ getUserAgent: () => "Unit Test", fetch: async (_url, options) => {
        assert.equal(options.body, undefined);
        gets++;
        if (step === "developer-auth-widget" && gets === 1) return new Response(loginHTML());
        return new Response(status === 204 ? null : "<html>No authentication configuration</html>", { status });
      } }, { logger: (event, payload) => diagnostics.push({ event, ...payload }) });
      await assert.rejects(() => client.login("person@example.com", "new-password"), error => {
        assert.equal(error.appleBootstrapMissingParameters, true);
        assert.equal(error.appleBootstrapStep, step);
        assert.equal(error.appleBootstrapStatus, status);
        assert.equal(error.appleBootstrapReason, status === 204 ? "empty-page" : step === "developer-auth-widget" ? "invalid-widget-parameters" : "invalid-login-parameters");
        return true;
      });
      assert.equal(gets, step === "developer-signin-page" ? 1 : 2);
      assert.equal(diagnostics.find(row => row.event === "bootstrap-parameters-missing")?.status, status);
      assert.doesNotMatch(JSON.stringify(diagnostics), /person@example\.com|new-password|No authentication configuration/);
    }
  }
});

test("204 and a 200 page without config recover once using native Developer navigation", async () => {
  for (const response of [new Response(null, { status: 204 }), new Response("<html>Stale page</html>")]) {
    const harness = bootstrapRecoverySession([
      response,
      new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>'),
    ], { nativePages: [{ status: 200, ok: true, url: "https://idmsa.apple.com/IDMSWebAuth/signin.html?fresh=1", html: loginHTML() }] });
    assert.equal((await harness.login()).result.requires2FA, true);
    assert.equal(harness.clients(), 2);
    assert.deepEqual(harness.calls.map(call => call.action), ["get", "reset-session", "clear-auth-cache", "native-entry", "get"]);
    assert.equal(harness.calls.at(-1).url.pathname, "/appleauth/auth/signin");
  }
});

test("empty widget bootstrap also uses native recovery before credentials", async () => {
  const harness = bootstrapRecoverySession([
    new Response(loginHTML()), new Response(null, { status: 204 }),
    new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>'),
  ], { nativePages: [{ status: 200, ok: true, url: "https://idmsa.apple.com/IDMSWebAuth/signin.html", html: loginHTML() }] });
  assert.equal((await harness.login()).result.requires2FA, true);
  assert.equal(harness.calls.filter(call => call.action === "native-entry").length, 1);
  assert.equal(harness.calls.filter(call => call.action === "reset-session").length, 1);
});

test("persistent missing parameters stop after one native recovery with an accurate status", async () => {
  for (const status of [204, 200]) {
    const harness = bootstrapRecoverySession([new Response(null, { status: 204 })], {
      nativePages: [{ status, ok: true, url: "https://idmsa.apple.com/IDMSWebAuth/signin.html", html: status === 204 ? "" : "<html>No config</html>" }],
    });
    await assert.rejects(harness.login, error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /已清理当前账户会话.*官方入口重试.*尚未验证密码/);
      assert.equal(error.message.includes("页面为空"), status === 204);
      return true;
    });
    assert.equal(harness.clients(), 2);
    assert.equal(harness.calls.filter(call => call.action === "reset-session").length, 1);
    assert.equal(harness.calls.filter(call => call.action === "get").length, 1);
  }
});

test("credential rejection after valid bootstrap is never retried or treated as a page failure", async () => {
  const passwordError = new Error("请检查输入的账户信息并重试。-20101");
  const harness = bootstrapRecoverySession([
    new Response(loginHTML()),
    new Response('<script class="boot_args">{"direct":{"enableSRPAuth":true}}</script>'),
  ], { afterBootstrapError: passwordError });
  await assert.rejects(harness.login, error => error === passwordError);
  assert.equal(harness.clients(), 1);
  assert.equal(harness.calls.filter(call => call.action === "reset-session").length, 0);
});

test("missing bootstrap parameters are not presented as an expired proxy", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
  const source = renderer.slice(renderer.indexOf("function isProxyExpiredLoginError("), renderer.indexOf("function setLoginError("));
  const classify = vm.runInNewContext(`${source}; isProxyExpiredLoginError`);
  assert.equal(classify(new Error("Apple 登录页未返回有效认证参数（HTTP 204，页面为空）。请检查该账户的代理配置。此时尚未验证密码。")), false);
  assert.equal(classify(new Error("ERR_PROXY_CONNECTION_FAILED")), true);
});
