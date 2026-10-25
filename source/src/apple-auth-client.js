const crypto = require("node:crypto");

const AUTH_ORIGIN = "https://idmsa.apple.com";
const AUTH_BASE = `${AUTH_ORIGIN}/appleauth/auth`;
const ASC_ORIGIN = "https://appstoreconnect.apple.com";
// Service constants from App Store Connect's current IDMS widget. They are
// stable service identifiers, unlike the per-login frame/session values.
const WIDGET_KEY = "e0b80c3bf78523bfe80974d320935bfa30add02e1bff88ec2166c6bd5a706c42";
const ASC_DOMAIN_ID = "3";
const DEVELOPER_WIDGET_KEY = "891bd3417a7776362562d2197f89480a8547b108fd934911bcbea0110d07f757";
const DEVELOPER_LOGIN_URL = "https://developer.apple.com/login/?return=%2Fcn%2F";
function bootstrapAccessDeniedError(step) {
  const error = new Error("Apple 登录页请求被拒绝 (403)，尚未进行密码验证");
  error.appleBootstrapAccessDenied = true;
  error.appleBootstrapStep = step;
  return error;
}
const N = BigInt("0x" + (
  "AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294 3DB56050 " +
  "A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D CD7F48A9 DA04FD50 " +
  "E8083969 EDB767B0 CF609517 9A163AB3 661A05FB D5FAAAE8 2918A996 2F0B93B8 " +
  "55F97993 EC975EEA A80D740A DBF4FF74 7359D041 D5C33EA7 1D281E44 6B14773B " +
  "CA97B43A 23FB8016 76BD207A 436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 " +
  "544523B5 24B0D57D 5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 " +
  "AF874E73 03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6 " +
  "94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F 9E4AFF73"
).replace(/\s/g, ""));
const G = 2n;
const PAD_LENGTH = 256;

function sha256(...parts) { const h = crypto.createHash("sha256"); parts.forEach(part => h.update(part)); return h.digest(); }
function toBigInt(buffer) { return BigInt("0x" + (Buffer.from(buffer).toString("hex") || "0")); }
function fromBigInt(value, size = 0) {
  let hex = value.toString(16); if (hex.length % 2) hex = "0" + hex;
  const raw = Buffer.from(hex, "hex");
  return size && raw.length < size ? Buffer.concat([Buffer.alloc(size - raw.length), raw]) : raw;
}
function mod(value, modulus) { const result = value % modulus; return result < 0n ? result + modulus : result; }
function modPow(base, exponent, modulus) {
  let result = 1n; base = mod(base, modulus);
  while (exponent > 0n) { if (exponent & 1n) result = result * base % modulus; exponent >>= 1n; base = base * base % modulus; }
  return result;
}

class AppleSRP {
  constructor(accountName) {
    this.accountName = String(accountName).toLowerCase();
    this.privateValue = toBigInt(crypto.randomBytes(256));
    this.publicValue = modPow(G, this.privateValue, N);
  }
  publicBase64() { return fromBigInt(this.publicValue, PAD_LENGTH).toString("base64"); }
  evidence({ iterations, serverPublicValue, salt, password, protocol = "s2k" }) {
    const BBuffer = Buffer.from(serverPublicValue, "base64");
    const saltBuffer = Buffer.from(salt, "base64");
    const B = toBigInt(BBuffer);
    const passwordHash = sha256(Buffer.from(password, "utf8"));
    const pbkdfPassword = protocol === "s2k"
      ? passwordHash
      : Buffer.from(passwordHash.toString("hex"), "utf8");
    const derived = crypto.pbkdf2Sync(pbkdfPassword, saltBuffer, Number(iterations), 32, "sha256");
    const x = toBigInt(sha256(saltBuffer, sha256(Buffer.from(":"), derived)));
    const ABuffer = fromBigInt(this.publicValue, PAD_LENGTH);
    const BPad = BBuffer.length === PAD_LENGTH ? BBuffer : fromBigInt(B, PAD_LENGTH);
    const u = toBigInt(sha256(ABuffer, BPad));
    const k = toBigInt(sha256(fromBigInt(N, PAD_LENGTH), fromBigInt(G, PAD_LENGTH)));
    const S = modPow(mod(B - k * modPow(G, x, N), N), this.privateValue + u * x, N);
    const K = sha256(fromBigInt(S, PAD_LENGTH));
    const hN = sha256(fromBigInt(N, PAD_LENGTH));
    const hg = sha256(fromBigInt(G, PAD_LENGTH));
    const xor = Buffer.alloc(hN.length); for (let i = 0; i < xor.length; i++) xor[i] = hN[i] ^ hg[i];
    const hI = sha256(Buffer.from(this.accountName, "utf8"));
    // Apple's worker pads B for u, but uses the original decoded B bytes in M1.
    const M1 = sha256(xor, hI, saltBuffer, ABuffer, BBuffer, K);
    const M2 = sha256(ABuffer, M1, K);
    return { m1: M1.toString("base64"), m2: M2.toString("base64") };
  }
}

function leadingZeroBits(buffer) {
  let count = 0;
  for (const byte of buffer) { if (byte === 0) { count += 8; continue; } for (let bit = 7; bit >= 0 && !(byte & (1 << bit)); bit--) count++; break; }
  return count;
}
function generateHashcash(challenge, bits) {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const prefix = `1:${bits}:${timestamp}:${challenge}`;
  for (let counter = 0; counter < 20_000_000; counter++) {
    const stamp = `${prefix}:${counter}`;
    if (leadingZeroBits(crypto.createHash("sha1").update(stamp).digest()) >= Number(bits)) return stamp;
  }
  throw new Error("Apple Hashcash 计算失败");
}

function parseBootDirect(html, predicate = info => info?.enableSRPAuth) {
  const blocks = [...String(html).matchAll(/<script[^>]*class=["']boot_args["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1]);
      const direct = data?.direct || data;
      if (predicate(direct, data)) return direct;
    } catch {}
  }
  return null;
}
function parseBootData(html) {
  const direct = parseBootDirect(html, info => info?.enableSRPAuth);
  if (direct) return direct;
  throw new Error("无法读取 Apple 认证启动参数");
}
function parseDeveloperLoginConfig(html) {
  const match = String(html).match(/<script[^>]*id=["']embed_login_boot_args["'][^>]*>([\s\S]*?)<\/script>/i);
  let direct;
  try { direct = JSON.parse(match?.[1] || "")?.direct; } catch {}
  const config = direct?.authWidgetConfig;
  let callback;
  try { callback = new URL(decodeURIComponent(direct?.signInRequestUrl || "")); } catch {}
  if (!config || !/^[a-f0-9]{64}$/i.test(String(config.widgetKey || "")) ||
      !String(direct.iframeId || "").startsWith("daw-") ||
      !/^\d+$/.test(String(direct.appId || "")) ||
      !/^[A-Z]{2}-[A-Z]{2}$/.test(String(direct.locale || "")) ||
      !/^https:\/\/idmsa\.apple\.com\/appleauth\/?$/.test(String(config.authWidgetURL || "")) ||
      callback?.origin !== AUTH_ORIGIN || callback.pathname !== "/signin" ||
      !/^[a-f0-9]{64}$/i.test(String(callback.searchParams.get("appIdKey") || "")) ||
      !callback.searchParams.get("path")) {
    throw new Error("无法读取 Apple Developer 登录页的认证参数，请稍后重试");
  }
  return { widgetKey: config.widgetKey, frameId: direct.iframeId, appId: String(direct.appId), locale: direct.locale, skVersion: String(config.skVersion || "7"), callbackAppIdKey: callback.searchParams.get("appIdKey"), callbackPath: callback.searchParams.get("path") };
}
async function readBody(response) { const text = await response.text(); try { return text ? JSON.parse(text) : {}; } catch { return { text }; } }
function asciiJSONStringify(value) {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function diagnosticHash(value) {
  const text = String(value || "");
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}
function diagnosticClientInfo(headerValue) {
  try {
    const parsed = JSON.parse(String(headerValue || ""));
    return {
      userAgent: String(parsed.U || ""),
      locale: String(parsed.L || ""),
      timezone: String(parsed.Z || ""),
      version: String(parsed.V || ""),
      fingerprintLength: String(parsed.F || "").length,
      fingerprintHash: diagnosticHash(parsed.F || ""),
    };
  } catch {
    return { parseError: true, length: String(headerValue || "").length };
  }
}
function diagnosticHeaders(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  return {
    accept: lower.accept || "",
    contentType: lower["content-type"] || "",
    requestedWith: lower["x-requested-with"] || "",
    origin: lower.origin || "",
    referer: lower.referer || "",
    domainId: lower["x-apple-domain-id"] || "",
    widgetKeyHash: diagnosticHash(lower["x-apple-widget-key"] || ""),
    frameIdHash: diagnosticHash(lower["x-apple-frame-id"] || ""),
    hasScnt: !!lower.scnt,
    scntHash: diagnosticHash(lower.scnt || ""),
    hasSessionId: !!lower["x-apple-id-session-id"],
    sessionIdHash: diagnosticHash(lower["x-apple-id-session-id"] || ""),
    hasAuthAttributes: !!lower["x-apple-auth-attributes"],
    authAttributesHash: diagnosticHash(lower["x-apple-auth-attributes"] || ""),
    clientInfo: diagnosticClientInfo(lower["x-apple-i-fd-client-info"] || ""),
  };
}
function diagnosticBody(data) {
  if (data === undefined) return null;
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/password/i.test(key)) output[key] = "[redacted]";
      else if (/accountName/i.test(key)) output[key] = { length: String(item || "").length, hash: diagnosticHash(item || "") };
      else if (key === "code") output[key] = { length: String(item || "").length };
      else if (["a", "m1", "m2", "c"].includes(key)) output[key] = { length: String(item || "").length, hash: diagnosticHash(item || "") };
      else output[key] = visit(item);
    }
    return output;
  };
  return visit(data);
}
function diagnosticResponseHeaders(headers) {
  const get = name => String(headers.get(name) || "");
  return {
    contentType: get("content-type"),
    hasScnt: !!get("scnt"),
    scntHash: diagnosticHash(get("scnt")),
    hasSessionId: !!get("x-apple-id-session-id"),
    sessionIdHash: diagnosticHash(get("x-apple-id-session-id")),
    hasAuthAttributes: !!get("x-apple-auth-attributes"),
    authAttributesHash: diagnosticHash(get("x-apple-auth-attributes")),
    setCookieNames: String(get("set-cookie") || "").split(/,(?=[^;,]+=)/).map(item => item.split("=")[0].trim()).filter(Boolean),
  };
}
function diagnosticResponseBody(body) {
  const result = {
    keys: body && typeof body === "object" ? Object.keys(body) : [],
    authType: String(body?.authType || ""),
    resultCode: body?.resultCode ?? "",
    referrerQueryLength: String(authReferrerQuery(body) || "").length,
  };
  const errors = [body?.service_errors, body?.serviceErrors, body?.errors].find(Array.isArray) || [];
  if (errors.length) result.errors = errors.slice(0, 3).map(error => ({
    code: String(error?.code || error?.errorCode || error?.status || ""),
    message: String(error?.message || error?.errorMessage || error?.title || ""),
  }));
  if (body?.text) {
    result.textLength = String(body.text).length;
    try {
      const info = secondFactorAuthInfo(body);
      result.bootKeys = info && typeof info === "object" ? Object.keys(info).slice(0, 20) : [];
      result.bootAuthType = String(info?.authType || info?.authUserType || "");
      result.bootReferrerQueryLength = String(authReferrerQuery(info) || "").length;
      result.trustedPhoneCount = trustedPhoneNumbers(info).length;
    } catch {}
  }
  return result;
}
function appleError(body, fallback) {
  if (body?.securityCode?.securityCodeLocked || body?.securityCode?.tooManyCodesValidated) {
    return "验证码输入错误次数过多，Apple 已暂时锁定验证，请稍后再试";
  }
  if (body?.securityCode?.securityCodeCooldown || body?.securityCode?.tooManyCodesSent) {
    return "验证码发送次数过多，请稍后再试";
  }
  const candidates = [body?.service_errors?.[0], body?.serviceErrors?.[0], body?.errors?.[0], body?.error, body];
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === "string") return item;
    const code = item.code || item.errorCode || item.status;
    const message = item.message || item.errorMessage || item.title;
    if (message || code) return [message, code && `code=${code}`].filter(Boolean).join(" ");
  }
  return fallback;
}
function authReferrerQuery(body) {
  const value = String(
    body?.referrerQuery ||
    body?.bootData?.referrerQuery ||
    body?.direct?.referrerQuery ||
    body?.twoSV?.referrerQuery ||
    body?.bootData?.twoSV?.referrerQuery ||
    ""
  ).trim();
  return value && value.startsWith("?") ? value : "";
}

function twoFactorAuthAppHeader(appKey, env = 1) {
  const key = String(appKey || "").trim();
  if (!key) return "";
  return Buffer.from(`${key}:${env || 1}::true::false::::::`, "utf8").toString("base64");
}

function findNestedString(value, keys, depth = 0, visited = new WeakSet()) {
  if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) return "";
  visited.add(value);
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, keys, depth + 1, visited);
      if (found) return found;
    }
    return "";
  }
  for (const item of Object.values(value)) {
    const found = findNestedString(item, keys, depth + 1, visited);
    if (found) return found;
  }
  return "";
}

function twoFactorAuthAppFromAuthInfo(info) {
  const direct = info?.direct || info;
  const existing = findNestedString(direct, ["twoFactorAuthApp", "tfaa"]);
  if (existing) return existing;
  const appKey = findNestedString(direct, ["twoFactorAuthAppKey"]);
  if (!appKey) return "";
  return twoFactorAuthAppHeader(appKey, findNestedString(direct, ["twoFactorAuthEnv"]) || "1");
}

function secondFactorAuthInfo(body) {
  if (!body?.text) return body || {};
  const blocks = [...String(body.text).matchAll(/<script[^>]*class=["']boot_args["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const info = parsed?.direct || parsed;
      if (info?.authUserType || info?.authType || info?.twoSV) return info;
    } catch {}
  }
  return body;
}

function trustedPhoneNumbers(body) {
  const phones = [];
  const visited = new WeakSet();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (Array.isArray(value.trustedPhoneNumbers)) phones.push(...value.trustedPhoneNumbers);
    if (value.trustedPhoneNumber && typeof value.trustedPhoneNumber === "object") {
      phones.push(value.trustedPhoneNumber);
    }
    Object.values(value).forEach(item => visit(item, depth + 1));
  };
  visit(body);
  const seen = new Set();
  return phones.map(phone => {
    const nested = phone?.phoneNumber && typeof phone.phoneNumber === "object" ? phone.phoneNumber : {};
    const id = phone?.id ?? phone?.phoneNumberId ?? nested.id;
    return { phone, nested, id };
  }).filter(({ id }) => {
    if (id == null) return false;
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ phone, nested, id }) => ({
    id,
    numberWithDialCode: String(phone.numberWithDialCode || nested.numberWithDialCode || ""),
    numberWithCountryCode: String(phone.numberWithCountryCode || nested.numberWithCountryCode || ""),
    phoneNumber: String(typeof phone.phoneNumber === "string" ? phone.phoneNumber : nested.number || ""),
    number: String(phone.number || nested.number || ""),
    obfuscatedNumber: String(phone.obfuscatedNumber || nested.obfuscatedNumber || ""),
    lastTwoDigits: String(phone.lastTwoDigits || nested.lastTwoDigits || ""),
    pushMode: String(phone.pushMode || "sms"),
  }));
}

function initialSecondFactor(info, trustedPhones) {
  const verification = info?.twoSV?.phoneNumberVerification;
  const method = verification?.mode === "sms" || info?.hasTrustedDevices === false || verification?.noTrustedDevices === true
    ? "sms" : "device";
  if (method === "device") return { method, automaticallySent: true };
  const selectedId = verification?.phoneNumber?.id ?? verification?.trustedPhoneNumber?.id;
  const selectedPhone = trustedPhones.find(phone => String(phone.id) === String(selectedId)) ||
    (selectedId == null && trustedPhones.length === 1 ? trustedPhones[0] : null);
  return {
    method,
    phoneId: selectedPhone?.id ?? null,
    automaticallySent: verification?.mode === "sms" && !!selectedPhone,
  };
}

class AppleAuthClient {
  constructor(electronSession, options = {}) {
    this.session = electronSession;
    this.clientFingerprint = String(options.clientFingerprint || "").trim();
    this.frameId = crypto.randomUUID();
    this.state = {};
    this.srp = null;
    this.authInfo = null;
    this.referrerQuery = "";
    this.secondFactor = null;
    this.secondFactorAuthInitialized = false;
    this.onDemand2FAToken = "";
    this.onDemand2FAAppKey = "";
    this.onDemand2FAEnv = "";
    this.oauth = options.oauth || null;
    this.skipTrust = !!options.skipTrust;
    this.logger = typeof options.logger === "function" ? options.logger : null;
    this.useDeveloperLoginEntry = options.useDeveloperLoginEntry === true;
    this.developerLoginPageLoader = typeof options.developerLoginPageLoader === "function" ? options.developerLoginPageLoader : null;
    // App Store Connect uses this widget for on-demand MFA. Developer login
    // replaces it with the widget key returned by IDMSWebAuth/signin.html.
    this.widgetKey = WIDGET_KEY;
    this.developerLoginConfig = null;
  }
  diagnostic(eventName, payload = {}) {
    try { if (this.logger) this.logger(eventName, payload); } catch {}
  }
  rotate(response) {
    for (const [header, key] of [["scnt", "scnt"], ["x-apple-id-session-id", "sessionId"], ["x-apple-auth-attributes", "authAttributes"], ["x-apple-2fa-app", "twoFactorAuthApp"], ["x-apple-identity-token", "identityToken"]]) {
      const value = response.headers.get(header); if (value) this.state[key] = value;
    }
    const hcChallenge = response.headers.get("x-apple-hc-challenge");
    const hcBits = response.headers.get("x-apple-hc-bits");
    if (hcChallenge) this.state.hashcash = { hcChallenge, hcBits: Number(hcBits || 0) };
  }
  headers(extra = {}, options = {}) {
    const userAgent = this.session.getUserAgent();
    const clientInfo = { U: userAgent, L: "zh-CN", Z: "GMT+08:00", V: "1.1", ...(this.clientFingerprint ? { F: this.clientFingerprint } : {}) };
    const oauthHeaders = this.oauth ? {
      "X-Apple-Domain-Id": "11",
      "X-Apple-OAuth-State": this.frameId,
      "X-Apple-OAuth-Response-Mode": "web_message",
      "X-Apple-OAuth-Client-Id": this.oauth.clientId,
      "X-Apple-OAuth-Redirect-URI": this.oauth.redirectURI,
      "X-Apple-OAuth-Response-Type": "code",
      "X-Apple-OAuth-Client-Type": "firstPartyAuth",
    } : {};
    const includeRequestedWith = options.xmlHttpRequest !== false;
    const includeOrigin = options.origin !== false;
    const result = {
      "Accept": options.accept || "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/json",
      ...(includeRequestedWith ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      "X-Apple-Widget-Key": this.oauth?.clientId || this.widgetKey || WIDGET_KEY,
      "X-Apple-Frame-Id": this.frameId,
      "X-Apple-Locale": this.developerLoginConfig?.locale || "zh_CN",
      "X-Apple-Trusted-Domain": this.developerLoginConfig ? AUTH_ORIGIN : "true",
      "X-Apple-Privacy-Consent": "true",
      ...(!this.developerLoginConfig ? { "X-Apple-Privacy-Consent-Accepted": "true" } : {}),
      "X-Apple-I-FD-Client-Info": asciiJSONStringify(clientInfo),
      ...(includeOrigin ? { "Origin": AUTH_ORIGIN } : {}),
      "Referer": `${AUTH_ORIGIN}/`,
      ...(!this.oauth && !this.developerLoginConfig ? { "X-Apple-Domain-Id": ASC_DOMAIN_ID } : {}),
      ...(this.developerLoginConfig?.appId || this.oauth?.clientId ? { "X-Apple-App-Id": this.developerLoginConfig?.appId || this.oauth.clientId } : {}),
      ...oauthHeaders,
      ...(this.state.scnt ? { scnt: this.state.scnt } : {}),
      ...(this.state.sessionId ? { "X-Apple-ID-Session-Id": this.state.sessionId } : {}),
      ...(this.state.authAttributes ? { "X-Apple-Auth-Attributes": this.state.authAttributes } : {}),
      ...(this.state.identityToken ? { "X-Apple-Identity-Token": this.state.identityToken } : {}),
      ...(this.state.twoFactorAuthApp ? { "X-Apple-2FA-App": this.state.twoFactorAuthApp } : {}),
      ...extra,
    };
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== null && value !== false));
  }
  async request(path, { method = "GET", data, headers = {}, accept, xmlHttpRequest = true, origin = true } = {}) {
    const url = path.startsWith("http") ? path : `${AUTH_BASE}${path}`;
    const requestHeaders = this.headers(headers, { accept, xmlHttpRequest, origin });
    const startedAt = Date.now();
    let response;
    try {
      response = await this.session.fetch(url, {
        method, headers: requestHeaders, credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    } catch (error) {
      this.diagnostic("request-error", { method, url, headers: diagnosticHeaders(requestHeaders), body: diagnosticBody(data), error: error.message });
      throw error;
    }
    this.rotate(response);
    const body = await readBody(response);
    this.diagnostic("request", {
      method,
      url,
      durationMs: Date.now() - startedAt,
      request: { headers: diagnosticHeaders(requestHeaders), body: diagnosticBody(data) },
      response: { status: response.status, ok: response.ok, headers: diagnosticResponseHeaders(response.headers), body: diagnosticResponseBody(body) },
    });
    return { response, body };
  }
  async bootstrap() {
    if (this.oauth) {
      const query = new URLSearchParams({
        frame_id: this.frameId, skVersion: "7", iframeId: this.frameId,
        client_id: this.oauth.clientId, redirect_uri: this.oauth.redirectURI,
        response_type: "code", response_mode: "web_message", state: this.frameId,
        authVersion: "8.0.2",
      });
      const response = await this.session.fetch(`${AUTH_BASE}/authorize/signin?${query}`, {
        signal: AbortSignal.timeout(30000), headers: { Accept: "text/html", Referer: `${this.oauth.redirectURI}/` },
      });
      this.rotate(response);
      await response.text();
      if (!response.ok) throw new Error(`Apple Account 认证初始化失败 (${response.status})`);
      return;
    }
    const developerSignin = new URL(`${AUTH_ORIGIN}/IDMSWebAuth/signin.html`);
    developerSignin.search = new URLSearchParams({ path: "/login/?return=%2Fcn%2F", appIdKey: DEVELOPER_WIDGET_KEY, rv: "0" }).toString();
    let followedDeveloperRedirect = false;
    const bootstrapFetch = async (step, url, options) => {
      try {
        let currentURL = url;
        const visited = new Set();
        // Some Electron/proxy responses expose a redirect even with `follow`.
        // Complete only these bootstrap GETs; never replay a password request.
        for (let hop = 0; hop <= 8; hop++) {
          if (visited.has(currentURL)) throw new Error("Apple 登录页跳转循环，请检查代理网络后重试");
          visited.add(currentURL);
          const response = await this.session.fetch(currentURL, { ...options, cache: "no-store" });
          if (![301, 302, 303, 307, 308].includes(response.status)) {
            const target = new URL(response.url || currentURL);
            this.diagnostic("bootstrap-response", {
              step, status: response.status, host: target.hostname, path: target.pathname,
              headers: diagnosticResponseHeaders(response.headers),
            });
            if (response.status === 403) {
              await response.body?.cancel();
              throw bootstrapAccessDeniedError(step);
            }
            return response;
          }
          const location = response.headers.get("location");
          if (!location) throw new Error(`Apple 登录页跳转缺少目标地址 (${response.status})，请检查代理网络后重试`);
          const target = new URL(location, response.url || currentURL);
          if (target.protocol !== "https:" || target.username || target.password ||
              !["idmsa.apple.com", "developer.apple.com", "account.apple.com", "appleid.apple.com"].includes(target.hostname)) {
            throw new Error("Apple 登录页返回了无效的跳转地址，请检查代理网络后重试");
          }
          this.diagnostic("bootstrap-redirect", { step, status: response.status, hop: hop + 1, host: target.hostname, path: target.pathname });
          if (step === "developer-signin-page") followedDeveloperRedirect = true;
          await response.body?.cancel();
          currentURL = target.toString();
        }
        throw new Error("Apple 登录页跳转次数过多，请检查代理网络后重试");
      } catch (error) {
        const message = String(error?.message || error).replace(/https?:\/\/[^\s)]+/gi, "[url]");
        this.diagnostic("bootstrap-error", { step, error: message });
        if (/ERR_BLOCKED_BY_CLIENT/i.test(`${error?.code || ""} ${error?.message || ""}`)) {
          error.appleBootstrapBlocked = true;
          error.appleBootstrapStep = step;
        }
        throw error;
      }
    };
    // Electron rejects a cross-origin Referer on session.fetch before sending the request.
    let landing, landingHtml;
    if (this.useDeveloperLoginEntry && this.developerLoginPageLoader) {
      landing = await this.developerLoginPageLoader();
      landingHtml = landing.html;
      if (landing.status === 403) throw bootstrapAccessDeniedError("developer-signin-page");
    } else {
      landing = await bootstrapFetch("developer-signin-page", this.useDeveloperLoginEntry ? DEVELOPER_LOGIN_URL : developerSignin.toString(), {
        credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000),
        headers: { Accept: "text/html" },
      });
      landingHtml = await landing.text();
    }
    if (!landing.ok) throw new Error(`Apple Developer 登录页初始化失败 (${landing.status})`);
    try {
      this.developerLoginConfig = parseDeveloperLoginConfig(landingHtml);
    } catch (error) {
      // A 204/empty page or a stale session can omit the widget without an
      // exposed redirect. Recover once before any credential request.
      error.appleBootstrapMissingParameters = true;
      error.appleBootstrapStep = "developer-signin-page";
      error.appleBootstrapStatus = landing.status;
      error.appleBootstrapReason = String(landingHtml || "").trim() ? "invalid-login-parameters" : "empty-page";
      if (followedDeveloperRedirect || landing.redirected) error.appleBootstrapStaleSession = true;
      this.diagnostic("bootstrap-parameters-missing", {
        step: error.appleBootstrapStep, status: landing.status, reason: error.appleBootstrapReason,
      });
      throw error;
    }
    this.widgetKey = this.developerLoginConfig.widgetKey;
    this.frameId = this.developerLoginConfig.frameId;
    const query = new URLSearchParams({ widgetKey: this.widgetKey, language: this.developerLoginConfig.locale, skVersion: this.developerLoginConfig.skVersion, iframeId: this.frameId, appId: this.developerLoginConfig.appId, authVersion: "latest" });
    // Keep Referer on IDMS even if Electron reports the original Developer
    // entry URL rather than the final document after following redirects.
    const landingReferer = landing.url && new URL(landing.url).origin === AUTH_ORIGIN ? landing.url : developerSignin.toString();
    const response = await bootstrapFetch("developer-auth-widget", `${AUTH_BASE}/signin?${query}`, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "text/html", Referer: landingReferer } });
    this.rotate(response);
    if (!response.ok) throw new Error(`Apple Developer 认证初始化失败 (${response.status})`);
    const widgetHtml = await response.text();
    let boot;
    try {
      boot = parseBootData(widgetHtml);
    } catch (error) {
      error.appleBootstrapMissingParameters = true;
      error.appleBootstrapStep = "developer-auth-widget";
      error.appleBootstrapStatus = response.status;
      error.appleBootstrapReason = String(widgetHtml || "").trim() ? "invalid-widget-parameters" : "empty-page";
      this.diagnostic("bootstrap-parameters-missing", {
        step: error.appleBootstrapStep, status: response.status, reason: error.appleBootstrapReason,
      });
      throw error;
    }
    this.state.authAttributes = boot.authAttributes || this.state.authAttributes;
    this.state.hashcash = boot.hashcash || {};
  }
  async beginMfaChallenge() {
    this.frameId = crypto.randomUUID();
    this.state = {};
    this.authInfo = null;
    this.referrerQuery = "";
    this.secondFactor = null;
    this.secondFactorAuthInitialized = false;
    this.onDemand2FAToken = "";
    this.onDemand2FAAppKey = "";
    this.onDemand2FAEnv = "";
    this.developerLoginConfig = null;
    this.widgetKey = WIDGET_KEY;
    const challenge = await this.session.fetch(`${ASC_ORIGIN}/olympus/v1/mfaChallenges`, {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Referer": `${ASC_ORIGIN}/business`,
        "X-Requested-With": "mesh",
      },
      body: JSON.stringify({ data: { type: "mfaChallenges" } }),
    });
    const challengeBody = await readBody(challenge);
    if (!challenge.ok) throw new Error(appleError(challengeBody, `Apple 安全验证挑战创建失败 (${challenge.status})`));
    const token = String(challengeBody?.data?.attributes?.token || "").trim();
    if (!token) throw new Error("Apple 未返回安全验证令牌");
    this.onDemand2FAToken = token;
    this.state.identityToken = token;
    const query = new URLSearchParams({
      widgetKey: this.widgetKey || WIDGET_KEY,
      widgetDomain: ASC_ORIGIN,
      odc: "1",
      iframeId: this.frameId,
      authVersion: "latest",
    });
    const signin = await this.session.fetch(`${AUTH_BASE}/signin?${query}`, {
      redirect: "follow",
      credentials: "include",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${ASC_ORIGIN}/`,
      },
    });
    this.rotate(signin);
    const signinText = await signin.text();
    if (!signin.ok) throw new Error(`Apple 安全验证初始化失败 (${signin.status})`);
    const boot = parseBootDirect(signinText, info => info?.twoFactorAuthAppKey) || {};
    const appKey = String(boot.twoFactorAuthAppKey || "").trim();
    if (!appKey) throw new Error("Apple 未返回短信验证入口");
    this.onDemand2FAAppKey = appKey;
    this.onDemand2FAEnv = String(boot.twoFactorAuthEnv || "1");
    this.state.authAttributes = boot.authAttributes || this.state.authAttributes;
    this.state.hashcash = boot.hashcash || this.state.hashcash || {};
    const fallbackTwoFactorAuthApp = twoFactorAuthAppHeader(appKey, this.onDemand2FAEnv);
    const initialized = await this.initializeSecondFactorAuth();
    this.state.twoFactorAuthApp = this.state.twoFactorAuthApp || fallbackTwoFactorAuthApp;
    const phone = initialized.trustedPhones?.[0] || null;
    if (!phone?.id) throw new Error("当前 Apple 账户没有可用的受信任手机号");
    // Fresh App Store Connect challenges do not deliver a code merely by
    // loading /auth. Send the first SMS through the widget's tfaa-bound
    // endpoint before returning control to the agreement dialog.
    const delivery = await this.requestSMS(phone.id);
    return {
      status: delivery.status,
      phoneId: delivery.phoneId,
      trustedPhone: phone,
      trustedPhones: delivery.trustedPhones || initialized.trustedPhones || [],
      initialSMS: true,
    };
  }
  async login(accountName, password, rememberMe = false) {
    // Treat every password attempt as a fresh widget transaction so no stale
    // scnt/session headers can cross account or retry boundaries.
    this.frameId = crypto.randomUUID();
    this.state = {};
    this.authInfo = null;
    this.referrerQuery = "";
    this.secondFactor = null;
    this.secondFactorAuthInitialized = false;
    this.developerLoginConfig = null;
    this.widgetKey = WIDGET_KEY;
    await this.bootstrap();
    this.srp = new AppleSRP(accountName);
    const federate = await this.request(`/federate?isRememberMeEnabled=${rememberMe}`, { method: "POST", data: { accountName, rememberMe } });
    if ([423, 429].includes(federate.response.status)) throw new Error("Apple ID 登录尝试次数过多或账户暂时受限，请稍后再试");
    if (!federate.response.ok) throw new Error(appleError(federate.body, `federate 失败 (${federate.response.status})`));
    const init = await this.request("/signin/init", { method: "POST", data: { a: this.srp.publicBase64(), accountName, protocols: ["s2k", "s2k_fo"] } });
    if ([423, 429].includes(init.response.status)) throw new Error("Apple ID 登录尝试次数过多或账户暂时受限，请稍后再试");
    if (!init.response.ok) throw new Error(appleError(init.body, `signin/init 失败 (${init.response.status})`));
    const evidence = this.srp.evidence({ iterations: init.body.iteration, serverPublicValue: init.body.b, salt: init.body.salt, password, protocol: init.body.protocol });
    const hc = this.state.hashcash?.hcChallenge ? generateHashcash(this.state.hashcash.hcChallenge, this.state.hashcash.hcBits || 0) : "";
    const complete = await this.request(`/signin/complete?isRememberMeEnabled=${rememberMe}`, {
      method: "POST", data: { accountName, rememberMe, m1: evidence.m1, c: init.body.c, m2: evidence.m2 },
      headers: hc ? { "X-APPLE-HC": hc } : {},
    });
    console.warn("[apple-auth] signin/complete", { status: complete.response.status, bodyKeys: Object.keys(complete.body || {}), authType: complete.body?.authType || "" });
    // Apple keeps authType=hsa2 in the success payload for already trusted
    // accounts. Only HTTP 409 means that an interactive second factor is
    // required; HTTP 200 means the remembered account is fully authenticated.
    if (complete.response.status === 409 && complete.body?.authType) {
      // Apple starts the first trusted-device delivery as part of entering its
      // HSA2 flow. Load /auth immediately while the transaction is valid: it
      // supplies the verification referrer and phone list but must not leave
      // the already-delivered code unusable behind a disabled input.
      const info = await this.request(AUTH_BASE, { accept: "text/html", xmlHttpRequest: false, origin: false });
      console.warn("[apple-auth] 2FA bootstrap /auth", { status: info.response.status, bodyKeys: Object.keys(info.body || {}) });
      if (!info.response.ok) throw new Error(appleError(info.body, `Apple 安全验证初始化失败 (${info.response.status})`));
      this.authInfo = secondFactorAuthInfo(info.body);
      this.referrerQuery = authReferrerQuery(this.authInfo);
      this.state.twoFactorAuthApp = this.state.twoFactorAuthApp || twoFactorAuthAppFromAuthInfo(this.authInfo);
      this.secondFactorAuthInitialized = true;
      const trustedPhones = trustedPhoneNumbers(this.authInfo);
      const initial = initialSecondFactor(this.authInfo, trustedPhones);
      this.secondFactor = initial.automaticallySent
        ? (initial.method === "sms" ? { method: "sms", phoneId: initial.phoneId } : { method: "device" })
        : null;
      return {
        requires2FA: true,
        authType: complete.body.authType,
        initial2FAMethod: initial.method,
        initialCodeAutomaticallySent: initial.automaticallySent,
        initialPhoneId: initial.phoneId ?? null,
        trustedPhone: trustedPhones[0] || null,
        trustedPhones,
      };
    }
    if ([423, 429].includes(complete.response.status)) throw new Error("Apple ID 登录尝试次数过多或账户暂时受限，请稍后再试");
    if (!complete.response.ok) throw new Error(appleError(complete.body, `signin/complete 失败 (${complete.response.status})`));
    return { requires2FA: false };
  }
  async initializeSecondFactorAuth() {
    if (this.secondFactorAuthInitialized) return { initializedNow: false, trustedPhones: trustedPhoneNumbers(this.authInfo) };
    let authUrl = AUTH_BASE;
    if (this.onDemand2FAAppKey) {
      const query = new URLSearchParams({ tfaak: this.onDemand2FAAppKey });
      if (this.onDemand2FAEnv) query.set("ev", this.onDemand2FAEnv);
      authUrl = `${AUTH_BASE}?${query}`;
    }
    const info = await this.request(authUrl, { accept: "text/html", xmlHttpRequest: !!this.onDemand2FAAppKey, origin: false });
    console.warn("[apple-auth] 2FA bootstrap /auth", { status: info.response.status, bodyKeys: Object.keys(info.body || {}) });
    if (!info.response.ok) throw new Error(appleError(info.body, `Apple 安全验证初始化失败 (${info.response.status})`));
    this.authInfo = secondFactorAuthInfo(info.body);
    this.referrerQuery = authReferrerQuery(this.authInfo);
    this.state.twoFactorAuthApp = this.state.twoFactorAuthApp || twoFactorAuthAppFromAuthInfo(this.authInfo);
    this.secondFactorAuthInitialized = true;
    return { initializedNow: true, trustedPhones: trustedPhoneNumbers(this.authInfo) };
  }
  async requestDeviceCode() {
    const previousDeviceFactor = this.secondFactor?.method === "device" ? this.secondFactor : null;
    if (!previousDeviceFactor) this.secondFactor = null;
    // The first /auth load performs Apple's initial device push. Later clicks
    // use the widget's explicit resend endpoint. This produces exactly one
    // delivery per user action instead of pushing during password login.
    const initialized = await this.initializeSecondFactorAuth();
    let status = 200;
    if (!initialized.initializedNow) {
      const result = await this.request("/verify/trusteddevice/securitycode", { method: "PUT", accept: "application/json, text/plain, */*", xmlHttpRequest: false });
      status = result.response.status;
      console.warn("[apple-auth] request device code", { status, bodyKeys: Object.keys(result.body || {}) });
      if (![200, 202, 204].includes(status)) {
        if (previousDeviceFactor) this.secondFactor = previousDeviceFactor;
        throw new Error(appleError(result.body, [423, 429].includes(status) ? "验证码发送次数过多，请稍后再试" : `设备验证码发送失败 (${status})`));
      }
    }
    this.secondFactor = { method: "device" };
    return { status, initialPush: initialized.initializedNow, trustedPhones: initialized.trustedPhones };
  }
  async requestSMS(phoneId) {
    const previousSMSFactor = this.secondFactor?.method === "sms" ? this.secondFactor : null;
    this.secondFactor = null;
    try {
      await this.initializeSecondFactorAuth();
      const phones = trustedPhoneNumbers(this.authInfo);
      const requestedPhoneId = phoneId == null || phoneId === "" ? null : String(phoneId);
      // Apple often withholds the trusted-number list from signin/complete and
      // only returns it from /auth. With multiple numbers, discover choices first.
      if (requestedPhoneId == null && phones.length > 1) {
        this.secondFactor = previousSMSFactor;
        return { selectionRequired: true, trustedPhones: phones };
      }
      const selectedPhone = requestedPhoneId == null
        ? phones[0]
        : phones.find(phone => String(phone.id) === requestedPhoneId);
      if (!selectedPhone) {
        throw new Error(requestedPhoneId == null ? "当前 Apple 账户没有可用的受信任手机号" : "请选择 Apple 返回的受信任手机号");
      }
      const resolvedPhoneId = selectedPhone.id;
      const needsTfaaBoundEndpoint = !!this.onDemand2FAAppKey;
      let path = "/verify/phone";
      if (needsTfaaBoundEndpoint) {
        this.state.twoFactorAuthApp = this.state.twoFactorAuthApp || twoFactorAuthAppFromAuthInfo(this.authInfo);
        const tfaa = String(this.state.twoFactorAuthApp || "").trim();
        if (!tfaa) throw new Error("Apple 短信验证会话缺少 tfaa 参数，请重新发起验证");
        path = `/verify/phone?tfaa=${encodeURIComponent(tfaa)}`;
      }
      const result = await this.request(path, { method: "PUT", data: { phoneNumber: { id: resolvedPhoneId }, mode: "sms" }, accept: "application/json, text/plain, */*", xmlHttpRequest: false });
      console.warn("[apple-auth] request SMS", { status: result.response.status, bodyKeys: Object.keys(result.body || {}) });
      if (![200, 202, 204].includes(result.response.status)) {
        throw new Error(appleError(result.body, [423, 429].includes(result.response.status) ? "验证码发送次数过多，请稍后再试" : `短信验证码发送失败 (${result.response.status})`));
      }
      this.secondFactor = { method: "sms", phoneId: resolvedPhoneId };
      return { status: result.response.status, phoneId: resolvedPhoneId, trustedPhones: phones };
    } catch (error) {
      this.secondFactor = previousSMSFactor;
      throw error;
    }
  }
  async verifyCode(code) {
    if (!this.secondFactor) throw new Error("请先点击发送验证码");
    const sms = this.secondFactor?.method === "sms";
    // Apple's current widget appends the dynamic referrerQuery returned by
    // /auth to verification requests. It is transaction/account-specific;
    // omitting it can still send an SMS but Apple rejects the correct code 403.
    const path = `${sms ? "/verify/phone/securitycode" : "/verify/trusteddevice/securitycode"}${this.referrerQuery || ""}`;
    const data = sms ? { phoneNumber: { id: this.secondFactor.phoneId }, securityCode: { code }, mode: "sms" } : { securityCode: { code } };
    const result = await this.request(path, { method: "POST", data, accept: "application/json, text/plain, */*", xmlHttpRequest: false });
    console.warn("[apple-auth] verify code", { method: sms ? "sms" : "device", status: result.response.status, bodyKeys: Object.keys(result.body || {}) });
    const needsPhoneRepair = sms && result.response.status === 412 && result.body?.securityCode?.valid === true &&
      !result.body?.securityCode?.securityCodeLocked &&
      !result.body?.service_errors?.length && !result.body?.serviceErrors?.length;
    if (!needsPhoneRepair && (![200, 204, 250].includes(result.response.status) || result.body?.service_errors?.length || result.body?.serviceErrors?.length || result.body?.securityCode?.securityCodeLocked)) {
      throw new Error(appleError(result.body, `验证码校验失败 (${result.response.status})`));
    }
    if (needsPhoneRepair) {
      const repair = await this.request("/repair/complete", { method: "POST", accept: "application/json;charset=utf-8" });
      if (![200, 204].includes(repair.response.status)) {
        throw new Error(appleError(repair.body, `Apple 手机号验证完成失败 (${repair.response.status})`));
      }
    }
    if (!this.skipTrust) {
      const trust = await this.request("/2sv/trust", { accept: "application/json, text/plain, */*", xmlHttpRequest: false, origin: false });
      console.warn("[apple-auth] trust", { status: trust.response.status, bodyKeys: Object.keys(trust.body || {}) });
      if (![200, 204].includes(trust.response.status)) throw new Error(`Apple 会话信任失败 (${trust.response.status})`);
    }
  }
  async finalizeDeveloperSession() {
    if (!this.developerLoginConfig) throw new Error("Apple Developer 登录参数已过期，请重新登录");
    // /2sv/trust authenticates IDMS. Visiting ASC promotes that transaction to
    // the first-party service session; a protected JSON endpoint is the
    // authoritative success check (a 200 login page alone is not sufficient).
    const ascLanding = await this.session.fetch(`${ASC_ORIGIN}/`, { redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "text/html" } });
    await ascLanding.text();
    const ascProbe = await this.session.fetch(`${ASC_ORIGIN}/olympus/v1/sites`, {
      redirect: "follow", signal: AbortSignal.timeout(30000),
      headers: { Accept: "application/json", Referer: `${ASC_ORIGIN}/` },
    });
    const ascProbeText = await ascProbe.text();
    if (!ascLanding.ok || !ascProbe.ok || !/^\s*[\[{]/.test(ascProbeText)) {
      throw new Error(`App Store Connect 会话建立失败 (${ascProbe.status})`);
    }
    const appleCookies = await this.session.cookies.get({ domain: ".apple.com" });
    const cookieNames = appleCookies.map(cookie => cookie.name).filter((name, index, rows) => rows.indexOf(name) === index);
    // A successful trusted-device verification normally mints myacinfo and
    // aidshd immediately. Calling /auth or submitting IDMSWebAuth again after
    // that point attempts to consume an already completed transaction and is
    // rejected with 401/403 when switching to a fresh account.
    const hasCompletedAppleSession = cookieNames.includes("myacinfo") || cookieNames.includes("aidshd");
    console.warn("[apple-auth] finalize cookies", { cookieNames, hasCompletedAppleSession });
    // This is the callback submitted by Apple's official IDMSWebAuth host in
    // embedLoginBoot.js after onAuthSuccess. It binds the verified IDMS
    // transaction to Apple Developer's appIdKey and is what creates the
    // Developer SSO cookies. A GET to developer.apple.com cannot replace it.
    const callbackBody = new URLSearchParams({
      rememberMe: "true",
      grantCode: "",
      iframeId: this.frameId,
      requestUri: "/signin.html",
      appIdKey: this.developerLoginConfig.callbackAppIdKey,
      language: this.developerLoginConfig.locale,
      path: this.developerLoginConfig.callbackPath,
      scnt: this.state.scnt || "",
    }).toString();
    if (!hasCompletedAppleSession) {
      const callback = await this.session.fetch("https://idmsa.apple.com/IDMSWebAuth/signin", {
        method: "POST",
        redirect: "follow",
        signal: AbortSignal.timeout(45000),
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: AUTH_ORIGIN,
          Referer: "https://idmsa.apple.com/IDMSWebAuth/signin.html",
        },
        body: callbackBody,
      });
      console.warn("[apple-auth] IDMS Developer callback", { status: callback.status, url: callback.url, location: callback.headers.get("location") || "" });
      if (![200, 201, 202, 204, 301, 302, 303, 307, 308].includes(callback.status)) {
        throw new Error(`Apple Developer 会话兑换失败 (${callback.status})`);
      }
    }
    const response = await this.session.fetch(DEVELOPER_LOGIN_URL, { redirect: "follow", signal: AbortSignal.timeout(30000), headers: { Accept: "text/html" } });
    console.warn("[apple-auth] developer handoff", { status: response.status, url: response.url, location: response.headers.get("location") || "" });
    // Apple commonly answers this hand-off with 301/302. Electron may expose
    // the redirect response instead of the final document even with `follow`.
    // It is not proof of failure; the authoritative checks are
    // services-session/v1/info and services-account/listTeams.action.
    if (![200, 201, 202, 204, 301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error(`Apple 开发者会话跳转失败 (${response.status})`);
    }
    return { status: response.status, redirected: response.status >= 300 && response.status < 400 };
  }
}

module.exports = { AppleAuthClient };
