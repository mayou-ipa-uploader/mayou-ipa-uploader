const modules = {
  "one-click": { title: "一键操作", icon: "✦", empty: "暂无一键操作任务" },
  apps: { title: "App 管理", icon: "▤", empty: "暂无 App 数据" },
  bundle: { title: "Bundle ID 管理", icon: "◉", empty: "暂无 Bundle ID 数据" },
  profiles: { title: "描述文件管理", icon: "◇", empty: "暂无描述文件数据" },
  certificates: { title: "证书管理", icon: "✿", empty: "暂无证书数据" },
  devices: { title: "设备管理", icon: "▣", empty: "暂无设备数据" },
  "ipa-upload": { title: "IPA包上传", icon: "⇧", empty: "暂无 IPA 上传任务" },
  help: { title: "使用帮助", icon: "?", empty: "使用帮助正在完善中" },
};

let authenticated = false;
let proxyRows = [];
let verifiedProxyKey = "";
let verifiedProxyIP = "";
let twoFAMethodReady = false;
let twoFARetryBlocked = false;
let trustedTwoFAPhones = [];
let teamPromptInProgress = false;
let lastTeamSelectionError = "";
let certificateTypes = [];
let certificateAppIds = [];
let editingBundleDetail = null;
let creatingBundleDetail = null;
let pushConfigureApp = null;
let profileOptions = null;
let profileCreateStep = 0;
let profileSelectedBundleId = "";
let profileSelectedCertificateId = "";
let profileSelectedDeviceIds = new Set();
let profileBundleLookupToken = 0;
let profileBundleLookupTimer = null;
let profileBundleLookupTimerResolve = null;
let automationOptions = null;
let automationArtifacts = null;
let automationDownloadOpen = false;
let automationDownloadLoading = false;
let automationDownloadBundles = [];
let automationDownloadSelected = "";
let automationDownloadPassword = "";
let automationDownloadError = "";
let automationCompletionDownloadOpen = false;
let openDeviceAddAfterDeviceLoad = false;
let deviceRenewalSuppressNextLoad = false;
let lastDeviceRenewalCompletedAt = 0;
let currentSelectedTeam = null;
let currentAgreement = null;
let currentPaidAppAgreement = null;
let paidAppAgreementRequestSeq = 0;
let appStoreTermsStatusPromise = null;
let appStoreCreateIsOrganization = null;
let homeBusinessStatus = null;
let appStoreBusinessStatusPromise = null;
const APP_STORE_BUSINESS_CACHE_KEY = "mayou.appStoreBusinessStatus.v1";
let homeAccountInfo = null;
let homeTermsStatus = null;
let homeDeveloperAgreementStatus = null;
let homeStatusLoading = false;
let homeOverviewGeneration = 0;
const homeOverviewCache = {
  terms: { loaded: false, failed: false, loading: false },
  developerAgreement: { loaded: false, failed: false, loading: false },
  business: { loaded: false, failed: false, loading: false },
  account: { loaded: false, failed: false, loading: false },
};
const initializedPages = new Set();
let pageSwitchToken = 0;
const PAGE_LOADING_TITLES = {
  "one-click": "正在加载一键操作…",
  apps: "正在加载 App 管理…",
  bundle: "正在加载 Bundle ID…",
  profiles: "正在加载描述文件…",
  certificates: "正在加载证书…",
  devices: "正在加载设备…",
  "ipa-upload": "正在加载 IPA 上传…",
};
let homeCountryPopoverOutsideHandler = null;
let currentLegalEntityDraft = null;
let currentLegalEntityMfa = null;
let currentLegalEntityMfaSubmitting = false;
let currentComplianceDraft = null;
let currentBankDraft = null;
let currentBankSearchDraft = null;
let currentBankMetadataRequestSeq = 0;
let currentTaxSurveyDraft = null;
let currentTaxMetadataRequestSeq = 0;
let homeTaxW8Metadata = null;
let homeTaxW8MetadataLoading = false;
let homeTaxW8MetadataError = "";
let homeTax1042Metadata = null;
let homeTaxAddressRequestSeq = 0;
let homeTaxAddressState = { scopeKey: "", formType: "", addresses: [], metadata: null, loading: false, addressesError: "", metadataError: "" };
let homeTaxDetailOpen = false;
const HOME_TAX_STATE_KEY = "mayou.homeTaxForms.v1";
let homeTaxStateScopeKey = "";

function appStoreBusinessCacheScope() {
  return String(launchAccountId || launchAppleId || "").trim().toLowerCase();
}

function readCachedAppStoreBusinessStatus() {
  const scope = appStoreBusinessCacheScope();
  if (!scope) return null;
  try {
    const cache = JSON.parse(localStorage.getItem(APP_STORE_BUSINESS_CACHE_KEY) || "{}");
    const value = cache?.[scope];
    return value?.success && value?.legalEntity ? value : null;
  } catch { return null; }
}

function cacheAppStoreBusinessStatus(status) {
  const scope = appStoreBusinessCacheScope();
  if (!scope || !status?.success || !status?.legalEntity) return;
  try {
    const cache = JSON.parse(localStorage.getItem(APP_STORE_BUSINESS_CACHE_KEY) || "{}");
    cache[scope] = { success: true, authenticated: status.authenticated !== false, provider: status.provider || null, legalEntity: status.legalEntity, sellerInfo: status.sellerInfo || null, cachedAt: Date.now() };
    localStorage.setItem(APP_STORE_BUSINESS_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

async function warmAppStoreBusinessStatus({ force = false } = {}) {
  const cached = readCachedAppStoreBusinessStatus();
  if (cached && !homeBusinessStatus?.success) homeBusinessStatus = cached;
  if (appStoreBusinessStatusPromise) return appStoreBusinessStatusPromise;
  if (!force && homeBusinessStatus?.success) return homeBusinessStatus;
  appStoreBusinessStatusPromise = window.appleDeveloper.appStoreBusinessStatus()
    .then(result => { if (result?.success) { homeBusinessStatus = result; cacheAppStoreBusinessStatus(result); } return result; })
    .catch(error => ({ success: false, error: error.message || "商务状态读取失败" }))
    .finally(() => { appStoreBusinessStatusPromise = null; });
  return appStoreBusinessStatusPromise;
}

let homeDeveloperAgreementPromise = null;
let homeAccountInfoPromise = null;

async function readDeveloperAgreementStatus() {
  if (homeDeveloperAgreementPromise) return homeDeveloperAgreementPromise;
  homeDeveloperAgreementPromise = window.appleDeveloper.agreementStatus()
    .catch(error => ({ success: false, error: error.message || "协议状态读取失败" }))
    .finally(() => { homeDeveloperAgreementPromise = null; });
  return homeDeveloperAgreementPromise;
}

async function loadHomeAccountInfo({ force = false } = {}) {
  if (homeAccountInfoPromise) return homeAccountInfoPromise;
  if (!force && homeOverviewCache.account.loaded && homeAccountInfo?.success) return homeAccountInfo;
  const generation = homeOverviewGeneration;
  let timer;
  const request = Promise.race([
    Promise.resolve().then(() => window.appleDeveloper.accountInfo()),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("会员信息读取超时，请检查网络后重试")), 20000);
    }),
  ])
    .catch(error => ({ success: false, error: error?.message || "会员信息读取失败" }))
    .then(result => generation === homeOverviewGeneration ? result : { success: false, stale: true })
    .finally(() => {
      clearTimeout(timer);
      if (homeAccountInfoPromise === request) homeAccountInfoPromise = null;
    });
  homeAccountInfoPromise = request;
  return request;
}

function applyHomeMembershipResult(result) {
  // Keep the last successful details visible if a refresh fails.
  homeAccountInfo = result?.success || !homeMembershipTeam()
    ? result
    : { ...homeAccountInfo, success: false, error: result?.error || "会员信息读取失败" };
}

async function refreshHomeMembershipDetails() {
  if (!authenticated || homeOverviewCache.account.loading) return;
  const generation = homeOverviewGeneration;
  const entry = homeOverviewCache.account;
  entry.loading = true;
  renderHomePage();
  const result = await loadHomeAccountInfo({ force: true });
  if (generation !== homeOverviewGeneration) return;
  applyHomeMembershipResult(result);
  entry.loaded = true;
  entry.failed = homeOverviewResultFailed(result);
  entry.loading = false;
  renderHomePage();
}
function defaultHomeTaxState() {
  return {
    added: false,
    selectedJurisdictions: [],
    usSurveyComplete: false,
    usTaxFormTypes: [],
    usa1042: {
      nickName: "",
      name: "",
      country: "中国大陆",
      beneficialType: "",
      title: "",
      declaration: false,
      submitted: false,
      mailingAddress: null,
    },
    w8ben: {
      nickName: "",
      name: "",
      country: "中国大陆",
      entityType: "",
      entityCertify14a: false,
      entityCertify14b: false,
      entityCertify14c: false,
      entityLimitationType: "",
      entityArticle: "",
      entityWithholdingRate: "",
      entityIncomeSale: false,
      entityOtherIncome: false,
      entityOtherIncomeType: "",
      entityTreatyExplanation: "",
      entityCertificationPrimary: false,
      entityCertificationCapacity: false,
      tin: "",
      tinType: "",
      foreignTaxId: "",
      referenceNumber: "",
      dateOfBirth: "",
      line9: false,
      article: "",
      withholdingRate: "",
      incomeSale: false,
      otherIncome: false,
      treatyExplanation: "",
      certificationPrimary: false,
      certificationCapacity: false,
      submitted: false,
      mailingAddress: null,
    },
  };
}

function resetUnsubmittedHomeTaxDraft(state, type = "all") {
  if (!state || typeof state !== "object") return state;
  if ((type === "all" || type === "w8ben") && state.w8ben?.submitted !== true) {
    Object.assign(state.w8ben, {
      nickName: "",
      entityType: "",
      entityCertify14a: false,
      entityCertify14b: false,
      entityCertify14c: false,
      entityLimitationType: "",
      entityArticle: "",
      entityWithholdingRate: "",
      entityIncomeSale: false,
      entityOtherIncome: false,
      entityOtherIncomeType: "",
      entityTreatyExplanation: "",
      entityCertificationPrimary: false,
      entityCertificationCapacity: false,
      tin: "",
      tinType: "",
      foreignTaxId: "",
      referenceNumber: "",
      dateOfBirth: "",
      line9: false,
      article: "",
      withholdingRate: "",
      incomeSale: false,
      otherIncome: false,
      treatyExplanation: "",
      certificationPrimary: false,
      certificationCapacity: false,
    });
  }
  if ((type === "all" || type === "certificate") && state.usa1042?.submitted !== true) {
    Object.assign(state.usa1042, {
      nickName: "",
      title: "",
      declaration: false,
    });
  }
  return state;
}

function readHomeTaxState(storageKey = "") {
  try {
    const parsed = storageKey ? JSON.parse(localStorage.getItem(storageKey) || "{}") : {};
    const fallback = defaultHomeTaxState();
    return resetUnsubmittedHomeTaxDraft({
      ...fallback,
      ...parsed,
      usa1042: { ...fallback.usa1042, ...(parsed?.usa1042 || {}) },
      w8ben: { ...fallback.w8ben, ...(parsed?.w8ben || {}) },
    });
  } catch {
    return defaultHomeTaxState();
  }
}
let homeTaxState = defaultHomeTaxState();
let launchAppleId = "";
let launchAccountId = "";
let browserBoundLaunch = false;
let browserDesktopAccount = null;
let launchNetwork = { enabled: false, mode: "direct" };
let appleLoginAwaiting2FA = false;
let selectedIPAUploadPath = "";
let selectedIPAUploadDescriptionPath = "";
let activeIPAUploadTaskId = "";
let ipaUploadPollTimer = null;
let ipaUploadPollInFlight = false;
let renderedIPAUploadEventCount = 0;
let ipaUploadTaskRunning = false;
let ipaUploadStartPending = false;
let ipaUploadLastError = "";
let ipaUploadLastFailureTask = null;
let ipaUploadLastTaskEvents = [];
let ipaUploadAnalysisDialogBusy = false;
let currentAccess = null;
let pendingAccessPage = "";
let accessPaymentOrderNo = "";
let accessPaymentTimer = null;
let accessPaymentMethod = "alipay";
let accessPaymentRequestId = 0;
const P12_PASSWORD_HISTORY_LIMIT = 8;
const QIANLI_PROXY_URL = "https://qianliip.com/?invitationCode=0O91DXHPFMZDKAPC0SF6";
let currentP12Password = "123456";
const BUNDLE_CAPABILITY_LANGUAGE_KEY = "mayou.bundleCapability.language";
let bundleCapabilityLanguage = "zh";
try {
  bundleCapabilityLanguage = localStorage.getItem(BUNDLE_CAPABILITY_LANGUAGE_KEY) === "en" ? "en" : "zh";
} catch {}
let appStoreBundleIds = [];
let appStorePrimaryLocales = [];
let appStoreApps = [];
let appStoreRegionDialogState = null;
let appStoreDetailBetaNoticeShown = false;
let currentAppStoreDetail = null;
let currentAppStoreApp = null;
let appStorePricingDraft = null;
const APP_STORE_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
const appStoreDetailCache = new Map();
const appStoreDetailPending = new Map();
let appStoreDetailRequestSeq = 0;
let appStoreSaveInFlight = false;
let appStoreEditRevision = 0;
let currentInAppPurchases = null;
let currentInAppPurchaseDetail = null;
let inAppPurchaseListEditing = false;
let inAppPurchaseListSearch = "";
let selectedInAppPurchaseIds = new Set();
let appStoreReviewDraftCount = 0;
let appStoreReviewDraftPlatform = "IOS";
let appStoreMediaDevice = "iphone";
let appStoreMediaUploads = [];
let currentReviewSubmissionDetail = null;
let currentReviewSubmissionLoadingId = "";
let activeAgeRatingDraftAttributes = null;
let reviewGuidancePollTimer = null;
let reviewGuidancePendingAfterLogin = false;
const reviewGuidanceAutoSyncAt = new Map();
let appleLoginInProgress = false;
let appStoreConnectLoginRecoveryInFlight = false;
const REVIEW_SCAN_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAE0ElEQVR4nO2aX07bWBTGz7VdqdBkyA6GvrRI8xCzgoYVNKxg6AqavlPVI3gfdwVlVkC6goYV4DyMBH0ps4NkkkKlsX3mO0lDC77+GydxCz/p6hyb5LM/3/8miu4Y94Z/du4NL5LfnLEdBLyB9BrTVMO/nZqHdCkszPCWc7VJYfAs5LBFrGyckpKER4o9Qxk9MsyTM2ftghZAqYZthxtfws/Pw5A7cogyD55hKPeh8ei956gBjkuhFMNi9NIfvyQSo6qBUyXCA2i661btbRnG5zb8ZP/fNsI7SDUQF4ZSfMFMrz4e/tLFYWEKG/5aqzBKbZRl0kVtvyha24UMy2jrB+Exs9qkFSC1bZnGbpHRPbdhMfufH37AVxs4XCE8eGAZO3lN5zJcHbMz8pvObLh6ZmfkM53JsAxQV8HodFV9Ng3p02tmfTvLQJbJ8JP90TFCG6XKdD8e1ncRE0k1PJ1nlRjWYhDtICQSErkITZQk+tDqICYCrQ8IMfBu2jytUGKRpnzpjz7hYw0casFTTdQQnu6Pekz0DGksEDk5P6y3KAW0NkbQkqVp4zrxQNwhojcoscwMw5SL0ESJwMQ2LtVAmgAPFCkPiY4+HkYHUe6JEZL4A/fkUAyTm9WRpXYFiE80YLjHKbVYFFzguvbTDfNg3ao/jqtlaOnZej3eC5nfIU2keoYxrij14uygdkQaoKUHwqcINkoiVTQMPNzXNmIEaEWRzXvo+5+QpgLhiUbFDJNhWY91LxGgFSVrcxYqazimWUMrCubeI/zpd8pAmmGl1CvF7CFNhZWymflPpDfABXIbhtpfmJP36BbQigLRUwQbJRUI9AjETT1YTOycHdZ7lIGt/VFLv7D4NmUxUYuyoe3HuN8oMAzdcsCNdrAgmNxsGlir23hwLtJSgOGIv8iJ6a6IpYZ/eHQDV8RwfLNKB2JvmWiAtDSg2YDmS6S5MTTdCXo3mcOwts+UAbrYKYKNkotFGxY8CA4QS4NRwwg2Sm6WYbhSZDJc9qAl8/D5Qc1FmkqeBU8WHlhq+/arn4hhAX2GEcrCMdR0rk4jZGoRPk8lgTEl4i9yQoBheSpNlFQgcIKAvjZZeGwgXQA8xHzuIcF1oqu5GPowbCPeQKFEKHNpWQa4wGKXlnn6UlUN59o83LntoQBhD6GJkkhFDWv7rwAtPVmbNYQnGlUyHNecBWjp+foS7wIf2aAEqmeYh3iJt5n7JZ4AcYeI3qDEUj3DBV/TClLLV/7IY1K/4lALxBM1hCwPAyLXppJIMqyI/1mz6nZc7Qq4TjKYk9v42DFSLVUyjOa8i7m3iyQWXCedp69HXWZ6jrSyKEXvzw/qbaSJZDKcpWmvkixNeUYmw8J0FxX28JUNqhQ8xD/EW7d3RXFkNixUz3Q+s0Iuw0J1TOc3K+Q2LIhp3w+7q+rT0mcty2jnNSsUMixMBrJgfLTs0VtG4zWztpdlgNJR2PAMmach4i66tqVWmaiTNs+mgXudH6ntS3/cQb9CURs4VSI8hKa7btXcorX6PaUYniHGvwSf29hldXDYRJmHPnY97kPzUbcMozNKNfw98hKBgqA1+YE4KZvSH0AftTn9gbhp9nSb9zJYmGEdMroHPjeQXmNaalBktC3KUg1XgXvDPzt3zvD/DCKoW55GGhAAAAAASUVORK5CYII=";
const REVIEW_KEY_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAAA8CAYAAAA6/NlyAAAFcUlEQVR4nO2aT1IbORTGn9pN1ZBg4huM2WCqZjHOCeKcIOQEOCfA2dtFM7DHnCDOCSAniHMCzGKqMBucE8TGnmGqaPzmE8aO3Var/6qhkvyqhF5XtYU+Pek9Sbagn4xfgk2z1Ri+QrVALicGfztrHZjGMSr4D2dUdl2CQN4mwUVmUSQNQnAP73QEibZt0xcTg5C64C3npsh37q4Uic4XKQFyAIitprBzny6c1R6lQGqCpdDx3e0esaiSCQS3rNzKflLhiQWXHS7c3I32mKmGR8NwH11uXh7m9/EQC4ESm636sDImPkEzBTxmhpzqds56G2eNxxa8WR/uoXLoEbGEeHdxsNaiCMQSvNm4/mBsrUZECGp2D/LvYYYisuCnJHYGAtrlwfo7WIEIlNCYFiuIv8JlHQTA2dpEBytMMpfrwXvH3cN8DaYWvBcOrFmHiPZQDMAfV2yrqQtCW41RlXnsMInf8agkzJoOJXgSjekzzJThgUVi++Iw36aQ6Aee+xi417qBCxQs8+y/7vAKrxbwmBpy+q7a+XLHEX08RkJ6e8z8AaaKDvL0S9RKAgWX6sMmE+3CTBEewBMVnSeCKDVGNWY+gqliH6IdUqAVfL9ddN0rmGnj26EowBltJnoF0wP3LXvlpWobqhW8Wb9u4ZUdShUeXB6uF2AokSesW5ffwCyjdJ7Za8d+0x7920b/TmCqUA6qr2Bz3uWPEFwlBeppqg9EEN2HjBcwPXD/mZ3f8A6Wr2BMFwNr1z91PHj2DOYScu/cPVjfgLkE+ukzreXnxPvuwVoT5gyBoqTUuL5Kep5VYRG9VqUhfbrB52x7Q7UmAz63FLGVgs3lXXTcR7B6On/HTzA8rJ2J3s8pBQeMWiJU00wSEDPO4aky6iUg2HdKS7xLSCk4qJFk+Act1YZCblBs29rWBK1veKsA04fF/6cUDA8zKkOoo+eUB09XCcA7vd9yz0/93oXYbUg4galjYR0vCZ5sJUffYBoC+2d7pTy/ruICx5yhKqNogeCZzpkxxWTAkmKRUxNtKacEBbl5Hkvw+YotqmmIVa11HfOZISvB59giVvzWYhRKjeERLghqMEOTteBAsTL4CIu4+9f6JzwuIePKf+N/3txfALAoUkSyFBwodnF6cl8QrniI5PsdlDJKkSZ1bDISvJj/VJi+I5uiDVpy+iRPS09HrEQrWIL8xqhi8rTEQuAX3GZW6AE8LxN3a4nGtFel97PnbniUldgJiw5AH5eBhx2KeHjANnBhk64iTrtJ8fZLKThq4PI2qgMpqIV/u0MZEep4KCnVr3u6S+8pUcROyVD00rFSI3jYZM3BGmtjgD9VrI9T1JHJQrTq7O0r+OGYdgVTiUU0S+ZxwZruoPoTxQA8wDG06N30+AqW+HthMfLFBYLPUJVRTLCP6eyQB61gjZeVjUXBbC5We1eiFSzxWcunEPwW9QJygOYjooqMcrGvQwIF33fQHfbw6guaA5v8Wvdw7RjmPaX6aJeJm7qoPWlr9FmaKKZYiszzBAqW+OVleUEOT/XwDXxx/tim+hlCNmKDb1RCCZYgwDhEtIcSjrmfIWQjFplDM7umCJTQ+EdtNWi8zSgY+RqeCmQW33U7D/oUjaiisyF8mowsWPLERO+H8eyUWIIlkdd06uB+W1i1oDXrJbZgiYzeSEWtMIeMlDmPe+WbSLBERuAbd+Tw8ubEAPLAIppRprCXxIKnyF3W2L110OQOpY4USqf4isYJ2skFkZrgKRPhbhXf+lU5+VQ/xxGvtZp73lLti+OQuuB55M8Y3DuqwEMVYi4HDQAG6Su2aR1YbTtH7ThrNAijglXIQEcecrbomxCnInPBj80vwT86P53g/wFlMPpbk4jrpAAAAABJRU5ErkJggg==";

function isReviewAppBound(access, appId) {
  if (!access?.allowed) return false;
  const target = String(appId || "");
  const boundIds = access.bound_app_ids || access.app_ids || [];
  if (Array.isArray(boundIds) && boundIds.some(id => String(id) === target)) return true;
  return String(access.app_id || access.appId || access.binding?.app_id || "") === target;
}

function restoreCertificateSidebarSelection() {
  const activePage = document.querySelector(".page.active")?.id?.replace(/^page-/, "") || "";
  document.querySelectorAll(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.page === activePage));
}

function requestReviewCodeForApp(mask, app) {
  return new Promise(resolve => {
    const panel = document.createElement("div");
    panel.className = "review-bind-mask";
    panel.innerHTML = `<section class="review-bind-dialog"><header class="review-bind-head"><h3>开通审核服务</h3><button class="review-bind-close" type="button" aria-label="关闭">×</button></header><div class="review-bind-body"><div class="review-bind-app"><span class="review-bind-app-icon">A</span><div><strong>${escapeHTML(app.name || "未命名 App")}</strong><span>AppID：${escapeHTML(String(app.id || ""))}</span></div></div><p class="review-bind-tip">选择一种方式开通该 App 的审核咨询服务</p><div class="review-bind-option selected" data-method="code" role="radio" aria-checked="true" tabindex="0"><span class="review-bind-option-row"><span class="review-bind-radio"></span><span class="review-bind-method-icon"><img src="${REVIEW_KEY_ICON}" alt=""></span><span class="review-bind-method-copy"><strong>使用审核核验码</strong><small>已有核验码，可直接绑定当前 App</small></span></span><span class="review-bind-code-wrap"><label for="review-bind-code">审核核验码</label><input id="review-bind-code" maxlength="16" autocomplete="off" placeholder="请输入审核核验码"></span></div><div class="review-bind-option review-bind-payment-option" data-method="payment" role="radio" aria-checked="false" tabindex="0"><span class="review-bind-option-row"><span class="review-bind-radio"></span><span class="review-bind-method-icon"><img src="${REVIEW_SCAN_ICON}" alt=""></span><span class="review-bind-method-copy"><strong>扫码购买核验码</strong><small>可切换支付宝或微信，付款后自动领取并绑定</small></span><span class="review-bind-recommend">推荐</span></span><div class="review-bind-pay-methods" id="review-bind-pay-methods"><button class="review-bind-pay-method active" type="button" data-review-pay-method="alipay"><img src="./assets/alipay.png" alt="">支付宝</button><button class="review-bind-pay-method" type="button" data-review-pay-method="wechat"><img src="./assets/weixin.png" alt="">微信</button></div><span id="review-payment-area"></span></div><div class="review-bind-error" id="review-bind-error"></div></div><footer class="review-bind-footer"><button class="secondary" id="review-bind-cancel" type="button">取消</button><button class="primary" id="review-bind-submit" type="button">确认绑定</button></footer></section>`;
    mask.querySelector(".review-chat-window").appendChild(panel);
    const finish = value => {
      if (paymentTimer) clearInterval(paymentTimer);
      panel.remove();
      resolve(value);
    };
    let selectedMethod = "code";
    let selectedPayMethod = "wechat";
    let paymentTimer = null;
    let paymentOrderNo = "";
    const paymentArea = () => panel.querySelector("#review-payment-area");
    const submit = () => panel.querySelector("#review-bind-submit");
    const errorBox = () => panel.querySelector("#review-bind-error");
    const updateSubmitText = () => {
      const button = submit();
      if (!button) return;
      button.textContent = selectedMethod === "payment"
        ? `${paymentOrderNo ? "重新生成" : "生成"}${selectedPayMethod === "wechat" ? "微信" : "支付宝"}订单`
        : "确认绑定";
    };
    const setPayMethod = method => {
      selectedPayMethod = method === "alipay" ? "alipay" : "wechat";
      panel.querySelectorAll("[data-review-pay-method]").forEach(button => {
        button.classList.toggle("active", button.dataset.reviewPayMethod === selectedPayMethod);
      });
      if (paymentOrderNo) {
        if (paymentTimer) clearInterval(paymentTimer);
        paymentTimer = null;
        paymentOrderNo = "";
        paymentArea().innerHTML = "";
      }
      updateSubmitText();
    };
    const renderPayment = result => {
      const area = paymentArea();
      if (!area) return;
      const amount = Number(result.amount || 0);
      const original = Math.max(amount, Number(result.original_price || amount));
      const savings = Math.max(0, Number(result.savings || (original - amount)));
      const label = selectedPayMethod === "wechat" ? "微信支付" : "支付宝付款";
      const paymentPane = result.payment_flow === "embedded" && result.pay_url
        ? `<div class="review-bind-payment-frame-wrap"><iframe class="review-bind-payment-frame" src="${escapeHTML(result.pay_url)}" title="${label}"></iframe></div>`
        : result.qr_image
        ? `<div class="review-bind-qr-box"><img src="${escapeHTML(result.qr_image)}" alt="${label}二维码"></div>`
        : `<div class="review-bind-payment-fallback">订单已创建，请在付款页面完成支付。</div>`;
      area.innerHTML = `<span class="review-bind-payment">${paymentPane}<span class="review-bind-price"><b>${label}</b><strong>¥${amount.toFixed(2)}</strong>${savings > 0 ? `<del>¥${original.toFixed(2)}</del><em>立省 ¥${savings.toFixed(2)}</em>` : ""}<small id="review-payment-status">等待支付…</small></span></span>`;
      area.parentElement?.classList.add("selected");
    };
    const startPayment = async () => {
      const button = submit();
      const error = errorBox();
      if (!button || !error) return;
      button.disabled = true;
      button.textContent = "正在生成…";
      error.textContent = "";
      if (paymentTimer) clearInterval(paymentTimer);
      paymentTimer = null;
      paymentOrderNo = "";
      const context = await window.appleDeveloper.launchContext().catch(() => null);
      const result = await window.appleDeveloper.createReviewGuidancePayment({
        pay_method: selectedPayMethod,
        app_id: String(app.id || ""),
        app_name: app.name || "",
        bundle_id: app.bundleId || "",
        developer_account_id: String(context?.accountId || context?.desktopAccount?.id || context?.appleId || "").trim(),
        developer_apple_id: String(context?.appleId || "").trim(),
        purchase_source: context?.browserBound ? "certificate_manager_browser" : "certificate_manager_standalone",
      });
      if (!result?.success) {
        error.textContent = result?.error || "付款码生成失败";
        button.disabled = false;
        updateSubmitText();
        return;
      }
      paymentOrderNo = String(result.order_no || "");
      if (!paymentOrderNo) {
        error.textContent = "付款码生成失败";
        button.disabled = false;
        updateSubmitText();
        return;
      }
      renderPayment(result);
      button.disabled = false;
      updateSubmitText();
      paymentTimer = setInterval(async () => {
        if (!panel.isConnected || !paymentOrderNo) {
          if (paymentTimer) clearInterval(paymentTimer);
          paymentTimer = null;
          return;
        }
        const status = await window.appleDeveloper.reviewGuidancePaymentStatus(paymentOrderNo).catch(() => ({}));
        const statusNode = panel.querySelector("#review-payment-status");
        if (statusNode) statusNode.textContent = status.status === "paid" ? "支付成功，正在绑定…" : "等待支付…";
        if (status.status !== "paid") return;
        if (paymentTimer) clearInterval(paymentTimer);
        paymentTimer = null;
        const orderNo = paymentOrderNo;
        const revealed = await window.appleDeveloper.revealReviewGuidanceCode(orderNo);
        if (!revealed?.success || !revealed.code) {
          error.textContent = revealed?.error || "支付成功，但核验码领取失败";
          updateSubmitText();
          return;
        }
        const bound = await window.appleDeveloper.bindReviewGuidanceCode(revealed.code, app.id, { name: app.name || "", bundle_id: app.bundleId || "" }, orderNo);
        if (!bound?.success) {
          error.textContent = bound?.error || "支付成功，但 App 绑定失败";
          updateSubmitText();
          return;
        }
        localStorage.setItem("reviewInvoiceOrderNo", orderNo);
        finish(true);
      }, 2000);
    };
    panel.querySelector("#review-bind-cancel").onclick = () => finish(false);
    panel.querySelector(".review-bind-close").onclick = () => finish(false);
    panel.querySelectorAll(".review-bind-option").forEach(option => option.onclick = event => {
      if (event.target.closest("input") || option.classList.contains("selected")) return;
      selectedMethod = option.dataset.method;
      panel.querySelectorAll(".review-bind-option").forEach(item => {
        item.classList.toggle("selected", item === option);
        item.setAttribute("aria-checked", item === option ? "true" : "false");
      });
      if (selectedMethod === "payment" && !paymentOrderNo) {
        paymentArea().innerHTML = "";
      }
      updateSubmitText();
      errorBox().textContent = "";
      if (selectedMethod === "code") panel.querySelector("#review-bind-code").focus();
    });
    panel.querySelectorAll(".review-bind-option").forEach(option => option.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); option.click(); }
    });
    panel.querySelectorAll("[data-review-pay-method]").forEach(button => button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      setPayMethod(button.dataset.reviewPayMethod);
    });
    panel.querySelector("#review-bind-submit").onclick = async () => {
      const button = panel.querySelector("#review-bind-submit");
      if (selectedMethod === "payment") { await startPayment(button); return; }
      const input = panel.querySelector("#review-bind-code");
      const code = input.value.trim().toUpperCase();
      const error = panel.querySelector("#review-bind-error");
      if (!/^[A-Z0-9]{6,16}$/.test(code)) { error.textContent = "请输入有效的审核核验码"; return; }
      button.disabled = true; button.textContent = "绑定中…"; error.textContent = "";
      const bound = await window.appleDeveloper.bindReviewGuidanceCode(code, app.id, {
        name: app.name || "", bundle_id: app.bundleId || "",
      }).catch(reason => ({ success: false, error: reason.message }));
      if (!bound?.success) {
        button.disabled = false; button.textContent = "确认绑定";
        error.textContent = bound?.error || "审核核验码绑定失败";
        return;
      }
      finish(true);
    };
    setPayMethod("wechat");
    updateSubmitText();
    panel.querySelector("#review-bind-code").focus();
  });
}

function showReviewLoginReminder() {
  document.querySelector(".review-login-reminder-mask")?.remove();
  const mask = document.createElement("div");
  mask.className = "review-login-reminder-mask";
  mask.innerHTML = `<section class="review-login-reminder" role="alertdialog" aria-modal="true" aria-labelledby="review-login-title"><button class="review-login-reminder-close" type="button" aria-label="关闭">×</button><div class="review-login-reminder-icon">!</div><h3 id="review-login-title">需要先登录 Apple ID</h3><p>审核服务需要读取 App Store Connect 中的 App 列表。登录成功后会自动继续，不需要再次点击“审核”。</p><div class="review-login-reminder-actions"><button class="secondary" data-cancel type="button">稍后再说</button><button class="primary" data-login type="button">立即登录</button></div></section>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.querySelector(".review-login-reminder-close").onclick = close;
  mask.querySelector("[data-cancel]").onclick = close;
  mask.onclick = event => { if (event.target === mask) close(); };
  mask.querySelector("[data-login]").onclick = () => {
    reviewGuidancePendingAfterLogin = true;
    close();
    if (!appleLoginInProgress) el("login-button")?.click();
  };
  setTimeout(() => mask.querySelector("[data-login]")?.focus(), 20);
}

const REVIEW_GUIDANCE_PAGE_SIZE = 20;

function reviewGuidancePage(apps, keyword, requestedPage, pageSize = REVIEW_GUIDANCE_PAGE_SIZE) {
  const normalizedKeyword = String(keyword || "").trim().toLowerCase();
  const indexes = (Array.isArray(apps) ? apps : []).map((app, index) => ({ app: app || {}, index }))
    .filter(({ app }) => !normalizedKeyword || `${app.name || ""} ${app.id || ""} ${app.bundleId || ""}`.toLowerCase().includes(normalizedKeyword))
    .map(({ index }) => index);
  const normalizedPageSize = Math.max(1, Number(pageSize) || REVIEW_GUIDANCE_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(indexes.length / normalizedPageSize));
  const page = Math.min(totalPages, Math.max(1, Number(requestedPage) || 1));
  const start = (page - 1) * normalizedPageSize;
  return { indexes: indexes.slice(start, start + normalizedPageSize), page, totalPages, totalMatches: indexes.length };
}

async function openReviewGuidance(options = {}) {
  if (!authenticated) { showReviewLoginReminder(); return; }
  clearInterval(reviewGuidancePollTimer);
  reviewGuidancePollTimer = null;
  document.querySelector(".review-chat-mask")?.remove();
  document.querySelectorAll(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.action === "review-guidance"));
  const mask = document.createElement("div");
  mask.className = "review-chat-mask";
  mask.innerHTML = `<section class="review-chat-window"><header class="review-chat-head"><strong>审核</strong><span>正在准备客服会话</span><button class="review-chat-close" type="button">×</button></header><div class="review-chat-body"><div class="review-select-intro loading" id="review-guidance-loading"><i class="loading-spinner" aria-hidden="true"></i><span>正在读取 App 列表…</span></div></div></section>`;
  document.body.appendChild(mask);
  const earlyClose = () => { mask.remove(); restoreCertificateSidebarSelection(); };
  mask.querySelector(".review-chat-close").onclick = earlyClose;
  const currentLoading = mask.querySelector("#review-guidance-loading");
  if (currentLoading) currentLoading.innerHTML = '<i class="loading-spinner" aria-hidden="true"></i><span>正在读取当前开发者账户的 App…</span>';
  const [appsResult, unreadByApp] = await Promise.all([
    loadReviewGuidanceAppsForCurrentAccount(),
    loadReviewGuidanceUnreadCounts(),
  ]);
  if (!mask.isConnected) return;
  if (!appsResult?.success) {
    const target = mask.querySelector("#review-guidance-loading") || mask.querySelector(".review-chat-body");
    target.textContent = appsResult?.error || "App 列表读取失败，请登录当前开发者账户后重试。";
    return;
  }
  const reviewApps = Array.isArray(appsResult.apps) ? appsResult.apps : [];
  if (!reviewApps.length) {
    const target = mask.querySelector("#review-guidance-loading") || mask.querySelector(".review-chat-body");
    target.innerHTML = '<div class="review-chat-empty-state"><strong>暂无APP</strong><span>请前往App管理创建app</span></div>';
    return;
  }
  const totalUnread = reviewApps.reduce((total, app) => total + (unreadByApp.get(String(app.id || "")) || 0), 0);
  mask.innerHTML = `<section class="review-chat-window review-select-window" role="dialog" aria-modal="true" aria-labelledby="review-select-title"><header class="review-chat-head review-select-head"><span class="review-select-mark">审</span><div><strong id="review-select-title">选择需要审核协助的 App</strong><span>选择一个 App，将版本信息和 Apple 消息同步给审核专员</span></div><span class="review-select-count">${reviewApps.length} 个 App</span><button class="review-chat-close" type="button" aria-label="关闭">×</button></header>
    <div class="review-chat-body review-select-body"><div class="review-select-toolbar"><label class="review-select-search"><span aria-hidden="true">⌕</span><input id="review-guidance-search" type="search" placeholder="搜索 App 名称、App ID 或 Bundle ID" aria-label="搜索 App"><kbd>⌘ K</kbd></label><button class="secondary" id="review-guidance-refresh" type="button"><span aria-hidden="true">↻</span>刷新</button></div>
    <div class="review-select-list-head"><span>可选 App</span><span>最近同步</span></div><div id="review-guidance-apps" role="radiogroup" aria-label="选择 App"></div>
    <div class="review-select-empty" id="review-guidance-empty" hidden>没有找到匹配的 App</div><nav class="review-select-pager" id="review-guidance-pager" aria-label="App 列表分页" hidden><button id="review-guidance-prev" type="button" aria-label="上一页">‹</button><span id="review-guidance-page-status"></span><button id="review-guidance-next" type="button" aria-label="下一页">›</button></nav>
    <div class="app-pricing-message" id="review-guidance-message"></div></div>
    <footer class="review-chat-actions review-select-actions"><span class="review-select-summary"><i aria-hidden="true">✓</i><span>已选：<strong id="review-guidance-selected-name"></strong></span><b>${totalUnread} 条未读消息</b></span><div><button class="secondary review-chat-cancel" type="button">取消</button><button class="primary" id="review-guidance-submit" type="button">连接审核专员 <span aria-hidden="true">→</span></button></div></footer></section>`;
  const rememberedAppId = String(localStorage.getItem("mayou.reviewGuidance.lastAppId") || "");
  let selectedIndex = reviewApps.findIndex(app => String(app?.id || "") === rememberedAppId);
  if (selectedIndex < 0) selectedIndex = 0;
  let currentPage = Math.floor(selectedIndex / REVIEW_GUIDANCE_PAGE_SIZE) + 1;
  let searchKeyword = "";
  const close = () => { clearInterval(reviewGuidancePollTimer); reviewGuidancePollTimer = null; mask.remove(); restoreCertificateSidebarSelection(); };
  mask.querySelector(".review-chat-close").onclick = close;
  mask.querySelector(".review-chat-cancel").onclick = close;
  mask.querySelector("#review-guidance-refresh").onclick = () => openReviewGuidance({ forceSelect: true });
  const updateSelectedApp = () => {
    const selectedApp = reviewApps[selectedIndex] || {};
    mask.querySelector("#review-guidance-selected-name").textContent = selectedApp.name || "未命名 App";
    mask.querySelector("#review-guidance-submit").disabled = !selectedApp.id;
  };
  const renderAppPage = () => {
    const pageData = reviewGuidancePage(reviewApps, searchKeyword, currentPage);
    currentPage = pageData.page;
    const list = mask.querySelector("#review-guidance-apps");
    list.innerHTML = pageData.indexes.map(index => {
      const app = reviewApps[index] || {};
      const unread = unreadByApp.get(String(app.id || "")) || 0;
      const selected = index === selectedIndex;
      return `<button class="review-app-choice${selected ? " selected" : ""}" data-index="${index}" type="button" role="radio" aria-checked="${selected ? "true" : "false"}"><span class="review-app-radio" aria-hidden="true">✓</span>${appStoreAppIconHTML(app,"review-app-choice-icon")}<span class="review-app-choice-main"><span class="review-app-choice-heading"><strong>${escapeHTML(app.name || "未命名 App")}</strong>${unread ? `<b class="review-app-unread">${unread} 条未读</b>` : ""}</span><small><span>App ID&nbsp; ${escapeHTML(String(app.id || "暂无"))}</span><span>Bundle ID&nbsp; ${escapeHTML(app.bundleId || "暂无 Bundle ID")}</span></small></span><span class="review-app-sync"><em><i></i>资料已同步</em><small>刚刚</small></span></button>`;
    }).join("");
    list.hidden = pageData.totalMatches === 0;
    mask.querySelector("#review-guidance-empty").hidden = pageData.totalMatches !== 0;
    const pager = mask.querySelector("#review-guidance-pager");
    pager.hidden = pageData.totalMatches <= REVIEW_GUIDANCE_PAGE_SIZE;
    mask.querySelector("#review-guidance-page-status").textContent = `第 ${pageData.page} / ${pageData.totalPages} 页 · 共 ${pageData.totalMatches} 个`;
    mask.querySelector("#review-guidance-prev").disabled = pageData.page <= 1;
    mask.querySelector("#review-guidance-next").disabled = pageData.page >= pageData.totalPages;
    list.querySelectorAll(".review-app-choice").forEach(choice => choice.onclick = () => {
      selectedIndex = Number(choice.dataset.index);
      const app = reviewApps[selectedIndex] || {};
      if (app.id) localStorage.setItem("mayou.reviewGuidance.lastAppId", String(app.id));
      updateSelectedApp();
      renderAppPage();
    });
  };
  mask.querySelector("#review-guidance-search").oninput = event => {
    searchKeyword = String(event.target.value || "");
    currentPage = 1;
    renderAppPage();
  };
  mask.querySelector("#review-guidance-prev").onclick = () => { currentPage -= 1; renderAppPage(); };
  mask.querySelector("#review-guidance-next").onclick = () => { currentPage += 1; renderAppPage(); };
  mask.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "k") {
      event.preventDefault();
      mask.querySelector("#review-guidance-search").focus();
    }
  });
  updateSelectedApp();
  renderAppPage();
  mask.querySelector("#review-guidance-submit").onclick = async () => {
    const button = mask.querySelector("#review-guidance-submit");
    const message = mask.querySelector("#review-guidance-message");
    const app = reviewApps[selectedIndex];
    if (!app) return;
    button.disabled = true; message.textContent = "正在核对该 AppID 的审核核验码…";
    const access = await window.appleDeveloper.reviewGuidanceAccess(app.id).catch(error => ({ success: false, error: error.message }));
    if (access?.success === false) {
      message.textContent = access.error || "无法核对该 App 的审核资格";
      button.disabled = false;
      return;
    }
    if (access?.error && !access?.allowed && !access?.bound && !access?.free_access) {
      message.textContent = access.error;
      button.disabled = false;
      return;
    }
    if (access?.free_access) {
      message.textContent = `当前处于免费咨询时段（${access.free_time_label || "后台设定区间"}），无需核验码。`;
    } else if (!isReviewAppBound(access, app.id)) {
      message.textContent = "";
      const bound = await requestReviewCodeForApp(mask, app);
      if (!bound) { button.disabled = false; return; }
    }
    message.textContent = "正在进入聊天，App 资料将在后台同步…";
    const ticket = await ensureReviewGuidanceTicketForApp(app).catch(error => ({ error: error.message }));
    if (!ticket?.id) { message.textContent = ticket?.error || "创建咨询失败"; button.disabled = false; return; }
    await renderReviewGuidanceChat(mask, ticket);
    syncReviewGuidanceAppInBackground(ticket, app, mask);
  };
}

async function loadReviewGuidanceUnreadCounts() {
  const result = await window.appleDeveloper.reviewGuidanceTickets().catch(() => ({ success: false }));
  const counts = new Map();
  if (!result?.success || !Array.isArray(result.tickets)) return counts;
  for (const ticket of result.tickets) {
    const appId = String(ticket?.app_id || "");
    if (!appId) continue;
    const unread = Math.max(0, Number(ticket?.user_unread || 0));
    counts.set(appId, (counts.get(appId) || 0) + unread);
  }
  return counts;
}

async function loadReviewGuidanceAppsForCurrentAccount() {
  const liveResult = await window.appleDeveloper.appStoreApps().catch(error => ({ success: false, error: error.message }));
  if (liveResult?.success) {
    appStoreApps = Array.isArray(liveResult.apps) ? liveResult.apps : [];
    return { success: true, apps: appStoreApps, total: Number(liveResult.total || appStoreApps.length), syncWarning: liveResult.syncWarning || "" };
  }
  const storedResult = await window.appleDeveloper.reviewGuidanceApps().catch(error => ({ success: false, error: error.message }));
  if (storedResult?.success) {
    appStoreApps = Array.isArray(storedResult.apps) ? storedResult.apps : [];
    return { ...storedResult, apps: appStoreApps, liveError: liveResult?.error || "" };
  }
  return storedResult?.error ? storedResult : liveResult;
}

async function buildReviewGuidanceAppSnapshot(app, detail, status = null) {
  if (status) status.textContent = "正在同步历史审核和 Apple 消息…";
  const developerIdentity = await reviewGuidanceDeveloperIdentity();
  const accessResult = await window.appleDeveloper.access().catch(() => ({}));
  const reviewAccessResult = app?.id ? await window.appleDeveloper.reviewGuidanceAccess(app.id).catch(() => ({})) : {};
  const reviewRows = Array.isArray(detail.reviewSubmissions) ? detail.reviewSubmissions.slice(0, 5) : [];
  const existingDetails = new Map((Array.isArray(detail.reviewSubmissionDetails) ? detail.reviewSubmissionDetails : [])
    .filter(row => row?.id)
    .map(row => [String(row.id), row]));
  const reviewSubmissionDetails = (await Promise.all(reviewRows.map(async row => {
    if (!row?.id) return null;
    const existing = existingDetails.get(String(row.id));
    if (existing && (Array.isArray(existing.messages) || Array.isArray(existing.items))) {
      return normalizeReviewGuidanceSubmission({ ...row, ...existing }, app);
    }
    const result = await window.appleDeveloper.appStoreReviewSubmissionDetail({ appId: app.id, submissionId: row.id }).catch(error => ({ success: false, error: error.message }));
    const merged = result?.success ? { ...row, ...(result.detail || {}) } : { ...row, detailError: result?.error || "审核详情读取失败" };
    return normalizeReviewGuidanceSubmission(merged, app);
  }))).filter(Boolean);
  const reviewDeveloperName = [...reviewSubmissionDetails, ...reviewRows].map(row => String(row?.submittedBy || row?.submitter || row?.developerName || "").trim())
    .find(name => name && name !== "—" && name.toLowerCase() !== "apple");
  const developerDisplayName = reviewDeveloperName || developerIdentity.appleId || developerIdentity.name || launchAppleId || "开发者";
  const screenshots = [
    ...(detail.screenshots || []), ...(detail.previews || []),
    ...((detail.screenshotSets || []).flatMap(set => [
      ...(set.screenshots || []).map(item => ({ ...item, mediaType: "screenshot", displayType: set.type })),
      ...(set.previews || []).map(item => ({ ...item, mediaType: "preview", displayType: set.type })),
    ])),
    ...((detail.localizations || []).flatMap(item => [...(item.screenshots || []), ...(item.previews || [])])),
  ].map(item => typeof item === "string" ? { url: item } : ({ ...item, url: item.url || item.previewUrl || item.imageAssetUrl || "" })).filter(item => item.url);
  return {
    ...app, ...(detail.app || {}), id: app.id, name: app.name || detail.app?.name,
    bundleId: app.bundleId || detail.app?.bundleId,
    description: detail.localizations?.[0]?.description || detail.l10n?.description || "",
    developerDisplayName,
    developerAccountNickname: developerIdentity.name || developerIdentity.appleId || launchAppleId || "开发者",
    developerAppleId: developerIdentity.appleId || launchAppleId || "",
    developerInfo: {
      displayName: developerDisplayName,
      accountNickname: developerIdentity.name || developerIdentity.appleId || launchAppleId || "开发者",
      appleId: developerIdentity.appleId || launchAppleId || "",
      accountId: developerIdentity.accountId || "",
      nickname: developerDisplayName,
      avatar: developerIdentity.avatar || "",
      access: accessResult?.access || {},
      reviewAccess: {
        allowed: !!reviewAccessResult?.allowed,
        bound: !!reviewAccessResult?.bound,
        freeAccess: !!reviewAccessResult?.free_access,
        freeTimeLabel: reviewAccessResult?.free_time_label || "",
      },
    },
    screenshots,
    appHistory: Array.isArray(detail.history) ? detail.history : [],
    reviewHistory: detail.reviewSubmissions || [],
    reviewSubmissionDetails,
    version: detail.selectedVersion || {},
    inAppPurchases: detail.inAppPurchases || detail.inAppPurchaseList || detail.iaps || currentInAppPurchases || [],
    reviewDetail: detail.reviewDetail || {}, appInfo: detail.appInfo || {}, appDetail: detail,
  };
}

function normalizeReviewGuidanceSubmission(row = {}, app = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const version = row.version && typeof row.version === "object" ? row.version : {};
  const versionString = version.versionString || row.versionString || row.versionLabel || "";
  const buildVersion = version.buildVersion || row.buildVersion || "";
  return {
    id: String(row.id || ""),
    state: String(row.state || row.status || ""),
    status: String(row.status || row.state || ""),
    platform: String(row.platform || version.platform || "IOS"),
    versionString: String(versionString || ""),
    buildVersion: String(buildVersion || ""),
    versionLabel: String(row.versionLabel || (versionString ? `${appStorePlatformText(row.platform || version.platform || "IOS")} ${versionString}` : "")),
    submittedDate: String(row.submittedDate || row.createdDate || row.lastUpdatedDate || ""),
    createdDate: String(row.createdDate || ""),
    lastUpdatedDate: String(row.lastUpdatedDate || ""),
    submittedBy: String(row.submittedBy || row.submitter || ""),
    submitter: String(row.submitter || row.submittedBy || ""),
    lastUpdatedBy: String(row.lastUpdatedBy || ""),
    itemCount: Number(row.itemCount || items.length || 0),
    detailError: String(row.detailError || ""),
    items: items.map(item => {
      const itemVersion = item.version && typeof item.version === "object" ? item.version : {};
      const itemVersionString = itemVersion.versionString || item.versionString || versionString || "";
      return {
        id: String(item.id || ""),
        state: String(item.state || row.state || ""),
        type: String(item.type || item.itemType || ""),
        name: String(item.name || (itemVersionString ? `${appStorePlatformText(itemVersion.platform || row.platform || "IOS")} App ${itemVersionString}` : app.name || "提交项目")),
        productId: String(item.productId || ""),
        versionString: String(itemVersionString || ""),
        buildVersion: String(itemVersion.buildVersion || item.buildVersion || buildVersion || ""),
        platform: String(itemVersion.platform || row.platform || "IOS"),
        iconUrl: String(itemVersion.iconUrl || app.iconUrl || app.artworkUrl || ""),
        rejectionReasons: Array.isArray(item.rejectionReasons)
          ? item.rejectionReasons
          : (Array.isArray(item.reviewRejections) ? item.reviewRejections : []),
        rejectionReason: String(item.rejectionReason || ""),
        reasonText: String(item.reasonText || ""),
        rejectionAttachments: Array.isArray(item.rejectionAttachments)
          ? item.rejectionAttachments
          : (Array.isArray(item.attachments) ? item.attachments : []),
      };
    }),
    messages: messages.map(message => ({
      id: String(message.id || ""),
      threadId: String(message.threadId || ""),
      author: String(message.author || message.sender || ""),
      createdDate: String(message.createdDate || message.lastUpdatedDate || ""),
      subject: String(message.subject || ""),
      body: String(message.body || message.content || message.text || ""),
      issueDescription: String(message.issueDescription || ""),
      nextSteps: String(message.nextSteps || ""),
      guideline: String(message.guideline || ""),
      rejectionReason: String(message.rejectionReason || ""),
      rejectionAttachments: Array.isArray(message.rejectionAttachments)
        ? message.rejectionAttachments
        : (Array.isArray(message.attachments) ? message.attachments : []),
    })),
  };
}

async function ensureReviewGuidanceTicketForApp(app, options = {}) {
  const ticketsResult = await window.appleDeveloper.reviewGuidanceTickets(app.id).catch(() => ({}));
  const currentTicket = (ticketsResult?.tickets || []).find(ticket => String(ticket.app_id || "") === String(app.id || ""));
  if (currentTicket) return currentTicket;
  const access = await window.appleDeveloper.reviewGuidanceAccess(app.id).catch(() => ({}));
  if (!access?.free_access && !isReviewAppBound(access, app.id)) {
    if (!options.silent) throw new Error(access?.error || "该 App 尚未绑定审核支持码");
    return null;
  }
  const created = await window.appleDeveloper.createReviewGuidance({
    app: { ...app, id: app.id, name: app.name || "未命名 App", bundleId: app.bundleId || "" },
    sync_pending: true,
    auto_sync: options.autoSync === true,
  }).catch(error => ({ success: false, error: error.message || "创建咨询失败" }));
  if (!created?.success) {
    if (!options.silent) throw new Error(created?.error || "创建咨询失败");
    return null;
  }
  return created.ticket || null;
}

async function syncReviewGuidanceAppSnapshot(ticket, app, detail, status = null) {
  const snapshot = await buildReviewGuidanceAppSnapshot(app, detail, status);
  const synced = await window.appleDeveloper.syncReviewGuidanceApp(ticket.id, { app: snapshot });
  if (!synced?.success) throw new Error(synced?.error || "同步失败");
  if (status) status.textContent = "App 最新资料已同步";
  return synced.ticket || ticket;
}

async function syncReviewGuidanceAppInBackground(ticket, app, mask) {
  const status = mask.querySelector("#review-chat-sync-status");
  try {
    const detailResult = await window.appleDeveloper.appStoreAppDetail(app.id);
    if (!detailResult?.success) throw new Error(detailResult?.error || "读取 App 信息失败");
    await syncReviewGuidanceAppSnapshot(ticket, app, detailResult.detail || {}, status);
  } catch (error) {
    if (status) status.textContent = `资料同步失败，可继续聊天 · ${error.message}`;
  }
}

async function autoSyncReviewGuidanceForApp(app, detail) {
  if (!authenticated || !app?.id || !detail || detail.loading || detail.partial) return;
  const key = String(app.id || "");
  const last = Number(reviewGuidanceAutoSyncAt.get(key) || 0);
  if (Date.now() - last < 5 * 60 * 1000) return;
  reviewGuidanceAutoSyncAt.set(key, Date.now());
  try {
    const ticket = await ensureReviewGuidanceTicketForApp(app, { silent: true, autoSync: true });
    if (!ticket?.id) return;
    await syncReviewGuidanceAppSnapshot(ticket, app, detail);
  } catch (error) {
    console.warn("review guidance auto sync failed:", error?.message || error);
  }
}

function mergeReviewSubmissionDetailIntoAppDetail(submissionDetail) {
  if (!submissionDetail?.id || !currentAppStoreDetail) return currentAppStoreDetail;
  const key = String(submissionDetail.id || "");
  const details = Array.isArray(currentAppStoreDetail.reviewSubmissionDetails) ? currentAppStoreDetail.reviewSubmissionDetails : [];
  const nextDetails = [submissionDetail, ...details.filter(row => String(row?.id || "") !== key)].slice(0, 5);
  const history = Array.isArray(currentAppStoreDetail.reviewSubmissions) ? currentAppStoreDetail.reviewSubmissions : [];
  const nextHistory = history.map(row => String(row?.id || "") === key ? { ...row, ...submissionDetail } : row);
  const nextDetail = {
    ...currentAppStoreDetail,
    reviewSubmissions: nextHistory.length ? nextHistory : history,
    reviewSubmissionDetails: nextDetails,
  };
  updateCurrentAppStoreDetail(nextDetail);
  return nextDetail;
}

async function uploadCurrentReviewGuidanceSnapshot() {
  if (!authenticated || !currentAppStoreApp?.id || !currentAppStoreDetail) return;
  try {
    const ticket = await ensureReviewGuidanceTicketForApp(currentAppStoreApp, { silent: true, autoSync: true });
    if (!ticket?.id) return;
    await syncReviewGuidanceAppSnapshot(ticket, currentAppStoreApp, currentAppStoreDetail);
  } catch (error) {
    console.warn("review guidance detail sync failed:", error?.message || error);
  }
}

function reviewGuidanceTime(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function reviewGuidanceMessageTime(value, previousValue = "") {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const previous = previousValue ? new Date(previousValue) : null;
  if (previous && !Number.isNaN(previous.getTime()) && date.getTime() - previous.getTime() <= 3 * 60 * 1000) return "";
  const now = Date.now();
  const elapsedMinutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes}分钟前`;
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameDay) return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isYesterday = date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function reviewGuidanceDeveloperIdentity() {
  try {
    const result = await loadHomeAccountInfo();
    const account = result?.account || {};
    const teams = result?.teams || [];
    const team = teams.find(item => item.id === result?.selectedTeamId) || teams[0] || {};
    return {
      name: account.name || team.name || account.appleId || launchAppleId || "开发者",
      appleId: account.appleId || launchAppleId || "",
      accountId: String(account.id || team.id || launchAppleId || ""),
      avatar: account.avatar || account.avatarUrl || account.avatar_url || "",
    };
  } catch (_) {
    return { name: launchAppleId || "开发者", appleId: launchAppleId || "", accountId: "", avatar: "" };
  }
}

function reviewGuidanceOtherAppRows(tickets, currentTicket) {
  const currentAppId = String(currentTicket?.app_id || "");
  const rowsByApp = new Map();
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    const appId = String(ticket?.app_id || "");
    const unread = Math.max(0, Math.floor(Number(ticket?.user_unread || 0)));
    if (!appId || appId === currentAppId || unread < 1) continue;
    const existing = rowsByApp.get(appId);
    if (existing) {
      existing.unread += unread;
      continue;
    }
    rowsByApp.set(appId, {
      ticket,
      appId,
      appName: ticket.app_name || "未命名 App",
      unread,
      latestMessage: ticket.latest_message || "审核会话有新消息",
      latestMessageType: ticket.latest_message_type || "text",
      updatedAt: ticket.updated_at || "",
    });
  }
  return Array.from(rowsByApp.values()).sort((a, b) => (
    (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0)
  ));
}

async function renderReviewGuidanceChat(mask, initialTicket) {
  mask.classList.add("conversation");
  const windowEl = mask.querySelector(".review-chat-window");
  const ticketId = Number(initialTicket?.id || 0);
  if (!ticketId) return;
  localStorage.setItem("mayou.reviewGuidance.lastAppId", String(initialTicket.app_id || ""));
  const developerIdentity = await reviewGuidanceDeveloperIdentity();
  const snapshot = initialTicket.app_snapshot || {};
  const appIcon = snapshot.iconUrl || snapshot.icon_url || snapshot.icon || "";
  const bundleId = snapshot.bundleId || snapshot.bundle_id || initialTicket.bundle_id || "—";
  const sku = snapshot.sku || snapshot.appInfo?.sku || snapshot.appDetail?.app?.sku || "—";
  const primaryLocale = snapshot.primaryLocale || snapshot.primary_locale || snapshot.appInfo?.primaryLocale || snapshot.appDetail?.app?.primaryLocale || "—";
  const reviewEmojis = "😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 🤗 🤔 🫣 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤢 🤮 🤧 😷 🤒 🤕 👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 👏 🙌 👐 🤲 🙏 ✍️ 💪 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✅ ❌ ⭐ 🌟 ✨ ⚡ 🔥 🎉 🎊 🎁 🏆 🚀".split(" ");
  windowEl.innerHTML = `<header class="review-chat-head"><div class="review-chat-title"><span class="review-chat-app-icon">${appIcon ? `<img src="${escapeHTML(appIcon)}" alt="">` : "A"}</span><div class="review-chat-session-copy"><div class="review-chat-session-title"><strong>${escapeHTML(initialTicket.app_name || "未命名 App")}</strong><span class="review-chat-sync"><i></i><b id="review-chat-sync-status">${initialTicket.sync_pending ? "正在同步资料…" : "资料已同步"}</b></span></div><div class="review-chat-session-meta"><span>${escapeHTML(developerIdentity.name || "客户")}</span><span>AppID ${escapeHTML(String(initialTicket.app_id || "—"))}</span><span>Bundle ID ${escapeHTML(String(bundleId))}</span><span>SKU ${escapeHTML(String(sku))}</span><span>主要语言 ${escapeHTML(String(primaryLocale))}</span></div></div></div><button class="review-chat-switch" type="button"><b>⇄</b> 切换 App</button></header>
    <button class="review-other-apps-toggle" id="review-other-apps-toggle" type="button" aria-expanded="false" aria-controls="review-other-apps-panel">其他 App 消息<span id="review-other-apps-badge" hidden>0</span></button>
    <aside class="review-other-apps-panel" id="review-other-apps-panel" aria-label="其他 App 未读消息" hidden><header><div><strong>其他 App 未读消息</strong><span id="review-other-apps-total">共 0 条</span></div><button id="review-other-apps-close" type="button" aria-label="关闭">×</button></header><div class="review-other-apps-list" id="review-other-apps-list"><div class="review-other-apps-loading">正在读取未读消息…</div></div><button class="review-other-apps-all" id="review-other-apps-all" type="button">查看全部 App 消息</button></aside>
    <div class="review-chat-drop-hint">松开鼠标，将图片添加到消息</div>
    <div class="review-chat-body" id="review-chat-body"><div class="review-chat-messages" id="review-chat-messages"><div class="review-chat-loading">正在连接客服…</div></div></div><button class="review-chat-unread" id="review-chat-unread" type="button" hidden></button>
    <form class="review-chat-compose" id="review-chat-compose"><div class="review-chat-tools"><button id="review-chat-emoji-button" type="button" title="表情" aria-label="表情">☺</button><button id="review-chat-image-button" type="button" title="发送图片" aria-label="发送图片"><img src="./assets/icons/chat-image.png" alt=""></button><input id="review-chat-image" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden></div><div class="review-chat-emoji" id="review-chat-emoji" hidden>${reviewEmojis.map(icon => `<button type="button">${icon}</button>`).join("")}</div><div id="review-chat-input" class="review-chat-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="输入消息，支持粘贴图片…"></div><div class="review-chat-send"><small>Enter 发送，Shift + Enter 换行</small><button class="primary" type="submit">发送 <span>▷</span></button></div></form>`;
  const sessionMeta = windowEl.querySelector(".review-chat-session-meta");
  if (sessionMeta) {
    const identitySpan = sessionMeta.querySelector("span");
    if (identitySpan) identitySpan.textContent = developerIdentity.name || "开发者";
    const accountSpan = document.createElement("span");
    accountSpan.textContent = `开发者账户 ${developerIdentity.appleId || developerIdentity.accountId || "—"}`;
    sessionMeta.insertBefore(accountSpan, sessionMeta.children[1] || null);
  }
  let chatDisposed = false;
  const close = () => { chatDisposed = true; clearPendingImage(); for (const item of localMessages?.values?.() || []) if (item.previewURL) URL.revokeObjectURL(item.previewURL); localMessages?.clear?.(); clearInterval(reviewGuidancePollTimer); reviewGuidancePollTimer = null; mask.remove(); restoreCertificateSidebarSelection(); };
  windowEl.querySelector(".review-chat-switch").onclick = () => { chatDisposed = true; clearPendingImage(); for (const item of localMessages?.values?.() || []) if (item.previewURL) URL.revokeObjectURL(item.previewURL); localMessages?.clear?.(); clearInterval(reviewGuidancePollTimer); reviewGuidancePollTimer = null; openReviewGuidance({ forceSelect: true }); };
  const chatInput = windowEl.querySelector("#review-chat-input");
  let sendingMessage = false;
  let composingMessage = false;
  let renderedMessageKeys = [];
  let renderedMessageSignature = "";
  let unreadIncomingCount = 0;
  let initialMessagesLoaded = false;
  const localMessages = new Map();
  const messageKey = (item, index) => String(item?.id || `${item?.created_at || ""}:${item?.sender_type || ""}:${index}`);
  const messageSignature = items => JSON.stringify((items || []).map((item, index) => [
    messageKey(item, index), item?.sender_name || "", item?.sender_role || "", item?.role_label || "",
    item?.content || "", item?.media_url || ""
  ]));
  const updateUnreadButton = () => {
    const button = windowEl.querySelector("#review-chat-unread");
    if (!button) return;
    button.dataset.count = String(unreadIncomingCount);
    button.textContent = `${unreadIncomingCount} 条新消息 ↓`;
    button.hidden = unreadIncomingCount < 1;
  };
  const localMessageHTML = item => {
    const status = item.delivery === "failed"
      ? `<span class="review-chat-message-status failed" role="img" aria-label="发送失败" title="${escapeHTML(item.error || "发送失败")}">!</span>`
      : `<span class="review-chat-message-status sending" role="status" aria-label="发送中"><i></i></span>`;
    return `<div class="review-chat-row user review-chat-local-message ${item.delivery}" data-review-client-message="${escapeHTML(item.clientId)}"><span class="review-chat-avatar developer">${item.avatar}</span><div class="review-chat-message-wrap"><div class="review-chat-message-meta"><span class="review-chat-identity"><strong>${escapeHTML(item.name)}</strong><span class="review-chat-role-badge customer">开发者</span></span></div><div class="review-chat-message-line">${status}<div class="review-chat-bubble">${item.contentHTML}</div></div></div></div>`;
  };
  const renderLocalMessages = () => {
    const list = windowEl.querySelector("#review-chat-messages");
    if (!list) return;
    list.querySelector(".review-chat-empty")?.remove();
    for (const item of localMessages.values()) {
      if (!list.querySelector(`[data-review-client-message="${CSS.escape(item.clientId)}"]`)) list.insertAdjacentHTML("beforeend", localMessageHTML(item));
    }
  };
  const refresh = async () => {
    if (sendingMessage) return;
    const [result, ticketsResult] = await Promise.all([
      window.appleDeveloper.reviewGuidanceMessages(ticketId).catch(error => ({ success: false, error: error.message })),
      window.appleDeveloper.reviewGuidanceTickets().catch(error => ({ success: false, error: error.message })),
    ]);
    if (chatDisposed || !windowEl.isConnected) return;
    if (ticketsResult?.success) renderOtherAppMessages(ticketsResult.tickets);
    if (!result?.success) return;
    const ticket = result.ticket || initialTicket;
    const matched = ticket.agent_name || "审核专员";
    const messages = result.messages || [];
    const list = windowEl.querySelector("#review-chat-messages");
    const body = windowEl.querySelector("#review-chat-body");
    const scrollBox = list;
    if (!list) return;
    const signature = messageSignature(messages);
    if (signature === renderedMessageSignature) return;
    const previousScrollTop = scrollBox.scrollTop;
    const wasNearBottom = scrollBox.scrollHeight - previousScrollTop - scrollBox.clientHeight <= 48;
    const nextMessageKeys = messages.map(messageKey);
    const previousKeySet = new Set(renderedMessageKeys);
    const addedIncomingCount = messages.reduce((count, item, index) => (
      !previousKeySet.has(nextMessageKeys[index]) && item?.sender_type !== "user" ? count + 1 : count
    ), 0);
    list.innerHTML = messages.length ? messages.map((item, index) => {
      const date = new Date(item.created_at || "");
      const timeLabel = reviewGuidanceMessageTime(item.created_at, messages[index - 1]?.created_at || "");
      const divider = timeLabel ? `<div class="review-chat-date"><b>${escapeHTML(timeLabel)}</b></div>` : "";
      const user = item.sender_type === "user";
      const content = `${item.media_url ? `<img src="${escapeHTML(item.media_url)}" alt="聊天图片">` : ""}${item.content ? `<div>${escapeHTML(item.content)}</div>` : ""}`;
      const displayName = user
        ? (developerIdentity.name || item.sender_name || "开发者")
        : (item.sender_name || matched);
      const roleLabel = user ? "开发者" : (item.role_label || (item.sender_type === "admin" ? "管理员" : "审核专员"));
      const roleClass = item.sender_role || (user ? "customer" : (item.sender_type === "admin" ? "admin" : "reviewer"));
      const avatar = user && developerIdentity.avatar ? `<img src="${escapeHTML(developerIdentity.avatar)}" alt="">` : (user ? "🧑🏻‍💻" : (item.sender_type === "admin" ? "🛡️" : "🎧"));
      const avatarHTML = `<span class="review-chat-avatar ${user ? "developer" : roleClass}" title="${escapeHTML(displayName)}">${avatar}</span>`;
      const messageHTML = `<div class="review-chat-message-wrap"><div class="review-chat-message-meta"><span class="review-chat-identity"><strong>${escapeHTML(displayName)}</strong><span class="review-chat-role-badge ${escapeHTML(roleClass)}">${escapeHTML(roleLabel)}</span></span></div><div class="review-chat-bubble">${content}</div></div>`;
      return `${divider}<div class="review-chat-row ${user ? "user" : "staff"}">${user ? `${avatarHTML}${messageHTML}` : `${messageHTML}${avatarHTML}`}</div>`;
    }).join("") : '<div class="review-chat-empty">已连接，请描述你遇到的审核问题。</div>';
    renderLocalMessages();
    const stickToBottom = !initialMessagesLoaded || wasNearBottom;
    if (stickToBottom) unreadIncomingCount = 0;
    else unreadIncomingCount += addedIncomingCount;
    const restoreScroll = () => {
      const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.clientHeight);
      scrollBox.scrollTop = stickToBottom ? maxScrollTop : Math.min(previousScrollTop, maxScrollTop);
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
    renderedMessageKeys = nextMessageKeys;
    renderedMessageSignature = signature;
    updateUnreadButton();
    initialMessagesLoaded = true;
  };
  let pendingImageFile = null;
  let pendingPreviewURL = "";
  const clearPendingImage = (removeNode = true) => {
    if (pendingPreviewURL) URL.revokeObjectURL(pendingPreviewURL);
    pendingPreviewURL = "";
    pendingImageFile = null;
    windowEl.querySelector("#review-chat-image").value = "";
    if (removeNode) chatInput.querySelector(".review-chat-editor-image")?.remove();
  };
  let otherAppTicketsById = new Map();
  const renderOtherAppMessages = tickets => {
    const rows = reviewGuidanceOtherAppRows(tickets, initialTicket);
    const totalUnread = rows.reduce((total, row) => total + row.unread, 0);
    const toggle = windowEl.querySelector("#review-other-apps-toggle");
    const badge = windowEl.querySelector("#review-other-apps-badge");
    const total = windowEl.querySelector("#review-other-apps-total");
    const list = windowEl.querySelector("#review-other-apps-list");
    if (!toggle || !badge || !total || !list) return;
    badge.textContent = String(totalUnread);
    badge.hidden = totalUnread < 1;
    toggle.classList.toggle("has-unread", totalUnread > 0);
    total.textContent = `共 ${totalUnread} 条`;
    otherAppTicketsById = new Map(rows.map(row => [String(row.ticket.id), row.ticket]));
    list.innerHTML = rows.length ? rows.map(row => {
      const ticketSnapshot = row.ticket.app_snapshot || {};
      const iconApp = { ...ticketSnapshot, iconUrl: ticketSnapshot.iconUrl || ticketSnapshot.icon_url || ticketSnapshot.icon || "" };
      const preview = row.latestMessageType === "image" ? "[图片]" : row.latestMessage;
      return `<button class="review-other-app-row" data-review-other-ticket="${escapeHTML(String(row.ticket.id))}" type="button">${appStoreAppIconHTML(iconApp, "review-other-app-icon")}<span class="review-other-app-copy"><span class="review-other-app-name">${escapeHTML(row.appName)}</span><span class="review-other-app-preview">${escapeHTML(preview)}</span></span><span class="review-other-app-meta"><time>${escapeHTML(reviewGuidanceMessageTime(row.updatedAt))}</time><b>${row.unread}</b></span></button>`;
    }).join("") : '<div class="review-other-apps-empty"><strong>暂无其他 App 未读消息</strong><span>新消息会自动显示在这里</span></div>';
    list.querySelectorAll("[data-review-other-ticket]").forEach(button => button.onclick = async () => {
      const target = otherAppTicketsById.get(String(button.dataset.reviewOtherTicket || ""));
      if (!target || chatDisposed) return;
      chatDisposed = true;
      clearPendingImage();
      for (const item of localMessages.values()) if (item.previewURL) URL.revokeObjectURL(item.previewURL);
      localMessages.clear();
      clearInterval(reviewGuidancePollTimer);
      reviewGuidancePollTimer = null;
      await renderReviewGuidanceChat(mask, target);
    });
  };
  const otherAppsToggle = windowEl.querySelector("#review-other-apps-toggle");
  const otherAppsPanel = windowEl.querySelector("#review-other-apps-panel");
  const setOtherAppsPanelOpen = open => {
    otherAppsPanel.hidden = !open;
    otherAppsToggle.setAttribute("aria-expanded", String(open));
  };
  otherAppsToggle.onclick = event => { event.stopPropagation(); setOtherAppsPanelOpen(otherAppsPanel.hidden); };
  windowEl.querySelector("#review-other-apps-close").onclick = event => { event.stopPropagation(); setOtherAppsPanelOpen(false); };
  windowEl.querySelector("#review-other-apps-all").onclick = () => { chatDisposed = true; clearPendingImage(); for (const item of localMessages.values()) if (item.previewURL) URL.revokeObjectURL(item.previewURL); localMessages.clear(); clearInterval(reviewGuidancePollTimer); reviewGuidancePollTimer = null; openReviewGuidance({ forceSelect: true }); };
  windowEl.addEventListener("click", event => {
    if (!otherAppsPanel.hidden && !event.target.closest("#review-other-apps-panel") && !event.target.closest("#review-other-apps-toggle")) setOtherAppsPanelOpen(false);
  });
  const placeCaretAfter = node => {
    const range = document.createRange(); range.setStartAfter(node); range.collapse(true);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  };
  const selectPendingImage = file => {
    if (!file || !/^image\/(png|jpeg|gif|webp)$/i.test(file.type || "")) { alert("仅支持 PNG、JPG、GIF、WebP 图片"); return; }
    if (file.size > 5 * 1024 * 1024) { alert("图片不能超过 5 MB"); return; }
    clearPendingImage();
    pendingImageFile = file;
    pendingPreviewURL = URL.createObjectURL(file);
    const image = document.createElement("img");
    image.className = "review-chat-editor-image"; image.src = pendingPreviewURL; image.alt = "待发送图片"; image.contentEditable = "false";
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && chatInput.contains(range.commonAncestorContainer)) range.insertNode(image); else chatInput.appendChild(image);
    const spacer = document.createTextNode("\u200B"); image.after(spacer);
    chatInput.focus(); placeCaretAfter(spacer);
  };
  windowEl.querySelector("#review-chat-compose").onsubmit = async event => {
    event.preventDefault();
    if (sendingMessage) return;
    const input = windowEl.querySelector("#review-chat-input");
    const fileInput = windowEl.querySelector("#review-chat-image");
    const content = String(input.innerText || "").replaceAll("\u200B", "").trim();
    const file = pendingImageFile || fileInput.files?.[0];
    if (!content && !file) return;
    if (file && file.size > 5 * 1024 * 1024) { alert("图片不能超过 5 MB"); return; }
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const clientId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingAvatar = developerIdentity.avatar ? `<img src="${escapeHTML(developerIdentity.avatar)}" alt="">` : "🧑🏻‍💻";
    const pendingContent = `${file ? `<img src="${escapeHTML(pendingPreviewURL || "")}" alt="待发送图片">` : ""}${content ? `<div>${escapeHTML(content)}</div>` : ""}`;
    const submittedPreviewURL = pendingPreviewURL;
    const localMessage = { clientId, name: developerIdentity.name || "开发者", avatar: pendingAvatar, contentHTML: pendingContent, previewURL: submittedPreviewURL, delivery: "sending", error: "" };
    localMessages.set(clientId, localMessage);
    renderLocalMessages();
    const pendingRow = windowEl.querySelector(`[data-review-client-message="${CSS.escape(clientId)}"]`);
    const scrollBox = windowEl.querySelector("#review-chat-messages");
    scrollBox?.scrollTo({ top: scrollBox.scrollHeight, behavior: "auto" });
    input.innerHTML = "";
    pendingImageFile = null;
    pendingPreviewURL = "";
    fileInput.value = "";
    sendingMessage = true;
    button.disabled = true;
    try {
      const imageDataURL = file ? await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(file);
      }) : "";
      const result = await window.appleDeveloper.sendReviewGuidanceMessage(ticketId, content, imageDataURL);
      if (!result?.success) throw new Error(result?.error || "消息发送失败");
      localMessages.delete(clientId);
      pendingRow?.remove();
      sendingMessage = false;
      if (submittedPreviewURL) URL.revokeObjectURL(submittedPreviewURL);
      await refresh();
    } catch (error) {
      const message = error?.message || "消息发送失败，请重试";
      localMessage.delivery = "failed";
      localMessage.error = message;
      pendingRow?.classList.remove("sending");
      pendingRow?.classList.add("failed");
      const status = pendingRow?.querySelector(".review-chat-message-status");
      if (status) {
        status.className = "review-chat-message-status failed";
        status.setAttribute("role", "img");
        status.setAttribute("aria-label", "发送失败");
        status.setAttribute("title", message);
        status.replaceChildren(document.createTextNode("!"));
      }
    } finally {
      sendingMessage = false;
      button.disabled = false;
      input.focus();
    }
  };
  const emojiPanel = windowEl.querySelector("#review-chat-emoji");
  windowEl.querySelector("#review-chat-emoji-button").onclick = () => { emojiPanel.hidden = !emojiPanel.hidden; };
  windowEl.addEventListener("click", event => {
    if (!emojiPanel.hidden && !event.target.closest("#review-chat-emoji") && !event.target.closest("#review-chat-emoji-button")) emojiPanel.hidden = true;
  });
  emojiPanel.querySelectorAll("button").forEach(button => button.onclick = () => {
    const textNode = document.createTextNode(button.textContent);
    const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && chatInput.contains(range.commonAncestorContainer)) { range.deleteContents(); range.insertNode(textNode); }
    else chatInput.appendChild(textNode);
    chatInput.focus(); placeCaretAfter(textNode);
  });
  const fileInput = windowEl.querySelector("#review-chat-image");
  windowEl.querySelector("#review-chat-image-button").onclick = () => fileInput.click();
  fileInput.onchange = () => selectPendingImage(fileInput.files?.[0]);
  chatInput.addEventListener("input", () => {
    if (pendingImageFile && !chatInput.querySelector(".review-chat-editor-image")) clearPendingImage(false);
  });
  chatInput.addEventListener("compositionstart", () => { composingMessage = true; });
  chatInput.addEventListener("compositionend", () => { composingMessage = false; });
  chatInput.onkeydown = event => {
    if (composingMessage || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!sendingMessage) windowEl.querySelector("#review-chat-compose").requestSubmit(); }
  };
  chatInput.onpaste = event => {
    const image = Array.from(event.clipboardData?.files || []).find(file => file.type.startsWith("image/"));
    if (image) { event.preventDefault(); selectPendingImage(image); }
  };
  const unreadButton = windowEl.querySelector("#review-chat-unread");
  unreadButton.onclick = () => {
    const body = windowEl.querySelector("#review-chat-messages");
    body?.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    unreadIncomingCount = 0;
    updateUnreadButton();
  };
  windowEl.querySelector("#review-chat-messages").addEventListener("scroll", event => {
    const body = event.currentTarget;
    if (body.scrollHeight - body.scrollTop - body.clientHeight <= 48) {
      unreadIncomingCount = 0;
      updateUnreadButton();
    }
  });
  let dragDepth = 0;
  windowEl.ondragenter = event => { event.preventDefault(); dragDepth += 1; windowEl.classList.add("dragging"); };
  windowEl.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; };
  windowEl.ondragleave = event => { event.preventDefault(); dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; windowEl.classList.remove("dragging"); } };
  windowEl.ondrop = event => {
    event.preventDefault(); dragDepth = 0; windowEl.classList.remove("dragging");
    selectPendingImage(Array.from(event.dataTransfer.files || []).find(file => file.type.startsWith("image/")));
  };
  await refresh();
  clearInterval(reviewGuidancePollTimer);
  reviewGuidancePollTimer = setInterval(refresh, 3000);
}

const el = id => document.getElementById(id);
const networkMode = () => el("custom-proxy-enabled")?.checked ? "custom" : "direct";
const twoFAMethod = () => document.querySelector('input[name="twofa-method"]:checked')?.value || "device";

function p12PasswordStorageKey() {
  return `mayou.p12Passwords.${launchAppleId || "default"}`;
}

function readP12PasswordHistory() {
  try {
    const rows = JSON.parse(localStorage.getItem(p12PasswordStorageKey()) || "[]");
    return Array.isArray(rows) ? rows.map(value => String(value || "")).filter(Boolean).slice(0, P12_PASSWORD_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function defaultP12Password() {
  return currentP12Password || readP12PasswordHistory()[0] || "123456";
}

function saveP12Password(password) {
  const value = String(password || "").trim();
  if (!value) return;
  const rows = [value, ...readP12PasswordHistory().filter(item => item !== value)].slice(0, P12_PASSWORD_HISTORY_LIMIT);
  localStorage.setItem(p12PasswordStorageKey(), JSON.stringify(rows));
}

async function editCurrentP12Password() {
  const next = prompt("请输入新的 P12 密码", currentP12Password || "123456");
  if (next === null) return false;
  const value = String(next || "").trim();
  if (!value) { alert("P12 密码不能为空"); return false; }
  const result = await window.appleDeveloper.updateP12Password(value);
  if (!result?.success) { alert(result?.error || "P12 密码修改失败"); return false; }
  currentP12Password = result.p12Password || value;
  saveP12Password(currentP12Password);
  document.querySelectorAll(".certificate-p12-password-text").forEach(node => { node.textContent = currentP12Password; });
  return true;
}

async function editCertificateP12Password(button) {
  const row = button?.closest("tr");
  const passwordNode = row?.querySelector(".certificate-p12-password-text");
  const current = passwordNode?.textContent?.trim() || defaultP12Password();
  const next = prompt("请输入此证书新的 P12 密码", current);
  if (next === null) return false;
  const value = String(next || "").trim();
  if (!value) { alert("P12 密码不能为空"); return false; }
  const result = await window.appleDeveloper.updateP12Password({ certificateId: button.dataset.id, password: value });
  if (!result?.success) { alert(result?.error || "P12 密码修改失败"); return false; }
  if (passwordNode) passwordNode.textContent = result.p12Password || value;
  saveP12Password(result.p12Password || value);
  return true;
}

function currentProxy() {
  return {
    enabled: networkMode() !== "direct",
    type: el("proxy-type").value,
    host: el("proxy-host").value.trim(),
    port: el("proxy-port").value.trim(),
    username: el("proxy-username").value,
    password: el("proxy-password").value,
  };
}

function proxyKey(proxy) { return JSON.stringify([proxy.enabled, proxy.type, proxy.host, proxy.port, proxy.username, proxy.password]); }
function setBusy(button, busy, text) { button.disabled = busy; button.dataset.label ||= button.textContent; button.textContent = busy ? text : button.dataset.label; }
function applyLoginLaunchRestrictions() {
  const backButton = el("login-account-back");
  if (!backButton) return;
  backButton.toggleAttribute("hidden", browserBoundLaunch);
  backButton.style.display = browserBoundLaunch ? "none" : "";
}
function setLoginProgress(active, title = "正在登录 Apple 账户", detail = "正在建立安全连接，请稍候…") {
  appleLoginInProgress = active;
  // A disabled fieldset also locks controls rendered during an async request,
  // while preserving their individual disabled states for the next step.
  if (el("apple-login-controls")) el("apple-login-controls").disabled = active;
  document.body.classList.toggle("apple-login-busy", active);
  const dialog = el("login-dialog");
  dialog?.classList.toggle("login-busy", active);
  if (dialog) {
    dialog.setAttribute("aria-busy", String(active));
    dialog.inert = active;
  }
  el("login-mask")?.classList.toggle("login-busy", active);
  el("login-progress")?.classList.toggle("show", active);
  el("account-login-spinner")?.classList.toggle("show", active && browserBoundLaunch);
  if (el("login-progress-title")) el("login-progress-title").textContent = title;
  if (el("login-progress-detail")) el("login-progress-detail").textContent = detail;
  if (!active && el("login-mask")?.classList.contains("show")) {
    if (appleLoginAwaiting2FA) (twoFAMethodReady ? el("twofa-code") : el("request-twofa"))?.focus();
    else if (!el("login-form")?.classList.contains("hidden")) el("apple-password")?.focus();
  }
}
document.addEventListener("click", event => {
  if (!appleLoginInProgress) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
function appleLoginNetworkLabel(network = launchNetwork) {
  const source = network && typeof network === "object" ? network : {};
  if (source.enabled !== true) return { title: "网络：直连", detail: "当前 Apple 登录请求使用本机网络" };
  const ip = String(source.ip || source.lastVerifiedIp || "").trim();
  const location = [source.country, source.region, source.city].map(value => String(value || "").trim()).filter(Boolean).join(" ");
  const isp = String(source.isp || "").trim();
  const mode = String(source.mode || "代理").toUpperCase();
  return {
    title: ip ? `网络：代理 ${ip}` : `网络：${mode} 代理`,
    detail: [location, isp].filter(Boolean).join(" · ") || "当前 Apple 登录请求使用已绑定代理",
  };
}
function updateLoginNetworkSummary(network = launchNetwork, { locked = false } = {}) {
  launchNetwork = network && typeof network === "object" ? network : { enabled: false, mode: "direct" };
  const label = appleLoginNetworkLabel(launchNetwork);
  if (el("network-summary-title")) el("network-summary-title").textContent = label.title;
  if (el("network-summary-detail")) el("network-summary-detail").textContent = label.detail;
  el("toggle-proxy-settings")?.toggleAttribute("hidden", locked);
  if (el("toggle-proxy-settings")) el("toggle-proxy-settings").style.display = locked ? "none" : "";
}
function appleLoginErrorText(error) {
  const message = String(error?.message || error || "登录失败");
  if (/ERR_PROXY_CONNECTION_FAILED|CONNECT tunnel failed|502 Bad Gateway/i.test(message)) {
    return "你的代理已经过期或无法连接，请修改配置、取消代理，或获取续费代理后重新检测。";
  }
  if (/socks5 authentication failed|auth method rejected|user was rejected/i.test(message)) {
    return "你的代理已经过期或认证已失效，请修改配置、取消代理，或获取续费代理后重新检测。";
  }
  if (/代理(?:认证|连接)?失败|代理不可达|已过期|已失效|保存的代理配置不可用|ECONNREFUSED|connect failed|timeout|timed out/i.test(message)) {
    return "你的代理已经过期或无法连接，请修改配置、取消代理，或获取续费代理后重新检测。";
  }
  if (/code=-?20101|\b-20101\b|请检查输入的账户信息并重试/.test(message)) {
    return "Apple ID 或密码不正确，请核对后再试";
  }
  return message;
}

function isProxyExpiredLoginError(error) {
  if (/Apple 登录页(?:请求被拒绝 \(403\)|未返回有效认证参数)/.test(String(error?.message || error || ""))) return false;
  return /代理|proxy|ECONNREFUSED|connect failed|timeout|timed out/i.test(String(error?.message || error || ""));
}

function setLoginError(message) {
  const box = el("login-error");
  if (!box) return;
  box.textContent = message || "";
}

function showProxyExpiredLoginError(error) {
  const box = el("login-error");
  if (!box) return;
  const message = appleLoginErrorText(error);
  box.innerHTML = `<div class="login-proxy-expired"><strong>${escapeHTML(message)}</strong><div class="login-proxy-actions"><button class="secondary" id="login-edit-proxy" type="button">修改配置</button><button class="secondary" id="login-disable-proxy" type="button">取消代理</button><button class="primary" id="login-renew-proxy" type="button">获取续费代理</button></div></div>`;
  el("login-edit-proxy")?.addEventListener("click", () => {
    el("proxy-settings")?.classList.add("show");
    el("custom-proxy-enabled").checked = true;
    applyNetworkMode();
    (el("proxy-host")?.value ? el("proxy-password") : el("proxy-host"))?.focus();
  });
  el("login-disable-proxy")?.addEventListener("click", () => {
    el("custom-proxy-enabled").checked = false;
    applyNetworkMode();
    updateLoginNetworkSummary({ enabled: false, mode: "direct" }, { locked: browserBoundLaunch });
    setLoginError("已取消代理，本次登录将使用本机网络直连。");
  });
  el("login-renew-proxy")?.addEventListener("click", async () => {
    const result = await window.appleDeveloper.openExternal(QIANLI_PROXY_URL).catch(errorValue => ({ success: false, error: errorValue.message }));
    if (result?.success === false) setLoginError(result.error || "无法打开续费代理页面");
  });
}

function showLoginError(error) {
  if (isProxyExpiredLoginError(error)) showProxyExpiredLoginError(error);
  else setLoginError(appleLoginErrorText(error));
}
function blockTwoFARetryIfLocked(message) {
  if (!/验证码.*(?:次数过多|锁定)|暂时锁定验证/.test(message)) return false;
  twoFARetryBlocked = true;
  twoFAMethodReady = false;
  el("twofa-code").value = "";
  el("twofa-code").disabled = true;
  return true;
}
function updateTwoFASubmit() { el("submit-twofa").disabled = twoFARetryBlocked || !twoFAMethodReady || !/^\d{6}$/.test(el("twofa-code").value.trim()); }

function trustedTwoFAPhoneLabel(phone, index) {
  const source = String(phone?.lastTwoDigits || phone?.obfuscatedNumber || phone?.numberWithDialCode || phone?.numberWithCountryCode || phone?.phoneNumber || phone?.number || "");
  const tail = (source.match(/\d/g) || []).slice(-4).join("");
  return `受信任手机号 ${index + 1}${tail ? ` · 尾号 ${tail}` : ""}`;
}

function setTrustedTwoFAPhones(phones, preferredPhoneId = "") {
  const seen = new Set();
  trustedTwoFAPhones = (Array.isArray(phones) ? phones : []).filter(phone => {
    if (!phone || phone.id == null) return false;
    const key = String(phone.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const select = el("twofa-phone");
  if (!select) return;
  const previous = String(preferredPhoneId || select.value || "");
  select.replaceChildren();
  if (!trustedTwoFAPhones.length) {
    select.add(new Option("点击“发送验证码”加载受信任手机号", ""));
    select.disabled = true;
    el("sms-method-phone").textContent = "发送至 Apple 账户的受信任手机号";
    return;
  }
  trustedTwoFAPhones.forEach((phone, index) => select.add(new Option(trustedTwoFAPhoneLabel(phone, index), String(phone.id))));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  select.disabled = trustedTwoFAPhones.length < 2;
  el("sms-method-phone").textContent = trustedTwoFAPhones.length > 1
    ? `可选择 ${trustedTwoFAPhones.length} 个受信任手机号`
    : trustedTwoFAPhoneLabel(trustedTwoFAPhones[0], 0);
}

function setTwoFARequestButtonLabel(label) {
  const button = el("request-twofa");
  button.dataset.label = label;
  button.textContent = label;
}

function resetTwoFADelivery() {
  twoFAMethodReady = false;
  el("twofa-code").value = "";
  el("twofa-code").disabled = true;
  el("twofa-error").textContent = "";
  setTwoFARequestButtonLabel("发送验证码");
  updateTwoFASubmit();
}

function renderTwoFAMethod(options = {}) {
  const device = twoFAMethod() === "device";
  const initialCodeAutomaticallySent = options?.initialCodeAutomaticallySent === true;
  resetTwoFADelivery();
  el("twofa-panel-title").textContent = device ? "输入设备验证码" : "输入短信验证码";
  el("twofa-panel-copy").textContent = device
    ? (initialCodeAutomaticallySent
      ? "Apple 已在本次登录中自动发送验证码，请输入受信任设备上显示的 6 位数字。"
      : "点击“发送验证码”后，请输入 Apple 受信任设备上显示的 6 位数字。")
    : (initialCodeAutomaticallySent
      ? "Apple 已在本次登录中自动发送短信，请输入收到的 6 位验证码。"
      : (trustedTwoFAPhones.length
        ? "选择 Apple 账户已绑定的受信任手机号，点击发送后输入收到的 6 位数字。"
        : "首次点击“发送验证码”会从 Apple 读取受信任手机号，有多个号码时可再选择。"));
  el("twofa-phone-field").hidden = device;
  if (initialCodeAutomaticallySent) {
    twoFAMethodReady = true;
    el("twofa-code").disabled = false;
    el("twofa-status").className = "ipbox ok";
    el("twofa-status").textContent = device ? "Apple 已自动发送设备验证码，可直接输入" : "Apple 已自动发送短信验证码，可直接输入";
    setTwoFARequestButtonLabel("重新发送");
    updateTwoFASubmit();
  } else {
    el("twofa-status").className = "ipbox";
    el("twofa-status").textContent = "请先点击发送验证码";
  }
}

function setTwoFADeliveryControlsDisabled(disabled) {
  document.querySelectorAll('input[name="twofa-method"]').forEach(input => { input.disabled = disabled; });
  el("twofa-phone").disabled = disabled || trustedTwoFAPhones.length < 2;
  el("request-twofa").disabled = disabled || twoFARetryBlocked;
  el("twofa-back").disabled = disabled;
}

function showAccountStep() {
  appleLoginAwaiting2FA = false;
  applyLoginLaunchRestrictions();
  if (browserBoundLaunch) {
    showLoginForm({ appleId: launchAppleId, locked: true });
    return;
  }
  el("account-picker").classList.remove("hidden");
  el("login-form").classList.add("hidden");
  el("twofa-form").classList.remove("show");
  el("dialog-title").textContent = "Apple 开发者账户";
}

function showLoginForm({ appleId = "", locked = false, proxy = null } = {}) {
  applyLoginLaunchRestrictions();
  el("account-picker").classList.add("hidden");
  el("login-form").classList.remove("hidden");
  el("twofa-form").classList.remove("show");
  el("apple-id").value = appleId;
  el("apple-id").readOnly = locked;
  el("apple-id-lock-note").textContent = locked ? "已选择本机账户" : "";
  el("apple-password").value = "";
  const savedProxy = proxy && typeof proxy === "object" ? proxy : { enabled: false };
  el("custom-proxy-enabled").checked = savedProxy.enabled === true;
  el("proxy-type").value = savedProxy.type || savedProxy.mode || "http";
  el("proxy-host").value = savedProxy.host || "";
  el("proxy-port").value = savedProxy.port || "";
  el("proxy-username").value = savedProxy.username || "";
  el("proxy-password").value = savedProxy.password || "";
  verifiedProxyKey = "";
  verifiedProxyIP = "";
  applyNetworkMode();
  updateLoginNetworkSummary(locked ? launchNetwork : savedProxy, { locked });
  el("dialog-title").textContent = appleId ? `登录 ${appleId}` : "添加 Apple 账户";
  setTimeout(() => (appleId ? el("apple-password") : el("apple-id")).focus(), 0);
}

function showVerifyStep() {
  appleLoginAwaiting2FA = true;
  el("account-picker").classList.add("hidden");
  el("login-form").classList.add("hidden");
  el("twofa-form").classList.add("show");
  el("dialog-title").textContent = "Apple 双重验证";
}

async function showLogin() {
  if (appleLoginInProgress) return;
  el("login-mask").classList.add("show");
  showAccountStep();
  el("login-error").textContent = "";
  if (!browserBoundLaunch) await refreshSavedAccountHistory();
}
function closeLogin({ completed = false } = {}) {
  if (appleLoginInProgress && !completed) return;
  el("login-mask").classList.remove("show");
  el("apple-password").value = "";
  el("proxy-password").value = "";
}

function formatAgreementDate(timestamp) {
  if (!timestamp) return "—";
  const numeric = Number(timestamp);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function agreementHTMLToText(html = "") {
  const documentValue = new DOMParser().parseFromString(String(html || ""), "text/html");
  return String(documentValue.body?.textContent || html || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAppStoreTermsAgreement(terms = {}) {
  const termsType = String(terms.termsType || terms.id || "ASC").trim() || "ASC";
  return {
    source: "app-store-connect",
    id: termsType,
    termsType,
    title: "App Store Connect 服务条款",
    version: Number(terms.version || 0),
    role: "App Store Connect",
    agreementHTML: String(terms.html || ""),
    dateEffective: terms.refreshed || "",
  };
}

function showAgreementNotice(agreement) {
  const notice = el("agreement-notice");
  if (!notice || !agreement) return;
  notice.classList.remove("agreement-success");
  notice.classList.add("show");
  el("agreement-view")?.classList.remove("hidden");
  if (agreement.source === "app-store-connect") {
    el("agreement-notice-title").textContent = "有新的 App Store Connect 服务条款需要同意";
    el("agreement-notice-detail").textContent = `版本 ${agreement.version || "—"}。同意前 App 管理、App Store 上传和审核相关功能可能不可用。`;
    return;
  }
  el("agreement-notice-title").textContent = agreement.title || "有新的 Apple Developer 协议需要同意";
  el("agreement-notice-detail").textContent = `版本 ${agreement.version || "—"} · 最晚同意日期 ${formatAgreementDate(agreement.dateAgreeBy)}。同意前证书、Bundle ID、设备和描述文件功能可能不可用。`;
}

async function readAppStoreTermsStatus() {
  if (typeof window.appleDeveloper.appStoreTermsStatus !== "function") return { success: true, required: false, terms: null };
  if (!appStoreTermsStatusPromise) {
    appStoreTermsStatusPromise = window.appleDeveloper.appStoreTermsStatus()
      .catch(error => ({ success: false, error: error.message || "App Store Connect 服务条款读取失败" }))
      .finally(() => { appStoreTermsStatusPromise = null; });
  }
  return appStoreTermsStatusPromise;
}

async function ensureAppStoreTermsAccepted({ prompt = false } = {}) {
  if (!authenticated) return false;
  const result = await readAppStoreTermsStatus();
  if (!result?.success) throw new Error(result?.error || "App Store Connect 服务条款读取失败");
  if (!result.required) return true;
  currentAgreement = normalizeAppStoreTermsAgreement(result.terms || {});
  showAgreementNotice(currentAgreement);
  if (prompt) await openAgreementDialog();
  return false;
}

function showAppStoreTermsRequiredState(message = "需要先同意 App Store Connect 服务条款，才能继续读取 App 管理数据。") {
  const content = el("app-store-content");
  if (content) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">!</div><strong>需要同意服务条款</strong><span>${escapeHTML(message)}</span><button class="primary" id="app-store-terms-open" type="button">查看并同意</button></div>`;
    el("app-store-terms-open")?.addEventListener("click", openAgreementDialog);
  }
  if (el("app-store-count")) el("app-store-count").textContent = "需同意条款";
}

function showAppStoreAccessErrorState(message = "App Store Connect 会话已过期，请重新登录后重试。") {
  const content = el("app-store-content");
  if (content) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">!</div><strong>App Store Connect 会话已过期</strong><span>${escapeHTML(message)}</span><button class="primary" id="app-store-access-retry" type="button">重新登录</button></div>`;
    el("app-store-access-retry")?.addEventListener("click", showLogin);
  }
  if (el("app-store-count")) el("app-store-count").textContent = "需重新登录";
}

async function loadAgreementStatus() {
  const notice = el("agreement-notice");
  if (!authenticated) {
    currentAgreement = null;
    notice.classList.remove("show", "agreement-success");
    return;
  }
  const refreshButton = el("agreement-refresh");
  setBusy(refreshButton, true, "检查中…");
  try {
    const termsResult = await readAppStoreTermsStatus();
    if (termsResult.required) {
      currentAgreement = normalizeAppStoreTermsAgreement(termsResult.terms || {});
      showAgreementNotice(currentAgreement);
      return;
    }
    const result = await readDeveloperAgreementStatus();
    if (!result?.success) {
      if (result?.teamRequired) {
        currentAgreement = null;
        notice.classList.remove("show");
        return;
      }
      throw new Error(result?.error || "协议状态读取失败");
    }
    currentAgreement = result.outstanding?.[0] || null;
    if (currentAgreement) {
      currentAgreement = { ...currentAgreement, source: "apple-developer" };
      showAgreementNotice(currentAgreement);
      return;
    }
    currentAgreement = null;
    if (!currentAgreement) {
      notice.classList.remove("show");
      return;
    }
  } catch (error) {
    currentAgreement = null;
    notice.classList.add("show");
    notice.classList.remove("agreement-success");
    el("agreement-notice-title").textContent = "Apple 协议状态检查失败";
    el("agreement-notice-detail").textContent = error.message || "请稍后重新检查";
  } finally { setBusy(refreshButton, false); }
}

function closeAgreementDialog() {
  el("agreement-mask").classList.remove("show");
  el("agreement-confirm").checked = false;
  el("agreement-accept").disabled = true;
  el("agreement-accept").style.display = "";
  el("agreement-cancel").textContent = "取消";
  const confirmRow = document.querySelector(".agreement-confirm");
  if (confirmRow) confirmRow.style.display = "";
  el("agreement-error").textContent = "";
}

async function openAgreementDialog() {
  if (!currentAgreement) {
    await loadAgreementStatus();
    if (!currentAgreement) return;
  }
  const agreement = currentAgreement;
  const readOnly = agreement.readOnly === true;
  el("agreement-mask").classList.add("show");
  el("agreement-dialog-title").textContent = agreement.title || "Apple Developer 协议";
  el("agreement-meta").textContent = agreement.source === "app-store-connect"
    ? `版本 ${agreement.version || "—"}　·　服务 App Store Connect`
    : agreement.source === "home-info"
      ? (agreement.metaText || "协议状态")
    : `版本 ${agreement.version || "—"}　·　生效日期 ${formatAgreementDate(agreement.dateEffective)}　·　团队角色 ${agreement.role || "—"}`;
  el("agreement-content").textContent = "正在读取协议正文…";
  el("agreement-confirm").checked = false;
  el("agreement-accept").disabled = true;
  el("agreement-accept").style.display = readOnly ? "none" : "";
  el("agreement-cancel").textContent = readOnly ? "关闭" : "取消";
  el("agreement-error").textContent = "";
  const confirmCopy = document.querySelector(".agreement-confirm span");
  const confirmRow = document.querySelector(".agreement-confirm");
  if (confirmRow) confirmRow.style.display = readOnly ? "none" : "";
  if (confirmCopy) confirmCopy.textContent = agreement.source === "app-store-connect"
    ? "本人已阅读并同意上述 App Store Connect 服务条款。此操作将代表当前账户接受条款，提交后无法撤销。"
    : "我已阅读并同意上述 Apple Developer 协议。此操作将代表当前团队接受协议，提交后无法撤销。";
  el("agreement-accept").textContent = agreement.source === "app-store-connect" ? "同意" : "同意协议";
  try {
    if (agreement.source === "home-info") {
      const text = agreement.agreementHTML ? agreementHTMLToText(agreement.agreementHTML) : String(agreement.agreementText || "");
      el("agreement-content").textContent = text || "暂无可显示的协议详情。";
      return;
    }
    if (agreement.source === "app-store-connect") {
      const text = agreementHTMLToText(agreement.agreementHTML);
      el("agreement-content").textContent = text || "Apple 未返回可显示的服务条款正文。";
      return;
    }
    const result = await window.appleDeveloper.agreementDetail({ agreementId: agreement.id });
    if (!result?.success) throw new Error(result?.error || "协议正文读取失败");
    currentAgreement = { ...agreement, ...(result.agreement || {}) };
    const text = agreementHTMLToText(currentAgreement.agreementHTML);
    el("agreement-content").textContent = text || "Apple 未返回可显示的协议正文。";
  } catch (error) {
    el("agreement-content").textContent = "协议正文读取失败";
    el("agreement-error").textContent = error.message;
  }
}

async function acceptCurrentAgreement() {
  if (!currentAgreement || !el("agreement-confirm").checked) return;
  const button = el("agreement-accept");
  el("agreement-error").textContent = "";
  setBusy(button, true, "正在提交…");
  try {
    const appStoreTerms = currentAgreement.source === "app-store-connect";
    const result = appStoreTerms
      ? await window.appleDeveloper.acceptAppStoreTerms({ termsType: currentAgreement.termsType || currentAgreement.id, version: currentAgreement.version })
      : await window.appleDeveloper.acceptAgreement({ agreementId: currentAgreement.id });
    if (!result?.success) throw new Error(result?.error || (appStoreTerms ? "服务条款同意失败" : "协议同意失败"));
    closeAgreementDialog();
    currentAgreement = null;
    const notice = el("agreement-notice");
    notice.classList.add("show", "agreement-success");
    el("agreement-notice-title").textContent = appStoreTerms ? "App Store Connect 服务条款已同意" : "Apple Developer 协议已同意";
    el("agreement-notice-detail").textContent = appStoreTerms ? "Apple 已返回成功结果，正在刷新 App 管理数据。" : "Apple 已返回成功结果，正在刷新当前团队权限和资源。";
    el("agreement-view").classList.add("hidden");
    await loadAgreementStatus();
    el("agreement-view").classList.remove("hidden");
    const activeModule = document.querySelector(".nav.active")?.dataset.page;
    if (["apps", "bundle", "profiles", "certificates", "devices"].includes(activeModule)) await refreshModule(activeModule);
    if (activeModule === "home") await loadHomeOverview({ force: true });
    await refreshAutomationIfActive();
  } catch (error) {
    el("agreement-error").textContent = error.message;
  } finally { setBusy(button, false); }
}

const PAID_AGREEMENT_DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4h14v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function isPaidAppAgreementActive(agreement = {}) {
  return agreement.isInEffect === true || /Active|有效|已同意/i.test(`${agreement.status || ""} ${agreement.statusText || ""}`);
}

function isPendingPaidAppAgreement(agreement = {}) {
  if (agreement.kind !== "paid-app" || isPaidAppAgreementActive(agreement)) return false;
  const hasNewContractConfig = !!String(agreement.availableNewContractConfigId || "").trim();
  const actions = agreement.applicableActions && typeof agreement.applicableActions === "object"
    ? agreement.applicableActions
    : {};
  const signActions = [...(Array.isArray(actions.setup) ? actions.setup : []), ...(Array.isArray(actions.edit) ? actions.edit : [])]
    .map(item => String(typeof item === "object" ? (item.action || item.type || item.name || "") : item || "").toLowerCase());
  return hasNewContractConfig || signActions.some(item => /sign|accept|agree|setup/.test(item));
}

function homePendingPaidAppAgreement() {
  const agreements = Array.isArray(homeBusinessStatus?.businessAgreements) ? homeBusinessStatus.businessAgreements : [];
  return agreements.find(isPendingPaidAppAgreement) || null;
}

function paidAppAgreementPayload(agreement = currentPaidAppAgreement || {}) {
  return paidAppAgreementPayloadWithOptions(agreement, {});
}

function paidAppAgreementPayloadWithOptions(agreement = currentPaidAppAgreement || {}, options = {}) {
  const availableNewConfigLocales = Array.isArray(agreement.availableNewConfigLocales) ? agreement.availableNewConfigLocales : [];
  const configLocales = Array.isArray(agreement.configLocales) ? agreement.configLocales : [];
  const availableLocales = Array.isArray(agreement.availableLocales) ? agreement.availableLocales : [];
  return {
    accountId: homeBusinessStatus?.provider?.id || agreement.providerPublicId || "",
    legalEntityId: homeBusinessStatus?.legalEntity?.id || agreement.legalEntityId || "",
    contractConfigId: agreement.contractConfigId || agreement.availableNewContractConfigId || agreement.configId || agreement.id || "",
    availableNewContractConfigId: agreement.availableNewContractConfigId || "",
    configId: agreement.configId || "",
    selectedLocaleCode: agreement.selectedLocaleCode || agreement.localeCode || availableNewConfigLocales[0] || configLocales[0] || availableLocales[0] || "en-US",
    termFilePublicId: agreement.termFilePublicId || "",
    agreeToFamilyShare: agreement.agreeToFamilyShare !== false,
    auxStorageInfoTOs: Array.isArray(agreement.auxStorageInfoTOs) ? agreement.auxStorageInfoTOs : [],
    attachments: Array.isArray(agreement.attachments) ? agreement.attachments : [],
    clientFingerprint: String(options.clientFingerprint || agreement.clientFingerprint || ""),
  };
}

function paidAppAgreementSetReadOnly(readOnly) {
  const confirmRow = el("paid-agreement-confirm-row");
  const accept = el("paid-agreement-accept");
  const cancel = el("paid-agreement-cancel");
  if (confirmRow) confirmRow.style.display = readOnly ? "none" : "";
  if (accept) accept.style.display = readOnly ? "none" : "";
  if (cancel) cancel.textContent = readOnly ? "关闭" : "取消";
}

function closePaidAppAgreementDialog() {
  paidAppAgreementRequestSeq += 1;
  currentPaidAppAgreement = null;
  el("paid-agreement-mask")?.classList.remove("show");
  if (el("paid-agreement-confirm")) el("paid-agreement-confirm").checked = false;
  if (el("paid-agreement-accept")) el("paid-agreement-accept").disabled = true;
  if (el("paid-agreement-error")) el("paid-agreement-error").textContent = "";
}

function setPaidAgreementAttachmentExpanded(expanded) {
  const toggle = el("paid-agreement-attachments-toggle");
  const body = el("paid-agreement-attachments");
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  body.hidden = !expanded;
}

function renderPaidAppAgreementAttachments(agreement = {}) {
  const wrap = el("paid-agreement-attachments-wrap");
  const body = el("paid-agreement-attachments");
  if (!wrap || !body) return;
  const attachments = Array.isArray(agreement.attachments) ? agreement.attachments : [];
  wrap.style.display = attachments.length ? "" : "none";
  if (!attachments.length) {
    body.innerHTML = "";
    return;
  }
  body.innerHTML = attachments.map((attachment, index) => `<div class="paid-agreement-attachment-row">
    <span>${escapeHTML(attachment.fileName || "Agreement Attachment")}</span>
    <button class="paid-agreement-file-download" type="button" data-paid-agreement-attachment="${index}" title="下载附件" aria-label="下载附件">${PAID_AGREEMENT_DOWNLOAD_ICON}</button>
  </div>`).join("");
  body.querySelectorAll("[data-paid-agreement-attachment]").forEach(button => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.paidAgreementAttachment || 0);
      downloadPaidAppAgreementDocument("attachment", attachments[index] || null, button);
    });
  });
  setPaidAgreementAttachmentExpanded(true);
}

function updatePaidAgreementAcceptState() {
  const button = el("paid-agreement-accept");
  if (!button || button.style.display === "none") return;
  const checked = el("paid-agreement-confirm")?.checked === true;
  const ready = !!(currentPaidAppAgreement?.detailReady && currentPaidAppAgreement?.contractConfigId);
  button.disabled = currentPaidAppAgreement?.readOnly === true || !checked || !ready;
}

function renderPaidAppAgreementDetail(agreement = {}) {
  el("paid-agreement-dialog-title").textContent = agreement.title || "付费 App 协议";
  const text = agreementHTMLToText(agreement.agreementHTML || "");
  el("paid-agreement-content").textContent = text || "Apple 未返回可显示的付费 App 协议正文。";
  el("paid-agreement-download").disabled = false;
  renderPaidAppAgreementAttachments(agreement);
  updatePaidAgreementAcceptState();
}

async function openPaidAppAgreementDialog(agreement = null, options = {}) {
  const sourceAgreement = agreement || homePendingPaidAppAgreement();
  if (!sourceAgreement) return;
  const readOnly = options.readOnly === true || isPaidAppAgreementActive(sourceAgreement);
  const mask = el("paid-agreement-mask");
  if (!mask) return;
  const requestId = ++paidAppAgreementRequestSeq;
  currentPaidAppAgreement = { ...sourceAgreement, readOnly, detailReady: false };
  mask.classList.add("show");
  paidAppAgreementSetReadOnly(readOnly);
  el("paid-agreement-dialog-title").textContent = sourceAgreement.title || "付费 App 协议";
  el("paid-agreement-content").textContent = "正在读取协议正文…";
  el("paid-agreement-error").textContent = "";
  el("paid-agreement-download").disabled = true;
  el("paid-agreement-confirm").checked = false;
  el("paid-agreement-attachments-wrap").style.display = "none";
  updatePaidAgreementAcceptState();
  try {
    if (typeof window.appleDeveloper.appStoreBusinessAgreementDetail !== "function") throw new Error("当前版本缺少付费 App 协议详情接口，请重启软件后再试");
    const result = await window.appleDeveloper.appStoreBusinessAgreementDetail(paidAppAgreementPayload(sourceAgreement));
    if (requestId !== paidAppAgreementRequestSeq || !mask.classList.contains("show")) return;
    if (!result?.success) throw new Error(result?.error || "付费 App 协议读取失败");
    currentPaidAppAgreement = { ...sourceAgreement, ...(result.agreement || {}), readOnly, detailReady: true };
    renderPaidAppAgreementDetail(currentPaidAppAgreement);
  } catch (error) {
    if (requestId !== paidAppAgreementRequestSeq) return;
    el("paid-agreement-content").textContent = "协议正文读取失败";
    el("paid-agreement-error").textContent = error.message || "付费 App 协议读取失败";
    updatePaidAgreementAcceptState();
  }
}

async function downloadPaidAppAgreementDocument(kind = "agreement", attachment = null, button = null) {
  const targetButton = button || el("paid-agreement-download");
  const previousHTML = targetButton?.innerHTML || "";
  if (targetButton) {
    targetButton.disabled = true;
    if (targetButton.id === "paid-agreement-download") targetButton.innerHTML = `${PAID_AGREEMENT_DOWNLOAD_ICON}<span>下载中…</span>`;
  }
  el("paid-agreement-error").textContent = "";
  try {
    const agreement = currentPaidAppAgreement || {};
    const filename = kind === "attachment"
      ? `${attachment?.fileName || "Exhibits to Schedule 2 and 3 - 29 January 2026"}.pdf`
      : `${agreement.title || "付费 App 协议"}.pdf`;
    const result = await window.appleDeveloper.downloadAppStoreBusinessAgreement({
      kind,
      filename,
      url: kind === "attachment" ? agreement.attachmentDownloadUrl : agreement.primaryDownloadUrl,
    });
    if (!result?.success && !result?.canceled) throw new Error(result?.error || "协议文件下载失败");
  } catch (error) {
    el("paid-agreement-error").textContent = error.message || "协议文件下载失败";
  } finally {
    if (targetButton) {
      targetButton.disabled = false;
      if (previousHTML) targetButton.innerHTML = previousHTML;
    }
  }
}

async function acceptPaidAppAgreement() {
  if (!currentPaidAppAgreement || currentPaidAppAgreement.readOnly === true || !el("paid-agreement-confirm")?.checked) return;
  const button = el("paid-agreement-accept");
  el("paid-agreement-error").textContent = "";
  setBusy(button, true, "正在提交…");
  try {
    const result = await window.appleDeveloper.acceptAppStoreBusinessAgreement(
      paidAppAgreementPayloadWithOptions(currentPaidAppAgreement, { clientFingerprint: generateAppleClientFingerprint() })
    );
    if (result?.requires2FA) {
      openLegalEntityMfaDialog({ ...result, kind: "business-agreement" });
      return;
    }
    if (!result?.success) throw new Error(result?.error || "付费 App 协议签署失败");
    closePaidAppAgreementDialog();
    await loadHomeOverview({ force: true });
  } catch (error) {
    el("paid-agreement-error").textContent = error.message || "付费 App 协议签署失败";
  } finally {
    setBusy(button, false);
    updatePaidAgreementAcceptState();
  }
}

function homeAccessInfo() {
  const access = currentAccess || {};
  const activated = access.activated === true || !!access.authorizationExpiresAt;
  const expired = access.authorizationExpired === true || access.trialExpired === true || access.allowed === false;
  const expiryValue = activated ? access.authorizationExpiresAt : access.trialExpiresAt;
  const startValue = access.firstLoginAt || access.activatedAt || "";
  const trialBaseline = Math.max(1, Number(access.trialDays || access.trialDaysSnapshot) || 15);
  let expiryText = formatAccessDate(expiryValue);
  let remainingDays = Number(access.remainingDays);
  if (!Number.isFinite(remainingDays) && expiryValue) {
    const expiryDate = new Date(expiryValue);
    if (!Number.isNaN(expiryDate.getTime())) {
      remainingDays = Math.ceil((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    }
  }
  if (expired) remainingDays = 0;
  const normalizedRemaining = Number.isFinite(remainingDays) ? Math.max(0, Math.ceil(remainingDays)) : null;
  if (!expiryText && normalizedRemaining !== null && !expired) {
    expiryText = formatAccessDate(Date.now() + normalizedRemaining * 24 * 60 * 60 * 1000);
  }
  let elapsedDays = null;
  if (startValue) {
    const start = new Date(startValue);
    if (!Number.isNaN(start.getTime()) && start.getTime() <= Date.now()) {
      elapsedDays = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
    }
  }
  if (elapsedDays === null && normalizedRemaining !== null) {
    const baseline = activated ? Math.max(normalizedRemaining, trialBaseline) : trialBaseline;
    elapsedDays = Math.max(0, baseline - normalizedRemaining);
  }
  const totalDays = (elapsedDays || 0) + (normalizedRemaining || 0) || trialBaseline;
  const progress = expired
    ? 100
    : totalDays
      ? Math.max(0, Math.min(100, Math.round(((elapsedDays || 0) / totalDays) * 100)))
      : (access.allowed === true ? 0 : 100);
  return {
    label: activated ? "授权版本" : "免费试用",
    statusText: expired ? "已到期" : activated ? "已授权" : access.allowed === true ? "试用中" : "未开通",
    expiryText: expired ? "已到期" : expiryText || "—",
    remainingText: normalizedRemaining === null ? "—" : String(normalizedRemaining),
    elapsedText: elapsedDays === null ? "—" : String(elapsedDays),
    progress,
  };
}

function formatHomeBusinessDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function homeMembershipTeam() {
  const teams = Array.isArray(homeAccountInfo?.teams) ? homeAccountInfo.teams : [];
  return teams.find(item => item.id === homeAccountInfo?.selectedTeamId) || teams[0] || null;
}

function renderHomeMembershipDetails() {
  if (!authenticated) return "";
  const account = homeAccountInfo?.account || {};
  const team = homeMembershipTeam();
  if (!team && (!homeOverviewCache.account.loaded || homeOverviewCache.account.loading)) {
    return `<section class="home-membership-panel"><div class="home-membership-head"><h2>会员资格详细信息</h2><span class="home-status muted">读取中</span></div><div class="home-membership-loading" role="status" aria-label="正在读取 Apple Developer 会员信息"><i class="loading-spinner" aria-hidden="true"></i></div></section>`;
  }
  if (!team) {
    const failed = homeAccountInfo?.success === false;
    return `<section class="home-membership-panel"><div class="home-membership-head"><h2>会员资格详细信息</h2><span class="home-status ${failed ? "bad" : "muted"}">${failed ? "读取失败" : "暂无"}</span></div><div class="home-membership-empty"><span>${escapeHTML(homeAccountInfo?.error || "暂无开发者团队信息")}</span><button class="secondary" type="button" data-home-action="retry-membership">重新读取</button></div></section>`;
  }
  const rows = [
    ["姓名", account.name || team.name || "—"],
    ["团队 ID", team.id || "—"],
    ["计划", team.program || "—"],
    ["注册身份", team.identityType || "—"],
    ["账户角色", (Array.isArray(team.roles) ? team.roles.join("、") : "") || "—"],
    ["电话", team.phone || "—"],
    ["续订日期", formatAccountDate(team.expirationDate)],
    ["年费", team.fee || "—"],
    ["设备重置日期", formatAccountDate(team.deviceResetDate)],
    ["状态", accountStatusText(team.status)],
    ["街道地址", team.address || "—", "wide"],
  ];
  const loading = homeOverviewCache.account.loading;
  const failed = homeAccountInfo?.success === false;
  return `<section class="home-membership-panel">
    <div class="home-membership-head"><h2>会员资格详细信息</h2><span class="home-status ${loading ? "muted" : failed ? "bad" : "ok"}">${loading ? "更新中" : failed ? "更新失败" : escapeHTML(accountStatusText(team.status))}</span></div>
    ${failed && !loading ? `<div class="home-membership-error" role="status"><span>当前显示上次读取的资料。${escapeHTML(homeAccountInfo.error || "会员信息更新失败")}</span><button class="secondary" type="button" data-home-action="retry-membership">重新读取</button></div>` : ""}
    <dl class="home-membership-grid">${rows.map(([label, value, wide]) => `<dt class="${wide ? "wide" : ""}">${escapeHTML(label)}</dt><dd class="${wide ? "wide" : ""}">${escapeHTML(value)}</dd>`).join("")}</dl>
  </section>`;
}

function formatHomeComplianceDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

function formatHomeBusinessDateRange(row = {}) {
  const start = formatHomeBusinessDate(row.effectiveDate);
  const end = formatHomeBusinessDate(row.expirationDate);
  if (start === "—" && end === "—") return "—";
  if (end === "—") return start;
  return `${start} - ${end}`;
}

function businessStatusClass(statusText = "") {
  const text = String(statusText || "");
  if (/有效|已同意|正常|可用|达标/i.test(text)) return "ok";
  if (/需|待|新|受阻|未通过/i.test(text)) return "warn";
  if (/失败|过期|错误/i.test(text)) return "bad";
  return "muted";
}

function homeBusinessAgreementSource(row = {}) {
  if (row.kind === "paid-app") return "App Store Connect 商务";
  if (row.kind === "free-app") return "App Store Connect 商务";
  return "商务协议";
}

function homeBusinessAgreementCountryText(agreement = {}) {
  if (agreement.countryScopeText) return agreement.countryScopeText;
  if (Number(agreement.countriesCount || 0) > 0) return `${agreement.countriesCount} 个国家或地区`;
  return "—";
}

function homeProtocolRows() {
  const rows = [];
  const termsRequired = homeTermsStatus?.required === true;
  const termsVersion = homeTermsStatus?.terms?.version || "";
  rows.push({
    id: "asc-terms",
    type: "asc",
    title: "App Store Connect 服务条款",
    source: "App Store Connect",
    meta: termsRequired ? `版本 ${termsVersion || "—"}` : homeTermsStatus?.success ? "当前账户已同意最新条款" : homeTermsStatus?.error || (authenticated ? "等待检查" : "登录后检查"),
    dateText: termsRequired ? "需同意后可继续 App 管理" : "—",
    statusText: termsRequired ? "待同意" : homeTermsStatus?.success ? "已同意" : authenticated ? "未知" : "未登录",
    statusClass: termsRequired ? "warn" : homeTermsStatus?.success ? "ok" : "muted",
  });

  const outstanding = Array.isArray(homeDeveloperAgreementStatus?.outstanding) ? homeDeveloperAgreementStatus.outstanding : [];
  const developerAgreement = outstanding[0] || null;
  rows.push({
    id: "developer-terms",
    type: "developer",
    title: "Apple Developer 协议",
    source: "developer.apple.com/account",
    meta: developerAgreement ? `版本 ${developerAgreement.version || "—"}` : homeDeveloperAgreementStatus?.teamRequired ? "需要先选择开发者团队" : homeDeveloperAgreementStatus?.success ? "当前团队已同意最新协议" : homeDeveloperAgreementStatus?.error || (authenticated ? "等待检查" : "登录后检查"),
    dateText: developerAgreement ? `最晚同意 ${formatAgreementDate(developerAgreement.dateAgreeBy)}` : "—",
    statusText: developerAgreement ? "待同意" : homeDeveloperAgreementStatus?.success ? "已同意" : homeDeveloperAgreementStatus?.teamRequired ? "待选择团队" : authenticated ? "未知" : "未登录",
    statusClass: developerAgreement || homeDeveloperAgreementStatus?.teamRequired ? "warn" : homeDeveloperAgreementStatus?.success ? "ok" : "muted",
  });

  const businessAgreements = Array.isArray(homeBusinessStatus?.businessAgreements) ? homeBusinessStatus.businessAgreements : [];
  const orderedAgreements = [...businessAgreements].sort((left, right) => {
    const weight = value => value.kind === "free-app" ? 0 : value.kind === "paid-app" ? 1 : 2;
    return weight(left) - weight(right);
  });
  orderedAgreements.forEach((agreement, index) => {
    const blocked = agreement.kind === "paid-app" && homeBusinessStatus?.requiresLegalEntityUpdate;
    const paidPending = isPendingPaidAppAgreement(agreement);
    rows.push({
      id: `business-${agreement.kind}-${agreement.id || index}`,
      type: "business",
      agreement,
      title: agreement.title || "商务协议",
      source: homeBusinessAgreementSource(agreement),
      meta: blocked ? "签署前需更新法律实体" : (agreement.countriesCount ? `${agreement.countriesCount} 个国家或地区` : agreement.contractDisplayName || "商务协议"),
      countryText: homeBusinessAgreementCountryText(agreement),
      countries: Array.isArray(agreement.countries) ? agreement.countries : [],
      dateText: formatHomeBusinessDateRange(agreement),
      statusText: blocked ? "受阻" : agreement.statusText || "—",
      statusClass: blocked ? "warn" : businessStatusClass(agreement.statusText),
      actionLabel: blocked ? "编辑法律实体" : paidPending ? "查看并同意条款" : "查看协议",
    });
  });
  if (authenticated && homeBusinessStatus?.success && !orderedAgreements.length) {
    rows.push({
      id: "business-empty",
      type: "business-empty",
      title: "商务协议",
      source: "App Store Connect 商务",
      meta: "Apple 当前未返回商务协议列表",
      dateText: "—",
      statusText: "无数据",
      statusClass: "muted",
    });
  }
  if (authenticated && homeBusinessStatus?.success === false) {
    rows.push({
      id: "business-error",
      type: "business-error",
      title: "商务协议",
      source: "App Store Connect 商务",
      meta: homeBusinessStatus.error || "商务状态读取失败",
      dateText: "—",
      statusText: "读取失败",
      statusClass: "bad",
    });
  }

  return rows;
}

function homeComplianceRows() {
  const legacyRows = Array.isArray(homeBusinessStatus?.complianceInfo) ? homeBusinessStatus.complianceInfo : [];
  const requirementRows = Array.isArray(homeBusinessStatus?.complianceRequirements) ? homeBusinessStatus.complianceRequirements : [];
  const rows = [];
  legacyRows.forEach((item, index) => {
    rows.push({
      id: `legacy-compliance-${item.id || index}`,
      title: item.title || "合规信息",
      countryText: item.countryScopeText || (Array.isArray(item.countries) && item.countries.length ? `${item.countries.length} 个国家或地区` : "—"),
      countries: Array.isArray(item.countries) ? item.countries : [],
      dateText: formatHomeComplianceDate(item.lastUpdated),
      statusText: item.statusText || "—",
      statusClass: businessStatusClass(item.statusText),
      actionLabel: "",
      requirement: null,
    });
  });
  requirementRows.forEach((item, index) => {
    const missing = item.statusText === "缺少信息";
    rows.push({
      id: `compliance-requirement-${item.id || index}`,
      title: item.title || "合规要求",
      countryText: item.countryScopeText || "—",
      countries: Array.isArray(item.countries) ? item.countries : [],
      dateText: formatHomeComplianceDate(item.lastUpdated),
      statusText: item.statusText || (missing ? "缺少信息" : "—"),
      statusClass: missing ? "warn" : businessStatusClass(item.statusText),
      actionLabel: missing && item.canEdit ? "添加信息" : "",
      requirement: item,
    });
  });
  return rows;
}

function homeBusinessMessage(messageKey) {
  return (Array.isArray(homeBusinessStatus?.accountMessages) ? homeBusinessStatus.accountMessages : [])
    .find(item => item?.messageKey === messageKey) || null;
}

function homeNeedsBankAccount() {
  const bankAccounts = Array.isArray(homeBusinessStatus?.bankAccounts) ? homeBusinessStatus.bankAccounts : [];
  const pendingBankAccounts = Array.isArray(homeBusinessStatus?.pendingBankAccounts) ? homeBusinessStatus.pendingBankAccounts : [];
  const bankState = homeBusinessStatus?.legalEntityState || {};
  return !bankAccounts.length && !pendingBankAccounts.length && (
    bankState.canCreateBank === true ||
    !!homeBusinessMessage("PPM.banking.bankingAccount.setup.message")
  );
}

function bankCountryLabel(code = "", fallback = "") {
  const value = String(code || fallback || "");
  const labels = {
    CHN: "中国大陆",
    CN: "中国大陆",
    USA: "美国",
    US: "美国",
    HKG: "香港",
    MAC: "澳门",
    TWN: "台湾",
    JPN: "日本",
    KOR: "韩国",
    SGP: "新加坡",
  };
  return labels[value] || String(fallback || value || "—");
}

function bankAccountStatusClass(text = "") {
  if (/可用|有效|active|available|approved/i.test(String(text || ""))) return "ok";
  if (/不可用|失败|拒绝|invalid|reject|failed/i.test(String(text || ""))) return "bad";
  if (/待|处理中|pending|review|process/i.test(String(text || ""))) return "warn";
  return "muted";
}

function homeBankRows() {
  const activeRows = Array.isArray(homeBusinessStatus?.bankAccounts) ? homeBusinessStatus.bankAccounts : [];
  const pendingRows = Array.isArray(homeBusinessStatus?.pendingBankAccounts) ? homeBusinessStatus.pendingBankAccounts : [];
  return [...activeRows.map(row => ({ ...row, pending: false })), ...pendingRows.map(row => ({ ...row, pending: true }))].map((row, index) => {
    const raw = row?.raw && typeof row.raw === "object" ? row.raw : row || {};
    const address = raw.accountHolderAddress || raw.address || {};
    const country = String(row.country || raw.selectedCountry || raw.country || address.country || "");
    const account = String(row.account || raw.displayName || raw.nickName || raw.bankAccountName || raw.name || "银行账户");
    const statusText = String(row.statusText || raw.statusText || raw.status || (row.pending ? "待处理" : "可用"));
    return {
      id: String(row.id || raw.id || raw.bankAccountId || `bank-${index}`),
      account,
      countryText: String(row.countryText || bankCountryLabel(country)),
      bankCurrency: String(row.bankCurrency || raw.selectedCurrency || raw.bankCurrency || raw.currency || "—"),
      royaltyCurrency: String(row.royaltyCurrency || raw.royaltyCurrency || raw.paymentCurrency || raw.proceedsCurrency || "—"),
      statusText,
      statusClass: bankAccountStatusClass(statusText),
      raw,
    };
  });
}

function renderHomeBankSection() {
  if (!authenticated) return "";
  if (!homeOverviewCache.business.loaded || (homeOverviewCache.business.loading && homeBusinessStatus?.success !== true)) {
    return `<section class="home-bank-section"><div class="home-bank-title-row"><h2>银行账户</h2></div><div class="home-bank-empty home-bank-loading" role="status" aria-label="正在读取银行账户"><i class="loading-spinner" aria-hidden="true"></i></div></section>`;
  }
  if (homeBusinessStatus?.success !== true) return "";
  const rows = homeBankRows();
  if (!rows.length) {
    return `<section class="home-bank-section">
      <div class="home-bank-title-row"><h2>银行账户</h2></div>
      <div class="home-bank-empty"><button class="home-bank-empty-add" type="button" data-home-action="add-bank">添加银行账户</button></div>
    </section>`;
  }
  return `<section class="home-bank-section">
    <div class="home-bank-title-row"><h2>银行账户</h2><button class="home-bank-add" type="button" data-home-action="add-bank" aria-label="添加银行账户">+</button><button class="home-bank-more" type="button" data-home-action="open-business">查看更多</button></div>
    <div class="home-bank-table">
      <div class="home-bank-head"><span>账户</span><span>国家或地区</span><span>银行货币</span><span>版税货币</span><span>状态</span><span></span></div>
      ${rows.map(row => `<div class="home-bank-row">
        <button class="home-bank-account-link" type="button" data-home-action="open-business">${escapeHTML(row.account)}</button>
        <span>${escapeHTML(row.countryText)}</span>
        <span>${escapeHTML(row.bankCurrency)}</span>
        <span>${escapeHTML(row.royaltyCurrency)}</span>
        <span class="home-bank-status ${row.statusClass}">${escapeHTML(row.statusText)}</span>
        <button class="home-bank-menu" type="button" data-home-action="open-business" aria-label="更多">...</button>
      </div>`).join("")}
    </div>
  </section>`;
}

function saveHomeTaxState() {
  try {
    if (!homeTaxStateScopeKey) return;
    const state = {
      ...homeTaxState,
      usa1042: { ...(homeTaxState.usa1042 || {}) },
      w8ben: { ...(homeTaxState.w8ben || {}) },
    };
    localStorage.setItem(homeTaxStateScopeKey, JSON.stringify(homeTaxDetailOpen ? state : resetUnsubmittedHomeTaxDraft(state)));
  } catch {}
}

function homeTaxApiContext() {
  const legalEntity = homeBusinessStatus?.legalEntity || {};
  return {
    accountId: String(homeBusinessStatus?.provider?.id || "").trim(),
    legalEntityId: String(legalEntity.id || "").trim(),
    vendorId: String(legalEntity.vendorId || legalEntity.id || "").trim(),
    vendorScopeId: String(legalEntity.vendorScopeId || legalEntity.id || "").trim(),
  };
}

function activateHomeTaxStateScope() {
  const { accountId, legalEntityId } = homeTaxApiContext();
  const nextKey = accountId && legalEntityId ? `${HOME_TAX_STATE_KEY}.${accountId}.${legalEntityId}` : "";
  if (nextKey === homeTaxStateScopeKey) return;
  homeTaxStateScopeKey = nextKey;
  homeTaxState = readHomeTaxState(nextKey);
  currentTaxMetadataRequestSeq += 1;
  homeTaxW8Metadata = null;
  homeTaxW8MetadataLoading = false;
  homeTaxW8MetadataError = "";
  homeTax1042Metadata = null;
  homeTaxAddressRequestSeq += 1;
  homeTaxAddressState = { scopeKey: "", formType: "", addresses: [], metadata: null, loading: false, addressesError: "", metadataError: "" };
  document.querySelector(".home-tax-address-mask")?.remove();
  document.querySelector(".home-tax-address-popover")?.remove();
}

function homeTaxJurisdictions() {
  const selected = Array.isArray(homeTaxState.selectedJurisdictions) && homeTaxState.selectedJurisdictions.length
    ? homeTaxState.selectedJurisdictions
    : ["US"];
  return new Set(selected.map(value => String(value || "").toUpperCase()));
}

function homeTaxW8FormTypeForAccount() {
  const legalEntity = homeBusinessStatus?.legalEntity;
  if (!legalEntity) return "";
  return legalEntity.isOrganization === true ? "USA_W8BENE" : "USA_W8BEN";
}

function homeTaxW8IsSubmitted(form) {
  const code = String(form?.taxStatus || form?.status || "").trim().toUpperCase();
  return form?.isSubmitted === true || ["ACTIVE", "COMPLETE", "SUBMITTED"].includes(code);
}

function homeTaxRows() {
  if (!homeTaxState.added) return [];
  const jurisdictions = homeTaxJurisdictions();
  const usTaxFormTypes = new Set(Array.isArray(homeTaxState.usTaxFormTypes) ? homeTaxState.usTaxFormTypes.map(String) : []);
  const rows = [];
  const formByType = new Map((Array.isArray(homeBusinessStatus?.taxForms) ? homeBusinessStatus.taxForms : [])
    .map(form => [String(form.taxFormType || ""), form]));
  const rowState = (id, type, action, title, detail = false) => {
    const form = formByType.get(type);
    const localSubmitted = (id === "w8ben" || id === "w8bene") && homeTaxState.w8ben?.submitted === true;
    const local1042Submitted = id === "us-certificate" && homeTaxState.usa1042?.submitted === true;
    const serverLoaded = homeBusinessStatus?.success === true;
    const status = homeTaxStatusPresentation(form, !serverLoaded && (localSubmitted || local1042Submitted));
    return {
      id,
      title,
      action,
      detail,
      submitted: status.submitted,
      statusText: status.text,
      date: form?.lastModifiedAt || form?.lastUpdatedAt || form?.submittedAt || form?.createdAt || "",
    };
  };
  if (!homeTaxState.usSurveyComplete || !usTaxFormTypes.size) {
    if (jurisdictions.has("BR")) rows.push(rowState("brazil-tax", "BRA_FORM", "menu", "巴西报税表"));
    if (jurisdictions.has("US")) rows.push(rowState("us-tax-survey", "USA_FOREIGN_ENTITY_QUESTIONNAIRE", "survey", "美国税收调查表"));
    if (jurisdictions.has("MX")) rows.push(rowState("mexico-tax", "MEX_QUESTIONNAIRE", "menu", "墨西哥税收调查表"));
    return rows;
  }
  if (jurisdictions.has("BR")) rows.push(rowState("brazil-tax", "BRA_FORM", "menu", "巴西报税表"));
  if (jurisdictions.has("MX")) rows.push(rowState("mexico-tax", "MEX_QUESTIONNAIRE", "menu", "墨西哥税收调查表"));
  if (usTaxFormTypes.has("USA_1042S")) {
    rows.push(rowState("us-certificate", "USA_1042S", "menu", "U.S. Certificate of Foreign Status of Beneficial Owner", "certificate"));
  }
  if (usTaxFormTypes.has("USA_W8BEN") && homeTaxW8FormTypeForAccount() === "USA_W8BEN") {
    rows.push(rowState("w8ben", "USA_W8BEN", "menu", "U.S. Form W-8BEN", "w8ben"));
  }
  if (usTaxFormTypes.has("USA_W8BENE") && homeTaxW8FormTypeForAccount() === "USA_W8BENE") {
    rows.push(rowState("w8bene", "USA_W8BENE", "menu", "U.S. Substitute Form W-8BEN-E", "w8bene"));
  }
  return rows;
}

function homeTaxStatusPresentation(form, localSubmitted = false) {
  const code = String(form?.taxStatus || form?.status || "").trim().toUpperCase();
  const submitted = localSubmitted || form?.isSubmitted === true || ["ACTIVE", "COMPLETE", "SUBMITTED"].includes(code);
  const labels = {
    ACTIVE: "使用中",
    COMPLETE: "已提交",
    SUBMITTED: "已提交",
    PENDING: "处理中",
    PROCESSING: "处理中",
    INCOMPLETE: "缺少税务信息",
    MISSING: "缺少税务信息",
    EXPIRED: "已过期",
    REJECTED: "需要处理",
  };
  const apiText = String(form?.statusText || "").trim();
  const text = labels[code] || (apiText && apiText.toUpperCase() !== code ? apiText : "") || (submitted ? "已提交" : "缺少税务信息");
  return { submitted, text };
}

function syncHomeTaxStateFromBusiness() {
  activateHomeTaxStateScope();
  const countries = Array.isArray(homeBusinessStatus?.taxCountries) ? homeBusinessStatus.taxCountries : [];
  const forms = Array.isArray(homeBusinessStatus?.taxForms) ? homeBusinessStatus.taxForms : [];
  const selected = countries.filter(row => row.isSelected === true || row.isRequired === true).map(row => taxStateCodeForCountry(row.country));
  if (countries.length) {
    homeTaxState.added = true;
    homeTaxState.selectedJurisdictions = selected.length ? selected : ["US"];
  }
  if (forms.length) {
    const usTaxFormTypes = forms.flatMap(row => [
      row.taxFormType,
      ...(Array.isArray(row.taxFormTypes) ? row.taxFormTypes : []),
      ...(Array.isArray(row.raw?.taxFormTypes) ? row.raw.taxFormTypes : []),
      ...(Array.isArray(row.raw?.taxFormQuestionnaire?.taxFormTypes) ? row.raw.taxFormQuestionnaire.taxFormTypes : []),
    ]).map(value => String(value || "").trim()).filter(value => /^USA_(?:1042S|W8BEN|W8BENE|W8ECI|W9)$/.test(value));
    const hasUsQuestionnaireForm = forms.some(row => String(row.taxFormType || "") === "USA_FOREIGN_ENTITY_QUESTIONNAIRE");
    const childUsTaxFormTypes = hasUsQuestionnaireForm
      ? (Array.isArray(homeBusinessStatus?.taxRequirements) ? homeBusinessStatus.taxRequirements : []).flatMap(row => [
        ...(Array.isArray(row.childTaxFormTypes) ? row.childTaxFormTypes : []),
        ...(Array.isArray(row.raw?.childTaxFormTypes) ? row.raw.childTaxFormTypes : []),
      ]).map(value => String(value || "").trim()).filter(value => /^USA_(?:1042S|W8BEN|W8BENE|W8ECI|W9)$/.test(value))
      : [];
    homeTaxState.usTaxFormTypes = [...new Set([...usTaxFormTypes, ...childUsTaxFormTypes])];
    homeTaxState.usSurveyComplete = homeTaxState.usTaxFormTypes.length > 0;
  } else if (homeBusinessStatus?.taxFormsLoaded === true && (countries.length || Array.isArray(homeBusinessStatus?.taxRequirements))) {
    homeTaxState.usTaxFormTypes = [];
    homeTaxState.usSurveyComplete = false;
    homeTaxState.w8ben.submitted = false;
    homeTaxState.usa1042.submitted = false;
  }
  const w8FormType = homeTaxW8FormTypeForAccount();
  const w8Form = forms.find(row => String(row.taxFormType || "") === w8FormType);
  if (homeBusinessStatus?.taxFormsLoaded === true) homeTaxState.w8ben.submitted = homeTaxW8IsSubmitted(w8Form);
  if (countries.length || forms.length || Array.isArray(homeBusinessStatus?.taxRequirements)) saveHomeTaxState();
}

function realTaxCountries() {
  const rows = Array.isArray(homeBusinessStatus?.taxCountries) ? homeBusinessStatus.taxCountries : [];
  return rows.length ? rows : [
    { country: "USA", countryText: "美国", isRequired: true, isSelected: true, description: "所有与 Apple 有商业合作的作者必填。" },
    { country: "BRA", countryText: "巴西", isRequired: false, isSelected: true, description: "如果你常驻巴西，此项必填。" },
    { country: "MEX", countryText: "墨西哥", isRequired: false, isSelected: true, description: "如果你常驻墨西哥或已在墨西哥进行税务登记，此项必填。" },
  ];
}

function taxCountryCodeForState(code = "") {
  const map = { US: "USA", BR: "BRA", MX: "MEX" };
  return map[String(code || "").toUpperCase()] || String(code || "").toUpperCase();
}

function taxStateCodeForCountry(code = "") {
  const map = { USA: "US", BRA: "BR", MEX: "MX" };
  return map[String(code || "").toUpperCase()] || String(code || "").toUpperCase();
}

function selectedTaxCountryRows() {
  const selected = homeTaxJurisdictions();
  return realTaxCountries().map(row => ({ ...row, isSelected: row.isRequired || selected.has(taxStateCodeForCountry(row.country)) }));
}

function homeTaxCanAddOptionalCountry() {
  const selected = homeTaxJurisdictions();
  return realTaxCountries().some(row => !row.isRequired && !selected.has(taxStateCodeForCountry(row.country)));
}

async function saveSelectedTaxCountries(rows) {
  const context = homeTaxApiContext();
  context.vendorScopeId = String(rows.find(row => row.vendorScopeId)?.vendorScopeId || context.vendorScopeId).trim();
  if (!context.accountId || !context.vendorId || !context.vendorScopeId || typeof window.appleDeveloper.saveAppStoreTaxCountries !== "function") return { success: false, error: "暂时无法读取商务账户税务接口" };
  return window.appleDeveloper.saveAppStoreTaxCountries({
    ...context,
    optimisticLock: String(rows.find(row => row.optimisticLock)?.optimisticLock || ""),
    taxCountries: rows.map(row => ({
      country: row.country,
      ...(row.isRequired ? { isRequired: true, isSelected: true } : { isSelected: row.isSelected === true }),
      ...(row.descriptionKey ? { descriptionKey: row.descriptionKey } : {}),
    })),
  });
}

function taxFormRequirementRows() {
  const requirements = Array.isArray(homeBusinessStatus?.taxRequirements) ? homeBusinessStatus.taxRequirements : [];
  const forms = Array.isArray(homeBusinessStatus?.taxForms) ? homeBusinessStatus.taxForms : [];
  const rows = requirements.map((item, index) => {
    const country = String(item.taxCountry || "");
    const type = String(item.taxFormType || "");
    const form = forms.find(row => String(row.taxCountry || "") === country && String(row.taxFormType || "") === type);
    return { id: `tax-${country || type || index}`, title: type === "USA_FOREIGN_ENTITY_QUESTIONNAIRE" ? "美国税收调查表" : type === "USA_W8BEN" ? "U.S. Form W-8BEN" : type === "USA_W8BENE" ? "U.S. Substitute Form W-8BEN-E" : type || "税收调查表", country, type, form, status: form ? "已提交" : "缺少税务信息" };
  });
  if (rows.length) return rows;
  return [];
}

function renderHomeTaxSection() {
  if (!authenticated) return "";
  if (!homeOverviewCache.business.loaded || homeOverviewCache.business.loading) {
    return `<section class="home-tax-section"><div class="home-tax-title-row"><h2>报税表</h2></div><div class="home-tax-loading" role="status" aria-label="正在读取报税表"><i class="loading-spinner" aria-hidden="true"></i></div></section>`;
  }
  if (homeBusinessStatus?.success !== true) return "";
  const rows = homeTaxRows();
  const canAdd = !homeTaxState.added || homeTaxCanAddOptionalCountry();
  return `<section class="home-tax-section">
    <div class="home-tax-title-row"><h2>报税表</h2>${canAdd ? '<button class="home-tax-add" type="button" data-home-tax-action="open-add" title="添加报税表" aria-label="添加报税表">+</button>' : ""}</div>
    <div class="home-tax-table">
      <div class="home-tax-head"><span>报税表</span><span>昵称</span><span>提交日期</span><span>状态</span><span></span></div>
      ${rows.length ? rows.map(row => `<div class="home-tax-row">
        <button class="home-tax-name" type="button" ${row.detail ? `data-home-tax-action="open-detail" data-home-tax-detail="${escapeHTML(row.detail)}"` : ""}>${escapeHTML(row.title)}</button>
        <span>—</span><span>${escapeHTML(row.date ? formatCertificateDate(row.date) : "—")}</span>
        <span class="home-tax-status">${row.submitted ? '<span class="home-tax-success" aria-hidden="true">●</span>' : '<span class="home-tax-warning" aria-hidden="true">▲</span>'} ${escapeHTML(row.statusText)}</span>
        <div class="home-tax-operation">${row.action === "survey" ? '<button class="home-tax-action-link" type="button" data-home-tax-action="open-survey">添加税务信息</button>' : '<button class="home-tax-menu" type="button" data-home-tax-menu="' + escapeHTML(row.id) + '" aria-label="更多税务表操作">...</button>'}</div>
      </div>`).join("") : '<div class="home-tax-empty">点击“添加”选择需要填写的税务表。</div>'}
    </div>
  </section>`;
}

function bindHomeTaxEvents(root = document) {
  root.querySelectorAll('[data-home-tax-action="open-add"]').forEach(button => button.addEventListener("click", openHomeTaxAddDialog));
  root.querySelectorAll('[data-home-tax-action="open-survey"]').forEach(button => button.addEventListener("click", () => openHomeTaxSurvey()));
  root.querySelectorAll('[data-home-tax-action="open-detail"]').forEach(button => button.addEventListener("click", () => openHomeTaxDetail(button.dataset.homeTaxDetail || "w8ben")));
  root.querySelectorAll("[data-home-tax-menu]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    openHomeTaxMenu(button.dataset.homeTaxMenu, button);
  }));
}

async function refreshHomeBusinessAfterTaxSubmit() {
  if (appStoreBusinessStatusPromise) await appStoreBusinessStatusPromise;
  const result = await warmAppStoreBusinessStatus({ force: true });
  if (!result?.success) throw new Error(result?.error || "首页协议与报税表状态读取失败");
  homeBusinessStatus = result;
  homeOverviewCache.business.loaded = true;
  homeOverviewCache.business.failed = homeOverviewResultFailed(result);
  homeOverviewCache.business.loading = false;
  syncHomeTaxStateFromBusiness();
  renderHomePage();
}

async function returnHomeAfterTaxSubmit() {
  homeTaxDetailOpen = false;
  homeOverviewCache.business.loading = true;
  renderHomePage();
  try {
    await refreshHomeBusinessAfterTaxSubmit();
  } catch (error) {
    homeOverviewCache.business.loading = false;
    renderHomePage();
    console.warn("报税表提交成功，但首页状态刷新失败", error);
    alert("税务表已提交，但首页协议和报税表刷新失败，请点击“刷新状态”重试。");
  }
}

function ensureHomeTaxAddDialog() {
  let mask = document.querySelector(".home-tax-add-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "home-tax-add-mask";
  document.body.appendChild(mask);
  mask.addEventListener("click", event => { if (event.target === mask) closeHomeTaxAddDialog(); });
  return mask;
}

function closeHomeTaxAddDialog() {
  document.querySelector(".home-tax-add-mask")?.classList.remove("show");
}

function openHomeTaxAddDialog() {
  const mask = ensureHomeTaxAddDialog();
  const countries = selectedTaxCountryRows();
  mask.innerHTML = `<section class="home-tax-add-dialog" role="dialog" aria-modal="true" aria-labelledby="home-tax-add-title">
    <div class="home-tax-dialog-body">
      <h2 id="home-tax-add-title">添加报税表</h2>
      <p class="home-tax-dialog-question">你想添加哪些报税表？</p>
      <div class="home-tax-add-head"><span>报税表</span><span>详细信息</span></div>
      ${countries.map(row => `<label class="home-tax-add-row"><input type="checkbox" value="${escapeHTML(taxStateCodeForCountry(row.country))}" ${row.isSelected ? "checked" : ""}${row.isRequired ? " disabled" : ""}><span>${escapeHTML(row.countryText || row.country)}</span><small>${escapeHTML(row.description || (row.country === "USA" ? "所有与 Apple 有商业合作的作者必填。" : "如果你常驻该国家或地区，此项必填。"))}</small></label>`).join("")}
    </div>
    <div class="home-tax-dialog-foot"><button class="secondary" type="button" data-home-tax-add="cancel">取消</button><button class="primary" type="button" data-home-tax-add="confirm">添加</button></div>
  </section>`;
  mask.classList.add("show");
  mask.querySelector('[data-home-tax-add="cancel"]').addEventListener("click", closeHomeTaxAddDialog);
  mask.querySelector('[data-home-tax-add="confirm"]').addEventListener("click", async event => {
    const button = event.currentTarget;
    setBusy(button, true, "保存中…");
    const selectedCodes = new Set(["US", ...Array.from(mask.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value)]);
    const rows = countries.map(row => ({ ...row, isSelected: selectedCodes.has(taxStateCodeForCountry(row.country)) }));
    const result = await saveSelectedTaxCountries(rows);
    if (!result?.success) {
      setBusy(button, false);
      let error = mask.querySelector(".home-tax-error");
      if (!error) { error = document.createElement("div"); error.className = "home-tax-error"; mask.querySelector(".home-tax-dialog-body").appendChild(error); }
      error.textContent = result?.error || "税务国家/地区保存失败";
      return;
    }
    homeTaxState.added = true;
    homeTaxState.selectedJurisdictions = rows.filter(row => row.isSelected).map(row => taxStateCodeForCountry(row.country));
    homeTaxState.usSurveyComplete = false;
    homeTaxState.w8ben.submitted = false;
    saveHomeTaxState();
    closeHomeTaxAddDialog();
    renderHomePage();
  });
}

function ensureHomeTaxSurveyDialog() {
  let mask = document.querySelector(".home-tax-survey-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "home-tax-survey-mask";
  document.body.appendChild(mask);
  mask.addEventListener("click", event => { if (event.target === mask) closeHomeTaxSurvey(); });
  return mask;
}

function closeHomeTaxSurvey() {
  document.querySelector(".home-tax-survey-mask")?.classList.remove("show");
  currentTaxSurveyDraft = null;
}

async function loadHomeTaxSurveyMetadata() {
  const draft = currentTaxSurveyDraft;
  if (!draft) return;
  if (typeof window.appleDeveloper.appStoreTaxQuestionnaireMetadata !== "function") {
    draft.loading = false;
    renderHomeTaxSurveyDialog();
    return;
  }
  const context = homeTaxApiContext();
  if (!context.accountId || !context.vendorId || !context.vendorScopeId) {
    draft.loading = false;
    renderHomeTaxSurveyDialog();
    return;
  }
  const seq = ++currentTaxMetadataRequestSeq;
  const result = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({ ...context, taxCountry: "USA", taxFormType: "USA_FOREIGN_ENTITY_QUESTIONNAIRE" }).catch(() => null);
  if (seq !== currentTaxMetadataRequestSeq || currentTaxSurveyDraft !== draft) return;
  draft.loading = false;
  if (!result?.success) {
    renderHomeTaxSurveyDialog();
    return;
  }
  draft.metadata = result;
  draft.currentQuestionKey = result.initialQuestionKey || "question1";
  renderHomeTaxSurveyDialog();
}

async function saveHomeTaxQuestionnaire() {
  const draft = currentTaxSurveyDraft;
  if (!draft) return;
  const metadata = draft.metadata;
  const taxFormTypes = Array.isArray(draft.taxFormTypes) ? draft.taxFormTypes : [];
  const context = homeTaxApiContext();
  let result = { success: true };
  if (context.accountId && context.vendorId && context.vendorScopeId && typeof window.appleDeveloper.saveAppStoreTaxForm === "function" && metadata?.data) {
    const questionnaire = metadata.data.taxFormQuestionnaire || {};
    result = await window.appleDeveloper.saveAppStoreTaxForm({
      ...context,
      formData: {
        accountId: context.accountId,
        optimisticLock: String(metadata.optimisticLock || ""),
        taxFormType: "USA_FOREIGN_ENTITY_QUESTIONNAIRE",
        taxCountry: "USA",
        taxFormQuestionnaire: { ...questionnaire, taxFormTypes },
      },
    }).catch(error => ({ success: false, error: error.message }));
  }
  if (!result?.success) {
    currentTaxSurveyDraft.error = result?.error || "税务调查表保存失败";
    renderHomeTaxSurveyDialog();
    return;
  }
  homeTaxState.added = true;
  homeTaxState.usSurveyComplete = true;
  homeTaxState.usTaxFormTypes = taxFormTypes;
  homeTaxState.w8ben.submitted = false;
  saveHomeTaxState();
  closeHomeTaxSurvey();
  await loadHomeOverview({ force: true });
}

function homeTaxQuestionText(value = "") {
  const holder = document.createElement("div");
  holder.innerHTML = String(value || "");
  return holder.textContent || "";
}

function renderHomeTaxSurveyDialog() {
  const mask = ensureHomeTaxSurveyDialog();
  const draft = currentTaxSurveyDraft || { answers: {}, history: [] };
  const loading = draft.loading === true;
  const questions = draft.metadata?.questionnaire || {};
  const questionKey = draft.currentQuestionKey || draft.metadata?.initialQuestionKey || "question1";
  const question = questions[questionKey] || questions.question1 || null;
  const selected = draft.answers?.[questionKey];
  const selectedAnswer = question?.answers?.[Number(selected)];
  const terminalQuestion = Array.isArray(question?.answers) && question.answers.length > 0 && question.answers.every(answer => !answer?.subsequentQuestionKey);
  const hasPreviousQuestion = (draft.history?.length || 0) > 0;
  const canContinue = !hasPreviousQuestion && !!selectedAnswer?.subsequentQuestionKey;
  const actionLabel = hasPreviousQuestion || terminalQuestion || (selectedAnswer && !canContinue) ? "保存" : "下一步";
  const title = "美国税收调查表";
  const copy = question ? `<p>${escapeHTML(homeTaxQuestionText(question.title || questionKey))}</p>${question.description ? `<p>${escapeHTML(homeTaxQuestionText(question.description))}</p>` : ""}${(question.answers || []).map((answer, index) => `<label><input type="radio" name="home-tax-survey-answer" value="${index}" ${Number(selected) === index ? "checked" : ""}> ${escapeHTML(homeTaxQuestionText(answer.label || answer.answerKey || "—"))}</label>`).join("")}` : (loading ? '<div class="home-tax-survey-loading"><i class="loading-spinner" aria-label="正在读取调查表"></i></div>' : "");
  const controlsDisabled = loading || !question;
  mask.innerHTML = `<section class="home-tax-survey-dialog" role="dialog" aria-modal="true" aria-labelledby="home-tax-survey-title">
    <div class="home-tax-dialog-body"><h2 id="home-tax-survey-title">${title}</h2><div class="home-tax-survey-copy">${copy}</div></div>
    <div class="home-tax-dialog-foot">${draft.history?.length ? `<button class="secondary" type="button" data-home-tax-survey="back" ${controlsDisabled ? "disabled" : ""}>上一步</button>` : ""}<span></span><button class="secondary" type="button" data-home-tax-survey="cancel" ${controlsDisabled ? "disabled" : ""}>取消</button><button class="primary" type="button" data-home-tax-survey="next" ${controlsDisabled || selected === undefined ? "disabled" : ""}>${actionLabel}</button></div>
  </section>`;
  mask.classList.add("show");
  mask.querySelectorAll('input[type="radio"]').forEach(input => input.addEventListener("change", () => {
    currentTaxSurveyDraft.answers[questionKey] = Number(input.value);
    renderHomeTaxSurveyDialog();
  }));
  mask.querySelector('[data-home-tax-survey="cancel"]').addEventListener("click", closeHomeTaxSurvey);
  mask.querySelector('[data-home-tax-survey="next"]').addEventListener("click", () => {
    const answer = question?.answers?.[Number(currentTaxSurveyDraft.answers[questionKey])];
    if (!currentTaxSurveyDraft.history?.length && answer?.subsequentQuestionKey) {
      currentTaxSurveyDraft.history.push(questionKey);
      currentTaxSurveyDraft.currentQuestionKey = answer.subsequentQuestionKey;
      renderHomeTaxSurveyDialog();
      return;
    }
    currentTaxSurveyDraft.taxFormTypes = Array.isArray(answer?.taxFormTypes) ? answer.taxFormTypes : [];
    saveHomeTaxQuestionnaire();
  });
  mask.querySelector('[data-home-tax-survey="back"]')?.addEventListener("click", () => {
    currentTaxSurveyDraft.currentQuestionKey = currentTaxSurveyDraft.history.pop() || "question1";
    renderHomeTaxSurveyDialog();
  });
}

function openHomeTaxSurvey({ reset = false } = {}) {
  currentTaxSurveyDraft = { currentQuestionKey: "question1", answers: {}, history: [], taxFormTypes: [], reset, loading: true };
  renderHomeTaxSurveyDialog();
  loadHomeTaxSurveyMetadata();
}

function closeHomeTaxMenu() {
  document.querySelector(".home-tax-action-popover")?.remove();
}

function homeTaxQuestionnaireIds() {
  const forms = Array.isArray(homeBusinessStatus?.taxForms) ? homeBusinessStatus.taxForms : [];
  const requirements = Array.isArray(homeBusinessStatus?.taxRequirements) ? homeBusinessStatus.taxRequirements : [];
  return [...new Set([
    ...forms.filter(row => String(row.taxFormType || "") === "USA_FOREIGN_ENTITY_QUESTIONNAIRE").map(row => String(row.taxFormId || row.id || "")),
    ...requirements.flatMap(row => [String(row.questionnaireTaxFormWrapperId || ""), row.isQuestionnaire === true ? String(row.taxFormWrapperId || "") : ""]),
  ].filter(Boolean))];
}

async function resetHomeTaxQuestionnaire() {
  const context = homeTaxApiContext();
  const taxFormIds = homeTaxQuestionnaireIds();
  if (!taxFormIds.length) {
    await loadHomeOverview({ force: true });
    if (homeTaxState.usSurveyComplete) alert("没有从税务接口读取到可重设的问卷 ID，请刷新后重试");
    return;
  }
  if (taxFormIds.length && typeof window.appleDeveloper.deleteAppStoreTaxForm !== "function") {
    alert("当前版本缺少税务问卷重设接口");
    return;
  }
  for (const taxFormId of taxFormIds) {
    const result = await window.appleDeveloper.deleteAppStoreTaxForm({ ...context, taxFormId }).catch(error => ({ success: false, error: error.message }));
    if (!result?.success) {
      alert(result?.error || "税务问卷重设失败");
      await loadHomeOverview({ force: true });
      return;
    }
  }
  homeTaxState.usSurveyComplete = false;
  homeTaxState.usTaxFormTypes = [];
  homeTaxState.w8ben.submitted = false;
  homeTaxState.usa1042.submitted = false;
  homeTaxW8Metadata = null;
  homeTaxW8MetadataLoading = false;
  homeTaxW8MetadataError = "";
  homeTax1042Metadata = null;
  saveHomeTaxState();
  await loadHomeOverview({ force: true });
}

function openHomeTaxMenu(rowId, anchor) {
  closeHomeTaxMenu();
  const menu = document.createElement("div");
  menu.className = "home-tax-action-popover";
  const removable = rowId === "brazil-tax" || rowId === "mexico-tax";
  menu.innerHTML = `<button type="button" data-home-tax-menu-action="detail"><span aria-hidden="true">▧</span> 添加税务信息</button><button type="button" data-home-tax-menu-action="reset"><span aria-hidden="true">${removable ? "■" : "↻"}</span> ${removable ? "移除" : homeTaxState.usSurveyComplete ? "重设问卷" : "移除"}</button>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 200;
  menu.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width))}px`;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 12, rect.bottom + 8)}px`;
  menu.querySelector('[data-home-tax-menu-action="detail"]').addEventListener("click", () => {
    closeHomeTaxMenu();
    if (rowId === "w8ben") openHomeTaxDetail("w8ben");
    else if (rowId === "w8bene") openHomeTaxDetail("w8bene");
    else if (rowId === "us-certificate") openHomeTaxDetail("certificate");
    else if (rowId === "us-tax-survey") openHomeTaxSurvey();
    else alert("该税务表暂未开放填写入口。");
  });
  menu.querySelector('[data-home-tax-menu-action="reset"]').addEventListener("click", async () => {
    closeHomeTaxMenu();
    if (removable) {
      const removed = rowId === "brazil-tax" ? "BR" : "MX";
      const previous = [...homeTaxState.selectedJurisdictions];
      homeTaxState.selectedJurisdictions = previous.filter(value => value !== removed);
      saveHomeTaxState();
      renderHomePage();
      const rows = selectedTaxCountryRows().map(row => ({
        ...row,
        isSelected: homeTaxJurisdictions().has(taxStateCodeForCountry(row.country)),
      }));
      const result = await saveSelectedTaxCountries(rows);
      if (!result?.success) {
        homeTaxState.selectedJurisdictions = previous;
        saveHomeTaxState();
        renderHomePage();
        alert(result?.error || "税务国家/地区移除失败");
      }
      return;
    }
    if (homeTaxState.usSurveyComplete) await resetHomeTaxQuestionnaire();
  });
  setTimeout(() => document.addEventListener("mousedown", event => { if (!menu.contains(event.target) && event.target !== anchor) closeHomeTaxMenu(); }, { once: true }), 0);
}

function homeTaxAddressLines() {
  const address = homeBusinessStatus?.legalEntity?.legalEntityAddress || {};
  const line = [address.addressLine1 || address.street || address.line1, address.addressLine2 || address.line2, address.city, address.regionText || address.region, address.postalCode].filter(Boolean).join(", ");
  return line || "—";
}

function homeTaxAddressLinesFrom(address = {}) {
  const line = [address.addressLine1 || address.street || address.line1, address.addressLine2 || address.line2, address.city, address.regionText || address.region, address.postalCode].filter(Boolean).join(", ");
  const country = String(address.country || address.iso2CountryCode || "").toUpperCase();
  const countryText = country === "CHN" || country === "CN" ? "中国大陆" : country;
  return `${escapeHTML(line || homeTaxAddressLines())}<br>${escapeHTML(countryText || "中国大陆")}`;
}

function homeTaxMetadataFieldEditable(metadata, attributeName) {
  const constraints = metadata?.raw?.constraints && typeof metadata.raw.constraints === "object" ? metadata.raw.constraints : {};
  const constraint = Object.values(constraints).find(row => String(row?.attributeName || "") === String(attributeName || ""));
  return constraint?.isEditable === true;
}

function homeTaxMetadataConstraint(metadata, attributeName) {
  const constraints = metadata?.raw?.constraints && typeof metadata.raw.constraints === "object" ? metadata.raw.constraints : {};
  return Object.values(constraints).find(row => String(row?.attributeName || "") === String(attributeName || "")) || null;
}

function homeTaxW8CertificationComplete(w8, entity = false) {
  if (entity) return w8.entityCertificationPrimary === true && w8.entityCertificationCapacity === true;
  const treatyRequired = homeTaxMetadataConstraint(homeTaxW8Metadata, "taxFormUsaW8Ben.certify9a")?.required === true;
  return w8.certificationPrimary === true && (!treatyRequired || w8.line9 === true);
}

function homeTax1042BeneficialTypeValue(value = "") {
  const normalized = String(value || "").trim();
  return normalized === "Individual/Sole proprietor" ? "Individual" : normalized;
}

function homeTax1042BeneficialTypeLabel(value = "") {
  const labels = {
    Individual: "Individual/Sole proprietor",
    CentralBankOfIssue: "Central bank of issue",
    ComplexTrust: "Complex trust",
    Corporation: "Corporation",
    DisregardedEntity: "Disregarded entity",
    Estate: "Estate",
    Government: "Government",
    GrantorTrust: "Grantor trust",
    Partnership: "Partnership",
    PrivateFoundation: "Private foundation",
    SimpleTrust: "Simple trust",
    TaxExemptOrganization: "Tax-exempt organization",
  };
  return labels[String(value || "").trim()] || String(value || "").trim();
}

function homeTaxAddressFormType() {
  if (homeTaxDetailOpen === "certificate") return "USA_1042S";
  return homeTaxDetailOpen === "w8bene" ? "USA_W8BENE" : "USA_W8BEN";
}

function homeTaxAddressDraft() {
  return homeTaxDetailOpen === "certificate" ? homeTaxState.usa1042 : homeTaxState.w8ben;
}

function homeTaxAddressContextKey(context = homeTaxApiContext(), formType = homeTaxAddressFormType()) {
  return [context.accountId, context.legalEntityId, context.vendorId, context.vendorScopeId, formType].map(value => String(value || "")).join(":");
}

function homeTaxAddressLabel(address = {}) {
  return String(address.addressLine1 || address.street || address.line1 || "—");
}

function homeTaxAddressCountryLabel(address = {}) {
  const country = String(address.country || address.iso2CountryCode || "").toUpperCase();
  const countryRule = Object.values(homeTaxAddressState.metadata?.constraints || {}).find(row => row?.attributeName === "country") || {};
  const option = (Array.isArray(countryRule.options) ? countryRule.options : []).find(row => String(row?.value || "") === country);
  return option?.label || bankCountryLabel(country, country || "—");
}

function homeTaxAddressOptions(metadata = {}) {
  const rule = Object.values(metadata?.constraints || {}).find(row => row?.attributeName === "country") || {};
  return Array.isArray(rule.options) ? rule.options : [];
}

function homeTaxAddressRegionOptions(metadata = {}) {
  const rule = Object.values(metadata?.constraints || {}).find(row => row?.attributeName === "regionSelect") || {};
  return Array.isArray(rule.options) ? rule.options : [];
}

async function loadHomeTaxAddresses(mode = "create") {
  const formType = homeTaxAddressFormType();
  const context = homeTaxApiContext();
  const scopeKey = homeTaxAddressContextKey(context, formType);
  if (!context.accountId || !context.legalEntityId || !context.vendorId || !context.vendorScopeId) {
    homeTaxAddressState = { scopeKey, formType, addresses: [], metadata: null, loading: false, addressesError: "当前账户缺少税务地址参数", metadataError: "当前账户缺少税务地址参数" };
    return homeTaxAddressState;
  }
  const selecting = mode === "select";
  if (homeTaxAddressState.scopeKey === scopeKey && (selecting ? homeTaxAddressState.addressesLoaded === true && !homeTaxAddressState.addressesError : homeTaxAddressState.metadataLoaded === true && homeTaxAddressState.metadata && !homeTaxAddressState.metadataError)) return homeTaxAddressState;
  const seq = ++homeTaxAddressRequestSeq;
  homeTaxAddressState = { ...homeTaxAddressState, scopeKey, formType, loading: true, addressesError: "", metadataError: "" };
  const result = selecting
    ? await window.appleDeveloper.appStoreTaxAddresses({ ...context, taxFormType: formType }).catch(error => ({ success: false, error: error.message }))
    : await window.appleDeveloper.appStoreTaxAddressMetadata({ ...context, taxFormType: formType }).catch(error => ({ success: false, error: error.message }));
  if (seq !== homeTaxAddressRequestSeq || homeTaxAddressContextKey() !== scopeKey) return homeTaxAddressState;
  homeTaxAddressState = {
    ...homeTaxAddressState,
    scopeKey,
    formType,
    loading: false,
    ...(selecting ? {
      addressesLoaded: result?.success !== false,
      addresses: Array.isArray(result?.data) ? result.data : [],
      metadata: homeTaxAddressState.metadata || (result?.success ? result : null),
      addressesError: result?.success === false ? String(result.error || "现有地址读取失败") : "",
    } : {
      metadataLoaded: result?.success === true,
      metadata: result?.success ? result : null,
      metadataError: result?.success === false ? String(result.error || "地址规则读取失败") : "",
    }),
  };
  return homeTaxAddressState;
}

function homeTaxAddressModalClose() {
  document.querySelector(".home-tax-address-mask")?.remove();
}

function closeHomeTaxAddressMenu() {
  document.querySelector(".home-tax-address-popover")?.remove();
}

function openHomeTaxAddressMenu(event) {
  closeHomeTaxAddressMenu();
  const anchor = event?.currentTarget;
  if (!anchor) return;
  const menu = document.createElement("div");
  menu.className = "home-tax-address-popover";
  menu.innerHTML = `<button type="button" data-address-choice="create">添加新地址</button><button type="button" data-address-choice="select">选取现有地址</button>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 202;
  menu.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left - 12))}px`;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 12, rect.bottom + 7)}px`;
  menu.querySelectorAll("[data-address-choice]").forEach(button => button.addEventListener("click", async () => {
    const mode = button.dataset.addressChoice;
    closeHomeTaxAddressMenu();
    await openHomeTaxAddressDialog(mode);
  }));
  setTimeout(() => document.addEventListener("mousedown", outsideEvent => {
    if (!menu.contains(outsideEvent.target) && outsideEvent.target !== anchor) closeHomeTaxAddressMenu();
  }, { once: true }), 0);
}

function homeTaxAddressConstraint(metadata = {}, attributeName = "") {
  return Object.values(metadata?.constraints || {}).find(row => String(row?.attributeName || "") === attributeName) || {};
}

function homeTaxAddressFieldValue(address = {}, metadata = {}, key = "") {
  if (address[key] !== undefined && address[key] !== null) return String(address[key]);
  return String(metadata?.data?.[key] || "");
}

function homeTaxAddressFieldsHTML(address = {}, metadata = {}, prefix = "tax-address") {
  const countries = homeTaxAddressOptions(metadata);
  const country = homeTaxAddressFieldValue(address, metadata, "country") || "USA";
  const regions = homeTaxAddressRegionOptions(metadata);
  const field = (key, label, fallbackMax) => {
    const rule = homeTaxAddressConstraint(metadata, key);
    const max = Number(rule.sizeMax || fallbackMax || 0);
    return `<label><span>${label}</span><input data-address-field="${key}"${max > 0 ? ` maxlength="${max}"` : ""} value="${escapeHTML(homeTaxAddressFieldValue(address, metadata, key))}"${rule.isEditable === false ? " disabled" : ""}></label>`;
  };
  const countryOptions = countries.map(option => `<option value="${escapeHTML(option.value || "")}"${String(option.value) === country ? " selected" : ""}>${escapeHTML(option.label || bankCountryLabel(option.value, option.value) || "")}</option>`).join("");
  const regionOptions = regions.map(option => `<option value="${escapeHTML(option.value || "")}"${String(option.value) === String(address.regionSelect || "") ? " selected" : ""}>${escapeHTML(option.label || option.value || "")}</option>`).join("");
  const region = regions.length
    ? `<select id="${prefix}-region" data-address-field="regionSelect"><option value=""></option>${regionOptions}</select>`
    : `<input id="${prefix}-region" data-address-field="regionText" maxlength="${Number(homeTaxAddressConstraint(metadata, "regionText").sizeMax || 100)}" value="${escapeHTML(homeTaxAddressFieldValue(address, metadata, "regionText"))}">`;
  return `<div class="home-tax-address-grid">
    ${field("addressLine1", "地址行 1", 40)}
    ${field("addressLine2", "地址行 2", 40)}
    ${field("addressLine3", "地址行 3", 40)}
    ${field("city", "城市", 35)}
    <label><span>州或省</span>${region}</label>
    ${field("postalCode", "邮政编码", 10)}
    <label><span>国家或地区</span><select data-address-field="country">${countryOptions || `<option value="${escapeHTML(country)}" selected>${escapeHTML(bankCountryLabel(country, country))}</option>`}</select></label>
  </div>`;
}

function homeTaxAddressObjectFromForm(root) {
  const address = {};
  root.querySelectorAll("[data-address-field]").forEach(input => { address[input.dataset.addressField] = String(input.value || "").trim(); });
  return address;
}

function validateHomeTaxAddress(address = {}, metadata = {}) {
  const checked = new Set();
  for (const rule of Object.values(metadata?.constraints || {})) {
    const key = String(rule?.attributeName || "");
    if (!key || checked.has(key)) continue;
    checked.add(key);
    const value = String(address[key] || "").trim();
    if (rule.required === true && !value) return `请填写${rule.label || key}`;
    if (value && rule.regex) {
      try { if (!(new RegExp(rule.regex)).test(value)) return `${rule.label || key}格式不正确`; } catch {}
    }
  }
  return "";
}

function applyHomeTaxMailingAddress(address) {
  if (!address || typeof address !== "object") return;
  if (homeTaxDetailOpen === "certificate") syncHomeTax1042DraftFromPage();
  else syncHomeTaxW8DraftFromPage();
  homeTaxAddressDraft().mailingAddress = clonePlainObject(address);
  saveHomeTaxState();
  homeTaxAddressModalClose();
  renderHomePage();
}

async function saveHomeTaxMailingAddress(address, scopeKey) {
  const context = homeTaxApiContext();
  const formType = homeTaxAddressFormType();
  if (homeTaxAddressContextKey(context, formType) !== scopeKey) throw new Error("当前 Apple 账户已切换，请关闭后重新选择地址");
  if (homeTaxDetailOpen === "certificate") syncHomeTax1042DraftFromPage(); else syncHomeTaxW8DraftFromPage();
  const draft = homeTaxAddressDraft();
  const previousAddress = draft.mailingAddress ? clonePlainObject(draft.mailingAddress) : null;
  draft.mailingAddress = clonePlainObject(address);
  saveHomeTaxState();
  try {
    let metadata = homeTaxDetailOpen === "certificate" ? homeTax1042Metadata : homeTaxW8Metadata;
    if (!metadata) {
      if (homeTaxDetailOpen === "certificate") await loadHomeTax1042Metadata(); else await loadHomeTaxW8Metadata(formType);
      metadata = homeTaxDetailOpen === "certificate" ? homeTax1042Metadata : homeTaxW8Metadata;
    }
    if (!metadata) throw new Error("无法读取当前税务表，请稍后重试");
    if (homeTaxAddressContextKey() !== scopeKey) throw new Error("当前 Apple 账户已切换，请关闭后重新选择地址");
    const formData = homeTaxDetailOpen === "certificate"
      ? buildHomeTax1042Payload(context.accountId, metadata, draft)
      : buildHomeTaxW8Payload(context.accountId, metadata, draft);
    const result = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({ ...context, taxCountry: "USA", taxFormType: formType, formData }).catch(error => ({ success: false, error: error.message }));
    if (homeTaxAddressContextKey() !== scopeKey || (result?.context && homeTaxAddressContextKey(result.context, formType) !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次地址不会应用到新账户");
    if (!result?.success) throw new Error(result?.error || "邮寄地址保存失败");
    if (homeTaxDetailOpen === "certificate") homeTax1042Metadata = result; else homeTaxW8Metadata = result;
    const serverForm = homeTaxDetailOpen === "certificate" ? result.data?.taxFormUsa1042 : (formType === "USA_W8BENE" ? result.data?.taxFormUsaW8BenE : result.data?.taxFormUsaW8Ben);
    draft.mailingAddress = clonePlainObject(serverForm?.mailingAddress || address);
    saveHomeTaxState();
    homeTaxAddressModalClose();
    renderHomePage();
    return true;
  } catch (error) {
    if (previousAddress) draft.mailingAddress = previousAddress; else delete draft.mailingAddress;
    saveHomeTaxState();
    throw error;
  }
}

async function openHomeTaxAddressDialog(mode = "create") {
  const taxDraft = homeTaxAddressDraft();
  const metadata = homeTaxDetailOpen === "certificate" ? homeTax1042Metadata : homeTaxW8Metadata;
  if (taxDraft?.submitted === true || String(metadata?.data?.taxStatus || "").toUpperCase() === "ACTIVE") return;
  const selecting = mode === "select";
  if (document.querySelector(".home-tax-address-mask")) return;
  const mask = document.createElement("div");
  mask.className = "home-tax-address-mask";
  mask.innerHTML = `<div class="home-tax-address-dialog${selecting ? " selecting" : ""}" role="dialog" aria-modal="true" aria-labelledby="home-tax-address-title"><div class="home-tax-address-body"><h2 id="home-tax-address-title">${selecting ? "选取现有地址" : "添加新地址"}</h2><p class="home-tax-address-loading">正在读取地址信息…</p></div><div class="home-tax-address-actions"><button type="button" class="secondary" data-address-action="cancel">取消</button><button type="button" class="primary" disabled>${selecting ? "保存" : "添加"}</button></div></div>`;
  document.body.appendChild(mask);
  mask.querySelector('[data-address-action="cancel"]').addEventListener("click", homeTaxAddressModalClose);
  mask.addEventListener("click", event => { if (event.target === mask) homeTaxAddressModalClose(); });
  await loadHomeTaxAddresses(mode);
  if (!mask.isConnected) return;
  const state = homeTaxAddressState;
  if (homeTaxAddressContextKey() !== state.scopeKey) { homeTaxAddressModalClose(); return; }
  const initialAddress = state.metadata?.data && typeof state.metadata.data === "object" ? state.metadata.data : {};
  mask.innerHTML = `<div class="home-tax-address-dialog${selecting ? " selecting" : ""}" role="dialog" aria-modal="true" aria-labelledby="home-tax-address-title"><div class="home-tax-address-body"><h2 id="home-tax-address-title">${selecting ? "选取现有地址" : "添加新地址"}</h2>${selecting ? `<div class="home-tax-address-list"><div class="home-tax-address-list-head"><span></span><span>地址</span><span>城市，州/省/区域</span><span>国家或地区</span></div>${state.addresses.length ? state.addresses.map((address, index) => `<label class="home-tax-address-row"><input type="radio" name="home-tax-existing-address" value="${index}"><span>${escapeHTML(homeTaxAddressLabel(address))}</span><small>${escapeHTML([address.city, address.regionText || address.regionSelect].filter(Boolean).join(", "))}</small><em>${escapeHTML(homeTaxAddressCountryLabel(address))}</em></label>`).join("") : `<p class="home-tax-address-empty">暂无可用地址</p>`}</div>` : `<div class="home-tax-address-view" data-address-view="create">${homeTaxAddressFieldsHTML(initialAddress, state.metadata || {})}</div>`}<div class="home-tax-address-error" aria-live="polite">${escapeHTML(selecting ? state.addressesError : state.metadataError)}</div></div><div class="home-tax-address-actions"><button type="button" class="secondary" data-address-action="cancel">取消</button><button type="button" class="primary" data-address-action="save">${selecting ? "保存" : "添加"}</button></div></div>`;
  const createView = mask.querySelector('[data-address-view="create"]');
  const saveButton = mask.querySelector('[data-address-action="save"]');
  const error = mask.querySelector(".home-tax-address-error");
  const validate = () => {
    if (selecting) {
      saveButton.disabled = !mask.querySelector('input[name="home-tax-existing-address"]:checked');
      return;
    }
    const message = validateHomeTaxAddress(homeTaxAddressObjectFromForm(createView), state.metadata || {});
    saveButton.disabled = !!message || !!state.metadataError;
    error.textContent = message || state.metadataError || "";
  };
  const bindCreateView = () => {
    if (!createView) return;
    createView.querySelectorAll("input,select").forEach(input => input.addEventListener("input", validate));
    createView.querySelectorAll("select").forEach(input => input.addEventListener("change", async event => {
      if (event.target.dataset.addressField !== "country") { validate(); return; }
      const address = homeTaxAddressObjectFromForm(createView);
      saveButton.disabled = true;
      const metadataResult = await window.appleDeveloper.appStoreTaxAddressMetadata({ ...homeTaxApiContext(), taxFormType: state.formType, address }).catch(() => null);
      if (homeTaxAddressContextKey() !== state.scopeKey) {
        error.textContent = "当前 Apple 账户已切换，请关闭后重新选择地址";
        return;
      }
      if (metadataResult?.success && homeTaxAddressContextKey(metadataResult.context, state.formType) === state.scopeKey) {
        state.metadata = metadataResult;
        const current = homeTaxAddressObjectFromForm(createView);
        createView.innerHTML = homeTaxAddressFieldsHTML(current, state.metadata || {});
        bindCreateView();
      } else error.textContent = metadataResult?.error || "地址规则读取失败";
      validate();
    }));
  };
  bindCreateView();
  mask.querySelectorAll('input[name="home-tax-existing-address"]').forEach(input => input.addEventListener("change", validate));
  mask.querySelector('[data-address-action="cancel"]').addEventListener("click", homeTaxAddressModalClose);
  saveButton.addEventListener("click", async () => {
    if (selecting) {
      if (homeTaxAddressContextKey() !== state.scopeKey) { error.textContent = "当前 Apple 账户已切换，请关闭后重新选择地址"; return; }
      const selected = mask.querySelector('input[name="home-tax-existing-address"]:checked');
      if (!selected) return;
      saveButton.disabled = true; saveButton.textContent = "保存中…";
      try { await saveHomeTaxMailingAddress(state.addresses[Number(selected.value)], state.scopeKey); }
      catch (saveError) { error.textContent = saveError.message || "邮寄地址保存失败"; saveButton.disabled = false; saveButton.textContent = "保存"; }
      return;
    }
    const address = homeTaxAddressObjectFromForm(createView);
    validate();
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    saveButton.textContent = "保存中…";
    const context = homeTaxApiContext();
    const result = await window.appleDeveloper.createAppStoreTaxAddress({ ...context, taxFormType: state.formType, address }).catch(errorValue => ({ success: false, error: errorValue.message }));
    if (homeTaxAddressContextKey() !== state.scopeKey) { error.textContent = "当前 Apple 账户已切换，本次地址不会应用到新账户"; saveButton.textContent = "添加"; return; }
    if (!result?.success) { error.textContent = result?.error || "地址保存失败"; saveButton.disabled = false; saveButton.textContent = "添加"; return; }
    state.addressesLoaded = false;
    try { await saveHomeTaxMailingAddress(result.data || address, state.scopeKey); }
    catch (saveError) { error.textContent = saveError.message || "邮寄地址保存失败"; saveButton.disabled = false; saveButton.textContent = "添加"; }
  });
  mask.addEventListener("click", event => { if (event.target === mask) homeTaxAddressModalClose(); });
  mask.addEventListener("keydown", event => { if (event.key === "Escape") homeTaxAddressModalClose(); });
  validate();
}

function renderHomeTaxCertificatePage(page) {
  const cert = homeTaxState.usa1042 || defaultHomeTaxState().usa1042;
  const metaForm = homeTax1042Metadata?.data?.taxFormUsa1042 || {};
  const locked = cert.submitted;
  const disabled = locked ? " disabled" : "";
  const readonlyDisabled = " disabled";
  const beneficialConstraint = homeTaxMetadataConstraint(homeTax1042Metadata, "taxFormUsa1042.beneficialType");
  const beneficialType = homeTax1042BeneficialTypeValue(cert.beneficialType || metaForm.beneficialType || "");
  const beneficialTypeOptions = Array.isArray(beneficialConstraint?.options) ? beneficialConstraint.options : [];
  const beneficialTypeHTML = beneficialTypeOptions.length
    ? beneficialTypeOptions.map(option => {
      const value = String(option?.value || "");
      return `<option value="${escapeHTML(value)}"${beneficialType === value ? " selected" : ""}>${escapeHTML(homeTax1042BeneficialTypeLabel(value))}</option>`;
    }).join("")
    : '<option value="">正在读取可选状态…</option>';
  const beneficialTypeDisabled = locked || beneficialConstraint?.isEditable !== true || !beneficialTypeOptions.length ? " disabled" : "";
  const canSave = !!String(cert.title || "").trim() && !!beneficialType && cert.declaration === true && !locked;
  const permanentAddress = homeTaxAddressLinesFrom(metaForm.permanentResidenceAddress || {});
  const mailingAddress = homeTaxAddressLinesFrom(cert.mailingAddress || metaForm.mailingAddress || {});
  page.innerHTML = `<div class="home-tax-detail-page home-tax-certificate-page">
    <button class="home-tax-back" type="button" data-home-tax-action="back-detail">‹ <span>返回到首页</span></button>
    <div class="home-tax-detail-head"><div><h1>U.S. Certificate of Foreign Status of Beneficial Owner</h1></div><button class="primary home-tax-submit" type="button" data-home-tax-action="submit-1042"${canSave ? "" : " disabled"}>保存</button></div>
    <div class="home-tax-meta-grid">${renderHomeTaxNickNameMeta("certificate")}<div><strong>关联协议类型</strong><span>付费 App</span></div></div>
    <section class="home-tax-form-section home-tax-certificate-section">
      <div class="home-tax-form-grid home-tax-certificate-grid">
        <label><span>1. Individual or Organization Name</span><input data-home-tax-1042-field="name" value="${escapeHTML(cert.name)}"${readonlyDisabled}></label>
        <label><span>2. Country or Region of Incorporation</span><select data-home-tax-1042-field="country"${readonlyDisabled}><option ${cert.country === "中国大陆" ? "selected" : ""}>中国大陆</option><option ${cert.country === "美国" ? "selected" : ""}>美国</option><option ${cert.country === "香港" ? "selected" : ""}>香港</option></select></label>
        <label><span>3. Type of Beneficial Owner</span><select data-home-tax-1042-field="beneficialType"${beneficialTypeDisabled}>${beneficialTypeHTML}</select><small class="home-tax-field-status" data-home-tax-1042-status aria-live="polite"></small></label>
      </div>
      <div class="home-tax-certificate-address"><strong>4. Permanent Residence</strong><p>${permanentAddress}</p></div>
      <div class="home-tax-certificate-address"><strong>5. Mailing Address <button type="button" data-home-tax-address-edit>编辑</button></strong><p>${mailingAddress}</p></div>
      <label class="home-tax-check-line home-tax-certificate-declare"><input type="checkbox" data-home-tax-1042-check="declaration"${cert.declaration ? " checked" : ""}${disabled}><span>I declare that the individual or organization named above is the beneficial owner of any payments made under the agreement. I declare that the beneficial owner does not have any employees in the United States and does not own, lease, or control any equipment or other assets in the United States that are used to derive revenue from Apple. I declare that I am either the beneficial owner or that I am authorized to make this declaration on behalf of the beneficial owner.</span></label>
      <div class="home-tax-certificate-signer">
        <p><strong>Beneficial Owner (or individual authorized to sign for the beneficial owner)</strong></p>
        <p>${escapeHTML(metaForm.authorizedPersonName || cert.name || "—")} <button type="button">不是你?</button></p>
        <label><span>Title</span><input data-home-tax-1042-field="title" value="${escapeHTML(cert.title)}"${disabled}></label>
        <button type="button" class="home-tax-link-button">谁有权签署此证明?</button>
      </div>
    </section>
  </div>`;
}

function homeTaxNickNameValue(formType = "w8ben") {
  const source = formType === "certificate" ? homeTaxState.usa1042 : homeTaxState.w8ben;
  return String(source?.nickName || "").trim();
}

function renderHomeTaxNickNameMeta(formType = "w8ben") {
  const nickname = homeTaxNickNameValue(formType);
  const action = formType === "certificate" ? "edit-1042-nickname" : "edit-w8-nickname";
  return `<div><strong>税务表格昵称</strong><div class="home-tax-meta-value">${nickname ? `<span>${escapeHTML(nickname)}</span>` : ""}<button type="button" class="home-tax-inline-add" data-home-tax-action="${action}">添加</button></div></div>`;
}

function renderHomeTaxDetailPage(page) {
  const w8 = homeTaxState.w8ben || defaultHomeTaxState().w8ben;
  const metadataFormType = String(homeTaxW8Metadata?.taxFormType || homeTaxW8Metadata?.data?.taxFormType || "");
  const isEntity = metadataFormType === "USA_W8BENE" || homeTaxDetailOpen === "w8bene";
  const metaForm = isEntity ? (homeTaxW8Metadata?.data?.taxFormUsaW8BenE || {}) : (homeTaxW8Metadata?.data?.taxFormUsaW8Ben || {});
  const formTitle = isEntity ? "U.S. Substitute Form W-8BEN-E" : "U.S. Form W-8BEN";
  const formDescription = isEntity ? "Certificate of Status of Beneficial Owner for United States Tax Withholding and Reporting (Entities) (Rev. October 2021)" : "Certificate of Foreign Status of Beneficial Owner for United States Tax Withholding and Reporting (Individuals) (Rev. October 2021)";
  const permanentAddress = homeTaxAddressLinesFrom(metaForm.permanentResidenceAddress || {});
  const mailingAddress = homeTaxAddressLinesFrom(homeTaxState.w8ben.mailingAddress || metaForm.mailingAddress || {});
  const locked = w8.submitted === true || String(homeTaxW8Metadata?.data?.taxStatus || "").toUpperCase() === "ACTIVE";
  const metadataPending = !homeTaxW8Metadata;
  const metadataStatus = metadataPending
    ? homeTaxW8MetadataError
      ? `<div class="home-tax-metadata-state error" role="alert"><span>无法读取 Apple 税务表：${escapeHTML(homeTaxW8MetadataError)}</span><button type="button" data-home-tax-action="retry-w8-metadata">重试读取</button></div>`
      : `<div class="home-tax-metadata-state" role="status">${homeTaxW8MetadataLoading ? "正在读取 Apple 税务表及可编辑字段，完成后会自动开放…" : "尚未读取 Apple 税务表。"}</div>`
    : `<div class="home-tax-metadata-state ready" role="status">${locked ? "此税务表已提交，当前不能修改。" : "表单已就绪：白色字段可填写，灰色字段由 Apple 设为只读。"}</div>`;
  const attrPrefix = isEntity ? "taxFormUsaW8BenE" : "taxFormUsaW8Ben";
  const entityNameAttribute = "taxFormUsaW8BenE.name";
  const entityCountryAttribute = "taxFormUsaW8BenE.country";
  const fieldDisabled = attribute => locked || metadataPending || (homeTaxW8Metadata && !homeTaxMetadataFieldEditable(homeTaxW8Metadata, `${attrPrefix}.${attribute}`)) ? " disabled" : "";
  const nameDisabled = fieldDisabled("name");
  const countryDisabled = fieldDisabled("country");
  const checked = value => value ? " checked" : "";
  const entityTypeOptions = [["CentralBankOfIssue", "Central bank of issue"], ["ComplexTrust", "Complex trust"], ["Corporation", "Corporation"], ["DisregardedEntity", "Disregarded entity"], ["Estate", "Estate"], ["ForeignGovernmentControlledEntity", "Foreign Government-Controlled Entity"], ["ForeignGovernmentIntegralPart", "Foreign Government-Integral Part"], ["GrantorTrust", "Grantor trust"], ["InternationalOrganization", "International organization"], ["Partnership", "Partnership"], ["PrivateFoundation", "Private foundation"], ["SimpleTrust", "Simple trust"], ["TaxExemptOrganization", "Tax-exempt organization"]];
  const entityType = String(w8.entityType || metaForm.beneficialType || "");
  const entitySelectOptions = entityTypeOptions.map(([value, label]) => `<option value="${value}"${entityType === value ? " selected" : ""}>${label}</option>`).join("");
  const limitationConstraint = homeTaxW8Metadata?.raw?.constraints && Object.values(homeTaxW8Metadata.raw.constraints).find(row => row?.attributeName === "taxFormUsaW8BenE.certify14bLimitationType");
  const limitationLabels = { GOVERNMENT: "Government", TAX_EXEMPT_PENSION: "Tax-exempt pension trust", TAX_EXEMPT_ORGANIZATION: "Tax-exempt organization", PUBLICLY_TRADED_ORGANIZATION: "Publicly traded organization", SUBSIDIARY_PUBLICLY_TRADED_ORGANIZATION: "Subsidiary of a publicly traded organization", COMPANY_OWNERSHIP_BASE_EROSION_TEST: "Company that meets the ownership and base erosion test", COMPANY_DERIVATIVE_BENEFITS_TEST: "Company that meets the derivative benefits test", COMPANY_INCOME_ACTIVE_TRADE_TEST: "Company that meets the active trade or business test", FAVORABLE_BY_US: "Discretionary determination by the United States", NO_LOB_ARTICLE: "No LOB article in treaty", OTHER: "Other" };
  const entityLimitationOptions = (limitationConstraint?.options || []).map(option => { const value = String(option?.value || ""); return `<option value="${escapeHTML(value)}"${w8.entityLimitationType === value ? " selected" : ""}>${escapeHTML(limitationLabels[value] || value)}</option>`; }).join("");
  const entityField = (key, attr, placeholder = "Optional") => `<input data-home-tax-field="${key}" value="${escapeHTML(w8[key] || "")}" placeholder="${placeholder}"${fieldDisabled(attr)}>`;
  const entityPage = `<div class="home-tax-detail-page home-tax-w8bene-page"><button class="home-tax-back" type="button" data-home-tax-action="back-detail">‹ <span>返回到首页</span></button><div class="home-tax-detail-notice"><span class="home-tax-info-icon">i</span><span>点按“提交”后，你将无法对此表进行更改</span></div>${metadataStatus}<div class="home-tax-detail-head"><div><h1>${formTitle}</h1><p>${formDescription}</p><p>We recommend that you review the Substitute Form W-8BEN-E Tips sheet and Form W-8BEN-E Instructions before completing the Substitute Form W-8BEN-E.</p><p>If you have previously submitted a Substitute Form W-8BEN-E, the Substitute Form W-8BEN-E you will now complete will replace and supersede the Substitute Form W-8BEN-E you previously submitted.</p><p>If you are a partnership and wish to claim treaty benefits related to your income from the Apple Developer Program, please see the FAQs about submitting updated tax information.</p><div class="home-tax-downloads"><span>下载:</span><button type="button" data-home-tax-download="w8-instructions">Form W-8BEN-E Instructions</button><i></i><button type="button" data-home-tax-download="w8-tips">Substitute Form W-8BEN-E Tips Sheet</button></div></div><button class="primary home-tax-submit" type="button" data-home-tax-action="submit-w8"${locked || !homeTaxW8CertificationComplete(w8, true) || !homeTaxW8Metadata ? " disabled" : ""}>提交</button></div><div class="home-tax-meta-grid">${renderHomeTaxNickNameMeta("w8ben")}<div><strong>关联协议类型</strong><span>付费 App</span></div></div><section class="home-tax-form-section"><h2>Part I: Identification of Beneficial Owner</h2><div class="home-tax-form-grid two-col"><label><span>1. Name of organization that is the beneficial owner</span><input data-home-tax-field="name" value="${escapeHTML(w8.name || metaForm.name || "")}"${nameDisabled}><small>As shown on your income statement.</small></label><label><span>2. Country or region of incorporation or organization</span><select data-home-tax-field="country"${countryDisabled}><option value="CHN"${w8.country === "中国大陆" || w8.country === "CHN" ? " selected" : ""}>中国大陆</option></select></label><label><span>3. Chapter 3 Status (entity type)</span><select data-home-tax-field="entityType"${fieldDisabled("beneficialType")}><option value=""></option>${entitySelectOptions}</select></label><div class="home-tax-address"><span>6. Permanent Residence Address</span><p>${permanentAddress}</p></div><div class="home-tax-address"><span>7. Mailing Address <button type="button" data-home-tax-address-edit${fieldDisabled("mailingAddress")}>编辑</button></span><p>${mailingAddress}</p></div><label><span>8. U.S. taxpayer identification number (TIN), if required</span>${entityField("tin", "taxpayerNumber")}<div class="home-tax-radio-row"><label><input type="radio" name="home-tax-tin-type" value="EIN" ${w8.tinType === "EIN" ? "checked" : ""}${fieldDisabled("taxpayerNumberType")}> EIN</label><label><input type="radio" name="home-tax-tin-type" value="SSN" ${w8.tinType === "SSN" ? "checked" : ""}${fieldDisabled("taxpayerNumberType")}> SSN</label></div><small>Don't have a U.S. Tax ID?<br><button type="button" data-home-tax-download="ss4">Download Form SS-4</button></small></label><label><span>9b. Foreign TIN</span>${entityField("foreignTaxId", "foreignTaxId")}</label><label><span>10. Reference Number(s)</span>${entityField("referenceNumber", "referenceNumber")}</label></div></section><section class="home-tax-form-section"><h2>Part III: Claim of Tax Treaty Benefits (If Applicable). (For chapter 3 purposes only)</h2><strong class="home-tax-entity-certify-heading">14. I certify that (check all that apply)</strong><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="entityCertify14a"${checked(w8.entityCertify14a)}${fieldDisabled("certify14a")}><span>The beneficial owner is a resident of ${escapeHTML(w8.country || "中国大陆")} within the meaning of the income tax treaty between United States and that country or region.</span></label><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="entityCertify14b"${checked(w8.entityCertify14b)}${fieldDisabled("certify14b")}><span>The beneficial owner derives the item (or items) of income for which the treaty benefits are claimed, and, if applicable, meets the requirements of the treaty provision dealing with limitation on benefits. The following are types of limitation on benefits provisions that may be included in an applicable tax treaty (check only one; see instructions):</span></label><label class="home-tax-wide-field"><span>Type of limitation on benefits provisions</span><select data-home-tax-field="entityLimitationType"${fieldDisabled("certify14bLimitationType")}><option value=""></option>${entityLimitationOptions}</select></label><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="entityCertify14c"${checked(w8.entityCertify14c)}${fieldDisabled("certify14c")}><span>The beneficial owner is claiming treaty benefits for dividends received from a foreign corporation or interest from a U.S. trade or business of a foreign corporation and meets qualified resident status (see instructions).</span></label><div class="home-tax-treaty-copy"><strong>15. Special rate and Conditions</strong><p>The beneficial owner is claiming the provisions of Article and paragraph ${entityField("entityArticle", "articleReference")} of the treaty identified on line 14a above to claim a ${entityField("entityWithholdingRate", "taxRate")} % rate of withholding on (specify type of income):</p><label><input type="checkbox" data-home-tax-check="entityIncomeSale"${checked(w8.entityIncomeSale)}${fieldDisabled("hasStandardIncomeType")}> Income from the sale of applications</label><label><input type="checkbox" data-home-tax-check="entityOtherIncome"${checked(w8.entityOtherIncome)}${fieldDisabled("hasOtherIncomeType")}> Other (please specify) ${entityField("entityOtherIncomeType", "incomeTypeOther")}</label><label class="home-tax-wide-field"><span>Explain the additional conditions in the Article the beneficial owner meets to be eligible for the rate of withholding</span>${entityField("entityTreatyExplanation", "articleJustification")}</label></div></section><section class="home-tax-form-section home-tax-certification"><h2>Part XXX: Certification</h2><strong>Certification</strong><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="entityCertificationPrimary"${checked(w8.entityCertificationPrimary)}${fieldDisabled("certify14a")}><span>Under penalties of perjury, I declare that I have examined the information on this form and to the best of my knowledge and belief it is true, correct, and complete. I further certify under penalties of perjury that:</span></label><div class="home-tax-certification-scroll">1. The entity identified on line 1 of this form is the beneficial owner of all the income or proceeds to which this form relates, is using this form to certify its status for chapter 4 purposes, or is submitting this form for purposes of section 6050W or 6050Y,<br><br>2. The entity identified on line 1 of this form is not a U.S. person,<br><br>3. This form relates to: (a) income not effectively connected with the conduct of a trade or business in the United States, (b) income effectively connected with the conduct of a trade or business in the United States but is not subject to tax under an income tax treaty, (c) the partner's share of a partnership's effectively connected taxable income, or (d) the partner's amount realized from the transfer of a partnership interest subject to withholding under section 1446(f).</div><p>Furthermore, I authorize this form to be provided to any withholding agent that has control, receipt, or custody of the income of which the entity on line 1 is the beneficial owner or any withholding agent that can disburse or make payments of the income of which the entity on line 1 is the beneficial owner.</p><p><strong>I agree that I will submit a new form within 30 days if any certification on this form becomes incorrect.</strong></p><p>The Internal Revenue Service does not require your consent to any provisions of this document other than the certifications required to establish your status as a non-U.S. person, establish your chapter 4 status (if required), and, if applicable, obtain a reduced rate of withholding.</p><p><strong>Beneficial Owner (or individual authorized to sign for the beneficial owner)</strong></p><p class="home-tax-signer">${escapeHTML(metaForm.authorizedPersonName || "—")} <button type="button">不是你?</button></p><button type="button" class="home-tax-link-button">谁有权签署此证明?</button><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="entityCertificationCapacity"${checked(w8.entityCertificationCapacity)}${fieldDisabled("certify14b")}><span>I certify that I have the capacity to sign for the entity identified on line 1 of this form.</span></label></section></div>`;
  if (isEntity) { page.innerHTML = entityPage; return; }
  page.innerHTML = `<div class="home-tax-detail-page">
    <button class="home-tax-back" type="button" data-home-tax-action="back-detail">‹ <span>返回到首页</span></button>
    <div class="home-tax-detail-notice"><span class="home-tax-info-icon">i</span><span>点按“提交”后，你将无法对此表进行更改</span></div>
    ${metadataStatus}
    <div class="home-tax-detail-head"><div><h1>${formTitle}</h1><p>${formDescription}</p><div class="home-tax-downloads"><button type="button" data-home-tax-download="w8-instructions">Download Form Instructions</button><i></i><button type="button" data-home-tax-download="w8-tips">Download Tips Sheet</button></div></div><button class="primary home-tax-submit" type="button" data-home-tax-action="submit-w8"${locked || !homeTaxW8CertificationComplete(w8) || !homeTaxW8Metadata ? " disabled" : ""}>提交</button></div>
    <div class="home-tax-meta-grid">${renderHomeTaxNickNameMeta("w8ben")}<div><strong>关联协议类型</strong><span>付费 App</span></div></div>
    <section class="home-tax-form-section"><h2>Part I: Identification of Beneficial Owner</h2><div class="home-tax-form-grid two-col">
      <label><span>1. ${isEntity ? "Name of organization that is the beneficial owner" : "Name of individual that is the beneficial owner"}</span><input data-home-tax-field="name" value="${escapeHTML(w8.name)}"${nameDisabled}><small>As shown on your income statement.</small></label>
      <label><span>2. ${isEntity ? "Country or region of incorporation or organization" : "Country or Region of Citizenship"}</span><select data-home-tax-field="country"${countryDisabled}><option ${w8.country === "中国大陆" ? "selected" : ""}>中国大陆</option><option ${w8.country === "美国" ? "selected" : ""}>美国</option><option ${w8.country === "香港" ? "selected" : ""}>香港</option></select></label>
      <div class="home-tax-address"><span>3. Permanent Residence Address</span><p>${permanentAddress}</p></div><div class="home-tax-address"><span>4. Mailing Address <button type="button" data-home-tax-address-edit${fieldDisabled("mailingAddress")}>编辑</button></span><p>${mailingAddress}</p></div>
      <label><span>5. U.S. taxpayer identification number, if required</span><input data-home-tax-field="tin" value="${escapeHTML(w8.tin)}" placeholder="Optional"${fieldDisabled("taxpayerNumber")}><div class="home-tax-radio-row"><label><input type="radio" name="home-tax-tin-type" value="EIN" ${w8.tinType === "EIN" ? "checked" : ""}${fieldDisabled("taxpayerNumberType")}> EIN</label><label><input type="radio" name="home-tax-tin-type" value="SSN" ${w8.tinType === "SSN" ? "checked" : ""}${fieldDisabled("taxpayerNumberType")}> SSN</label></div><small>Don't have a U.S. Tax ID?<br><button type="button" data-home-tax-download="ss4">Download Form SS-4</button></small></label>
      <label><span>6.a. Foreign Tax Identifying Number (if any)</span><input data-home-tax-field="foreignTaxId" value="${escapeHTML(w8.foreignTaxId)}" placeholder="Optional"${fieldDisabled("foreignTaxId")}></label><label><span>7. Reference Number(s)</span><input data-home-tax-field="referenceNumber" value="${escapeHTML(w8.referenceNumber)}" placeholder="Optional"${fieldDisabled("referenceNumber")}></label>
      <label><span>8. Date of Birth</span><input data-home-tax-field="dateOfBirth" value="${escapeHTML(w8.dateOfBirth)}" placeholder="MM-DD-YYYY"${fieldDisabled("dateOfBirth")}></label>
    </div></section>
    <section class="home-tax-form-section"><h2>Part II: Claim of Tax Treaty Benefits</h2><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="line9"${checked(w8.line9)}${fieldDisabled("certify9a")}><span>9. I certify that the beneficial owner is a resident of ${escapeHTML(w8.country || "中国大陆")} within the meaning of the income tax treaty between United States and that country or region.</span></label><div class="home-tax-treaty-copy"><strong>10. Special rates and conditions</strong><p>The beneficial owner is claiming the provisions of Article and paragraph <input data-home-tax-field="article" value="${escapeHTML(w8.article)}" placeholder="Optional"${fieldDisabled("articleReference")}> of the treaty identified on line 9 above to claim a <input data-home-tax-field="withholdingRate" value="${escapeHTML(w8.withholdingRate)}" placeholder="Optional"${fieldDisabled("taxRate")}> % rate of withholding on (specify type of income):</p><label><input type="radio" name="home-tax-income" value="sale" ${w8.incomeSale ? "checked" : ""}${fieldDisabled("useIncomeTypeOther")}> Income from the sale of applications</label><label><input type="radio" name="home-tax-income" value="other" ${w8.otherIncome ? "checked" : ""}${fieldDisabled("useIncomeTypeOther")}> Other (please specify)</label><label class="home-tax-wide-field"><span>Explain the additional conditions in the Article the beneficial owner meets to be eligible for the rate of withholding</span><input data-home-tax-field="treatyExplanation" value="${escapeHTML(w8.treatyExplanation)}" placeholder="Optional"${fieldDisabled("articleJustification")}></label></div></section>
    <section class="home-tax-form-section home-tax-certification"><h2>Part III: Certification</h2><strong>Certification</strong><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="certificationPrimary"${checked(w8.certificationPrimary)}${locked || metadataPending ? " disabled" : ""}><span>Under penalties of perjury, I declare that I have examined the information on this form and to the best of my knowledge and belief it is true, correct, and complete.</span></label><p>Beneficial Owner (or individual authorized to sign for the beneficial owner)</p><p class="home-tax-signer">${escapeHTML(metaForm.authorizedPersonName || w8.name || "—")} <button type="button">不是你?</button></p><button type="button" class="home-tax-link-button">谁有权签署此证明?</button><label class="home-tax-check-line"><input type="checkbox" data-home-tax-check="certificationCapacity"${checked(w8.certificationCapacity)}${locked || metadataPending ? " disabled" : ""}><span>I certify that I have the capacity to sign for the person identified on line 1 of this form.</span></label></section>
  </div>`;
}

function closeHomeTaxNicknameDialog() {
  document.querySelector(".home-tax-nickname-mask")?.remove();
}

function syncHomeTax1042DraftFromPage() {
  const page = el("page-home");
  if (!page || homeTaxDetailOpen !== "certificate" || !homeTaxState.usa1042) return;
  const title = page.querySelector('[data-home-tax-1042-field="title"]');
  const beneficialType = page.querySelector('[data-home-tax-1042-field="beneficialType"]');
  const declaration = page.querySelector('[data-home-tax-1042-check="declaration"]');
  if (title) homeTaxState.usa1042.title = title.value;
  if (beneficialType) homeTaxState.usa1042.beneficialType = homeTax1042BeneficialTypeValue(beneficialType.value);
  if (declaration) homeTaxState.usa1042.declaration = declaration.checked;
}

function syncHomeTaxW8DraftFromPage() {
  const page = el("page-home");
  if (!page || !["w8ben", "w8bene"].includes(homeTaxDetailOpen) || !homeTaxState.w8ben) return;
  page.querySelectorAll("[data-home-tax-field]").forEach(input => { homeTaxState.w8ben[input.dataset.homeTaxField] = input.value; });
  page.querySelectorAll("[data-home-tax-check]").forEach(input => { homeTaxState.w8ben[input.dataset.homeTaxCheck] = input.checked; });
  const tinType = page.querySelector('input[name="home-tax-tin-type"]:checked');
  if (tinType) homeTaxState.w8ben.tinType = tinType.value;
  const income = page.querySelector('input[name="home-tax-income"]:checked');
  homeTaxState.w8ben.incomeSale = income?.value === "sale";
  homeTaxState.w8ben.otherIncome = income?.value === "other";
}

function openHomeTaxNicknameDialog(formType = "w8ben") {
  if (formType === "certificate") syncHomeTax1042DraftFromPage();
  else syncHomeTaxW8DraftFromPage();
  const target = formType === "certificate" ? homeTaxState.usa1042 : homeTaxState.w8ben;
  const current = homeTaxNickNameValue(formType);
  closeHomeTaxNicknameDialog();
  const mask = document.createElement("div");
  mask.className = "home-tax-nickname-mask";
  mask.innerHTML = `<form class="home-tax-nickname-dialog" role="dialog" aria-modal="true" aria-labelledby="home-tax-nickname-title">
    <div class="home-tax-nickname-body">
      <h2 id="home-tax-nickname-title">编辑昵称</h2>
      <div class="home-tax-nickname-field">
        <strong>关联的协议类型</strong>
        <span>付费 App</span>
      </div>
      <p>添加一个税务表格名称，帮助你在税务表格列表中识别此表格。</p>
      <label class="home-tax-nickname-input"><span>税务表格名称</span><input id="home-tax-nickname-input" maxlength="50" value="${escapeHTML(current)}" autocomplete="off"></label>
      <div class="home-tax-nickname-error" aria-live="polite"></div>
    </div>
    <div class="home-tax-nickname-actions"><button class="secondary" type="button" data-home-tax-nickname="cancel">Cancel</button><button class="primary" type="submit" disabled>保存</button></div>
  </form>`;
  document.body.appendChild(mask);
  const form = mask.querySelector("form");
  const input = mask.querySelector("#home-tax-nickname-input");
  const save = mask.querySelector('[type="submit"]');
  const error = mask.querySelector(".home-tax-nickname-error");
  const update = () => {
    const value = String(input.value || "").trim();
    const tooShort = value.length > 0 && value.length < 3;
    const tooLong = value.length > 50;
    save.disabled = tooShort || tooLong || !value;
    error.textContent = tooShort ? "税务表格名称至少需要 3 个字符。" : tooLong ? "税务表格名称不能超过 50 个字符。" : "";
  };
  mask.addEventListener("click", event => { if (event.target === mask) closeHomeTaxNicknameDialog(); });
  mask.querySelector('[data-home-tax-nickname="cancel"]')?.addEventListener("click", closeHomeTaxNicknameDialog);
  input.addEventListener("input", update);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (formType === "certificate") syncHomeTax1042DraftFromPage();
    else syncHomeTaxW8DraftFromPage();
    const value = String(input.value || "").trim();
    if (value.length < 3 || value.length > 50) {
      update();
      return;
    }
    target.nickName = value;
    saveHomeTaxState();
    closeHomeTaxNicknameDialog();
    renderHomePage();
  });
  update();
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function assignHomeTaxOptionalString(target, key, value) {
  const text = String(value || "").trim();
  if (text) target[key] = text;
  else delete target[key];
}

function buildHomeTaxW8Payload(accountId, metadata, w8) {
  const formType = String(metadata?.taxFormType || metadata?.data?.taxFormType || "USA_W8BEN");
  const isEntity = formType === "USA_W8BENE";
  const form = isEntity ? (metadata?.data?.taxFormUsaW8BenE || {}) : (metadata?.data?.taxFormUsaW8Ben || {});
  const taxFormUsaW8Ben = { ...form };
  taxFormUsaW8Ben.name = String(w8.name || form.name || "");
  taxFormUsaW8Ben.country = "CHN";
  taxFormUsaW8Ben.authorizedPersonName = String(form.authorizedPersonName || w8.name || "");
  if (w8.mailingAddress && typeof w8.mailingAddress === "object") taxFormUsaW8Ben.mailingAddress = clonePlainObject(w8.mailingAddress);
  assignHomeTaxOptionalString(taxFormUsaW8Ben, "taxpayerNumber", w8.tin);
  if (String(w8.tin || "").trim()) assignHomeTaxOptionalString(taxFormUsaW8Ben, "taxpayerNumberType", w8.tinType);
  else delete taxFormUsaW8Ben.taxpayerNumberType;
  assignHomeTaxOptionalString(taxFormUsaW8Ben, "foreignTaxId", w8.foreignTaxId);
  assignHomeTaxOptionalString(taxFormUsaW8Ben, "referenceNumber", w8.referenceNumber);
  if (isEntity) {
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "beneficialType", w8.entityType);
    taxFormUsaW8Ben.certify14a = w8.entityCertify14a === true;
    taxFormUsaW8Ben.certify14b = w8.entityCertify14b === true;
    taxFormUsaW8Ben.certify14c = w8.entityCertify14c === true;
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "certify14bLimitationType", w8.entityLimitationType);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "articleReference", w8.entityArticle);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "taxRate", w8.entityWithholdingRate);
    taxFormUsaW8Ben.incomeType = w8.entityIncomeSale ? ["APP_SALES"] : (Array.isArray(form.incomeType) ? form.incomeType : []);
    taxFormUsaW8Ben.hasStandardIncomeType = w8.entityIncomeSale === true;
    taxFormUsaW8Ben.hasOtherIncomeType = w8.entityOtherIncome === true;
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "incomeTypeOther", w8.entityOtherIncomeType);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "articleJustification", w8.entityTreatyExplanation);
  } else {
    taxFormUsaW8Ben.certify9a = w8.line9 === true;
    taxFormUsaW8Ben.incomeType = w8.incomeSale ? ["APP_SALES"] : Array.isArray(form.incomeType) ? form.incomeType : [];
    if (w8.otherIncome) taxFormUsaW8Ben.useIncomeTypeOther = true;
    else if (taxFormUsaW8Ben.useIncomeTypeOther !== true) delete taxFormUsaW8Ben.useIncomeTypeOther;
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "dateOfBirth", w8.dateOfBirth);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "articleReference", w8.article);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "taxRate", w8.withholdingRate);
    assignHomeTaxOptionalString(taxFormUsaW8Ben, "articleJustification", w8.treatyExplanation);
  }
  const payload = {
    [isEntity ? "taxFormUsaW8BenE" : "taxFormUsaW8Ben"]: taxFormUsaW8Ben,
    accountId,
    optimisticLock: String(metadata?.optimisticLock || metadata?.data?.optimisticLock || ""),
    taxFormType: formType,
    taxCountry: "USA",
  };
  const nickname = String(w8.nickName || "").trim();
  if (nickname) payload.nickName = nickname;
  return payload;
}

function buildHomeTax1042Payload(accountId, metadata, cert) {
  const form = metadata?.data?.taxFormUsa1042 || {};
  const taxFormUsa1042 = { ...form };
  taxFormUsa1042.name = String(form.name || cert.name || "");
  taxFormUsa1042.country = String(form.country || cert.country || "").trim();
  const beneficialConstraint = homeTaxMetadataConstraint(metadata, "taxFormUsa1042.beneficialType");
  const beneficialType = homeTax1042BeneficialTypeValue(cert.beneficialType || form.beneficialType || beneficialConstraint?.options?.[0]?.value || "");
  if (beneficialType) taxFormUsa1042.beneficialType = beneficialType;
  else delete taxFormUsa1042.beneficialType;
  taxFormUsa1042.authorizedPersonName = String(form.authorizedPersonName || cert.name || "");
  taxFormUsa1042.authorizedPersonTitle = String(cert.title || "").trim();
  if (cert.mailingAddress && typeof cert.mailingAddress === "object") taxFormUsa1042.mailingAddress = clonePlainObject(cert.mailingAddress);
  const payload = {
    taxFormUsa1042,
    accountId,
    optimisticLock: String(metadata?.optimisticLock || metadata?.data?.optimisticLock || ""),
    taxFormType: "USA_1042S",
    taxCountry: "USA",
  };
  const nickname = String(cert.nickName || "").trim();
  if (nickname) payload.nickName = nickname;
  return payload;
}

function updateHomeTaxSubmitState() {
  const button = document.querySelector('[data-home-tax-action="submit-w8"]');
  const entity = homeTaxDetailOpen === "w8bene" || String(homeTaxW8Metadata?.taxFormType || homeTaxW8Metadata?.data?.taxFormType || "") === "USA_W8BENE";
  const w8 = homeTaxState.w8ben;
  const complete = homeTaxW8CertificationComplete(w8, entity);
  const selectedType = entity ? "USA_W8BENE" : "USA_W8BEN";
  if (button) button.disabled = selectedType !== homeTaxW8FormTypeForAccount() || w8.submitted || !complete || !homeTaxW8Metadata;
}

function updateHomeTax1042SubmitState() {
  syncHomeTax1042DraftFromPage();
  const button = document.querySelector('[data-home-tax-action="submit-1042"]');
  const cert = homeTaxState.usa1042 || defaultHomeTaxState().usa1042;
  const beneficialType = homeTax1042BeneficialTypeValue(cert.beneficialType || homeTax1042Metadata?.data?.taxFormUsa1042?.beneficialType || "");
  if (button) button.disabled = cert.submitted || !String(cert.title || "").trim() || !beneficialType || cert.declaration !== true;
}

function openHomeTaxDetail(type = "w8ben") {
  if (type !== "certificate" && (type === "w8bene" ? "USA_W8BENE" : "USA_W8BEN") !== homeTaxW8FormTypeForAccount()) {
    alert("此税务表不适用于当前账户类型，请刷新后重试");
    return;
  }
  homeTaxDetailOpen = type === "certificate" ? "certificate" : (type === "w8bene" ? "w8bene" : "w8ben");
  homeTaxW8Metadata = null;
  homeTaxW8MetadataLoading = homeTaxDetailOpen !== "certificate";
  homeTaxW8MetadataError = "";
  resetUnsubmittedHomeTaxDraft(homeTaxState, homeTaxDetailOpen === "certificate" ? "certificate" : "w8ben");
  saveHomeTaxState();
  closeHomeTaxMenu();
  renderHomePage();
  if (homeTaxDetailOpen === "certificate") loadHomeTax1042Metadata();
  else loadHomeTaxW8Metadata(homeTaxDetailOpen === "w8bene" ? "USA_W8BENE" : "USA_W8BEN");
}

async function loadHomeTax1042Metadata() {
  const context = homeTaxApiContext();
  if (!context.accountId || !context.vendorId || !context.vendorScopeId || typeof window.appleDeveloper.appStoreTaxQuestionnaireMetadata !== "function") return null;
  const seq = ++currentTaxMetadataRequestSeq;
  const result = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({ ...context, taxCountry: "USA", taxFormType: "USA_1042S" }).catch(() => null);
  if (seq !== currentTaxMetadataRequestSeq || !result?.success) return result;
  homeTax1042Metadata = result;
  const form = result.data?.taxFormUsa1042 || {};
  const cert = homeTaxState.usa1042;
  cert.name = String(form.name || "");
  if (form.mailingAddress && typeof form.mailingAddress === "object") cert.mailingAddress = clonePlainObject(form.mailingAddress);
  cert.country = String(form.country || "CHN") === "CHN" ? "中国大陆" : String(form.country || cert.country || "中国大陆");
  if (form.beneficialType) cert.beneficialType = homeTax1042BeneficialTypeValue(form.beneficialType);
  saveHomeTaxState();
  if (homeTaxDetailOpen === "certificate") renderHomePage();
  return result;
}

async function loadHomeTaxW8Metadata(taxFormType = "USA_W8BEN") {
  const context = homeTaxApiContext();
  if (taxFormType !== homeTaxW8FormTypeForAccount()) return null;
  if (!context.accountId || !context.vendorId || !context.vendorScopeId || typeof window.appleDeveloper.appStoreTaxQuestionnaireMetadata !== "function") {
    homeTaxW8MetadataLoading = false;
    homeTaxW8MetadataError = "当前账户缺少税务表关联信息，请刷新首页后重试";
    if (homeTaxDetailOpen) renderHomePage();
    return null;
  }
  const seq = ++currentTaxMetadataRequestSeq;
  homeTaxW8MetadataLoading = true;
  homeTaxW8MetadataError = "";
  if (homeTaxDetailOpen) renderHomePage();
  const result = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({ ...context, taxCountry: "USA", taxFormType }).catch(error => ({ success: false, error: error.message }));
  if (seq !== currentTaxMetadataRequestSeq || homeTaxAddressContextKey(context, taxFormType) !== homeTaxAddressContextKey(homeTaxApiContext(), taxFormType) || taxFormType !== homeTaxW8FormTypeForAccount()) return result;
  homeTaxW8MetadataLoading = false;
  if (!result?.success) {
    homeTaxW8MetadataError = String(result?.error || "请求失败，请稍后重试");
    if (homeTaxDetailOpen) renderHomePage();
    return result;
  }
  homeTaxW8Metadata = result;
  const form = taxFormType === "USA_W8BENE" ? (result.data?.taxFormUsaW8BenE || {}) : (result.data?.taxFormUsaW8Ben || {});
  const w8 = homeTaxState.w8ben;
  const serverSubmitted = homeTaxW8IsSubmitted(result.data);
  w8.submitted = serverSubmitted;
  if (w8.submitted === true) w8.nickName = String(result.data?.nickName || w8.nickName || "");
  else w8.nickName = "";
  w8.name = String(form.name || "");
  if (form.mailingAddress && typeof form.mailingAddress === "object") w8.mailingAddress = clonePlainObject(form.mailingAddress);
  w8.country = String(form.country || "CHN") === "CHN" ? "中国大陆" : String(form.country || w8.country || "中国大陆");
  if (taxFormType === "USA_W8BENE") {
    w8.entityType = String(form.beneficialType || w8.entityType || "");
    w8.entityCertify14a = form.certify14a === true;
    w8.entityCertify14b = form.certify14b === true;
    w8.entityCertify14c = form.certify14c === true;
    w8.entityLimitationType = String(form.certify14bLimitationType || w8.entityLimitationType || "");
    w8.entityArticle = String(form.articleReference || w8.entityArticle || "");
    w8.entityWithholdingRate = String(form.taxRate || w8.entityWithholdingRate || "");
    w8.entityIncomeSale = form.hasStandardIncomeType === true || (Array.isArray(form.incomeType) && form.incomeType.includes("APP_SALES"));
    w8.entityOtherIncome = form.hasOtherIncomeType === true;
    w8.entityOtherIncomeType = String(form.incomeTypeOther || w8.entityOtherIncomeType || "");
    w8.entityTreatyExplanation = String(form.articleJustification || w8.entityTreatyExplanation || "");
  } else if (w8.submitted === true) {
    w8.tin = String(form.taxpayerNumber || w8.tin || "");
    w8.tinType = String(form.taxpayerNumberType || w8.tinType || "");
    w8.foreignTaxId = String(form.foreignTaxId || w8.foreignTaxId || "");
    w8.referenceNumber = String(form.referenceNumber || w8.referenceNumber || "");
    w8.dateOfBirth = String(form.dateOfBirth || w8.dateOfBirth || "");
    w8.article = String(form.articleReference || w8.article || "");
    w8.withholdingRate = String(form.taxRate || w8.withholdingRate || "");
    w8.treatyExplanation = String(form.articleJustification || w8.treatyExplanation || "");
    w8.incomeSale = Array.isArray(form.incomeType) && form.incomeType.includes("APP_SALES");
    w8.otherIncome = form.useIncomeTypeOther === true;
    w8.line9 = form.certify9a === true || w8.line9 === true;
  } else {
    resetUnsubmittedHomeTaxDraft(homeTaxState, "w8ben");
    w8.incomeSale = Array.isArray(form.incomeType) && form.incomeType.includes("APP_SALES");
    w8.otherIncome = form.useIncomeTypeOther === true;
  }
  saveHomeTaxState();
  if (homeTaxDetailOpen) renderHomePage();
  return result;
}

function bindHomeTaxDetailEvents() {
  const page = el("page-home");
  if (!page) return;
  page.querySelector('[data-home-tax-action="back-detail"]')?.addEventListener("click", () => {
    currentTaxMetadataRequestSeq += 1;
    homeTaxW8MetadataLoading = false;
    resetUnsubmittedHomeTaxDraft(homeTaxState, homeTaxDetailOpen === "certificate" ? "certificate" : "w8ben");
    saveHomeTaxState();
    homeTaxDetailOpen = false;
    renderHomePage();
  });
  if (homeTaxDetailOpen === "certificate") {
    page.querySelector('[data-home-tax-action="edit-1042-nickname"]')?.addEventListener("click", () => openHomeTaxNicknameDialog("certificate"));
    page.querySelector("[data-home-tax-address-edit]")?.addEventListener("click", openHomeTaxAddressMenu);
    page.querySelectorAll("[data-home-tax-1042-field]").forEach(input => input.addEventListener("input", () => {
      homeTaxState.usa1042[input.dataset.homeTax1042Field] = input.value;
      saveHomeTaxState();
      updateHomeTax1042SubmitState();
    }));
    page.querySelectorAll("[data-home-tax-1042-field]").forEach(input => input.addEventListener("change", () => {
      homeTaxState.usa1042[input.dataset.homeTax1042Field] = input.value;
      saveHomeTaxState();
      updateHomeTax1042SubmitState();
    }));
    page.querySelector('[data-home-tax-1042-field="beneficialType"]')?.addEventListener("change", async event => {
      const select = event.currentTarget;
      const status = page.querySelector("[data-home-tax-1042-status]");
      const cert = homeTaxState.usa1042;
      const previous = cert.beneficialType;
      const context = homeTaxApiContext();
      const scopeKey = homeTaxAddressContextKey(context, "USA_1042S");
      cert.beneficialType = homeTax1042BeneficialTypeValue(select.value);
      saveHomeTaxState();
      if (!context.accountId || !context.vendorId || !context.vendorScopeId || !homeTax1042Metadata || typeof window.appleDeveloper.appStoreTaxQuestionnaireMetadata !== "function") return;
      select.disabled = true;
      select.setAttribute("aria-busy", "true");
      if (status) status.textContent = "正在保存…";
      try {
        const result = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({
          ...context,
          taxCountry: "USA",
          taxFormType: "USA_1042S",
          formData: buildHomeTax1042Payload(context.accountId, homeTax1042Metadata, cert),
        }).catch(error => ({ success: false, error: error.message }));
        if (homeTaxAddressContextKey() !== scopeKey || (result?.context && homeTaxAddressContextKey(result.context, "USA_1042S") !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次选择已取消");
        if (!result?.success) throw new Error(result?.error || "受益所有人类型保存失败");
        homeTax1042Metadata = result;
        const returnedType = result.data?.taxFormUsa1042?.beneficialType;
        if (returnedType) cert.beneficialType = homeTax1042BeneficialTypeValue(returnedType);
        saveHomeTaxState();
        renderHomePage();
      } catch (error) {
        cert.beneficialType = previous;
        select.value = homeTax1042BeneficialTypeValue(previous);
        if (status) status.textContent = error.message || "受益所有人类型保存失败";
        select.disabled = false;
        select.removeAttribute("aria-busy");
        saveHomeTaxState();
        updateHomeTax1042SubmitState();
      }
    });
    page.querySelectorAll("[data-home-tax-1042-check]").forEach(input => input.addEventListener("change", () => {
      homeTaxState.usa1042[input.dataset.homeTax1042Check] = input.checked;
      saveHomeTaxState();
      updateHomeTax1042SubmitState();
    }));
    page.querySelector('[data-home-tax-action="submit-1042"]')?.addEventListener("click", async event => {
      syncHomeTax1042DraftFromPage();
      const cert = homeTaxState.usa1042;
      if (cert.submitted || !String(cert.title || "").trim() || !homeTax1042BeneficialTypeValue(cert.beneficialType) || cert.declaration !== true) return;
      const button = event.currentTarget;
      setBusy(button, true, "保存中…");
      const context = homeTaxApiContext();
      if (context.accountId && context.vendorId && context.vendorScopeId && !homeTax1042Metadata) {
        await loadHomeTax1042Metadata();
        if (!homeTax1042Metadata) {
          setBusy(button, false);
          alert("无法读取 U.S. Certificate 税务信息，请稍后重试");
          return;
        }
      }
      const scopeKey = homeTaxAddressContextKey(context, "USA_1042S");
      try {
        if (context.accountId && context.vendorId && context.vendorScopeId && typeof window.appleDeveloper.saveAppStoreTaxForm === "function") {
          const validation = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({
            ...context,
            taxCountry: "USA",
            taxFormType: "USA_1042S",
            formData: buildHomeTax1042Payload(context.accountId, homeTax1042Metadata, cert),
          }).catch(error => ({ success: false, error: error.message }));
          if (homeTaxAddressContextKey() !== scopeKey || (validation?.context && homeTaxAddressContextKey(validation.context, "USA_1042S") !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次保存已取消");
          if (!validation?.success) throw new Error(validation?.error || "U.S. Certificate 校验失败");
          homeTax1042Metadata = validation;
          const result = await window.appleDeveloper.saveAppStoreTaxForm({
            ...context,
            taxFormType: "USA_1042S",
            formData: buildHomeTax1042Payload(context.accountId, homeTax1042Metadata, cert),
          }).catch(error => ({ success: false, error: error.message }));
          if (homeTaxAddressContextKey() !== scopeKey || (result?.context && homeTaxAddressContextKey(result.context, "USA_1042S") !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次保存结果不会应用到新账户");
          if (!result?.success) throw new Error(result?.error || "U.S. Certificate 保存失败");
        }
        homeTaxState.usa1042.submitted = true;
        saveHomeTaxState();
        await returnHomeAfterTaxSubmit();
      } catch (error) {
        setBusy(button, false);
        alert(error.message || "U.S. Certificate 保存失败");
      }
    });
    return;
  }
  page.querySelector('[data-home-tax-action="retry-w8-metadata"]')?.addEventListener("click", () => {
    loadHomeTaxW8Metadata(homeTaxDetailOpen === "w8bene" ? "USA_W8BENE" : "USA_W8BEN");
  });
  page.querySelector('[data-home-tax-action="edit-w8-nickname"]')?.addEventListener("click", () => openHomeTaxNicknameDialog("w8ben"));
  page.querySelector("[data-home-tax-address-edit]")?.addEventListener("click", openHomeTaxAddressMenu);
  page.querySelectorAll("[data-home-tax-field]").forEach(input => input.addEventListener("input", () => {
    homeTaxState.w8ben[input.dataset.homeTaxField] = input.value;
    saveHomeTaxState();
  }));
  page.querySelectorAll("[data-home-tax-field]").forEach(input => input.addEventListener("change", () => {
    homeTaxState.w8ben[input.dataset.homeTaxField] = input.value;
    saveHomeTaxState();
  }));
  page.querySelectorAll("[data-home-tax-check]").forEach(input => input.addEventListener("change", () => {
    homeTaxState.w8ben[input.dataset.homeTaxCheck] = input.checked;
    saveHomeTaxState();
    updateHomeTaxSubmitState();
  }));
  page.querySelectorAll('input[name="home-tax-tin-type"]').forEach(input => input.addEventListener("change", () => { homeTaxState.w8ben.tinType = input.value; saveHomeTaxState(); }));
  page.querySelectorAll('input[name="home-tax-income"]').forEach(input => input.addEventListener("change", () => { homeTaxState.w8ben.incomeSale = input.value === "sale"; homeTaxState.w8ben.otherIncome = input.value === "other"; saveHomeTaxState(); }));
  page.querySelectorAll("[data-home-tax-download]").forEach(button => button.addEventListener("click", async () => {
    const urls = { "w8-instructions": "https://www.irs.gov/pub/irs-pdf/iw8ben.pdf", "w8-tips": "https://www.irs.gov/pub/irs-pdf/fw8ben.pdf", ss4: "https://www.irs.gov/pub/irs-pdf/fss4.pdf" };
    const url = urls[button.dataset.homeTaxDownload];
    if (!url) return;
    try { await window.appleDeveloper.openExternal(url); } catch (error) { alert(error.message || "下载链接打开失败"); }
  }));
  page.querySelector('[data-home-tax-action="submit-w8"]')?.addEventListener("click", async event => {
    syncHomeTaxW8DraftFromPage();
    const entity = homeTaxDetailOpen === "w8bene";
    const taxFormType = entity ? "USA_W8BENE" : "USA_W8BEN";
    if (taxFormType !== homeTaxW8FormTypeForAccount()) {
      alert("当前账户类型已变化，请刷新后重试");
      return;
    }
    const complete = homeTaxW8CertificationComplete(homeTaxState.w8ben, entity);
    if (homeTaxState.w8ben.submitted || !complete) return;
    const button = event.currentTarget;
    const context = homeTaxApiContext();
    const scopeKey = homeTaxAddressContextKey(context, taxFormType);
    const w8 = homeTaxState.w8ben;
    setBusy(button, true, "提交中…");
    try {
      if (context.accountId && context.vendorId && context.vendorScopeId && !homeTaxW8Metadata) {
        await loadHomeTaxW8Metadata(taxFormType);
        if (!homeTaxW8Metadata) throw new Error("无法读取 W-8BEN 税务信息，请稍后重试");
        if (w8.submitted) return;
      }
      if (context.accountId && context.vendorId && context.vendorScopeId && typeof window.appleDeveloper.saveAppStoreTaxForm === "function") {
        const validation = await window.appleDeveloper.appStoreTaxQuestionnaireMetadata({
          ...context,
          taxCountry: "USA",
          taxFormType,
          formData: buildHomeTaxW8Payload(context.accountId, homeTaxW8Metadata, w8),
        }).catch(error => ({ success: false, error: error.message }));
        if (homeTaxAddressContextKey() !== scopeKey || (validation?.context && homeTaxAddressContextKey(validation.context, taxFormType) !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次提交已取消");
        if (!validation?.success) throw new Error(validation?.error || "W-8BEN 校验失败");
        homeTaxW8Metadata = validation;
        if (homeTaxW8IsSubmitted(validation.data)) {
          w8.submitted = true;
          saveHomeTaxState();
          renderHomePage();
          return;
        }
        const result = await window.appleDeveloper.saveAppStoreTaxForm({
          ...context,
          taxFormType,
          formData: buildHomeTaxW8Payload(context.accountId, homeTaxW8Metadata, w8),
        }).catch(error => ({ success: false, error: error.message }));
        if (homeTaxAddressContextKey() !== scopeKey || (result?.context && homeTaxAddressContextKey(result.context, taxFormType) !== scopeKey)) throw new Error("当前 Apple 账户已切换，本次提交结果不会应用到新账户");
        if (result?.alreadySubmitted) {
          w8.submitted = true;
          saveHomeTaxState();
          renderHomePage();
          return;
        }
        if (!result?.success) throw new Error(result?.error || "W-8BEN 提交失败");
      }
      homeTaxState.w8ben.submitted = true;
      saveHomeTaxState();
      await returnHomeAfterTaxSubmit();
    } catch (error) {
      setBusy(button, false);
      alert(error.message || "W-8BEN 提交失败");
    }
  });
}

function homeNeedsTaxForm() {
  if (homeTaxState.added) return false;
  const requirements = Array.isArray(homeBusinessStatus?.taxRequirements) ? homeBusinessStatus.taxRequirements : [];
  const forms = Array.isArray(homeBusinessStatus?.taxForms) ? homeBusinessStatus.taxForms : [];
  const hasRequiredTax = requirements.some(item => item?.isRequired !== false);
  return !forms.length && (hasRequiredTax || !!homeBusinessMessage("PPM.tax.taxInfo.usTaxMissing.message"));
}

function homeStaRequirement() {
  return homeComplianceRows().find(row => (
    String(row.requirement?.name || "").toUpperCase() === "STA" ||
    /国务院令第 810 号/.test(String(row.title || ""))
  )) || null;
}

function homeBusinessPageURL() {
  const entityId = String(homeBusinessStatus?.legalEntity?.id || "").trim();
  return entityId
    ? `https://appstoreconnect.apple.com/business/atb/${encodeURIComponent(entityId)}`
    : "https://appstoreconnect.apple.com/business";
}

function renderHomeBusinessNotices() {
  if (!authenticated || homeBusinessStatus?.success !== true) return "";
  const notices = [];
  if (homeNeedsBankAccount()) {
    notices.push(`<div class="home-business-notice info">
      <span class="home-business-notice-icon" aria-hidden="true">i</span>
      <div class="home-business-notice-copy"><span>若要接收 Apple 付款，必须添加银行账户。</span><button class="home-business-link" type="button" data-home-action="add-bank">添加银行账户</button></div>
    </div>`);
  }
  if (homeNeedsTaxForm()) {
    notices.push(`<div class="home-business-notice info">
      <span class="home-business-notice-icon" aria-hidden="true">i</span>
      <div class="home-business-notice-copy"><span>你的账户中还有一份或多份税务表格需要填写，请尽快提交。</span><button class="home-business-link" type="button" data-home-action="open-business">添加税务表格</button></div>
    </div>`);
  }
  const sta = homeStaRequirement();
  if (sta?.statusText === "缺少信息") {
    notices.push(`<div class="home-business-notice warning">
      <span class="home-business-notice-icon" aria-hidden="true">!</span>
      <div class="home-business-notice-copy"><span>为了避免付款中断，请添加关于国务院令第 810 号的税务合规信息。</span><div class="home-business-notice-links"><button class="home-business-link" type="button" data-home-action="open-business">进一步了解</button><button class="home-business-link" type="button" data-home-compliance="${escapeHTML(sta.id)}">添加信息</button></div></div>
    </div>`);
  }
  return notices.length ? `<div class="home-business-notices">${notices.join("")}</div>` : "";
}

function renderHomePage() {
  const page = el("page-home");
  if (!page) return;
  const crumb = el("crumb");
  closeHomeCountryPopover();
  if (homeTaxDetailOpen) {
    if (crumb) crumb.style.display = "none";
    if (homeTaxDetailOpen === "certificate") renderHomeTaxCertificatePage(page);
    else renderHomeTaxDetailPage(page);
    bindHomeTaxDetailEvents();
    return;
  }
  if (crumb) crumb.style.display = "";
  const access = homeAccessInfo();
  const entity = homeBusinessStatus?.legalEntity || null;
  const providerName = homeBusinessStatus?.provider?.name || entity?.name || "—";
  const loginStatus = authenticated ? "已登录" : "未登录";
  const businessFailed = homeOverviewCache.business.loaded && homeBusinessStatus?.success === false;
  const businessReady = homeBusinessStatus?.success === true;
  const businessCheckText = !authenticated ? "未登录" : businessFailed ? "读取失败" : homeBusinessStatus?.requiresLegalEntityUpdate ? "需更新" : businessReady ? "已达标" : homeStatusLoading ? "检查中" : "待检查";
  const businessCheckClass = !authenticated ? "muted" : businessFailed ? "bad" : homeBusinessStatus?.requiresLegalEntityUpdate ? "warn" : businessReady ? "ok" : "muted";
  const canEditEntity = !!(authenticated && entity?.id && entity.isEditable !== false);
  const alertHTML = authenticated && homeBusinessStatus?.requiresLegalEntityUpdate
    ? `<div class="home-legal-alert"><span class="home-alert-icon">!</span><div class="home-alert-copy"><strong>法律实体信息需更新</strong><span>${escapeHTML(homeBusinessStatus.legalEntityUpdateText || "若要提供 App 或其他 App 内购买项目，你必须在签署付费 App 协议前更新法律实体信息。")}</span><small>达标检测未通过</small></div><button class="home-alert-action" type="button" data-home-action="edit-legal-entity">编辑法律实体</button></div>`
    : "";
  const paidAgreement = authenticated && !homeBusinessStatus?.requiresLegalEntityUpdate ? homePendingPaidAppAgreement() : null;
  const paidAgreementHTML = paidAgreement
    ? `<div class="home-paid-agreement-notice"><span class="home-paid-agreement-icon">i</span><span>若要提供 App 或其他 App 内购买项目，你必须签署付费 App 协议。<button class="home-inline-link" type="button" data-home-action="sign-paid-app-agreement">签署付费 App 协议</button></span></div>`
    : "";
  const businessNoticesHTML = renderHomeBusinessNotices();
  const membershipHTML = renderHomeMembershipDetails();
  const bankHTML = renderHomeBankSection();
  const taxHTML = renderHomeTaxSection();
  const rows = homeProtocolRows();
  const complianceRows = homeComplianceRows();
  const complianceHTML = authenticated && homeBusinessStatus?.success
    ? `<section class="home-compliance-panel">
      <div class="home-compliance-title">合规</div>
      <div class="home-compliance-head"><span>法规</span><span>国家或地区</span><span>LAST UPDATED</span><span>状态</span><span>操作</span></div>
      ${complianceRows.length ? complianceRows.map(row => {
        const countries = Array.isArray(row.countries) ? row.countries : [];
        const countryCell = countries.length > 1
          ? `<div class="home-country-cell"><span>${escapeHTML(row.countryText || `${countries.length} 个国家或地区`)}</span><button class="home-country-link" type="button" data-home-countries="${escapeHTML(row.id)}">查看</button></div>`
          : `<div class="home-protocol-meta">${escapeHTML(row.countryText || "—")}</div>`;
        const action = row.actionLabel
          ? `<button class="home-compliance-action" type="button" data-home-compliance="${escapeHTML(row.id)}">${escapeHTML(row.actionLabel)}</button>`
          : "";
        return `<div class="home-compliance-row">
          <div class="home-compliance-name">${escapeHTML(row.title)}</div>
          ${countryCell}
          <div class="home-protocol-meta">${escapeHTML(row.dateText)}</div>
          <span class="home-status ${row.statusClass}">${escapeHTML(row.statusText)}</span>
          <div class="home-compliance-operation">${action}</div>
        </div>`;
      }).join("") : '<div class="home-compliance-empty">暂无需要处理的合规信息</div>'}
    </section>`
    : "";
  page.innerHTML = `<div class="home-page">
    <div class="home-head">
      <div><h1>首页</h1><p>集中查看软件有效期、Apple 账号状态、协议签署状态和法律实体信息。</p></div>
      <button class="secondary" id="home-refresh" type="button">${homeStatusLoading ? "检查中…" : "刷新状态"}</button>
    </div>
    <div class="home-overview">
      <section class="home-card home-license-card">
        <div class="home-license-top"><div><span>软件使用期限</span><div class="home-license-title"><h2>${escapeHTML(access.label)}</h2><button class="home-renew-button" type="button" data-home-action="renew-membership">续费</button></div></div><div class="home-days"><strong>${escapeHTML(access.remainingText)}</strong><span>天</span></div></div>
        <div class="home-progress-meta"><span>已使用 ${escapeHTML(access.elapsedText)} 天</span><span>剩余 ${escapeHTML(access.remainingText)} 天</span></div>
        <div class="home-progress"><span style="width:${access.progress}%"></span></div>
        <div class="home-license-foot"><span>状态：<strong>${escapeHTML(access.statusText)}</strong></span><span>到期时间：<strong>${escapeHTML(access.expiryText)}</strong></span></div>
      </section>
      <section class="home-card home-account-card">
        <div class="home-account-line"><div><strong>Apple 账号</strong><span>${escapeHTML(launchAppleId || "未登录 Apple ID")}</span></div><span class="home-status ${authenticated ? "ok" : "muted"}">${loginStatus}</span></div>
        <div class="home-account-line"><div><strong>商务账户</strong><span>${escapeHTML(providerName)}</span></div><span class="home-status ${businessCheckClass}">${escapeHTML(businessCheckText)}</span></div>
        <div class="home-entity-line"><div><strong>${escapeHTML(entity?.name || "法律实体")}</strong><span>${escapeHTML([entity?.legalEntityAddress?.city, entity?.legalEntityAddress?.regionText, entity?.legalEntityAddress?.postalCode].filter(Boolean).join(" ") || entity?.typeText || "登录后读取法律实体")}</span></div>${canEditEntity ? '<button class="home-entity-edit" type="button" data-home-action="edit-legal-entity">编辑法律实体</button>' : ""}</div>
      </section>
    </div>
    ${membershipHTML}
    ${businessNoticesHTML}
    ${alertHTML}
    ${paidAgreementHTML}
    ${bankHTML}
    ${taxHTML}
    <section class="home-protocol-panel">
      <div class="home-protocol-head"><span>协议</span><span>来源/说明</span><span>国家或地区</span><span>日期</span><span>状态</span><span>操作</span></div>
      ${rows.map(row => {
        const countries = Array.isArray(row.countries) ? row.countries : [];
        const countryCell = countries.length
          ? `<div class="home-country-cell"><span>${escapeHTML(row.countryText || `${countries.length} 个国家或地区`)}</span><button class="home-country-link" type="button" data-home-countries="${escapeHTML(row.id)}">查看</button></div>`
          : `<div class="home-protocol-meta">${escapeHTML(row.countryText || "—")}</div>`;
        return `<div class="home-protocol-row">
        <div class="home-protocol-name"><strong>${escapeHTML(row.title)}</strong><div class="home-protocol-meta">${escapeHTML(row.meta)}</div></div>
        <div class="home-protocol-meta">${escapeHTML(row.source)}</div>
        ${countryCell}
        <div class="home-protocol-meta">${escapeHTML(row.dateText)}</div>
        <span class="home-status ${row.statusClass}">${escapeHTML(row.statusText)}</span>
        <button class="home-protocol-view" type="button" data-home-protocol="${escapeHTML(row.id)}">${escapeHTML(row.actionLabel || "查看协议")}</button>
      </div>`;
      }).join("")}
    </section>
    ${complianceHTML}
  </div>`;
  bindHomeEvents();
}

function resetHomeOverviewCache() {
  homeOverviewGeneration += 1;
  homeAccountInfoPromise = null;
  homeStatusLoading = false;
  Object.values(homeOverviewCache).forEach(entry => {
    entry.loaded = false;
    entry.failed = false;
    entry.loading = false;
  });
}

function homeOverviewResultFailed(result) {
  return !result || result.success === false;
}

async function loadHomeOverview({ force = false } = {}) {
  if (homeStatusLoading) return;
  const generation = homeOverviewGeneration;
  const checks = [
    {
      key: "terms",
      shouldLoad: force || !homeOverviewCache.terms.loaded || homeOverviewCache.terms.failed,
      load: readAppStoreTermsStatus,
      assign: result => { homeTermsStatus = result; },
    },
    {
      key: "developerAgreement",
      shouldLoad: force || !homeOverviewCache.developerAgreement.loaded || homeOverviewCache.developerAgreement.failed,
      load: readDeveloperAgreementStatus,
      assign: result => { homeDeveloperAgreementStatus = result; },
    },
    {
      key: "business",
      shouldLoad: force || !homeOverviewCache.business.loaded || homeOverviewCache.business.failed,
      load: () => warmAppStoreBusinessStatus({ force }),
      assign: result => { homeBusinessStatus = result; },
    },
    {
      key: "account",
      shouldLoad: force || !homeOverviewCache.account.loaded || homeOverviewCache.account.failed,
      load: () => loadHomeAccountInfo({ force }),
      assign: applyHomeMembershipResult,
    },
  ].filter(check => check.shouldLoad);
  if (!checks.length) return;
  homeStatusLoading = true;
  checks.forEach(check => { homeOverviewCache[check.key].loading = true; });
  renderHomePage();
  const accessPromise = refreshAccess(false).catch(() => false);
  if (!authenticated) {
    homeTermsStatus = null;
    homeDeveloperAgreementStatus = null;
    homeBusinessStatus = null;
    homeAccountInfo = null;
    resetHomeOverviewCache();
    homeStatusLoading = false;
    renderHomePage();
    return;
  }
  const settle = async factory => {
    try {
      return { status: "fulfilled", value: await factory() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  const applyCheckResult = (check, result) => {
    if (generation !== homeOverviewGeneration) return;
    const value = result.status === "fulfilled"
      ? result.value
      : { success: false, error: result.reason?.message || "首页状态读取失败" };
    check.assign(value);
    homeOverviewCache[check.key].loaded = true;
    homeOverviewCache[check.key].failed = homeOverviewResultFailed(value);
    homeOverviewCache[check.key].loading = false;
    if (check.key === "business") {
      if (homeBusinessStatus?.success) cacheAppStoreBusinessStatus(homeBusinessStatus);
      syncHomeTaxStateFromBusiness();
    }
    renderHomePage();
  };
  await Promise.all([
    ...checks.map(check => settle(check.load).then(result => applyCheckResult(check, result))),
    accessPromise,
  ]);
  if (generation !== homeOverviewGeneration) return;
  if (homeBusinessStatus?.authenticated === false) applyStatus({ authenticated: false });
  homeStatusLoading = false;
  renderHomePage();
}

function bindHomeEvents() {
  el("home-refresh")?.addEventListener("click", () => loadHomeOverview({ force: true }));
  document.querySelectorAll('[data-home-action="retry-membership"]').forEach(button => {
    button.addEventListener("click", refreshHomeMembershipDetails);
  });
  document.querySelectorAll("[data-home-protocol]").forEach(button => {
    button.addEventListener("click", () => openHomeProtocol(button.dataset.homeProtocol));
  });
  document.querySelectorAll("[data-home-compliance]").forEach(button => {
    button.addEventListener("click", () => {
      const row = homeComplianceRows().find(item => item.id === button.dataset.homeCompliance);
      if (row?.requirement) openComplianceFormDialog(row.requirement);
    });
  });
  document.querySelectorAll("[data-home-countries]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      openHomeCountryPopover(button.dataset.homeCountries, button);
    });
  });
  document.querySelectorAll('[data-home-action="edit-legal-entity"]').forEach(button => {
    button.addEventListener("click", openLegalEntityDialog);
  });
  document.querySelectorAll('[data-home-action="sign-paid-app-agreement"]').forEach(button => {
    button.addEventListener("click", () => openPaidAppAgreementDialog(homePendingPaidAppAgreement()));
  });
  document.querySelectorAll('[data-home-action="add-bank"]').forEach(button => {
    button.addEventListener("click", openBankAccountDialog);
  });
  document.querySelectorAll('[data-home-action="renew-membership"]').forEach(button => {
    button.addEventListener("click", () => showAccessRenewalDialog("home"));
  });
  document.querySelectorAll('[data-home-action="open-business"]').forEach(button => {
    button.addEventListener("click", async () => {
      try {
        const result = await window.appleDeveloper.openExternal(homeBusinessPageURL());
        if (result?.success === false) throw new Error(result.error || "商务页面打开失败");
      } catch (error) {
        alert(error.message || "商务页面打开失败");
      }
    });
  });
  bindHomeTaxEvents();
}

function closeHomeCountryPopover() {
  document.querySelector(".home-country-popover")?.remove();
  if (homeCountryPopoverOutsideHandler) {
    document.removeEventListener("mousedown", homeCountryPopoverOutsideHandler, true);
    homeCountryPopoverOutsideHandler = null;
  }
}

function openHomeCountryPopover(protocolId, anchor) {
  const row = homeProtocolRows().find(item => item.id === protocolId) || homeComplianceRows().find(item => item.id === protocolId);
  const countries = (Array.isArray(row?.countries) ? row.countries : [])
    .map(item => ({ name: String(item?.name || item?.code || ""), code: String(item?.code || "") }))
    .filter(item => item.name);
  if (!countries.length || !anchor) return;
  closeHomeCountryPopover();
  const popover = document.createElement("div");
  popover.className = "home-country-popover";
  popover.innerHTML = `<div class="home-country-popover-title">国家或地区</div><div class="home-country-list">${countries.map(country => `<div><span>${escapeHTML(country.name)}</span></div>`).join("")}</div>`;
  document.body.appendChild(popover);
  const positionPopover = () => {
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth || 210;
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    popover.style.left = `${left}px`;
    const height = popover.offsetHeight || 420;
    const aboveTop = rect.top - height - 12;
    if (aboveTop >= 10) {
      popover.classList.remove("below");
      popover.style.top = `${aboveTop}px`;
    } else {
      popover.classList.add("below");
      popover.style.top = `${Math.min(rect.bottom + 12, window.innerHeight - height - 10)}px`;
    }
    popover.style.setProperty("--arrow-x", `${rect.left + rect.width / 2 - left}px`);
  };
  requestAnimationFrame(positionPopover);
  homeCountryPopoverOutsideHandler = event => {
    if (!popover.contains(event.target) && event.target !== anchor) closeHomeCountryPopover();
  };
  setTimeout(() => document.addEventListener("mousedown", homeCountryPopoverOutsideHandler, true), 0);
}

async function openHomeProtocol(protocolId) {
  const row = homeProtocolRows().find(item => item.id === protocolId);
  if (!row) return;
  if (row.type === "asc") {
    if (homeTermsStatus?.required) {
      currentAgreement = normalizeAppStoreTermsAgreement(homeTermsStatus.terms || {});
    } else {
      currentAgreement = {
        source: "home-info",
        readOnly: true,
        title: "App Store Connect 服务条款",
        metaText: row.meta,
        agreementText: homeTermsStatus?.success
          ? "当前 Apple ID 已同意最新的 App Store Connect 服务条款。"
          : `暂时无法确认 App Store Connect 服务条款状态：${homeTermsStatus?.error || "请刷新后重试"}`,
      };
    }
    await openAgreementDialog();
    return;
  }
  if (row.type === "developer") {
    const agreement = (homeDeveloperAgreementStatus?.outstanding || [])[0];
    currentAgreement = agreement
      ? { ...agreement, source: "apple-developer" }
      : {
        source: "home-info",
        readOnly: true,
        title: "Apple Developer 协议",
        metaText: row.meta,
        agreementText: homeDeveloperAgreementStatus?.success
          ? "当前开发者团队已同意最新的 Apple Developer 协议。"
          : `暂时无法确认 Apple Developer 协议状态：${homeDeveloperAgreementStatus?.error || "请刷新后重试"}`,
      };
    await openAgreementDialog();
    return;
  }
  if (row.type === "business") {
    const agreement = row.agreement || {};
    if (agreement.kind === "paid-app") {
      if (homeBusinessStatus?.requiresLegalEntityUpdate) {
        await openLegalEntityDialog();
        return;
      }
      await openPaidAppAgreementDialog(agreement, { readOnly: !isPendingPaidAppAgreement(agreement) });
      return;
    }
    currentAgreement = {
      source: "home-info",
      readOnly: true,
      title: agreement.title || "商务协议",
      metaText: `${row.source} · ${row.statusText}`,
      agreementText: [
        `协议名称：${agreement.title || "商务协议"}`,
        `状态：${row.statusText}`,
        `生效日期：${row.dateText}`,
        `国家或地区：${agreement.countryScopeText || (agreement.countriesCount ? `${agreement.countriesCount} 个国家或地区` : "—")}`,
        agreement.localizedTermUrl ? `Apple 协议链接：${agreement.localizedTermUrl}` : "",
        row.statusText === "受阻" ? "签署付费 App 协议前需要先更新法律实体信息。" : "",
      ].filter(Boolean).join("\n"),
    };
    await openAgreementDialog();
    return;
  }
  if (row.type === "compliance") {
    const compliance = row.compliance || {};
    currentAgreement = {
      source: "home-info",
      readOnly: true,
      title: compliance.title || "合规信息",
      metaText: `${row.source} · ${row.statusText}`,
      agreementText: [`名称：${row.title}`, `类型：${row.meta}`, `状态：${row.statusText}`, `最近更新：${row.dateText}`].join("\n"),
    };
    await openAgreementDialog();
    return;
  }
  currentAgreement = {
    source: "home-info",
    readOnly: true,
    title: row.title || "协议详情",
    metaText: row.meta || "协议状态",
    agreementText: row.meta || "暂无可显示的协议详情。",
  };
  await openAgreementDialog();
}

function ensureBankAccountDialog() {
  let mask = document.querySelector(".bank-account-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "bank-account-mask";
  document.body.appendChild(mask);
  mask.addEventListener("click", event => { if (event.target === mask) closeBankAccountDialog(); });
  return mask;
}

function closeBankAccountDialog() {
  document.querySelector(".bank-account-mask")?.classList.remove("show");
  closeBankSearchDialog();
  currentBankDraft = null;
}

function ensureBankSearchDialog() {
  let mask = document.querySelector(".bank-search-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "bank-search-mask";
  document.body.appendChild(mask);
  mask.addEventListener("click", event => { if (event.target === mask) closeBankSearchDialog(); });
  return mask;
}

function closeBankSearchDialog() {
  document.querySelector(".bank-search-mask")?.classList.remove("show");
  currentBankSearchDraft = null;
}

function bankOptionsHTML(options = [], selected = "", placeholder = "选取") {
  const rows = [`<option value="">${escapeHTML(placeholder)}</option>`];
  (Array.isArray(options) ? options : []).forEach(option => {
    const value = String(option?.value || "");
    if (!value) return;
    const label = String(option?.label || option?.name || value);
    rows.push(`<option value="${escapeHTML(value)}" ${value === selected ? "selected" : ""}>${escapeHTML(label)}</option>`);
  });
  return rows.join("");
}

function bankCountryPickerHTML(id, options = [], selected = "", disabled = false) {
  const rows = Array.isArray(options) ? options.filter(option => String(option?.value || "")) : [];
  const selectedOption = rows.find(option => String(option.value) === String(selected));
  const selectedLabel = String(selectedOption?.label || selectedOption?.name || (disabled && !rows.length ? "正在读取..." : "选取"));
  return `<div class="bank-country-picker" data-bank-country-picker="${escapeHTML(id)}">
    <input id="${escapeHTML(id)}" type="hidden" value="${escapeHTML(selected || "")}">
    <button class="bank-country-picker-toggle" type="button" aria-haspopup="listbox" aria-expanded="false" ${disabled ? "disabled" : ""}>
      <span>${escapeHTML(selectedLabel)}</span><i aria-hidden="true"></i>
    </button>
    <div class="bank-country-picker-menu" role="listbox" hidden>
      ${rows.map(option => {
        const value = String(option.value || "");
        const label = String(option.label || option.name || value);
        return `<button type="button" role="option" data-bank-country-value="${escapeHTML(value)}" aria-selected="${value === selected ? "true" : "false"}" class="${value === selected ? "selected" : ""}">${escapeHTML(label)}</button>`;
      }).join("")}
    </div>
  </div>`;
}

function bindBankCountryPicker(id, onChange) {
  const input = document.getElementById(id);
  const picker = input?.closest(".bank-country-picker");
  const toggle = picker?.querySelector(".bank-country-picker-toggle");
  const menu = picker?.querySelector(".bank-country-picker-menu");
  if (!input || !picker || !toggle || !menu) return;
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => {
    const opening = menu.hidden;
    document.querySelectorAll(".bank-country-picker-menu:not([hidden])").forEach(node => { node.hidden = true; });
    document.querySelectorAll('.bank-country-picker-toggle[aria-expanded="true"]').forEach(node => node.setAttribute("aria-expanded", "false"));
    menu.hidden = !opening;
    toggle.setAttribute("aria-expanded", opening ? "true" : "false");
    if (opening) {
      const rect = toggle.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const openAbove = spaceBelow < 160 && rect.top > spaceBelow;
      const available = Math.max(120, Math.min(240, (openAbove ? rect.top : spaceBelow) - 8));
      menu.style.left = `${Math.round(rect.left)}px`;
      menu.style.width = `${Math.round(rect.width)}px`;
      menu.style.maxHeight = `${Math.round(available)}px`;
      menu.style.top = openAbove ? "auto" : `${Math.round(rect.bottom + 4)}px`;
      menu.style.bottom = openAbove ? `${Math.round(window.innerHeight - rect.top + 4)}px` : "auto";
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    }
  });
  menu.querySelectorAll("[data-bank-country-value]").forEach(button => {
    button.addEventListener("click", () => {
      const value = String(button.dataset.bankCountryValue || "");
      input.value = value;
      toggle.querySelector("span").textContent = String(button.textContent || "").trim();
      menu.querySelectorAll('[role="option"]').forEach(option => {
        const isSelected = option === button;
        option.classList.toggle("selected", isSelected);
        option.setAttribute("aria-selected", isSelected ? "true" : "false");
      });
      close();
      onChange(value);
    });
  });
  picker.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      close();
      toggle.focus();
    }
  });
}

function bankNormalizeAccountNumber(value = "") {
  return String(value || "").replace(/\s+/g, "");
}

function bankCountryOptions(metadata = null) {
  const options = Array.isArray(metadata?.countryOptions) ? metadata.countryOptions : [];
  return options.length ? options : [{ value: "CHN", label: "中国大陆" }, { value: "USA", label: "美国" }];
}

function bankAddressCountryOptions(metadata = null) {
  const options = Array.isArray(metadata?.addressCountryOptions) ? metadata.addressCountryOptions : [];
  return options.length ? options : bankCountryOptions(metadata);
}

function bankHolderTypeOptions(metadata = null) {
  const options = Array.isArray(metadata?.holderTypeOptions) ? metadata.holderTypeOptions : [];
  return options.length ? options : [];
}

function bankAccountTypeOptions(metadata = null) {
  const options = Array.isArray(metadata?.accountTypeOptions) ? metadata.accountTypeOptions : [];
  if (options.length || metadata) return options;
  return [
    { value: "CHECKING", label: "支票账户" },
    { value: "SAVINGS", label: "储蓄账户" },
  ];
}

function bankCurrencyOptions(metadata = null) {
  const options = Array.isArray(metadata?.currencyOptions) ? metadata.currencyOptions : [];
  return options.length ? options : [];
}

function bankMetadataAddress(metadata = null) {
  const address = metadata?.accountHolderAddress && typeof metadata.accountHolderAddress === "object" ? metadata.accountHolderAddress : {};
  return {
    country: String(address.country || "USA"),
    addressLine1: String(address.addressLine1 || ""),
    addressLine2: String(address.addressLine2 || ""),
    city: String(address.city || ""),
    regionText: String(address.regionText || ""),
    regionSelect: String(address.regionSelect || ""),
    postalCode: String(address.postalCode || ""),
    addressId: String(address.addressId || ""),
    iso2CountryCode: String(address.iso2CountryCode || ""),
  };
}

function bankLegalEntityName() {
  const raw = homeBusinessStatus?.rawLegalEntity || homeBusinessStatus?.legalEntity?.raw || {};
  const entity = homeBusinessStatus?.legalEntity || {};
  const candidates = [
    raw.accountHolderName,
    raw.financeName,
    raw.legalEntityName,
    raw.name,
    entity.accountHolderName,
    entity.name,
    raw.alternateLegalName,
    raw.legalEntityLocalName,
    entity.localName,
  ];
  return String(candidates.find(value => String(value || "").trim()) || "").trim();
}

function bankLegalEntityHolderType() {
  return homeBusinessStatus?.legalEntity?.isOrganization ? "CORPORATION" : "INDIVIDUAL";
}

function bankLegalEntityAddress() {
  const raw = homeBusinessStatus?.rawLegalEntity || homeBusinessStatus?.legalEntity?.raw || {};
  const address = raw.financeAddress || raw.legalEntityAddress || raw.address || homeBusinessStatus?.legalEntity?.financeAddress || homeBusinessStatus?.legalEntity?.legalEntityAddress || {};
  return {
    country: String(address.country || homeBusinessStatus?.legalEntity?.legalEntityAddress?.country || "CHN"),
    addressLine1: String(address.addressLine1 || ""),
    addressLine2: String(address.addressLine2 || ""),
    city: String(address.city || ""),
    regionText: String(address.regionText || ""),
    regionSelect: String(address.regionSelect || ""),
    postalCode: String(address.postalCode || ""),
    addressId: String(address.addressId || raw.legalEntityId || homeBusinessStatus?.legalEntity?.id || ""),
    iso2CountryCode: String(address.iso2CountryCode || ""),
  };
}

function bankDefaultForm(metadata = null) {
  return {
    accountHolderName: String(metadata?.data?.accountHolderName || ""),
    accountHolderType: String(metadata?.data?.accountHolderType || ""),
    accountType: String(metadata?.data?.accountType || ""),
    selectedCurrency: String(metadata?.selectedCurrency || metadata?.data?.selectedCurrency || ""),
    nickName: String(metadata?.data?.nickName || ""),
    accountNumber: bankNormalizeAccountNumber(metadata?.data?.accountNumber || ""),
    bankBranchIdentification1: String(metadata?.data?.bankBranchIdentification1 || ""),
    bankBranchIdentification2: String(metadata?.data?.bankBranchIdentification2 || ""),
    bankName: "",
    accountHolderAddress: bankMetadataAddress(metadata),
  };
}

function bankDraftMetadataPayload(extra = {}) {
  const draft = currentBankDraft || {};
  const metadata = draft.metadata || {};
  const form = draft.form || bankDefaultForm(metadata);
  return {
    accountId: draft.accountId,
    selectedCountry: draft.selectedCountry,
    optimisticLock: metadata.optimisticLock || homeBusinessStatus?.legalEntity?.optimisticLock || "",
    unknownBankBranchIdentificationKey: metadata.unknownBankBranchIdentificationKey || `PPM.banking.bankingAccount.unknownBankBranchIdentificationKey.${draft.selectedCountry || "USA"}`,
    skipRoyaltySelect: metadata.skipRoyaltySelect !== false,
    accountHolderName: form.accountHolderName,
    accountHolderType: form.accountHolderType,
    accountType: form.accountType,
    selectedCurrency: form.selectedCurrency || draft.selectedCurrency || metadata.selectedCurrency || "",
    nickName: form.nickName,
    accountNumber: form.accountNumber,
    bankBranchIdentification1: form.bankBranchIdentification1,
    bankBranchIdentification2: form.bankBranchIdentification2,
    accountHolderAddress: form.accountHolderAddress,
    ...extra,
  };
}

function bankReadFormFromDialog() {
  if (!currentBankDraft) return;
  const form = currentBankDraft.form || bankDefaultForm(currentBankDraft.metadata);
  const address = form.accountHolderAddress || {};
  const value = id => String(document.getElementById(id)?.value || "");
  if (document.getElementById("bank-holder-name")) form.accountHolderName = value("bank-holder-name");
  if (document.getElementById("bank-holder-type")) form.accountHolderType = value("bank-holder-type");
  if (document.getElementById("bank-account-type")) form.accountType = value("bank-account-type");
  if (document.getElementById("bank-currency")) {
    form.selectedCurrency = value("bank-currency");
    currentBankDraft.selectedCurrency = form.selectedCurrency;
  }
  if (document.getElementById("bank-nick-name")) form.nickName = value("bank-nick-name");
  if (document.getElementById("bank-account-number")) {
    const input = document.getElementById("bank-account-number");
    form.accountNumber = bankNormalizeAccountNumber(input.value);
    if (input.value !== form.accountNumber) input.value = form.accountNumber;
  }
  if (document.getElementById("bank-cnaps-code")) form.bankBranchIdentification1 = value("bank-cnaps-code");
  if (document.getElementById("bank-branch-id2")) form.bankBranchIdentification2 = value("bank-branch-id2");
  if (document.getElementById("bank-selected-name")) form.bankName = value("bank-selected-name");
  if (document.getElementById("bank-address-line1")) address.addressLine1 = value("bank-address-line1");
  if (document.getElementById("bank-address-line2")) address.addressLine2 = value("bank-address-line2");
  if (document.getElementById("bank-city")) address.city = value("bank-city");
  if (document.getElementById("bank-postal-code")) address.postalCode = value("bank-postal-code");
  if (document.getElementById("bank-address-country")) address.country = value("bank-address-country") || address.country || "USA";
  if (document.getElementById("bank-region-select")) {
    address.regionSelect = value("bank-region-select");
    address.regionText = "";
  } else if (document.getElementById("bank-region-text")) {
    address.regionText = value("bank-region-text");
    address.regionSelect = "";
  }
  currentBankDraft.form = { ...form, accountHolderAddress: address };
}

function bankHasCJK(text = "") {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function bankConstraint(attributeName = "") {
  const constraints = currentBankDraft?.metadata?.constraints || {};
  const target = String(attributeName || "");
  return Object.entries(constraints).find(([path, rule]) => (
    String(rule?.attributeName || "").replace(/^\$\[\*\]\.?/, "") === target ||
    String(path || "").replace(/^\$\[\*\]\.?/, "") === target
  ))?.[1] || null;
}

function bankRuleError(value = "", rule = null, fallback = "格式不符合 Apple 要求") {
  const text = String(value || "");
  if (!rule) return "";
  if (rule.required === true && !text.trim()) return "必填项不能为空";
  if (rule.required !== true && !text.trim()) return "";
  if (Number(rule.sizeMin || 0) > 0 && text.length < Number(rule.sizeMin)) return fallback;
  if (Number(rule.sizeMax || 0) > 0 && text.length > Number(rule.sizeMax)) return fallback;
  if (rule.regex && text) {
    try { if (!(new RegExp(String(rule.regex))).test(text)) return fallback; } catch {}
  }
  return "";
}

function bankFieldInvalidClass(attributeName = "", value = "") {
  const error = bankRuleError(value, bankConstraint(attributeName), "此值无效。");
  return error ? " invalid" : "";
}

function bankFieldInlineError(attributeName = "", value = "") {
  const error = bankRuleError(value, bankConstraint(attributeName), "此值无效。");
  return `<small class="bank-field-error" data-bank-error-for="${escapeHTML(attributeName)}">${escapeHTML(error)}</small>`;
}

function bankRefreshInlineValidation(inputId = "", attributeName = "") {
  const input = document.getElementById(inputId);
  if (!input) return "";
  const error = bankRuleError(input.value, bankConstraint(attributeName), "此值无效。");
  input.classList.toggle("invalid", !!error);
  const label = input.closest("label");
  const errorNode = label?.querySelector(`[data-bank-error-for="${CSS.escape(attributeName)}"]`);
  if (errorNode) errorNode.textContent = error;
  return error;
}

function bankHolderValidationError() {
  const form = currentBankDraft?.form || {};
  const address = form.accountHolderAddress || {};
  const regionOptions = Array.isArray(currentBankDraft?.metadata?.regionOptions) ? currentBankDraft.metadata.regionOptions : [];
  if (!String(form.accountHolderName || "").trim()) return "请填写账户持有人姓名";
  if (bankHasCJK(form.accountHolderName)) return "账户持有人姓名只能使用英文，可以填写拼音";
  const holderNameRuleError = bankRuleError(form.accountHolderName, bankConstraint("accountHolderName"), "账户持有人姓名只能使用英文，可以填写拼音");
  if (holderNameRuleError) return holderNameRuleError;
  if (!String(form.accountHolderType || "").trim()) return "请选择账户持有人类型";
  if (!String(address.addressLine1 || "").trim()) return "请填写账户持有人地址";
  if (!String(address.city || "").trim()) return "请填写城市";
  if (regionOptions.length && !String(address.regionSelect || "").trim()) return "请选择州或省";
  if (!String(address.postalCode || "").trim()) return "请填写邮政编码";
  if (!String(address.country || "").trim()) return "请选择国家或地区";
  return "";
}

function bankDetailValidationError() {
  const form = currentBankDraft?.form || {};
  const nickError = bankRuleError(form.nickName, bankConstraint("nickName"), "银行账户名称格式不正确");
  if (nickError) return nickError;
  if (bankAccountTypeOptions(currentBankDraft?.metadata).length && !String(form.accountType || "").trim()) return "请选择账户类型";
  if (!String(form.selectedCurrency || currentBankDraft?.selectedCurrency || "").trim()) return "请选择银行账户币种";
  if (!String(form.bankBranchIdentification1 || "").trim()) return "请选择或填写 CNAPS 代码";
  if (!String(form.accountNumber || "").trim()) return "请填写银行账号";
  const accountError = bankRuleError(form.accountNumber, bankConstraint("accountNumber"), "银行账号格式不正确");
  if (accountError) return "银行账号格式不正确";
  return "";
}

function bankFormReady() {
  const step = currentBankDraft?.step;
  if (step === "holder") return !bankHolderValidationError();
  if (step === "bank") return !bankDetailValidationError();
  if (step === "agreement") return document.getElementById("bank-agreement-confirm")?.checked === true;
  return true;
}

function bankUpdateNextButton() {
  const button = document.getElementById("bank-next");
  if (!button || !currentBankDraft) return;
  button.disabled = currentBankDraft.loading || (currentBankDraft.step === "country" ? !currentBankDraft.selectedCountry : !bankFormReady());
}

function bankCnapsInvalidErrorMessage() {
  return "1、请点击按钮“不知道你的 CNAPS 代码?”来进行搜索CNAPS 代码以确保信息的准确性;\n2、请核对银行卡号是否正确";
}

function bankFriendlyError(text = "") {
  const raw = String(text || "");
  if (
    /PPM\.banking\.bankingAccount\.localClearingCode\.CHN\.validate\.invalid/i.test(raw) ||
    /PPM\.banking\.localclearnacecode\.search\.invalidLocalClearingCode/i.test(raw) ||
    /PPM\.banking\.localclearingcode\.search\.invalidLocalClearingCode/i.test(raw)
  ) {
    return bankCnapsInvalidErrorMessage();
  }
  return raw;
}

function bankSetError(text = "") {
  const message = bankFriendlyError(text);
  const error = document.getElementById("bank-error");
  if (error) error.textContent = message;
  if (currentBankDraft) currentBankDraft.error = message;
}

function renderBankAccountDialog() {
  const mask = ensureBankAccountDialog();
  const draft = currentBankDraft || {};
  const metadata = draft.metadata || null;
  const loading = draft.loading === true;
  const form = draft.form || bankDefaultForm(metadata);
  const address = form.accountHolderAddress || {};
  const countryOptions = bankCountryOptions(metadata);
  const addressCountryOptions = bankAddressCountryOptions(metadata);
  const holderTypeOptions = bankHolderTypeOptions(metadata);
  const accountTypeOptions = bankAccountTypeOptions(metadata);
  const currencyOptions = bankCurrencyOptions(metadata);
  const regionOptions = Array.isArray(metadata?.regionOptions) ? metadata.regionOptions : [];
  const holderLocked = draft.sameLegalEntity === true;
  const holderDisabled = holderLocked ? "disabled" : "";
  const isHolderStep = draft.step === "holder";
  const isBankStep = draft.step === "bank";
  const isAgreementStep = draft.step === "agreement";
  const selectedBankAddress = [form.selectedBank?.addressLine1, form.selectedBank?.addressLine2, form.selectedBank?.city, form.selectedBank?.state, form.selectedBank?.postalCode, form.selectedBank?.country].filter(Boolean).join("\n");
  const regionControl = regionOptions.length
    ? `<select id="bank-region-select" ${holderDisabled}>${bankOptionsHTML(regionOptions, String(address.regionSelect || ""), "")}</select>`
    : `<input id="bank-region-text" value="${escapeHTML(address.regionText || "")}" ${holderDisabled}>`;
  const stepTitle = isAgreementStep ? "声明" : isBankStep ? "添加银行账户" : isHolderStep ? "账户持有人详细信息" : "添加新银行账户";
  const bodyHTML = isHolderStep
    ? `<div class="bank-dialog-body">
        <h2>${stepTitle}</h2>
        <p>请输入与银行账户中完全一致的信息，否则付款可能无法完成。</p>
        <label class="bank-same-entity"><input id="bank-same-entity" type="checkbox" ${draft.sameLegalEntity ? "checked" : ""}><span>与法律实体相同</span></label>
        <div class="bank-form-grid">
          <label><span>账户持有人姓名</span><input id="bank-holder-name" value="${escapeHTML(form.accountHolderName || "")}"></label>
          <label><span>账户持有人类型</span><select id="bank-holder-type" ${holderDisabled}>${bankOptionsHTML(holderTypeOptions, form.accountHolderType || "", "")}</select></label>
          <label><span>账户持有人地址</span><input id="bank-address-line1" value="${escapeHTML(address.addressLine1 || "")}" ${holderDisabled}></label>
          <label><span>地址行 2</span><input id="bank-address-line2" value="${escapeHTML(address.addressLine2 || "")}" ${holderDisabled}></label>
          <label><span>城市</span><input id="bank-city" value="${escapeHTML(address.city || "")}" ${holderDisabled}></label>
          <label><span>州或省</span>${regionControl}</label>
          <label><span>邮政编码</span><input id="bank-postal-code" value="${escapeHTML(address.postalCode || "")}" ${holderDisabled}></label>
          <label><span>国家或地区</span><select id="bank-address-country" ${holderDisabled}>${bankOptionsHTML(addressCountryOptions, String(address.country || "USA"), "")}</select></label>
        </div>
        <div class="bank-dialog-error" id="bank-error">${escapeHTML(draft.error || "")}</div>
      </div>`
    : isBankStep
      ? `<div class="bank-dialog-body">
        <h2>${stepTitle}</h2>
        <p>来自 Apple 的付款将存入此银行账户。</p>
        <div class="bank-form-grid">
          <label><span>银行所在国家或地区</span>${bankCountryPickerHTML("bank-country-inline", countryOptions, draft.selectedCountry || "")}</label>
          <label><span>银行账户币种</span><select id="bank-currency">${bankOptionsHTML(currencyOptions, form.selectedCurrency || draft.selectedCurrency || metadata?.selectedCurrency || "", "")}</select></label>
          <label><span>账户名称（可选）</span><input id="bank-nick-name" class="${bankFieldInvalidClass("nickName", form.nickName)}" value="${escapeHTML(form.nickName || "")}">${bankFieldInlineError("nickName", form.nickName)}</label>
          ${accountTypeOptions.length ? `<label><span>账户类型</span><select id="bank-account-type">${bankOptionsHTML(accountTypeOptions, form.accountType || "", "")}</select></label>` : ""}
          <label><span>CNAPS 代码</span><input id="bank-cnaps-code" value="${escapeHTML(form.bankBranchIdentification1 || "")}"><button class="bank-cnaps-help" id="bank-cnaps-help" type="button">不知道你的 CNAPS 代码?</button></label>
          <label><span>账号</span><input id="bank-account-number" class="${bankFieldInvalidClass("accountNumber", form.accountNumber)}" value="${escapeHTML(form.accountNumber || "")}" autocomplete="off" spellcheck="false">${bankFieldInlineError("accountNumber", form.accountNumber)}</label>
          <input id="bank-branch-id2" type="hidden" value="${escapeHTML(form.bankBranchIdentification2 || "")}">
          ${selectedBankAddress ? `<div class="bank-selected-address wide"><strong>银行地址</strong><span>${escapeHTML(selectedBankAddress).replace(/\n/g, "<br>")}</span></div>` : ""}
        </div>
        <div class="bank-dialog-error" id="bank-error">${escapeHTML(draft.error || "")}</div>
      </div>`
      : isAgreementStep
        ? `<div class="bank-dialog-body bank-agreement-step">
        <h2>${stepTitle}</h2>
        <div class="bank-agreement-content">
          <p>我保证上述信息真实准确；另外，作为本公司（我本人）的代表，我在此授权 Apple Inc. 和/或其附属公司（可能包括 Apple Distribution International Ltd.、iTunes K.K.、Apple Canada, Inc.、Apple Services LATAM LLC 和/或 Apple Pty Ltd.）（以下简称“Apple”）应付账款以电子方式存入指定银行账户。（其中包括我对改正所有错误条目的授权）。这一授权将持续有效，直到 Apple 收到请求更改授权或取消授权的书面通知，或直到 Apple 通知停止提供此服务为止。</p>
        </div>
        <label class="bank-agreement-confirm"><input id="bank-agreement-confirm" type="checkbox" ${draft.agreementAccepted ? "checked" : ""}><span>我已阅读并同意以上条款与条件。</span></label>
        <div class="bank-dialog-error" id="bank-error">${escapeHTML(draft.error || "")}</div>
      </div>`
        : `<div class="bank-dialog-body bank-country-step">
        <h2>${stepTitle}</h2>
        <p>来自 Apple 的付款将存入此银行账户。</p>
        <label><span>银行所在国家或地区</span>${loading && !metadata ? bankCountryPickerHTML("bank-country", [], "", true) : bankCountryPickerHTML("bank-country", countryOptions, draft.selectedCountry || "", loading)}</label>
        <div class="bank-dialog-error" id="bank-error">${escapeHTML(draft.error || "")}</div>
      </div>`;
  mask.innerHTML = `<section class="bank-account-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-dialog-title">
    ${bodyHTML}
    <div class="bank-dialog-foot">
      <button class="secondary" id="bank-back" type="button" ${draft.step === "country" ? "disabled" : ""}>返回</button>
      <span></span>
      <button class="secondary" id="bank-cancel" type="button">取消</button>
      <button class="primary" id="bank-next" type="button">${loading ? "读取中..." : (isAgreementStep ? "添加" : "下一步")}</button>
    </div>
  </section>`;
  mask.classList.add("show");
  document.getElementById("bank-cancel")?.addEventListener("click", closeBankAccountDialog);
  document.getElementById("bank-back")?.addEventListener("click", () => {
    if (!currentBankDraft || currentBankDraft.step === "country") return;
    bankReadFormFromDialog();
    currentBankDraft.step = currentBankDraft.step === "agreement" ? "bank" : currentBankDraft.step === "bank" ? "holder" : "country";
    currentBankDraft.error = "";
    renderBankAccountDialog();
  });
  document.getElementById("bank-next")?.addEventListener("click", handleBankNext);
  bindBankCountryPicker("bank-country", value => {
    if (!currentBankDraft) return;
    currentBankDraft.selectedCountry = String(value || "");
    bankSetError("");
    bankUpdateNextButton();
  });
  if (isHolderStep) {
    ["bank-holder-name", "bank-holder-type", "bank-address-line1", "bank-address-line2", "bank-city", "bank-region-select", "bank-region-text", "bank-postal-code"].forEach(id => {
      document.getElementById(id)?.addEventListener("input", () => {
        bankReadFormFromDialog();
        bankSetError(bankHasCJK(currentBankDraft?.form?.accountHolderName) ? "账户持有人姓名只能使用英文，可以填写拼音" : "");
        bankUpdateNextButton();
      });
      document.getElementById(id)?.addEventListener("change", () => {
        bankReadFormFromDialog();
        bankSetError(bankHasCJK(currentBankDraft?.form?.accountHolderName) ? "账户持有人姓名只能使用英文，可以填写拼音" : "");
        bankUpdateNextButton();
      });
    });
    document.getElementById("bank-address-country")?.addEventListener("change", handleBankAddressCountryChange);
    document.getElementById("bank-same-entity")?.addEventListener("change", handleBankSameLegalEntityChange);
  }
  if (isBankStep) {
    ["bank-nick-name", "bank-account-type", "bank-currency", "bank-cnaps-code", "bank-account-number"].forEach(id => {
      document.getElementById(id)?.addEventListener("input", () => {
        if (id === "bank-account-number") {
          const input = document.getElementById(id);
          input.value = bankNormalizeAccountNumber(input.value);
        }
        bankReadFormFromDialog();
        bankSetError("");
        if (id === "bank-nick-name") bankRefreshInlineValidation(id, "nickName");
        if (id === "bank-account-number") bankRefreshInlineValidation(id, "accountNumber");
        bankUpdateNextButton();
      });
      document.getElementById(id)?.addEventListener("change", async () => {
        bankReadFormFromDialog();
        bankSetError("");
        if (id === "bank-nick-name") bankRefreshInlineValidation(id, "nickName");
        if (id === "bank-account-number") bankRefreshInlineValidation(id, "accountNumber");
        bankUpdateNextButton();
      });
    });
    bindBankCountryPicker("bank-country-inline", async value => {
      if (!currentBankDraft || currentBankDraft.loading) return;
      bankReadFormFromDialog();
      const country = String(value || "");
      currentBankDraft.selectedCountry = country;
      currentBankDraft.form = {
        ...(currentBankDraft.form || {}),
        bankBranchIdentification1: "",
        bankBranchIdentification2: "",
        selectedBank: null,
      };
      await loadBankMetadata(bankDraftMetadataPayload({ selectedCountry: country }));
    });
    document.getElementById("bank-cnaps-help")?.addEventListener("click", openBankSearchDialog);
  }
  if (isAgreementStep) {
    document.getElementById("bank-agreement-confirm")?.addEventListener("change", event => {
      if (currentBankDraft) currentBankDraft.agreementAccepted = event.target.checked;
      bankUpdateNextButton();
    });
  }
  bankUpdateNextButton();
}

function renderBankSearchDialog() {
  const mask = ensureBankSearchDialog();
  const draft = currentBankSearchDraft || {};
  const results = Array.isArray(draft.results) ? draft.results : [];
  const selected = String(draft.selectedKey || "");
  mask.innerHTML = `<section class="bank-search-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-search-title">
    <div class="bank-search-body">
      <div class="bank-search-controls">
        <h2 id="bank-search-title">查找你的银行</h2>
        <div class="bank-search-info"><span>i</span><p>搜索返回的结果已达允许的数量上限。请细化搜索条件以查找你的银行账户。</p></div>
        <div class="bank-search-grid">
          <label><span>银行名称</span><input id="bank-search-name" value="${escapeHTML(draft.bankName || "")}"></label>
          <label><span>城市</span><input id="bank-search-city" value="${escapeHTML(draft.cityName || "")}"></label>
          <label><span>邮政编码</span><input id="bank-search-postal" value="${escapeHTML(draft.postalCode || "")}"></label>
          <button class="primary" id="bank-search-submit" type="button">${draft.loading ? "搜索中..." : "搜索"}</button>
        </div>
        <div class="bank-search-error" id="bank-search-error">${escapeHTML(draft.error || "")}</div>
      </div>
      <div class="bank-search-results">
        ${results.length ? `<div class="bank-search-table-head"><span></span><span>银行名称</span><span>地址</span><span>汇款路线号码</span></div>${results.map((row, index) => {
          const key = `${row.bankBranchIdentification1 || ""}-${row.bankBranchIdentification2 || ""}-${index}`;
          const address = [row.addressLine1, row.addressLine2, row.city, row.state, row.postalCode, row.country].filter(Boolean).join(" ");
          return `<button class="bank-search-row ${selected === key ? "selected" : ""}" type="button" data-bank-search-index="${index}" data-bank-search-key="${escapeHTML(key)}">
            <span class="bank-search-radio"></span><span><b>${escapeHTML(row.bankName || "—")}</b></span><span>${escapeHTML(address || "—")}</span><span>${escapeHTML(row.bankBranchIdentification1 || "—")}</span>
          </button>`;
        }).join("")}` : `<div class="bank-search-empty">${draft.loading ? "正在搜索..." : "暂无搜索结果"}</div>`}
      </div>
    </div>
    <div class="bank-search-foot"><button class="secondary" id="bank-search-cancel" type="button">取消</button><button class="primary" id="bank-search-apply" type="button" ${selected ? "" : "disabled"}>确认</button></div>
  </section>`;
  mask.classList.add("show");
  mask.querySelector("#bank-search-cancel")?.addEventListener("click", closeBankSearchDialog);
  ["bank-search-name", "bank-search-city", "bank-search-postal"].forEach(id => {
    mask.querySelector(`#${id}`)?.addEventListener("input", () => {
      if (!currentBankSearchDraft) return;
      currentBankSearchDraft.bankName = String(mask.querySelector("#bank-search-name")?.value || "");
      currentBankSearchDraft.cityName = String(mask.querySelector("#bank-search-city")?.value || "");
      currentBankSearchDraft.postalCode = String(mask.querySelector("#bank-search-postal")?.value || "");
      currentBankSearchDraft.error = "";
      const error = mask.querySelector("#bank-search-error");
      if (error) error.textContent = "";
    });
  });
  mask.querySelector("#bank-search-submit")?.addEventListener("click", submitBankSearch);
  mask.querySelectorAll("[data-bank-search-index]").forEach(button => {
    button.addEventListener("click", () => {
      if (!currentBankSearchDraft) return;
      currentBankSearchDraft.selectedIndex = Number(button.dataset.bankSearchIndex);
      currentBankSearchDraft.selectedKey = button.dataset.bankSearchKey || "";
      renderBankSearchDialog();
    });
  });
  mask.querySelector("#bank-search-apply")?.addEventListener("click", applyBankSearchSelection);
}

async function loadBankMetadata(payload = {}) {
  if (!currentBankDraft) return null;
  const seq = ++currentBankMetadataRequestSeq;
  currentBankDraft.loading = true;
  currentBankDraft.error = "";
  renderBankAccountDialog();
  try {
    const result = await window.appleDeveloper.appStoreBankMetadata(payload);
    if (seq !== currentBankMetadataRequestSeq || !currentBankDraft) return null;
    if (!result?.success) throw new Error(result?.error || "银行账户信息读取失败");
    currentBankDraft.metadata = result;
    currentBankDraft.selectedCurrency = result.selectedCurrency || currentBankDraft.selectedCurrency || "";
    if (!currentBankDraft.form) currentBankDraft.form = bankDefaultForm(result);
    else {
      currentBankDraft.form.accountHolderAddress = {
        ...(currentBankDraft.form.accountHolderAddress || {}),
        ...(result.accountHolderAddress || {}),
      };
      if (!currentBankDraft.form.selectedCurrency) currentBankDraft.form.selectedCurrency = currentBankDraft.selectedCurrency;
    }
    currentBankDraft.loading = false;
    currentBankDraft.error = "";
    renderBankAccountDialog();
    return result;
  } catch (error) {
    if (seq !== currentBankMetadataRequestSeq || !currentBankDraft) return null;
    currentBankDraft.loading = false;
    currentBankDraft.error = error.message || "银行账户信息读取失败";
    renderBankAccountDialog();
    return null;
  }
}

async function openBankAccountDialog() {
  const accountId = String(homeBusinessStatus?.provider?.id || homeBusinessStatus?.legalEntity?.accountId || "").trim();
  const legalEntityId = String(homeBusinessStatus?.legalEntity?.id || "").trim();
  if (!accountId || !legalEntityId) {
    alert("请先刷新并读取商务账户与法律实体信息");
    return;
  }
  currentBankDraft = {
    step: "country",
    accountId,
    legalEntityId,
    selectedCountry: "",
    selectedCurrency: "",
    metadata: null,
    form: null,
    sameLegalEntity: false,
    loading: false,
    error: "",
  };
  renderBankAccountDialog();
  const result = await loadBankMetadata({ accountId, initial: true });
  if (result && currentBankDraft) {
    currentBankDraft.form = bankDefaultForm(result);
    renderBankAccountDialog();
  }
}

async function handleBankNext() {
  if (!currentBankDraft || currentBankDraft.loading) return;
  if (currentBankDraft.step === "country") {
    if (!currentBankDraft.selectedCountry) {
      bankSetError("请选择银行所在国家或地区");
      bankUpdateNextButton();
      return;
    }
    const country = currentBankDraft.selectedCountry;
    const metadata = await loadBankMetadata(bankDraftMetadataPayload({
      selectedCountry: country,
      accountHolderAddress: { country: "USA" },
    }));
    if (!metadata || !currentBankDraft) return;
    currentBankDraft.selectedCountry = country;
    currentBankDraft.form = bankDefaultForm(metadata);
    currentBankDraft.step = "holder";
    renderBankAccountDialog();
    return;
  }
  if (currentBankDraft.step === "holder") {
    bankReadFormFromDialog();
    const error = bankHolderValidationError();
    if (error) {
      bankSetError(error);
      bankUpdateNextButton();
      return;
    }
    currentBankDraft.step = "bank";
    currentBankDraft.error = "";
    renderBankAccountDialog();
    return;
  }
  if (currentBankDraft.step === "bank") {
    bankReadFormFromDialog();
    const error = bankDetailValidationError();
    if (error) {
      bankSetError(error);
      bankUpdateNextButton();
      return;
    }
    currentBankDraft.step = "agreement";
    currentBankDraft.agreementAccepted = false;
    currentBankDraft.error = "";
    renderBankAccountDialog();
    return;
  }
  if (currentBankDraft.step === "agreement") {
    if (document.getElementById("bank-agreement-confirm")?.checked !== true) {
      bankSetError("请先确认声明内容");
      bankUpdateNextButton();
      return;
    }
    await submitBankAccountCreation();
    return;
  }
  bankReadFormFromDialog();
  if (!bankFormReady()) {
    bankSetError("请填写所有必填账户持有人信息");
    bankUpdateNextButton();
    return;
  }
  const metadata = await loadBankMetadata(bankDraftMetadataPayload());
  if (!metadata || !currentBankDraft) return;
  currentBankDraft.step = "bank";
  renderBankAccountDialog();
}

async function handleBankAddressCountryChange(event) {
  if (!currentBankDraft || currentBankDraft.loading) return;
  bankReadFormFromDialog();
  currentBankDraft.sameLegalEntity = false;
  const country = String(event.target.value || "");
  currentBankDraft.form.accountHolderAddress = {
    ...currentBankDraft.form.accountHolderAddress,
    country,
    regionText: "",
    regionSelect: "",
  };
  await loadBankMetadata(bankDraftMetadataPayload({ accountHolderAddress: currentBankDraft.form.accountHolderAddress }));
}

async function handleBankSameLegalEntityChange(event) {
  if (!currentBankDraft || currentBankDraft.loading) return;
  currentBankDraft.sameLegalEntity = event.target.checked;
  if (currentBankDraft.sameLegalEntity) {
    const address = bankLegalEntityAddress();
    currentBankDraft.form = {
      ...(currentBankDraft.form || bankDefaultForm(currentBankDraft.metadata)),
      accountHolderName: bankLegalEntityName(),
      accountHolderType: bankLegalEntityHolderType(),
      accountHolderAddress: address,
    };
    await loadBankMetadata(bankDraftMetadataPayload({
      accountHolderName: currentBankDraft.form.accountHolderName,
      accountHolderType: currentBankDraft.form.accountHolderType,
      accountHolderAddress: address,
    }));
    if (currentBankDraft) {
      currentBankDraft.sameLegalEntity = true;
      currentBankDraft.form = {
        ...(currentBankDraft.form || {}),
        accountHolderName: bankLegalEntityName(),
        accountHolderType: bankLegalEntityHolderType(),
        accountHolderAddress: {
          ...address,
          ...(currentBankDraft.metadata?.accountHolderAddress || {}),
        },
      };
      renderBankAccountDialog();
    }
    return;
  }
  currentBankDraft.form = bankDefaultForm(currentBankDraft.metadata);
  renderBankAccountDialog();
}

function openBankSearchDialog() {
  if (!currentBankDraft) return;
  bankReadFormFromDialog();
  currentBankSearchDraft = {
    bankName: "",
    cityName: "",
    postalCode: "",
    results: [],
    selectedIndex: -1,
    selectedKey: "",
    loading: false,
    error: "",
  };
  renderBankSearchDialog();
}

async function submitBankSearch() {
  if (!currentBankSearchDraft || currentBankSearchDraft.loading || !currentBankDraft) return;
  const mask = ensureBankSearchDialog();
  currentBankSearchDraft.bankName = String(mask.querySelector("#bank-search-name")?.value || "").trim();
  currentBankSearchDraft.cityName = String(mask.querySelector("#bank-search-city")?.value || "").trim();
  currentBankSearchDraft.postalCode = String(mask.querySelector("#bank-search-postal")?.value || "").trim();
  if (!currentBankSearchDraft.bankName && !currentBankSearchDraft.cityName && !currentBankSearchDraft.postalCode) {
    currentBankSearchDraft.error = "请输入银行名称、城市或邮政编码";
    renderBankSearchDialog();
    return;
  }
  currentBankSearchDraft.loading = true;
  currentBankSearchDraft.error = "";
  renderBankSearchDialog();
  try {
    const result = await window.appleDeveloper.appStoreBankSearch({
      accountId: currentBankDraft.accountId,
      bankName: currentBankSearchDraft.bankName,
      cityName: currentBankSearchDraft.cityName,
      postalCode: currentBankSearchDraft.postalCode,
      iso3CountryCode: currentBankDraft.selectedCountry,
    });
    if (!result?.success) throw new Error(result?.error || "未找到符合条件的银行");
    currentBankSearchDraft.results = (Array.isArray(result.results) ? result.results : []).slice(0, 100);
    currentBankSearchDraft.error = currentBankSearchDraft.results.length ? "" : "找不到任何与搜索条件相匹配的银行。请修改搜索条件，然后重试。";
    currentBankSearchDraft.selectedIndex = -1;
    currentBankSearchDraft.selectedKey = "";
  } catch (error) {
    currentBankSearchDraft.results = [];
    currentBankSearchDraft.error = error.message || "银行搜索失败";
  } finally {
    if (currentBankSearchDraft) {
      currentBankSearchDraft.loading = false;
      renderBankSearchDialog();
    }
  }
}

function applyBankSearchSelection() {
  if (!currentBankDraft || !currentBankSearchDraft) return;
  const row = currentBankSearchDraft.results?.[currentBankSearchDraft.selectedIndex] || null;
  if (!row) return;
  const form = currentBankDraft.form || bankDefaultForm(currentBankDraft.metadata);
  currentBankDraft.form = {
    ...form,
    bankName: row.bankName || form.bankName || "",
    nickName: form.nickName || row.bankName || "",
    bankBranchIdentification1: row.bankBranchIdentification1 || "",
    bankBranchIdentification2: row.bankBranchIdentification2 || "",
    selectedBank: row,
  };
  closeBankSearchDialog();
  bankSetError("");
  renderBankAccountDialog();
}

async function submitBankAccountCreation() {
  if (!currentBankDraft || currentBankDraft.loading) return;
  bankReadFormFromDialog();
  const holderError = bankHolderValidationError();
  const detailError = bankDetailValidationError();
  if (holderError || detailError) {
    currentBankDraft.step = holderError ? "holder" : "bank";
    bankSetError(holderError || detailError);
    renderBankAccountDialog();
    return;
  }
  const button = document.getElementById("bank-next");
  setBusy(button, true, "处理中...");
  bankSetError("");
  try {
    const form = currentBankDraft.form || {};
    const result = await window.appleDeveloper.createAppStoreBankAccount({
      accountId: currentBankDraft.accountId,
      legalEntityId: currentBankDraft.legalEntityId,
      selectedCountry: currentBankDraft.selectedCountry,
      selectedCurrency: form.selectedCurrency || currentBankDraft.selectedCurrency,
      optimisticLock: currentBankDraft.metadata?.optimisticLock || homeBusinessStatus?.rawLegalEntity?.optimisticLock || homeBusinessStatus?.legalEntity?.optimisticLock || "",
      unknownBankBranchIdentificationKey: currentBankDraft.metadata?.unknownBankBranchIdentificationKey || `PPM.banking.bankingAccount.unknownBankBranchIdentificationKey.${currentBankDraft.selectedCountry || "USA"}`,
      skipRoyaltySelect: currentBankDraft.metadata?.skipRoyaltySelect !== false,
      accountHolderName: form.accountHolderName,
      accountHolderType: form.accountHolderType,
      accountHolderAddress: form.accountHolderAddress || {},
      accountType: form.accountType,
      nickName: form.nickName || form.bankName,
      accountNumber: bankNormalizeAccountNumber(form.accountNumber),
      bankBranchIdentification1: form.bankBranchIdentification1,
      bankBranchIdentification2: form.bankBranchIdentification2,
      bank: { bankName: form.bankName, bankBranchIdentification1: form.bankBranchIdentification1, bankBranchIdentification2: form.bankBranchIdentification2 },
      clientFingerprint: generateAppleClientFingerprint(),
    });
    if (result?.requires2FA) {
      openLegalEntityMfaDialog({ ...result, kind: "bank-account" });
      return;
    }
    if (!result?.success) throw new Error(result?.error || "银行卡添加失败");
    closeBankAccountDialog();
    await loadHomeOverview({ force: true });
  } catch (error) {
    bankSetError(bankFriendlyError(error.message || "银行卡添加失败"));
  } finally {
    setBusy(button, false);
  }
}

function ensureComplianceFormDialog() {
  let mask = document.querySelector(".compliance-form-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "compliance-form-mask";
  mask.innerHTML = `<div class="compliance-form-dialog" role="dialog" aria-modal="true" aria-labelledby="compliance-form-title">
    <div class="compliance-form-head"><h2 id="compliance-form-title">添加信息</h2><button class="compliance-form-close" type="button" aria-label="关闭">&times;</button></div>
    <div class="compliance-form-body" id="compliance-form-body"></div>
    <div class="compliance-form-foot"><button class="secondary" id="compliance-form-cancel" type="button">取消</button><button class="primary" id="compliance-form-save" type="button">保存</button></div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelector(".compliance-form-close").addEventListener("click", closeComplianceFormDialog);
  mask.querySelector("#compliance-form-cancel").addEventListener("click", closeComplianceFormDialog);
  mask.addEventListener("click", event => { if (event.target === mask) closeComplianceFormDialog(); });
  return mask;
}

function closeComplianceFormDialog() {
  document.querySelector(".compliance-form-mask")?.classList.remove("show");
  currentComplianceDraft = null;
}

function complianceFormValue() {
  return String(document.querySelector("#compliance-resident-id")?.value || "").trim();
}

function renderComplianceFormDialog(errorText = "") {
  const mask = ensureComplianceFormDialog();
  const draft = currentComplianceDraft || {};
  const value = String(draft.formData?.chinaResidentId || "");
  const body = mask.querySelector("#compliance-form-body");
  body.innerHTML = `<div class="compliance-form-intro"><strong>${escapeHTML(draft.title || "合规信息")}</strong><span>请填写 Apple 要求的身份信息，保存后会同步到当前商务账户。</span></div>
    <div class="compliance-form-field"><label for="compliance-resident-id">身份证号</label><input id="compliance-resident-id" inputmode="text" autocomplete="off" maxlength="18" spellcheck="false" placeholder="请输入 18 位身份证号" value="${escapeHTML(value)}"><small>仅支持 18 位字母或数字。</small></div>
    <div class="compliance-form-error" id="compliance-form-error">${escapeHTML(errorText)}</div>`;
  const input = body.querySelector("#compliance-resident-id");
  input.addEventListener("input", () => {
    input.value = input.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);
    const error = body.querySelector("#compliance-form-error");
    if (error) error.textContent = "";
    const save = mask.querySelector("#compliance-form-save");
    if (save) save.disabled = !/^[a-zA-Z0-9]{18}$/.test(input.value.trim());
  });
  input.dispatchEvent(new Event("input"));
  mask.querySelector("#compliance-form-save").onclick = submitComplianceForm;
}

async function openComplianceFormDialog(requirement = {}) {
  if (!authenticated) { await showLogin(); return; }
  const accountId = String(homeBusinessStatus?.provider?.id || "").trim();
  const legalEntityId = String(requirement.legalEntityId || homeBusinessStatus?.legalEntity?.id || "").trim();
  const requirementId = String(requirement.requirementId || requirement.id || "").trim();
  if (!accountId || !legalEntityId || !requirementId) {
    alert("暂时没有读取到可编辑的合规信息，请先刷新首页状态。");
    return;
  }
  const mask = ensureComplianceFormDialog();
  currentComplianceDraft = {
    ...requirement,
    accountId,
    legalEntityId,
    requirementId,
    formData: { ...(requirement.formData || {}) },
  };
  mask.classList.add("show");
  mask.querySelector("#compliance-form-body").innerHTML = '<div class="loading-state">正在读取合规表单…</div>';
  mask.querySelector("#compliance-form-save").disabled = true;
  try {
    const result = await window.appleDeveloper.appStoreComplianceForm({
      accountId,
      legalEntityId,
      requirementId,
    });
    if (!result?.success) throw new Error(result?.error || "合规表单读取失败");
    currentComplianceDraft.formData = { ...(result.formData || currentComplianceDraft.formData) };
    currentComplianceDraft.constraints = result.constraints || currentComplianceDraft.constraints || {};
    renderComplianceFormDialog();
  } catch (error) {
    renderComplianceFormDialog(error.message || "合规表单读取失败");
  }
  setTimeout(() => document.querySelector("#compliance-resident-id")?.focus(), 0);
}

async function submitComplianceForm() {
  if (!currentComplianceDraft) return;
  const input = document.querySelector("#compliance-resident-id");
  const value = complianceFormValue();
  const errorBox = document.querySelector("#compliance-form-error");
  const button = el("compliance-form-save");
  if (!/^[a-zA-Z0-9]{18}$/.test(value)) {
    if (errorBox) errorBox.textContent = "请输入 18 位字母或数字组成的身份证号";
    input?.focus();
    return;
  }
  if (errorBox) errorBox.textContent = "";
  setBusy(button, true, "保存中…");
  try {
    const result = await window.appleDeveloper.saveAppStoreComplianceForm({
      accountId: currentComplianceDraft.accountId,
      legalEntityId: currentComplianceDraft.legalEntityId,
      requirementId: currentComplianceDraft.requirementId,
      formData: { chinaResidentId: value },
    });
    if (!result?.success) throw new Error(result?.error || "合规信息保存失败");
    closeComplianceFormDialog();
    await loadHomeOverview({ force: true });
  } catch (error) {
    if (errorBox) errorBox.textContent = error.message || "合规信息保存失败";
  } finally {
    if (document.querySelector(".compliance-form-mask")?.classList.contains("show")) setBusy(button, false);
  }
}

function ensureLegalEntityDialog() {
  let mask = document.querySelector(".legal-entity-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "legal-entity-mask";
  mask.innerHTML = `<div class="legal-entity-dialog">
    <div class="legal-entity-head"><h2>编辑法律实体</h2><button class="legal-entity-close" type="button">&times;</button></div>
    <div class="legal-entity-body" id="legal-entity-body"></div>
    <div class="legal-entity-foot"><button class="secondary" id="legal-entity-cancel" type="button">取消</button><button class="primary" id="legal-entity-save" type="button">保存</button></div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelector(".legal-entity-close").addEventListener("click", closeLegalEntityDialog);
  mask.querySelector("#legal-entity-cancel").addEventListener("click", closeLegalEntityDialog);
  mask.addEventListener("click", event => { if (event.target === mask) closeLegalEntityDialog(); });
  return mask;
}

function closeLegalEntityDialog() {
  document.querySelector(".legal-entity-mask")?.classList.remove("show");
  currentLegalEntityDraft = null;
}

function legalEntityMfaPhoneLabel(phone = {}) {
  const obfuscated = String(phone?.obfuscatedNumber || phone?.numberWithDialCode || "").trim();
  if (obfuscated) return obfuscated;
  const lastTwoDigits = String(phone?.lastTwoDigits || "").replace(/\D/g, "").slice(-2);
  return lastTwoDigits ? `••• •••• ••${lastTwoDigits}` : "••• •••• ••19";
}

function ensureLegalEntityMfaDialog() {
  let mask = document.querySelector(".legal-mfa-mask");
  if (mask) return mask;
  mask = document.createElement("div");
  mask.className = "legal-mfa-mask";
  mask.innerHTML = `<div class="legal-mfa-dialog" role="dialog" aria-modal="true" aria-labelledby="legal-mfa-title">
    <div class="legal-mfa-top">
      <h2 id="legal-mfa-title">Two-Factor Authentication Required</h2>
      <p class="legal-mfa-subtitle">Apple requires two-factor authentication to help ensure your identity.</p>
    </div>
    <div class="legal-mfa-body">
      <h3>双重认证</h3>
      <p class="legal-mfa-copy" id="legal-mfa-copy">输入通过短信发送至 ••• •••• ••19 的验证码。</p>
      <div class="legal-mfa-code-grid" id="legal-mfa-code-grid" aria-label="验证码输入">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-0" inputmode="numeric" maxlength="1" autocomplete="one-time-code" aria-label="第 1 位验证码" spellcheck="false">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-1" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="第 2 位验证码" spellcheck="false">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-2" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="第 3 位验证码" spellcheck="false">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-3" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="第 4 位验证码" spellcheck="false">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-4" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="第 5 位验证码" spellcheck="false">
        <input class="legal-mfa-code-cell" id="legal-mfa-code-5" inputmode="numeric" maxlength="1" autocomplete="off" aria-label="第 6 位验证码" spellcheck="false">
      </div>
      <div class="legal-mfa-links">
        <button class="legal-mfa-link" id="legal-mfa-resend" type="button">重新发送验证码</button>
        <button class="legal-mfa-link" id="legal-mfa-no-number" type="button">无法使用此号码?</button>
      </div>
      <div class="legal-mfa-status" id="legal-mfa-status" aria-live="polite"></div>
    </div>
    <div class="legal-mfa-foot">
      <button class="secondary" id="legal-mfa-cancel" type="button">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelector("#legal-mfa-cancel").addEventListener("click", closeLegalEntityMfaDialog);
  mask.querySelector("#legal-mfa-no-number").addEventListener("click", () => {
    el("legal-mfa-status").className = "legal-mfa-status";
    el("legal-mfa-status").textContent = "请使用当前短信验证码完成验证。";
  });
  mask.querySelector("#legal-mfa-resend").addEventListener("click", resendLegalEntityMfaCode);
  mask.querySelectorAll(".legal-mfa-code-cell").forEach((input, index) => {
    input.addEventListener("input", event => handleLegalEntityMfaCodeInput(event, index));
    input.addEventListener("keydown", event => handleLegalEntityMfaCodeKeydown(event, index));
    input.addEventListener("paste", event => handleLegalEntityMfaCodePaste(event, index));
    input.addEventListener("focus", () => input.select());
    input.addEventListener("click", () => input.select());
  });
  return mask;
}

function legalEntityMfaCodeInputs() {
  return Array.from(document.querySelectorAll(".legal-mfa-code-cell"));
}

function legalEntityMfaCodeValue() {
  return legalEntityMfaCodeInputs().map(input => String(input.value || "").replace(/\D/g, "").slice(0, 1)).join("");
}

function legalEntityMfaSetCode(code = "") {
  const digits = String(code || "").replace(/\D/g, "").slice(0, 6).split("");
  legalEntityMfaCodeInputs().forEach((input, index) => {
    input.value = digits[index] || "";
  });
}

function legalEntityMfaSetInvalid(invalid = false) {
  const grid = document.getElementById("legal-mfa-code-grid");
  grid?.classList.toggle("invalid", invalid);
}

function legalEntityMfaFocusIndex(index = 0) {
  const inputs = legalEntityMfaCodeInputs();
  inputs[Math.max(0, Math.min(inputs.length - 1, index))]?.focus();
}

function legalEntityMfaSetInteractiveDisabled(disabled = false) {
  legalEntityMfaCodeInputs().forEach(input => { input.disabled = disabled; });
  ["legal-mfa-resend", "legal-mfa-no-number"].forEach(id => {
    const button = el(id);
    if (button) button.disabled = disabled;
  });
}

function legalEntityMfaSetStatus(text = "", kind = "") {
  const status = el("legal-mfa-status");
  if (!status) return;
  status.className = `legal-mfa-status${kind ? ` ${kind}` : ""}`;
  status.textContent = text;
}

function legalEntityMfaFlow(state = currentLegalEntityMfa) {
  return String(state?.kind || state?.flow || "legal-entity");
}

function legalEntityMfaPhoneText(phone = {}) {
  const obfuscated = String(phone?.obfuscatedNumber || phone?.numberWithDialCode || "").trim();
  if (obfuscated) return obfuscated;
  const lastTwoDigits = String(phone?.lastTwoDigits || "").replace(/\D/g, "").slice(-2);
  return lastTwoDigits ? `••• •••• ••${lastTwoDigits}` : "••• •••• ••19";
}

function handleLegalEntityMfaCodeInput(event, index = 0) {
  if (currentLegalEntityMfaSubmitting) return;
  const input = event.currentTarget;
  const digits = String(input.value || "").replace(/\D/g, "");
  const inputs = legalEntityMfaCodeInputs();
  if (!inputs.length) return;
  legalEntityMfaSetStatus("", "");
  legalEntityMfaSetInvalid(false);
  if (!digits) {
    input.value = "";
    return;
  }
  if (digits.length > 1) {
    for (let i = index; i < inputs.length; i += 1) inputs[i].value = "";
    [...digits].forEach((digit, offset) => {
      if (index + offset < inputs.length) inputs[index + offset].value = digit;
    });
    const nextIndex = Math.min(inputs.length - 1, index + digits.length);
    if (index + digits.length < inputs.length) inputs[nextIndex].focus();
  } else {
    input.value = digits.slice(0, 1);
    if (index < inputs.length - 1) inputs[index + 1].focus();
  }
  if (legalEntityMfaCodeValue().length === 6 && !currentLegalEntityMfaSubmitting) {
    queueMicrotask(() => {
      if (legalEntityMfaCodeValue().length === 6 && !currentLegalEntityMfaSubmitting) submitLegalEntityMfaCode();
    });
  }
}

function handleLegalEntityMfaCodeKeydown(event, index = 0) {
  if (currentLegalEntityMfaSubmitting) return;
  const inputs = legalEntityMfaCodeInputs();
  if (!inputs.length) return;
  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    event.currentTarget.value = event.key;
    legalEntityMfaSetStatus("", "");
    legalEntityMfaSetInvalid(false);
    if (index < inputs.length - 1) inputs[index + 1].focus();
    if (legalEntityMfaCodeValue().length === 6) queueMicrotask(submitLegalEntityMfaCode);
    return;
  }
  if (event.key === "Backspace") {
    event.preventDefault();
    if (event.currentTarget.value) {
      event.currentTarget.value = "";
      event.currentTarget.focus();
    } else if (index > 0) {
      inputs[index - 1].value = "";
      inputs[index - 1].focus();
    }
    legalEntityMfaSetStatus("", "");
    legalEntityMfaSetInvalid(false);
    return;
  }
  if (event.key === "Delete") {
    event.preventDefault();
    event.currentTarget.value = "";
    legalEntityMfaSetStatus("", "");
    legalEntityMfaSetInvalid(false);
    return;
  }
  if (event.key === "ArrowLeft" && index > 0) {
    event.preventDefault();
    inputs[index - 1].focus();
    return;
  }
  if (event.key === "ArrowRight" && index < inputs.length - 1) {
    event.preventDefault();
    inputs[index + 1].focus();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    submitLegalEntityMfaCode();
  }
}

function handleLegalEntityMfaCodePaste(event, index = 0) {
  if (currentLegalEntityMfaSubmitting) return;
  const text = String(event.clipboardData?.getData("text") || "").replace(/\D/g, "");
  if (!text) return;
  event.preventDefault();
  const inputs = legalEntityMfaCodeInputs();
  [...text.slice(0, inputs.length - index)].forEach((digit, offset) => {
    if (index + offset < inputs.length) inputs[index + offset].value = digit;
  });
  const nextIndex = Math.min(inputs.length - 1, index + text.length);
  if (index + text.length < inputs.length) inputs[nextIndex].focus();
  if (legalEntityMfaCodeValue().length === 6 && !currentLegalEntityMfaSubmitting) {
    queueMicrotask(() => {
      if (legalEntityMfaCodeValue().length === 6 && !currentLegalEntityMfaSubmitting) submitLegalEntityMfaCode();
    });
  }
}

function renderLegalEntityMfaDialog(state = currentLegalEntityMfa) {
  const mask = ensureLegalEntityMfaDialog();
  const phone = state?.phone || {};
  el("legal-mfa-copy").textContent = `输入通过短信发送至 ${legalEntityMfaPhoneText(phone)} 的验证码。`;
  legalEntityMfaSetCode("");
  legalEntityMfaSetStatus("", "");
  currentLegalEntityMfaSubmitting = false;
  mask.classList.add("show");
  legalEntityMfaSetInvalid(false);
  setTimeout(() => legalEntityMfaFocusIndex(0), 0);
}

function openLegalEntityMfaDialog(result = {}) {
  currentLegalEntityMfa = { ...result, kind: String(result.kind || result.flow || "legal-entity") };
  renderLegalEntityMfaDialog(result);
}

function hideLegalEntityMfaDialog() {
  document.querySelector(".legal-mfa-mask")?.classList.remove("show");
  currentLegalEntityMfaSubmitting = false;
  currentLegalEntityMfa = null;
}

async function closeLegalEntityMfaDialog() {
  const state = currentLegalEntityMfa;
  hideLegalEntityMfaDialog();
  try {
    if (legalEntityMfaFlow(state) === "business-agreement") {
      await window.appleDeveloper.cancelAppStoreBusinessAgreement2FA?.();
    } else if (legalEntityMfaFlow(state) === "bank-account") {
      await window.appleDeveloper.cancelAppStoreBank2FA?.();
    } else {
      await window.appleDeveloper.cancelAppStoreLegalEntity2FA?.();
    }
  } catch {}
}

async function resendLegalEntityMfaCode() {
  const flow = legalEntityMfaFlow();
  legalEntityMfaSetStatus("", "");
  legalEntityMfaSetInvalid(false);
  legalEntityMfaSetInteractiveDisabled(true);
  try {
    const result = flow === "business-agreement"
      ? await window.appleDeveloper.resendAppStoreBusinessAgreementCode()
      : flow === "bank-account"
        ? await window.appleDeveloper.resendAppStoreBankCode()
      : await window.appleDeveloper.resendAppStoreLegalEntityCode();
    if (!result?.success) throw new Error(result?.error || "验证码发送失败");
    currentLegalEntityMfa = { ...(currentLegalEntityMfa || {}), ...result, initialSMS: false };
    el("legal-mfa-copy").textContent = `输入通过短信发送至 ${legalEntityMfaPhoneText(result.phone || currentLegalEntityMfa.phone || {})} 的验证码。`;
    legalEntityMfaSetCode("");
    legalEntityMfaSetStatus("新的验证码已发送。", "ok");
    legalEntityMfaFocusIndex(0);
  } catch (error) {
    const message = error.message || "验证码发送失败";
    legalEntityMfaSetStatus(
      flow === "business-agreement" && currentLegalEntityMfa?.phoneId
        ? `${message}；之前收到的验证码仍可继续验证`
        : message,
      "bad",
    );
  } finally {
    if (document.querySelector(".legal-mfa-mask")?.classList.contains("show")) {
      legalEntityMfaSetInteractiveDisabled(false);
    }
  }
}

async function submitLegalEntityMfaCode() {
  if (currentLegalEntityMfaSubmitting) return;
  const flow = legalEntityMfaFlow();
  const code = legalEntityMfaCodeValue();
  if (!/^\d{6}$/.test(code)) {
    legalEntityMfaSetStatus("请输入 6 位验证码", "bad");
    legalEntityMfaSetInvalid(true);
    return;
  }
  legalEntityMfaSetStatus("", "");
  legalEntityMfaSetInvalid(false);
  currentLegalEntityMfaSubmitting = true;
  legalEntityMfaSetInteractiveDisabled(true);
  legalEntityMfaSetStatus("正在验证…", "");
  try {
    const result = flow === "business-agreement"
      ? await window.appleDeveloper.verifyAppStoreBusinessAgreementCode(code)
      : flow === "bank-account"
        ? await window.appleDeveloper.verifyAppStoreBankCode(code)
      : await window.appleDeveloper.verifyAppStoreLegalEntityCode(code);
    if (!result?.success) {
      if (result?.verificationAccepted && flow === "bank-account") {
        hideLegalEntityMfaDialog();
        if (currentBankDraft) {
          currentBankDraft.error = `验证码已通过，但银行账户提交失败：${result.error || "请重试"}`;
          renderBankAccountDialog();
        }
        return;
      }
      throw new Error(result?.error || "验证码验证失败");
    }
    hideLegalEntityMfaDialog();
    if (flow === "business-agreement") {
      closePaidAppAgreementDialog();
    } else if (flow === "bank-account") {
      closeBankAccountDialog();
    } else {
      closeLegalEntityDialog();
    }
    await loadHomeOverview({ force: true });
  } catch (error) {
    const message = /incorrect|invalid|verification code|验证码/i.test(String(error.message || ""))
      ? "验证码不正确"
      : (error.message || "验证码验证失败");
    legalEntityMfaSetCode("");
    legalEntityMfaSetStatus(message, "bad");
    legalEntityMfaSetInvalid(true);
    legalEntityMfaFocusIndex(0);
  } finally {
    currentLegalEntityMfaSubmitting = false;
    if (document.querySelector(".legal-mfa-mask")?.classList.contains("show")) {
      legalEntityMfaSetInteractiveDisabled(false);
    }
  }
}

function clonePlainObject(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value || {})); }
}

function legalEntityAddressValue(raw = {}, key = "") {
  return String(raw?.legalEntityAddress?.[key] ?? raw?.address?.[key] ?? raw?.financeAddress?.[key] ?? "");
}

function legalEntityCleanPath(path = "") {
  return String(path || "").replace(/^\$\[\d+\]\.?/, "");
}

function legalEntityConstraint(path = "") {
  const constraints = currentLegalEntityDraft?.constraints || {};
  const cleanPath = legalEntityCleanPath(path);
  return Object.entries(constraints).find(([key]) => {
    const cleanKey = legalEntityCleanPath(key);
    return cleanKey === cleanPath || cleanKey.endsWith(`.${cleanPath}`);
  })?.[1] || null;
}

function legalEntityIssueForPath(path = "") {
  const issues = currentLegalEntityDraft?.validationIssues || [];
  const cleanPath = legalEntityCleanPath(path);
  return issues.find(issue => {
    const issuePath = legalEntityCleanPath(issue.path || "");
    return issuePath === cleanPath || issuePath.endsWith(`.${cleanPath}`);
  }) || null;
}

function legalEntityFormFields() {
  return [
    { path: "legalEntityName", label: "名称", value: String(currentLegalEntityDraft?.raw?.legalEntityName || currentLegalEntityDraft?.raw?.name || ""), readonly: true },
    { path: "entityType", label: "类型", value: currentLegalEntityDraft?.normalized?.isOrganization ? "公司" : "个人", readonly: true },
    { path: "legalEntityLocalName", label: "当地名称", value: String(currentLegalEntityDraft?.raw?.legalEntityLocalName || ""), readonly: true },
    { path: "legalEntityAddress.addressLine1", field: "addressLine1", label: "地址行 1", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "addressLine1") },
    { path: "legalEntityAddress.addressLine2", field: "addressLine2", label: "地址行 2", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "addressLine2") },
    { path: "legalEntityAddress.city", field: "city", label: "城市", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "city") },
    { path: "legalEntityAddress.regionText", field: "regionText", label: "州或省", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "regionText") },
    { path: "legalEntityAddress.postalCode", field: "postalCode", label: "邮政编码", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "postalCode") },
    { path: "legalEntityAddress.country", field: "country", label: "国家或地区", value: legalEntityAddressValue(currentLegalEntityDraft?.raw, "country") || legalEntityAddressValue(currentLegalEntityDraft?.raw, "iso2CountryCode") || "中国大陆", readonly: true },
  ];
}

function renderLegalEntityDialog(errorText = "") {
  const mask = ensureLegalEntityDialog();
  const body = mask.querySelector("#legal-entity-body");
  const fields = legalEntityFormFields();
  body.innerHTML = `<div class="legal-entity-grid">
    ${fields.map(field => {
      const issue = legalEntityIssueForPath(field.path);
      return `<div class="legal-entity-field ${field.path === "legalEntityLocalName" ? "wide" : ""}">
        <label>${escapeHTML(field.label)}</label>
        <input data-legal-path="${escapeHTML(field.path)}" data-legal-field="${escapeHTML(field.field || "")}" value="${escapeHTML(field.value)}" ${field.readonly ? "readonly" : ""}>
        <small class="legal-entity-error-text" data-legal-error="${escapeHTML(field.path)}">${escapeHTML(issue?.message || "")}</small>
      </div>`;
    }).join("")}
  </div><div class="legal-entity-form-error" id="legal-entity-form-error">${escapeHTML(errorText)}</div>`;
  body.querySelectorAll("input[data-legal-field]").forEach(input => {
    if (!input.dataset.legalField) return;
    input.addEventListener("input", () => {
      updateLegalEntityDraftFromForm();
      applyLegalEntityValidation();
    });
  });
  mask.querySelector("#legal-entity-save").onclick = submitLegalEntity;
  applyLegalEntityValidation();
}

function updateLegalEntityDraftFromForm() {
  if (!currentLegalEntityDraft) return;
  const mask = ensureLegalEntityDialog();
  const raw = clonePlainObject(currentLegalEntityDraft.raw || {});
  const nextAddress = { ...(raw.legalEntityAddress || raw.address || raw.financeAddress || {}) };
  mask.querySelectorAll("input[data-legal-field]").forEach(input => {
    const key = input.dataset.legalField;
    if (!key) return;
    nextAddress[key] = input.value;
  });
  raw.legalEntityAddress = { ...(raw.legalEntityAddress || {}), ...nextAddress };
  raw.address = { ...(raw.address || {}), ...nextAddress };
  raw.financeAddress = { ...(raw.financeAddress || {}), ...nextAddress };
  currentLegalEntityDraft.raw = raw;
}

function applyLegalEntityValidation() {
  if (!currentLegalEntityDraft) return [];
  updateLegalEntityDraftFromForm();
  const issues = [];
  for (const field of legalEntityFormFields()) {
    if (!field.field) continue;
    const value = String(field.value || "");
    const rule = legalEntityConstraint(field.path);
    let message = "";
    if (rule?.required === true && !value.trim()) message = "必填项不能为空";
    else if (Number(rule?.sizeMax || 0) > 0 && value.length > Number(rule.sizeMax)) message = "此值过长。";
    else if (Number(rule?.sizeMin || 0) > 0 && value.length < Number(rule.sizeMin)) message = `至少需要 ${rule.sizeMin} 个字符`;
    else if (rule?.regex && value) {
      try { if (!(new RegExp(String(rule.regex))).test(value)) message = "格式不符合 Apple 要求"; } catch {}
    }
    const node = document.querySelector(`[data-legal-error="${CSS.escape(field.path)}"]`);
    if (node) node.textContent = message;
    if (message) issues.push({ path: field.path, message });
  }
  const saveButton = el("legal-entity-save");
  if (saveButton) saveButton.disabled = issues.length > 0;
  return issues;
}

async function openLegalEntityDialog() {
  if (!authenticated) { await showLogin(); return; }
  const entity = homeBusinessStatus?.legalEntity || null;
  const accountId = String(homeBusinessStatus?.provider?.id || entity?.accountId || "").trim();
  const legalEntityId = String(entity?.id || "").trim();
  if (!accountId || !legalEntityId) {
    alert("暂时没有读取到可编辑的法律实体，请先刷新首页状态。");
    return;
  }
  const mask = ensureLegalEntityDialog();
  mask.classList.add("show");
  mask.querySelector("#legal-entity-body").innerHTML = '<div class="loading-state">正在读取法律实体校验规则…</div>';
  mask.querySelector("#legal-entity-save").disabled = true;
  currentLegalEntityDraft = {
    accountId,
    legalEntityId,
    raw: clonePlainObject(homeBusinessStatus.rawLegalEntity || entity.raw || {}),
    normalized: entity,
    constraints: homeBusinessStatus.constraints || {},
    validationIssues: homeBusinessStatus.validationIssues || [],
  };
  try {
    const result = await window.appleDeveloper.appStoreLegalEntityMetadata({ accountId, legalEntity: currentLegalEntityDraft.raw });
    if (!result?.success) throw new Error(result?.error || "法律实体校验规则读取失败");
    currentLegalEntityDraft.raw = clonePlainObject(result.rawLegalEntity || currentLegalEntityDraft.raw);
    currentLegalEntityDraft.normalized = result.legalEntity || currentLegalEntityDraft.normalized;
    currentLegalEntityDraft.constraints = result.constraints || currentLegalEntityDraft.constraints;
    currentLegalEntityDraft.validationIssues = result.validationIssues || [];
    renderLegalEntityDialog();
  } catch (error) {
    renderLegalEntityDialog(error.message || "法律实体信息读取失败");
  }
}

async function submitLegalEntity() {
  if (!currentLegalEntityDraft) return;
  const issues = applyLegalEntityValidation();
  if (issues.length) return;
  const button = el("legal-entity-save");
  const errorBox = el("legal-entity-form-error");
  if (errorBox) errorBox.textContent = "";
  setBusy(button, true, "保存中…");
  try {
    updateLegalEntityDraftFromForm();
    const result = await window.appleDeveloper.saveAppStoreLegalEntity({
      accountId: currentLegalEntityDraft.accountId,
      legalEntityId: currentLegalEntityDraft.legalEntityId,
      legalEntity: currentLegalEntityDraft.raw,
      clientFingerprint: generateAppleClientFingerprint(),
    });
    if (result?.requires2FA) {
      openLegalEntityMfaDialog(result);
      return;
    }
    if (!result?.success) {
      currentLegalEntityDraft.validationIssues = result?.validationIssues || [];
      if (currentLegalEntityDraft.validationIssues.length) {
        renderLegalEntityDialog(result.error || "法律实体信息未通过 Apple 校验");
      } else {
        throw new Error(result?.error || "法律实体保存失败");
      }
      return;
    }
    closeLegalEntityDialog();
    await loadHomeOverview({ force: true });
  } catch (error) {
    if (errorBox) errorBox.textContent = error.message || "法律实体保存失败";
  } finally { setBusy(button, false); }
}

async function ensureTeamSelection(force = false) {
  if (teamPromptInProgress) return false;
  teamPromptInProgress = true;
  lastTeamSelectionError = "";
  el("team-error").textContent = "";
  el("team-list").innerHTML = '<div class="loading-state" style="height:90px">正在读取开发者团队…</div>';
  el("team-mask").classList.add("show");
  try {
    const result = await window.appleDeveloper.teams();
    if (!result?.success) throw new Error(result?.error || "开发者团队读取失败");
    const teams = result.teams || [];
    if (!teams.length) throw new Error("当前 Apple ID 下没有读取到可用的开发者团队");
    const list = el("team-list");
    list.replaceChildren();
    teams.forEach((team, index) => {
      const label = document.createElement("label");
      label.className = "team-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "developer-team";
      input.value = team.id;
      input.checked = team.id === result.selectedTeamId || (!result.selectedTeamId && index === 0);
      input.addEventListener("change", () => { el("confirm-team").disabled = false; });
      const content = document.createElement("span");
      const name = document.createElement("strong"); name.textContent = team.name || "开发者团队";
      const id = document.createElement("small"); id.textContent = `Team ID · ${team.id}`;
      content.append(name, id); label.append(input, content); list.appendChild(label);
    });
    el("confirm-team").disabled = false;
    if (!force && result.selectedTeamId && teams.some(team => team.id === result.selectedTeamId)) {
      el("team-mask").classList.remove("show");
      return true;
    }
    return false;
  } catch (error) {
    el("team-list").replaceChildren();
    lastTeamSelectionError = error.message || "开发者团队读取失败";
    el("team-error").textContent = error.message;
    el("confirm-team").disabled = true;
    return false;
  } finally { teamPromptInProgress = false; }
}

async function loadProxies() {
  const result = await window.appleDeveloper.proxies();
  proxyRows = result?.proxies || [];
  const select = el("proxy-select");
  if (select) {
    select.replaceChildren(new Option("请选择代理 IP", ""));
    proxyRows.forEach((proxy, index) => select.add(new Option(proxy.note || proxy.name || `${proxy.host}:${proxy.port}`, String(index))));
  }
  populateIPAUploadProxyOptions();
}

function buildModulePage(key) {
  if (authenticated && initializedPages.has(key)) return;
  if (key === "one-click") return;
  if (key === "apps") {
    if (!authenticated) {
      const page = el("page-apps");
      page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">App 管理</span></div><div class="empty"><div class="empty-icon">!</div><strong>Apple ID 未登录</strong><span>请先点击右上角“登录 Apple ID”，登录后才能读取 App 数据。</span></div></div>`;
      return;
    }
    if (!el("apps-capture-ready")) renderAppsPage();
    return;
  }
  if (key === "ipa-upload") {
    if (!el("ipa-upload-form")) renderIPAUploadPage();
    return;
  }
  const item = modules[key];
  const page = document.getElementById(`page-${key}`);
  page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">${item.title}</span><button class="primary" onclick="refreshModule('${key}')">刷新</button></div><div class="empty"><div class="empty-icon">${item.icon}</div><strong>${item.empty}</strong><span>${authenticated ? "Apple 开发者接口尚未同步数据" : "登录 Apple ID 后可读取数据"}</span></div></div>`;
}

function renderAppsPage(options = {}) {
  const page = el("page-apps");
  page.innerHTML = `<div class="module" id="apps-capture-ready">
    <div class="module-bar">
      <span class="module-title">App 管理</span>
      <span class="table-meta" id="app-store-count">正在读取…</span>
      <div class="module-bar-actions">
        <button class="secondary" id="app-store-create-toggle" type="button">创建 App</button>
        <button class="primary" onclick="refreshModule('apps')">刷新</button>
      </div>
    </div>
    <div id="app-store-create-mask" class="app-store-create-mask hidden" aria-hidden="true">
      <section class="app-store-create-modal" role="dialog" aria-modal="true" aria-labelledby="app-store-create-title">
        <div class="app-store-create-head">
          <h2 id="app-store-create-title">新建 App</h2>
        </div>
        <div class="app-store-create-body">
          <div class="app-store-create-grid">
            <div class="field">
              <label>平台 <span class="app-store-help">?</span></label>
              <div class="app-store-platform-row" id="app-store-platform-row">
                <label class="app-store-platform-option"><input type="checkbox" name="app-store-platform" value="IOS"><span>iOS</span></label>
                <label class="app-store-platform-option"><input type="checkbox" name="app-store-platform" value="MAC_OS"><span>macOS</span></label>
                <label class="app-store-platform-option"><input type="checkbox" name="app-store-platform" value="TV_OS"><span>Apple tvOS</span></label>
                <label class="app-store-platform-option"><input type="checkbox" name="app-store-platform" value="VISION_OS"><span>visionOS</span></label>
              </div>
            </div>
            <div class="field">
              <label>公司名称 <span class="app-store-help">?</span></label>
              <input id="app-store-company-name" placeholder="请输入公司名" autocomplete="organization">
              <div class="app-store-bundle-hint">公司账号请填写 Apple 账户登记的公司名称</div>
            </div>
            <div class="field">
              <label>名称 <span class="app-store-help">?</span></label>
              <input id="app-store-name" maxlength="30" placeholder="例如 烧烤APP测试" autocomplete="off">
              <div class="app-store-name-count">30</div>
            </div>
            <div class="field">
              <label>主要语言 <span class="app-store-help">?</span></label>
              <div class="app-store-locale-wrap"><button id="app-store-locale-trigger" class="app-store-locale-trigger" type="button"><span>正在读取…</span><b>⌄</b></button><select id="app-store-locale" hidden></select><div id="app-store-locale-menu" class="app-store-locale-menu"></div></div>
            </div>
            <div class="field">
              <label>套装 ID <span class="app-store-help">?</span></label>
              <select id="app-store-bundle"><option value="">请选择套装 ID</option></select>
              <div class="app-store-bundle-hint">请前往 <span>证书、标识符和描述文件</span> 注册一个新的套装 ID。</div>
            </div>
            <div class="field">
              <label>SKU <span class="app-store-help">?</span></label>
              <input id="app-store-sku" maxlength="64" autocomplete="off" placeholder="例如 com.company.app">
            </div>
            <div class="field">
              <label>用户访问权限 <span class="app-store-help">?</span></label>
              <div class="app-store-access">
                <label><input type="radio" name="app-store-access" value="limited"><span>有限访问权限</span></label>
                <label><input type="radio" name="app-store-access" value="full" checked><span>完全访问权限</span></label>
              </div>
            </div>
          </div>
          <div class="app-store-create-error" id="app-store-create-error"></div>
        </div>
        <div class="app-store-create-foot">
          <button class="secondary" id="app-store-create-cancel" type="button">取消</button>
          <button class="primary" id="app-store-create-submit" type="button" disabled>创建</button>
        </div>
      </section>
    </div>
    <div id="app-store-content"><div class="loading-state">正在读取 App Store Connect App…</div></div>
  </div>`;
  const createMask = el("app-store-create-mask");
  const createToggle = el("app-store-create-toggle");
  createToggle?.addEventListener("click", showAppStoreCreateModal);
  createMask?.addEventListener("click", event => {
    if (event.target === createMask) {
      closeAppStoreCreateModal();
      return;
    }
  });
  el("app-store-create-cancel")?.addEventListener("click", () => closeAppStoreCreateModal());
  el("app-store-create-submit")?.addEventListener("click", createAppStoreApp);
  el("app-store-name")?.addEventListener("input", appStoreSyncCreateSubmitState);
  el("app-store-sku")?.addEventListener("input", appStoreSyncCreateSubmitState);
  el("app-store-locale")?.addEventListener("change", appStoreSyncCreateSubmitState);
  el("app-store-locale-trigger")?.addEventListener("click", () => el("app-store-locale-menu")?.classList.toggle("open"));
  el("app-store-bundle")?.addEventListener("change", appStoreSyncCreateSubmitState);
  const platformRow = el("app-store-platform-row");
  (platformRow?.querySelectorAll('input[name="app-store-platform"]') || []).forEach(input => {
    input.addEventListener("change", appStoreSyncCreateSubmitState);
  });
  if (options.prepare !== false) prepareAppStorePage();
}

async function prepareAppStorePage() {
  const requestId = appStoreDetailRequestSeq;
  if (!authenticated) { buildModulePage("apps"); return; }
  try {
    if (!await ensureAppStoreTermsAccepted({ prompt: true })) {
      if (requestId !== appStoreDetailRequestSeq) return;
      showAppStoreTermsRequiredState();
      return;
    }
    if (requestId !== appStoreDetailRequestSeq) return;
    await Promise.all([loadAppStoreBundleIds(), loadAppStorePrimaryLocales(), loadAppStoreApps()]);
  } catch (error) {
    if (requestId !== appStoreDetailRequestSeq) return;
    showAppStoreTermsRequiredState(error.message || "App Store Connect 服务条款状态读取失败，请稍后重试。");
  }
}

function appStoreStatusText(status) {
  const map = { DRAFT: "准备提交", AVAILABLE_FOR_SALE: "可分发", READY_FOR_SALE: "可分发", READY_FOR_DISTRIBUTION: "可分发", PREPARE_FOR_SUBMISSION: "准备提交", READY_TO_SUBMIT: "准备提交", MISSING_METADATA: "缺少元数据", DEVELOPER_REMOVED_FROM_SALE: "开发者下架", REMOVED_FROM_SALE: "已下架", REMOVED: "已下架", READY_FOR_REVIEW: "可供审核", WAITING_FOR_REVIEW: "等待审核", SUBMITTED: "已提交审核", IN_REVIEW: "审核中", REJECTED: "被拒绝", DEVELOPER_REJECTED: "开发者已拒绝", DEVELOPER_ACTION_NEEDED: "需要开发者处理", PENDING_DEVELOPER_ACTION: "等待开发者处理", PENDING_BINARY_APPROVAL: "等待构建版本审核", PENDING_DEVELOPER_RELEASE: "等待开发者发布", PENDING_CONTRACT: "等待合同", PROCESSING_CONTENT: "正在处理内容", APPROVED: "已通过审核", WAITING_FOR_EXPORT_COMPLIANCE: "等待出口合规", INVALID_BINARY: "无效构建版本", COMPLETE: "已完成审核", COMPLETED: "已完成审核", CANCELING: "正在取消", UNRESOLVED_ISSUES: "未解决的问题" };
  return map[String(status || "")] || status || "—";
}

function appStoreVersionEditable(version = {}) {
  const state = String(version.appStoreState || version.appVersionState || version.state || "").toUpperCase();
  const editableState = /DRAFT|PREPARE_FOR_SUBMISSION|READY_TO_SUBMIT|MISSING_METADATA/.test(state);
  const rejectedState = /REJECTED|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/.test(state);
  const detailRejected = Boolean(
    version.id
    && String(currentAppStoreDetail?.selectedVersion?.id || "") === String(version.id)
    && currentAppStoreDetail?.reviewWarning?.isRejected === true,
  );
  return editableState || rejectedState || detailRejected;
}

function appStoreCurrentVersionId(detail) {
  return String(detail?.selectedVersion?.id || detail?.currentVersionId || "");
}

function appStoreVersionActionLabel(version) {
  const status = appStoreVersionStatus(version);
  return status ? appStoreStatusText(status) : (appStoreVersionEditable(version) ? "准备提交" : "可分发");
}

function appStoreVersionSideLabel(version = {}) {
  return [version.versionString || "1.0", appStoreVersionActionLabel(version)].filter(Boolean).join(" ");
}

function appStoreVersionStatus(version = {}, fallback = "") {
  return version.appStoreState || version.appVersionState || version.state || fallback || "";
}

function appStoreVersionIsDistributable(version = {}, fallback = "") {
  const state = String(appStoreVersionStatus(version, fallback) || "").toUpperCase();
  return /^(AVAILABLE_FOR_SALE|READY_FOR_SALE|READY_FOR_DISTRIBUTION)$/.test(state);
}

function appStoreVersionPendingDeveloperRelease(version = {}, fallback = "") {
  return [
    appStoreVersionStatus(version, fallback),
    version.appStoreState,
    version.appVersionState,
    version.state,
    version.status,
  ].some(state => String(state || "").toUpperCase() === "PENDING_DEVELOPER_RELEASE");
}

function appStorePlatformText(platform) {
  const map = { IOS: "iOS", MAC_OS: "macOS", TV_OS: "Apple tvOS", VISION_OS: "visionOS" };
  return map[String(platform || "")] || platform || "iOS";
}

function appStoreStateClass(status) {
  const text = String(status || "");
  if (/AVAILABLE|READY_FOR_SALE|READY_FOR_DISTRIBUTION|APPROVED|COMPLETED|^COMPLETE$/.test(text)) return "ok";
  if (/REJECT|ISSUE|INVALID|FAILED/.test(text)) return "bad";
  return "warn";
}

function appStoreHistoryStatusText(status) {
  const state = String(status || "").toUpperCase();
  const map = {
    PROCESSING_FOR_DISTRIBUTION: "正在处理以供分发",
    READY_FOR_SALE: "可分发",
    READY_FOR_DISTRIBUTION: "可分发",
    AVAILABLE_FOR_SALE: "可分发",
    PENDING_DEVELOPER_RELEASE: "等待开发者发布",
    IN_REVIEW: "正在审核",
    WAITING_FOR_REVIEW: "正在等待审核",
    READY_FOR_REVIEW: "可供审核",
    PREPARE_FOR_SUBMISSION: "准备提交",
    READY_TO_SUBMIT: "准备提交",
    DRAFT: "准备提交",
  };
  return map[state] || appStoreStatusText(status);
}

function appStoreHistoryDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date).replace(/\s/g, "");
}

function appStoreSafeImageUrl(url) {
  const text = String(url || "").trim();
  return /^https:\/\/[^\s"']+$/i.test(text) ? text : "";
}

function appStoreAppIconHTML(app, extraClass = "") {
  const fromVersion = (Array.isArray(app?.versions) ? app.versions : []).find(item => item?.iconUrl)?.iconUrl || "";
  const iconUrl = appStoreSafeImageUrl(app?.iconUrl || fromVersion);
  const className = ["app-store-icon", extraClass, iconUrl ? "has-image" : ""].filter(Boolean).join(" ");
  return `<span class="${escapeHTML(className)}">${iconUrl ? `<img src="${escapeHTML(iconUrl)}" alt="">` : ""}</span>`;
}

function appStoreVersionLinesHTML(app) {
  const versions = (Array.isArray(app?.versions) ? app.versions : []).filter(item => item && (item.platform || item.versionString || item.state));
  if (!versions.length) {
    const status = app?.status || "";
    return `<div class="app-store-versions"><span class="app-store-version-line"><span class="app-store-dot ${escapeHTML(appStoreStateClass(status))}"></span>${escapeHTML(appStoreStatusText(status))}${app?.bundleId ? ` · ${escapeHTML(app.bundleId)}` : ""}</span></div>`;
  }
  return `<div class="app-store-versions">${versions.map(version => {
    const status = appStoreVersionStatus(version, app?.status || "");
    const label = [appStorePlatformText(version.platform), version.versionString, appStoreStatusText(status)].filter(Boolean).join(" ");
    return `<span class="app-store-version-line"><span class="app-store-dot ${escapeHTML(appStoreStateClass(status))}"></span>${escapeHTML(label)}</span>`;
  }).join("")}${app?.bundleId ? `<span class="app-store-bundle">${escapeHTML(app.bundleId)}</span>` : ""}</div>`;
}

function appStoreListItemHTML(item, index) {
  const versions = Array.isArray(item?.versions) ? item.versions : [];
  const version = versions[0] || {};
  const versionText = version.versionString || item.latestVersion || "—";
  const rawStatus = appStoreVersionStatus(version, item.status || "");
  const statusText = appStoreStatusText(rawStatus);
  const statusClass = appStoreStateClass(rawStatus);
  const iconUrl = appStoreSafeImageUrl(item?.iconUrl || versions.find(row => row?.iconUrl)?.iconUrl || "");
  const fallback = String(item?.name || "A").trim().slice(0, 1).toUpperCase() || "A";
  const icon = iconUrl
    ? `<img src="${escapeHTML(iconUrl)}" alt="">`
    : `<span aria-hidden="true">${escapeHTML(fallback)}</span>`;
  return `<article class="app-store-card" role="button" tabindex="0" data-index="${index}" aria-label="打开 ${escapeHTML(item.name || "未命名 App")}">
    <button class="app-store-card-more" type="button" data-app-card-more="${index}" title="更多" aria-label="更多">⋯</button>
    <div class="app-store-card-head"><span class="app-store-card-icon">${icon}</span><span class="app-store-card-title"><strong title="${escapeHTML(item.name || "未命名 App")}">${escapeHTML(item.name || "未命名 App")}</strong><small title="${escapeHTML(item.bundleId || "—")}">${escapeHTML(item.bundleId || "—")}</small></span></div>
    <dl class="app-store-card-meta"><div><dt>App ID</dt><dd title="${escapeHTML(item.id || "—")}">${escapeHTML(item.id || "—")}</dd></div><div><dt>版本</dt><dd>${escapeHTML(versionText)}</dd></div></dl>
    <div class="app-store-card-foot"><span class="app-store-card-status ${escapeHTML(statusClass)}">${escapeHTML(statusText)}</span><button class="secondary app-store-card-refresh" type="button" data-app-card-refresh="${index}">刷新</button></div>
  </article>`;
}

async function appStoreDetailBetaNoticeEnabled() {
  const result = await window.appleDeveloper.desktopConfig?.({ force: true, timeoutMs: 7000 }).catch(() => null);
  const config = result?.config || {};
  if (result?.success && (config.certificateManagerAppDetailNoticeEnabled === false || config.certificate_manager_app_detail_notice_enabled === false)) return false;
  return true;
}

function openAppStoreDetailBetaNotice(app) {
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "app-pricing-modal app-detail-beta-notice-modal";
    modal.innerHTML = `<div class="app-pricing-dialog app-detail-beta-notice-dialog" role="dialog" aria-modal="true" aria-labelledby="app-detail-beta-title">
      <div class="app-pricing-dialog-body">
        <h2 id="app-detail-beta-title">App 详情功能测试中</h2>
        <p>目前 App 管理里的 App 详情还在测试阶段，如遇到 bug，请及时向我们反馈。</p>
        <p>如果需要提交 App 审核，建议临时使用 Apple 官网 App Store Connect 进行提交。</p>
      </div>
      <div class="app-pricing-dialog-actions">
        <button class="secondary" data-open-official type="button">打开官网提交审核</button>
        <button class="primary" data-continue type="button">继续查看</button>
      </div>
    </div>`;
    appendAppStoreModal(modal);
    const finish = () => { modal.remove(); resolve(); };
    modal.querySelector("[data-continue]")?.addEventListener("click", finish);
    modal.querySelector("[data-open-official]")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      button.disabled = true;
      await window.appleDeveloper.openExternal("https://appstoreconnect.apple.com/apps").catch(error => alert(error.message || "官网打开失败"));
      button.disabled = false;
    });
    modal.addEventListener("click", event => { if (event.target === modal) finish(); });
  });
}

async function openAppStoreDetail(app) {
  if (!app) return;
  if (!appStoreDetailBetaNoticeShown && await appStoreDetailBetaNoticeEnabled()) {
    appStoreDetailBetaNoticeShown = true;
    await openAppStoreDetailBetaNotice(app);
  }
  renderAppStoreDetail(app);
}

function appStoreDetailLoadingHTML(status = "正在连接 App Store Connect…") {
  return `<section class="app-detail-loading-panel" role="status" aria-live="polite">
    <i class="loading-spinner" aria-hidden="true"></i>
    <h3>正在加载 App 详情</h3>
    <p>正在读取当前版本、截图及审核信息</p>
    <div class="app-detail-loading-bar"><span></span></div>
    <div class="app-detail-loading-status" data-loading-status>${escapeHTML(status)}</div>
  </section>`;
}

function showAppStoreDetailLoading() {
  document.getElementById("app-store-detail-loading-mask")?.remove();
  const mask = document.createElement("div");
  mask.id = "app-store-detail-loading-mask";
  mask.className = "app-detail-loading-mask";
  mask.innerHTML = '<section class="app-detail-loading-dialog" role="status" aria-live="polite"><i class="loading-spinner" aria-hidden="true"></i><h3>正在加载 App 详情</h3><p>正在读取当前版本、截图及审核信息</p><div class="app-detail-loading-bar"><span></span></div><div class="app-detail-loading-status" data-loading-status>正在连接 App Store Connect…</div></section>';
  const host = document.querySelector("#page-apps > .module") || document.querySelector(".main") || document.body;
  host.append(mask);
}

function updateAppStoreDetailLoadingStatus(message) {
  const text = String(message || "正在加载数据…");
  document.querySelectorAll("[data-loading-status]").forEach(node => {
    node.textContent = text;
  });
}

function closeAppStoreDetailLoading() {
  document.getElementById("app-store-detail-loading-mask")?.remove();
}

function bindAppStoreListEvents(content) {
  content.querySelectorAll(".app-store-card").forEach(card => {
    const open = () => openAppStoreDetail(appStoreApps[Number(card.dataset.index)]);
    card.addEventListener("click", event => {
      if (event.target.closest("[data-app-card-refresh]")) return;
      if (event.target.closest("[data-app-card-more]")) {
        openAppStoreRegionDialog(appStoreApps[Number(card.dataset.index)]);
        return;
      }
      open();
    });
    card.addEventListener("keydown", event => {
      if ((event.key === "Enter" || event.key === " ") && event.target === card) {
        event.preventDefault();
        open();
      }
    });
  });
  content.querySelectorAll("[data-app-card-refresh]").forEach(button => button.addEventListener("click", async event => {
    event.stopPropagation();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "刷新中…";
    try { await loadAppStoreApps(); }
    finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }));
}

function closeAppStoreRegionDialog() {
  document.getElementById("app-store-region-mask")?.remove();
  appStoreRegionDialogState = null;
}

function appStoreRegionFallbackURL(appId, code) {
  return `https://apps.apple.com/${String(code || "us").toLowerCase()}/app/id${encodeURIComponent(String(appId || ""))}`;
}

function appStoreRegionIconURL(app = {}) {
  const fromVersion = (Array.isArray(app?.versions) ? app.versions : []).find(item => item?.iconUrl)?.iconUrl || "";
  return appStoreSafeImageUrl(app.iconUrl || app.artworkUrl || fromVersion);
}

function sortAppStoreRegionRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({ row, index })).sort((left, right) => {
    const leftChinaMainland = String(left.row?.code || "").toUpperCase() === "CN" ? 1 : 0;
    const rightChinaMainland = String(right.row?.code || "").toUpperCase() === "CN" ? 1 : 0;
    if (leftChinaMainland !== rightChinaMainland) return rightChinaMainland - leftChinaMainland;
    const leftListed = left.row?.listed ? 1 : 0;
    const rightListed = right.row?.listed ? 1 : 0;
    if (leftListed !== rightListed) return rightListed - leftListed;
    return left.index - right.index;
  }).map(item => item.row);
}

function filterAppStoreRegionRows(rows = [], query = "") {
  const keyword = String(query || "").trim().toLowerCase();
  if (!keyword) return rows;
  return rows.filter(row => [
    row?.code,
    row?.name,
    row?.status,
    row?.listed ? "可下载 已上架 可检索 available listed" : "未上架 不可下载 unavailable unlisted",
  ].some(value => String(value || "").toLowerCase().includes(keyword)));
}

function renderAppStoreRegionDialog() {
  document.getElementById("app-store-region-mask")?.remove();
  const current = appStoreRegionDialogState;
  if (!current) return;
  const app = current.app || {};
  const allRows = sortAppStoreRegionRows(current.rows);
  const query = String(current.search || "");
  const rows = filterAppStoreRegionRows(allRows, query);
  const listedCount = allRows.filter(row => row.listed).length;
  const mask = document.createElement("div");
  mask.id = "app-store-region-mask";
  mask.className = "app-download-mask";
  mask.innerHTML = `<section class="app-download-dialog" role="dialog" aria-modal="true" aria-labelledby="app-region-title">
    <div class="app-download-head"><div><strong id="app-region-title">选择下载地区</strong><span>${escapeHTML(app.name || "App")}</span></div><button class="app-download-close" type="button" data-app-dialog-close aria-label="关闭">×</button></div>
    <div class="app-download-body">
      ${current.loading ? '<div class="app-dialog-loading">正在读取 App Store 地区信息…</div>' : current.error ? `<div class="app-dialog-error">${escapeHTML(current.error)}</div>` : allRows.length ? `<label class="app-region-search"><input type="search" data-app-region-search placeholder="搜索地区名称或代码" value="${escapeHTML(query)}"></label><div class="app-region-summary">已返回 ${allRows.length} 个 App Store 地区，其中 ${listedCount} 个地区可下载${query ? `，当前显示 ${rows.length} 个` : ""}</div>${rows.length ? `<div class="app-region-grid">${rows.map(row => `<button class="app-region-option ${row.listed ? "" : "disabled"}" type="button" data-app-region-code="${escapeHTML(row.code)}" ${row.listed ? "" : "disabled"}><span><strong>${escapeHTML(row.name || row.code)}</strong><small>${escapeHTML(row.status || "")}</small></span><b>${row.listed ? "›" : "—"}</b></button>`).join("")}</div>` : '<div class="app-dialog-empty">没有匹配的地区</div>'}` : '<div class="app-dialog-empty">接口未返回地区信息</div>'}
    </div>
    <div class="app-download-foot"><button class="secondary" type="button" data-app-dialog-close>取消</button></div>
  </section>`;
  mask.addEventListener("click", event => { if (event.target === mask) closeAppStoreRegionDialog(); });
  mask.querySelectorAll("[data-app-dialog-close]").forEach(button => button.addEventListener("click", closeAppStoreRegionDialog));
  mask.querySelector("[data-app-region-search]")?.addEventListener("input", event => {
    if (!appStoreRegionDialogState || appStoreRegionDialogState.type !== "regions") return;
    appStoreRegionDialogState.search = event.currentTarget.value;
    renderAppStoreRegionDialog();
    const input = document.querySelector("[data-app-region-search]");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
  mask.querySelectorAll("[data-app-region-code]").forEach(button => button.addEventListener("click", () => {
    const row = allRows.find(item => String(item.code) === String(button.dataset.appRegionCode));
    if (row?.listed) openAppStoreRegionQR(app, { ...row, url: row.url || appStoreRegionFallbackURL(app.id, row.code) });
  }));
  document.body.append(mask);
}

async function openAppStoreRegionDialog(app = {}) {
  if (!app?.id) return;
  appStoreRegionDialogState = { type: "regions", app, rows: [], loading: true, error: "" };
  renderAppStoreRegionDialog();
  const result = await window.appleDeveloper.appStoreRegions({ appId: app.id }).catch(error => ({ success: false, error: error.message }));
  if (appStoreRegionDialogState?.type !== "regions" || String(appStoreRegionDialogState?.app?.id) !== String(app.id)) return;
  const search = appStoreRegionDialogState.search || "";
  if (!result?.success) appStoreRegionDialogState = { type: "regions", app, rows: [], search, loading: false, error: result?.error || "地区信息读取失败" };
  else appStoreRegionDialogState = { type: "regions", app, rows: Array.isArray(result.rows) ? result.rows : [], search, loading: false, error: "" };
  renderAppStoreRegionDialog();
}

function renderAppStoreRegionQR(app = {}, row = {}, options = {}) {
  document.getElementById("app-store-region-mask")?.remove();
  const loading = options.loading === true;
  const error = String(options.error || "");
  const qrDataURL = String(options.qrDataURL || "");
  const mask = document.createElement("div");
  mask.id = "app-store-region-mask";
  mask.className = "app-download-mask";
  mask.innerHTML = `<section class="app-download-dialog app-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="app-qr-title">
    <div class="app-download-head"><div><strong id="app-qr-title">扫码打开 App</strong><span>${escapeHTML(app.name || "App")} · ${escapeHTML(row.name || row.code || "")}</span></div><button class="app-download-close" type="button" data-app-dialog-close aria-label="关闭">×</button></div>
    <div class="app-download-body app-qr-body">${loading ? '<div class="app-dialog-loading">正在生成下载二维码…</div>' : error ? `<div class="app-dialog-error">${escapeHTML(error)}</div>` : `<img class="app-qr-image" src="${escapeHTML(qrDataURL)}" alt="${escapeHTML(app.name || "App")} 下载二维码"><p class="app-qr-hint">使用手机扫码打开 App Store</p><code class="app-qr-link">${escapeHTML(row.url || "")}</code>`}</div>
    <div class="app-download-foot app-qr-actions"><button class="secondary" type="button" data-app-region-back>返回</button>${!loading && !error ? '<button class="secondary" type="button" data-app-qr-save>下载二维码</button><button class="primary" type="button" data-app-qr-copy>复制下载链接</button>' : ""}<button class="secondary" type="button" data-app-dialog-close>关闭</button></div>
  </section>`;
  mask.addEventListener("click", event => { if (event.target === mask) closeAppStoreRegionDialog(); });
  mask.querySelectorAll("[data-app-dialog-close]").forEach(button => button.addEventListener("click", closeAppStoreRegionDialog));
  mask.querySelector("[data-app-region-back]")?.addEventListener("click", () => {
    appStoreRegionDialogState = { type: "regions", app, rows: appStoreRegionDialogState?.regionRows || [], loading: false, error: "" };
    renderAppStoreRegionDialog();
  });
  mask.querySelector("[data-app-qr-save]")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "保存中…";
    const result = await window.appleDeveloper.saveAppStoreRegionQR({ url: row.url, appName: app.name, iconUrl: appStoreRegionIconURL(app), countryCode: row.code, countryName: row.name }).catch(reason => ({ success: false, error: reason.message }));
    button.disabled = false;
    button.textContent = result?.success ? "已下载" : "下载二维码";
    if (!result?.success && !result?.canceled) alert(result?.error || "二维码下载失败");
  });
  mask.querySelector("[data-app-qr-copy]")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    try {
      const result = await window.appleDeveloper.copyAppStoreRegionLink({ url: row.url });
      if (!result?.success) throw new Error(result?.error || "copy failed");
      button.textContent = "已复制";
      setTimeout(() => { if (button.isConnected) button.textContent = "复制下载链接"; }, 1500);
    } catch { alert("复制失败，请手动复制下载链接"); }
  });
  document.body.append(mask);
}

async function openAppStoreRegionQR(app = {}, row = {}) {
  if (!row.url) return;
  const regionRows = appStoreRegionDialogState?.rows || [];
  appStoreRegionDialogState = { type: "qr", app, row, regionRows };
  renderAppStoreRegionQR(app, row, { loading: true });
  const result = await window.appleDeveloper.previewAppStoreRegionQR({ url: row.url, appName: app.name, iconUrl: appStoreRegionIconURL(app) }).catch(error => ({ success: false, error: error.message }));
  if (appStoreRegionDialogState?.type !== "qr" || String(appStoreRegionDialogState?.row?.code) !== String(row.code)) return;
  appStoreRegionDialogState = { ...appStoreRegionDialogState, qrDataURL: result?.qrDataURL || "", error: result?.success ? "" : result?.error || "二维码生成失败" };
  renderAppStoreRegionQR(app, row, result?.success ? { qrDataURL: result.qrDataURL } : { error: appStoreRegionDialogState.error });
}

function appStoreInAppPurchaseGroupText(rows = []) {
  const groupOf = item => {
    const explicit = String(item.stateGroup || "").toUpperCase();
    if (explicit) return explicit;
    const status = String(item.status || item.state || "").toUpperCase();
    if (/PREPARE|READY_TO_SUBMIT|MISSING_METADATA|DRAFT/.test(status)) return "DRAFT";
    if (/WAITING_FOR_REVIEW|SUBMITTED/.test(status)) return "SUBMITTED";
    if (/IN_REVIEW/.test(status)) return "IN_REVIEW";
    if (/APPROVED|READY_FOR_SALE|AVAILABLE_FOR_SALE/.test(status)) return "APPROVED";
    if (/REJECT/.test(status)) return "REJECTED";
    if (/REMOVED/.test(status)) return "REMOVED";
    return "";
  };
  const groups = [...new Set(rows.map(groupOf).filter(Boolean))];
  if (groups.length !== 1) return "App 内购买项目";
  return ({ DRAFT: "草稿", SUBMITTED: "已提交", IN_REVIEW: "审核中", APPROVED: "已批准", REJECTED: "被拒绝", REMOVED: "已下架" })[groups[0]] || groups[0];
}

function appStoreCreateSelectedPlatforms() { return [...(el("app-store-platform-row")?.querySelectorAll('input[name="app-store-platform"]:checked') || [])].map(input => input.value); }
function appStoreCreateSelectedPlatform() { return appStoreCreateSelectedPlatforms()[0] || ""; }

function appStoreEnsureSinglePlatformSelection(target) {
  const row = el("app-store-platform-row");
  if (!row || !target) return;
  const inputs = [...row.querySelectorAll('input[name="app-store-platform"]')];
  if (target.checked) {
    inputs.forEach(input => { if (input !== target) input.checked = false; });
    return;
  }
  if (!inputs.some(input => input.checked)) target.checked = true;
}

function appStoreSyncCreateSubmitState() {
  const button = el("app-store-create-submit");
  if (!button || button.dataset.loading === "1") return;
  const platforms = appStoreCreateSelectedPlatforms();
  const name = el("app-store-name")?.value.trim() || "";
  const primaryLocale = el("app-store-locale")?.value || "";
  const bundleId = el("app-store-bundle")?.value.trim() || "";
  const sku = el("app-store-sku")?.value.trim() || "";
  const companyName = el("app-store-company-name")?.value.trim() || "";
  const companyReady = appStoreCreateIsOrganization === false || Boolean(companyName);
  button.disabled = !(platforms.length && name && primaryLocale && bundleId && sku && companyReady);
}

function appStoreResetCreateForm() {
  const platformRow = el("app-store-platform-row");
  platformRow?.querySelectorAll('input[name="app-store-platform"]').forEach(input => {
    input.checked = false;
  });
  if (el("app-store-name")) el("app-store-name").value = "";
  if (el("app-store-sku")) el("app-store-sku").value = "";
  if (el("app-store-company-name")) el("app-store-company-name").value = "";
  appStoreCreateIsOrganization = null;
  if (el("app-store-locale")) el("app-store-locale").value = "";
  if (el("app-store-bundle")) el("app-store-bundle").value = "";
  const fullAccess = document.querySelector('input[name="app-store-access"][value="full"]');
  if (fullAccess) fullAccess.checked = true;
  appStoreSyncCreateSubmitState();
  loadAppStoreCreateCompanyName();
}

async function loadAppStoreCreateCompanyName() {
  const input = el("app-store-company-name");
  if (!input) return;
  const current = input.value.trim();
  const cached = readCachedAppStoreBusinessStatus();
  const cachedEntity = cached?.legalEntity || homeBusinessStatus?.legalEntity || null;
  if (cachedEntity) {
    appStoreCreateIsOrganization = cachedEntity.isOrganization === true;
    input.value = appStoreCreateIsOrganization ? String(cachedEntity.legalEntityName || cachedEntity.name || "").trim() : "";
    const cachedField = input.closest(".field");
    if (cachedField) cachedField.hidden = appStoreCreateIsOrganization === false;
    appStoreSyncCreateSubmitState();
  } else {
    appStoreCreateIsOrganization = null;
  }
  const field = input.closest(".field");
  if (!cachedEntity) {
    input.value = "";
    if (field) field.hidden = false;
  }
  appStoreSyncCreateSubmitState();
  const result = await warmAppStoreBusinessStatus();
  const effectiveResult = result?.success ? result : cached;
  const entity = effectiveResult?.legalEntity || {};
  const hasEntity = Boolean(entity.id || entity.legalEntityName || entity.name);
  appStoreCreateIsOrganization = hasEntity ? entity.isOrganization === true : null;
  const sellerRows = Array.isArray(result?.sellerInfo?.sellerInfo) ? result.sellerInfo.sellerInfo : [];
  const seller = sellerRows.find(row => String(row?.legalEntityId || "") === String(entity.id || "")) || sellerRows[0] || {};
  if (appStoreCreateIsOrganization === false) input.value = "";
  else if (!cachedEntity && !current) input.value = String(entity.legalEntityName || entity.name || seller.name || "").trim();
  if (field) field.hidden = appStoreCreateIsOrganization === false;
  input.title = appStoreCreateIsOrganization === false
    ? "个人开发者账户无需填写公司名称"
    : input.value ? "可编辑：Apple 账户法律实体名称可作为参考" : (effectiveResult?.error || result?.error || "请填写公司名称");
  appStoreSyncCreateSubmitState();
}

let appStoreCreateKeydownHandler = null;

function showAppStoreCreateModal() {
  const mask = el("app-store-create-mask");
  if (!mask) return;
  mask.classList.remove("hidden");
  mask.setAttribute("aria-hidden", "false");
  appStoreSyncCreateSubmitState();
  loadAppStoreCreateCompanyName();
  loadAppStoreBundleIds().catch(() => {});
  if (!appStoreCreateKeydownHandler) {
    appStoreCreateKeydownHandler = event => {
      if (event.key === "Escape" && !el("app-store-create-mask")?.classList.contains("hidden")) {
        closeAppStoreCreateModal();
      }
    };
  }
  document.addEventListener("keydown", appStoreCreateKeydownHandler);
  setTimeout(() => el("app-store-name")?.focus(), 0);
}

function closeAppStoreCreateModal(options = {}) {
  const mask = el("app-store-create-mask");
  if (!mask) return;
  mask.classList.add("hidden");
  mask.setAttribute("aria-hidden", "true");
  if (appStoreCreateKeydownHandler) document.removeEventListener("keydown", appStoreCreateKeydownHandler);
  if (options.reset) appStoreResetCreateForm();
}

async function loadAppStoreBundleIds() {
  const select = el("app-store-bundle");
  if (select) select.innerHTML = '<option value="">正在读取…</option>';
  const result = await window.appleDeveloper.appStoreBundleIds();
  if (!result?.success) {
    appStoreBundleIds = [];
    if (select) select.innerHTML = `<option value="">${escapeHTML(result?.error || "读取失败")}</option>`;
    appStoreSyncCreateSubmitState();
    return;
  }
  appStoreBundleIds = result.bundleIds || [];
  if (!select) return;
  const current = String(select.value || "");
  select.innerHTML = appStoreBundleIds.length
    ? '<option value="">请选择套装 ID</option>' + appStoreBundleIds.map(item => `<option value="${escapeHTML(item.bundleId)}">${escapeHTML(`${item.name || item.bundleId} · ${item.bundleId}`)}</option>`).join("")
    : '<option value="">暂无可用套装 ID</option>';
  if (current && !appStoreBundleIds.some(item => String(item.bundleId || "") === current)) select.value = "";
  appStoreSyncCreateSubmitState();
}

async function loadAppStorePrimaryLocales() {
  const select = el("app-store-locale");
  const trigger = el("app-store-locale-trigger");
  const menu = el("app-store-locale-menu");
  if (select) select.innerHTML = '<option value="">正在读取…</option>';
  const result = await window.appleDeveloper.appStorePrimaryLocales();
  if (!result?.success) {
    appStorePrimaryLocales = [];
    if (select) select.innerHTML = `<option value="">${escapeHTML(result?.error || "读取失败")}</option>`;
    if (trigger) trigger.querySelector("span").textContent = result?.error || "读取失败";
    appStoreSyncCreateSubmitState();
    return;
  }
  appStorePrimaryLocales = Array.isArray(result.locales) ? result.locales : [];
  if (!select) return;
  select.innerHTML = appStorePrimaryLocales.length
    ? '<option value="">选取</option>' + appStorePrimaryLocales.map(item => `<option value="${escapeHTML(item.code)}">${escapeHTML(item.name || item.code)}</option>`).join("")
    : '<option value="">暂无可用语言</option>';
  if (trigger) trigger.querySelector("span").textContent = "选取";
  if (menu) menu.innerHTML = appStorePrimaryLocales.length ? appStorePrimaryLocales.map(item => `<button type="button" class="app-store-locale-option" data-locale-value="${escapeHTML(item.code)}">${escapeHTML(item.name || item.code)}</button>`).join("") : '<div class="app-store-locale-empty">暂无可用语言</div>';
  menu?.querySelectorAll("[data-locale-value]").forEach(button => button.addEventListener("click", () => {
    select.value = button.dataset.localeValue || "";
    trigger.querySelector("span").textContent = button.textContent;
    menu.classList.remove("open");
    appStoreSyncCreateSubmitState();
  }));
  appStoreSyncCreateSubmitState();
}

async function loadAppStoreApps() {
  const content = el("app-store-content");
  if (!content) return;
  const requestId = appStoreDetailRequestSeq;
  if (!authenticated) { buildModulePage("apps"); return; }
  try {
    if (!await ensureAppStoreTermsAccepted()) {
      if (requestId !== appStoreDetailRequestSeq) return;
      showAppStoreTermsRequiredState();
      return;
    }
  } catch (error) {
    if (requestId !== appStoreDetailRequestSeq) return;
    showAppStoreTermsRequiredState(error.message || "App Store Connect 服务条款状态读取失败，请稍后重试。");
    return;
  }
  if (requestId !== appStoreDetailRequestSeq) return;
  content.innerHTML = '<div class="loading-state">正在读取 App Store Connect App…</div>';
  if (!appStoreBundleIds.length) loadAppStoreBundleIds().catch(() => {});
  const result = await window.appleDeveloper.appStoreApps();
  // A request started before logout must never paint its old account data
  // back into the logged-out page after the response arrives.
  if (!authenticated) { buildModulePage("apps"); return; }
  if (requestId !== appStoreDetailRequestSeq) return;
  if (!result?.success) {
    if (result?.code === "APP_STORE_CONNECT_LOGIN_REQUIRED" || Number(result?.status) === 401 || /会话.*(过期|失效)|重新认证|重新登录/.test(String(result?.error || ""))) {
      showAppStoreAccessErrorState(result?.error);
      return;
    }
    content.innerHTML = `<div class="empty"><div class="empty-icon">▤</div><strong>读取失败</strong><span>${escapeHTML(result?.error || "App 列表读取失败")}</span></div>`;
    el("app-store-count").textContent = "读取失败";
    return;
  }
  const rows = result.apps || [];
  appStoreApps = rows;
  el("app-store-count").textContent = `共 ${Number(result.total || rows.length)} 个`;
  content.innerHTML = rows.length ? `<div class="app-store-card-grid">${rows.map(appStoreListItemHTML).join("")}</div>` : '<div class="empty"><div class="empty-icon">▤</div><strong>暂无 App</strong><span>点击“创建 App”添加 App Store Connect 记录。</span></div>';
  bindAppStoreListEvents(content);
}

function renderAppStoreDetail(app) {
  if (!app) return;
  const content = el("app-store-content");
  if (!content) return;
  currentAppStoreApp = app;
  currentAppStoreDetail = null;
  currentInAppPurchases = null;
  currentInAppPurchaseDetail = null;
  currentReviewSubmissionDetail = null;
  currentReviewSubmissionLoadingId = "";
  el("app-store-count").textContent = "App 详情";
  content.innerHTML = appStoreDetailLoadingHTML();
  showAppStoreDetailLoading();
  loadAppStoreDetail(app, "release", "", { initial: true });
}

function renderAppStoreListFromCache() {
  ++appStoreDetailRequestSeq;
  closeAppStoreDetailLoading();
  const content = el("app-store-content");
  if (!content) return;
  el("app-store-count").textContent = `共 ${appStoreApps.length} 个`;
  const rows = appStoreApps;
  content.innerHTML = rows.length ? `<div class="app-store-card-grid">${rows.map(appStoreListItemHTML).join("")}</div>` : "";
  bindAppStoreListEvents(content);
}

function appStoreDetailShell(app, detail, pane = "release") {
  const displayApp = { ...(app || {}), ...(detail?.app || {}) };
  if (pane === "testflight") return window.MayouTestFlight.shell(displayApp, appStoreAppIconHTML(displayApp, "app-detail-icon"));
  const version = detail?.selectedVersion || displayApp?.versions?.[0] || {};
  const platform = appStorePlatformText(version.platform || "IOS");
  const versionString = version.versionString || "1.0";
  const loading = !detail || detail.loading;
  const rawState = loading ? "" : appStoreVersionStatus(version, displayApp.status);
  const state = loading ? "加载中" : appStoreStatusText(rawState);
  const stateClass = loading ? "loading" : appStoreStateClass(rawState);
  const selectedVersionId = appStoreCurrentVersionId(detail);
  const versions = detail?.versions?.length ? detail.versions : (displayApp?.versions || []);
  const platformGroups = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"].map(platformId => {
    const rows = versions.filter(item => String(item.platform || "").toUpperCase() === platformId);
    if (!rows.length && platformId !== "IOS" && platformId !== "MAC_OS") return "";
    const title = `${appStorePlatformText(platformId)} App`;
    const canAddVersion = !rows.length || rows.every(item => appStoreVersionIsDistributable(item, displayApp.status));
    const addButton = !loading && canAddVersion ? `<button type="button" class="app-side-add-version" data-app-new-version="${escapeHTML(platformId)}" title="添加新版本">+</button>` : "";
    const versionButtons = rows.map(item => {
      const itemState = appStoreVersionStatus(item);
      return `<button class="app-side-version ${String(item.id || "") === selectedVersionId ? "active" : ""}" data-app-version-id="${escapeHTML(item.id || "")}" type="button"><i class="${escapeHTML(appStoreStateClass(itemState))}"></i><span>${escapeHTML(appStoreVersionSideLabel(item))}</span></button>`;
    }).join("");
    return `<div class="app-side-version-head"><strong>${escapeHTML(title)}</strong>${addButton}</div>${versionButtons || '<span class="app-side-empty">暂无版本</span>'}`;
  }).filter(Boolean).join("");
  return `<div class="app-detail" data-pane="${escapeHTML(pane)}" data-app-id="${escapeHTML(displayApp.id || "")}">
    <div class="app-detail-sticky">
      <div class="app-detail-tabs"><div class="app-detail-identity">${appStoreAppIconHTML(displayApp, "app-detail-icon")}<div class="app-detail-title"><h2>${escapeHTML(displayApp.name || "未命名 App")}</h2><span>${escapeHTML(displayApp.bundleId || "—")}</span></div></div><button class="active" type="button">分发</button><button id="app-tab-testflight" type="button">TestFlight</button><button class="app-switch-button" id="app-switch-button" type="button">切换 App</button></div>
    </div>
    <div class="app-detail-body">
      <aside class="app-detail-side">${platformGroups}<button class="app-side-add-platform" data-app-coming-soon type="button">添加平台</button><hr><strong>综合</strong><button class="${pane === "info" ? "active" : ""}" data-app-pane="info" type="button">App 信息</button><button class="${pane === "review" ? "active" : ""}" data-app-pane="review" type="button">App 审核</button><button class="${pane === "history" ? "active" : ""}" data-app-pane="history" type="button">历史记录</button><hr><strong>App Store</strong><button type="button" data-app-coming-soon>信任和安全性</button><button class="${pane === "privacy" ? "active" : ""}" data-app-pane="privacy" type="button">App 隐私</button><hr><strong>营利</strong><button class="${pane === "pricing" ? "active" : ""}" data-app-pane="pricing" type="button">价格与销售范围</button><button class="${pane === "iap" ? "active" : ""}" data-app-pane="iap" type="button">App 内购买项目</button></aside>
      <main class="app-detail-main" id="app-detail-main">${renderAppStorePane(displayApp, detail, pane)}</main>
    </div>${appStoreReviewDraftCount > 0 ? `<button class="app-review-draft-float" id="app-review-draft-float" type="button">草稿提交 (${appStoreReviewDraftCount}) <b>›</b></button>` : ""}
  </div>`;
}

function bindAppStoreDetailEvents(app) {
  currentAppStoreApp = app;
  el("app-tab-testflight")?.addEventListener("click", () => requestAppStorePane(app, "testflight"));
  const testFlightRoot = document.querySelector(".tf-page");
  if (testFlightRoot) {
    window.MayouTestFlight.mount({
      root: testFlightRoot, app: { ...app, ...currentAppStoreDetail?.app },
      versions: currentAppStoreDetail?.versions || app.versions || [],
      platform: currentAppStoreDetail?.selectedVersion?.platform || "IOS",
      api: payload => window.appleDeveloper.testFlight(payload),
      contextToken: currentAppStoreDetail?.testFlightContextToken || "",
      onDistribution: () => currentAppStoreDetail?.loadedPanes?.includes("release") || !currentAppStoreDetail?.partial
        ? switchAppStorePane(currentAppStoreApp, "release") : loadAppStoreDetail(currentAppStoreApp, "release"),
      onSwitch: () => currentAppStoreDetail?.appsListPartial ? loadAppStoreApps() : renderAppStoreListFromCache(),
      openExternal: url => window.appleDeveloper.openExternal(url),
    });
    return;
  }
  el("app-switch-button")?.addEventListener("click", renderAppStoreListFromCache);
  el("app-review-draft-float")?.addEventListener("click", () => openInAppPurchaseReviewDraftPanel());
  el("app-version-review-draft-link")?.addEventListener("click", () => {
    const draft = appStoreFindVersionReviewDraft(currentAppStoreDetail?.selectedVersion || {});
    if (draft) openAppStoreReviewDraftSubmissionPanel(draft);
    else openInAppPurchaseReviewDraftPanel();
  });
  document.querySelectorAll("[data-app-pane]").forEach(button => button.addEventListener("click", () => requestAppStorePane(app, button.dataset.appPane)));
  document.querySelectorAll("[data-app-coming-soon]").forEach(button => button.addEventListener("click", () => showAppStoreNotice("正在开发，敬请期待。")));
  bindAppStoreHelpButtons(document);
  document.removeEventListener("click", closeAppStoreHelpPopovers, true);
  document.addEventListener("click", closeAppStoreHelpPopovers, true);
  document.querySelectorAll("[data-app-version-id]").forEach(button => button.addEventListener("click", () => {
    currentReviewSubmissionDetail = null;
    currentReviewSubmissionLoadingId = "";
    renderAppStoreDetailLoadingVersion(app, button.dataset.appVersionId || "");
    loadAppStoreDetail(app, "release", button.dataset.appVersionId || "");
  }));
  document.querySelectorAll("[data-app-new-version]").forEach(button => button.addEventListener("click", () => openAppStoreNewVersionModal(button.dataset.appNewVersion || "IOS")));
  document.querySelectorAll("[data-app-field]").forEach(field => field.addEventListener("input", event => {
    updateAppStoreFieldCounter(event.currentTarget);
    markAppStoreDetailDirty();
  }));
  document.querySelectorAll("[data-app-field]").forEach(field => field.addEventListener("change", markAppStoreDetailDirty));
  document.querySelectorAll("[data-app-field]").forEach(updateAppStoreFieldCounter);
  document.querySelectorAll('input[name="app-release-type"]').forEach(field => field.addEventListener("change", () => {
    const dateInput = document.querySelector('[data-app-field="version.earliestReleaseDate"]');
    const dateTrigger = document.querySelector("[data-app-release-date-trigger]");
    if (!dateInput) return;
    const scheduled = field.value === "SCHEDULED";
    dateInput.disabled = !scheduled;
    if (dateTrigger) dateTrigger.disabled = !scheduled;
    if (field.value === "SCHEDULED" && !dateInput.value) {
      dateInput.value = appStoreDateTimeLocalValue(appStoreDefaultScheduledDate().toISOString());
    }
    appStoreRefreshReleaseDateDisplay();
  }));
  document.querySelectorAll("[data-app-media-device]").forEach(button => button.addEventListener("click", () => {
    appStoreMediaDevice = button.dataset.appMediaDevice || "iphone";
    switchAppStorePane(app, "release");
  }));
  document.querySelector(".app-locale-select")?.addEventListener("change", event => {
    activeAppStoreLocaleId = event.target.value || "";
    switchAppStorePane(app, "release");
  });
  document.querySelector(".app-privacy-locale-select")?.addEventListener("change", event => {
    activeAppStoreLocaleId = event.target.value || "";
    switchAppStorePane(app, "privacy");
  });
  document.querySelectorAll("[data-app-media-delete]").forEach(button => button.addEventListener("click", () => deleteAppStoreMediaItem(button.dataset.appMediaKind, button.dataset.appMediaDelete)));
  el("app-media-delete-all")?.addEventListener("click", deleteAllVisibleAppStoreMedia);
  el("app-media-select-file")?.addEventListener("click", uploadVisibleAppStoreScreenshot);
  bindAppStoreReviewAttachments();
  el("app-release-date-trigger")?.addEventListener("click", openAppStoreReleaseDatePicker);
  el("app-build-add")?.addEventListener("click", openAppStoreBuildModal);
  el("app-build-add-empty")?.addEventListener("click", openAppStoreBuildModal);
  document.querySelector("[data-app-build-upload-tools]")?.addEventListener("click", openAppStoreBuildUploadTools);
  document.querySelector("[data-app-build-remove]")?.addEventListener("click", openAppStoreBuildRemoveModal);
  document.querySelector("[data-app-build-encryption]")?.addEventListener("click", openAppStoreBuildEncryptionModal);
  el("app-detail-save")?.addEventListener("click", saveAppStoreDetail);
  document.querySelector(".app-info-save")?.addEventListener("click", saveAppStoreDetail);
  el("app-detail-submit")?.addEventListener("click", event => {
    if (appStoreReviewSubmitDraftCandidates().length) return openAppStoreSubmitMenu(event);
    submitAppStoreReview();
  });
  el("app-detail-release")?.addEventListener("click", openAppStoreVersionReleaseModal);
  el("app-detail-cancel-release")?.addEventListener("click", openAppStoreVersionCancelReleaseModal);
  el("app-detail-submit-menu")?.addEventListener("click", openAppStoreSubmitMenu);
  document.querySelectorAll("[data-review-submit-draft]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    closeAppStoreSubmitMenu();
    submitAppStoreReview({ submissionId: button.dataset.reviewSubmitDraft || "" });
  }));
  document.querySelector("[data-review-submit-new]")?.addEventListener("click", event => {
    event.stopPropagation();
    closeAppStoreSubmitMenu();
    submitAppStoreReview({ forceNewSubmission: true });
  });
  document.querySelectorAll("[data-review-submission-update]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    updateAppStoreReviewSubmission(button);
  }));
  document.querySelectorAll("[data-review-submission-resubmit]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    resubmitAppStoreReviewSubmission(button);
  }));
  el("app-review-detail-back")?.addEventListener("click", () => {
    currentReviewSubmissionDetail = null;
    currentReviewSubmissionLoadingId = "";
    switchAppStorePane(currentAppStoreApp || app, "review");
  });
  el("app-review-reply-link")?.addEventListener("click", openAppStoreReviewReplyModal);
  document.querySelector("[data-review-draft-edit]")?.addEventListener("click", openAppStoreReviewReplyModal);
  document.querySelector("[data-review-draft-delete]")?.addEventListener("click", openAppStoreReviewDraftDeleteModal);
  document.querySelectorAll("[data-review-submission-id]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.reviewSubmissionUpdate === "1" || button.dataset.reviewSubmissionResubmit === "1") return;
    openAppStoreReviewSubmission(button.dataset.reviewSubmissionId || "");
  }));
  document.querySelectorAll("[data-app-history-group]").forEach(button => button.addEventListener("click", () => {
    const group = button.closest(".app-history-group");
    const open = !group?.classList.contains("open");
    group?.classList.toggle("open", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }));
  document.querySelectorAll("[data-app-history-detail]").forEach(button => button.addEventListener("click", () => {
    const detail = document.getElementById(button.dataset.appHistoryDetail || "");
    const open = !detail?.classList.contains("open");
    detail?.classList.toggle("open", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }));
  document.querySelectorAll("[data-app-info-modal]").forEach(button => button.addEventListener("click", () => openAppInfoModal(button.dataset.appInfoModal)));
  document.removeEventListener("click", openAppStoreSystemExternalLink, true);
  document.addEventListener("click", openAppStoreSystemExternalLink, true);
  el("app-pricing-add")?.addEventListener("click", openAppStorePricingModal);
  el("app-pricing-change")?.addEventListener("click", confirmAppStorePricingEdit);
  el("app-pricing-edit")?.addEventListener("click", confirmAppStorePricingEdit);
  document.querySelectorAll("[data-app-current-prices]").forEach(button => button.addEventListener("click", openAppStoreCurrentPricesModal));
  el("app-pricing-download")?.addEventListener("click", downloadAppStoreCurrentPrices);
  el("app-availability-manage")?.addEventListener("click", openAppStoreAvailabilityModal);
  el("app-preorder-setup")?.addEventListener("click", openAppStorePreOrderModal);
  bindAppStorePricingSettingsEvents();
  document.querySelectorAll("[data-iap-current-prices]").forEach(button => button.addEventListener("click", openAppStoreInAppPurchaseCurrentPriceModal));
  document.querySelectorAll("[data-iap-create], #app-iap-create").forEach(button => button.addEventListener("click", openAppStoreInAppPurchaseModal));
  el("app-iap-back")?.addEventListener("click", () => {
    currentInAppPurchaseDetail = null;
    switchAppStorePane(currentAppStoreApp, "iap");
    window.appleDeveloper.appStoreInAppPurchases(currentAppStoreApp.id).then(result => {
      if (!result?.success || currentInAppPurchaseDetail) return;
      currentInAppPurchases = result.purchases || [];
      switchAppStorePane(currentAppStoreApp, "iap");
    });
  });
  document.querySelectorAll("[data-iap-open]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); openAppStoreInAppPurchaseDetail(button.dataset.iapOpen); }));
  el("app-iap-edit")?.addEventListener("click", () => { inAppPurchaseListEditing = true; selectedInAppPurchaseIds.clear(); switchAppStorePane(currentAppStoreApp, "iap"); });
  el("app-iap-edit-cancel")?.addEventListener("click", () => { inAppPurchaseListEditing = false; selectedInAppPurchaseIds.clear(); switchAppStorePane(currentAppStoreApp, "iap"); });
  el("app-iap-search-toggle")?.addEventListener("click", () => { const input = el("app-iap-search-input"); if (!input) return; input.hidden = false; input.focus(); });
  el("app-iap-search-input")?.addEventListener("input", event => { inAppPurchaseListSearch = event.currentTarget.value; switchAppStorePane(currentAppStoreApp, "iap"); el("app-iap-search-input")?.focus(); });
  document.querySelectorAll("[data-iap-select]").forEach(input => {
    const item = (currentInAppPurchases || []).find(row => row.id === input.dataset.iapSelect);
    input.disabled = !isInAppPurchaseSubmittable(item);
    if (input.disabled) {
      input.checked = false;
      input.title = "只有准备提交的项目可以勾选";
      selectedInAppPurchaseIds.delete(input.dataset.iapSelect);
    }
    input.addEventListener("change", () => {
      if (input.checked) selectedInAppPurchaseIds.add(input.dataset.iapSelect); else selectedInAppPurchaseIds.delete(input.dataset.iapSelect);
      switchAppStorePane(currentAppStoreApp, "iap");
    });
  });
  el("app-iap-select-all")?.addEventListener("change", event => {
    selectedInAppPurchaseIds.clear();
    if (event.currentTarget.checked) (currentInAppPurchases || []).filter(isInAppPurchaseSubmittable).forEach(item => selectedInAppPurchaseIds.add(item.id));
    switchAppStorePane(currentAppStoreApp, "iap");
  });
  el("app-iap-add-review")?.addEventListener("click", addSelectedInAppPurchasesToReview);
  el("app-iap-availability")?.addEventListener("click", openAppStoreInAppPurchaseAvailabilityModal);
  el("app-iap-pricing")?.addEventListener("click", openAppStoreInAppPurchasePricingModal);
  el("app-iap-pricing-edit")?.addEventListener("click", openAppStoreInAppPurchasePricingEditConfirm);
  el("app-iap-pricing-current")?.addEventListener("click", openAppStoreInAppPurchasePricingModal);
  document.querySelectorAll("[data-iap-schedule-toggle]").forEach(button => button.addEventListener("click", () => {
    const body = button.closest(".app-iap-schedule-card")?.querySelector(".app-iap-schedule-body");
    if (!body) return;
    const expanded = button.getAttribute("aria-expanded") !== "false";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    body.hidden = expanded;
  }));
  el("app-iap-takedown")?.addEventListener("change", async () => {
    if (!confirm("确定要将此 App 内购买项目从所有国家或地区下架吗？")) { switchAppStorePane(currentAppStoreApp, "iap"); return; }
    const result = await window.appleDeveloper.saveAppStoreInAppPurchaseAvailability({ purchaseId: currentInAppPurchaseDetail.id, territoryIds: [], availableInNewTerritories: false });
    if (!result?.success) return showAppStoreError(result?.error || "下架失败", "", "销售范围保存失败");
    currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.availability }; switchAppStorePane(currentAppStoreApp, "iap");
  });
  document.querySelector(".app-iap-sale-line input")?.addEventListener("change", openAppStoreInAppPurchaseAvailabilityModal);
  el("app-iap-localization-add")?.addEventListener("click", () => openAppStoreInAppPurchaseLocalizationModal());
  el("app-iap-localization-add-empty")?.addEventListener("click", () => openAppStoreInAppPurchaseLocalizationModal());
  document.querySelectorAll("[data-iap-localization]").forEach(button => button.addEventListener("click", () => openAppStoreInAppPurchaseLocalizationModal(button.dataset.iapLocalization)));
  el("app-iap-review-edit")?.addEventListener("click", openAppStoreInAppPurchaseReviewModal);
  el("app-iap-review-note")?.addEventListener("input", event => {
    const counter = event.currentTarget.parentElement.querySelector("small");
    if (counter) counter.textContent = String(4000 - event.currentTarget.value.length);
    updateAppStoreInAppPurchaseSaveState();
  });
  el("app-iap-name")?.addEventListener("input", event => {
    const counter = event.currentTarget.parentElement.querySelector("small");
    if (counter) counter.textContent = String(64 - event.currentTarget.value.length);
    updateAppStoreInAppPurchaseSaveState();
  });
  el("app-iap-save")?.addEventListener("click", async event => {
    const note = el("app-iap-review-note")?.value || "";
    const name = el("app-iap-name")?.value.trim() || "";
    setBusy(event.currentTarget, true, "保存中…");
    const result = await window.appleDeveloper.saveAppStoreInAppPurchase({ appId: currentAppStoreApp?.id || "", purchaseId: currentInAppPurchaseDetail.id, name, reviewNote: note });
    if (!result?.success) showAppStoreError(result?.error || "审核备注保存失败", "", "审核信息保存失败");
    else { currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.detail }; switchAppStorePane(currentAppStoreApp, "iap"); }
  });
  el("app-iap-add-review-detail")?.addEventListener("click", addCurrentInAppPurchaseToReview);
  el("app-iap-remove-review")?.addEventListener("click", openRemoveInAppPurchaseFromReviewModal);
  el("app-iap-review-upload")?.addEventListener("click", uploadAppStoreInAppPurchaseReviewScreenshot);
  const reviewImage = document.querySelector("#app-iap-review-upload img");
  if (reviewImage) {
    const showReviewImageError = () => {
      const upload = el("app-iap-review-upload");
      if (!upload || upload.querySelector(".app-iap-review-image-error")) return;
      upload.insertAdjacentHTML("afterbegin", '<b class="app-iap-review-image-error">截图读取失败，请刷新详情后重试</b>');
    };
    reviewImage.addEventListener("error", showReviewImageError);
    if (reviewImage.complete && !reviewImage.naturalWidth) showReviewImageError();
  }
  const deleteInAppPurchaseButton = el("app-iap-delete");
  if (/^(READY_FOR_REVIEW|WAITING_FOR_REVIEW|IN_REVIEW)$/.test(String(currentInAppPurchaseDetail?.state || "").toUpperCase())) {
    deleteInAppPurchaseButton?.closest(".app-iap-delete-section")?.remove();
  } else {
    deleteInAppPurchaseButton?.addEventListener("click", openAppStoreInAppPurchaseDeleteModal);
  }
  el("app-privacy-publish")?.addEventListener("click", publishAppStorePrivacy);
  document.querySelector("[data-privacy-edit-policy]")?.addEventListener("click", openAppStorePrivacyPolicyModal);
  bindAppStorePrivacyButtons();
  document.querySelectorAll("[data-privacy-category]").forEach(input => input.addEventListener("change", onPrivacyCategoryChange));
  document.querySelectorAll("[data-privacy-purpose]").forEach(input => input.addEventListener("change", onPrivacyPurposeChange));
  document.querySelectorAll("[data-privacy-protection]").forEach(input => input.addEventListener("change", onPrivacyProtectionChange));
}

async function uploadAppStoreInAppPurchaseReviewScreenshot() {
  const item = currentInAppPurchaseDetail || {};
  const button = el("app-iap-review-upload");
  const errorBox = el("app-iap-review-error");
  if (errorBox) { errorBox.textContent = ""; errorBox.hidden = true; }
  setBusy(button, true, "上传中…");
  const result = await window.appleDeveloper.uploadAppStoreInAppPurchaseReviewScreenshot({ purchaseId: item.id, versionId: item.versionId, reviewScreenshotId: item.reviewScreenshotId });
  if (result.canceled) { setBusy(button, false); return; }
  if (!result?.success) {
    setBusy(button, false);
    if (errorBox) { errorBox.textContent = `上传失败：${result?.error || "审核截图上传失败"}`; errorBox.hidden = false; return; }
    return showAppStoreError(result?.error || "审核截图上传失败", "", "上传失败");
  }
  currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.detail };
  switchAppStorePane(currentAppStoreApp, "iap");
}

function updateAppStoreInAppPurchaseSaveState() {
  const save = el("app-iap-save");
  if (!save || !currentInAppPurchaseDetail) return;
  const nameChanged = (el("app-iap-name")?.value.trim() || "") !== String(currentInAppPurchaseDetail.name || "");
  const noteChanged = (el("app-iap-review-note")?.value || "") !== String(currentInAppPurchaseDetail.reviewNote || "");
  const dirty = nameChanged || noteChanged;
  save.disabled = !dirty;
  const reviewButton = el("app-iap-add-review-detail");
  if (reviewButton && !reviewButton.classList.contains("app-iap-added-review")) {
    reviewButton.disabled = dirty || !currentInAppPurchaseDetail.versionId;
    reviewButton.title = dirty ? "请先保存修改后再添加以供审核" : "";
  }
}

async function addCurrentInAppPurchaseToReview() {
  const item = currentInAppPurchaseDetail || {};
  const button = el("app-iap-add-review-detail");
  if (!item.id || !item.versionId || !currentAppStoreApp?.id) return;
  setBusy(button, true, "正在添加…");
  const result = await window.appleDeveloper.addAppStoreInAppPurchaseToReview({ appId: currentAppStoreApp.id, purchaseId: item.id, versionId: item.versionId });
  if (!result?.success) { setBusy(button, false); return showAppStoreError(result?.error || "添加以供审核失败", "", "无法添加以供审核"); }
  currentInAppPurchaseDetail = {
    ...item,
    reviewDraft: result.reviewDraft,
    reviewItemId: result.reviewDraft?.itemId || "",
    state: result.reviewDraft?.versionState || result.reviewDraft?.submissionState || item.state,
    status: result.reviewDraft?.versionState || result.reviewDraft?.submissionState || item.status || item.state,
  };
  await refreshAppStoreAfterInAppPurchaseReviewChange(result.reviewDraft?.submissionId, [currentInAppPurchaseDetail]);
}

async function addSelectedInAppPurchasesToReview() {
  const button = el("app-iap-add-review");
  const selected = (currentInAppPurchases || []).filter(item => selectedInAppPurchaseIds.has(item.id));
  if (!selected.length || !currentAppStoreApp?.id) return;
  setBusy(button, true, "正在添加…");
  const detailResults = await Promise.all(selected.map(item =>
    window.appleDeveloper.appStoreInAppPurchaseDetail({ purchaseId: item.id, appId: currentAppStoreApp.id })
  ));
  const invalidIndex = detailResults.findIndex(result => !result?.success || !result.detail?.versionId);
  if (invalidIndex >= 0) {
    setBusy(button, false);
    const failedItem = selected[invalidIndex] || {};
    return showAppStoreError(detailResults[invalidIndex]?.error || `无法读取“${failedItem.name || "未命名项目"}”的内购版本`, "", "添加以供审核失败");
  }
  const added = [];
  let sharedSubmissionId = "";
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const detailResult = detailResults[index];
    const result = await window.appleDeveloper.addAppStoreInAppPurchaseToReview({
      appId: currentAppStoreApp.id,
      purchaseId: item.id,
      versionId: detailResult.detail.versionId,
      submissionId: sharedSubmissionId,
      itemCountHint: added.length,
    });
    if (!result?.success) { setBusy(button, false); return showAppStoreError(result?.error || "添加以供审核失败", "", "无法添加以供审核"); }
    sharedSubmissionId ||= String(result.reviewDraft?.submissionId || "");
    added.push({
      ...detailResult.detail,
      reviewDraft: result.reviewDraft,
      reviewItemId: result.reviewDraft?.itemId || "",
      state: result.reviewDraft?.versionState || result.reviewDraft?.submissionState || detailResult.detail.state,
      status: result.reviewDraft?.versionState || result.reviewDraft?.submissionState || detailResult.detail.status || detailResult.detail.state,
    });
  }
  inAppPurchaseListEditing = false;
  selectedInAppPurchaseIds.clear();
  await refreshAppStoreAfterInAppPurchaseReviewChange(sharedSubmissionId, added);
}

async function refreshAppStoreAfterInAppPurchaseReviewChange(submissionId = "", fallbackItems = []) {
  const app = currentAppStoreApp;
  if (!app?.id) return;
  const versionId = appStoreCurrentVersionId(currentAppStoreDetail);
  currentInAppPurchases = null;
  clearAppStoreDetailCache(app.id, versionId);
  const result = await fetchAppStoreDetail(app, versionId, true, { mode: "full" })
    .catch(error => ({ success: false, error: error.message }));
  let submission = null;
  if (result?.success && result.detail) {
    applyLoadedAppStoreDetail(app, result.detail, "iap", versionId);
    submission = appStoreReviewDraftRows().find(row => String(row.id || "") === String(submissionId || "")) || null;
  } else {
    switchAppStorePane(app, "iap");
    showAppStoreNotice("项目已添加，草稿内容正在从 Apple 重新同步。", "warning");
  }
  const fallbackSubmission = {
    id: String(submissionId || ""),
    state: "READY_FOR_REVIEW",
    itemCount: fallbackItems.length,
    items: fallbackItems.map(item => ({ ...item, id: item.reviewItemId || item.id })),
  };
  syncAppStoreReviewDraftCount();
  if (!appStoreReviewDraftCount && fallbackSubmission.id) appStoreReviewDraftCount = 1;
  openAppStoreReviewDraftSubmissionPanel(submission || fallbackSubmission);
}

function openAppStoreVersionReviewDraftAfterCreate(reviewSubmissionId = "") {
  const submissionId = String(reviewSubmissionId || "");
  const version = currentAppStoreDetail?.selectedVersion || {};
  const submission = appStoreReviewDraftRows().find(row => String(row.id || "") === submissionId)
    || appStoreFindVersionReviewDraft(version)
    || appStoreReviewDraftRows().find(appStoreReviewSubmissionHasAppVersion)
    || appStoreReviewDraftRows()[0]
    || (submissionId ? {
      id: submissionId,
      state: "READY_FOR_REVIEW",
      platform: version.platform || "IOS",
      version,
      itemCount: 1,
      items: [{ type: "APP_STORE_VERSION", itemType: "appStoreVersions", relatedId: version.id || "", version }],
    } : null);
  const app = { ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) };
  switchAppStorePane(app, "release");
  if (submission) {
    requestAnimationFrame(() => openAppStoreReviewDraftSubmissionPanel(submission));
  } else {
    requestAnimationFrame(() => openInAppPurchaseReviewDraftPanel());
  }
}

function appStoreReviewDraftRows() {
  const rows = Array.isArray(currentAppStoreDetail?.reviewSubmissions) ? currentAppStoreDetail.reviewSubmissions : [];
  return rows.filter(item => item?.id && /^READY_FOR_REVIEW$/i.test(String(item.state || "")));
}

function syncAppStoreReviewDraftCount() {
  appStoreReviewDraftCount = appStoreReviewDraftRows().length;
  return appStoreReviewDraftCount;
}

function appStoreReviewSubmissionItems(submission = {}) {
  return Array.isArray(submission.items) ? submission.items : [];
}

function appStoreReviewSubmissionHasAppVersion(submission = {}) {
  const items = appStoreReviewSubmissionItems(submission);
  return items.some(item => item.version?.versionString || /appStoreVersion/i.test(`${item.type || ""} ${item.itemType || ""}`));
}

function appStoreReviewSubmissionHasInAppPurchase(submission = {}) {
  const items = appStoreReviewSubmissionItems(submission);
  return items.some(item => item.productId || item.purchaseId || item.versionId || /inAppPurchase/i.test(`${item.type || ""} ${item.itemType || ""}`));
}

function appStoreFindVersionReviewDraft(version = currentAppStoreDetail?.selectedVersion || {}) {
  const versionId = String(version?.id || "");
  const platform = String(version?.platform || "IOS").toUpperCase();
  return appStoreReviewDraftRows().find(submission => {
    if (!appStoreReviewSubmissionHasAppVersion(submission)) return false;
    if (versionId && String(submission.version?.id || "") === versionId) return true;
    return String(submission.platform || submission.version?.platform || "IOS").toUpperCase() === platform
      && String(submission.version?.versionString || "") === String(version?.versionString || "");
  }) || null;
}

function appStoreReviewSubmitDraftCandidates() {
  return appStoreReviewDraftRows().filter(submission =>
    appStoreReviewSubmissionHasInAppPurchase(submission) && !appStoreReviewSubmissionHasAppVersion(submission)
  );
}

function appStoreReviewDraftTitle(submission = {}) {
  const count = Number(submission.itemCount || submission.items?.length || 0) || 1;
  return `${appStorePlatformText(submission.platform || submission.version?.platform || appStoreReviewDraftPlatform || "IOS")} 提交草稿 (${count})`;
}

function appStoreReviewDraftMeta(submission = {}) {
  const actor = submission.submitter || submission.lastUpdatedBy || "开发者";
  const date = formatCertificateDate(submission.createdDate || submission.submittedDate || submission.lastUpdatedDate || new Date().toISOString());
  return `由${actor}于${date}开始`;
}

function appStoreReviewDraftDetailTitle(submission = {}) {
  return "草稿提交";
}

function appStoreReviewDraftTypeLabel(item = {}) {
  if (item.version?.versionString || /appStoreVersion/i.test(item.type || item.itemType || "")) return "App 版本";
  if (/subscription/i.test(`${item.type || ""} ${item.itemType || ""}`)) return "订阅";
  if (item.productId || item.versionId || /inAppPurchase/i.test(`${item.type || ""} ${item.itemType || ""}`)) return "App 内购买项目";
  return "项目";
}

function openAppStoreReviewDraftSubmissionPanel(submission = {}) {
  if (submission?.id && currentAppStoreApp?.id && !submission.reviewDetailLoaded) {
    openAppStoreReviewDraftSubmissionLoadingPanel(submission);
    loadAppStoreReviewDraftSubmissionPanel(submission);
    return;
  }
  const expectedItemCount = Number(submission.itemCount || submission.items?.length || 0);
  if (expectedItemCount <= 1 && appStoreReviewSubmissionHasAppVersion(submission) && !appStoreReviewSubmissionHasInAppPurchase(submission)) {
    openAppStoreVersionReviewDraftDetailPanel(submission);
    return;
  }
  openInAppPurchaseReviewDraftDetailPanel(submission.items || [], submission || {});
}

function openAppStoreReviewDraftSubmissionLoadingPanel(submission = {}) {
  document.querySelectorAll(".app-review-draft-overlay").forEach(node => node.remove());
  const modal = document.createElement("div");
  modal.className = "app-review-draft-overlay";
  modal.innerHTML = `<aside class="app-review-draft-panel app-review-draft-detail-panel">
    <button class="app-review-draft-close" type="button" aria-label="关闭">×</button>
    <button class="app-review-draft-back" type="button">‹ 提交内容</button>
    <header><h2>${escapeHTML(appStoreReviewDraftDetailTitle(submission))}</h2><p>${escapeHTML(appStoreReviewDraftMeta(submission))}</p></header>
    <div class="loading-state">正在读取审核草稿…</div>
  </aside>`;
  appendAppReviewDraftModal(modal);
  modal.querySelector(".app-review-draft-close").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  modal.querySelector(".app-review-draft-back").onclick = () => {
    modal.remove();
    openInAppPurchaseReviewDraftListPanel(appStoreReviewDraftRows());
  };
}

async function loadAppStoreReviewDraftSubmissionPanel(submission = {}) {
  const result = await window.appleDeveloper.appStoreReviewSubmissionDetail({
    appId: currentAppStoreApp?.id,
    submissionId: submission.id,
  }).catch(error => ({ success: false, error: error.message }));
  if (!result?.success) {
    document.querySelectorAll(".app-review-draft-overlay").forEach(node => node.remove());
    openAppStoreReviewDraftSubmissionPanel({ ...submission, reviewDetailLoaded: true });
    showAppStoreError(result?.error || "审核草稿读取失败", "", "读取失败");
    return;
  }
  const existingItems = new Map(appStoreReviewSubmissionItems(submission).map(item => [String(item.id || ""), item]));
  const loadedItems = appStoreReviewSubmissionItems(result.detail || {}).map(item => {
    const existing = existingItems.get(String(item.id || "")) || {};
    return {
      ...existing,
      ...item,
      name: item.name || existing.name || "",
      productId: item.productId || existing.productId || "",
      purchaseId: item.purchaseId || existing.purchaseId || "",
      purchaseType: item.purchaseType || existing.purchaseType || "",
      version: item.version || existing.version || null,
    };
  });
  const detail = { ...submission, ...(result.detail || {}), items: loadedItems, reviewDetailLoaded: true };
  mergeReviewSubmissionDetailIntoAppDetail(detail);
  document.querySelectorAll(".app-review-draft-overlay").forEach(node => node.remove());
  openAppStoreReviewDraftSubmissionPanel(detail);
}

function openInAppPurchaseReviewDraftPanel(items = [], targetSubmission = null) {
  document.querySelectorAll(".app-review-draft-overlay").forEach(node => node.remove());
  const draftRows = appStoreReviewDraftRows();
  const itemDraft = items.map(item => item?.reviewDraft).find(item => item?.submissionId || item?.id) || null;
  const itemDraftSubmission = itemDraft ? {
    id: String(itemDraft.submissionId || itemDraft.id || ""),
    state: String(itemDraft.submissionState || itemDraft.state || "READY_FOR_REVIEW"),
    createdDate: String(itemDraft.createdDate || ""),
    lastUpdatedDate: String(itemDraft.lastUpdatedDate || itemDraft.createdDate || ""),
    itemCount: Number(itemDraft.itemCount || items.length || 0),
    platform: appStoreReviewDraftPlatform || "IOS",
    submitter: "开发者",
    items,
  } : null;
  const inferredSubmission = targetSubmission?.id
    ? targetSubmission
    : (itemDraftSubmission || draftRows.find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW") || draftRows[0] || {});
  if (!targetSubmission?.id && !items.length) {
    const rows = draftRows.length ? draftRows : (inferredSubmission.id ? [inferredSubmission] : []);
    if (rows.length === 1) return openAppStoreReviewDraftSubmissionPanel(rows[0]);
    return openInAppPurchaseReviewDraftListPanel(rows);
  }
  openInAppPurchaseReviewDraftDetailPanel(items, inferredSubmission);
}

function appendAppReviewDraftModal(modal) {
  const host = document.querySelector(".app-detail") || document.body;
  host.appendChild(modal);
}

function openInAppPurchaseReviewDraftListPanel(submissions = []) {
  const modal = document.createElement("div");
  modal.className = "app-review-draft-overlay";
  const rows = submissions.length ? submissions : [];
  modal.innerHTML = `<aside class="app-review-draft-panel app-review-draft-list-panel">
    <button class="app-review-draft-close" type="button" aria-label="关闭">×</button>
    <header><h2>提交内容</h2><p>准备提交至 App 审核的提交内容。</p></header>
    <div class="app-review-draft-cards">${rows.length ? rows.map(item => `<button class="app-review-draft-card" type="button" data-submission-id="${escapeHTML(item.id)}">
      <span><strong>${escapeHTML(appStoreReviewDraftTitle(item))}</strong><small>${escapeHTML(appStoreReviewDraftMeta(item))}</small></span><b>›</b>
    </button>`).join("") : '<div class="app-review-draft-empty">当前没有准备提交的草稿。</div>'}</div>
  </aside>`;
  appendAppReviewDraftModal(modal);
  modal.querySelector(".app-review-draft-close").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  modal.querySelectorAll("[data-submission-id]").forEach(button => {
    button.onclick = () => {
      const submission = rows.find(item => String(item.id || "") === String(button.dataset.submissionId || ""));
      modal.remove();
      openAppStoreReviewDraftSubmissionPanel(submission || {});
    };
  });
}

function appStoreVersionDraftBuildLabel(submission = {}) {
  const version = submission.version || currentAppStoreDetail?.selectedVersion || {};
  const versionString = String(version.versionString || "");
  const build = (currentAppStoreDetail?.builds || []).find(item => !version.buildId || String(item.id || "") === String(version.buildId || "")) || (currentAppStoreDetail?.builds || [])[0] || {};
  const buildVersion = String(version.buildVersion || build.version || build.buildVersion || "");
  if (versionString && buildVersion) return `${versionString} (${buildVersion})`;
  return versionString || buildVersion || "—";
}

function openAppStoreReviewDraftRemoveConfirmation(onConfirm) {
  document.getElementById("app-review-draft-remove-modal")?.remove();
  const confirmModal = document.createElement("div");
  confirmModal.id = "app-review-draft-remove-modal";
  confirmModal.className = "app-pricing-modal app-iap-remove-review-modal app-review-draft-remove-modal";
  confirmModal.innerHTML = `<div class="app-iap-remove-review-dialog"><div><h2>是否从提交中移除?</h2><p>该项目将从此次提交中移除。</p><div class="app-pricing-message" data-error></div></div><footer><button class="secondary" data-close type="button">取消</button><button class="primary" data-remove type="button">移除</button></footer></div>`;
  appendAppStoreModal(confirmModal);
  const close = () => confirmModal.remove();
  confirmModal.querySelector("[data-close]").addEventListener("click", close);
  confirmModal.addEventListener("click", event => { if (event.target === confirmModal) close(); });
  confirmModal.querySelector("[data-remove]").addEventListener("click", async event => {
    const button = event.currentTarget;
    const message = confirmModal.querySelector("[data-error]");
    setBusy(button, true, "移除中…");
    const result = await onConfirm();
    if (result?.success === false) {
      setBusy(button, false);
      message.textContent = result.error || "无法从提交中移除";
      return;
    }
    confirmModal.remove();
  });
}

function openAppStoreVersionReviewDraftDetailPanel(targetSubmission = {}) {
  const submission = targetSubmission?.id ? targetSubmission : {};
  const version = submission.version || currentAppStoreDetail?.selectedVersion || {};
  const platform = appStorePlatformText(submission.platform || version.platform || "IOS");
  const versionString = version.versionString || currentAppStoreDetail?.selectedVersion?.versionString || "";
  const title = `${platform} App ${versionString || ""}`.trim();
  const iconUrl = appStoreSafeImageUrl(version.iconUrl || currentAppStoreDetail?.app?.iconUrl || currentAppStoreApp?.iconUrl || "");
  const lastUpdated = formatCertificateDate(submission.lastUpdatedDate || submission.createdDate || submission.submittedDate || new Date().toISOString());
  const canSubmit = !!submission.id && /^READY_FOR_REVIEW$/i.test(String(submission.state || "READY_FOR_REVIEW"));
  const versionItem = (submission.items || []).find(item => item.version?.versionString || /appStoreVersion/i.test(`${item.type || ""} ${item.itemType || ""}`)) || {};
  const reviewItemId = String(versionItem.id || "");
  const modal = document.createElement("div");
  modal.className = "app-review-draft-overlay";
  modal.innerHTML = `<aside class="app-review-draft-panel app-review-draft-detail-panel app-review-version-draft-panel">
    <button class="app-review-draft-close" type="button" aria-label="关闭">×</button>
    <button class="app-review-draft-back" type="button">‹ 提交内容</button>
    <header><h2>${escapeHTML(appStoreReviewDraftDetailTitle(submission))}</h2><p>${escapeHTML(appStoreReviewDraftMeta(submission))}</p></header>
    <p>下方添加的项目将与 ${escapeHTML(platform)} 版本 ${escapeHTML(versionString || "—")} 一起审核</p>
    <h3>准备提交项目</h3>
    <article class="app-review-draft-product-row app-review-version-draft-row">
      <span class="app-review-draft-icon">${iconUrl ? `<img src="${escapeHTML(iconUrl)}" alt="">` : ""}</span>
      <span><strong>${escapeHTML(title || "App 版本")}</strong><small>${escapeHTML(appStoreVersionDraftBuildLabel(submission))}</small></span>
      ${reviewItemId ? `<button class="app-review-draft-remove app-review-version-remove" type="button" data-item-id="${escapeHTML(reviewItemId)}" title="从提交中移除" aria-label="从提交中移除">−</button>` : ""}
    </article>
    <footer><small>最后由${escapeHTML(submission.submitter || "开发者")}于${escapeHTML(lastUpdated)}更新</small><button class="app-review-draft-submit" type="button" ${canSubmit ? "" : "disabled"}>提交以供审核</button></footer>
  </aside>`;
  appendAppReviewDraftModal(modal);
  modal.querySelector(".app-review-draft-close").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  modal.querySelector(".app-review-draft-back").onclick = () => {
    modal.remove();
    openInAppPurchaseReviewDraftListPanel(appStoreReviewDraftRows());
  };
  modal.querySelector(".app-review-draft-submit").onclick = async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    setBusy(button, true, "提交中…");
    const result = await window.appleDeveloper.submitAppStoreInAppPurchaseReview({
      appId: currentAppStoreApp?.id,
      submissionId: submission.id,
    }).catch(error => ({ success: false, error: error.message }));
    if (!result?.success) {
      setBusy(button, false);
      return showAppStoreError(result?.error || "提交审核失败", "", "提交审核失败");
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    const activeDraft = appStoreReviewDraftRows().find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW");
    appStoreReviewDraftCount = Number(activeDraft?.itemCount || 0);
    modal.remove();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "review");
    showAppStoreNotice("提交审核成功，页面内容已刷新。");
  };
  modal.querySelector(".app-review-version-remove")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    openAppStoreReviewDraftRemoveConfirmation(async () => {
      const result = await window.appleDeveloper.removeAppStoreReviewSubmissionItem({
        appId: currentAppStoreApp?.id,
        submissionId: submission.id,
        itemId: button.dataset.itemId,
        itemCount: submission.itemCount || submission.items?.length || 1,
      });
      if (!result?.success) return result;
      if (result.detail) updateCurrentAppStoreDetail(result.detail, { clearCache: true });
      const activeDraft = appStoreReviewDraftRows().find(item => String(item.id || "") === String(submission.id || ""))
        || appStoreReviewDraftRows().find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW");
      appStoreReviewDraftCount = Number(activeDraft?.itemCount || 0);
      modal.remove();
      switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
      showAppStoreNotice("已从草稿中移除 App 版本，页面内容已刷新。");
      return result;
    });
  });
}

function openInAppPurchaseReviewDraftItemsPanel(items = [], targetSubmission = {}) {
  const rows = (items.length ? [...items] : (Array.isArray(targetSubmission.items) ? [...targetSubmission.items] : []))
    .filter(item => appStoreReviewDraftTypeLabel(item) === "App 内购买项目");
  const hasSubmissionAppVersion = appStoreReviewSubmissionHasAppVersion(targetSubmission);
  const fallbackCount = Number((targetSubmission.itemCount && hasSubmissionAppVersion ? Math.max(0, Number(targetSubmission.itemCount) - 1) : targetSubmission.itemCount) || rows.length || appStoreReviewDraftCount || 0);
  if (!rows.length && fallbackCount > 0) {
    for (let index = 0; index < fallbackCount; index += 1) rows.push({ name: `待提交项目 ${index + 1}` });
  }
  const modal = document.createElement("div");
  modal.className = "app-review-draft-overlay";
  modal.innerHTML = `<aside class="app-review-draft-panel app-review-draft-items-panel">
    <button class="app-review-draft-close" type="button" aria-label="关闭">×</button>
    <button class="app-review-draft-back" type="button">‹ ${escapeHTML(appStoreReviewDraftTitle(targetSubmission))}</button>
    <header><h2>App 内购买项目 (${rows.length || fallbackCount || 0})</h2></header>
    <div class="app-review-draft-product-list">${rows.map(item => {
      const icon = appStoreSafeImageUrl(item.iconUrl || item.artworkUrl || currentAppStoreApp?.iconUrl || "");
      const title = item.name || appStoreReviewItemName(item, currentAppStoreApp || {}) || "未命名项目";
      const purchaseId = String(item.purchaseId || appStoreReviewSubmissionPurchase(item)?.id || "");
      const itemId = String(item.id || "");
      const versionId = appStoreReviewSubmissionPurchaseVersionId(item, targetSubmission);
      return `<article class="app-review-draft-product-row ${purchaseId ? "clickable" : ""}" ${purchaseId ? `data-purchase-id="${escapeHTML(purchaseId)}"` : ""}><span class="app-review-draft-icon">${icon ? `<img src="${escapeHTML(icon)}" alt="">` : ""}</span><span><strong>${escapeHTML(title)}</strong><small>${escapeHTML(appStoreReviewDraftTypeLabel(item))}</small></span>${itemId || versionId ? `<button class="app-review-draft-remove" type="button" ${itemId ? `data-item-id="${escapeHTML(itemId)}"` : ""} ${versionId ? `data-version-id="${escapeHTML(versionId)}"` : ""} title="从提交中移除" aria-label="从提交中移除">−</button>` : ""}</article>`;
    }).join("") || '<div class="app-review-draft-empty">当前没有 App 内购买项目。</div>'}</div>
  </aside>`;
  appendAppReviewDraftModal(modal);
  modal.querySelector(".app-review-draft-close").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  modal.querySelector(".app-review-draft-back").onclick = () => {
    modal.remove();
    openInAppPurchaseReviewDraftDetailPanel(rows, targetSubmission);
  };
  modal.querySelectorAll("[data-purchase-id]").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest(".app-review-draft-remove")) return;
      const purchaseId = row.dataset.purchaseId || "";
      if (!purchaseId) return;
      modal.remove();
      openAppStoreInAppPurchaseDetail(purchaseId);
    });
  });
  modal.querySelectorAll(".app-review-draft-remove").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      openAppStoreReviewDraftRemoveConfirmation(async () => {
        const itemId = button.dataset.itemId || "";
        const versionId = button.dataset.versionId || "";
        const result = itemId
          ? await window.appleDeveloper.removeAppStoreReviewSubmissionItem({
            appId: currentAppStoreApp?.id,
            submissionId: targetSubmission.id,
            itemId,
            itemCount: targetSubmission.itemCount || targetSubmission.items?.length || rows.length || 1,
          })
          : await window.appleDeveloper.removeAppStoreInAppPurchaseFromReview({ appId: currentAppStoreApp?.id, versionId });
        if (!result?.success) return result;
        if (result.detail) updateCurrentAppStoreDetail(result.detail, { clearCache: true });
        else {
          targetSubmission.items = (targetSubmission.items || []).filter(item => item.id !== itemId && item.versionId !== versionId);
          targetSubmission.itemCount = targetSubmission.items.length;
          if (!targetSubmission.itemCount && currentAppStoreDetail?.reviewSubmissions) {
            currentAppStoreDetail.reviewSubmissions = currentAppStoreDetail.reviewSubmissions.filter(item => item.id !== targetSubmission.id);
          }
        }
        syncAppStoreReviewDraftCount();
        const refreshedSubmission = appStoreReviewDraftRows().find(item => String(item.id || "") === String(targetSubmission.id || ""));
        modal.remove();
        switchAppStorePane(currentAppStoreApp, document.querySelector(".app-detail")?.dataset.pane || "review");
        if (refreshedSubmission?.id) openAppStoreReviewDraftSubmissionPanel(refreshedSubmission);
        else if (appStoreReviewDraftCount) openInAppPurchaseReviewDraftPanel();
        else showAppStoreNotice("已从草稿中移除 App 内购买项目，页面内容已刷新。");
        return result;
      });
    });
  });
}

function appStoreInAppPurchaseDraftWarning(items = [], hasAppVersionItem = false) {
  if (!hasAppVersionItem) return "若要提交项目以供审核，请为所选平台添加 App 版本。";
  const hasConsumable = items.some(item => String(item.purchaseType || item.type || "").toUpperCase() === "CONSUMABLE");
  const status = currentAppStoreDetail?.iapSubmissionStatus || {};
  if (hasConsumable && !status.hasApprovedConsumableIAP) return "首个消耗型 App 内购买项目必须随新 App 版本提交。";
  if (status.missingRequiredPrivacyPolicyData) return "请先补充 App 隐私政策信息，再提交内购项目审核。";
  return "";
}

function openInAppPurchaseReviewDraftDetailPanel(items = [], targetSubmission = {}) {
  const submission = targetSubmission?.id ? targetSubmission : {};
  const rows = items.length ? [...items] : (Array.isArray(submission.items) ? [...submission.items] : []);
  const fallbackCount = Number(submission.itemCount || rows.length || appStoreReviewDraftCount || 0);
  if (!rows.length && fallbackCount > 0) {
    for (let index = 0; index < fallbackCount; index += 1) {
      rows.push({ name: `App 内购买项目 ${index + 1}`, type: "inAppPurchaseVersion", itemType: "inAppPurchaseVersions" });
    }
  }
  const platforms = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"];
  const displayPlatform = String(submission.platform || submission.version?.platform || appStoreReviewDraftPlatform || "IOS").toUpperCase();
  const availablePlatforms = new Set((currentAppStoreDetail?.versions || []).map(version => String(version.platform || "").toUpperCase()));
  const platformHasVersion = availablePlatforms.has(displayPlatform);
  const versionItems = rows.filter(item => appStoreReviewDraftTypeLabel(item) === "App 版本");
  const iapItems = rows.filter(item => appStoreReviewDraftTypeLabel(item) === "App 内购买项目");
  const versionItem = versionItems[0] || {};
  const version = versionItem.version || submission.version || {};
  const iconUrl = appStoreSafeImageUrl(version.iconUrl || currentAppStoreDetail?.app?.iconUrl || currentAppStoreApp?.iconUrl || "");
  const hasAppVersionItem = !!versionItems.length;
  const canSubmit = !!submission.id && hasAppVersionItem && /^READY_FOR_REVIEW$/i.test(String(submission.state || "READY_FOR_REVIEW"));
  const draftWarning = appStoreInAppPurchaseDraftWarning(iapItems, hasAppVersionItem);
  const showMissingVersionWarning = !!draftWarning;
  const iapCount = iapItems.length || (rows.length && !hasAppVersionItem ? rows.length : 0);
  const lastUpdated = formatCertificateDate(submission.lastUpdatedDate || submission.createdDate || submission.submittedDate || new Date().toISOString());
  const associationText = hasAppVersionItem
    ? `下方添加的项目将与 ${appStorePlatformText(displayPlatform)} 版本 ${version.versionString || currentAppStoreDetail?.selectedVersion?.versionString || "—"} 一起审核`
    : `下方添加的项目尚未关联 ${appStorePlatformText(displayPlatform)} App 版本。`;
  const modal = document.createElement("div");
  modal.className = "app-review-draft-overlay";
  modal.innerHTML = `<aside class="app-review-draft-panel app-review-draft-detail-panel">
    <button class="app-review-draft-close" type="button" aria-label="关闭">×</button>
    <button class="app-review-draft-back" type="button">‹ 提交内容</button>
    <header><h2>${escapeHTML(appStoreReviewDraftDetailTitle(submission))}</h2><p>${escapeHTML(appStoreReviewDraftMeta(submission))}</p></header>
    <p>${escapeHTML(associationText)}</p>
    ${hasAppVersionItem ? "" : `<select class="app-review-draft-platform" aria-label="选择审核平台">${platforms.map(platform => `<option value="${platform}" ${platform === displayPlatform ? "selected" : ""}>${escapeHTML(appStorePlatformText(platform))}</option>`).join("")}</select>`}
    <div class="app-review-draft-warning" ${showMissingVersionWarning ? "" : "hidden"}><b>!</b><span><strong>无法提交以供审核</strong><small>${escapeHTML(draftWarning)}</small></span></div>
    <h3>准备提交项目 (${Number(submission.itemCount || rows.length || 0) || rows.length || 0})</h3>
    ${hasAppVersionItem ? `<article class="app-review-draft-product-row app-review-version-draft-row">
      <span class="app-review-draft-icon">${iconUrl ? `<img src="${escapeHTML(iconUrl)}" alt="">` : ""}</span>
      <span><strong>${escapeHTML(appStoreReviewItemName(versionItem, currentAppStoreApp || {}))}</strong><small>${escapeHTML(appStoreVersionDraftBuildLabel({ ...submission, version }))}</small></span>
      ${versionItem.id ? `<button class="app-review-draft-remove app-review-version-remove" type="button" data-item-id="${escapeHTML(versionItem.id)}" title="从提交中移除" aria-label="从提交中移除">−</button>` : ""}
    </article>` : ""}
    <button class="app-review-draft-product-card" type="button"><span>App 内购买项目 (${iapCount})</span><b>›</b></button>
    <div class="app-review-draft-items" hidden>${rows.map(item => {
      const versionId = appStoreReviewSubmissionPurchaseVersionId(item, submission);
      const title = item.name || appStoreReviewItemName(item, currentAppStoreApp || {}) || "未命名项目";
      return `<div class="app-review-draft-item"><span class="app-review-draft-icon"></span><span><strong>${escapeHTML(title)}</strong><small>${escapeHTML(appStoreReviewDraftTypeLabel(item))}</small></span>${versionId ? `<button class="app-review-draft-remove" type="button" data-version-id="${escapeHTML(versionId)}" title="从提交中移除" aria-label="从提交中移除">−</button>` : ""}</div>`;
    }).join("")}</div>
    <footer><small>最后由${escapeHTML(submission.submitter || "开发者")}于${escapeHTML(lastUpdated)}更新</small><button class="app-review-draft-submit" type="button" ${canSubmit ? "" : "disabled"}>提交以供审核</button></footer>
  </aside>`;
  appendAppReviewDraftModal(modal);
  modal.querySelector(".app-review-draft-close").onclick = () => modal.remove();
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  modal.querySelector(".app-review-draft-back").onclick = () => {
    modal.remove();
    openInAppPurchaseReviewDraftListPanel(appStoreReviewDraftRows());
  };
  modal.querySelector(".app-review-draft-platform")?.addEventListener("change", event => {
    appStoreReviewDraftPlatform = event.currentTarget.value || "IOS";
    submission.platform = appStoreReviewDraftPlatform;
    modal.remove();
    openInAppPurchaseReviewDraftDetailPanel(rows, submission);
  });
  modal.querySelector(".app-review-draft-product-card")?.addEventListener("click", () => {
    modal.remove();
    openInAppPurchaseReviewDraftItemsPanel(iapItems.length ? iapItems : rows, submission);
  });
  modal.querySelector(".app-review-draft-submit").onclick = async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    setBusy(button, true, "提交中…");
    const result = await window.appleDeveloper.submitAppStoreInAppPurchaseReview({
      appId: currentAppStoreApp?.id,
      submissionId: submission.id,
    }).catch(error => ({ success: false, error: error.message }));
    if (!result?.success) {
      setBusy(button, false);
      return showAppStoreError(result?.error || "提交审核失败", "", "提交审核失败");
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    const activeDraft = appStoreReviewDraftRows().find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW");
    appStoreReviewDraftCount = Number(activeDraft?.itemCount || 0);
    modal.remove();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "review");
    showAppStoreNotice("提交审核成功，页面内容已刷新。");
  };
  modal.querySelectorAll(".app-review-draft-remove").forEach(button => button.onclick = async () => {
    openAppStoreReviewDraftRemoveConfirmation(async () => {
      const itemId = button.dataset.itemId || "";
      const result = itemId
        ? await window.appleDeveloper.removeAppStoreReviewSubmissionItem({
          appId: currentAppStoreApp?.id,
          submissionId: submission.id,
          itemId,
          itemCount: submission.itemCount || submission.items?.length || 1,
        })
        : await window.appleDeveloper.removeAppStoreInAppPurchaseFromReview({ appId: currentAppStoreApp?.id, versionId: button.dataset.versionId });
      if (!result?.success) return result;
      if (result.detail) updateCurrentAppStoreDetail(result.detail, { clearCache: true });
      else {
        submission.items = (submission.items || []).filter(item => item.id !== itemId && item.versionId !== button.dataset.versionId);
        submission.itemCount = submission.items.length;
        if (!submission.itemCount && currentAppStoreDetail?.reviewSubmissions) {
          currentAppStoreDetail.reviewSubmissions = currentAppStoreDetail.reviewSubmissions.filter(item => item.id !== submission.id);
        }
      }
      syncAppStoreReviewDraftCount();
      const refreshedSubmission = appStoreReviewDraftRows().find(item => String(item.id || "") === String(submission.id || ""));
      const removedAppVersion = button.classList.contains("app-review-version-remove") || (itemId && appStoreReviewDraftTypeLabel(rows.find(item => item.id === itemId) || {}) === "App 版本");
      modal.remove();
      switchAppStorePane(currentAppStoreApp, document.querySelector(".app-detail")?.dataset.pane || "review");
      if (removedAppVersion) showAppStoreNotice("已从草稿中移除 App 版本，页面内容已刷新。");
      else if (refreshedSubmission?.id) openAppStoreReviewDraftSubmissionPanel(refreshedSubmission);
      else if (appStoreReviewDraftCount) openInAppPurchaseReviewDraftPanel();
      return result;
    });
  });
}

function openRemoveInAppPurchaseFromReviewModal() {
  const item = currentInAppPurchaseDetail || {};
  const modal = document.createElement("div");
  modal.className = "app-pricing-modal app-iap-remove-review-modal";
  modal.innerHTML = `<div class="app-iap-remove-review-dialog"><div><h2>是否从提交中移除?</h2><p>该项目将从此次提交中移除。</p></div><footer><button class="secondary" data-close type="button">取消</button><button class="primary" data-remove type="button">移除</button></footer></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("[data-remove]").onclick = async event => {
    setBusy(event.currentTarget, true, "移除中…");
    const result = await window.appleDeveloper.removeAppStoreInAppPurchaseFromReview({ appId: currentAppStoreApp?.id, purchaseId: item.id, versionId: item.versionId });
    if (!result?.success) { setBusy(event.currentTarget, false); return showAppStoreError(result?.error || "移除失败", "", "无法从提交中移除"); }
    currentInAppPurchaseDetail = { ...item, state: "PREPARE_FOR_SUBMISSION", status: "PREPARE_FOR_SUBMISSION", reviewDraft: null };
    appStoreReviewDraftCount = Math.max(0, appStoreReviewDraftCount - 1);
    modal.remove();
    switchAppStorePane(currentAppStoreApp, "iap");
  };
}

function showAppleLoginGuardMessage() {
  document.querySelectorAll(".app-login-guard").forEach(node => node.remove());
  const main = el("app-detail-main");
  if (!main) return;
  main.insertAdjacentHTML("afterbegin", `<div class="app-login-guard"><i class="loading-spinner"></i><span><strong>正在登录 Apple 开发者账户</strong><small>请勿操作，登录完成后再进入 App 审核。</small></span></div>`);
}

async function requestAppStorePane(app, pane) {
  if (pane === "review" && (!authenticated || appleLoginInProgress)) {
    showAppleLoginGuardMessage();
    return;
  }
  ++appStoreDetailRequestSeq;
  if (!["release", "testflight", "iap"].includes(pane) && currentAppStoreDetail?.partial) {
    // Keep navigation available; never display unloaded fields as empty data.
    renderAppStoreDetailLoadingVersion(app, appStoreCurrentVersionId(currentAppStoreDetail), pane);
    await loadAppStoreDetail(app, pane, appStoreCurrentVersionId(currentAppStoreDetail));
    return;
  }
  switchAppStorePane(app, pane);
  if (pane === "review") {
    currentReviewSubmissionDetail = null;
    currentReviewSubmissionLoadingId = "";
    const requestId = appStoreDetailRequestSeq;
    const result = await fetchAppStoreDetail(app, appStoreCurrentVersionId(currentAppStoreDetail));
    if (requestId !== appStoreDetailRequestSeq || !result?.success || document.querySelector(".app-detail")?.dataset.pane !== "review") return;
    updateCurrentAppStoreDetail(result.detail);
    const activeDraft = (currentAppStoreDetail?.reviewSubmissions || []).find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW");
    appStoreReviewDraftCount = Number(activeDraft?.itemCount || 0);
    switchAppStorePane(app, "review");
  }
}

function bindAppStorePrivacyButtons() {
  document.querySelectorAll("[data-privacy-open]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      openPrivacyButton(button.dataset.privacyOpen || "");
    });
  });
  document.querySelectorAll("[data-privacy-delete]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      deleteAppStoreDataUsage(button.dataset.privacyDelete || "");
    });
  });
}

function closeAppStoreHelpPopovers(event) {
  if (event?.target?.closest?.(".app-help")) return;
  document.querySelectorAll(".app-help.open").forEach(item => item.classList.remove("open"));
  if (document.activeElement?.classList?.contains("app-help")) document.activeElement.blur();
}

function bindAppStoreHelpButtons(root = document) {
  root.querySelectorAll(".app-help").forEach(button => {
    button.classList.remove("open");
    if (button.dataset.helpBound === "1") return;
    button.dataset.helpBound = "1";
    button.addEventListener("click", event => {
      event.stopPropagation();
      document.querySelectorAll(".app-help.open").forEach(item => { if (item !== button) item.classList.remove("open"); });
      button.classList.toggle("open");
    });
  });
}

function openAppStoreSystemExternalLink(event) {
  const link = event?.target?.closest?.("[data-system-external]");
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  window.appleDeveloper.openExternal(link.href).catch(error => showAppStoreError(error.message || "无法打开系统浏览器"));
}

function openAppStoreNewVersionModal(platform = "IOS") {
  if (!currentAppStoreApp?.id || document.getElementById("app-new-version-modal")) return;
  const normalizedPlatform = String(platform || "IOS").toUpperCase();
  const modal = document.createElement("div");
  modal.id = "app-new-version-modal";
  modal.className = "app-pricing-modal app-new-version-modal-mask";
  modal.innerHTML = `<form class="app-pricing-dialog app-new-version-dialog"><div class="app-pricing-dialog-body"><h2>新版本</h2><div class="app-new-version-field"><div class="app-new-version-label"><label for="app-new-version-input">版本</label>${appStoreHelp("你要添加的 App 的版本。编号应遵循软件版本规范。")}</div><input id="app-new-version-input" name="versionString" maxlength="64" autocomplete="off"><small data-new-version-count>64</small></div><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" type="submit" disabled>创建</button></div></form>`;
  appendAppStoreModal(modal);
  bindAppStoreHelpButtons(modal);
  const form = modal.querySelector("form");
  const input = modal.querySelector("#app-new-version-input");
  const submit = modal.querySelector('[type="submit"]');
  const counter = modal.querySelector("[data-new-version-count]");
  const message = modal.querySelector(".app-pricing-message");
  const close = () => modal.remove();
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  input.addEventListener("input", () => {
    const value = input.value.trim();
    submit.disabled = !value;
    if (counter) counter.textContent = String(Math.max(0, 64 - value.length));
    message.textContent = "";
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const versionString = input.value.trim();
    if (!versionString) return;
    setBusy(submit, true, "创建中…");
    input.disabled = true;
    message.textContent = "";
    const result = await window.appleDeveloper.createAppStoreVersion({ appId: currentAppStoreApp.id, platform: normalizedPlatform, versionString });
    if (!result?.success) {
      input.disabled = false;
      setBusy(submit, false);
      message.textContent = result?.error || "新版本创建失败";
      return;
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    const nextApp = { ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}), versions: currentAppStoreDetail?.versions || currentAppStoreApp.versions || [] };
    currentAppStoreApp = nextApp;
    appStoreApps = appStoreApps.map(item => String(item.id || "") === String(nextApp.id || "") ? { ...item, ...nextApp } : item);
    close();
    switchAppStorePane(nextApp, "release");
  });
}

function switchAppStorePane(app, pane) {
  const content = el("app-store-content");
  if (!content) return;
  const previousDetail = content.querySelector(".app-detail");
  const samePane = previousDetail?.dataset.pane === pane && String(previousDetail?.dataset.appId || "") === String(app?.id || "");
  const previousMainScroll = samePane ? content.querySelector("#app-detail-main")?.scrollTop || 0 : 0;
  content.innerHTML = appStoreDetailShell(app, currentAppStoreDetail, pane);
  content.scrollTop = 0;
  const main = content.querySelector("#app-detail-main");
  if (main) main.scrollTop = previousMainScroll;
  if (el("app-store-count")) el("app-store-count").textContent = `${app?.name || "App"} · App 详情`;
  bindAppStoreDetailEvents(app);
  if (pane === "iap" && currentInAppPurchases === null) loadAppStoreInAppPurchases(app);
}

function appStoreDetailCacheKey(appId, versionId = "") {
  return `${String(appId || "")}:${String(versionId || "")}`;
}

function appStoreDetailPendingKey(appId, versionId = "", mode = "full") {
  return `${appStoreDetailCacheKey(appId, versionId)}:${String(mode || "full")}`;
}

function getCachedAppStoreDetail(appId, versionId = "", mode = "full") {
  const cached = appStoreDetailCache.get(appStoreDetailCacheKey(appId, versionId));
  if (!cached || Date.now() - Number(cached.at || 0) > APP_STORE_DETAIL_CACHE_TTL_MS) return null;
  if (cached.detail?.partial && !(mode === "release" && cached.detail.loadedPanes?.includes("release"))) return null;
  return cached.detail || null;
}

function cacheAppStoreDetail(appId, detail, requestedVersionId = "") {
  if (!appId || !detail) return;
  const at = Date.now();
  const selectedId = String(detail?.selectedVersion?.id || "");
  const versionIds = [requestedVersionId, selectedId].map(value => String(value || ""));
  if (!String(requestedVersionId || "")) versionIds.push("");
  versionIds.filter((value, index, rows) => rows.indexOf(value) === index).forEach(versionId => {
    appStoreDetailCache.set(appStoreDetailCacheKey(appId, versionId), { at, detail });
  });
  if (appStoreDetailCache.size > 24) {
    [...appStoreDetailCache.entries()]
      .sort((left, right) => Number(left[1]?.at || 0) - Number(right[1]?.at || 0))
      .slice(0, appStoreDetailCache.size - 24)
      .forEach(([key]) => appStoreDetailCache.delete(key));
  }
}

function clearAppStoreDetailCache(appId = "", versionId = "") {
  const targetApp = String(appId || "");
  const targetVersion = String(versionId || "");
  [...appStoreDetailCache.keys()].forEach(key => {
    const [cachedAppId, cachedVersionId = ""] = key.split(":");
    if ((!targetApp || cachedAppId === targetApp) && (!targetVersion || cachedVersionId === targetVersion || cachedVersionId === "")) {
      appStoreDetailCache.delete(key);
    }
  });
}

function appStoreDetailLoadingVersion(app, versionId = "") {
  const versions = currentAppStoreDetail?.versions?.length ? currentAppStoreDetail.versions : (app?.versions || []);
  const selectedVersion = versions.find(item => String(item.id || "") === String(versionId || "")) || versions[0] || {};
  return {
    ...(currentAppStoreDetail || {}),
    app: { ...(app || {}), ...(currentAppStoreDetail?.app || {}) },
    versions,
    selectedVersion,
    loading: true,
  };
}

function renderAppStoreReviewWarning(detail, version = {}) {
  const warning = detail?.reviewWarning || {};
  const rejected = warning.isRejected || /REJECT|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/i.test(appStoreVersionStatus(version));
  if (!rejected) return "";
  const reasons = (Array.isArray(warning.reasons) ? warning.reasons : [])
    .map(appStoreReviewReasonText)
    .filter(Boolean);
  const uniqueReasons = [...new Set(reasons)];
  const reasonHTML = uniqueReasons.length
    ? `<ul>${uniqueReasons.map(reason => `<li>${escapeHTML(reason)}</li>`).join("")}</ul>`
    : "";
  const submissionId = String(warning.submissionId || "");
  const reviewLink = submissionId
    ? `<button class="app-link-button app-review-warning-link" type="button" data-review-submission-id="${escapeHTML(submissionId)}">查看提交内容</button>`
    : "";
  return `<section class="app-review-warning" role="alert">
    <span class="app-review-warning-icon">!</span>
    <div class="app-review-warning-copy">
      <strong>此项目需要注意：</strong>
      <p>提交的项目被拒。请前往提交详细信息页面进一步了解。</p>
      ${reasonHTML}
      ${reviewLink}
    </div>
  </section>`;
}

function renderAppStoreDetailLoadingVersion(app, versionId = "", pane = "release") {
  const content = el("app-store-content");
  if (!content) return;
  content.innerHTML = appStoreDetailShell(app, appStoreDetailLoadingVersion(app, versionId), pane);
  bindAppStoreDetailEvents(app);
}

function applyLoadedAppStoreDetail(app, detail, pane = "release", requestedVersionId = "") {
  currentAppStoreDetail = detail || null;
  if (!currentAppStoreDetail) return null;
  if (!currentAppStoreDetail.partial || currentAppStoreDetail.loadedPanes?.includes("release")) cacheAppStoreDetail(app.id, currentAppStoreDetail, requestedVersionId);
  const activeDraft = (currentAppStoreDetail.reviewSubmissions || []).find(item => String(item.state || "").toUpperCase() === "READY_FOR_REVIEW");
  appStoreReviewDraftCount = Number(activeDraft?.itemCount || 0);
  const nextApp = { ...app, ...(currentAppStoreDetail?.app || {}), versions: currentAppStoreDetail?.versions || app.versions || [] };
  currentAppStoreApp = nextApp;
  appStoreApps = appStoreApps.map(item => String(item.id || "") === String(nextApp.id || "") ? { ...item, ...nextApp } : item);
  switchAppStorePane(nextApp, pane);
  return nextApp;
}

function updateCurrentAppStoreDetail(detail, options = {}) {
  if (!detail) return currentAppStoreDetail;
  const appId = String(currentAppStoreApp?.id || detail?.app?.id || "");
  if (options.clearCache && appId) clearAppStoreDetailCache(appId);
  currentAppStoreDetail = detail;
  if (appId) cacheAppStoreDetail(appId, currentAppStoreDetail, currentAppStoreDetail?.selectedVersion?.id || "");
  return currentAppStoreDetail;
}

async function fetchAppStoreDetail(app, versionId = "", force = false, options = {}) {
  const requestSeq = appStoreDetailRequestSeq;
  const mode = ["light", "release"].includes(options.mode) ? options.mode : "full";
  const key = appStoreDetailPendingKey(app.id, versionId, mode);
  if (!force) {
    const cached = getCachedAppStoreDetail(app.id, versionId, mode);
    if (cached) return { success: true, detail: cached, cached: true };
    if (appStoreDetailPending.has(key)) return appStoreDetailPending.get(key);
  }
  const request = window.appleDeveloper.appStoreAppDetail({ appId: app.id, versionId, mode });
  appStoreDetailPending.set(key, request);
  try {
    const result = await request;
    if (requestSeq === appStoreDetailRequestSeq && mode !== "light" && result?.success && result.detail) cacheAppStoreDetail(app.id, result.detail, versionId);
    return result;
  } finally {
    if (appStoreDetailPending.get(key) === request) appStoreDetailPending.delete(key);
  }
}

async function loadAppStoreDetail(app, pane = "release", versionId = "", options = {}) {
  const content = el("app-store-content");
  const requestId = ++appStoreDetailRequestSeq;
  const initialLoad = options.initial === true;
  const mode = pane === "release" ? "release" : "full";
  if (pane !== "review") {
    currentReviewSubmissionDetail = null;
    currentReviewSubmissionLoadingId = "";
  }
  const cached = !options.force ? getCachedAppStoreDetail(app.id, versionId, mode) : null;
  if (cached) {
    applyLoadedAppStoreDetail(app, cached, pane, versionId);
    if (initialLoad) closeAppStoreDetailLoading();
    autoSyncReviewGuidanceForApp(app, cached);
    return;
  }
  if (initialLoad) updateAppStoreDetailLoadingStatus("正在读取当前版本页面…");
  else renderAppStoreDetailLoadingVersion(app, versionId, pane);
  let result;
  try {
    result = await fetchAppStoreDetail(app, versionId, options.force === true, { mode });
  } catch (error) { result = { success: false, error: error.message }; }
  if (requestId !== appStoreDetailRequestSeq || currentAppStoreApp?.id !== app.id) return;
  if (initialLoad) closeAppStoreDetailLoading();
  if (!result?.success || !result.detail) {
    const target = initialLoad ? content : el("app-detail-main");
    if (target) target.innerHTML = `<div class="empty"><div class="empty-icon">!</div><strong>App 数据读取失败</strong><span>${escapeHTML(result?.error || "请稍后重试")}</span><button class="primary" id="app-detail-retry" type="button">重新加载</button></div>`;
    el("app-detail-retry")?.addEventListener("click", () => loadAppStoreDetail(app, pane, versionId, { initial: initialLoad, force: true }));
    return;
  }
  // No background full-page replacement: typed fields and TestFlight navigation
  // remain owned by the user after this page is displayed.
  applyLoadedAppStoreDetail(app, result.detail, pane, versionId);
  autoSyncReviewGuidanceForApp(app, result.detail);
}

async function refreshCurrentAppStoreView() {
  const app = currentAppStoreApp;
  const detailRoot = document.querySelector(".app-detail");
  if (detailRoot?.dataset.pane === "testflight") { detailRoot.tfRefresh?.(); return; }
  if (!app || !detailRoot) {
    await prepareAppStorePage();
    return;
  }
  try {
    if (!await ensureAppStoreTermsAccepted({ prompt: true })) {
      showAppStoreTermsRequiredState();
      return;
    }
  } catch (error) {
    showAppStoreTermsRequiredState(error.message || "App Store Connect 服务条款状态读取失败，请稍后重试。");
    return;
  }
  const pane = detailRoot.dataset.pane || "release";
  if (pane === "iap" && currentInAppPurchaseDetail?.id) {
    const previousDetail = currentInAppPurchaseDetail;
    const purchaseId = currentInAppPurchaseDetail.id;
    currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, loading: true };
    switchAppStorePane(app, "iap");
    const result = await window.appleDeveloper.appStoreInAppPurchaseDetail({ purchaseId, appId: app.id });
    currentInAppPurchaseDetail = result?.success ? result.detail : previousDetail;
    switchAppStorePane(app, "iap");
    if (!result?.success) showAppStoreError(result?.error || "刷新失败", "", "无法刷新当前 App 内购项目");
    return;
  }
  if (pane === "iap") {
    currentInAppPurchases = null;
    switchAppStorePane(app, "iap");
    return;
  }
  const currentVersionId = appStoreCurrentVersionId(currentAppStoreDetail);
  currentAppStoreDetail = null;
  clearAppStoreDetailCache(app.id, currentVersionId);
  const content = el("app-store-content");
  if (content) content.innerHTML = appStoreDetailShell(app, null, pane);
  await loadAppStoreDetail(app, pane, currentVersionId, { force: true });
}

function renderAppStorePane(app, detail, pane) {
  if (!detail || detail.loading) return '<section class="app-detail-panel"><div class="app-loading-title"><i class="loading-spinner"></i><h3>正在加载 App 详情</h3></div><div class="loading-state">正在读取版本、审核与销售信息，请稍候…</div></section>';
  if (pane === "history") return renderAppStoreHistoryPane(detail);
  if (pane === "review") return renderAppStoreReviewPane(detail, app);
  if (pane === "info") return renderAppStoreInfoPane(app, detail);
  if (pane === "privacy") return renderAppStorePrivacyPane(app, detail);
  if (pane === "pricing") return renderAppStorePricingPane(detail);
  if (pane === "iap") return renderAppStoreInAppPurchasePane();
  return renderAppStoreReleasePane(app, detail);
}

function appStoreInAppPurchaseTypeText(value) {
  return ({ CONSUMABLE: "消耗型", NON_CONSUMABLE: "非消耗型", NON_RENEWING_SUBSCRIPTION: "非续期订阅" })[value] || value || "—";
}

function isInAppPurchaseSubmittable(item = {}) {
  return /^(PREPARE_FOR_SUBMISSION|READY_TO_SUBMIT|DRAFT)$/.test(String(item.state || item.status || "").toUpperCase());
}

function formatAppStoreScheduleDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日` : String(value || "");
}

function renderAppStoreInAppPurchaseSchedule(item = {}) {
  const changes = Array.isArray(item.scheduledPriceChanges) ? item.scheduledPriceChanges : [];
  const endings = Array.isArray(item.endingPriceChanges) ? item.endingPriceChanges : [];
  const scheduleLoaded = item.priceScheduleLoaded !== false;
  const territoryCount = Number(item.currentPriceTerritoryCount || 0);
  const territoryLabel = scheduleLoaded ? `${territoryCount} 个国家或地区` : "读取失败";
  const download = `<button class="app-link-button app-iap-schedule-download" type="button" data-iap-current-prices>下载 ${PAID_AGREEMENT_DOWNLOAD_ICON}</button>`;
  const upcomingRows = changes.map(change => `<button class="app-link-button" type="button" data-iap-current-prices>${escapeHTML(formatAppStoreScheduleDate(change.startDate))}</button><button class="app-link-button" type="button" data-iap-current-prices>${escapeHTML(String(change.count || 1))} 个国家或地区</button><span>${escapeHTML(change.adjustment || "外汇汇率或税率调整")}</span>`).join("");
  const endingRows = endings.map(change => `<button class="app-link-button" type="button" data-iap-current-prices>价格于${escapeHTML(formatAppStoreScheduleDate(change.endDate))}结束</button><button class="app-link-button" type="button" data-iap-current-prices>${escapeHTML(String(change.count || 1))} 个国家或地区</button><span>可能进行自动调整</span>`).join("");
  const scheduleError = item.priceScheduleError ? `<p class="app-iap-schedule-error">${escapeHTML(item.priceScheduleError)}</p>` : "";
  return `<div class="app-iap-schedule-card"><button class="app-iap-schedule-toggle" data-iap-schedule-toggle type="button" aria-expanded="true"><span></span>App 内购买项目定价</button><div class="app-iap-schedule-body"><h4>所在国家或地区</h4><p>Apple 可能根据税率或外汇汇率的变化，不时自动调整除所在国家或地区以外所有国家或地区的价格。</p><div>${escapeHTML(item.baseTerritoryName || item.baseTerritoryId)} (${escapeHTML(item.currency || "")}) <button class="app-link-button" id="app-iap-pricing-edit" type="button">编辑</button></div>${changes.length ? `<div class="app-iap-schedule-subhead"><h4>即将进行的调整</h4>${download}</div><div class="app-price-table"><div>日期</div><div>国家或地区</div><div>价格调整</div>${upcomingRows}</div>` : ""}<div class="app-iap-schedule-subhead"><h4>价格</h4>${download}</div><div class="app-price-table"><div>日期</div><div>国家或地区</div><div>价格调整</div><button class="app-link-button" type="button" data-iap-current-prices>当前价格</button><button class="app-link-button" type="button" data-iap-current-prices>${escapeHTML(territoryLabel)}</button><span>可能进行自动调整</span>${endingRows}</div>${scheduleError}</div></div>`;
}

function renderAppStoreInAppPurchasePane() {
  if (currentInAppPurchaseDetail?.loading) return '<div class="app-iap-page"><button class="app-link-button" id="app-iap-back" type="button">‹ App 内购项目</button><div class="loading-state">正在读取 App 内购项目详情…</div></div>';
  if (currentInAppPurchaseDetail?.id) return renderAppStoreInAppPurchaseDetail();
  if (currentInAppPurchases === null) return '<div class="app-iap-page"><div class="app-iap-head"><h2>App 内购买项目</h2><button class="app-iap-plus" data-iap-create type="button">+</button></div><div class="loading-state">正在读取 App 内购买项目…</div></div>';
  const allRows = currentInAppPurchases || [];
  const query = inAppPurchaseListSearch.trim().toLowerCase();
  const rows = query ? allRows.filter(item => `${item.name} ${item.productId}`.toLowerCase().includes(query)) : allRows;
  const eligibleRows = rows.filter(isInAppPurchaseSubmittable);
  const checked = [...selectedInAppPurchaseIds].filter(id => eligibleRows.some(item => item.id === id)).length;
  return `<div class="app-iap-page"><div class="app-iap-head"><div><h2>App 内购买项目</h2><button class="app-iap-plus" id="app-iap-create" type="button" title="新建 App 内购买项目">+</button></div><div class="app-iap-search-wrap"><button class="app-iap-search" id="app-iap-search-toggle" type="button" aria-label="搜索"></button><input id="app-iap-search-input" value="${escapeHTML(inAppPurchaseListSearch)}" placeholder="搜索参考名称或产品 ID" ${inAppPurchaseListSearch ? "" : "hidden"}></div></div>${rows.length ? `<section class="app-iap-group"><div class="app-iap-group-head"><h3><span>⌄</span> ${escapeHTML(appStoreInAppPurchaseGroupText(rows))} (${rows.length})</h3><div>${inAppPurchaseListEditing ? `<button class="secondary" id="app-iap-edit-cancel" type="button">取消</button><button class="primary" id="app-iap-add-review" type="button" ${checked ? "" : "disabled"}>添加以供审核</button>` : '<button class="secondary" id="app-iap-edit" type="button">编辑</button>'}</div></div><div class="app-iap-table ${inAppPurchaseListEditing ? "editing" : ""}">${inAppPurchaseListEditing ? '<div class="head check"><input id="app-iap-select-all" type="checkbox"></div>' : ""}<div class="head">参考名称</div><div class="head">产品 ID</div><div class="head">类型</div><div class="head">状态</div>${rows.map(item => `<div class="app-iap-row" data-iap-id="${escapeHTML(item.id)}">${inAppPurchaseListEditing ? `<span class="check"><input data-iap-select="${escapeHTML(item.id)}" type="checkbox" ${selectedInAppPurchaseIds.has(item.id) ? "checked" : ""}></span>` : ""}<button type="button" data-iap-open="${escapeHTML(item.id)}">${escapeHTML(item.name || "—")}</button><span>${escapeHTML(item.productId || "—")}</span><span>${escapeHTML(appStoreInAppPurchaseTypeText(item.type))}</span><span class="app-iap-status ${escapeHTML(appStoreStateClass(item.state))}"><i></i>${escapeHTML(appStoreStatusText(item.state))}</span></div>`).join("")}</div></section>` : `<section class="app-iap-empty"><p>App 内购买项目允许客户通过访问 App Store 在你的 App 中购买内容、功能或服务，并可安全地处理用户的付款。<a>了解更多</a></p><p>首个 App 内购买项目必须随新 App 版本提交。创建 App 内购买项目，然后选择“添加以供审核”，并在提交时包含 App 版本，以便一起审核项目。</p><button class="primary" id="app-iap-create" type="button">创建</button></section>`}</div>`;
}

function renderAppStoreInAppPurchaseDetail() {
  const item = currentInAppPurchaseDetail || {};
  const priceText = item.hasPrice ? formatAppStorePrice(item.price, item.currency) : "";
  const purchaseType = appStoreInAppPurchaseTypeText(item.type);
  const addedToReview = !!item.reviewDraft;
  const displayState = String(item.reviewDraft?.submissionState || item.reviewDraft?.versionState || item.state || item.status || "").toUpperCase();
  return `<div class="app-iap-page app-iap-detail"><button class="app-link-button" id="app-iap-back" type="button">‹ App 内购项目</button>
    <div class="app-iap-detail-head"><div><h2>${escapeHTML(item.name || "未命名内购项目")}</h2></div><div><button class="secondary" id="app-iap-save" type="button" disabled>保存</button><button class="${addedToReview ? "secondary app-iap-added-review" : "primary"}" id="app-iap-add-review-detail" type="button" ${addedToReview || !item.versionId ? "disabled" : ""}>${addedToReview ? "✓ 添加以供审核" : "添加以供审核"}</button></div></div>
    <div class="app-iap-notice"><i>i</i>${addedToReview ? '<span>此项目已<b>添加以供审核</b>，但你仍可以<button class="app-link-button" id="app-iap-remove-review" type="button">移除项目</button>。</span>' : `<span>首个${escapeHTML(purchaseType)} App 内购买项目必须随新 App 版本提交。</span><button class="app-link-button" type="button">进一步了解</button>`}</div>
    <section class="app-iap-summary"><div class="app-iap-summary-left"><div class="app-iap-summary-status"><strong>状态</strong><span class="app-iap-status ${escapeHTML(appStoreStateClass(displayState || item.state))}"><i></i>${escapeHTML(appStoreStatusText(displayState || item.state) || "准备提交")}</span></div><label>参考名称 ${appStoreHelp("用于在 App Store Connect 中识别此 App 内购买项目，不会向顾客显示。") }<input id="app-iap-name" maxlength="64" value="${escapeHTML(item.name || "")}"><small>${64 - String(item.name || "").length}</small></label></div><dl><dt>产品 ID ${appStoreHelp("用于在你的 App 中引用此 App 内购买项目。")}</dt><dd>${escapeHTML(item.productId || "—")}</dd><dt>Apple ID ${appStoreHelp("Apple 为此 App 内购买项目分配的唯一标识符。")}</dt><dd>${escapeHTML(item.id || "—")}</dd></dl></section>
    <section class="app-price-section"><h3>销售范围</h3>${item.exists ? `<div class="app-iap-availability-summary"><div class="app-iap-sale-line"><label><input type="radio" name="iap-sale-state" ${item.availableCount ? "checked" : ""}> ${item.availableCount === item.total ? "已选择所有国家或地区" : `已选择 ${escapeHTML(String(item.availableCount || 0))} 个国家或地区（共 ${escapeHTML(String(item.total || 175))} 个）`}</label><button class="app-link-button" id="app-iap-availability" type="button" ${item.availableCount ? "" : "disabled"}>编辑</button></div><label><input id="app-iap-takedown" type="radio" name="iap-sale-state" ${item.availableCount ? "" : "checked"}> 下架</label>${item.availableCount ? "" : '<div class="app-iap-takedown-warning"><b>▲</b><span>移除后，App Store 将不再提供此 App 内购买。</span></div>'}</div>` : `<div class="app-iap-action-box"><span>请选择你想要提供 App 内购买的国家或地区。</span><button class="primary" id="app-iap-availability" type="button">设置供应情况</button></div>`}</section>
    <section class="app-price-section app-iap-schedule"><div class="app-iap-section-title"><h3>价格时间表${priceText ? '<button class="app-iap-plus" id="app-iap-pricing" type="button">+</button>' : ""}</h3><button class="app-link-button" data-iap-current-prices type="button">所有价格和货币</button></div>${priceText ? `<p class="app-price-note">以下是当前定价和所有即将进行的调整一览。</p>${renderAppStoreInAppPurchaseSchedule(item)}` : `<div class="app-iap-action-box"><span>设置初始价格。此价格将决定 App Store 定价和你的收入。如果 App 内购买项目为付费，你必须拥有付费应用程序协议。</span><button class="primary" id="app-iap-pricing" type="button">添加定价</button></div>`}</section>
    <section class="app-price-section"><h3>优惠代码</h3>${item.offerCodes?.length ? `<div class="app-iap-list">${item.offerCodes.map(code => `<div><strong>${escapeHTML(code.name || code.id)}</strong><span>${code.active ? "有效" : "已停用"}</span></div>`).join("")}</div>` : `<div class="app-iap-action-box"><span>创建优惠代码，让符合条件的用户免费或以优惠价格兑换此内购项目。</span><button class="secondary" type="button" disabled title="请先设置价格">创建优惠</button></div>`}</section>
    <section class="app-price-section app-iap-localization-section"><div class="app-iap-section-title"><h3>App Store 本地化版本 <button class="app-iap-plus" id="app-iap-localization-add" type="button">+</button></h3></div>${item.localizations?.length ? `<p class="app-iap-localization-copy">App Store 中将展示 App 内购买项目的本地化显示名称。若你将 App 内购买项目用于推广，则 App Store 中还会显示其本地化描述。 <button class="app-link-button" type="button">进一步了解</button></p><div class="app-iap-localization-table"><div>本地化版本</div><div>显示名称</div><div>描述</div>${item.localizations.map(loc => `<button type="button" data-iap-localization="${escapeHTML(loc.id)}">${escapeHTML(appStoreLocaleName(loc.locale))}</button><span>${escapeHTML(loc.name)}</span><span>${escapeHTML(loc.description)}</span>`).join("")}</div>` : '<div class="app-iap-localization-empty"><span>请为你的 App 内购买项目提供显示名称和描述，我们将在 App Store 上显示这些信息。</span><button class="primary" id="app-iap-localization-add-empty" type="button">添加本地化版本</button></div>'}</section>
    <section class="app-price-section app-iap-image-section"><h3>图像（可选）</h3><p>添加能够最好地展现此 App 内购买项目的图像，图像应为 1024 × 1024 像素。该图像将在优惠代码兑换时出现。如果你为该 App 内购买项目启用 App Store 推广，该图像也会出现在 App 产品页面上。 <button class="app-link-button" type="button">进一步了解</button></p><button class="app-iap-square-upload" type="button">选择文件</button></section>
    <section class="app-price-section app-iap-tax-section"><h3>税务类别 ${appStoreHelp("税费类别基于你 App 的内容而定，并且会确定适用于各领域内的哪些税务法规，使得 Apple 可以按照特定的比率向你收取税费。")}</h3><button class="app-link-button" type="button">编辑</button><p class="app-iap-tax-label">类别</p><p>${escapeHTML(item.taxCategory || "与主 App 匹配")}</p></section>
    <section class="app-price-section app-iap-review-section"><h3>审核信息</h3><div class="app-iap-review-grid"><label>截屏 ${appStoreHelp("上传一张能帮助 App 审核团队找到并测试此 App 内购买项目的截屏。")}<button class="app-iap-review-upload" id="app-iap-review-upload" type="button">${item.reviewScreenshotUrl ? `<img src="${escapeHTML(item.reviewScreenshotUrl)}" alt="审核截屏"><span>更换文件</span>` : "选择文件"}</button><div class="app-iap-review-error" id="app-iap-review-error" hidden></div></label><label>审核备注（可不填） ${appStoreHelp("有助于我们审核你 App 内购买项目的其他信息。")}<textarea id="app-iap-review-note" maxlength="4000">${escapeHTML(item.reviewNote || "")}</textarea><small>${4000 - String(item.reviewNote || "").length}</small></label></div></section><section class="app-iap-delete-section"><button id="app-iap-delete" type="button">删除此 App 内购买项目</button></section></div>`;
}

function openAppStoreInAppPurchaseDeleteModal() {
  const item = currentInAppPurchaseDetail || {};
  const modal = document.createElement("div");
  modal.className = "app-pricing-modal app-iap-delete-modal";
  modal.innerHTML = `<div class="app-iap-delete-dialog"><div class="app-iap-delete-body"><h2>要删除此 App 内购买项目吗?</h2><p>此 App 内购买项目将从你的 App 中永久移除，且无法恢复。与此 App 内购买项目关联的产品 ID 将无法再次使用。</p></div><div class="app-iap-delete-actions"><button class="secondary" data-close type="button">取消</button><button class="danger" data-delete type="button">删除</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("[data-delete]").onclick = async event => {
    const button = event.currentTarget;
    setBusy(button, true, "删除中…");
    const result = await window.appleDeveloper.deleteAppStoreInAppPurchase({ purchaseId: item.id, appId: currentAppStoreApp?.id || "" });
    if (!result?.success) {
      setBusy(button, false);
      return showAppStoreError(result?.error || "删除失败", "", "无法删除 App 内购买项目");
    }
    currentInAppPurchases = Array.isArray(result.purchases) ? result.purchases : (currentInAppPurchases || []).filter(row => row.id !== item.id);
    currentInAppPurchaseDetail = null;
    inAppPurchaseListEditing = false;
    selectedInAppPurchaseIds.clear();
    modal.remove();
    switchAppStorePane(currentAppStoreApp, "iap");
  };
}

async function openAppStoreInAppPurchaseLocalizationModal(localizationId = "") {
  const item = currentInAppPurchaseDetail || {};
  const existing = (item.localizations || []).find(loc => loc.id === localizationId) || {};
  const localeResult = await window.appleDeveloper.appStoreInAppPurchaseLocales().catch(() => ({}));
  const usedLocales = new Set((item.localizations || []).map(loc => String(loc.locale || "")));
  const localeOptions = (localeResult.locales || []).filter(locale => existing.id ? locale.code === existing.locale : !usedLocales.has(locale.code));
  const modal = document.createElement("div"); modal.className = "app-pricing-modal";
  const selectedLocaleName = localeOptions.find(locale => locale.code === existing.locale)?.name || "请选择...";
  modal.innerHTML = `<form class="app-pricing-dialog app-iap-localization-dialog"><div class="app-pricing-dialog-body"><h2>${existing.id ? "编辑" : "添加"} App Store 本地化版本</h2><label>本地化版本<div class="app-iap-locale-picker"><input name="locale" type="hidden" value="${escapeHTML(existing.locale || "")}"><button class="app-iap-locale-trigger" data-locale-trigger type="button" aria-haspopup="listbox" aria-expanded="false" ${existing.id ? "disabled" : ""}>${escapeHTML(selectedLocaleName)}</button><div class="app-iap-locale-options" data-locale-options role="listbox" hidden>${localeOptions.map(locale => `<button type="button" role="option" data-locale="${escapeHTML(locale.code)}">${escapeHTML(locale.name)}</button>`).join("")}</div></div></label><label>显示名称<input name="name" maxlength="35" value="${escapeHTML(existing.name || "")}" required><small data-name-count>35</small></label><label>描述<textarea name="description" maxlength="55" required>${escapeHTML(existing.description || "")}</textarea><small data-description-count>55</small></label><div class="app-pricing-message">${!existing.id && !localeOptions.length ? "所有支持的语言均已添加。" : ""}</div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" type="submit" disabled>保存</button></div></form>`;
  appendAppStoreModal(modal); const form = modal.querySelector("form");
  const localeTrigger = form.querySelector("[data-locale-trigger]"), localeOptionsPanel = form.querySelector("[data-locale-options]");
  localeTrigger?.addEventListener("click", () => { localeOptionsPanel.hidden = !localeOptionsPanel.hidden; localeTrigger.setAttribute("aria-expanded", localeOptionsPanel.hidden ? "false" : "true"); });
  localeOptionsPanel?.querySelectorAll("[data-locale]").forEach(button => button.addEventListener("click", () => { form.elements.locale.value = button.dataset.locale; localeTrigger.textContent = button.textContent; localeOptionsPanel.hidden = true; localeTrigger.setAttribute("aria-expanded", "false"); form.elements.locale.dispatchEvent(new Event("change")); }));
  const updateLocalizationForm = () => {
    form.querySelector("[data-name-count]").textContent = String(35 - form.elements.name.value.length);
    form.querySelector("[data-description-count]").textContent = String(55 - form.elements.description.value.length);
    form.querySelector('[type="submit"]').disabled = !(form.elements.locale.value && form.elements.name.value.trim() && form.elements.description.value.trim());
  };
  form.elements.locale.addEventListener("change", updateLocalizationForm); form.elements.name.addEventListener("input", updateLocalizationForm); form.elements.description.addEventListener("input", updateLocalizationForm); updateLocalizationForm();
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector('[type="submit"]'); setBusy(button, true, "保存中…"); const result = await window.appleDeveloper.saveAppStoreInAppPurchaseLocalization({ purchaseId: item.id, localizationId: existing.id, locale: existing.locale || form.elements.locale.value, name: form.elements.name.value, description: form.elements.description.value }); if (!result?.success) { setBusy(button, false); const rawError = result?.error || "保存失败"; form.querySelector(".app-pricing-message").textContent = /locale code.+already exists|already exists.+locale/i.test(rawError) ? "该语言的本地化版本已经存在，请刷新详情后直接编辑。" : rawError; return; } currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.detail }; modal.remove(); switchAppStorePane(currentAppStoreApp, "iap"); };
}

function openAppStoreInAppPurchaseReviewModal() {
  const item = currentInAppPurchaseDetail || {}, modal = document.createElement("div"); modal.className = "app-pricing-modal";
  modal.innerHTML = `<form class="app-pricing-dialog"><div class="app-pricing-dialog-body"><h2>审核信息</h2><p>可填写帮助 App 审核团队测试此内购项目的信息。</p><label>审核备注（可不填）<textarea name="reviewNote" maxlength="4000">${escapeHTML(item.reviewNote || "")}</textarea></label><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" type="submit">保存</button></div></form>`;
  appendAppStoreModal(modal); modal.querySelector("[data-close]").onclick = () => modal.remove(); modal.querySelector("form").onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type="submit"]'); setBusy(button, true, "保存中…"); const result = await window.appleDeveloper.saveAppStoreInAppPurchase({ purchaseId: item.id, reviewNote: form.elements.reviewNote.value }); if (!result?.success) { setBusy(button, false); form.querySelector(".app-pricing-message").textContent = result?.error || "保存失败"; return; } currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.detail }; modal.remove(); switchAppStorePane(currentAppStoreApp, "iap"); };
}

async function openAppStoreInAppPurchaseDetail(purchaseId) {
  currentInAppPurchaseDetail = { id: String(purchaseId || ""), loading: true };
  switchAppStorePane(currentAppStoreApp, "iap");
  const [detailResult, availabilityResult] = await Promise.all([
    window.appleDeveloper.appStoreInAppPurchaseDetail({ purchaseId, appId: currentAppStoreApp?.id || "" }),
    window.appleDeveloper.appStoreInAppPurchaseAvailability(purchaseId),
  ]);
  if (!detailResult?.success) {
    currentInAppPurchaseDetail = null;
    switchAppStorePane(currentAppStoreApp, "iap");
    showAppStoreError(detailResult?.error || "详情读取失败", "", "App 内购项目读取失败");
    return;
  }
  currentInAppPurchaseDetail = { ...detailResult.detail, ...(availabilityResult?.success ? availabilityResult.availability : {}) };
  switchAppStorePane(currentAppStoreApp, "iap");
}

async function loadAppStoreInAppPurchases(app) {
  currentInAppPurchaseDetail = null;
  const result = await window.appleDeveloper.appStoreInAppPurchases(app.id);
  if (!result?.success) currentInAppPurchases = [];
  else currentInAppPurchases = result.purchases || [];
  switchAppStorePane(app, "iap");
  if (!result?.success) showAppStoreError(result?.error || "读取失败", "", "App 内购买项目读取失败");
}

function openAppStoreInAppPurchaseModal() {
  if (document.getElementById("app-iap-modal")) return;
  const modal = document.createElement("div");
  modal.className = "app-pricing-modal"; modal.id = "app-iap-modal";
  modal.innerHTML = `<form class="app-pricing-dialog app-iap-dialog"><div class="app-pricing-dialog-body"><h2>创建 App 内购买项目</h2><p>App 内购项目允许客户在 App 中购买内容、功能或服务。创建后产品 ID 不能修改。</p><label>类型<select name="type" required><option value="">请选择…</option><option value="CONSUMABLE">消耗型项目</option><option value="NON_CONSUMABLE">非消耗型项目</option></select></label><label>参考名称<input name="name" maxlength="64" required placeholder="仅在 App Store Connect 中显示"></label><label>产品 ID<input name="productId" maxlength="100" required placeholder="例如 com.company.app.coins100"></label><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" type="submit">创建</button></div></form>`;
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("form").onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget; const button = form.querySelector('[type="submit"]'); const message = form.querySelector(".app-pricing-message");
    setBusy(button, true, "创建中…");
    const result = await window.appleDeveloper.createAppStoreInAppPurchase({ appId: currentAppStoreApp?.id, type: form.elements.type.value, name: form.elements.name.value.trim(), productId: form.elements.productId.value.trim() });
    setBusy(button, false);
    if (!result?.success) { message.textContent = result?.error || "创建失败"; return; }
    currentInAppPurchases = result.purchases || [];
    modal.remove();
    if (result.created?.id) openAppStoreInAppPurchaseDetail(result.created.id);
    else switchAppStorePane(currentAppStoreApp, "iap");
  };
  document.body.appendChild(modal);
}

async function openAppStoreInAppPurchaseAvailabilityModal() {
  const purchaseId = String(currentInAppPurchaseDetail?.id || "");
  if (!purchaseId || document.getElementById("app-iap-availability-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-iap-availability-modal"; modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-territory-dialog"><div class="app-pricing-dialog-body app-territory-body"><div class="app-territory-head"><h2>国家或地区供应情况 (<span data-selected-count>0</span>)</h2><span>选择 <button data-select-all type="button">全部</button><i>|</i><button data-select-none type="button">无</button></span></div><div id="app-iap-availability-loading">正在读取国家或地区…</div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-save type="button" disabled>完成</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  const result = await window.appleDeveloper.appStoreInAppPurchaseAvailability(purchaseId);
  if (!result?.success) { modal.querySelector("#app-iap-availability-loading").textContent = result?.error || "销售范围读取失败"; return; }
  const territories = result.availability?.territories || [];
  const original = new Set(territories.filter(item => item.available).map(item => item.id));
  modal.querySelector("#app-iap-availability-loading").outerHTML = appStoreTerritoryPicker(groupAppStoreTerritories(territories), original, "iap-availability") + `<label class="app-availability-future"><input id="app-iap-availability-future" type="checkbox" ${result.availability?.availableInNewTerritories !== false ? "checked" : ""}> 在将来的所有 App Store 国家或地区中自动提供 App 内购买。</label>`;
  const picker = wireAppStoreTerritoryPicker(modal, original, { allowUnchanged: true });
  const save = modal.querySelector("[data-save]");
  save.disabled = false;
  save.addEventListener("click", async () => {
    setBusy(save, true, "正在保存…");
    const saved = await window.appleDeveloper.saveAppStoreInAppPurchaseAvailability({ purchaseId, territoryIds: picker.selectedIds(), availableInNewTerritories: modal.querySelector("#app-iap-availability-future").checked });
    if (!saved?.success) { setBusy(save, false); alert(saved?.error || "销售范围保存失败"); return; }
    currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...saved.availability };
    modal.remove(); switchAppStorePane(currentAppStoreApp, "iap");
  });
}

async function openAppStoreInAppPurchaseCurrentPriceModal() {
  const item = currentInAppPurchaseDetail || {};
  const purchaseId = String(item.id || "");
  const pricePointId = String(item.pricePointId || "");
  const currentTerritoryIds = new Set(Array.isArray(item.currentPriceTerritoryIds) ? item.currentPriceTerritoryIds.map(String) : []);
  const expectedTerritoryCount = Number(item.currentPriceTerritoryCount || currentTerritoryIds.size || item.priceTerritoryCount || 0);
  if (!purchaseId || !pricePointId || document.getElementById("app-iap-current-price-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-iap-current-price-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-iap-current-price-dialog"><div class="app-pricing-dialog-body"><div class="app-iap-current-price-head"><h2>当前价格</h2><button class="app-link-button app-iap-current-price-download" data-download type="button">${PAID_AGREEMENT_DOWNLOAD_ICON}<span>下载</span></button></div><div class="app-iap-current-price-table"><div class="head">国家或地区 (${escapeHTML(String(expectedTerritoryCount))})</div><div class="head">价格</div><div class="head">收入</div><div class="loading-state">正在读取价格…</div></div><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">关闭</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  modal.querySelector("[data-close]").onclick = close;
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  const table = modal.querySelector(".app-iap-current-price-table");
  const message = modal.querySelector(".app-pricing-message");
  const download = modal.querySelector("[data-download]");
  download.onclick = async () => {
    setBusy(download, true, "下载中…");
    message.textContent = "";
    const result = await window.appleDeveloper.downloadAppStoreInAppPurchasePricing({
      appId: currentAppStoreApp?.id || "",
      purchaseId,
      pricePointId,
      name: item.name || "",
    }).catch(error => ({ success: false, error: error.message }));
    setBusy(download, false);
    download.innerHTML = `${PAID_AGREEMENT_DOWNLOAD_ICON}<span>下载</span>`;
    if (!result?.success && !result?.canceled) message.textContent = result?.error || "价格表下载失败";
  };
  const result = await window.appleDeveloper.appStoreInAppPurchasePriceEqualizations(pricePointId).catch(error => ({ success: false, error: error.message }));
  if (!result?.success) {
    table.innerHTML = `<div class="head">国家或地区</div><div class="head">价格</div><div class="head">收入</div><div class="app-iap-current-price-error">${escapeHTML(result?.error || "价格读取失败")}</div>`;
    return;
  }
  const base = {
    territoryId: item.baseTerritoryId,
    name: item.baseTerritoryName || item.baseTerritoryId,
    currency: item.currency,
    price: item.price,
    proceeds: item.proceeds,
  };
  const allRows = base.territoryId
    ? [base, ...(result.prices || []).filter(row => row.territoryId !== base.territoryId)]
    : (result.prices || []);
  const rows = currentTerritoryIds.size
    ? allRows.filter(row => currentTerritoryIds.has(String(row.territoryId || "")))
    : allRows;
  table.innerHTML = `<div class="head">国家或地区 (${rows.length})</div><div class="head">价格</div><div class="head">收入</div>${rows.map(row => `<strong>${escapeHTML(`${row.name || row.territoryId} (${row.currency || ""})`)}</strong><span>${escapeHTML(formatAppStorePrice(row.price, row.currency))}</span><span>${escapeHTML(formatAppStorePrice(row.proceeds, row.currency))}</span>`).join("")}`;
}

async function openAppStoreInAppPurchasePricingModal() {
  const purchaseId = String(currentInAppPurchaseDetail?.id || "");
  if (!purchaseId || document.getElementById("app-iap-pricing-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-iap-pricing-modal"; modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-iap-pricing-dialog"><div class="app-pricing-dialog-body" data-wizard-body><h2>${currentInAppPurchaseDetail?.hasPrice ? "要编辑所在国家或地区吗？" : "App 内购买项目定价"}</h2><p>请选取所在国家或地区。Apple 可能根据税率或外汇汇率的变化，不时自动调整除所在国家或地区外所有国家或地区的价格。</p><label>所在国家或地区<div class="app-iap-price-anchor"><select id="app-iap-price-territory" hidden><option>正在读取…</option></select><button class="app-iap-price-trigger" id="app-iap-territory-trigger" type="button" disabled>正在读取…</button><div class="app-iap-price-popover" id="app-iap-territory-popover" hidden><div class="app-iap-price-search"><span>⌕</span><input id="app-iap-territory-search" type="search" placeholder="搜索"></div><div class="app-iap-price-options" id="app-iap-territory-options"></div></div></div></label><hr><p>请为所在国家或地区选取新价格。Apple 将根据税率或外汇汇率，为所有其他国家或地区提供相应价格。你可以在下一步编辑单个国家或地区的价格。</p><label>价格<div class="app-iap-price-anchor"><button class="app-iap-price-trigger" id="app-iap-price-trigger" type="button" disabled>选取</button><div class="app-iap-price-popover" id="app-iap-price-popover" hidden><div class="app-iap-price-search"><span>⌕</span><input id="app-iap-price-search" type="search" placeholder="搜索"></div><div class="app-iap-price-options" id="app-iap-price-options"></div></div></div></label><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-back type="button" hidden>返回</button><span class="app-pricing-action-spacer"></span><button class="secondary" data-close type="button">取消</button><button class="primary" data-save type="button" disabled>下一步</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  const territory = modal.querySelector("#app-iap-price-territory");
  const trigger = modal.querySelector("#app-iap-price-trigger");
  const popover = modal.querySelector("#app-iap-price-popover");
  const save = modal.querySelector("[data-save]");
  const back = modal.querySelector("[data-back]");
  const message = modal.querySelector(".app-pricing-message");
  let allTerritories = [], allPricePoints = [], currentCurrency = "USD", selectedPointId = "", equalizedPrices = [], wizardStep = 1;
  const renderPoints = () => { const q = modal.querySelector("#app-iap-price-search").value.trim().toLowerCase(); modal.querySelector("#app-iap-price-options").innerHTML = allPricePoints.filter(item => !q || `${item.price} ${formatAppStorePrice(item.price, currentCurrency)}`.toLowerCase().includes(q)).map(item => `<button type="button" data-price-point="${escapeHTML(item.id)}" class="${item.id === selectedPointId ? "active" : ""}">${item.id === selectedPointId ? "✓ " : ""}${escapeHTML(formatAppStorePrice(item.price, currentCurrency))}</button>`).join("") || '<div class="app-iap-price-no-result">没有匹配的价格</div>'; modal.querySelectorAll("[data-price-point]").forEach(button => button.onclick = () => { selectedPointId = button.dataset.pricePoint; trigger.textContent = button.textContent.replace(/^✓\s*/, ""); save.disabled = false; popover.hidden = true; renderPoints(); }); };
  const loadPoints = async () => {
    trigger.disabled = true; save.disabled = true; selectedPointId = ""; trigger.textContent = "正在读取…";
    const result = await window.appleDeveloper.appStoreInAppPurchasePricingOptions({ purchaseId, territoryId: territory.value });
    if (!result?.success) { trigger.textContent = "读取失败"; message.textContent = result?.error || "价格读取失败"; return; }
    currentCurrency = territory.selectedOptions[0]?.dataset.currency || "USD"; allPricePoints = result.pricePoints || [];
    const existingPointId = territory.value === currentInAppPurchaseDetail?.baseTerritoryId ? String(currentInAppPurchaseDetail?.pricePointId || "") : "";
    if (existingPointId && allPricePoints.some(item => item.id === existingPointId)) { selectedPointId = existingPointId; const selected = allPricePoints.find(item => item.id === existingPointId); trigger.textContent = formatAppStorePrice(selected.price, currentCurrency); save.disabled = false; } else trigger.textContent = "选取";
    trigger.disabled = false; renderPoints();
  };
  territory.addEventListener("change", loadPoints);
  trigger.addEventListener("click", () => { popover.hidden = !popover.hidden; if (!popover.hidden) setTimeout(() => modal.querySelector("#app-iap-price-search").focus(), 0); });
  modal.querySelector("#app-iap-price-search").addEventListener("input", renderPoints);
  const renderTerritoryPrices = confirming => {
    wizardStep = confirming ? 3 : 2; back.hidden = false; save.textContent = confirming ? "确认" : "下一步";
    const base = { territoryId: territory.value, name: territory.selectedOptions[0]?.textContent?.replace(/\s*\([^)]*\)$/, "") || territory.value, currency: currentCurrency, price: allPricePoints.find(item => item.id === selectedPointId)?.price || "" };
    const rows = confirming ? [base, ...equalizedPrices] : equalizedPrices;
    modal.querySelector("[data-wizard-body]").innerHTML = `<h2>${confirming ? "确认 App 内购买项目定价" : "国家或地区价格"}</h2><p>${confirming ? "App 内购买项目定价将在 App 状态为“可供销售”时生效。" : `以下是基于所在国家或地区换算的所有国家或地区的相应价格。你可以针对单个国家或地区选取不同价格。`}</p>${confirming ? "" : `<p><strong>所在国家或地区价格：</strong>${escapeHTML(territory.selectedOptions[0]?.textContent || territory.value)} - ${escapeHTML(formatAppStorePrice(base.price, base.currency))}</p>`}<div class="app-iap-country-price-table"><div class="head">国家或地区 (${rows.length})</div><div class="head">价格</div>${rows.map((row, index) => `<strong>${escapeHTML(`${row.name || row.territoryId} (${row.currency || ""})`)}</strong><button type="button" ${confirming || index === 0 && row.territoryId === base.territoryId ? "disabled" : ""}>${escapeHTML(formatAppStorePrice(row.price, row.currency))}${confirming ? "" : "⌄"}</button>`).join("")}</div>`;
  };
  save.addEventListener("click", async () => {
    if (wizardStep === 1) { setBusy(save, true, "正在换算…"); const result = await window.appleDeveloper.appStoreInAppPurchasePriceEqualizations(selectedPointId); setBusy(save, false); if (!result?.success) { message.textContent = result?.error || "国家或地区价格读取失败"; return; } equalizedPrices = result.prices || []; renderTerritoryPrices(false); return; }
    if (wizardStep === 2) { renderTerritoryPrices(true); return; }
    setBusy(save, true, "正在确认…"); const result = await window.appleDeveloper.saveAppStoreInAppPurchasePricing({ purchaseId, territoryId: territory.value, pricePointId: selectedPointId }); if (!result?.success) { setBusy(save, false); modal.querySelector("[data-wizard-body]").insertAdjacentHTML("beforeend", `<div class="app-pricing-message">${escapeHTML(result?.error || "价格保存失败")}</div>`); return; } currentInAppPurchaseDetail = { ...currentInAppPurchaseDetail, ...result.detail }; modal.remove(); await openAppStoreInAppPurchaseDetail(purchaseId);
  });
  back.addEventListener("click", () => { if (wizardStep === 3) renderTerritoryPrices(false); else { modal.remove(); openAppStoreInAppPurchasePricingModal(); } });
  const result = await window.appleDeveloper.appStoreInAppPurchasePricingOptions({ purchaseId });
  if (!result?.success) { territory.innerHTML = "<option>读取失败</option>"; message.textContent = result?.error || "国家或地区读取失败"; return; }
  const territories = result.territories || []; allTerritories = territories;
  territory.innerHTML = territories.map(item => `<option value="${escapeHTML(item.id)}" data-currency="${escapeHTML(item.currency)}">${escapeHTML(`${item.name} (${item.currency})`)}</option>`).join("");
  territory.disabled = false;
  const preferred = currentInAppPurchaseDetail?.baseTerritoryId || "CHN";
  const index = territories.findIndex(item => item.id === preferred);
  territory.selectedIndex = index >= 0 ? index : 0;
  const territoryTrigger = modal.querySelector("#app-iap-territory-trigger"), territoryPopover = modal.querySelector("#app-iap-territory-popover");
  const renderTerritories = () => { const q = modal.querySelector("#app-iap-territory-search").value.trim().toLowerCase(); modal.querySelector("#app-iap-territory-options").innerHTML = allTerritories.filter(item => !q || `${item.name} ${item.id} ${item.currency}`.toLowerCase().includes(q)).map(item => `<button type="button" data-territory-id="${escapeHTML(item.id)}" class="${item.id === territory.value ? "active" : ""}">${item.id === territory.value ? "✓ " : ""}${escapeHTML(`${item.name} (${item.currency})`)}</button>`).join(""); modal.querySelectorAll("[data-territory-id]").forEach(button => button.onclick = () => { territory.value = button.dataset.territoryId; territoryTrigger.textContent = button.textContent.replace(/^✓\s*/, ""); territoryPopover.hidden = true; territory.dispatchEvent(new Event("change")); renderTerritories(); }); };
  territoryTrigger.textContent = territory.selectedOptions[0]?.textContent; territoryTrigger.disabled = false; territoryTrigger.onclick = () => { territoryPopover.hidden = !territoryPopover.hidden; if (!territoryPopover.hidden) setTimeout(() => modal.querySelector("#app-iap-territory-search").focus(), 0); }; modal.querySelector("#app-iap-territory-search").oninput = renderTerritories; renderTerritories();
  await loadPoints();
}

function openAppStoreInAppPurchasePricingEditConfirm() {
  const item = currentInAppPurchaseDetail || {}, modal = document.createElement("div"); modal.className = "app-pricing-modal";
  const currentTerritoryCount = Number(item.currentPriceTerritoryCount || item.priceTerritoryCount || 0);
  modal.innerHTML = `<div class="app-pricing-dialog app-iap-edit-price-dialog"><div class="app-pricing-dialog-body"><h2>要编辑所在国家或地区吗？</h2><p>更改所在国家或地区将自动更新所有国家或地区的价格。App 内购买项目定价将立即生效。</p><label class="app-check"><input type="checkbox" data-confirm-delete> 我明白以下信息将永久删除。</label><div class="app-price-table"><div>开始日期 / 结束日期</div><div>国家或地区</div><span>当前价格/无结束日期</span><span>${escapeHTML(String(currentTerritoryCount))} 个国家或地区</span></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-edit type="button" disabled>编辑</button></div></div>`;
  appendAppStoreModal(modal); modal.querySelector("[data-close]").onclick = () => modal.remove(); const edit = modal.querySelector("[data-edit]"); modal.querySelector("[data-confirm-delete]").onchange = event => { edit.disabled = !event.target.checked; }; edit.onclick = () => { modal.remove(); openAppStoreInAppPurchasePricingModal().then(() => { const pricingModal = document.getElementById("app-iap-pricing-modal"); if (pricingModal) pricingModal.dataset.replacePriceId = item.priceId || ""; }); };
}

function renderAppStorePricingExtraSections(detail, draft = null) {
  const settings = detail?.pricingSettings || {};
  const mac = settings.mac || {};
  const vision = settings.vision || {};
  const distribution = settings.distribution || {};
  const versions = (settings.versions || []).filter(item => item.platform === "IOS");
  const isIosApp = (detail?.versions || []).some(item => item.platform === "IOS") || detail?.selectedVersion?.platform === "IOS";
  const distributionLockedState = /^(READY_FOR_SALE|READY_FOR_DISTRIBUTION|AVAILABLE_FOR_SALE|PENDING_APPLE_RELEASE|PENDING_DEVELOPER_RELEASE|IN_REVIEW|PROCESSING_FOR_APP_STORE)$/;
  const locked = (settings.versions || detail?.versions || []).some(item => distributionLockedState.test(String(item.state || "")))
    || distributionLockedState.test(String(detail?.app?.status || ""));
  const macAvailable = draft && mac.loaded ? draft.macAvailable : mac.available;
  const macMinVersion = draft && mac.loaded ? draft.macMinVersion : mac.minVersion;
  const visionAvailable = draft && vision.loaded ? draft.visionAvailable : vision.available;
  const distributionType = draft && distribution.loaded ? draft.distributionType : distribution.type;
  const educationDiscount = draft && distribution.loaded ? draft.educationDiscount : distribution.educationDiscount;
  const versionDownloadable = item => draft?.versions && Object.hasOwn(draft.versions, item.id) ? draft.versions[item.id] : item.downloadable;
  const downloadableCount = versions.filter(versionDownloadable).length;
  const versionSummary = settings.versionsLoaded ? (versions.length && downloadableCount === versions.length ? "全部" : `${downloadableCount} / ${versions.length}`) : "暂不可用";
  return `${isIosApp ? `<section class="app-price-section app-platform-section">
    <h3>搭载 Apple 芯片的 Mac 上的 iPhone App 和 iPad App</h3>
    <p class="app-price-note">兼容的 iPhone App 和 iPad App 可在搭载 Apple 芯片的 Mac 上提供，并使用与 iOS、iPadOS 相同的框架和运行环境。 <a href="https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-macs-with-apple-silicon" target="_blank" rel="noopener noreferrer">了解更多</a></p>
    <h4>搭载 Apple 芯片的 Mac 上的可用性</h4>
    <p class="app-price-note">选择是否在 Mac App Store 中提供此 App，并可指定兼容所需的最低 macOS 版本。</p>
    ${mac.loaded ? `<div class="app-price-control-row"><label><input id="app-price-mac-available" type="checkbox" ${macAvailable ? "checked" : ""}> 提供此 App</label><select id="app-price-mac-version" aria-label="最低 macOS 版本" ${macAvailable ? "" : "disabled"}><option value="" ${macMinVersion ? "" : "selected"}>自动 (macOS ${escapeHTML(mac.automaticMinVersion || "—")})</option>${(mac.supportedVersions || []).map(version => `<option value="${escapeHTML(version)}" ${macMinVersion === version ? "selected" : ""}>macOS ${escapeHTML(version)}</option>`).join("")}</select></div>` : '<p class="app-price-unavailable">Mac 提供设置暂未读取成功，请刷新后重试。</p>'}
    <h4>与搭载 Apple 芯片的 Mac 的兼容性</h4>
    <p class="app-price-note">${mac.verified ? "此 App 的 Mac 兼容性已验证。" : "此 App 的 Mac 兼容性尚未验证。如果已完成测试，可验证兼容性。"}</p>
    ${mac.loaded && !mac.verified ? `<button class="app-link-button" id="app-price-mac-verify" type="button" ${mac.available ? "" : 'disabled title="请先保存 Mac 提供设置"'}>验证兼容性</button>` : ""}
    ${versions.length ? `<p class="app-price-compatible-line">${versions.map(item => `版本 ${escapeHTML(item.version || "—")}`).join(" · ")}</p>` : ""}
  </section>
  <section class="app-price-section app-platform-section">
    <h3>Apple Vision Pro 上的 iPhone 和 iPad App</h3>
    <p class="app-price-note">兼容的 iPhone App 和 iPad App 可在 Apple Vision Pro 上本地运行。 <a href="https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-apple-vision-pro" target="_blank" rel="noopener noreferrer">了解更多</a></p>
    <h4>Apple Vision Pro 提供情况</h4>
    ${vision.loaded ? `<label class="app-price-check"><input id="app-price-vision-available" type="checkbox" ${visionAvailable ? "checked" : ""}> 在 Apple Vision Pro 上提供此 App</label>` : '<p class="app-price-unavailable">Apple Vision Pro 提供设置暂未读取成功，请刷新后重试。</p>'}
    ${versions.length ? `<h4>兼容性</h4><p class="app-price-compatible-line">${versions.map(item => `版本 ${escapeHTML(item.version || "—")}`).join(" · ")}</p>` : ""}
  </section>` : ""}
  <section class="app-price-section app-distribution-section">
    <h3>App 分发方式</h3>
    <p class="app-price-note">请选择希望如何向用户分发 App。App 获批后，分发方式无法更改。 <a href="https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods" target="_blank" rel="noopener noreferrer">了解更多</a></p>
    ${distribution.loaded ? `<div class="app-price-distribution-options"><label><input name="app-price-distribution" type="radio" value="APP_STORE" ${distributionType === "APP_STORE" ? "checked" : ""} ${locked ? "disabled" : ""}> 公开 — 在 App Store 上对所有人可见（默认）</label><label class="app-price-discount"><input id="app-price-education-discount" type="checkbox" ${educationDiscount ? "checked" : ""} ${distributionType === "APP_STORE" ? "" : "disabled"}> 在 Apple 校园教务管理中提供批量购买优惠价格</label><label><input name="app-price-distribution" type="radio" value="CUSTOM" ${distributionType === "CUSTOM" ? "checked" : ""} ${locked ? "disabled" : ""}> 专属 — 在 Apple 商务管理或 Apple 校园教务管理中作为自定义 App 提供</label></div>` : '<p class="app-price-unavailable">App 分发方式暂未读取成功，请刷新后重试。</p>'}
  </section>
  <section class="app-price-section app-compatible-section"><details id="app-price-compatible"><summary>上个兼容版本的设置</summary><p class="app-price-note">决定哪些旧版本可供使用旧设备的客户从 iCloud 下载。当前 App Store 版本始终可用。</p><table class="app-main-price-table"><thead><tr><th>平台</th><th>可用版本</th></tr></thead><tbody><tr><td>iOS</td><td><button class="app-link-button" id="app-price-compatible-edit" type="button" ${settings.versionsLoaded && versions.length ? "" : "disabled"}><span id="app-price-compatible-summary">${escapeHTML(versionSummary)}</span></button></td></tr></tbody></table></details></section>
  <div class="app-price-stop-sale">${detail?.availability?.availableCount > 0 ? '<button class="app-link-button" id="app-price-stop-sale" type="button">停止销售 App</button>' : '<span>此 App 当前未在任何国家或地区开启供应。可在“App 供应情况”中重新设置。</span>'}</div>`;
}

function renderAppStorePricingPane(detail) {
  const pricing = detail?.pricing || {};
  const availability = detail?.availability || {};
  const priceText = pricing.basePrice || formatAppStorePrice(pricing.price, pricing.currency);
  const hasPrice = !!pricing.hasPrice || !!priceText;
  const priceCount = pricing.priceScheduleLoaded && Number.isFinite(Number(pricing.currentPriceTerritoryCount))
    ? Number(pricing.currentPriceTerritoryCount) : null;
  const priceCountText = priceCount > 0 ? `${priceCount} 个国家或地区` : "查看国家或地区价格";
  const total = Number(availability.total || availability.territories?.length || 0);
  const selected = Number(availability.availableCount || 0);
  const statusCount = availability.statusCount || {};
  const hasSalesStatus = total > 0 && Number(statusCount.unknown) === 0
    && ["available", "processing", "unavailable"].every(key => Number.isFinite(Number(statusCount[key])))
    && Number(statusCount.available) + Number(statusCount.processing) + Number(statusCount.unavailable) === total;
  const supplySummary = hasSalesStatus
    ? `<div class="app-main-supply-status"><span class="app-main-supply-item available"><i></i><strong>${Number(statusCount.available)}</strong> 个可供货</span><span class="app-main-supply-item processing"><i></i><strong>${Number(statusCount.processing)}</strong> 个正在处理</span><span class="app-main-supply-item unavailable"><i></i><strong>${Number(statusCount.unavailable)}</strong> 个无法销售</span></div>`
    : `<div class="app-main-supply-status"><span class="app-main-supply-item selected"><i></i><strong>${selected}</strong> 个已开启供应</span><span class="app-main-supply-item not-selected"><i></i><strong>${Math.max(0, total - selected)}</strong> 个未开启</span></div><p class="app-main-supply-hint">Apple 暂未返回各地区的销售处理状态，此处显示供应范围设置。</p>`;
  const showPreorder = !appStoreVersionIsDistributable(detail?.selectedVersion || {}, detail?.app?.status);
  const draft = appStorePricingDraft?.appId === String(detail?.app?.id || "") ? appStorePricingDraft : null;
  return `<div class="app-price-page">
    <div class="app-price-head"><h2>价格与销售范围</h2><button class="secondary" id="app-pricing-settings-save" type="button" disabled title="当前没有未保存的更改">保存</button></div><p class="app-pricing-settings-message" id="app-pricing-settings-message" role="status"></p>
    <section class="app-price-section app-main-schedule-section">
      <div class="app-main-section-head"><div class="app-main-section-title"><h3>价格时间表</h3>${hasPrice ? '<button class="app-price-plus" id="app-pricing-change" type="button" aria-label="更改当前定价" title="更改当前定价">+</button>' : ""}</div>${hasPrice ? '<button class="app-link-button" data-app-current-prices type="button">所有价格和货币</button>' : ""}</div>
      ${hasPrice
        ? `<p class="app-price-note">以下是当前定价和所有即将进行的调整一览。</p><h4>所在国家或地区</h4><p class="app-price-note">Apple 可能根据税率或外汇汇率的变化，不时自动调整其他国家或地区的价格。</p><div class="app-price-base">${escapeHTML(`${pricing.territoryName || pricing.territoryId || "—"}${pricing.currency ? ` (${pricing.currency})` : ""}`)} <button id="app-pricing-edit" type="button">编辑</button></div><div class="app-main-price-heading"><h4>价格</h4><button class="app-link-button" id="app-pricing-download" type="button" ${pricing.priceScheduleLoaded && pricing.currentPrices?.length ? "" : 'disabled title="完整价格数据暂不可用"'}>下载 ↓</button></div><table class="app-main-price-table"><thead><tr><th scope="col">日期</th><th scope="col">国家或地区</th><th scope="col">价格调整</th></tr></thead><tbody><tr><td><button class="app-link-button" data-app-current-prices type="button">当前价格</button></td><td><button class="app-link-button" data-app-current-prices type="button">${escapeHTML(priceCountText)}</button></td><td>—</td></tr></tbody></table>`
        : `<div class="app-price-empty"><span>设置初始价格。此价格将决定 App Store 定价和你的收入。</span><button class="primary" id="app-pricing-add" type="button">添加定价</button></div>`}
    </section>
    <section class="app-price-section app-main-supply-section"><div class="app-main-section-head"><h3>App 供应情况</h3>${availability.exists ? '<button class="app-link-button" id="app-availability-manage" type="button">管理</button>' : ""}</div>${availability.exists
      ? `<p class="app-price-note">查看 App 在各个国家或地区的供应状态摘要。</p>${supplySummary}`
      : `<div class="app-price-empty"><span>确定 App 可供购买或下载的国家或地区。</span><button class="primary" id="app-availability-manage" type="button">设置供应情况</button></div>`}</section>
    ${showPreorder ? `<section class="app-price-section app-main-preorder-section"><h3>预购</h3><p class="app-price-note">App 发布后，客户将收到通知，并且 App 将自动下载到客户的设备上。App 发布前，我们不会向付费客户收取费用。</p><button class="secondary" id="app-preorder-setup" type="button">设置预购</button></section>` : ""}
    <section class="app-price-section app-main-tax-section"><h3>税务类别</h3><div class="app-detail-meta"><dt>类别</dt><dd>${escapeHTML(pricing.taxCategory || "App Store 软件")}</dd></div></section>
    ${renderAppStorePricingExtraSections(detail, draft)}
  </div>`;
}

function appStorePricingSettingsChanges(detail, draft) {
  const settings = detail?.pricingSettings || {};
  const changes = {};
  if (settings.mac?.loaded && (draft.macAvailable !== settings.mac.available || draft.macMinVersion !== settings.mac.minVersion)) {
    changes.mac = { available: draft.macAvailable, minVersion: draft.macMinVersion };
  }
  if (settings.vision?.loaded && draft.visionAvailable !== settings.vision.available) {
    changes.vision = { available: draft.visionAvailable };
  }
  if (settings.distribution?.loaded && (draft.distributionType !== settings.distribution.type || draft.educationDiscount !== settings.distribution.educationDiscount)) {
    changes.distribution = { type: draft.distributionType, educationDiscount: draft.educationDiscount };
  }
  const versions = (settings.versions || []).filter(item => Object.hasOwn(draft.versions, item.id) && draft.versions[item.id] !== item.downloadable);
  if (versions.length) changes.versions = versions.map(item => ({ id: item.id, downloadable: draft.versions[item.id] }));
  return changes;
}

function bindAppStorePricingSettingsEvents() {
  const page = document.querySelector(".app-price-page");
  if (!page) return;
  const detail = currentAppStoreDetail || {};
  const settings = detail.pricingSettings || {};
  const appId = String(detail.app?.id || currentAppStoreApp?.id || "");
  if (!appStorePricingDraft || appStorePricingDraft.appId !== appId) {
    appStorePricingDraft = {
      appId,
      macAvailable: settings.mac?.available === true,
      macMinVersion: String(settings.mac?.minVersion || ""),
      visionAvailable: settings.vision?.available === true,
      distributionType: String(settings.distribution?.type || ""),
      educationDiscount: settings.distribution?.educationDiscount === true,
      versions: Object.fromEntries((settings.versions || []).map(item => [item.id, item.downloadable])),
    };
  }
  const draft = appStorePricingDraft;
  const save = page.querySelector("#app-pricing-settings-save");
  const message = page.querySelector("#app-pricing-settings-message");
  const update = () => {
    const dirty = Object.keys(appStorePricingSettingsChanges(detail, draft)).length > 0;
    save.disabled = !dirty;
    save.title = dirty ? "保存下方设置的更改" : "当前没有未保存的更改";
    const versionSelect = page.querySelector("#app-price-mac-version");
    if (versionSelect) versionSelect.disabled = !draft.macAvailable;
    const discount = page.querySelector("#app-price-education-discount");
    if (discount) discount.disabled = draft.distributionType !== "APP_STORE";
  };
  page.querySelector("#app-price-mac-available")?.addEventListener("change", event => {
    draft.macAvailable = event.target.checked;
    if (!draft.macAvailable) {
      draft.macMinVersion = "";
      const versionSelect = page.querySelector("#app-price-mac-version");
      if (versionSelect) versionSelect.value = "";
    }
    update();
  });
  page.querySelector("#app-price-mac-version")?.addEventListener("change", event => { draft.macMinVersion = event.target.value; update(); });
  page.querySelector("#app-price-vision-available")?.addEventListener("change", event => { draft.visionAvailable = event.target.checked; update(); });
  page.querySelectorAll('input[name="app-price-distribution"]').forEach(input => input.addEventListener("change", event => {
    if (!event.target.checked) return;
    draft.distributionType = event.target.value;
    if (draft.distributionType !== "APP_STORE") {
      draft.educationDiscount = false;
      const discount = page.querySelector("#app-price-education-discount");
      if (discount) discount.checked = false;
    }
    update();
  }));
  page.querySelector("#app-price-education-discount")?.addEventListener("change", event => { draft.educationDiscount = event.target.checked; update(); });
  page.querySelector("#app-price-compatible-edit")?.addEventListener("click", () => openAppStoreCompatibleVersionsModal(detail, draft, update));
  page.querySelector("#app-price-mac-verify")?.addEventListener("click", () => {
    if (Object.keys(appStorePricingSettingsChanges(detail, draft)).length) { message.textContent = "请先保存当前设置，再验证 Mac 兼容性。"; return; }
    openAppStoreMacCompatibilityModal();
  });
  page.querySelector("#app-price-stop-sale")?.addEventListener("click", () => {
    if (Object.keys(appStorePricingSettingsChanges(detail, draft)).length) { message.textContent = "请先保存当前设置，再停止销售 App。"; return; }
    openAppStoreStopSaleModal();
  });
  save?.addEventListener("click", async () => {
    const changes = appStorePricingSettingsChanges(detail, draft);
    if (!Object.keys(changes).length) return;
    message.textContent = "";
    setBusy(save, true, "正在保存…");
    const result = await window.appleDeveloper.saveAppStorePricingSettings({ appId, ...changes });
    if (!result?.success) {
      setBusy(save, false);
      message.textContent = `${result?.error || "保存失败"}。部分设置可能已经保存，请刷新后确认。`;
      return;
    }
    appStorePricingDraft = null;
    updateCurrentAppStoreDetail({ ...detail, pricingSettings: result.settings }, { clearCache: true });
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
  });
  update();
}

function openAppStoreCompatibleVersionsModal(detail, draft, onChange) {
  const versions = (detail?.pricingSettings?.versions || []).filter(item => item.platform === "IOS");
  if (!versions.length || document.getElementById("app-compatible-versions-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-compatible-versions-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-compatible-dialog" role="dialog" aria-modal="true"><div class="app-pricing-dialog-body"><h2>编辑 iOS App 的上个兼容版本</h2><p>旧设备用户可从 iCloud 下载上个兼容版本。若旧版本存在明显的可用性或法律问题，可取消其可下载状态；当前版本无法取消。</p><table class="app-main-price-table"><thead><tr><th>版本</th><th>创建日期</th></tr></thead><tbody>${versions.map(item => `<tr><td><label><input type="checkbox" data-compatible-version="${escapeHTML(item.id)}" ${draft.versions[item.id] ? "checked" : ""} ${appStoreVersionIsDistributable(item, item.state) ? "disabled" : ""}> ${escapeHTML(item.version || "—")}</label></td><td>${escapeHTML(item.createdDate ? new Date(item.createdDate).toLocaleDateString("zh-CN") : "—")}</td></tr>`).join("")}</tbody></table></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-done type="button">完成</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  modal.querySelector("[data-done]").onclick = () => {
    modal.querySelectorAll("[data-compatible-version]").forEach(input => { draft.versions[input.dataset.compatibleVersion] = input.checked; });
    const count = versions.filter(item => draft.versions[item.id]).length;
    const label = document.getElementById("app-price-compatible-summary");
    if (label) label.textContent = count === versions.length ? "全部" : `${count} / ${versions.length}`;
    modal.remove();
    onChange();
  };
}

function openAppStoreMacCompatibilityModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (!appId || document.getElementById("app-mac-compatibility-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-mac-compatibility-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-price-confirm-dialog" role="dialog" aria-modal="true"><div class="app-pricing-dialog-body"><h2>验证与搭载 Apple 芯片的 Mac 的兼容性</h2><p>请确认已在搭载 Apple 芯片的 Mac 上测试此 App，且功能符合预期。</p><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">验证</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  const confirm = modal.querySelector("[data-confirm]");
  confirm.onclick = async () => {
    setBusy(confirm, true, "正在验证…");
    const result = await window.appleDeveloper.verifyAppStoreMacCompatibility(appId);
    if (!result?.success) { setBusy(confirm, false); modal.querySelector(".app-pricing-message").textContent = result?.error || "验证失败"; return; }
    appStorePricingDraft = null;
    updateCurrentAppStoreDetail({ ...currentAppStoreDetail, pricingSettings: result.settings }, { clearCache: true });
    modal.remove();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
  };
}

function openAppStoreStopSaleModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (!appId || document.getElementById("app-stop-sale-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-stop-sale-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-price-confirm-dialog" role="dialog" aria-modal="true"><div class="app-pricing-dialog-body"><h2>停止销售 App？</h2><p>App 将于 24 小时内从 App Store 的所有国家或地区移除。</p><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="danger" data-confirm type="button">移除</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").onclick = () => modal.remove();
  const confirm = modal.querySelector("[data-confirm]");
  confirm.onclick = async () => {
    setBusy(confirm, true, "正在移除…");
    const result = await window.appleDeveloper.saveAppStoreAvailability({ appId, mode: "stop-sale", territoryIds: [], availableInNewTerritories: false });
    if (!result?.success) { setBusy(confirm, false); modal.querySelector(".app-pricing-message").textContent = result?.error || "停止销售失败"; return; }
    appStorePricingDraft = null;
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    modal.remove();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
  };
}

function openAppStoreCurrentPricesModal() {
  if (document.getElementById("app-current-prices-modal")) return;
  const pricing = currentAppStoreDetail?.pricing || {};
  const rows = Array.isArray(pricing.currentPrices) ? pricing.currentPrices : [];
  const modal = document.createElement("div");
  modal.id = "app-current-prices-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-current-prices-dialog" role="dialog" aria-modal="true" aria-labelledby="app-current-prices-title"><div class="app-pricing-dialog-body"><div class="app-current-prices-head"><div><h2 id="app-current-prices-title">所有价格和货币</h2><p>当前价格 · ${pricing.priceScheduleLoaded ? `${rows.length} 个国家或地区` : "仅显示已读取的价格"}</p></div><button class="secondary" data-close type="button">关闭</button></div>${pricing.priceScheduleLoaded ? "" : '<p class="app-current-prices-warning">其他国家或地区的价格暂未读取成功，请刷新后重试。</p>'}<input class="app-current-prices-search" type="search" placeholder="搜索国家、地区或货币" aria-label="搜索国家、地区或货币"><div class="app-current-prices-list"><table><thead><tr><th>国家或地区</th><th>货币</th><th>当前价格</th></tr></thead><tbody></tbody></table></div></div></div>`;
  appendAppStoreModal(modal);
  const body = modal.querySelector("tbody");
  const renderRows = () => {
    const query = modal.querySelector("input").value.trim().toLowerCase();
    const visible = rows.filter(row => `${row.territoryName} ${row.territoryId} ${row.currency}`.toLowerCase().includes(query));
    body.innerHTML = visible.length ? visible.map(row => `<tr><td>${escapeHTML(row.territoryName || row.territoryId || "—")}</td><td>${escapeHTML(row.currency || "—")}</td><td>${escapeHTML(row.currency ? formatAppStorePrice(row.price, row.currency) || "—" : row.price || "—")}</td></tr>`).join("") : '<tr><td colspan="3">没有匹配的国家或地区</td></tr>';
  };
  modal.querySelector("input").addEventListener("input", renderRows);
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", event => { if (event.target === modal) modal.remove(); });
  renderRows();
}

function downloadAppStoreCurrentPrices() {
  const pricing = currentAppStoreDetail?.pricing || {};
  if (!pricing.priceScheduleLoaded || !Array.isArray(pricing.currentPrices) || !pricing.currentPrices.length) return;
  const csvCell = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["国家或地区", "地区代码", "货币", "当前价格"], ...pricing.currentPrices.map(row => [row.territoryName, row.territoryId, row.currency, row.price])];
  const blob = new Blob(["\uFEFF", rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "App-当前价格.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatAppStorePrice(value, currency) {
  if (value === "" || value === null || value === undefined) return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value || "");
  try {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || ""} ${amount.toFixed(2)}`.trim();
  }
}

async function openAppStorePricingModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (!appId || document.getElementById("app-pricing-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-pricing-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog" role="dialog" aria-modal="true" aria-labelledby="app-pricing-title">
    <div class="app-pricing-dialog-body">
      <h2 id="app-pricing-title">App 定价</h2>
      <p>请选取所在国家或地区。Apple 可能根据税率或外汇汇率的变化，自动调整其他国家或地区的价格。</p>
      <label>所在国家或地区<select id="app-pricing-territory" disabled><option>正在读取…</option></select></label>
      <hr>
      <p>请为所在国家或地区选取新价格。Apple 将为其他国家或地区提供相应价格。</p>
      <label>价格<select id="app-pricing-point" disabled><option>请先选择国家或地区</option></select></label>
      <div class="app-pricing-message" id="app-pricing-message"></div>
    </div>
    <div class="app-pricing-dialog-actions"><button class="secondary" id="app-pricing-cancel" type="button">取消</button><button class="primary" id="app-pricing-next" type="button" disabled>下一步</button></div>
  </div>`;
  appendAppStoreModal(modal);
  const territorySelect = el("app-pricing-territory");
  const priceSelect = el("app-pricing-point");
  const nextButton = el("app-pricing-next");
  const message = el("app-pricing-message");
  const close = () => modal.remove();
  el("app-pricing-cancel")?.addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });

  const loadPricePoints = async () => {
    const territoryId = territorySelect.value;
    const territory = territorySelect.selectedOptions[0];
    priceSelect.disabled = true;
    nextButton.disabled = true;
    message.textContent = "";
    priceSelect.innerHTML = "<option>正在读取价格…</option>";
    const result = await window.appleDeveloper.appStorePricingOptions({ appId, territoryId });
    if (!result?.success) {
      priceSelect.innerHTML = "<option>读取失败</option>";
      message.textContent = result?.error || "价格读取失败";
      return;
    }
    const currency = territory?.dataset.currency || "USD";
    priceSelect.innerHTML = '<option value="">选取</option>' + (result.pricePoints || []).map(item =>
      `<option value="${escapeHTML(item.id)}">${escapeHTML(formatAppStorePrice(item.price, currency))}</option>`
    ).join("");
    priceSelect.disabled = false;
  };

  territorySelect.addEventListener("change", loadPricePoints);
  priceSelect.addEventListener("change", () => { nextButton.disabled = !priceSelect.value; });
  nextButton.addEventListener("click", async () => {
    if (!territorySelect.value || !priceSelect.value) return;
    setBusy(nextButton, true, "正在设置…");
    territorySelect.disabled = true;
    priceSelect.disabled = true;
    message.textContent = "";
    const result = await window.appleDeveloper.createAppStorePricing({
      appId,
      territoryId: territorySelect.value,
      pricePointId: priceSelect.value,
    });
    if (!result?.success) {
      territorySelect.disabled = false;
      priceSelect.disabled = false;
      setBusy(nextButton, false);
      message.textContent = result?.error || "价格设置失败";
      return;
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    close();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
  });

  const result = await window.appleDeveloper.appStorePricingOptions({ appId });
  if (!result?.success) {
    territorySelect.innerHTML = "<option>读取失败</option>";
    message.textContent = result?.error || "国家或地区读取失败";
    return;
  }
  const territories = result.territories || [];
  territorySelect.innerHTML = territories.map(item =>
    `<option value="${escapeHTML(item.id)}" data-currency="${escapeHTML(item.currency)}">${escapeHTML(`${item.name} (${item.currency})`)}</option>`
  ).join("");
  territorySelect.disabled = false;
  const chinaIndex = territories.findIndex(item => item.id === "CHN");
  territorySelect.selectedIndex = chinaIndex >= 0 ? chinaIndex : 0;
  await loadPricePoints();
}

function confirmAppStorePricingEdit() {
  const pricing = currentAppStoreDetail?.pricing || {};
  if (!pricing.hasPrice) return openAppStorePricingModal();
  const modal = document.createElement("div");
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-pricing-warning"><div class="app-pricing-dialog-body">
    <h2>要编辑所在国家或地区吗？</h2>
    <p>更改所在国家或地区将自动更新所有国家或地区的价格。App 定价将立即生效。</p>
    <label class="app-pricing-agree"><input id="app-pricing-edit-agree" type="checkbox"> 我明白更改 App 的所在国家或地区还会更改相关定价，当前价格计划会由新设置替换。</label>
  </div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" id="app-pricing-edit-continue" type="button" disabled>编辑</button></div></div>`;
  appendAppStoreModal(modal);
  const agree = modal.querySelector("#app-pricing-edit-agree");
  const next = modal.querySelector("#app-pricing-edit-continue");
  agree.addEventListener("change", () => { next.disabled = !agree.checked; });
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  next.addEventListener("click", () => { modal.remove(); openAppStorePricingModal(); });
}

function appendAppStoreModal(modal) {
  modal.classList.add("app-pricing-modal-mask");
  const host = document.querySelector("#page-apps > .module");
  (host || document.body).appendChild(modal);
}

async function openAppStoreVersionReleaseModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  const version = currentAppStoreDetail?.selectedVersion || {};
  const versionId = String(version.id || appStoreCurrentVersionId(currentAppStoreDetail) || "");
  if (!appId || !versionId || document.getElementById("app-version-release-modal")) return;
  if (!appStoreVersionPendingDeveloperRelease(version, currentAppStoreApp?.status)) return;
  const availability = currentAppStoreDetail?.availability || {};
  let territories = (availability?.territories || []).filter(item => item.available);
  if (!territories.length && window.appleDeveloper?.appStoreAvailability) {
    const result = await window.appleDeveloper.appStoreAvailability(appId);
    if (result?.success) territories = (result.availability?.territories || []).filter(item => item.available);
  }
  const territoryList = territories.length
    ? `<ul class="app-release-territories">${territories.map(item => `<li>${escapeHTML(item.name || item.id || "—")}</li>`).join("")}</ul>`
    : '<p>暂未读取到可发布的国家或地区，请确认 App 供应情况后重试。</p>';
  const modal = document.createElement("div");
  modal.id = "app-version-release-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-confirm-dialog"><div class="app-pricing-dialog-body">
    <h2>发布此版本</h2>
    <p>以下素材和元数据将在你 App 的产品页面上显示。发布后，所选国家或地区的用户可以下载此版本。</p>
    ${territoryList}
    <div class="app-pricing-message"></div>
  </div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">发布</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  modal.querySelector("[data-close]")?.addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  const confirm = modal.querySelector("[data-confirm]");
  confirm?.addEventListener("click", async () => {
    setBusy(confirm, true, "正在发布…");
    const result = await window.appleDeveloper.releaseAppStoreVersion({ appId, versionId });
    if (!result?.success) {
      setBusy(confirm, false);
      const message = modal.querySelector(".app-pricing-message");
      if (message) message.textContent = result?.error || "发生错误。请稍后重试。";
      return;
    }
    clearAppStoreDetailCache(appId);
    if (result.detail) updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    const nextApp = { ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) };
    modal.remove();
    await loadAppStoreDetail(nextApp, "release", versionId, { force: true });
    showAppStoreNotice("发布请求已提交，页面内容已刷新。");
  });
}

function openAppStoreVersionCancelReleaseModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  const version = currentAppStoreDetail?.selectedVersion || {};
  const versionId = String(version.id || appStoreCurrentVersionId(currentAppStoreDetail) || "");
  if (!appId || !versionId || document.getElementById("app-version-cancel-release-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-version-cancel-release-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-confirm-dialog"><div class="app-pricing-dialog-body">
    <h2>是否取消发布版本？</h2>
    <p>取消后，此版本会回到可编辑状态，你可以修改元数据后重新提交审核。</p>
    <div class="app-pricing-message"></div>
  </div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">取消发布版本</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  modal.querySelector("[data-close]")?.addEventListener("click", close);
  const confirm = modal.querySelector("[data-confirm]");
  confirm?.addEventListener("click", async () => {
    setBusy(confirm, true, "正在取消…");
    const result = await window.appleDeveloper.cancelAppStoreVersionRelease({ appId, versionId });
    if (!result?.success) {
      setBusy(confirm, false);
      const message = modal.querySelector(".app-pricing-message");
      if (message) message.textContent = result?.error || "发生错误。请稍后重试。";
      return;
    }
    clearAppStoreDetailCache(appId);
    if (result.detail) updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    const nextApp = { ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) };
    modal.remove();
    await loadAppStoreDetail(nextApp, "release", versionId, { force: true });
    showAppStoreNotice("已取消发布版本，页面内容已刷新。");
  });
}

const APP_STORE_TERRITORY_REGIONS = [
  { id: "NAM", name: "美国和加拿大", codes: "CAN USA" },
  { id: "EUR", name: "欧洲", codes: "ALB IRL EST AUT BLR BGR MKD BEL ISL POL BIH DNK DEU RUS FRA FIN NLD MNE CZE XKS HRV LVA LTU LUX ROU MLT MDA NOR PRT SWE CHE SRB CYP SVK SVN TUR UKR ESP GRC HUN ITA GBR" },
  { id: "MEA", name: "非洲、中东和印度", codes: "DZA AFG ARE OMN AZE EGY AGO BHR BEN BWA BFA CPV GMB COG COD GEO GNB GHA GAB ZWE CMR QAT CIV KWT KEN LBN LBR LBY RWA MDG MWI MLI MUS MRT MAR MOZ NAM ZAF NER NGA SLE SEN SYC SAU STP SWZ TZA TUN UGA ARM YEM IRQ ISR IND JOR ZMB TCD" },
  { id: "LAC", name: "拉丁美洲和加勒比海地区", codes: "ARG AIA ATG BRB BHS PRY PAN BRA BMU BOL BLZ DOM DMA ECU COL CRI GRD GUY HND CYM MSR PER MEX NIC SLV KNA LCA VCT SUR TCA TTO GTM VEN URY JAM VGB CHL" },
  { id: "APAC", name: "亚太地区", codes: "AUS MAC PNG PAK BTN PHL FJI KAZ KOR KGZ KHM LAO MDV MYS MNG FSM MMR NRU NPL PLW JPN LKA SLB TJK TWN THA TON TKM VUT BRN UZB HKG SGP NZL IDN VNM CHN" },
].map(region => ({ ...region, codes: region.codes.split(" ") }));

function groupAppStoreTerritories(territories) {
  const byId = new Map((territories || []).map(item => [item.id, item]));
  const used = new Set();
  const groups = APP_STORE_TERRITORY_REGIONS.map(region => ({
    ...region,
    territories: region.codes.map(code => byId.get(code)).filter(item => item && used.add(item.id)),
  }));
  const remaining = (territories || []).filter(item => !used.has(item.id));
  if (remaining.length) groups[groups.length - 1].territories.push(...remaining);
  return groups;
}

function appStoreTerritoryPicker(groups, selected, prefix) {
  return `<div class="app-territory-picker" data-prefix="${prefix}">
    ${groups.map(group => `<section class="app-territory-group">
      <label class="app-territory-group-title"><input type="checkbox" data-region="${escapeHTML(group.id)}"> <strong>${escapeHTML(group.name)} (<span data-region-count="${escapeHTML(group.id)}">0</span>)</strong></label>
      <div class="app-territory-grid">${group.territories.map(item => `<label><input type="checkbox" data-territory value="${escapeHTML(item.id)}" data-region-id="${escapeHTML(group.id)}" ${selected.has(item.id) ? "checked" : ""}> <span>${escapeHTML(item.name)}</span></label>`).join("")}</div>
    </section>`).join("")}
  </div>`;
}

function wireAppStoreTerritoryPicker(modal, originalSelected = new Set(), options = {}) {
  const territoryInputs = [...modal.querySelectorAll("input[data-territory]")];
  const selectedIds = () => territoryInputs.filter(input => input.checked).map(input => input.value);
  const update = () => {
    APP_STORE_TERRITORY_REGIONS.forEach(region => {
      const children = territoryInputs.filter(input => input.dataset.regionId === region.id);
      const checked = children.filter(input => input.checked).length;
      const regionInput = modal.querySelector(`input[data-region="${region.id}"]`);
      const count = modal.querySelector(`[data-region-count="${region.id}"]`);
      if (regionInput) {
        regionInput.checked = !!children.length && checked === children.length;
        regionInput.indeterminate = checked > 0 && checked < children.length;
      }
      if (count) count.textContent = String(checked);
    });
    const ids = selectedIds();
    const titleCount = modal.querySelector("[data-selected-count]");
    if (titleCount) titleCount.textContent = String(ids.length);
    const all = modal.querySelector("[data-select-all]");
    const none = modal.querySelector("[data-select-none]");
    if (all) all.disabled = ids.length === territoryInputs.length;
    if (none) none.disabled = ids.length === 0;
    const next = modal.querySelector("[data-picker-next]");
    if (next) {
      const unchanged = ids.length === originalSelected.size && ids.every(id => originalSelected.has(id));
      next.disabled = !ids.length || (!options.allowUnchanged && unchanged);
    }
  };
  territoryInputs.forEach(input => input.addEventListener("change", update));
  modal.querySelectorAll("input[data-region]").forEach(input => input.addEventListener("change", () => {
    territoryInputs.filter(item => item.dataset.regionId === input.dataset.region).forEach(item => { item.checked = input.checked; });
    update();
  }));
  modal.querySelector("[data-select-all]")?.addEventListener("click", () => { territoryInputs.forEach(input => { input.checked = true; }); update(); });
  modal.querySelector("[data-select-none]")?.addEventListener("click", () => { territoryInputs.forEach(input => { input.checked = false; }); update(); });
  update();
  return { selectedIds, update };
}

async function openAppStoreAvailabilityModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (!appId || document.getElementById("app-availability-modal")) return;
  const modal = document.createElement("div");
  modal.id = "app-availability-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<div class="app-pricing-dialog app-territory-dialog"><div class="app-pricing-dialog-body app-territory-body">
    <div class="app-territory-head"><h2>国家或地区供应情况 (<span data-selected-count>0</span>)</h2><span>选择 <button data-select-all type="button">全部</button><i>|</i><button data-select-none type="button">无</button></span></div>
    <div id="app-availability-loading">正在读取国家或地区…</div>
  </div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-picker-next type="button" disabled>下一步</button></div></div>`;
  appendAppStoreModal(modal);
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  const result = await window.appleDeveloper.appStoreAvailability(appId);
  if (!result?.success) { modal.querySelector("#app-availability-loading").textContent = result?.error || "供应情况读取失败"; return; }
  const availability = result.availability || {};
  const territories = availability.territories || [];
  const originalSelected = new Set(territories.filter(item => item.available).map(item => item.id));
  modal.querySelector("#app-availability-loading").outerHTML =
    appStoreTerritoryPicker(groupAppStoreTerritories(territories), originalSelected, "availability") +
    `<label class="app-availability-future"><input id="app-availability-future" type="checkbox" ${availability.availableInNewTerritories !== false ? "checked" : ""}> 在将来的所有 App Store 国家或地区中自动提供你的 App。</label>`;
  const picker = wireAppStoreTerritoryPicker(modal, originalSelected);
  modal.querySelector("[data-picker-next]").addEventListener("click", () => {
    const territoryIds = picker.selectedIds();
    const availableInNewTerritories = modal.querySelector("#app-availability-future")?.checked === true;
    const selected = new Set(territoryIds);
    const removed = territories.filter(item => originalSelected.has(item.id) && !selected.has(item.id));
    const added = territories.filter(item => !originalSelected.has(item.id) && selected.has(item.id));
    modal.innerHTML = `<div class="app-pricing-dialog app-confirm-dialog"><div class="app-pricing-dialog-body">
      <h2>确认 App 供应情况更改</h2>
      <p>${removed.length ? `App 将从${escapeHTML(removed.map(item => item.name).join("、"))}的 App Store 移除。` : ""}${added.length ? `App 将在${escapeHTML(added.map(item => item.name).join("、"))}的 App Store 提供。` : ""}<br>更改将于 24 小时内生效。</p>
    </div><div class="app-pricing-dialog-actions app-actions-split"><button class="secondary" data-back type="button">返回</button><span></span><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">确认</button></div></div>`;
    modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    modal.querySelector("[data-back]").addEventListener("click", () => { modal.remove(); openAppStoreAvailabilityModal(); });
    const confirm = modal.querySelector("[data-confirm]");
    confirm.addEventListener("click", async () => {
      setBusy(confirm, true, "正在保存…");
    const saved = await window.appleDeveloper.saveAppStoreAvailability({
      appId,
      territoryIds,
        availableInNewTerritories,
    });
      if (!saved?.success) { setBusy(confirm, false); alert(saved?.error || "供应情况保存失败"); return; }
    updateCurrentAppStoreDetail(saved.detail, { clearCache: true });
    modal.remove();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
    });
  });
}

async function openAppStorePreOrderModal() {
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (!appId || document.getElementById("app-preorder-modal")) return;
  const result = await window.appleDeveloper.appStoreAvailability(appId);
  if (!result?.success) { alert(result?.error || "供应情况读取失败"); return; }
  const availability = result.availability || {};
  const territories = availability.territories || [];
  const modal = document.createElement("div");
  modal.id = "app-preorder-modal";
  modal.className = "app-pricing-modal";
  const now = new Date();
  const min = new Date(now); min.setDate(min.getDate() + 2);
  const max = new Date(now); max.setDate(max.getDate() + 180);
  const isoDate = date => date.toISOString().slice(0, 10);
  const showDateStep = () => {
    modal.innerHTML = `<div class="app-pricing-dialog app-preorder-dialog"><div class="app-pricing-dialog-body">
      <h2>设置预购</h2>
      <p>选取 App 的发布日期，发布后可供下载。此日期必须至少在 2 天后，但是不得超过 180 天。</p>
      <label class="app-preorder-date">发布日期<input id="app-preorder-date" type="date" min="${isoDate(min)}" max="${isoDate(max)}"></label>
    </div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-next type="button" disabled>下一步</button></div></div>`;
    modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    const input = modal.querySelector("#app-preorder-date");
    const next = modal.querySelector("[data-next]");
    input.addEventListener("change", () => { next.disabled = !input.value || input.value < input.min || input.value > input.max; });
    next.addEventListener("click", () => showCountryStep(input.value));
  };
  const showCountryStep = releaseDate => {
    modal.innerHTML = `<div class="app-pricing-dialog app-territory-dialog"><div class="app-pricing-dialog-body app-territory-body">
      <div class="app-territory-head"><h2>选取国家或地区 (<span data-selected-count>0</span>)</h2><span>选择 <button data-select-all type="button">全部</button><i>|</i><button data-select-none type="button">无</button></span></div>
      ${appStoreTerritoryPicker(groupAppStoreTerritories(territories), new Set(), "preorder")}
    </div><div class="app-pricing-dialog-actions app-actions-split"><button class="secondary" data-back type="button">返回</button><span></span><button class="secondary" data-close type="button">取消</button><button class="primary" data-picker-next type="button" disabled>下一步</button></div></div>`;
    const picker = wireAppStoreTerritoryPicker(modal, new Set(), { allowUnchanged: true });
    modal.querySelector("[data-back]").addEventListener("click", showDateStep);
    modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    modal.querySelector("[data-picker-next]").addEventListener("click", () => showConfirm(releaseDate, picker.selectedIds()));
  };
  const showConfirm = (releaseDate, territoryIds) => {
    const names = territories.filter(item => territoryIds.includes(item.id)).map(item => item.name);
    const formatted = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(`${releaseDate}T12:00:00`));
    modal.innerHTML = `<div class="app-pricing-dialog app-confirm-dialog"><div class="app-pricing-dialog-body">
      <h2>要在手动发布首个版本后，在${escapeHTML(names.join("、"))}为 App 提供预购吗？</h2>
      <p>通过 App 审核后，必须以预购方式手动发布 App。提供预购后，App 将于${escapeHTML(formatted)}发布。预购 App 的客户将收到通知，并且 App 会自动下载到其设备上。App 发布前，不会向付费客户收费。请记住，App 在某个国家或地区发布后，将不能再在当地提供预购。</p>
    </div><div class="app-pricing-dialog-actions app-actions-split"><button class="secondary" data-back type="button">返回</button><span></span><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">确认</button></div></div>`;
    modal.querySelector("[data-back]").addEventListener("click", () => showCountryStep(releaseDate));
    modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
    const confirm = modal.querySelector("[data-confirm]");
    confirm.addEventListener("click", async () => {
      setBusy(confirm, true, "正在保存…");
      const saved = await window.appleDeveloper.saveAppStoreAvailability({ appId, mode: "preorder", territoryIds, releaseDate });
      if (!saved?.success) { setBusy(confirm, false); alert(saved?.error || "预购设置失败"); return; }
      updateCurrentAppStoreDetail(saved.detail, { clearCache: true });
      modal.remove();
      switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "pricing");
    });
  };
  appendAppStoreModal(modal);
  showDateStep();
}

function renderAppStoreReleasePane(app, detail) {
  const version = detail?.selectedVersion || app?.versions?.[0] || {};
  const localization = activeAppStoreLocalization(detail);
  const screenshotSetIds = new Set(localization.screenshotSetIds || []);
  const previewSetIds = new Set(localization.previewSetIds || []);
  const screenshotSets = (detail?.screenshotSets || []).filter(set => (!screenshotSetIds.size || screenshotSetIds.has(set.id)) && appStoreMediaDeviceMatches(set.type, appStoreMediaDevice));
  const previewSets = (detail?.previewSets || []).filter(set => (!previewSetIds.size || previewSetIds.has(set.id)) && appStoreMediaDeviceMatches(set.type, appStoreMediaDevice));
  const activeScreenshotSet = appStorePickPrimaryMediaSet(screenshotSets, appStoreMediaDevice);
  const activePreviewSet = appStorePickPrimaryMediaSet(previewSets, appStoreMediaDevice);
  const screenshots = activeScreenshotSet ? (activeScreenshotSet.screenshots || []).map(item => ({ ...item, displayType: activeScreenshotSet.type })) : [];
  const previews = activePreviewSet ? (activePreviewSet.previews || []).map(item => ({ ...item, displayType: activePreviewSet.type })) : [];
  const screenshotCount = screenshots.length;
  const previewCount = previews.length;
  const build = (detail?.builds || [])[0] || null;
  const platform = appStorePlatformText(version.platform || "IOS");
  const scheduledDate = appStoreDateTimeLocalValue(version.earliestReleaseDate || (version.releaseType === "SCHEDULED" ? appStoreDefaultScheduledDate().toISOString() : ""));
  const editable = appStoreVersionEditable(version);
  const pendingDeveloperRelease = appStoreVersionPendingDeveloperRelease(version, app.status);
  const rejected = !!detail?.reviewWarning?.isRejected || /REJECT|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/i.test(appStoreVersionStatus(version, app.status));
  const versionReviewDraft = appStoreFindVersionReviewDraft(version);
  const submitDraftCandidates = appStoreReviewSubmitDraftCandidates();
  const reviewDraftNotice = versionReviewDraft ? `<div class="app-blue-note app-release-review-note"><span class="app-info-icon">i</span> 此 App 版本已<button class="app-link-button" id="app-version-review-draft-link" type="button">添加以供审核</button>。要提交不同版本，你必须先移除此版本。</div>` : "";
  const pendingDeveloperReleaseNotice = pendingDeveloperRelease ? `<div class="app-blue-note app-release-review-note"><span class="app-info-icon">i</span> 你的版本正在等待开发者发布，你只能编辑部分信息。要编辑所有信息，请<button class="app-link-button" id="app-detail-cancel-release" type="button">取消此次发布</button>。</div>` : "";
  const releaseActions = rejected
    ? `<div class="app-release-actions"><button class="secondary app-detail-save" id="app-detail-save" type="button" disabled>保存</button>${detail?.reviewWarning?.submissionId ? `<button class="primary app-review-update-button" type="button" data-review-submission-id="${escapeHTML(detail.reviewWarning.submissionId)}" data-review-submission-item-id="${escapeHTML(detail.reviewWarning.itemId || "")}" data-review-submission-update="1">更新审核</button>` : ""}</div>`
    : pendingDeveloperRelease
    ? `<div class="app-release-actions"><button class="secondary app-detail-save" id="app-detail-save" type="button" disabled>保存</button><button class="primary app-detail-release" id="app-detail-release" type="button">发布此版本</button></div>`
    : editable
    ? `<div class="app-release-actions"><button class="secondary app-detail-save" id="app-detail-save" type="button" disabled>保存</button><div class="app-submit-menu-wrap"><button class="primary app-detail-submit" id="app-detail-submit" type="button">添加以供审核</button><button class="primary app-submit-menu-trigger" id="app-detail-submit-menu" type="button" aria-label="选择提交内容" ${submitDraftCandidates.length ? "" : "hidden"}>⌄</button><div class="app-submit-menu" id="app-submit-menu" hidden>${submitDraftCandidates.map(item => `<button type="button" data-review-submit-draft="${escapeHTML(item.id)}"><strong>${escapeHTML(appStoreReviewDraftTitle(item).replace(/^iOS 提交草稿/, "草稿提交"))}</strong><small>${escapeHTML(appStoreReviewDraftMeta(item))}</small></button>`).join("")}<button type="button" data-review-submit-new><span>创建新提交内容</span></button></div></div></div>`
    : `<div class="app-release-actions"><button class="secondary app-detail-save" id="app-detail-save" type="button" disabled>保存</button></div>`;
  const mediaHTML = detail?.mediaLoading
    ? '<div class="app-media-box app-media-readonly"><div class="loading-state">正在加载 App 预览和截屏…</div></div>'
    : renderAppStoreMedia(previews, screenshots, previewCount, screenshotCount, editable, activeScreenshotSet?.type || activePreviewSet?.type || "");
  return `
    <section class="app-release-title app-release-hero"><div><h3>${escapeHTML(platform)} App 版本 ${escapeHTML(version.versionString || "1.0")}</h3><p>${escapeHTML(appStoreStatusText(appStoreVersionStatus(version, app.status)))}</p></div>${releaseActions}</section>
    ${renderAppStoreReviewWarning(detail, version)}
    ${pendingDeveloperReleaseNotice}
    ${reviewDraftNotice}
    <section class="app-detail-panel app-media-panel"><div class="app-locale-row"><h3>App 预览和截屏 ${appStoreHelp("一个版本可以配置多个本地化语言；选择语言后会显示并编辑该语言对应的资料。")}</h3>${renderAppStoreLocaleSelector(detail, app)}</div><div class="app-device-tabs"><button class="${appStoreMediaDevice === "iphone" ? "active" : ""}" data-app-media-device="iphone" type="button">iPhone</button><button class="${appStoreMediaDevice === "ipad" ? "active" : ""}" data-app-media-device="ipad" type="button">iPad</button><button class="${appStoreMediaDevice === "watch" ? "active" : ""}" data-app-media-device="watch" type="button">Apple Watch</button></div>${mediaHTML}</section>
    <section class="app-form-section app-release-metadata">
      ${appStoreTextarea("促销文本", "localization.promotionalText", localization.promotionalText, 170, "推广文本可使你在无需提交更新请求的情况下让 App Store 访客了解当前的 App 功能。如果客户的设备运行 iOS 11 或更高版本以及 macOS 10.13 或更高版本，则客户将看到此文本显示在 App Store 中描述的上方。", !editable)}
      ${appStoreTextarea("描述", "localization.description", localization.description, 4000, "描述此版本 App 的新增内容，例如增添了何种新功能、有何改进之处，以及修正了哪些错误。", !editable)}
      ${appStoreInput("关键词", "localization.keywords", localization.keywords, "一个或多个用于描述 App 的关键词。关键词将影响 App Store 搜索结果。", null, !editable, 100)}
      <div class="app-two-cols app-release-url-row">${appStoreInput("技术支持网址 (URL)", "localization.supportUrl", localization.supportUrl, "用户可以通过这个网址获取 App 的技术支持。", null, !editable)}${appStoreInput("营销网址 (URL)", "localization.marketingUrl", localization.marketingUrl || "", "用户可以通过这个网址了解 App 的营销信息。", null, !editable)}</div>
      <div class="app-two-cols app-release-version-row">${appStoreInput("版本", "version.versionString", version.versionString || "1.0", "你要添加的 App 的版本。编号应遵循软件版本规范。", null, !editable)}${appStoreInput("版权", "version.copyright", version.copyright || "", "拥有此 App 独家权利的个人或实体名称，前面显示年份。", null, !editable, 200)}</div>
      ${window.AppVersionRules.isUpdateVersion(detail, version) ? appStoreTextarea("此版本的新增内容", "localization.whatsNew", localization.whatsNew, 4000, "描述此版本 App 的新增内容，例如增添了何种新功能、有何改进之处，以及修正了哪些错误。", !editable) : ""}
    </section>
    ${renderAppStoreBuildSection(app, detail, editable)}
    <section class="app-detail-panel"><h3>App 内购买项目和订阅</h3><div class="app-blue-note">提交 App 前，可在这里关联 App 内购买项目或订阅。</div></section>
    <section class="app-detail-panel"><h3>Game Center</h3><p>此版本当前没有启用 Game Center 配置。</p></section>
    ${renderAppStoreReviewInfoSection(detail, editable)}
    <section class="app-detail-panel app-release-schedule-panel"><h3>App Store 版本发布</h3><p>要在 App Store 提供你的 App，你可以在通过 App 审核后自动发布，也可以之后在 App Store 手动发布。</p><label class="app-radio"><input type="radio" name="app-release-type" data-app-field="version.releaseType" value="MANUAL" ${version.releaseType === "MANUAL" ? "checked" : ""} ${editable ? "" : "disabled"}> 手动发布此版本</label><label class="app-radio"><input type="radio" name="app-release-type" data-app-field="version.releaseType" value="AFTER_APPROVAL" ${version.releaseType !== "MANUAL" && version.releaseType !== "SCHEDULED" ? "checked" : ""} ${editable ? "" : "disabled"}> 自动发布此版本</label><label class="app-radio"><input type="radio" name="app-release-type" data-app-field="version.releaseType" value="SCHEDULED" ${version.releaseType === "SCHEDULED" ? "checked" : ""} ${editable ? "" : "disabled"}> 在 App 审核后自动发布此版本，时间不早于</label><div class="app-release-date field"><small>你的本地日期和时间。</small><input type="hidden" data-app-field="version.earliestReleaseDate" value="${escapeHTML(scheduledDate)}" ${editable && version.releaseType === "SCHEDULED" ? "" : "disabled"}><button class="app-release-date-trigger" id="app-release-date-trigger" data-app-release-date-trigger type="button" ${editable && version.releaseType === "SCHEDULED" ? "" : "disabled"}>${escapeHTML(appStoreFormatReleaseDateDisplay(scheduledDate))}</button></div></section>`;
}

function appStoreBuildIconHTML(build = {}, className = "app-build-icon") {
  const iconUrl = appStoreSafeImageUrl(build.iconUrl || currentAppStoreDetail?.app?.iconUrl || currentAppStoreApp?.iconUrl || "");
  return `<span class="${escapeHTML([className, iconUrl ? "has-image" : ""].filter(Boolean).join(" "))}">${iconUrl ? `<img src="${escapeHTML(iconUrl)}" alt="">` : ""}</span>`;
}

function appStoreBuildContainsLightAppText(build = {}) {
  return build.containsLightApp ? "是" : "否";
}

function appStoreBuildRequiresEncryptionDeclaration(build = {}) {
  return build?.usesNonExemptEncryption === null || build?.usesNonExemptEncryption === undefined || build?.usesNonExemptEncryption === "";
}

function appStoreBuildEncryptionStatusHTML(build = {}, editable = true) {
  const needsDeclaration = appStoreBuildRequiresEncryptionDeclaration(build);
  if (!needsDeclaration) return '<span class="app-build-status-ok">已设置</span>';
  const manage = editable ? `<button class="app-link-button app-build-encryption-manage" data-app-build-encryption="${escapeHTML(build.id || "")}" type="button">管理</button>` : "";
  return `<span class="app-build-encryption-status"><i>!</i><b>缺少出口合规证明</b>${manage}</span>`;
}

function renderAppStoreBuildSection(app, detail, editable = true) {
  const build = (detail?.builds || [])[0] || null;
  const addButton = editable && build ? '<button class="app-build-add" id="app-build-add" type="button" aria-label="添加构建版本">+</button>' : "";
  const body = build ? `
    <div class="app-build-table">
      <div class="app-build-head"><span>构建版本</span><span>版本</span><span>状态</span><span></span></div>
      <div class="app-build-selected-row">
        <span class="app-build-name">${appStoreBuildIconHTML(build)}<button type="button" id="app-build-name">${escapeHTML(build.version || build.id)}</button></span>
        <span>${escapeHTML(build.preReleaseVersion || detail?.selectedVersion?.versionString || "—")}</span>
        <span>${appStoreBuildEncryptionStatusHTML(build, editable)}</span>
        ${editable ? '<button class="app-build-remove" data-app-build-remove type="button" aria-label="移除构建版本">−</button>' : "<span></span>"}
      </div>
    </div>
    <div class="app-build-assets"><h4>包含的素材</h4><figure>${appStoreBuildIconHTML(build, "app-build-asset-icon")}<figcaption>App 图标</figcaption></figure></div>`
    : `<div class="app-build-empty"><p>从多种工具中选取一种来上传你的构建版本。 <button class="app-link-button" data-app-build-upload-tools type="button">查看上传工具</button></p>${editable ? '<button class="primary" id="app-build-add-empty" type="button">添加构建版本</button>' : ""}</div>`;
  return `<section class="app-detail-panel app-build-panel"><div class="app-build-title"><h3>构建版本</h3>${addButton}</div>${body}</section>`;
}

function openAppStoreBuildUploadTools() {
  showPage("ipa-upload");
}

async function openAppStoreBuildModal() {
  if (document.getElementById("app-build-modal")) return;
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "";
  const version = currentAppStoreDetail?.selectedVersion || {};
  const versionId = version.id || "";
  const modal = document.createElement("div");
  modal.id = "app-build-modal";
  modal.className = "app-pricing-modal app-build-modal";
  modal.innerHTML = `<div class="app-build-dialog"><div class="app-build-dialog-body"><h2>添加构建版本</h2><div class="app-build-modal-table"><div class="app-build-modal-head"><span></span><span>构建版本</span><span>版本</span></div><div class="app-build-modal-loading">正在读取构建版本…</div></div><div class="app-pricing-message"></div></div><div class="app-build-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-done type="button" disabled>完成</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  const done = modal.querySelector("[data-done]");
  const message = modal.querySelector(".app-pricing-message");
  let selectedBuildId = "";
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  const result = await window.appleDeveloper.appStoreBuildCandidates({ appId, versionId, platform: version.platform || "IOS" });
  const table = modal.querySelector(".app-build-modal-table");
  if (!result?.success) {
    table.innerHTML = `<div class="app-build-modal-empty">${escapeHTML(result?.error || "构建版本读取失败")}</div>`;
    return;
  }
  const builds = result.builds || [];
  if (!builds.length) {
    table.innerHTML = '<div class="app-build-modal-empty">暂无可添加的构建版本。</div>';
    return;
  }
  table.innerHTML = `<div class="app-build-modal-head"><span></span><span>构建版本</span><span>版本</span></div>${builds.map(build => `<label class="app-build-modal-row"><input type="radio" name="app-build-choice" value="${escapeHTML(build.id)}"><span>${appStoreBuildIconHTML(build)}<b>${escapeHTML(build.version || build.id)}</b></span><span>${escapeHTML(build.preReleaseVersion || version.versionString || "—")}</span></label>`).join("")}`;
  table.querySelectorAll('input[name="app-build-choice"]').forEach(input => input.addEventListener("change", () => {
    selectedBuildId = input.value || "";
    done.disabled = !selectedBuildId;
    message.textContent = "";
  }));
  done.addEventListener("click", async () => {
    if (!selectedBuildId) return;
    setBusy(done, true, "保存中…");
    const saved = await window.appleDeveloper.saveAppStoreVersionBuild({ appId, versionId, buildId: selectedBuildId });
    setBusy(done, false);
    if (!saved?.success) {
      message.textContent = saved?.error || "构建版本保存失败";
      return;
    }
    updateCurrentAppStoreDetail(saved.detail, { clearCache: true });
    close();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
  });
}

function openAppStoreBuildRemoveModal() {
  const build = (currentAppStoreDetail?.builds || [])[0] || null;
  if (!build || document.getElementById("app-build-remove-modal")) return;
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "";
  const versionId = currentAppStoreDetail?.selectedVersion?.id || "";
  const modal = document.createElement("div");
  modal.id = "app-build-remove-modal";
  modal.className = "app-pricing-modal app-build-remove-modal";
  modal.innerHTML = `<div class="app-build-remove-dialog"><div class="app-build-remove-body"><h2>要移除构建版本吗？</h2><p>移除此构建版本后，在再次提交审核前，你需要重新添加一个构建版本。</p><div class="app-build-remove-summary">${appStoreBuildIconHTML(build)}<span><strong>${escapeHTML(build.version || build.id)}</strong><small>${escapeHTML(build.preReleaseVersion || "")}</small></span></div><div class="app-pricing-message"></div></div><div class="app-build-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="danger" data-remove type="button">移除</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelector("[data-remove]").addEventListener("click", async event => {
    const button = event.currentTarget;
    setBusy(button, true, "移除中…");
    const result = await window.appleDeveloper.saveAppStoreVersionBuild({ appId, versionId, remove: true });
    setBusy(button, false);
    if (!result?.success) {
      modal.querySelector(".app-pricing-message").textContent = result?.error || "构建版本移除失败";
      return;
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    close();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
  });
}

function appStoreBuildEncryptionOptions(selected = "") {
  const rows = [
    {
      value: "standard",
      usesNonExemptEncryption: true,
      text: "专有或未被国际标准化组织（IEEE、IETF、ITU 等）视为标准的加密算法。",
    },
    {
      value: "apple",
      usesNonExemptEncryption: true,
      text: "代替在 Apple 操作系统中使用或访问加密，或与这些操作同时使用的标准加密算法。",
    },
    {
      value: "both",
      usesNonExemptEncryption: true,
      text: "兼用上述的两种算法",
    },
    {
      value: "none",
      usesNonExemptEncryption: false,
      text: "不属于上述的任意一种算法",
    },
  ];
  const current = selected || "none";
  return rows.map(item => `<label class="app-build-encryption-choice"><input type="radio" name="app-build-encryption-choice" value="${escapeHTML(item.value)}" data-uses-non-exempt-encryption="${item.usesNonExemptEncryption ? "1" : "0"}" ${item.value === current ? "checked" : ""}><span>${escapeHTML(item.text)}</span></label>`).join("");
}

function openAppStoreBuildEncryptionModal() {
  const build = (currentAppStoreDetail?.builds || [])[0] || null;
  if (!build || document.getElementById("app-build-encryption-modal")) return;
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "";
  const versionId = currentAppStoreDetail?.selectedVersion?.id || "";
  const currentChoice = build.usesNonExemptEncryption === false ? "none" : "";
  const modal = document.createElement("div");
  modal.id = "app-build-encryption-modal";
  modal.className = "app-pricing-modal app-build-encryption-modal";
  modal.innerHTML = `<div class="app-build-encryption-dialog" role="dialog" aria-modal="true" aria-labelledby="app-build-encryption-title">
    <div class="app-build-encryption-body">
      <h2 id="app-build-encryption-title">App 加密文稿</h2>
      <p>你的 App 采用了哪种类型的加密算法?</p>
      <div class="app-build-encryption-options">${appStoreBuildEncryptionOptions(currentChoice)}</div>
      <div class="app-build-encryption-warning"><span>!</span><p>要跳过在 App Store Connect 中设置出口合规，你可以在 Xcode 项目中的信息属性列表 (Info.plist) 里直接指定你使用的加密。如果你需要提供文稿，Apple 会为你提供需要添加到 Info.plist 中的密钥值。<button class="app-link-button" type="button">进一步了解</button></p></div>
      <div class="app-pricing-message" id="app-build-encryption-message"></div>
    </div>
    <div class="app-build-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-save type="button">保存</button></div>
  </div>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  const save = modal.querySelector("[data-save]");
  const message = modal.querySelector("#app-build-encryption-message");
  const syncSaveState = () => { save.disabled = !modal.querySelector("input[name=app-build-encryption-choice]:checked"); message.textContent = ""; };
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelectorAll("input[name=app-build-encryption-choice]").forEach(input => input.addEventListener("change", syncSaveState));
  save.addEventListener("click", async () => {
    const input = modal.querySelector("input[name=app-build-encryption-choice]:checked");
    if (!input) { message.textContent = "请选择 App 使用的加密算法类型"; return; }
    setBusy(save, true, "保存中…");
    const result = await window.appleDeveloper.saveAppStoreBuildEncryption({
      appId,
      versionId,
      buildId: build.id,
      choice: input.value,
      usesNonExemptEncryption: input.dataset.usesNonExemptEncryption === "1",
    }).catch(error => ({ success: false, error: error.message }));
    setBusy(save, false);
    if (!result?.success) {
      message.textContent = result?.error || "出口合规证明保存失败";
      return;
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    close();
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
    showAppStoreNotice("保存成功，页面内容已刷新。");
  });
  syncSaveState();
}

function appStoreDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function appStoreDefaultScheduledDate() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return date;
}

function appStoreParseLocalDateValue(value) {
  const date = value ? new Date(value) : appStoreDefaultScheduledDate();
  return Number.isNaN(date.getTime()) ? appStoreDefaultScheduledDate() : date;
}

function appStoreReleaseDateTimezoneText(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

function appStoreFormatReleaseDateDisplay(value) {
  if (!value) return "年/月/日 --:--";
  const date = appStoreParseLocalDateValue(value);
  const hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const period = hour < 12 ? "上午" : "下午";
  const displayHour = hour % 12 || 12;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日　${period} ${displayHour}:${minute} ${appStoreReleaseDateTimezoneText(date)}`;
}

function appStoreSetReleaseDateValue(date, markDirty = true) {
  const input = document.querySelector('[data-app-field="version.earliestReleaseDate"]');
  if (!input) return;
  input.value = appStoreDateTimeLocalValue(date.toISOString());
  appStoreRefreshReleaseDateDisplay();
  clearAppStoreFieldError("version.earliestReleaseDate");
  if (markDirty) markAppStoreDetailDirty();
}

function appStoreRefreshReleaseDateDisplay() {
  const input = document.querySelector('[data-app-field="version.earliestReleaseDate"]');
  const trigger = document.querySelector("[data-app-release-date-trigger]");
  if (trigger) trigger.textContent = appStoreFormatReleaseDateDisplay(input?.value || "");
}

function openAppStoreReleaseDatePicker(event) {
  const trigger = event?.currentTarget || el("app-release-date-trigger");
  if (!trigger || trigger.disabled) return;
  const existing = document.querySelector(".app-release-date-popover");
  if (existing) { existing.remove(); return; }
  const input = document.querySelector('[data-app-field="version.earliestReleaseDate"]');
  const selected = appStoreParseLocalDateValue(input?.value || "");
  const state = { viewYear: selected.getFullYear(), viewMonth: selected.getMonth(), selected };
  const popover = document.createElement("div");
  popover.className = "app-release-date-popover";
  trigger.closest(".app-release-date")?.appendChild(popover);
  const render = () => renderAppStoreReleaseDatePicker(popover, state, render);
  render();
  requestAnimationFrame(() => popover.querySelector(".selected-time")?.scrollIntoView({ block: "center" }));
  const closeOnOutside = outsideEvent => {
    if (!popover.contains(outsideEvent.target) && outsideEvent.target !== trigger) {
      popover.remove();
      document.removeEventListener("mousedown", closeOnOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeOnOutside, true), 0);
}

function renderAppStoreReleaseDatePicker(popover, state, rerender) {
  const firstDay = new Date(state.viewYear, state.viewMonth, 1).getDay();
  const start = new Date(state.viewYear, state.viewMonth, 1 - firstDay);
  const selectedKey = appStoreDateKey(state.selected);
  const days = Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const inMonth = day.getMonth() === state.viewMonth;
    const key = appStoreDateKey(day);
    return `<button class="app-release-day ${inMonth ? "" : "muted"} ${key === selectedKey ? "selected" : ""}" data-date="${escapeHTML(key)}" type="button">${day.getDate()}</button>`;
  }).join("");
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const period = hour < 12 ? "上午" : "下午";
    const displayHour = hour % 12 || 12;
    return `<button class="app-release-time ${hour === state.selected.getHours() ? "selected-time" : ""}" data-hour="${hour}" type="button">${period} ${displayHour}:00</button>`;
  }).join("");
  popover.innerHTML = `<div class="app-release-picker-calendar"><div class="app-release-picker-head"><button data-prev-month type="button" aria-label="上一月">‹</button><strong>${state.viewMonth + 1}月 ${state.viewYear}</strong><button data-next-month type="button" aria-label="下一月">›</button></div><div class="app-release-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="app-release-days">${days}</div></div><div class="app-release-picker-times"><h4>时间</h4><div>${hours}</div></div>`;
  popover.querySelector("[data-prev-month]").addEventListener("click", () => {
    state.viewMonth -= 1;
    if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear -= 1; }
    rerender();
  });
  popover.querySelector("[data-next-month]").addEventListener("click", () => {
    state.viewMonth += 1;
    if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear += 1; }
    rerender();
  });
  popover.querySelectorAll("[data-date]").forEach(button => button.addEventListener("click", () => {
    const [year, month, day] = button.dataset.date.split("-").map(Number);
    state.selected = new Date(year, month - 1, day, state.selected.getHours(), 0, 0, 0);
    state.viewYear = state.selected.getFullYear();
    state.viewMonth = state.selected.getMonth();
    appStoreSetReleaseDateValue(state.selected);
    rerender();
  }));
  popover.querySelectorAll("[data-hour]").forEach(button => button.addEventListener("click", () => {
    state.selected.setHours(Number(button.dataset.hour || 0), 0, 0, 0);
    appStoreSetReleaseDateValue(state.selected);
    popover.remove();
  }));
}

function appStoreDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderAppStoreReviewInfoSection(detail, editable = true) {
  const review = detail?.reviewDetail || {};
  const attachmentsEditable = editable || /^READY_FOR_REVIEW$/.test(String(detail?.selectedVersion?.state || ""));
  return `<section class="app-review-info-section">
    <h3>App 审核信息</h3>
    <div class="app-review-info-grid">
      <div class="app-review-info-group">
        <h4>登录信息 ${appStoreHelp("请提供用户名和密码，以便我们登录你的 App。我们需要使用此登录信息才能完成对你 App 的审核。")}</h4>
        <p>请提供用户名和密码，以便我们登录你的 App。我们需要使用此登录信息才能完成对你 App 的审核。</p>
        <label class="app-check"><input type="checkbox" data-app-field="reviewDetail.demoAccountRequired" ${review.demoAccountRequired ? "checked" : ""} ${editable ? "" : "disabled"}> 需要登录</label>
        <div class="app-review-inline">${appStoreInput("", "reviewDetail.demoAccountName", review.demoAccountName, "", "用户名", !editable)}${appStoreInput("", "reviewDetail.demoAccountPassword", review.demoAccountPassword, "", "密码", !editable)}</div>
      </div>
      <div class="app-review-info-group">
        <h4>联系信息 ${appStoreHelp("如果 App 审核团队需要更多信息，会通过这些联系方式联系你。")}</h4>
        <div class="app-review-contact-grid">
          ${appStoreInput("", "reviewDetail.contactLastName", review.contactLastName, "", "姓氏", !editable)}
          ${appStoreInput("", "reviewDetail.contactFirstName", review.contactFirstName, "", "名字", !editable)}
          ${appStoreInput("", "reviewDetail.contactPhone", review.contactPhone, "", "电话号码", !editable)}
          ${appStoreInput("", "reviewDetail.contactEmail", review.contactEmail, "", "电子邮件", !editable)}
        </div>
      </div>
    </div>
    <div class="app-review-note">${appStoreTextarea("备注", "reviewDetail.notes", review.notes, 4000, "对审核过程会有所帮助的 App 额外信息。请提供测试 App 时可能需要的信息（例如，App 特有的设置）。", !editable)}</div>
    <div class="app-review-attachment"><label>附件 ${appStoreHelp("你可以提交特定的 App 文稿、演示视频以及其他内容，帮助防止 App 审核过程中发生延迟。请确保你的文件使用下列扩展名：.pdf, .doc, .docx, .rtf, .pages, .xls, .xlsx, .numbers, .zip, .rar, .plist, .crash, .jpg, .png, .mp4, .avi")}</label><button class="secondary" id="app-review-attachment-upload" type="button" ${attachmentsEditable ? "" : "disabled"}>选取文件（可不填）</button><button class="secondary" id="app-review-attachment-refresh" type="button">刷新附件</button><button class="secondary hidden" id="app-review-attachment-cancel" type="button">取消上传</button><div id="app-review-attachment-list" aria-live="polite">${renderAppStoreReviewAttachments(review.attachments, attachmentsEditable)}</div><p id="app-review-attachment-status" role="status">${escapeHTML(review.attachmentsError || "")}</p></div>
  </section>`;
}

function renderAppStoreReviewAttachments(attachments = [], editable = true) {
  return attachments.map(item => {
    const state = item.state === "COMPLETE" ? "已上传" : /FAIL|ERROR|INVALID|REJECT/.test(item.state || "") ? "处理失败" : "处理中";
    const errors = (item.errors || []).map(error => error.description || error.message || error.code).filter(Boolean).join("；");
    return `<div class="app-review-reply-attachment"><span class="app-review-reply-attachment-name" title="${escapeHTML(item.fileName)}">${escapeHTML(item.fileName)}</span><span class="app-review-reply-attachment-size">${escapeHTML(appStoreReviewFileSizeText(item.fileSize))}</span><span>${escapeHTML(state)}${errors ? `：${escapeHTML(errors)}` : ""}</span>${editable ? `<button class="app-review-attachment-delete" type="button" data-review-attachment-delete="${escapeHTML(item.id)}" aria-label="删除附件 ${escapeHTML(item.fileName)}" title="删除附件">−</button>` : ""}</div>`;
  }).join("") || '<span class="hint">暂无附件</span>';
}

function bindAppStoreReviewAttachments() {
  const uploadButton = el("app-review-attachment-upload"), refreshButton = el("app-review-attachment-refresh");
  const cancelButton = el("app-review-attachment-cancel"), list = el("app-review-attachment-list"), status = el("app-review-attachment-status");
  if (!uploadButton || !list) return;
  const appId = currentAppStoreApp?.id, versionId = currentAppStoreDetail?.selectedVersion?.id;
  let detail = currentAppStoreDetail;
  let contextToken = detail?.reviewDetail?.attachmentsContextToken || "", busy = false, requestId = "";
  const editable = !uploadButton.disabled;
  const current = () => list.isConnected && currentAppStoreApp?.id === appId && currentAppStoreDetail?.selectedVersion?.id === versionId;
  const updateControls = () => {
    const hasAttachment = !!detail?.reviewDetail?.attachments?.length;
    uploadButton.disabled = busy || !editable || !contextToken || hasAttachment;
    uploadButton.textContent = hasAttachment ? "已有附件，请先删除后更换" : "选取文件（可不填）";
    refreshButton.disabled = busy;
    list.querySelectorAll?.("[data-review-attachment-delete]").forEach(button => { button.disabled = busy || !editable || !contextToken; });
  };
  const execute = async (action, attachmentId = "") => {
    if (busy || !current()) return;
    if (action !== "list" && (!editable || !contextToken)) return;
    if (action === "delete") {
      const item = detail.reviewDetail?.attachments?.find(row => row.id === attachmentId);
      if (!item || !confirm(`确定删除审核附件“${item.fileName}”吗？删除后可以上传新附件。`)) return;
    }
    busy = true;
    updateControls();
    cancelButton.classList.toggle("hidden", action !== "upload");
    requestId = `review-attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    status.textContent = action === "delete" ? "正在删除附件…" : action === "upload" ? "正在选择、上传并等待 Apple 处理附件…" : "正在读取附件…";
    try {
      const result = await window.appleDeveloper.appStoreReviewAttachments({ action, appId, versionId, attachmentId, reviewDetailId: detail.reviewDetail?.id || "", contextToken, requestId });
      if (Array.isArray(result.attachments) || action === "delete") clearAppStoreDetailCache(appId);
      if (!current()) return;
      detail = currentAppStoreDetail;
      if (result.contextToken) contextToken = result.contextToken;
      if (Array.isArray(result.attachments)) {
        detail.reviewDetail ||= {};
        Object.assign(detail.reviewDetail, { id: result.reviewDetailId, attachments: result.attachments, attachmentsContextToken: contextToken, attachmentsError: "" });
        list.innerHTML = renderAppStoreReviewAttachments(result.attachments, editable);
      }
      status.textContent = result.canceled ? "" : !result.success ? result.error || "附件操作失败，请重试" : action === "delete" ? "附件已删除，可以上传新附件。" : action === "upload" ? (result.uploaded ? `已上传 ${result.uploaded} 个附件。` : "所选附件已上传，无需重复上传。") : "";
    } catch (error) { if (current()) status.textContent = error.message || "附件操作失败，请重试"; }
    finally {
      busy = false;
      if (current()) { updateControls(); cancelButton.classList.add("hidden"); }
    }
  };
  uploadButton.addEventListener("click", () => execute("upload"));
  refreshButton.addEventListener("click", () => execute("list"));
  list.addEventListener("click", event => {
    const button = event.target.closest("[data-review-attachment-delete]");
    if (button && !button.disabled) execute("delete", button.dataset.reviewAttachmentDelete);
  });
  cancelButton.addEventListener("click", () => {
    if (!busy) return;
    status.textContent = "正在取消上传…";
    window.appleDeveloper.appStoreReviewAttachments({ action: "cancel", requestId }).catch(error => { if (current()) status.textContent = error.message; });
  });
  updateControls();
  if (!contextToken) execute("list");
}

function renderAppStoreInfoPane(app, detail) {
  const version = detail?.selectedVersion || {};
  const appInfo = detail?.appInfo || {};
  const categories = detail?.categories || [];
  const appBundles = detail?.appBundles || [];
  const bundleOptions = mergeAppInfoBundleOptions(app, appBundles);
  const contentRightsValue = appStoreFieldValue("appInfo.contentRightsDeclaration")
    || detail?.app?.contentRightsDeclaration
    || app?.contentRightsDeclaration
    || appInfo?.attributes?.contentRightsDeclaration
    || "";
  const icpValue = appStoreFieldValue("appInfo.icpNumber") || app.icpNumber || app.icpNumberDetail?.icpNumber || "";
  const infoLocalization = (appInfo.localizations || []).find(item => item.locale === app.primaryLocale) || (appInfo.localizations || [])[0] || {};
  return `<section class="app-info-page">
    <div class="app-info-title-row"><div><h2>App 信息</h2><p>此信息用于这个 App 的所有平台。任何更改将在 App 的下一个版本中发布。</p></div><button class="secondary app-info-save" type="button" disabled>保存</button></div>
    <section class="app-info-section">
      <div class="app-info-section-head"><h3>可本地化的信息</h3><div class="app-info-locale">${escapeHTML(appStoreLocaleName(infoLocalization.locale || app.primaryLocale || "zh-Hans"))} ${appStoreHelp("这些信息会显示在 App Store 的产品页面上。")}</div></div>
      <div class="field app-info-wide"><label>名称 ${appStoreHelp("App 在 App Store 上显示的名称。")}</label><input data-app-field="appInfo.name" value="${escapeHTML(infoLocalization.name || app.name || "")}" maxlength="30" placeholder="名称"><small>${String(infoLocalization.name || app.name || "").length}/30</small></div>
      <div class="field app-info-wide"><label>副标题 ${appStoreHelp("副标题会显示在 App 名称下方。")}</label><input data-app-field="appInfo.subtitle" value="${escapeHTML(infoLocalization.subtitle || "")}" maxlength="30" placeholder="副标题"><small>${String(infoLocalization.subtitle || "").length}/30</small></div>
    </section>
    <section class="app-info-section">
      <h3>综合信息</h3>
      <div class="app-info-general">
        <div>
          <div class="field"><label>套装 ID ${appStoreHelp("与此 App 关联的 Bundle ID。")}</label><select data-app-field="appInfo.bundleId" disabled>${renderAppInfoBundleOptions(app, bundleOptions)}</select></div>
          <div class="app-info-readonly"><label>SKU ${appStoreHelp("创建 App 时设置的唯一 SKU。")}</label><strong>${escapeHTML(app.sku || "—")}</strong></div>
          <div class="app-info-readonly"><label>Apple ID ${appStoreHelp("Apple 为此 App 分配的唯一 ID。")}</label><strong>${escapeHTML(app.id || "—")}</strong></div>
          <div class="app-info-readonly"><label>内容版权 ${appStoreHelp("说明 App 是否包含或访问第三方内容。")}</label><button class="app-info-link" data-app-info-modal="content-rights" type="button">编辑</button><div class="app-content-rights-summary" id="app-content-rights-summary">${renderContentRightsSummary(contentRightsValue)}</div><input type="hidden" data-app-field="appInfo.contentRightsDeclaration" value="${escapeHTML(contentRightsValue)}"></div>
          <div class="app-info-readonly"><label>许可协议 ${appStoreHelp("App Store 标准许可协议或自定义许可协议。")}</label><button class="app-info-link" data-app-info-modal="license" type="button">编辑</button><strong>Apple 标准许可协议</strong></div>
        </div>
        <div>
          <div class="app-info-readonly"><label>主要语言 ${appStoreHelp("App 的主要本地化语言。")}</label><strong>${escapeHTML(appStoreLocaleName(app.primaryLocale || "—"))}</strong></div>
          <div class="field"><label>类别 ${appStoreHelp("类别会影响 App Store 中的浏览和发现。")}</label><select data-app-field="appInfo.primaryCategoryId">${renderAppCategoryOptions(categories, appInfo.primaryCategory?.id, "主要")}</select><select data-app-field="appInfo.secondaryCategoryId">${renderAppCategoryOptions(categories, appInfo.secondaryCategory?.id, "次要（可不填）", true)}</select></div>
        </div>
      </div>
    </section>
    <section class="app-info-section">
      <h3>年龄分级</h3>
      <p>年龄分级可帮助用户了解 App 中是否包含限制性内容。若要确定 App 的年龄分级，系统会询问 App 中某些功能和内容类型的提供情况或频率。</p>
      <div id="app-age-rating-summary">${renderAgeRatingSummary(detail)}</div>
    </section>
    <section class="app-info-section">
      <h3>进一步了解年龄分级</h3>
      <p>要进一步了解有关用于确定年龄分级的功能和内容并查看示例，请从下面选择一个类别。</p>
      <div class="app-info-age-cards"><div><strong>App 内控件</strong><span>家长控制、年龄保证</span></div><div><strong>功能</strong><span>不受限的网页访问、用户生成内容</span></div><div><strong>成人主题</strong><span>低俗笑话、恐怖/惊悚题材</span></div><div><strong>医疗或保健</strong><span>医疗或治疗信息、健康主题</span></div></div>
    </section>
    <section class="app-info-section">
      <h3>App Store 法规和许可</h3>
      <div class="app-info-regulatory-grid">
        <article><h4>数字服务法</h4><p>该开发者已表明不是此 App 的交易商。要更新 App 级别交易商状态，你需要完成合规要求。</p><button class="app-info-link" data-app-info-modal="license" type="button">开始处理</button></article>
        <article><h4>中国大陆 ICP 备案号</h4><p id="app-icp-summary">${escapeHTML(icpValue || "ICP 备案号是中华人民共和国工业和信息化部（MIIT）核发的 App 注册号。如果你有 ICP 备案号，请在此处提供。")}</p><button class="app-info-link" data-app-info-modal="icp" type="button">设置</button><input type="hidden" data-app-field="appInfo.icpNumber" value="${escapeHTML(icpValue)}"></article>
        <article><h4>越南游戏许可</h4><p>如果你的游戏在越南 App Store 提供，你可以根据越南监管机构的要求添加游戏许可。</p><button class="app-info-link" type="button">添加</button></article>
        <article><h4>受监管医疗设备</h4><p>如果你的 App 属于医疗或健康与健身类别，可能需要声明是否用作受监管的医疗设备。</p><button class="app-info-link" type="button">声明受监管医疗设备</button></article>
      </div>
    </section>
  </section>`;
}

function privacyL10n(l10n, key, fallback = "") {
  return String(l10n?.[key]?.loc || fallback || "");
}

function privacyLabel(id, type = "category", l10n = {}) {
  const value = String(id || "");
  const fallback = {
    CONTACT_INFO: "联系信息",
    HEALTH_AND_FITNESS: "健康与健身",
    FINANCIAL_INFO: "财务信息",
    LOCATION: "位置",
    SENSITIVE_INFO: "敏感信息",
    USER_CONTENT: "用户内容",
    BROWSING_HISTORY: "浏览历史记录",
    SEARCH_HISTORY: "搜索历史记录",
    IDENTIFIERS: "标识符",
    PURCHASES: "购买项目",
    USAGE_DATA: "使用数据",
    DIAGNOSTICS: "诊断",
    OTHER_DATA: "其他数据",
    NAME: "姓名",
    EMAIL_ADDRESS: "电子邮件地址",
    PHONE_NUMBER: "电话号码",
    PHYSICAL_ADDRESS: "实际地址",
    OTHER_USER_CONTACT_INFO: "其他用户联系信息",
    HEALTH: "健康",
    FITNESS: "健身",
    PAYMENT_INFORMATION: "付款信息",
    CREDIT_AND_FRAUD: "信用信息",
    PRECISE_LOCATION: "精确位置",
    COARSE_LOCATION: "粗略位置",
    EMAILS_OR_TEXT_MESSAGES: "电子邮件或短信",
    PHOTOS_OR_VIDEOS: "照片或视频",
    AUDIO_DATA: "音频数据",
    GAMEPLAY_CONTENT: "游戏内容",
    CUSTOMER_SUPPORT: "客户支持",
    OTHER_USER_CONTENT: "其他用户内容",
    WEB_BROWSING_HISTORY: "网页浏览历史记录",
    SEARCH_HISTORY: "搜索历史记录",
    USER_ID: "用户 ID",
    DEVICE_ID: "设备 ID",
    PURCHASE_HISTORY: "购买历史记录",
    PRODUCT_INTERACTION: "产品交互",
    ADVERTISING_DATA: "广告数据",
    OTHER_USAGE_DATA: "其他使用数据",
    CRASH_DATA: "崩溃数据",
    PERFORMANCE_DATA: "性能数据",
    OTHER_DIAGNOSTIC_DATA: "其他诊断数据",
    OTHER_DATA_TYPES: "其他数据类型",
    ENVIRONMENTAL_SCANNING: "环境扫描",
    HEAD_MOVEMENT: "头部运动",
    DATA_NOT_COLLECTED: "未收集数据",
    DATA_LINKED_TO_YOU: "与你关联的数据",
    DATA_NOT_LINKED_TO_YOU: "不与你关联的数据",
    THIRD_PARTY_ADVERTISING: "第三方广告",
    DEVELOPERS_ADVERTISING: "开发者广告或营销",
    ANALYTICS: "分析",
    PRODUCT_PERSONALIZATION: "产品个性化",
    APP_FUNCTIONALITY: "App 功能",
    OTHER_PURPOSES: "其他目的",
  };
  const prefixes = {
    category: ["ITC.Apps.Privacy.Category.", "ITC.Apps.Privacy.DataCategory."],
    grouping: ["ITC.Apps.Privacy.Grouping.", "ITC.Apps.Privacy.DataType."],
    purpose: ["ITC.Apps.Privacy.Purpose.", "ITC.Apps.Privacy.PurposeSelectionModal.Purpose."],
    protection: ["ITC.Apps.Privacy.DataProtection.", "ITC.Apps.Privacy.PurposeSelectionModal.DataProtection."],
  }[type] || [];
  for (const prefix of prefixes) {
    const text = privacyL10n(l10n, `${prefix}${value}`);
    if (text) {
      const clean = text.replace(/<[^>]+>/g, "");
      if (/[\u3400-\u9fff]/.test(clean) || !fallback[value]) return clean;
      return fallback[value];
    }
  }
  return fallback[value] || value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
}

function primaryPrivacyLocalization(detail) {
  const app = detail?.app || currentAppStoreApp || {};
  const localizations = detail?.privacy?.appInfo?.localizations || detail?.appInfo?.localizations || [];
  return localizations.find(item => item.id === activeAppStoreLocaleId) || localizations.find(item => item.locale === app.primaryLocale) || localizations[0] || {};
}

function renderPrivacyLocaleSelector(detail, app) {
  const localizations = detail?.privacy?.appInfo?.localizations || detail?.appInfo?.localizations || [];
  const active = primaryPrivacyLocalization(detail);
  if (localizations.length < 2) return `${escapeHTML(appStoreLocaleName(active.locale || app.primaryLocale || "zh-Hans"))} ${appStoreHelp("这些信息会显示在 App Store 的产品页面上。")}`;
  return `<select class="app-privacy-locale-select" aria-label="选择隐私本地化语言">${localizations.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === active.id ? "selected" : ""}>${escapeHTML(appStoreLocaleName(item.locale))}${item.locale === app.primaryLocale ? "（主要）" : ""}</option>`).join("")}</select> ${appStoreHelp("这些信息会显示在 App Store 的产品页面上。")}`;
}

function renderAppStorePrivacyPane(app, detail) {
  const privacy = detail?.privacy || {};
  const localization = primaryPrivacyLocalization(detail);
  const usages = Array.isArray(privacy.usages) ? privacy.usages : [];
  const published = !!privacy.publishState?.published;
  const privacyPolicyUrl = String(localization.privacyPolicyUrl || "").trim();
  const privacyChoicesUrl = String(localization.privacyChoicesUrl || "").trim();
  const missing = privacyMissingItems(privacy, localization);
  return `<section class="app-privacy-page">
    <div class="app-privacy-head">
      <div><h2>App 隐私</h2></div>
      <button class="primary" id="app-privacy-publish" type="button" ${published ? "disabled" : ""}>发布</button>
    </div>
    ${missing.length ? `<div class="app-privacy-alert"><b>!</b><div><p>要开始审核流程，必须提供以下项目：</p><ul>${missing.map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul></div></div>` : ""}
    <section class="app-privacy-section">
      <div class="app-privacy-section-title"><div class="app-privacy-title-inline"><h3>隐私政策</h3><button class="app-info-link" data-privacy-edit-policy type="button">编辑</button></div><div class="app-info-locale">${renderPrivacyLocaleSelector(detail, app)}</div></div>
      <div class="app-privacy-policy-grid">
        <div><label>隐私政策网址 (URL) ${appStoreHelp("此网址会显示在 App Store 产品页面。")}</label><p>${privacyPolicyUrl ? escapeHTML(privacyPolicyUrl) : "—"}</p></div>
        <div><label>用户隐私选择网址 (URL) <span>（可不填）</span> ${appStoreHelp("如果 App 支持用户管理数据选择，请提供对应网址。")}</label><p>${privacyChoicesUrl ? escapeHTML(privacyChoicesUrl) : "—"}</p></div>
      </div>
      <input type="hidden" data-app-field="privacy.localizationId" value="${escapeHTML(localization.id || "")}">
    </section>
    <section class="app-privacy-section">
      <div class="app-privacy-section-title"><h3>产品页面预览</h3><button class="app-info-link" type="button">查看详细信息</button></div>
      ${renderPrivacyUsageSummary(privacy)}
    </section>
    <section class="app-privacy-section">
      <div class="app-privacy-section-title"><h3>数据类型</h3><button class="app-info-link" data-privacy-open="all" type="button">${usages.length ? "编辑" : "开始"}</button></div>
      ${renderPrivacyDataTypeSummary(privacy)}
    </section>
    ${renderPrivacyCategorySections(privacy)}
  </section>`;
}

function privacyHasDataNotCollected(privacy = {}) {
  return (privacy.usages || []).some(item => item.dataProtectionId === "DATA_NOT_COLLECTED" && !item.categoryId);
}

function privacyCollectedCategoryIds(privacy = {}) {
  return [...new Set((privacy.usages || []).map(item => item.categoryId).filter(Boolean))];
}

function privacyCanPublish(privacy = {}, localization = {}) {
  return privacyMissingItems(privacy, localization).length === 0;
}

function privacyMissingItems(privacy = {}, localization = {}) {
  const items = [];
  const localizations = (privacy?.appInfo?.localizations || currentAppStoreDetail?.appInfo?.localizations || []).filter(Boolean);
  const rows = localizations.length ? localizations : [localization].filter(Boolean);
  rows.forEach(row => {
    if (!String(row.privacyPolicyUrl || "").trim()) {
      const localeName = appStoreLocaleName(row.locale || localization.locale || currentAppStoreApp?.primaryLocale || "zh-Hans");
      items.push(`${localeName} - 隐私政策网址 (URL) - 此栏为必填项。`);
    }
  });
  if (!privacyHasDataNotCollected(privacy) && !privacyCollectedCategoryIds(privacy).length) items.push("数据收集 - 需要回答此 App 是否收集数据。");
  if (privacyCollectedCategoryIds(privacy).some(id => !privacyUsagesForCategory(privacy, id).some(item => item.purposeId && item.dataProtectionId))) items.push("数据类型 - 请为所有已选择的数据类型补全用途和关联信息。");
  return items;
}

function renderPrivacyUsageSummary(privacy = {}) {
  const l10n = privacy.l10n || {};
  const usages = Array.isArray(privacy.usages) ? privacy.usages : [];
  if (privacyHasDataNotCollected(privacy)) return `<div class="app-privacy-product-preview app-privacy-not-collected"><div class="app-privacy-checkmark">✓</div><strong>未收集数据</strong><p>开发者不会从此 App 中收集任何数据。</p></div>`;
  const categoryIds = privacyCollectedCategoryIds(privacy);
  if (!categoryIds.length) return `<button class="app-privacy-empty" data-privacy-open="all" type="button">开始设置数据收集</button>`;
  const linked = categoryIds.filter(id => privacyUsagesForCategory(privacy, id).some(item => item.dataProtectionId === "DATA_LINKED_TO_YOU"));
  const notLinked = categoryIds.filter(id => privacyUsagesForCategory(privacy, id).some(item => item.dataProtectionId === "DATA_NOT_LINKED_TO_YOU"));
  return `<div class="app-privacy-product-preview">
    <div class="app-privacy-preview-icon">◎</div>
    <strong>与你关联的数据</strong>
    <p>开发者可能会收集以下数据，且数据与你的身份关联：</p>
    <ul>${(linked.length ? linked : categoryIds).slice(0, 8).map(id => `<li>${escapeHTML(privacyLabel(id, "category", l10n))}</li>`).join("")}</ul>
    ${notLinked.length ? `<strong>不与你关联的数据</strong><ul>${notLinked.slice(0, 8).map(id => `<li>${escapeHTML(privacyLabel(id, "category", l10n))}</li>`).join("")}</ul>` : ""}
  </div>
  `;
}

function renderPrivacyDataTypeSummary(privacy = {}) {
  const categoryIds = privacyCollectedCategoryIds(privacy);
  if (privacyHasDataNotCollected(privacy)) return "<ul class=\"app-privacy-data-list\"><li>未从此 App 中收集数据。</li></ul>";
  if (!categoryIds.length) return "<ul class=\"app-privacy-data-list\"><li>尚未设置数据收集。</li></ul>";
  return `<ul class="app-privacy-data-list"><li>从此 App 中收集的数据类型有 ${categoryIds.length} 个：${escapeHTML(categoryIds.map(id => privacyLabel(id, "category", privacy.l10n || {})).join("、"))}</li></ul>`;
}

function renderPrivacyCategorySections(privacy = {}) {
  const usages = (privacy.usages || []).filter(item => item.categoryId);
  if (!usages.length) return "";
  const selected = new Set(usages.map(item => item.categoryId));
  return privacyCategoryGroups(privacy).map(group => {
    const rows = group.categories.filter(category => selected.has(category.id));
    if (!rows.length) return "";
    return `<section class="app-privacy-section app-privacy-data-section">
      <h3><span class="app-privacy-group-icon">${escapeHTML(privacyGroupIcon(group.id))}</span>${escapeHTML(privacyLabel(group.id, "grouping", privacy.l10n || {}))}</h3>
      <div class="app-privacy-card-grid">${rows.map(category => renderPrivacyDataCard(category.id, privacy)).join("")}</div>
    </section>`;
  }).join("");
}

function privacyUsagesForCategory(privacy, categoryId) {
  return (privacy?.usages || []).filter(item => item.categoryId === categoryId);
}

function renderPrivacyDataCard(categoryId, privacy = {}) {
  const l10n = privacy.l10n || {};
  const usages = privacyUsagesForCategory(privacy, categoryId);
  const completed = usages.some(item => item.purposeId && item.dataProtectionId);
  const purposes = [...new Set(usages.map(item => item.purposeId).filter(Boolean))];
  const protections = [...new Set(usages.map(item => item.dataProtectionId).filter(Boolean))];
  return `<article class="app-privacy-data-card ${completed ? "complete" : "pending"}">
    <div class="app-privacy-card-title"><span>${completed ? "●" : "⚠"}</span><strong>${escapeHTML(privacyLabel(categoryId, "category", l10n))}</strong>${appStoreHelp("请为此数据类型声明收集用途，以及这些数据是否与你或你的身份相关联。")}</div>
    ${completed ? `<ul>${purposes.map(id => `<li>用于${escapeHTML(privacyLabel(id, "purpose", l10n))}</li>`).join("")}${protections.map(id => `<li>${escapeHTML(privacyLabel(id, "protection", l10n))}</li>`).join("")}</ul>` : ""}
    <button class="app-info-link app-privacy-card-action" data-privacy-open="${escapeHTML(categoryId)}" type="button">${completed ? "编辑" : `设置${escapeHTML(privacyLabel(categoryId, "category", l10n))}`}</button>
  </article>`;
}

function privacyGroupIcon(groupId) {
  const icons = { CONTACT_INFO: "ℹ", HEALTH_AND_FITNESS: "♥", FINANCIAL_INFO: "▰", LOCATION: "◎", SENSITIVE_INFO: "!", USER_CONTENT: "▣", BROWSING_HISTORY: "◔", SEARCH_HISTORY: "⌕", IDENTIFIERS: "▤", PURCHASES: "▰", USAGE_DATA: "▥", DIAGNOSTICS: "⚙", OTHER_DATA: "…" };
  return icons[groupId] || "●";
}

function privacyCategoryGroups(privacy = {}) {
  const groups = new Map();
  for (const group of privacy.groupings || []) groups.set(group.id, { ...group, categories: [] });
  for (const category of privacy.categories || []) {
    const key = category.groupingId || "OTHER";
    if (!groups.has(key)) groups.set(key, { id: key, categories: [] });
    groups.get(key).categories.push(category);
  }
  return [...groups.values()].filter(group => group.categories.length);
}

function privacyModalHost() {
  return el("app-store-content")?.closest(".module") || document.body;
}

function openPrivacyDataCollection(categoryId = "") {
  document.querySelector(".app-privacy-modal-mask")?.remove();
  if (categoryId && categoryId !== "all") {
    openPrivacyCategoryDetailModal(categoryId);
    return;
  }
  const privacy = currentAppStoreDetail?.privacy || {};
  const l10n = privacy.l10n || currentAppStoreDetail?.l10n || {};
  const existingCategoryIds = new Set((privacy.usages || []).map(item => item.categoryId).filter(Boolean));
  const collecting = existingCategoryIds.size > 0 || !(privacy.usages || []).some(item => item.dataProtectionId === "DATA_NOT_COLLECTED" && !item.categoryId);
  const categoryOptions = privacyCategoryGroups(privacy).map(group => `<div class="app-privacy-choice-group"><h4><span class="app-privacy-group-icon">${escapeHTML(privacyGroupIcon(group.id))}</span>${escapeHTML(privacyLabel(group.id, "grouping", l10n))}</h4>${group.categories.map(category => `<label><input type="checkbox" data-privacy-category value="${escapeHTML(category.id)}" ${existingCategoryIds.has(category.id) ? "checked" : ""}><span><strong>${escapeHTML(privacyLabel(category.id, "category", l10n))}</strong><small>${escapeHTML(privacyCategoryHint(category.id, l10n))}</small></span></label>`).join("")}</div>`).join("");
  privacyModalHost().insertAdjacentHTML("beforeend", `<div class="app-info-modal-mask app-privacy-modal-mask"><div class="app-info-modal app-privacy-modal">
    <h2>数据收集</h2>
    <div class="app-privacy-step" data-privacy-step="collect">
      <p>感谢你帮助用户了解你的 App 隐私处理方式。请不要忘记，对于添加到你的 App 中的任何第三方代码，你对其负有责任。</p>
      <ul><li>“收集”是指以允许你和/或你的第三方合作伙伴在过长的时间段内提供服务所必要的时长访问数据的方式从设备传输数据。</li><li>“第三方合作伙伴”包括分析工具、广告网络、第三方 SDK，或其他外部供应商。</li></ul>
      <hr><p>你或你的第三方合作伙伴是否会从此 App 中收集数据？</p>
      <label><input type="radio" name="privacy-collects" value="yes" ${collecting ? "checked" : ""}> 是，我们会从此 App 中收集数据</label>
      <label><input type="radio" name="privacy-collects" value="no" ${!collecting ? "checked" : ""}> 否，我们不会从此 App 中收集数据</label>
    </div>
    <div class="app-privacy-step hidden" data-privacy-step="categories">
      <p>所有此类数据收集必须遵守相关 App Store 准则，且数据不可用于追踪目的。如果你的 App 收集的数据类型仅符合上述部分而非所有条件，则你必须在隐私部分中进行披露。</p>
      <div class="app-privacy-category-list">${categoryOptions || '<div class="app-empty-line">Apple 未返回可用的数据类型。</div>'}</div>
    </div>
    <div class="error app-privacy-error"></div>
    <div class="app-info-modal-actions"><button class="secondary" id="app-privacy-back" type="button">返回</button><button class="secondary" data-privacy-close type="button">取消</button><button class="primary" id="app-privacy-next" type="button">下一步</button></div>
  </div></div>`);
  const mask = document.querySelector(".app-privacy-modal-mask");
  const close = () => mask?.remove();
  mask?.addEventListener("click", event => { if (event.target === mask) close(); });
  mask?.querySelector("[data-privacy-close]")?.addEventListener("click", close);
  mask?.querySelectorAll(".app-help").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    document.querySelectorAll(".app-help.open").forEach(item => { if (item !== button) item.classList.remove("open"); });
    button.classList.toggle("open");
  }));
  let step = "collect";
  const renderStep = () => {
    mask?.querySelectorAll("[data-privacy-step]").forEach(node => node.classList.toggle("hidden", node.dataset.privacyStep !== step));
    const back = el("app-privacy-back");
    const next = el("app-privacy-next");
    if (back) back.style.visibility = step === "categories" ? "visible" : "hidden";
    if (next) next.textContent = step === "categories" || mask?.querySelector("input[name=privacy-collects]:checked")?.value === "no" ? "保存" : "下一步";
    updatePrivacyCategorySaveState(mask);
  };
  mask?.querySelectorAll("input").forEach(input => input.addEventListener("change", () => updatePrivacyCategorySaveState(mask)));
  el("app-privacy-back")?.addEventListener("click", () => { step = "collect"; renderStep(); });
  el("app-privacy-next")?.addEventListener("click", async () => {
    if (step === "collect" && mask?.querySelector("input[name=privacy-collects]:checked")?.value === "yes") {
      step = "categories";
      renderStep();
      return;
    }
    await savePrivacyCategorySelection(mask);
  });
  renderStep();
}

function openPrivacyButton(categoryId = "") {
  try {
    openPrivacyDataCollection(categoryId);
  } catch (error) {
    showAppStoreError(error.message || "无法打开编辑窗口", "", "App 隐私打开失败");
  }
  return false;
}
function privacyCategoryHint(categoryId, l10n = {}) {
  const text = privacyL10n(l10n, `ITC.Apps.Privacy.Category.${categoryId}.Description`) || privacyL10n(l10n, `ITC.Apps.Privacy.DataCategory.${categoryId}.Description`);
  return text ? text.replace(/<[^>]+>/g, "") : "";
}

function privacyPurposeHint(purposeId) {
  const map = {
    THIRD_PARTY_ADVERTISING: "例如，在 App 中显示第三方广告、与显示第三方广告的实体共享数据",
    DEVELOPERS_ADVERTISING: "例如，在 App 中显示甲方广告、向用户直接发送营销信息",
    ANALYTICS: "使用数据评估用户行为，包括了解现有产品功能的效果、规划新功能、衡量受众规模或特征",
    PRODUCT_PERSONALIZATION: "自定用户看到的内容，例如包含推荐产品、帖子、建议的列表",
    APP_FUNCTIONALITY: "例如，认证用户身份、启用功能、防止欺诈、实施安全措施、确保服务器正常运行时间、最大限度减少 App 崩溃、提升可扩展性和性能、提供客户支持",
    OTHER_PURPOSES: "任何未列出的其他用途",
  };
  return map[purposeId] || "";
}

function updatePrivacyCategorySaveState(mask) {
  const button = el("app-privacy-next");
  if (!button || !mask) return;
  const collects = mask.querySelector("input[name=privacy-collects]:checked")?.value || "yes";
  const inCategories = !mask.querySelector('[data-privacy-step="categories"]')?.classList.contains("hidden");
  button.disabled = inCategories && collects !== "no" && !mask.querySelector("[data-privacy-category]:checked");
}

async function savePrivacyCategorySelection(mask) {
  const button = el("app-privacy-next");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const privacy = currentAppStoreDetail?.privacy || {};
  if (!appId || !button) return;
  const collects = mask?.querySelector("input[name=privacy-collects]:checked")?.value || "yes";
  const selectedIds = new Set(collects === "no" ? [] : [...mask.querySelectorAll("[data-privacy-category]:checked")].map(input => input.value).filter(Boolean));
  setBusy(button, true, "保存中…");
  try {
    for (const usage of privacy.usages || []) {
      const shouldDelete = !usage.categoryId || !selectedIds.has(usage.categoryId);
      if (shouldDelete) {
        const deleted = await window.appleDeveloper.deleteAppStoreDataUsage({ appId, usageId: usage.id });
        if (!deleted?.success) throw new Error(deleted?.error || "数据类型更新失败");
      }
    }
    const currentIds = new Set((privacy.usages || []).map(item => item.categoryId).filter(Boolean));
    if (collects === "no") {
      const result = await window.appleDeveloper.createAppStoreDataUsage({ appId, dataProtectionId: "DATA_NOT_COLLECTED" });
      if (result?.success) mask?.remove();
      await refreshAppStorePrivacyFromResult(result);
      return;
    }
    let latest = null;
    for (const categoryId of selectedIds) {
      if (currentIds.has(categoryId)) continue;
      latest = await window.appleDeveloper.createAppStoreDataUsage({ appId, categoryId });
      if (!latest?.success) throw new Error(latest?.error || "数据类型保存失败");
    }
    if (!latest) latest = await window.appleDeveloper.appStorePrivacyDetail(appId);
    if (latest?.success) mask?.remove();
    await refreshAppStorePrivacyFromResult(latest);
  } catch (error) {
    const box = mask?.querySelector(".app-privacy-error");
    if (box) box.textContent = error.message || "保存失败";
  } finally {
    if (document.body.contains(button)) setBusy(button, false);
  }
}

function openPrivacyCategoryDetailModal(categoryId) {
  const privacy = currentAppStoreDetail?.privacy || {};
  const l10n = privacy.l10n || currentAppStoreDetail?.l10n || {};
  const usages = privacyUsagesForCategory(privacy, categoryId);
  const selectedPurposes = new Set(usages.map(item => item.purposeId).filter(Boolean));
  const selectedProtection = usages.find(item => item.dataProtectionId)?.dataProtectionId || "DATA_LINKED_TO_YOU";
  const selectedTracking = usages.some(item => item.tracking === true) ? "yes" : "no";
  const purposes = (privacy.purposes || []).filter(item => !item.deleted);
  privacyModalHost().insertAdjacentHTML("beforeend", `<div class="app-info-modal-mask app-privacy-modal-mask"><div class="app-info-modal app-privacy-modal app-privacy-purpose-modal">
    <h2>${escapeHTML(privacyLabel(categoryId, "category", l10n))}</h2>
    <div class="app-privacy-purpose-steps">
      <section data-privacy-purpose-step="purposes">
        <p>请注明你或你的第三方合作伙伴会如何使用从此 App 中收集的${escapeHTML(privacyLabel(categoryId, "category", l10n))}（请选择所有适用项）：</p>
        ${purposes.map(item => `<label><input type="checkbox" data-privacy-purpose value="${escapeHTML(item.id)}" ${selectedPurposes.has(item.id) ? "checked" : ""}><span><strong>${escapeHTML(privacyLabel(item.id, "purpose", l10n))}</strong><small>${escapeHTML(privacyPurposeHint(item.id))}</small></span></label>`).join("")}
      </section>
      <section class="hidden" data-privacy-purpose-step="linked">
        <p>接下来，请注明从此 App 中收集的数据是否与用户身份关联（经由用户的账户、设备或详细信息）。</p>
        <p>从 App 中收集的数据通常经由这些途径与用户身份关联，除非在收集数据前采取特定的隐私保护措施，以对数据进行去标识化或匿名处理。</p>
        <ul><li>在收集数据前去除直接标识符，例如电子邮件地址或姓名。</li><li>通过对数据的处理，断开与真实身份的关联并防止再次关联。</li><li>你不得尝试将数据再次关联到用户身份。</li></ul>
        <hr><h3>从此 App 中收集的${escapeHTML(privacyLabel(categoryId, "category", l10n))}是否与用户身份关联？</h3>
        <label><input type="radio" name="privacy-protection" data-privacy-protection value="DATA_LINKED_TO_YOU" ${selectedProtection !== "DATA_NOT_LINKED_TO_YOU" ? "checked" : ""}><span>是，从此 App 中收集的${escapeHTML(privacyLabel(categoryId, "category", l10n))}与用户身份关联</span></label>
        <label><input type="radio" name="privacy-protection" data-privacy-protection value="DATA_NOT_LINKED_TO_YOU" ${selectedProtection === "DATA_NOT_LINKED_TO_YOU" ? "checked" : ""}><span>否，从此 App 中收集的${escapeHTML(privacyLabel(categoryId, "category", l10n))}未与用户身份关联</span></label>
      </section>
      <section class="hidden" data-privacy-purpose-step="tracking-def">
        <p>在进行下一步之前，我们先来定义两个重要的术语。</p>
        <h3>追踪</h3>
        <p>追踪是指将从您的 App 中收集的有关特定最终用户或设备的数据（例如用户 ID、设备 ID 或描述文件）与第三方数据相关联用于定向广告或广告评估目的。同时，追踪也指与数据中间商共享从您的 App 中收集的有关特定最终用户或设备的数据。</p>
        <p>追踪不适用于以下情况：</p>
        <ul><li>数据仅关联在最终用户的设备上，且不会以可识别最终用户或设备的方式从设备发送。</li><li>数据中间商在使用共享给他们的数据时，仅出于欺诈检测和预防或安全相关目的。</li><li>数据中间商是消费者报告机构，且共享给他们的数据是用于消费者信用相关目的。</li></ul>
        <h3>第三方数据</h3>
        <p>第三方数据是指任何从不归开发者所有的 App、网站或离线属性文件中收集的有关特定最终用户或设备的数据。</p>
      </section>
      <section class="hidden" data-privacy-purpose-step="tracking-examples">
        <p>为了更具体地解释追踪，以下是几个例子：</p>
        <ul><li>基于从其他公司的 App 和网站中收集的用户数据，在你的 App 中显示定向广告。</li><li>与数据中间商共享设备位置数据或电子邮件列表。</li><li>与第三方广告网络共享电子邮件、广告 ID 或其他 ID 的列表，而第三方广告网络利用相关信息在其他开发者的 App 中将这些用户重定位，或寻找类似用户。</li><li>在你的 App 中加入第三方 SDK，该 SDK 会将 App 中的用户数据与其他开发者 App 中的用户数据相结合，以投放定向广告或衡量广告投放效率。</li></ul>
      </section>
      <section class="hidden" data-privacy-purpose-step="tracking-choice">
        <p>最后，请注明你的第三方合作伙伴是否会将${escapeHTML(privacyLabel(categoryId, "category", l10n))}用于追踪目的。</p>
        <h3>你或你的第三方合作伙伴是否会将${escapeHTML(privacyLabel(categoryId, "category", l10n))}用于追踪目的？</h3>
        <label><input type="radio" name="privacy-tracking" data-privacy-tracking value="yes" ${selectedTracking === "yes" ? "checked" : ""}><span>是，我们会将${escapeHTML(privacyLabel(categoryId, "category", l10n))}用于追踪目的</span></label>
        <label><input type="radio" name="privacy-tracking" data-privacy-tracking value="no" ${selectedTracking !== "yes" ? "checked" : ""}><span>否，我们不会将${escapeHTML(privacyLabel(categoryId, "category", l10n))}用于追踪目的</span></label>
        <details open><summary>定义和示例</summary><h3>追踪</h3><p>追踪是指将从 App 中收集的数据与第三方数据相关联用于定向广告或广告评估目的，或与数据中间商共享。</p><h3>第三方数据</h3><p>第三方数据是从不归开发者所有的 App、网站或离线属性中收集的数据。</p></details>
      </section>
    </div>
    <div class="error app-privacy-error"></div>
    <div class="app-info-modal-actions"><button class="secondary" id="app-privacy-purpose-back" type="button">返回</button><button class="secondary" data-privacy-close type="button">取消</button><button class="primary" id="app-privacy-category-save" type="button">下一步</button></div>
  </div></div>`);
  const mask = document.querySelector(".app-privacy-modal-mask");
  const close = () => mask?.remove();
  mask?.addEventListener("click", event => { if (event.target === mask) close(); });
  mask?.querySelector("[data-privacy-close]")?.addEventListener("click", close);
  mask?.querySelectorAll(".app-help").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    document.querySelectorAll(".app-help.open").forEach(item => { if (item !== button) item.classList.remove("open"); });
    button.classList.toggle("open");
  }));
  const steps = ["purposes", "linked", "tracking-def", "tracking-examples", "tracking-choice"];
  let stepIndex = 0;
  const renderStep = () => {
    mask?.querySelectorAll("[data-privacy-purpose-step]").forEach(node => node.classList.toggle("hidden", node.dataset.privacyPurposeStep !== steps[stepIndex]));
    const back = el("app-privacy-purpose-back");
    const next = el("app-privacy-category-save");
    if (back) back.style.visibility = stepIndex ? "visible" : "hidden";
    if (next) next.textContent = stepIndex === steps.length - 1 ? "保存" : "下一步";
    update();
  };
  const update = () => {
    const next = el("app-privacy-category-save");
    if (!next) return;
    const step = steps[stepIndex];
    if (step === "purposes") next.disabled = !mask?.querySelector("[data-privacy-purpose]:checked");
    else if (step === "linked") next.disabled = !mask?.querySelector("[data-privacy-protection]:checked");
    else if (step === "tracking-choice") next.disabled = !mask?.querySelector("[data-privacy-tracking]:checked");
    else next.disabled = false;
  };
  mask?.querySelectorAll("input").forEach(input => input.addEventListener("change", update));
  el("app-privacy-purpose-back")?.addEventListener("click", () => {
    if (stepIndex > 0) {
      stepIndex -= 1;
      renderStep();
    }
  });
  el("app-privacy-category-save")?.addEventListener("click", () => {
    if (stepIndex < steps.length - 1) {
      stepIndex += 1;
      renderStep();
      return;
    }
    savePrivacyCategoryDetail(mask, categoryId);
  });
  renderStep();
}

async function savePrivacyCategoryDetail(mask, categoryId) {
  const button = el("app-privacy-category-save");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const privacy = currentAppStoreDetail?.privacy || {};
  const purposeIds = [...mask.querySelectorAll("[data-privacy-purpose]:checked")].map(input => input.value).filter(Boolean);
  const dataProtectionId = mask.querySelector("[data-privacy-protection]:checked")?.value || "";
  const tracking = mask.querySelector("[data-privacy-tracking]:checked")?.value || "no";
  if (!appId || !button || !categoryId || !purposeIds.length || !dataProtectionId) return;
  setBusy(button, true, "保存中…");
  try {
    for (const usage of privacyUsagesForCategory(privacy, categoryId)) {
      const deleted = await window.appleDeveloper.deleteAppStoreDataUsage({ appId, usageId: usage.id });
      if (!deleted?.success) throw new Error(deleted?.error || "数据声明更新失败");
    }
    let latest = null;
    for (const purposeId of purposeIds) {
      latest = await window.appleDeveloper.createAppStoreDataUsage({ appId, categoryId, purposeId, dataProtectionId });
      if (!latest?.success) throw new Error(latest?.error || "数据声明保存失败");
    }
    if (latest?.privacy?.usages) latest.privacy.usages = latest.privacy.usages.map(item => item.categoryId === categoryId ? { ...item, tracking: tracking === "yes" } : item);
    if (latest?.success) mask?.remove();
    await refreshAppStorePrivacyFromResult(latest);
  } catch (error) {
    const box = mask?.querySelector(".app-privacy-error");
    if (box) box.textContent = error.message || "保存失败";
  } finally {
    if (document.body.contains(button)) setBusy(button, false);
  }
}

function mergeAppInfoBundleOptions(app, bundles = []) {
  const seen = new Set();
  const rows = [];
  const push = item => {
    const bundleId = String(item?.bundleId || "").trim();
    if (!bundleId || seen.has(bundleId)) return;
    seen.add(bundleId);
    rows.push({ bundleId, name: String(item?.name || bundleId) });
  };
  (appStoreBundleIds || []).forEach(push);
  (bundles || []).forEach(push);
  push({ bundleId: app.bundleId || "", name: app.bundleIdName || app.bundleId || "" });
  return rows;
}

function renderAppInfoBundleOptions(app, bundles = []) {
  const current = app.bundleId || "";
  const rows = bundles.length ? bundles : [{ bundleId: current, name: app.bundleIdName || current }];
  return rows.map(item => `<option value="${escapeHTML(item.bundleId || "")}" ${item.bundleId === current ? "selected" : ""}>${escapeHTML(`${item.name || item.bundleId} - ${item.bundleId}`)}</option>`).join("");
}

function renderContentRightsSummary(value) {
  if (value === "USES_THIRD_PARTY_CONTENT") return "是，此 App 拥有对其第三方内容的必要权利。";
  if (value === "DOES_NOT_USE_THIRD_PARTY_CONTENT") return "否，此 App 不包含、显示或访问第三方内容。";
  return '<button class="app-info-empty-box" data-app-info-modal="content-rights" type="button">设置内容版权信息</button>';
}

function appStoreL10n(key, fallback = "") {
  return currentAppStoreDetail?.l10n?.[key]?.loc || fallback || "";
}

function categoryDisplayName(item) {
  return item?.name || appStoreL10n(`ITC.AppInfo.Categories.${item?.id || ""}`, item?.id || "");
}

function renderAppCategoryOptions(categories = [], selectedId = "", placeholder = "主要", allowEmpty = false) {
  const options = allowEmpty ? [`<option value="">${escapeHTML(placeholder)}</option>`] : [];
  if (!categories.length) options.push(`<option value="">${escapeHTML(selectedId || placeholder)}</option>`);
  for (const item of flattenAppCategories(categories)) options.push(`<option value="${escapeHTML(item.id)}" ${String(item.id) === String(selectedId || "") ? "selected" : ""}>${escapeHTML(categoryDisplayName(item))}</option>`);
  return options.join("");
}

function flattenAppCategories(categories = []) {
  const rows = [];
  const seen = new Set();
  const push = item => {
    if (!item?.id || seen.has(item.id)) return;
    seen.add(item.id);
    rows.push(item);
  };
  for (const item of categories) {
    push(item);
    (item.subcategories || []).forEach(push);
  }
  return rows;
}

function findAppCategory(id) {
  return flattenAppCategories(currentAppStoreDetail?.categories || []).find(item => String(item.id) === String(id || "")) || null;
}

function renderAgeRatingSummary(detail) {
  const ratings = Array.isArray(detail?.territoryAgeRatings) ? detail.territoryAgeRatings : [];
  const appInfo = detail?.appInfo || {};
  const loading = !!(detail?.loading || detail?.partial) && !ratings.length;
  if (loading) return '<div class="app-age-summary-loading"><i class="loading-spinner"></i><span>正在读取年龄分级数据…</span></div>';
  if (!ratings.length && !appInfo?.ageRatingDeclaration?.attributes) return '<div class="app-info-action-box"><button class="primary" data-app-info-modal="age-rating" type="button">设置年龄分级</button></div>';
  const counts = new Map();
  for (const item of ratings) counts.set(item.appStoreAgeRating, (counts.get(item.appStoreAgeRating) || 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [appInfo.attributes?.appStoreAgeRating || "", 0];
  const territoryPriority = { BRA: 1, KOR: 2, VNM: 3 };
  const specials = ratings
    .filter(item => item.appStoreAgeRating && item.appStoreAgeRating !== common[0])
    .sort((left, right) => (territoryPriority[left.territoryId] || 99) - (territoryPriority[right.territoryId] || 99))
    .slice(0, 3);
  const cards = [
    { rating: common[0], title: `${common[1] || ratings.length || 0} 个国家或地区` },
    ...specials.map(item => ({ rating: item.appStoreAgeRating, title: item.territoryName || item.territoryId })),
  ];
  const infoUrl = appInfo.ageRatingDeclaration?.attributes?.developerAgeRatingInfoUrl || "";
  const globalRating = appAgeRatingText(common[0] || appInfo.attributes?.appStoreAgeRating || "");
  const hasExceptions = specials.length > 0;
  if (isUnratedAgeRating(common[0] || appInfo.attributes?.appStoreAgeRating)) {
    return `<div class="app-age-summary-head"><span>App 年龄分级</span><button class="app-info-link" data-app-info-modal="age-rating" type="button">编辑</button><i></i><button class="app-info-link" type="button">查看详细信息</button></div>
      <div class="app-age-unrated">未评级</div>
      ${infoUrl ? `<div class="app-age-summary-line"><strong>适龄信息 URL ${appStoreHelp("如果想要提供 App 有关的其他适龄信息，请在下方附上 URL。")}</strong><span>${escapeHTML(infoUrl)}</span></div>` : ""}
      <div class="app-age-summary-line"><strong>操作系统版本低于 26</strong><span>未评级</span></div>`;
  }
  return `<div class="app-age-summary-head"><span>App 年龄分级</span><button class="app-info-link" data-app-info-modal="age-rating" type="button">编辑</button><i></i><button class="app-info-link" type="button">查看详细信息</button></div>
    <p>用户只会在 App Store 上看到适用于所有国家或地区的年龄分级。</p>
    <div class="app-age-summary-cards">${cards.map(card => `<article><strong class="${appAgeRatingBadgeClass(card.rating)}">${escapeHTML(appAgeRatingText(card.rating, card.title))}</strong><span>${escapeHTML(card.title)}</span></article>`).join("")}</div>
    ${infoUrl ? `<div class="app-age-summary-line"><strong>适龄信息 URL ${appStoreHelp("如果想要提供 App 有关的其他适龄信息，请在下方附上 URL。")}</strong><span>${escapeHTML(infoUrl)}</span></div>` : ""}
    <div class="app-age-summary-line"><strong>操作系统版本低于 26</strong><span>全球分级为 ${escapeHTML(globalRating)}${hasExceptions ? "（有区域例外）" : ""} <button class="app-info-link" type="button">查看详细信息</button></span></div>`;
}

function refreshAppStoreAgeRatingSummary(ageRating = {}) {
  if (!currentAppStoreDetail || !ageRating?.appInfo) return;
  const currentAppInfo = currentAppStoreDetail.appInfo || {};
  currentAppStoreDetail = {
    ...currentAppStoreDetail,
    appInfo: {
      ...currentAppInfo,
      attributes: { ...(currentAppInfo.attributes || {}), ...(ageRating.appInfo.attributes || {}) },
      ageRatingDeclarationId: ageRating.appInfo.ageRatingDeclarationId || currentAppInfo.ageRatingDeclarationId,
      ageRatingDeclaration: ageRating.appInfo.ageRatingDeclaration || currentAppInfo.ageRatingDeclaration,
    },
    territoryAgeRatings: Array.isArray(ageRating.territoryAgeRatings) ? ageRating.territoryAgeRatings : [],
  };
  const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
  if (appId) {
    clearAppStoreDetailCache(appId);
    cacheAppStoreDetail(appId, currentAppStoreDetail, currentAppStoreDetail?.selectedVersion?.id || "");
  }
  document.querySelector('[data-app-field="appInfo.ageRatingAttributes"]')?.remove();
  const summary = document.getElementById("app-age-rating-summary");
  if (!summary) return;
  summary.innerHTML = renderAgeRatingSummary(currentAppStoreDetail);
  summary.querySelectorAll('[data-app-info-modal="age-rating"]').forEach(button =>
    button.addEventListener("click", () => openAppInfoModal("age-rating"))
  );
  bindAppStoreHelpButtons(summary);
}

function appAgeRatingText(value, territoryName = "") {
  if (String(value || "") === "ALL" && /韩|Korea|KOR/i.test(String(territoryName || ""))) return "全部";
  if (String(value || "") === "L" || String(value || "") === "SELF_RATED_L") return "AL";
  const map = { FOUR_PLUS: "4+", NINE_PLUS: "9+", TEN_PLUS: "AL", TWELVE_PLUS: "12+", THIRTEEN_PLUS: "13+", FIFTEEN_PLUS: "15+", SIXTEEN_PLUS: "16+", SEVENTEEN_PLUS: "17+", EIGHTEEN_PLUS: "18+", L: "AL", ALL: "全部", ZERO_ZERO: "00+", UNRATED: "UNRATED" };
  return map[value] || String(value || "—").replace(/_/g, " ");
}

function isUnratedAgeRating(value) {
  return /^(UNRATED|NOT_RATED|NONE)?$/i.test(String(value || ""));
}

function appAgeRatingBadgeClass(value) {
  const rating = String(value || "");
  if (rating === "L" || rating === "TEN_PLUS" || rating === "SELF_RATED_L" || rating === "SELF_RATED_TEN") return "brazil";
  return "";
}

function appStoreLocaleName(locale) {
  const map = { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", "en-US": "英语（美国）", "en-AU": "英语（澳大利亚）", "en-GB": "英语（英国）", "en-CA": "英语（加拿大）", ja: "日语", ko: "韩语" };
  if (map[locale]) return map[locale];
  try { return new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(locale) || locale || "—"; }
  catch { return locale || "—"; }
}

async function ensureAgeRatingDetailBeforeModal() {
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  if (!appId || typeof window.appleDeveloper?.appStoreAppDetail !== "function") return;
  if (hasCompleteAgeRatingDetail(currentAppStoreDetail)) return;
  const versionId = currentAppStoreDetail?.selectedVersion?.id || "";
  const result = await fetchAppStoreDetail({ id: appId }, versionId, false, { mode: "full" }).catch(error => ({ success: false, error: error.message }));
  if (result?.success && result.detail) updateCurrentAppStoreDetail(result.detail);
}

function hasCompleteAgeRatingDetail(detail = currentAppStoreDetail) {
  if (!detail || detail.loading || detail.partial) return false;
  const declaration = detail?.appInfo?.ageRatingDeclaration?.attributes || {};
  return !!(Object.keys(declaration).length || (Array.isArray(detail?.territoryAgeRatings) && detail.territoryAgeRatings.length));
}

async function openAppInfoModal(kind) {
  document.querySelector(".app-info-modal-mask")?.remove();
  if (kind === "age-rating") await ensureAgeRatingDetailBeforeModal();
  const modal = {
    "content-rights": appInfoContentRightsModal(),
    "age-rating": appInfoAgeRatingModal(),
    license: appInfoLicenseModal(),
    icp: appInfoIcpModal(),
  }[kind];
  if (!modal) return;
  document.body.insertAdjacentHTML("beforeend", modal);
  const mask = document.querySelector(".app-info-modal-mask");
  mask?.addEventListener("click", event => { if (event.target === mask) closeAppInfoModal(); });
  mask?.querySelectorAll("[data-app-modal-close]").forEach(button => button.addEventListener("click", closeAppInfoModal));
  bindAppStoreHelpButtons(mask || document);
  mask?.querySelector("[data-app-content-rights-done]")?.addEventListener("click", () => {
    const value = mask.querySelector("input[name=content-rights]:checked")?.value || "";
    let hidden = document.querySelector('[data-app-field="appInfo.contentRightsDeclaration"]');
    if (!hidden) {
      document.querySelector(".app-info-page")?.insertAdjacentHTML("beforeend", '<input type="hidden" data-app-field="appInfo.contentRightsDeclaration">');
      hidden = document.querySelector('[data-app-field="appInfo.contentRightsDeclaration"]');
    }
    hidden.value = value;
    const summary = document.getElementById("app-content-rights-summary");
    if (summary) summary.innerHTML = renderContentRightsSummary(value);
    markAppStoreDetailDirty();
    closeAppInfoModal();
  });
  if (kind === "icp") {
    const entry = mask.querySelector("[data-app-icp-entry]");
    const confirmation = mask.querySelector("[data-app-icp-confirmation]");
    const input = mask.querySelector("[data-app-icp-input]");
    let pendingNumber = "";
    const submitIcp = async consent => {
      const value = consent ? pendingNumber : String(input?.value || "").trim();
      const errorBox = mask.querySelector(consent ? ".app-icp-confirm-error" : ".app-icp-error");
      if (errorBox) errorBox.innerHTML = "";
      if (!value) {
        if (errorBox) errorBox.textContent = "请输入 ICP 备案号";
        return;
      }
      const button = mask.querySelector(consent ? "[data-app-icp-confirm]" : "[data-app-icp-done]");
      if (button) setBusy(button, true, "保存中…");
      try {
        const appId = String(currentAppStoreApp?.id || currentAppStoreDetail?.app?.id || "");
        const result = await window.appleDeveloper.saveAppStoreIcpNumber({
          appId,
          icpNumber: value,
          ...(consent ? { developerNameMismatchConsent: true } : {}),
        });
        if (result?.confirmationRequired && !consent) {
          pendingNumber = value;
          mask.querySelector(".app-icp-confirm-error").innerHTML = "";
          const developerName = String(currentAppStoreApp?.sellerName || homeBusinessStatus?.provider?.name || homeBusinessStatus?.legalEntity?.name || "").trim();
          const developerLabel = developerName ? `“${developerName}”` : "当前开发者";
          mask.querySelector("[data-app-icp-consent-copy]").textContent = `${developerLabel}与工信部该备案号关联的名称不符。若要继续，请确认你是此 App 的所有者。`;
          mask.querySelector("[data-app-icp-consent-statement]").textContent = `我确认${developerLabel}是以此 ICP 备案号注册的提供商或其关联方。`;
          mask.querySelector("[data-app-icp-consent-number]").textContent = value;
          entry.hidden = true;
          confirmation.hidden = false;
          return;
        }
        if (!result?.success) {
          if (errorBox) errorBox.innerHTML = renderIcpReadableError((result?.errors || [])[0] || result?.error || "保存失败");
          return;
        }
        const app = {
          ...(currentAppStoreDetail?.app || {}),
          icpNumber: value,
          icpNumberDetail: { ...(currentAppStoreDetail?.app?.icpNumberDetail || {}), id: appId, icpNumber: value },
        };
        updateCurrentAppStoreDetail({ ...currentAppStoreDetail, app }, { clearCache: true });
        if (currentAppStoreApp) currentAppStoreApp.icpNumber = value;
        const hidden = document.querySelector('[data-app-field="appInfo.icpNumber"]');
        const summary = document.getElementById("app-icp-summary");
        if (hidden) hidden.value = value;
        if (summary) summary.textContent = value;
        closeAppInfoModal();
        showAppStoreNotice("ICP 备案号已保存。");
      } catch (error) {
        if (errorBox) errorBox.innerHTML = renderIcpReadableError(error.message || "保存失败");
      } finally {
        if (button) setBusy(button, false);
      }
    };
    mask.querySelector("[data-app-icp-done]")?.addEventListener("click", () => submitIcp(false));
    mask.querySelector("[data-app-icp-confirm]")?.addEventListener("click", () => submitIcp(true));
    mask.querySelector("[data-app-icp-back]")?.addEventListener("click", () => {
      confirmation.hidden = true;
      entry.hidden = false;
      pendingNumber = "";
      input?.focus();
    });
    input?.addEventListener("input", () => { mask.querySelector(".app-icp-error").innerHTML = ""; });
  }
  bindAgeRatingModal(mask);
}

function closeAppInfoModal() {
  document.querySelector(".app-info-modal-mask")?.remove();
}

function appInfoContentRightsModal() {
  const current = appStoreFieldValue("appInfo.contentRightsDeclaration");
  return `<div class="app-info-modal-mask"><div class="app-info-modal app-info-content-modal">
    <h2>内容版权</h2>
    <p>如果 App 包含、显示或会访问第三方内容，则必须拥有相应内容的所有必要版权，或者在提供该 App 的所有国家或地区依法获得使用相应内容。</p>
    <p>你的 App 是否包含、显示或者会访问第三方内容?</p>
    <label><input type="radio" name="content-rights" value="USES_THIRD_PARTY_CONTENT" ${current === "USES_THIRD_PARTY_CONTENT" ? "checked" : ""}> 是，它包含、显示或会访问第三方内容，并且我拥有相应内容的必要版权</label>
    <label><input type="radio" name="content-rights" value="DOES_NOT_USE_THIRD_PARTY_CONTENT" ${current === "DOES_NOT_USE_THIRD_PARTY_CONTENT" ? "checked" : ""}> 不，它不包含、显示或访问第三方内容</label>
    <div class="app-info-modal-actions"><button class="secondary" data-app-modal-close type="button">取消</button><button class="primary" data-app-content-rights-done type="button">完成</button></div>
  </div></div>`;
}

function appInfoAgeRatingModal() {
  const steps = appAgeRatingSteps();
  const step = steps[0];
  return `<div class="app-info-modal-mask"><div class="app-info-modal app-age-modal">
    <h2>年龄分级</h2>
    <div class="app-age-steps" style="--age-step-count:${steps.length}">${steps.map((item, index) => `<span class="${index === 0 ? "active" : ""}" data-age-step-tab="${index}">${escapeHTML(ageRatingStepLabel(item, index, index === 0))}</span>`).join("")}</div>
    <div class="app-age-step-content" data-age-step="0">${renderAgeRatingStep(step, 0)}</div>
    <div class="app-age-error" role="alert"></div>
    <div class="app-info-modal-actions"><button class="secondary" data-age-back type="button" disabled>返回</button><button class="secondary" data-app-modal-close type="button">取消</button><button class="primary" data-age-next type="button" disabled>下一步</button></div>
  </div></div>`;
}

function bindAgeRatingModal(mask) {
  const next = mask?.querySelector("[data-age-next]");
  const back = mask?.querySelector("[data-age-back]");
  if (!next) return;
  let stepIndex = 0;
  let ageAttributes = currentAgeRatingAttributes();
  activeAgeRatingDraftAttributes = { ...ageAttributes };
  const steps = appAgeRatingSteps();
  const syncDraft = () => {
    ageAttributes = { ...ageAttributes, ...collectAgeRatingAttributes(mask) };
    activeAgeRatingDraftAttributes = { ...ageAttributes };
  };
  const update = () => {
    syncDraft();
    const audience = mask.querySelector('input[name="age-audience"]:checked')?.value || "none";
    const childPanel = mask.querySelector(".app-age-child-panel");
    const overridePanel = mask.querySelector(".app-age-override-panel");
    const blockingNotice = !!mask.querySelector(".app-age-notice.blocking");
    if (childPanel) childPanel.hidden = audience !== "kids";
    if (overridePanel) overridePanel.hidden = audience !== "override";
    const names = [...new Set([...mask.querySelectorAll(".app-age-step-content input[type=radio]")].map(input => input.name))];
    next.disabled = !names.every(name => mask.querySelector(`input[name="${name}"]:checked`));
    if (!names.length) next.disabled = false;
    if (audience === "kids") next.disabled = next.disabled || !String(mask.querySelector(".app-age-child-panel select")?.value || "").trim() || mask.querySelector(".app-age-child-panel select")?.value === "null";
    if (audience === "override") next.disabled = next.disabled || !String(mask.querySelector(".app-age-override-panel select")?.value || "").trim() || mask.querySelector(".app-age-override-panel select")?.value === "null";
    if (blockingNotice) next.disabled = true;
    next.textContent = stepIndex === steps.length - 1 ? "保存" : "下一步";
    if (back) back.disabled = stepIndex === 0;
  };
  const render = () => {
    mask.querySelector(".app-age-step-content").innerHTML = renderAgeRatingStep(steps[stepIndex], stepIndex);
    mask.querySelectorAll(".app-age-steps span").forEach((tab, index) => {
      const active = index === stepIndex;
      tab.classList.toggle("active", active);
      tab.textContent = ageRatingStepLabel(steps[index], index, active);
    });
    mask.querySelectorAll(".app-age-step-content input,.app-age-step-content select").forEach(input => input.addEventListener("change", update));
    update();
  };
  next.addEventListener("click", async () => {
    syncDraft();
    if (stepIndex < steps.length - 1) {
      stepIndex += 1;
      render();
    } else {
      const attributes = { ...ageAttributes, ...collectAgeRatingAttributes(mask, { includeDefaults: true }) };
      const errorBox = mask.querySelector(".app-age-error");
      if (errorBox) errorBox.textContent = "";
      setBusy(next, true, "保存中…");
      try {
        const result = await window.appleDeveloper.saveAppStoreAgeRating({
          appId: currentAppStoreApp?.id || currentAppStoreDetail?.app?.id,
          appInfoId: currentAppStoreDetail?.appInfo?.id,
          ageRatingDeclarationId: currentAppStoreDetail?.appInfo?.ageRatingDeclarationId,
          attributes,
        });
        if (!result?.success) {
          if (errorBox) errorBox.textContent = [...new Set([...(result?.errors || []).map(appStoreReadableError), result?.error].filter(Boolean))].join("；") || "年龄分级保存失败";
          return;
        }
        refreshAppStoreAgeRatingSummary(result.ageRating);
        activeAgeRatingDraftAttributes = null;
        closeAppInfoModal();
        showAppStoreNotice("年龄分级已保存并刷新。");
      } catch (error) {
        if (errorBox) errorBox.textContent = error.message || "年龄分级保存失败";
      } finally {
        setBusy(next, false);
      }
    }
  });
  back?.addEventListener("click", () => {
    if (stepIndex > 0) {
      syncDraft();
      stepIndex -= 1;
      render();
    }
  });
  render();
}

function ageRatingStepLabel(step, index, active = false) {
  const title = String(step?.title || (step?.final ? "其他信息" : "")).trim();
  return `第 ${index + 1} 步${active && title ? `：${title}` : ""}`;
}

function currentAgeRatingAttributes() {
  const remote = normalizeAgeRatingAttributes(currentAppStoreDetail?.appInfo?.ageRatingDeclaration?.attributes || {});
  const appStoreAgeRating = String(currentAppStoreDetail?.appInfo?.attributes?.appStoreAgeRating || "");
  const baseRating = calculateBaseAgeRating(remote);
  if (!ageRatingOverrideValue(remote) && /PLUS$/.test(appStoreAgeRating) && appStoreAgeRating !== baseRating) {
    remote.ageRatingOverride = appStoreAgeRating;
    remote.ageRatingOverrideV2 = appStoreAgeRating;
  }
  const hidden = document.querySelector('[data-app-field="appInfo.ageRatingAttributes"]');
  if (hidden?.value) {
    try { return normalizeAgeRatingAttributes({ ...remote, ...(JSON.parse(hidden.value) || {}) }); } catch {}
  }
  return remote;
}

function normalizeAgeRatingAttributes(attributes = {}) {
  const normalized = { ...(attributes || {}) };
  if (!normalized.ageRatingOverrideV2 && normalized.ageRatingOverride) normalized.ageRatingOverrideV2 = normalized.ageRatingOverride;
  if (!normalized.ageRatingOverride && normalized.ageRatingOverrideV2) normalized.ageRatingOverride = normalized.ageRatingOverrideV2;
  return normalized;
}

function ageRatingOverrideValue(attributes = {}) {
  return String(attributes.ageRatingOverrideV2 || attributes.ageRatingOverride || "");
}

function collectAgeRatingAttributes(mask, options = {}) {
  const includeDefaults = !!options.includeDefaults;
  const attributes = {};
  mask.querySelectorAll("[data-age-attr]:checked").forEach(input => {
    const key = input.dataset.ageAttr;
    if (!key) return;
    let value = input.dataset.ageValue;
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value === "null") value = null;
    attributes[key] = value;
  });
  mask.querySelectorAll("select[data-age-attr]").forEach(select => {
    if (select.closest("[hidden]")) return;
    const key = select.dataset.ageAttr;
    if (!key) return;
    let value = select.value;
    if (value === "null") value = null;
    attributes[key] = value || null;
  });
  const urlInput = mask.querySelector("[data-age-info-url]");
  if (urlInput) {
    const url = String(urlInput.value || "").trim();
    attributes.developerAgeRatingInfoUrl = url || null;
  }
  if (includeDefaults) {
    for (const step of appAgeRatingSteps()) {
      for (const row of step.rows || []) {
        const key = row[3];
        if (!key || Object.prototype.hasOwnProperty.call(attributes, key)) continue;
        const defaults = row[4] || [];
        if (defaults.length) attributes[key] = coerceAgeRatingValue(defaults[0]);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(attributes, "parentalControls")) attributes.parentalControls = false;
    if (!Object.prototype.hasOwnProperty.call(attributes, "ageAssurance")) attributes.ageAssurance = false;
  }
  if (mask.querySelector('input[name="age-audience"]')) {
    if (includeDefaults && !Object.prototype.hasOwnProperty.call(attributes, "kidsAgeBand")) attributes.kidsAgeBand = null;
    if (includeDefaults && !Object.prototype.hasOwnProperty.call(attributes, "ageRatingOverrideV2")) attributes.ageRatingOverrideV2 = "NONE";
    if (includeDefaults && !Object.prototype.hasOwnProperty.call(attributes, "koreaAgeRatingOverride")) attributes.koreaAgeRatingOverride = "NONE";
    if (includeDefaults && !Object.prototype.hasOwnProperty.call(attributes, "gracRatingClassificationNumber")) attributes.gracRatingClassificationNumber = null;
  }
  return attributes;
}

function coerceAgeRatingValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

function appAgeRatingSteps() {
  const remoteDeclaration = currentAppStoreDetail?.appInfo?.ageRatingDeclaration || {};
  const remoteSteps = remoteDeclaration.steps || remoteDeclaration.attributes?.steps || remoteDeclaration.attributes?.questions;
  if (Array.isArray(remoteSteps) && remoteSteps.length) {
    return remoteSteps.map(step => ({
      title: String(step.title || ""),
      intro: String(step.intro || step.description || ""),
      final: !!step.final,
      rows: (Array.isArray(step.rows) ? step.rows : []).map(row => [
        String(row.title || row.name || ""),
        String(row.help || row.description || ""),
        (Array.isArray(row.options) ? row.options : []).map(option => String(option.label || option.name || option.value || "")).filter(Boolean),
      ]).filter(row => row[0] && row[2].length),
    }));
  }
  const steps = [
    { title: "功能", intro: "选择 App 是否有可用于限制 App 中的内容和功能的特定 App 内控件。", boolean: true, rows: [
      ["家长控制", "允许家长/监护人监控、管理或限制儿童访问可能不适合的 App 内内容或功能的设置或工具。", ["否", "是"], "parentalControls", ["false", "true"], "App 内控件"],
      ["年龄保证", "确认个人年龄满足访问特定内容或服务的年龄要求的机制。", ["否", "是"], "ageAssurance", ["false", "true"], "App 内控件"],
      ["不受限的网页访问", "用户可以前往 App 中的任何网页或自由浏览网页。", ["否", "是"], "unrestrictedWebAccess", ["false", "true"], "功能"],
      ["用户生成内容", "包括广泛分发用户创建的内容，作为 App 预期用户体验的组成部分。", ["否", "是"], "userGeneratedContent", ["false", "true"], "功能"],
      ["社交媒体", "通过社交动态或类似探索方式，对用户生成内容进行再分发、推广或互动，将内容广泛传播给众多用户。", ["否", "是"], "socialMedia", ["false", "true"], "功能"],
      ["禁止未满 13 周岁的用户使用社交媒体", "未满 13 周岁的用户无法访问社交媒体功能。在启用社交媒体功能前，至少会调用 Declared Age Range API 以检查用户的年龄范围。仅提供适龄的用户生成内容。", ["否", "是"], "socialMediaAgeRestricted", ["false", "true"], "功能"],
      ["信息和聊天", "用户可以通过 App 内的功能直接相互沟通。", ["否", "是"], "messagingAndChat", ["false", "true"], "功能"],
      ["广告", "App 内产品或服务的付费推广。", ["否", "是"], "advertising", ["false", "true"], "功能"],
    ] },
    { title: "成人主题", rows: [
      ["低俗笑话", "亵渎或低俗幽默：可能被认为是粗鲁、淫秽或不恰当的冒犯性或低俗语言。", ["无", "偶尔", "频繁"], "profanityOrCrudeHumor", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["恐怖/惊悚题材", "唤起焦虑、恐惧或恐怖感的内容或故事情节。", ["无", "偶尔", "频繁"], "horrorOrFearThemes", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["使用或提及烟、酒或毒品", "提及或描述使用酒精、烟草制品或其他合法或非法物质。", ["无", "偶尔", "频繁"], "alcoholTobaccoOrDrugUseOrReferences", ["NONE", "INFREQUENT", "FREQUENT"]],
    ] },
    { title: "医疗或保健", rows: [
      ["医疗或治疗信息", "提供有关医疗状况或健康和保健管理的诊断或指导内容。", ["无", "偶尔", "频繁"], "medicalOrTreatmentInformation", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["健康或保健主题", "提供自我护理或生活方式建议的内容。", ["否", "是"], "healthOrWellnessTopics", ["false", "true"], "选择 App 是否包含以下内容："],
    ] },
    { title: "性或裸体", intro: "根据以下定义，选择每种类型的内容在 App 中出现的频率。若提供 App 内控件，请考虑开启这些控件的用户在使用 App 时会遇到的内容。", rows: [
      ["成人或暗示性的主题", "暗示或间接提及性或成人主题但无需露骨内容，或由于复杂、激烈或敏感的性质，可能涉及现实世界的问题或不适合儿童的内容，因而适合年龄更大用户的主题。", ["无", "偶尔", "频繁"], "matureOrSuggestiveThemes", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["色情内容或裸体", "性行为的非露骨描述，包括短暂或部分裸露。", ["无", "偶尔", "频繁"], "sexualContentOrNudity", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["露骨色情内容及裸体", "对性行为或裸体露骨、详细的描述。", ["无", "偶尔", "频繁"], "sexualContentGraphicAndNudity", ["NONE", "INFREQUENT", "FREQUENT"]],
    ] },
    { title: "暴力", intro: "选择 App 中暴力相关内容出现频率。", rows: [
      ["卡通或幻想暴力", "可与现实生活轻松区分开来的夸张或幻想性质的身体冲突或伤害。", ["无", "偶尔", "频繁"], "violenceCartoonOrFantasy", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["现实暴力", "逼真情景下涉及人类的激烈身体冲突或伤害。", ["无", "偶尔", "频繁"], "violenceRealistic", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["大量露骨或残暴的现实暴力", "长时间、详细或逼真的身体冲突描绘。", ["无", "偶尔", "频繁"], "violenceRealisticProlongedGraphicOrSadistic", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["枪支或其他武器", "提及或描绘可能造成身体伤害的枪支、武器或物体。", ["无", "偶尔", "频繁"], "gunsOrOtherWeapons", ["NONE", "INFREQUENT", "FREQUENT"]],
    ] },
    { title: "基于概率的活动", intro: "选择 App 中基于概率的活动出现频率。", rows: [
      ["模拟赌博", "不使用真钱或可兑换真钱的游戏内货币进行投注或下注。", ["无", "偶尔", "频繁"], "gamblingSimulated", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["竞赛", "可让用户相互竞争以获得排名、奖励或实现个人目标的活动。", ["无", "偶尔", "频繁"], "contests", ["NONE", "INFREQUENT", "FREQUENT"]],
      ["赌博", "使用真钱或可兑换真钱的游戏内货币进行投注或下注。", ["否", "是"], "gambling", ["false", "true"], "选择 App 是否包含以下内容："],
      ["抽奖箱", "可购买的虚拟容器，为玩家提供随机虚拟物品。", ["否", "是"], "lootBox", ["false", "true"], "选择 App 是否包含以下内容："],
    ] },
    { title: "其他信息", final: true },
  ];
  return localizeAgeRatingSteps(steps);
}

function localizeAgeRatingSteps(steps) {
  const categoryKeys = {
    "功能": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.Capabilities.Label",
    "成人主题": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.MatureThemes.Label",
    "性或裸体": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.SexualOrNudity.Label",
    "医疗或保健": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.MedicalOrWellness.Label",
    "暴力": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.Violence.Label",
    "基于概率的活动": "ITC.apps.AppInfo.AgeRatings.DescriptorCategory.GamblingAndContests.Label",
  };
  return steps.map(step => ({
    ...step,
    title: appStoreL10n(categoryKeys[step.title], step.title),
    rows: (step.rows || []).map(row => {
      const key = row[3];
      if (!key) return row;
      return [
        appStoreL10n(`ITC.apps.AppInfo.AgeRatingsWizard.Descriptor.${key}.Label`, row[0]),
        appStoreL10n(`ITC.apps.AppInfo.AgeRatingsWizard.Descriptor.${key}.Description`, row[1]),
        row[2],
        row[3],
        row[4],
        row[5],
      ];
    }),
  }));
}

function renderAgeRatingStep(step, stepIndex) {
  const currentAttributes = activeAgeRatingDraftAttributes || currentAgeRatingAttributes();
  if (step.final) {
    const calculatedRating = calculateBaseAgeRating(currentAttributes);
    const overrideOptions = ageRatingOverrideOptions(calculatedRating);
    const overrideValue = validAgeRatingOverrideValue(ageRatingOverrideValue(currentAttributes), calculatedRating);
    const allowKidsAudience = ageRatingRank(calculatedRating) <= ageRatingRank("FOUR_PLUS");
    const checkedAudience = allowKidsAudience && currentAttributes.kidsAgeBand
      ? "kids"
      : (/PLUS$/.test(overrideValue) && overrideValue !== "NONE" ? "override" : "none");
    const kidsOptions = [["", "选取"], ["FIVE_AND_UNDER", "5 岁及以下"], ["SIX_TO_EIGHT", "6 - 8 岁"], ["NINE_TO_ELEVEN", "9 - 11 岁"]];
    const select = (key, options) => {
      const selectedValue = key === "ageRatingOverrideV2"
        ? overrideValue
        : String(currentAttributes[key] || "");
      return `<select class="app-age-final-select" data-age-attr="${escapeHTML(key)}">${options.map(([value, label]) => `<option value="${escapeHTML(value || "null")}" ${selectedValue === String(value || "") ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}</select>`;
    };
    const notice = renderAgeRatingFinalNotice(currentAttributes, calculatedRating);
    if (/app-age-notice error blocking/.test(notice)) {
      return `<div class="app-age-final app-age-final-blocked">${notice}</div>`;
    }
    return `<div class="app-age-final">
      ${notice}
      <h3>计算分级</h3>
      <p>根据回复，你的年龄分级计算如下。你仍然可以调整 App 的类别或提高其分级。</p>
      <span class="app-age-rating-badge">${escapeHTML(appAgeRatingText(calculatedRating))}</span>
      <h3>年龄类别和覆盖</h3>
      <p>如果你的 App 面向特定年龄段的用户，或者具有包含年龄要求的最终用户许可协议 (EULA)，你可以指定更符合 App 的年龄分级。系统将根据各个国家或地区的年龄适宜标准，计算相应的分级。App Store 上只会显示覆盖的年龄分级。</p>
      <label><input type="radio" name="age-audience" value="none" data-age-attr="kidsAgeBand" data-age-value="null" ${checkedAudience === "none" ? "checked" : ""}> 不适用</label>
      ${allowKidsAudience ? `<label><input type="radio" name="age-audience" value="kids" ${checkedAudience === "kids" ? "checked" : ""}> 面向儿童</label>
      <div class="app-age-child-panel" ${checkedAudience === "kids" ? "" : "hidden"}>
        <p>“儿童”类别是查找专为儿童设计的 App 的好方法。一旦你的“儿童专用”App 通过 App 审核，所有后续更新都需要遵循“儿童”类别指南。“儿童专用”App 无法在 visionOS 上提供。</p>
        ${select("kidsAgeBand", kidsOptions)}
      </div>` : ""}
      <label><input type="radio" name="age-audience" value="override" ${checkedAudience === "override" ? "checked" : ""}> 覆盖至更高的年龄分级</label>
      <div class="app-age-override-panel" ${checkedAudience === "override" ? "" : "hidden"}>${select("ageRatingOverrideV2", overrideOptions)}</div>
      <hr>
      <div class="field"><label>适龄 URL（可选）</label><p>如果想要提供 App 有关的其他适龄信息，请在下方附上 URL。</p><input data-age-info-url value="${escapeHTML(currentAttributes.developerAgeRatingInfoUrl || "")}"></div>
    </div>`;
  }
  const intro = stepIndex === 0
    ? "确认个人年龄满足访问特定内容或服务的年龄要求的机制。"
    : "根据以下定义，选择每种类型的内容在 App 中出现的频率。若提供 App 内控件，请考虑开启这些控件的用户在使用 App 时会遇到的内容。";
  const groups = [];
  (step.rows || []).forEach(row => {
    const marker = row[5] || "";
    if (!groups.length || (marker && groups[groups.length - 1].marker !== marker)) groups.push({ marker, rows: [] });
    groups[groups.length - 1].rows.push(row);
  });
  const stepIcon = appAgeStepIcon(step.title);
  return `<p>${escapeHTML(step.intro || intro)}</p>${stepIndex ? '<ul class="app-age-frequency-help"><li>偶尔：用户很少会在 App 中遇到此内容。</li><li>频繁：用户经常会在 App 中遇到此内容。</li></ul>' : ""}<div class="app-age-table">${groups.map(group => {
    const headerStyle = `style="--age-options:${Math.max((group.rows[0]?.[2] || []).length, 1)}"`;
    return `${group.marker ? `<div class="app-age-subhead" ${headerStyle}><strong><span>${appAgeStepIcon(group.marker)}</span>${escapeHTML(group.marker)}</strong>${renderAgeRatingOptionHeaders(group.rows[0])}</div>` : `<div class="app-age-category-head" ${headerStyle}><strong><span>${stepIcon}</span>${escapeHTML(step.title)}</strong>${renderAgeRatingOptionHeaders(group.rows[0])}</div>`}${group.rows.map(row => {
    const options = row[2] || [];
    const key = row[3] || "";
    const currentValue = Object.prototype.hasOwnProperty.call(currentAttributes, key) ? currentAttributes[key] : coerceAgeRatingValue((row[4] || [])[0]);
    return `<div class="app-age-question" style="--age-options:${Math.max(options.length, 1)}"><div><strong>${escapeHTML(row[0])} ${appStoreHelp(row[1])}</strong><p>${escapeHTML(row[1])}</p></div>${options.map((option, optionIndex) => {
      const value = (row[4] || [])[optionIndex] ?? option;
      const checked = key && String(currentValue) === String(coerceAgeRatingValue(value));
      return `<label><input type="radio" name="age-${stepIndex}-${escapeHTML(key)}" value="${escapeHTML(option)}" data-age-attr="${escapeHTML(key)}" data-age-value="${escapeHTML(value)}" ${checked ? "checked" : ""}><span>${escapeHTML(option)}</span></label>`;
    }).join("")}</div>`;
  }).join("")}`;
  }).join("")}</div>`;
}

function ageRatingRank(value = "") {
  const ranks = { FOUR_PLUS: 4, NINE_PLUS: 9, TWELVE_PLUS: 12, THIRTEEN_PLUS: 13, FIFTEEN_PLUS: 15, SIXTEEN_PLUS: 16, SEVENTEEN_PLUS: 17, EIGHTEEN_PLUS: 18 };
  return ranks[String(value || "")] || 0;
}

function ageRatingOverrideOptions(calculatedRating = "") {
  const baseRank = ageRatingRank(calculatedRating);
  return [["", "选取"], ["NINE_PLUS", "9 岁以上"], ["THIRTEEN_PLUS", "13 岁以上"], ["SIXTEEN_PLUS", "16 岁以上"], ["EIGHTEEN_PLUS", "18 岁以上"]]
    .filter(([value]) => !value || ageRatingRank(value) > baseRank);
}

function validAgeRatingOverrideValue(value = "", calculatedRating = "") {
  const optionValues = new Set(ageRatingOverrideOptions(calculatedRating).map(([optionValue]) => optionValue).filter(Boolean));
  return optionValues.has(String(value || "")) ? String(value || "") : "";
}

function calculateBaseAgeRating(attributes = {}) {
  const value = key => attributes[key];
  const any = keys => keys.some(key => {
    const raw = value(key);
    return raw === true || raw === "true" || (raw && raw !== "NONE" && raw !== "null");
  });
  const frequent = keys => keys.some(key => value(key) === "FREQUENT");
  if (value("sexualContentGraphicAndNudity") && value("sexualContentGraphicAndNudity") !== "NONE") return "EIGHTEEN_PLUS";
  if (value("gambling") === true || value("gambling") === "true") return "EIGHTEEN_PLUS";
  if (frequent(["violenceRealisticProlongedGraphicOrSadistic"])) return "EIGHTEEN_PLUS";
  if (frequent(["sexualContentOrNudity", "matureOrSuggestiveThemes", "alcoholTobaccoOrDrugUseOrReferences", "gunsOrOtherWeapons", "violenceRealistic"])) return "SEVENTEEN_PLUS";
  if (any(["unrestrictedWebAccess", "gamblingSimulated", "contests", "medicalOrTreatmentInformation", "horrorOrFearThemes", "alcoholTobaccoOrDrugUseOrReferences", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic", "gunsOrOtherWeapons", "sexualContentOrNudity", "matureOrSuggestiveThemes"])) return "THIRTEEN_PLUS";
  if (any(["userGeneratedContent", "socialMedia", "messagingAndChat", "advertising", "healthOrWellnessTopics", "lootBox", "violenceCartoonOrFantasy", "profanityOrCrudeHumor"])) return "NINE_PLUS";
  return "FOUR_PLUS";
}

function renderAgeRatingFinalNotice(attributes = {}, calculatedRating = "") {
  const value = key => attributes[key];
  const notNone = key => {
    const raw = value(key);
    return raw === true || raw === "true" || (raw && raw !== "NONE" && raw !== "null");
  };
  const graphicSexualContent = notNone("sexualContentGraphicAndNudity");
  if (graphicSexualContent) {
    return `<div class="app-age-notice error blocking"><strong>根据你的选择，你无法在 App Store 提供此 App。</strong><p>App Store 中的 App 不得包含任何类型（文本、图形、图像和照片等）的淫秽、色情、冒犯性或诽谤性内容或材料。</p></div>`;
  }
  const regionalRisk = calculatedRating === "EIGHTEEN_PLUS"
    || notNone("gambling")
    || value("violenceRealisticProlongedGraphicOrSadistic") === "FREQUENT"
    || value("gunsOrOtherWeapons") === "FREQUENT"
    || value("sexualContentOrNudity") === "FREQUENT";
  if (!regionalRisk) return "";
  return `<div class="app-age-notice warning"><strong>鉴于当地法律的规定，此 App 将不在以下国家或地区销售：</strong><ul><li>阿富汗、阿拉伯联合酋长国、利比亚、马尔代夫、摩洛哥、沙特阿拉伯、伊拉克（如果主要类别或次要类别是“娱乐”、“生活方式”或“游戏”）</li><li>巴西（如果主要类别或次要类别是“游戏”）</li></ul></div>`;
}

function renderAgeRatingOptionHeaders(row = []) {
  const options = row[2] || [];
  return options.map(option => `<span>${escapeHTML(option)}</span>`).join("");
}

function appAgeStepIcon(title = "") {
  if (/内控件|控制|保证/.test(title)) return "◉";
  if (/医疗|保健/.test(title)) return "♧";
  if (/暴力/.test(title)) return "◈";
  if (/概率|赌博|竞赛/.test(title)) return "▣";
  if (/性|裸体/.test(title)) return "▱";
  if (/成人/.test(title)) return "♙";
  return "◉";
}

function appInfoLicenseModal() {
  return `<div class="app-info-modal-mask"><div class="app-info-modal app-license-modal">
    <h2>App Store 法规和许可</h2>
    <p>请确认与你的 App 相关的法规、许可和地区合规信息。任何更改可能会影响 App 在相关地区的提供状态。</p>
    <div class="app-license-list"><label><input type="checkbox"> 数字服务法交易商状态</label><label><input type="checkbox"> Apple 标准许可协议</label><label><input type="checkbox"> 越南游戏许可</label><label><input type="checkbox"> 受监管医疗设备声明</label></div>
    <div class="app-info-modal-actions"><button class="secondary" data-app-modal-close type="button">取消</button><button class="primary" data-app-modal-close type="button">完成</button></div>
  </div></div>`;
}

function appInfoIcpModal() {
  const current = appStoreFieldValue("appInfo.icpNumber");
  return `<div class="app-info-modal-mask"><div class="app-info-modal app-icp-modal">
    <div class="app-icp-step" data-app-icp-entry>
      <h2>设置 ICP 备案号</h2>
      <p>ICP 备案号是中华人民共和国工业和信息化部（MIIT）核发的 App 注册号。如果你有 ICP 备案号，请在此处提供。<a href="https://beian.miit.gov.cn/" data-system-external rel="noreferrer">了解更多</a></p>
      <div class="field"><label for="app-icp-number-input">ICP 备案号</label><input id="app-icp-number-input" data-app-icp-input value="${escapeHTML(current)}" placeholder="请输入 ICP 备案号"></div>
      <div class="error app-icp-error" role="alert"></div>
      <div class="app-info-modal-actions"><button class="secondary" data-app-modal-close type="button">取消</button><button class="primary" data-app-icp-done type="button">保存</button></div>
    </div>
    <div class="app-icp-step" data-app-icp-confirmation hidden>
      <h2>确认 ICP 备案号信息</h2>
      <p data-app-icp-consent-copy></p>
      <p data-app-icp-consent-statement></p>
      <strong class="app-icp-consent-number" data-app-icp-consent-number></strong>
      <div class="error app-icp-confirm-error" role="alert"></div>
      <div class="app-info-modal-actions"><button class="secondary" data-app-icp-back type="button">返回修改</button><button class="secondary" data-app-modal-close type="button">取消</button><button class="primary" data-app-icp-confirm type="button">确认并保存</button></div>
    </div>
  </div></div>`;
}

function renderIcpReadableError(error) {
  const raw = typeof error === "object" ? `${error.message || ""} ${error.detail || ""}` : String(error || "");
  if (/developer.{0,30}name.{0,60}(?:not match|mismatch)|(?:开发者|开发人员).{0,12}(?:姓名|名称).{0,40}(?:不匹配|不一致)/i.test(raw)) {
    return `${escapeHTML("开发者名称与工信部备案记录仍不一致，请核对备案号及开发者归属后重试。")} <a href="https://beian.miit.gov.cn/" data-system-external rel="noreferrer">去查询备案号</a>`;
  }
  const text = appStoreReadableError(error);
  const message = /ICP|备案/i.test(text)
    ? "备案号错误。请前往中国工业和信息化部政务服务平台查询确认后再保存。"
    : text;
  return `${escapeHTML(message)} <a href="https://beian.miit.gov.cn/" data-system-external rel="noreferrer">去查询备案号</a>`;
}

let activeAppStoreLocaleId = "";

function activeAppStoreLocalization(detail = currentAppStoreDetail) {
  const rows = Array.isArray(detail?.localizations) ? detail.localizations : [];
  return rows.find(item => item.id === activeAppStoreLocaleId) || rows[0] || {};
}

function renderAppStoreLocaleSelector(detail, app) {
  const rows = Array.isArray(detail?.localizations) ? detail.localizations : [];
  const active = activeAppStoreLocalization(detail);
  if (rows.length < 2) return `<span class="app-locale-single">${escapeHTML(appStoreLocaleName(active.locale || app.primaryLocale || "zh-Hans"))}</span>`;
  return `<select class="app-locale-select" aria-label="选择本地化语言">${rows.map(item => `<option value="${escapeHTML(item.id)}" ${item.id === active.id ? "selected" : ""}>${escapeHTML(appStoreLocaleName(item.locale))}${item.locale === app.primaryLocale ? "（主要）" : ""}</option>`).join("")}</select>`;
}

function appStoreReviewSubmittedTime(row = {}) {
  return row.submittedDate || row.createdDate || row.lastUpdatedDate || "";
}

function appStoreReviewCreatedTime(row = {}) {
  return row.createdDate || row.lastUpdatedDate || row.submittedDate || "";
}

function appStoreReviewIsDraft(row = {}) {
  return /^READY_FOR_REVIEW$/i.test(String(row.state || ""));
}

function appStoreReviewRows(detail = currentAppStoreDetail) {
  return (Array.isArray(detail?.reviewSubmissions) ? detail.reviewSubmissions : []).filter(item => item?.id);
}

function appStoreReviewDraftSubmissions(detail = currentAppStoreDetail) {
  return appStoreReviewRows(detail).filter(appStoreReviewIsDraft);
}

function appStoreReviewSubmittedSubmissions(detail = currentAppStoreDetail) {
  return appStoreReviewRows(detail).filter(row => !appStoreReviewIsDraft(row));
}

function appStoreReviewSubmissionAllowsDetail(row = {}) {
  const state = String(row.state || "").toUpperCase();
  return /^(WAITING_FOR_REVIEW|SUBMITTED|IN_REVIEW|CANCELING|COMPLETING|COMPLETE|COMPLETED|APPROVED|PENDING_DEVELOPER_RELEASE|REJECTED|DEVELOPER_REJECTED|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES|INVALID_BINARY)$/.test(state);
}

function findAppStoreReviewSubmission(submissionId) {
  const id = String(submissionId || "");
  return (currentAppStoreDetail?.reviewSubmissions || []).find(item => String(item.id || "") === id) || null;
}

function appStoreReviewVersionLabel(row = {}) {
  const platform = appStorePlatformText(row.platform || row.version?.platform || "IOS");
  const version = row.version?.versionString || row.versionString || "-";
  return `${platform} ${version}`;
}

function appStoreReviewItemCountLabel(row = {}) {
  return `${Number(row.itemCount || row.items?.length || 0) || 1} 个项目`;
}

function appStoreReviewActorLabel(row = {}) {
  return row.submitter || row.submittedBy || row.lastUpdatedBy || "—";
}

function appStoreReviewDateLabel(value = "") {
  const text = String(value || "").trim();
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(/\s+/g, "");
  if (sameDay) return `今天${time}`;
  const day = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date).replace(/\s+/g, "");
  return `${day}${time}`;
}

function appStoreReviewFullDateLabel(value = "") {
  const text = String(value || "").trim();
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date).replace(/\s+/g, "");
}

function appStoreReviewItemName(item = {}, app = currentAppStoreApp || {}) {
  if (item.version?.versionString) return `${appStorePlatformText(item.version.platform || "IOS")} App ${item.version.versionString}`;
  const purchase = appStoreReviewSubmissionPurchase(item);
  if (purchase?.name) return purchase.name;
  if (item.productId) return item.name ? `${item.name}` : item.productId;
  return item.name || app.name || "提交项目";
}

function appStoreReviewSubmissionPurchase(item = {}, detail = currentAppStoreDetail) {
  const purchases = Array.isArray(detail?.inAppPurchases) ? detail.inAppPurchases : [];
  const versionId = String(item.relatedId || item.versionId || "");
  if (!versionId) return null;
  return purchases.find(purchase => String(purchase.versionId || "") === versionId || String(purchase.id || "") === versionId) || null;
}

function appStoreReviewSubmissionPurchaseVersionId(item = {}, detail = currentAppStoreDetail) {
  return String(item.relatedId || item.versionId || appStoreReviewSubmissionPurchase(item, detail)?.versionId || "");
}

function appStoreReviewSubmissionItemState(item = {}, row = {}) {
  return item.relatedState || item.versionState || item.state || row.state || "";
}

function appStoreReviewSubmissionItemType(item = {}, row = {}, detail = currentAppStoreDetail) {
  const purchase = appStoreReviewSubmissionPurchase(item, detail);
  if (item.version?.versionString || /appStoreVersion/i.test(`${item.type || ""} ${item.itemType || ""}`)) return "App 版本";
  if (purchase || item.productId || item.purchaseId || item.versionId || /inAppPurchase/i.test(`${item.type || ""} ${item.itemType || ""}`)) return "App 内购买项目";
  return "项目";
}

function appStoreReviewMessageAuthor(message = {}) {
  const author = String(message.author || message.sender || "").trim();
  if (author) return author;
  return /developer|user/i.test(String(message.state || "")) ? (currentAppStoreApp?.sellerName || "开发者") : "Apple";
}

function appStoreReviewPlainText(value = "") {
  return String(value || "")
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gis, "\n\n$1\n\n")
    .replace(/<(?:b|strong)\b[^>]*>(.*?)<\/(?:b|strong)>/gis, "$1")
    .replace(/<a[^>]*>(.*?)<\/a>/gis, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function appStoreReviewMessageHTML(message = {}, item = {}) {
  const blocks = [
    appStoreReviewPlainText(message.body || message.content || message.text || ""),
    message.issueDescription ? `Issue Description\n\n${appStoreReviewPlainText(message.issueDescription)}` : "",
    message.nextSteps ? `Next Steps\n\n${appStoreReviewPlainText(message.nextSteps)}` : "",
  ].filter(Boolean);
  const headingPattern = /^(?:Review Environment|Issue Description|Next Steps|Resources|Support|Test on the latest betas|Prevent Common Issues|防止常见问题|避免常见问题)\s*[:：]?$|^Guideline\s+\d+(?:\.\d+)+\s*[-–—:]\s*.+$/i;
  // Recognize standalone headings without turning the following prose into a heading.
  const body = blocks.join("\n\n").split("\n")
    .flatMap(line => headingPattern.test(line.trim()) ? ["", line.trim(), ""] : [line])
    .join("\n");
  let commonIssues = false;
  let skipIssueHeading = false;
  const sections = body.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const paragraphs = body
    ? sections.map((text, index) => {
      if (skipIssueHeading) {
        skipIssueHeading = false;
        return "";
      }
      if (/^(Prevent Common Issues|防止常见问题|避免常见问题)/i.test(text)) commonIssues = true;
      if (commonIssues && /^Guideline\b/i.test(text)) return `<p><strong>${escapeHTML(text)}</strong></p>`;
      // Apple's messageBody uses an h3 followed by a bold Issue Description.
      // Keep that adjacent pair together; allow it to wrap only when needed.
      if (!commonIssues && /^Guideline\s+\d+(?:\.\d+)+\s*[-–—:]\s*.+$/i.test(text)
        && /^Issue Description\s*[:：]?$/i.test(sections[index + 1] || "")) {
        skipIssueHeading = true;
        return `<h4 class="app-review-issue-heading"><span>${escapeHTML(text)}</span><span>${escapeHTML(sections[index + 1])}</span></h4>`;
      }
      if (headingPattern.test(text) && !/^(Prevent Common Issues|防止常见问题|避免常见问题)/i.test(text)) {
        return `<h4>${escapeHTML(text)}</h4>`;
      }
      // Single newlines in prose often come from Apple's fixed-width message.
      // Let the browser wrap prose; keep separate list entries and review fields.
      const lines = [];
      text.split("\n").map(line => line.trim()).filter(Boolean).forEach(line => {
        const separateLine = /^(?:[-*•]\s+|\d+[.)]\s+|(?:Submission ID|Review date|Review Device|Version reviewed)\s*[:：])/i.test(line);
        if (separateLine || !lines.length) lines.push(line);
        else lines[lines.length - 1] += ` ${line}`;
      });
      return `<p>${lines.map(escapeHTML).join("<br>")}</p>`;
    }).join("")
    : '<p class="app-review-message-empty">暂无消息正文。</p>';
  const reason = message.guideline || message.rejectionReason || "";
  const footer = reason || item.version?.versionString ? `<footer class="app-review-message-footer"><strong>${escapeHTML(appStoreReviewItemName(item, currentAppStoreApp || {}))}</strong><span>${escapeHTML(item.version ? "App 版本" : "项目")}</span>${reason ? `<p><b>拒绝原因：</b>${escapeHTML(reason)}</p>` : ""}</footer>` : "";
  return footer ? `<div class="app-review-message-body">${paragraphs}</div>${footer}` : paragraphs;
}

function renderAppStoreReviewMessages(messages = [], items = [], draft = null) {
  const hasDraft = !!draft?.id;
  if (!messages.length && !hasDraft) return "";
  const item = items.find(row => row.version?.versionString) || items[0] || {};
  const draftAttachments = Array.isArray(draft?.attachments) ? draft.attachments : [];
  const draftHTML = hasDraft ? `<details class="app-review-message app-review-draft-message" open>
    <summary><span class="app-review-message-chevron"></span><strong>${escapeHTML(draft.author || "—")}</strong><time>${escapeHTML(appStoreReviewDateLabel(draft.lastUpdatedDate || draft.createdDate || ""))}</time>${draftAttachments.length ? '<span class="app-review-draft-paperclip" aria-label="包含附件"></span>' : ""}</summary>
    <div class="app-review-draft-message-body"><p>${escapeHTML(String(draft.messageBody || "").trim()).replace(/\n/g, "<br>")}</p>
      ${draftAttachments.length ? `<div class="app-review-draft-attachments"><strong>消息附件：</strong>${draftAttachments.map(attachment => attachment.downloadUrl
        ? `<a href="${escapeHTML(attachment.downloadUrl)}" data-system-external><span>${escapeHTML(attachment.fileName || "附件")}</span><b>下载</b></a>`
        : `<span class="app-review-draft-attachment-name">${escapeHTML(attachment.fileName || "附件")}</span>`).join("")}</div>` : ""}
      <div class="app-review-draft-actions"><button type="button" data-review-draft-edit>继续编辑草稿</button><button type="button" data-review-draft-delete>删除草稿</button></div>
    </div>
  </details>` : "";
  return `<div class="app-review-detail-messages"><h3>消息 (${messages.length + (hasDraft ? 1 : 0)})</h3>
    <div class="app-review-message-list">${messages.map((message, index) => {
      const author = appStoreReviewMessageAuthor(message);
      const date = appStoreReviewDateLabel(message.createdDate || message.lastUpdatedDate || "");
      return `<details class="app-review-message" ${index === messages.length - 1 && !hasDraft ? "open" : ""}>
        <summary><span class="app-review-message-chevron"></span><strong>${escapeHTML(author)}</strong><time>${escapeHTML(date)}</time>${message.attachments?.length ? '<span class="app-review-message-paperclip" aria-label="包含附件">📎</span>' : ""}</summary>
        ${appStoreReviewMessageHTML(message, item)}
      </details>`;
    }).join("")}${draftHTML}</div>
  </div>`;
}

function appStoreReviewSubmissionCanReply(row = {}) {
  const state = String(row.state || "").toUpperCase();
  const itemRejected = (Array.isArray(row.items) ? row.items : []).some(item => /REJECT|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/i.test(String(item.state || item.relatedState || "")));
  return !!String(row.threadId || "") && (itemRejected || /REJECT|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES/i.test(state) || (Array.isArray(row.reviewRejections) && row.reviewRejections.length > 0));
}

function openAppStoreReviewDraftDeleteModal() {
  const detail = currentReviewSubmissionDetail;
  const draftId = String(detail?.draftMessage?.id || "");
  if (!detail?.id || !draftId) return;
  document.getElementById("app-review-draft-delete-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "app-review-draft-delete-modal";
  modal.className = "app-review-draft-delete-modal";
  modal.innerHTML = `<section class="app-review-draft-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="app-review-draft-delete-title"><div><h2 id="app-review-draft-delete-title">是否删除此草稿?</h2><p>此草稿内的所有附件也将被删除。</p><span class="app-review-draft-delete-error" aria-live="polite"></span></div><footer><button class="secondary" data-close type="button">取消</button><button class="danger" data-delete type="button">删除</button></footer></section>`;
  appendAppStoreModal(modal);
  const close = () => modal.remove();
  modal.querySelector("[data-close]").onclick = close;
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelector("[data-delete]").onclick = async event => {
    const button = event.currentTarget;
    const errorNode = modal.querySelector(".app-review-draft-delete-error");
    setBusy(button, true, "删除中…");
    const result = await window.appleDeveloper.deleteAppStoreReviewDraftMessage({ draftId }).catch(error => ({ success: false, error: error.message }));
    if (!result?.success) {
      setBusy(button, false);
      errorNode.textContent = result?.error || "审核回复草稿删除失败";
      return;
    }
    const submissionId = detail.id;
    detail.draftMessage = null;
    close();
    switchAppStorePane(currentAppStoreApp, "review");
    const refreshed = await window.appleDeveloper.appStoreReviewSubmissionDetail({ appId: currentAppStoreApp?.id || "", submissionId }).catch(() => null);
    if (refreshed?.success && refreshed.detail) {
      currentReviewSubmissionDetail = refreshed.detail;
      mergeReviewSubmissionDetailIntoAppDetail(refreshed.detail);
      switchAppStorePane(currentAppStoreApp, "review");
    }
  };
}

function openAppStoreReviewReplyModal() {
  const detail = currentReviewSubmissionDetail;
  const threadId = String(detail?.threadId || "");
  if (!detail?.id || !threadId) return;
  document.getElementById("app-review-reply-modal")?.remove();
  const initialDraft = detail.draftMessage && typeof detail.draftMessage === "object" ? detail.draftMessage : {};
  const initialText = String(initialDraft.messageBody || "");
  const originalDetailDraft = detail.draftMessage || null;
  const modal = document.createElement("div");
  modal.id = "app-review-reply-modal";
  modal.className = "app-review-reply-modal";
  modal.innerHTML = `<section class="app-review-reply-dialog" role="dialog" aria-modal="true" aria-labelledby="app-review-reply-title">
    <div class="app-review-reply-body">
      <h2 id="app-review-reply-title">回复 App 审核</h2>
      <p>请使用下方字段：</p>
      <ul><li>请求阐明 App 被拒绝的原因。</li><li>提供 App 审核所要求的信息。</li><li>提供更多信息，帮助 App 审核更好地了解你的 App 或商业模式。如果你认为 App 应重新接受审核，可以向 <a href="https://developer.apple.com/contact/app-store/?topic=review" target="_blank" rel="noreferrer">App 审核委员会提交申诉</a>。</li></ul>
      <p>如果你的账户中有可用的 TSI，则可向“开发者技术支持 (DTS)”的工程师提交代码级<a href="https://developer.apple.com/support/technical/" target="_blank" rel="noreferrer">技术支持请求</a>。</p>
      <div class="app-review-reply-field"><label for="app-review-reply-textarea">回复</label><textarea id="app-review-reply-textarea" maxlength="4000" spellcheck="false">${escapeHTML(initialText)}</textarea><span class="app-review-reply-count">${4000 - initialText.length}</span><button class="app-review-reply-attach" type="button">附加文件</button><div class="app-review-reply-attachments" aria-live="polite"></div><div class="app-review-reply-error" aria-live="polite"></div></div>
    </div>
    <footer class="app-review-reply-footer"><button class="cancel" type="button">取消</button><button class="secondary save" type="button" disabled>保存草稿</button><button class="primary send" type="button" disabled>回复</button></footer>
  </section>`;
  document.body.appendChild(modal);
  const textarea = modal.querySelector("#app-review-reply-textarea");
  const count = modal.querySelector(".app-review-reply-count");
  const errorNode = modal.querySelector(".app-review-reply-error");
  const attachmentsNode = modal.querySelector(".app-review-reply-attachments");
  const attachButton = modal.querySelector(".app-review-reply-attach");
  const saveButton = modal.querySelector(".save");
  const sendButton = modal.querySelector(".send");
  let draft = { ...initialDraft };
  let savedText = initialText;
  let originalDraftId = String(initialDraft.id || "");
  let originalAttachmentIds = new Set((Array.isArray(initialDraft.attachments) ? initialDraft.attachments : []).map(item => String(item.id || "")).filter(Boolean));
  const uploadedAttachmentIds = new Set();
  const attachmentIdsToDelete = new Set();
  let createdDraftForAttachments = false;
  let busy = false;
  const setError = message => { errorNode.textContent = String(message || ""); };
  const attachmentChangesPending = () => uploadedAttachmentIds.size > 0 || attachmentIdsToDelete.size > 0;
  const unsavedChanges = () => String(textarea.value || "") !== savedText || attachmentChangesPending();
  const visibleAttachments = () => (Array.isArray(draft.attachments) ? draft.attachments : []).filter(item => item?.id && !attachmentIdsToDelete.has(String(item.id)));
  const renderAttachments = () => {
    const rows = visibleAttachments();
    attachmentsNode.innerHTML = rows.map(item => {
      const state = String(item.state || "").toUpperCase();
      const status = state && state !== "COMPLETE" ? `<span class="app-review-reply-attachment-state">${escapeHTML(/FAIL|ERROR|INVALID|REJECT/.test(state) ? "上传失败" : "处理中…")}</span>` : "";
      return `<div class="app-review-reply-attachment"><span class="app-review-reply-attachment-name" title="${escapeHTML(item.fileName || "附件")}">${escapeHTML(item.fileName || "附件")}</span>${item.fileSize ? `<span class="app-review-reply-attachment-size">${escapeHTML(appStoreReviewFileSizeText(item.fileSize))}</span>` : ""}${status}<button class="app-review-reply-attachment-remove" data-attachment-id="${escapeHTML(item.id)}" type="button" title="移除附件" aria-label="移除 ${escapeHTML(item.fileName || "附件")}">×</button></div>`;
    }).join("");
    attachmentsNode.querySelectorAll("[data-attachment-id]").forEach(button => button.addEventListener("click", () => {
      if (busy) return;
      attachmentIdsToDelete.add(String(button.dataset.attachmentId || ""));
      setError("");
      renderAttachments();
      refreshButtons();
    }));
  };
  const refreshButtons = () => {
    const value = String(textarea.value || "");
    count.textContent = String(Math.max(0, 4000 - value.length));
    saveButton.disabled = busy || !value.trim() || !unsavedChanges();
    sendButton.disabled = busy || !value.trim();
    attachButton.disabled = busy;
    modal.querySelectorAll(".app-review-reply-attachment-remove").forEach(button => { button.disabled = busy; });
  };
  const close = () => modal.remove();
  const cancel = async () => {
    if (busy) return;
    if (!uploadedAttachmentIds.size && !createdDraftForAttachments) { close(); return; }
    busy = true; setError(""); refreshButtons();
    const cleanup = createdDraftForAttachments && !originalDraftId
      ? window.appleDeveloper.deleteAppStoreReviewDraftMessage({ draftId: draft.id })
      : window.appleDeveloper.deleteAppStoreReviewMessageAttachments({ threadId, attachmentIds: [...uploadedAttachmentIds] });
    const result = await cleanup.catch(error => ({ success: false, error: error.message }));
    busy = false;
    if (!result?.success) { setError(result?.error || "附件清理失败"); refreshButtons(); return; }
    detail.draftMessage = originalDetailDraft;
    close();
  };
  modal.querySelector(".cancel").onclick = cancel;
  modal.addEventListener("click", event => { if (event.target === modal) cancel(); });
  textarea.addEventListener("input", refreshButtons);
  const saveDraft = async () => {
    const value = String(textarea.value || "");
    if (!value.trim() || busy) return null;
    busy = true; setError(""); refreshButtons();
    const result = await window.appleDeveloper.saveAppStoreReviewDraftMessage({ threadId, draftId: draft.id || "", messageBody: value, attachmentIdsToDelete: [...attachmentIdsToDelete] }).catch(error => ({ success: false, error: error.message }));
    busy = false;
    if (!result?.success) { setError(result?.error || "审核回复草稿保存失败"); refreshButtons(); return null; }
    draft = result.draft || { ...draft, id: draft.id || "", threadId, messageBody: value };
    draft.messageBody = String(draft.messageBody || value);
    savedText = value;
    originalDraftId = String(draft.id || originalDraftId);
    originalAttachmentIds = new Set((Array.isArray(draft.attachments) ? draft.attachments : []).map(item => String(item.id || "")).filter(Boolean));
    uploadedAttachmentIds.clear();
    attachmentIdsToDelete.clear();
    createdDraftForAttachments = false;
    detail.draftMessage = draft;
    renderAttachments();
    refreshButtons();
    return draft;
  };
  modal.querySelector(".save").onclick = async () => {
    const savedDraft = await saveDraft();
    if (!savedDraft) return;
    close();
    switchAppStorePane(currentAppStoreApp, "review");
  };
  modal.querySelector(".send").onclick = async () => {
    if (busy || !String(textarea.value || "").trim()) return;
    const value = String(textarea.value || "");
    const shouldSave = value !== savedText;
    busy = true; setError(""); refreshButtons();
    const result = await window.appleDeveloper.sendAppStoreReviewMessage({ threadId, draftId: draft.id || "", messageBody: value, saveDraft: shouldSave, attachmentIdsToDelete: [...attachmentIdsToDelete] }).catch(error => ({ success: false, error: error.message }));
    busy = false;
    if (!result?.success) { setError(result?.error || "回复 App 审核失败"); refreshButtons(); return; }
    close();
    await openAppStoreReviewSubmissionDetail(detail.id);
  };
  attachButton.onclick = async () => {
    if (busy) return;
    busy = true; setError(""); attachButton.textContent = "正在上传…"; refreshButtons();
    const result = await window.appleDeveloper.uploadAppStoreReviewMessageAttachments({ threadId, draftId: draft.id || "", messageBody: String(textarea.value || "") }).catch(error => ({ success: false, error: error.message }));
    busy = false; attachButton.textContent = "附加文件";
    if (!result?.success) { setError(result?.error || "审核回复附件上传失败"); refreshButtons(); return; }
    if (result.canceled) { refreshButtons(); return; }
    draft = result.draft || draft;
    createdDraftForAttachments = createdDraftForAttachments || !!result.createdDraft;
    (result.uploadedAttachmentIds || []).forEach(id => uploadedAttachmentIds.add(String(id)));
    detail.draftMessage = draft;
    renderAttachments();
    refreshButtons();
  };
  renderAttachments();
  refreshButtons();
  window.appleDeveloper.appStoreReviewDraftMessage({ threadId }).then(result => {
    if (!result?.success || !result.draft || textarea.value !== savedText || attachmentChangesPending() || busy) return;
    draft = result.draft;
    const latestText = String(result.draft.messageBody || "");
    textarea.value = latestText;
    savedText = latestText;
    originalDraftId = String(result.draft.id || "");
    originalAttachmentIds = new Set((Array.isArray(result.draft.attachments) ? result.draft.attachments : []).map(item => String(item.id || "")).filter(Boolean));
    detail.draftMessage = result.draft;
    renderAttachments();
    refreshButtons();
  }).catch(() => {});
  textarea.focus();
}

function appStoreReviewReasonText(reason = {}) {
  if (typeof reason === "string") return reason.trim();
  const code = String(reason.reasonCode || reason.reasonSection || reason.code || "").trim();
  const description = String(reason.reasonDescription || reason.description || reason.text || "").trim();
  return [code, description].filter(Boolean).join(" ").trim();
}

function appStoreReviewItemReasons(item = {}) {
  const source = Array.isArray(item.rejectionReasons) ? item.rejectionReasons : [];
  const values = (source.length ? source.map(appStoreReviewReasonText) : [item.rejectionReason, item.reasonText])
    .map(value => String(value || "").trim()).filter(Boolean);
  return [...new Set(values)];
}

function appStoreReviewFileSizeText(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function appStoreReviewItemAttachments(item = {}) {
  const source = Array.isArray(item.rejectionAttachments) ? item.rejectionAttachments : [];
  const seen = new Set();
  return source.map(attachment => ({
    fileName: String(attachment?.fileName || attachment?.name || attachment?.id || "附件"),
    fileSize: Number(attachment?.fileSize || attachment?.size || 0) || 0,
    downloadUrl: String(attachment?.downloadUrl || attachment?.url || attachment?.assetUrl || ""),
  })).filter(attachment => {
    const key = attachment.downloadUrl || attachment.fileName;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function appStoreReviewItemMetaHTML(item = {}) {
  const reasons = appStoreReviewItemReasons(item);
  const attachments = appStoreReviewItemAttachments(item);
  if (!reasons.length && !attachments.length) return "";
  const reasonHTML = reasons.map(reason => `<div class="app-review-item-reason"><b>拒绝原因：</b>${escapeHTML(reason)}</div>`).join("");
  const attachmentHTML = attachments.length ? `<div class="app-review-item-attachments"><b>附件：</b>${attachments.map(attachment => {
    const size = appStoreReviewFileSizeText(attachment.fileSize);
    const label = `${attachment.fileName}${size ? ` (${size})` : ""}`;
    return attachment.downloadUrl
      ? `<a class="app-review-attachment-link" href="${escapeHTML(attachment.downloadUrl)}" data-system-external>${escapeHTML(label)}<span>下载</span></a>`
      : `<span class="app-review-attachment-link no-download">${escapeHTML(label)}</span>`;
  }).join("")}</div>` : "";
  return `<details class="app-review-item-meta"><summary>审核详情${attachments.length ? ` · ${attachments.length} 个附件` : ""}</summary><div class="app-review-item-meta-content">${reasonHTML}${attachmentHTML}</div></details>`;
}

function renderAppStoreReviewSubmissionDetail(detail, app) {
  if (currentReviewSubmissionLoadingId) return `<section class="app-review-detail-page"><button class="app-link-button" id="app-review-detail-back" type="button">‹ App 审核</button><div class="loading-state">正在读取审核详情…</div></section>`;
  const row = currentReviewSubmissionDetail;
  if (!row?.id) return "";
  const items = row.items?.length ? row.items : [{ version: row.version, state: row.state }];
  const versionItem = items.find(item => item.version?.versionString) || items[0] || {};
  const iconUrl = appStoreSafeImageUrl(versionItem.version?.iconUrl || app?.iconUrl || app?.artworkUrl || "");
  const icon = iconUrl ? `<span class="app-review-detail-icon"><img src="${escapeHTML(iconUrl)}" alt=""></span>` : appStoreAppIconHTML(app, "app-review-detail-icon");
  const submissionState = String(row.state || "").toUpperCase();
  const canResubmit = !row.submissionAccepted && /^(UNRESOLVED_ISSUES|READY_FOR_REVIEW)$/.test(submissionState);
  const resubmittableItem = canResubmit ? items.find(item => /^READY_FOR_REVIEW$/i.test(String(item.state || item.relatedState || ""))) : null;
  const resubmitButton = resubmittableItem
    ? `<button class="primary app-review-resubmit-button" type="button" data-review-submission-id="${escapeHTML(row.id)}" data-review-submission-resubmit="1">重新提交至 App 审核</button>`
    : "";
  return `<section class="app-review-detail-page">
    <button class="app-link-button" id="app-review-detail-back" type="button">‹ App 审核</button>
    <div class="app-review-detail-title-row"><h2>${escapeHTML(appStorePlatformText(row.platform || versionItem.version?.platform || "IOS"))} 提交</h2>${resubmitButton}</div>
    <div class="app-review-detail-status ${escapeHTML(appStoreStateClass(row.state))}"><i></i>${escapeHTML(appStoreStatusText(row.state))}</div>
    <div class="app-review-detail-block"><h3>已提交项目 (${Number(row.itemCount || items.length) || items.length})</h3>
      <p class="app-review-submitted-description">你可以查看并编辑以下项目，或与 Apple 进行沟通。在重新提交所有存在问题的项目且相关项目被接受前，当前已接受项目将无法发布。你也可以移除相关项目，之后再重新提交。</p>
      <div class="app-review-detail-table" role="table" aria-label="已提交项目"><div class="app-review-detail-row head" role="row"><span role="columnheader">项目</span><span role="columnheader">类型</span><span role="columnheader">审核状态</span></div>${items.map(item => {
        const itemState = appStoreReviewSubmissionItemState(item, row);
        const itemType = appStoreReviewSubmissionItemType(item, row, currentAppStoreDetail);
        const itemMeta = appStoreReviewItemMetaHTML(item);
        return `<div class="app-review-detail-row ${itemMeta ? "has-review-meta" : ""}" role="row"><div class="app-review-item-primary" role="cell">${icon}<div class="app-review-item-copy"><strong>${escapeHTML(appStoreReviewItemName(item, app))}</strong>${item.version?.versionString ? `<small>${escapeHTML(item.version.versionString)}${item.version.buildVersion ? ` (${escapeHTML(item.version.buildVersion)})` : item.version.buildVersionError ? ` · ${escapeHTML(item.version.buildVersionError)}` : ""}</small>` : ""}${itemMeta}</div></div><span class="app-review-item-type" role="cell">${escapeHTML(itemType)}</span><span class="app-review-state ${escapeHTML(appStoreStateClass(itemState))}" role="cell"><i></i>${escapeHTML(appStoreStatusText(itemState))}</span></div>`;
      }).join("")}</div>
    </div>
    ${renderAppStoreReviewMessages(row.messages || [], items, row.draftMessage)}
    ${appStoreReviewSubmissionCanReply(row) && !row.draftMessage?.id ? '<button class="app-review-reply-link" id="app-review-reply-link" type="button">回复 App 审核</button>' : ''}
    <dl class="app-review-detail-meta">
      <dt>提交日期</dt><dd>${escapeHTML(appStoreReviewFullDateLabel(appStoreReviewSubmittedTime(row)))}</dd>
      <dt>提交 ID</dt><dd class="mono">${escapeHTML(row.id)}</dd>
      <dt>提交者</dt><dd>${escapeHTML(row.submittedBy || row.submitter || "—")}</dd>
      <dt>最后更新者</dt><dd>${escapeHTML(row.lastUpdatedBy || "—")}</dd>
    </dl>
  </section>`;
}

async function updateAppStoreReviewSubmission(button) {
  const submissionId = String(button?.dataset?.reviewSubmissionId || "");
  if (!submissionId || !currentAppStoreApp?.id) return;
  setBusy(button, true, "更新中…");
  const result = await window.appleDeveloper.updateAppStoreReviewSubmissionItem({
    appId: currentAppStoreApp.id,
    submissionId,
    itemId: button.dataset.reviewSubmissionItemId || "",
    versionId: currentAppStoreDetail?.selectedVersion?.id || "",
  }).catch(error => ({ success: false, error: error.message }));
  setBusy(button, false);
  if (!result?.success) {
    showAppStoreError(result?.error || "更新审核项目失败", "", "更新失败");
    return;
  }
  await openAppStoreReviewSubmissionDetail(submissionId);
}

async function refreshAcceptedAppStoreSubmission(appId, submissionId, requestSeq) {
  const revision = appStoreEditRevision;
  const result = await window.appleDeveloper.appStoreReviewSubmissionStatus({ submissionId })
    .catch(error => ({ success: false, error: error.message }));
  if (requestSeq !== appStoreDetailRequestSeq || currentAppStoreApp?.id !== appId) return;
  if (!result?.success) {
    showAppStoreNotice(`提交审核已成功，审核状态暂未刷新：${result?.error || "请稍后刷新查看"}`, "warning");
    return;
  }
  const submission = result.submission;
  const merge = existing => ({
    ...existing,
    state: submission.state || existing.state,
    submittedDate: submission.submittedDate || existing.submittedDate,
    submissionAccepted: true,
    items: (existing.items || []).map(item => ({ ...item, ...(submission.items || []).find(row => row.id === item.id) })),
  });
  if (currentReviewSubmissionDetail?.id === submissionId) currentReviewSubmissionDetail = merge(currentReviewSubmissionDetail);
  if (currentAppStoreDetail) {
    currentAppStoreDetail.reviewSubmissions = (currentAppStoreDetail.reviewSubmissions || []).map(item => item.id === submissionId ? merge(item) : item);
    if (submission.version?.id) {
      const updateVersion = version => version?.id === submission.version.id ? {
        ...version, state: submission.version.state, appStoreState: submission.version.appStoreState, appVersionState: submission.version.appVersionState,
      } : version;
      currentAppStoreDetail.versions = (currentAppStoreDetail.versions || []).map(updateVersion);
      currentAppStoreDetail.selectedVersion = updateVersion(currentAppStoreDetail.selectedVersion);
    }
    updateCurrentAppStoreDetail(currentAppStoreDetail, { clearCache: true });
  }
  // A late refresh must not replace fields the user has started editing.
  const pane = document.querySelector(".app-detail")?.dataset.pane;
  if (pane && revision === appStoreEditRevision) {
    switchAppStorePane(currentAppStoreApp, pane);
    showAppStoreNotice("提交审核成功，审核状态已更新。");
  }
}

async function resubmitAppStoreReviewSubmission(button) {
  const submissionId = String(button?.dataset?.reviewSubmissionId || "");
  const appId = currentAppStoreApp?.id;
  if (!submissionId || !appId || button.disabled) return;
  const requestSeq = ++appStoreDetailRequestSeq;
  setBusy(button, true, "提交中…");
  const result = await window.appleDeveloper.resubmitAppStoreReview({ appId, submissionId })
    .catch(error => ({ success: false, error: error.message }));
  if (requestSeq !== appStoreDetailRequestSeq || currentAppStoreApp?.id !== appId) return;
  if (!result?.success) {
    setBusy(button, false);
    showAppStoreError(result?.error || "重新提交审核失败", "", "提交失败");
    return;
  }
  if (currentReviewSubmissionDetail?.id === submissionId) {
    currentReviewSubmissionDetail.submissionAccepted = true;
    if (result.state) currentReviewSubmissionDetail.state = result.state;
  }
  for (const item of currentAppStoreDetail?.reviewSubmissions || []) {
    if (item.id === submissionId) { item.submissionAccepted = true; if (result.state) item.state = result.state; }
  }
  clearAppStoreDetailCache(appId);
  button.textContent = "已提交";
  button.disabled = true;
  showAppStoreNotice("提交审核成功，正在刷新审核状态。");
  refreshAcceptedAppStoreSubmission(appId, submissionId, requestSeq).catch(() => {
    if (requestSeq === appStoreDetailRequestSeq && currentAppStoreApp?.id === appId) showAppStoreNotice("提交审核已成功，请刷新查看最新审核状态。", "warning");
  });
}

function renderAppStoreReviewPane(detail, app = currentAppStoreApp) {
  if (currentReviewSubmissionDetail || currentReviewSubmissionLoadingId) return renderAppStoreReviewSubmissionDetail(detail, app);
  const drafts = appStoreReviewDraftSubmissions(detail);
  const submitted = appStoreReviewSubmittedSubmissions(detail);
  const draftTable = drafts.length ? `<div class="app-review-table app-review-draft-table"><div class="app-review-row head"><span>创建日期</span><span>版本</span><span>创建者</span><span>项目</span><span>状态</span></div>${drafts.map(row => `<div class="app-review-row"><button class="app-review-link" data-review-submission-id="${escapeHTML(row.id)}" type="button">${escapeHTML(appStoreReviewDateLabel(appStoreReviewCreatedTime(row)))}</button><span>${escapeHTML(appStoreReviewVersionLabel(row))}</span><span>${escapeHTML(appStoreReviewActorLabel(row))}</span><span>${escapeHTML(appStoreReviewItemCountLabel(row))}</span><span class="app-review-state ${escapeHTML(appStoreStateClass(row.state))}"><i></i>${escapeHTML(appStoreStatusText(row.state))}</span></div>`).join("")}</div>` : '<div class="app-empty-line">当前没有准备提交的草稿。</div>';
  const submittedTable = submitted.length ? `<div class="app-review-table app-review-submitted-table"><div class="app-review-row head"><span>提交日期</span><span>版本</span><span>提交者</span><span>项目</span><span>状态</span></div>${submitted.map(row => `<div class="app-review-row"><button class="app-review-link" data-review-submission-id="${escapeHTML(row.id)}" type="button">${escapeHTML(appStoreReviewDateLabel(appStoreReviewSubmittedTime(row)))}</button><span>${escapeHTML(appStoreReviewVersionLabel(row))}</span><span>${escapeHTML(appStoreReviewActorLabel(row))}</span><span>${escapeHTML(appStoreReviewItemCountLabel(row))}</span><span class="app-review-state ${escapeHTML(appStoreStateClass(row.state))}"><i></i>${escapeHTML(appStoreStatusText(row.state))}</span></div>`).join("")}</div>` : '<div class="app-empty-line">当前没有审核提交记录。</div>';
  return `<section class="app-review-page"><h2>App 审核</h2><p>所有提交至 App 审核的项目以及你与 Apple 的交流消息显示如下。</p><div class="app-review-block"><h3>草稿</h3><p>准备提交至 App 审核的提交内容。</p>${draftTable}</div><div class="app-review-block"><h3>提交内容</h3><p>你可在下方查看过去 180 天内最新 10 项已完成的提交内容。</p>${submittedTable}</div></section>`;
}

function openAppStoreReviewSubmission(submissionId) {
  const submission = findAppStoreReviewSubmission(submissionId);
  if (submission && appStoreReviewIsDraft(submission)) {
    openAppStoreReviewDraftSubmissionPanel(submission);
    return;
  }
  openAppStoreReviewSubmissionDetail(submissionId);
}

async function openAppStoreReviewSubmissionDetail(submissionId) {
  if (!submissionId || !currentAppStoreApp?.id) return;
  currentReviewSubmissionDetail = null;
  currentReviewSubmissionLoadingId = submissionId;
  switchAppStorePane(currentAppStoreApp, "review");
  const result = await window.appleDeveloper.appStoreReviewSubmissionDetail({ appId: currentAppStoreApp.id, submissionId }).catch(error => ({ success: false, error: error.message }));
  currentReviewSubmissionLoadingId = "";
  if (!result?.success) {
    switchAppStorePane(currentAppStoreApp, "review");
    showAppStoreError(result?.error || "审核详情读取失败", "", "读取失败");
    return;
  }
  currentReviewSubmissionDetail = result.detail || null;
  if (currentReviewSubmissionDetail) {
    mergeReviewSubmissionDetailIntoAppDetail(currentReviewSubmissionDetail);
    uploadCurrentReviewGuidanceSnapshot();
  }
  switchAppStorePane(currentAppStoreApp, "review");
}

function renderAppStoreHistoryPane(detail) {
  const groups = detail?.history || [];
  if (!detail) return '<section class="app-history-page"><h2>iOS 历史记录</h2><div class="loading-state">正在读取历史记录…</div></section>';
  return `<section class="app-history-page"><h2>iOS 历史记录</h2>${groups.length ? groups.map((group, groupIndex) => {
    const version = group.version || {};
    const changes = group.changes || [];
    const groupId = `app-history-group-${groupIndex}`;
    const open = groupIndex === 0;
    return `<div class="app-history-group ${open ? "open" : ""}">
      <button class="app-history-toggle" type="button" data-app-history-group="${escapeHTML(groupId)}" aria-expanded="${open ? "true" : "false"}"><span class="app-history-arrow"></span>版本 ${escapeHTML(version.versionString || "")}</button>
      ${changes.length ? `<div class="app-history-table" id="${escapeHTML(groupId)}"><div class="app-history-row head"><span>活动</span><span>用户</span><span>日期</span></div>${changes.map((item, itemIndex) => {
        const detailId = `${groupId}-detail-${itemIndex}`;
        const stateText = appStoreHistoryStatusText(item.state);
        const stateClass = appStoreStateClass(item.state);
        const userText = item.initiator || "Apple";
        const dateText = appStoreHistoryDate(item.date);
        return `<button class="app-history-row app-history-record" type="button" data-app-history-detail="${escapeHTML(detailId)}" aria-expanded="false"><strong class="app-history-state ${escapeHTML(stateClass)}"><i></i>${escapeHTML(stateText)}</strong><span>${escapeHTML(userText)}</span><time>${escapeHTML(dateText)}</time></button><div class="app-history-detail" id="${escapeHTML(detailId)}"><dl><dt>活动</dt><dd>${escapeHTML(stateText)}</dd><dt>用户</dt><dd>${escapeHTML(userText)}</dd><dt>日期</dt><dd>${escapeHTML(dateText)}</dd><dt>版本</dt><dd>${escapeHTML(version.versionString || "—")}</dd>${item.id ? `<dt>记录 ID</dt><dd>${escapeHTML(item.id)}</dd>` : ""}</dl></div>`;
      }).join("")}</div>` : '<div class="app-empty-line">暂无状态变化记录。</div>'}
    </div>`;
  }).join("") : '<div class="app-empty-line">暂无历史记录。</div>'}</section>`;
}

function appStoreHelp(text) {
  return `<button class="app-help" type="button" aria-label="字段说明">?<span>${escapeHTML(text || "")}</span></button>`;
}

function appStoreInput(label, field, value, help = "", placeholder = "", disabled = false, max = 0) {
  const hint = placeholder === null ? "" : (placeholder || label || "");
  const maxAttr = Number(max || 0) ? ` maxlength="${Number(max)}"` : "";
  const counter = Number(max || 0) ? `<small class="app-field-counter" data-app-counter-max="${Number(max)}">${Math.max(0, Number(max) - String(value || "").length)}</small>` : "";
  return `<div class="field">${label || help ? `<label>${escapeHTML(label)}${help ? ` ${appStoreHelp(help)}` : ""}</label>` : ""}<input data-app-field="${escapeHTML(field)}" value="${escapeHTML(value || "")}" placeholder="${escapeHTML(hint)}"${maxAttr} ${disabled ? "disabled" : ""}>${counter}</div>`;
}

function updateAppStoreFieldCounter(field) {
  const counter = field?.parentElement?.querySelector?.("[data-app-counter-max]");
  const max = Number(counter?.dataset?.appCounterMax || 0);
  if (!counter || !max) return;
  const length = String(field.value || "").length;
  counter.textContent = counter.dataset.appCounterMode === "used"
    ? `${length}/${max}`
    : String(Math.max(0, max - length));
}

function appStoreTextarea(label, field, value, max, help = "", disabled = false) {
  const id = field.split(".").pop();
  return `<div class="field"><label>${escapeHTML(label)}${help ? ` ${appStoreHelp(help)}` : ""}${max ? ` <small data-app-counter-max="${Number(max)}" data-app-counter-mode="used">${String(value || "").length}/${max}</small>` : ""}</label><textarea id="${escapeHTML(id)}" data-app-field="${escapeHTML(field)}" maxlength="${Number(max || 0) || ""}" ${disabled ? "disabled" : ""}>${escapeHTML(value || "")}</textarea></div>`;
}

function appStoreMediaDeviceMatches(displayType = "", device = "iphone") {
  const type = String(displayType || "").toUpperCase();
  if (device === "ipad") return /IPAD/.test(type);
  if (device === "watch") return /WATCH/.test(type);
  return /IPHONE|IOS/.test(type) || (!/IPAD|WATCH/.test(type) && !type);
}

function appStoreMediaDisplayTitle(displayType = "", device = "iphone") {
  const type = String(displayType || "").toUpperCase();
  const map = {
    APP_IPHONE_65: "6.5 英寸显示屏",
    APP_IPHONE_67: "6.7 英寸显示屏",
    APP_IPHONE_61: "6.1 英寸显示屏",
    APP_IPHONE_58: "5.8 英寸显示屏",
    APP_IPHONE_55: "5.5 英寸显示屏",
    APP_IPAD_PRO_3GEN_129: "12.9 英寸显示屏",
    APP_IPAD_PRO_11: "11 英寸显示屏",
    APP_WATCH_ULTRA: "49 毫米显示屏",
    APP_WATCH_45: "45 毫米显示屏",
  };
  if (map[type]) return map[type];
  if (device === "ipad") return "12.9 英寸显示屏";
  if (device === "watch") return "Apple Watch 显示屏";
  return "6.5 英寸显示屏";
}

function appStorePickPrimaryMediaSet(sets = [], device = "iphone") {
  const matched = (Array.isArray(sets) ? sets : []).filter(set => appStoreMediaDeviceMatches(set?.type, device));
  if (!matched.length) return null;
  const rank = type => {
    const value = String(type || "").toUpperCase();
    const map = {
      APP_IPHONE_67: 5,
      APP_IPHONE_65: 4,
      APP_IPHONE_61: 3,
      APP_IPHONE_58: 2,
      APP_IPHONE_55: 1,
      APP_IPAD_PRO_3GEN_129: 4,
      APP_IPAD_PRO_11: 3,
      APP_WATCH_ULTRA: 3,
      APP_WATCH_49: 2,
    };
    return map[value] ?? 0;
  };
  return [...matched].sort((left, right) => {
    const delta = rank(right.type) - rank(left.type);
    if (delta) return delta;
    return (right.screenshots?.length || 0) - (left.screenshots?.length || 0);
  })[0];
}

function renderAppStoreMedia(previews, screenshots, previewCount, screenshotCount, editable = true, displayType = "") {
  const deviceTitles = { iphone: "iPhone", ipad: "iPad", watch: "Apple Watch" };
  const displayTitle = appStoreMediaDisplayTitle(displayType, appStoreMediaDevice);
  const items = [
    ...previews.map(item => ({ id: item.id, kind: "预览", mediaKind: "preview", url: item.previewUrl, name: item.fileName, type: item.displayType })),
    ...screenshots.map(item => ({ id: item.id, kind: "截屏", mediaKind: "screenshot", url: item.imageAssetUrl, name: item.fileName, type: item.displayType })),
  ].filter(item => item.url);
  const actions = editable ? `<button id="app-media-select-file" type="button">选取文件</button><button id="app-media-delete-all" type="button">全部删除</button>` : "";
  const removeButton = editable ? item => `<button class="app-media-remove" data-app-media-kind="${escapeHTML(item.mediaKind)}" data-app-media-delete="${escapeHTML(item.id)}" type="button">−</button>` : () => "";
  const pending = editable ? appStoreMediaUploads.filter(item => item.device === appStoreMediaDevice && item.state !== "uploaded") : [];
  const pendingHTML = pending.map(item => `<figure class="app-media-uploading" data-app-media-upload-id="${escapeHTML(item.id)}"><div class="app-media-upload-placeholder"><span class="app-media-spinner"></span><b>${Math.round(Number(item.percent || 0))}%</b></div><figcaption>${escapeHTML(item.name || "正在上传")}</figcaption></figure>`).join("");
  return `<div class="app-media-box ${editable ? "" : "app-media-readonly"}"><div class="app-media-device"><span class="app-device-icon"></span><strong>${deviceTitles[appStoreMediaDevice]}</strong><b>${displayTitle}</b></div><div class="app-media-strip">${items.map(item => `<figure>${removeButton(item)}<img src="${escapeHTML(item.url)}" alt="${escapeHTML(item.name || item.kind)}"></figure>`).join("")}${pendingHTML}</div><div class="app-media-footer"><span>${previewCount}/3 个 App 预览</span><span>${screenshotCount}/10 张截屏</span>${actions}</div></div>`;
}

function updateAppStoreScreenshotProgress(progress = {}) {
  const uploadId = String(progress.uploadId || "");
  if (!uploadId) return;
  if (progress.phase === "selected" || progress.phase === "resize-required") {
    appStoreMediaUploads = (progress.files || []).map(item => ({ ...item, uploadId, device: progress.device || appStoreMediaDevice }));
    if (currentAppStoreDetail) switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail.app || {}) }, "release");
  } else if (progress.itemId) {
    appStoreMediaUploads = appStoreMediaUploads.map(item => String(item.id) === String(progress.itemId) ? { ...item, ...progress } : item);
  }
  appStoreMediaUploads.forEach(item => {
    const node = document.querySelector(`[data-app-media-upload-id="${CSS.escape(String(item.id))}"]`);
    if (!node) return;
    const percent = node.querySelector(".app-media-upload-placeholder b");
    if (percent) percent.textContent = `${Math.round(Number(item.percent || 0))}%`;
  });
}

function openAppStoreScreenshotResizeModal(result) {
  if (document.getElementById("app-screenshot-resize-modal")) return;
  const requirements = result?.requirements || {};
  const sizes = requirements.sizes || [];
  const recommended = result?.recommendations?.[0] || {};
  const recommendedIndex = sizes.findIndex(size => size.width === recommended.width && size.height === recommended.height);
  const modal = document.createElement("div");
  modal.id = "app-screenshot-resize-modal";
  modal.className = "app-pricing-modal";
  const options = sizes.map((size, index) => `<label><input type="radio" name="app-screenshot-size" value="${index}" ${index === Math.max(0, recommendedIndex) ? "checked" : ""}>${size.orientation === "landscape" ? "横屏" : "竖屏"}（${size.width} × ${size.height}）</label>`).join("");
  modal.innerHTML = `<div class="app-pricing-dialog app-screenshot-resize-dialog"><div class="app-pricing-dialog-body"><h2>选择截屏尺寸</h2><p>检测到图片尺寸不符合 ${escapeHTML(requirements.device || "当前设备")} 要求。请选择上传尺寸，系统会处理后上传。</p><div class="app-screenshot-resize-options">${options}</div><div class="app-pricing-message"></div></div><div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" data-confirm type="button">确认并上传</button></div></div>`;
  appendAppStoreModal(modal);
  const close = () => { modal.remove(); appStoreMediaUploads = []; };
  modal.querySelector("[data-close]").addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelector("[data-confirm]").addEventListener("click", async event => {
    const selectedIndex = Number(modal.querySelector('input[name="app-screenshot-size"]:checked')?.value ?? -1);
    const target = sizes[selectedIndex];
    if (!target) return;
    const button = event.currentTarget;
    setBusy(button, true, "处理中…");
    const retry = await window.appleDeveloper.uploadAppStoreScreenshot({ appId: currentAppStoreApp?.id || currentAppStoreDetail?.app?.id, localizationId: activeAppStoreLocalization(currentAppStoreDetail)?.id, device: appStoreMediaDevice, filePaths: result.files, resize: target });
    setBusy(button, false);
    if (retry?.success) {
      modal.remove();
      updateCurrentAppStoreDetail(retry.detail, { clearCache: true });
      appStoreMediaUploads = [];
      switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
    } else modal.querySelector(".app-pricing-message").textContent = retry?.error || "截图上传失败";
  });
}

function markAppStoreDetailDirty() {
  appStoreEditRevision += 1;
  if (!appStoreVersionEditable(currentAppStoreDetail?.selectedVersion || {})) return;
  const button = el("app-detail-save");
  if (button) button.disabled = appStoreSaveInFlight;
  const submitButton = el("app-detail-submit");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.title = "请先保存修改后再添加以供审核";
  }
  const submitMenuButton = el("app-detail-submit-menu");
  if (submitMenuButton) {
    submitMenuButton.disabled = true;
    submitMenuButton.title = "请先保存修改后再添加以供审核";
  }
  const infoButton = document.querySelector(".app-info-save");
  if (infoButton) infoButton.disabled = appStoreSaveInFlight;
  const node = document.activeElement;
  if (node?.dataset?.appField) clearAppStoreFieldError(node.dataset.appField);
}

function closeAppStoreSubmitMenu() {
  const menu = el("app-submit-menu");
  const trigger = el("app-detail-submit-menu");
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function openAppStoreSubmitMenu(event) {
  event?.stopPropagation?.();
  const menu = el("app-submit-menu");
  const trigger = el("app-detail-submit-menu");
  const submitButton = el("app-detail-submit");
  if (!menu || submitButton?.disabled || trigger?.disabled) return;
  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  if (trigger) trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) {
    setTimeout(() => document.addEventListener("click", closeAppStoreSubmitMenu, { once: true }), 0);
  }
}

function onPrivacyCategoryChange() {}
function onPrivacyPurposeChange() {}
function onPrivacyProtectionChange() {}

async function refreshAppStorePrivacyFromResult(result, noticeText = "保存成功，页面内容已刷新。", errorPrefix = "保存失败") {
  if (!result?.success) {
    showAppStoreResultErrors(result, errorPrefix);
    return false;
  }
  currentAppStoreDetail = {
    ...currentAppStoreDetail,
    privacy: result.privacy || currentAppStoreDetail?.privacy || null,
  };
  switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "privacy");
  if (noticeText) showAppStoreNotice(noticeText);
  return true;
}

function openAppStorePrivacyPolicyModal() {
  if (document.getElementById("app-privacy-policy-modal")) return;
  const localization = primaryPrivacyLocalization(currentAppStoreDetail);
  const modal = document.createElement("div");
  modal.id = "app-privacy-policy-modal";
  modal.className = "app-pricing-modal";
  modal.innerHTML = `<form class="app-pricing-dialog app-privacy-policy-dialog">
    <div class="app-pricing-dialog-body">
      <h2>隐私政策</h2>
      <p>隐私政策网址会显示在 App Store 产品页面上。用户隐私选择网址可用于让用户管理数据选择。</p>
      <label>隐私政策网址 (URL) ${appStoreHelp("此网址会显示在 App Store 产品页面。")}<input name="privacyPolicyUrl" value="${escapeHTML(localization.privacyPolicyUrl || "")}" placeholder="https://"></label>
      <label>用户隐私选择网址 (URL) <span>（可不填）</span> ${appStoreHelp("如果 App 支持用户管理数据选择，请提供对应网址。")}<input name="privacyChoicesUrl" value="${escapeHTML(localization.privacyChoicesUrl || "")}" placeholder="https://"></label>
      <div class="app-pricing-message"></div>
    </div>
    <div class="app-pricing-dialog-actions"><button class="secondary" data-close type="button">取消</button><button class="primary" type="submit">保存</button></div>
  </form>`;
  appendAppStoreModal(modal);
  const form = modal.querySelector("form");
  const close = () => modal.remove();
  modal.querySelector("[data-close]")?.addEventListener("click", close);
  modal.addEventListener("click", event => { if (event.target === modal) close(); });
  modal.querySelectorAll(".app-help").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    document.querySelectorAll(".app-help.open").forEach(item => { if (item !== button) item.classList.remove("open"); });
    button.classList.toggle("open");
  }));
  form?.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const message = form.querySelector(".app-pricing-message");
    const privacyPolicyUrl = String(form.elements.privacyPolicyUrl.value || "").trim();
    const privacyChoicesUrl = String(form.elements.privacyChoicesUrl.value || "").trim();
    if (!privacyPolicyUrl) {
      message.textContent = "请输入隐私政策网址。";
      form.elements.privacyPolicyUrl.focus();
      return;
    }
    if (message) message.textContent = "";
    setBusy(submit, true, "保存中…");
    const saved = await saveAppStorePrivacyUrls({ privacyPolicyUrl, privacyChoicesUrl }, false);
    if (saved) close();
    else if (message && !message.textContent) message.textContent = "保存失败，请检查网址后重试。";
    setBusy(submit, false);
  });
  setTimeout(() => form?.elements.privacyPolicyUrl?.focus(), 0);
}

async function saveAppStorePrivacyUrls(values = null, showErrors = true) {
  const button = el("app-privacy-save");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const localizationId = appStoreFieldValue("privacy.localizationId", primaryPrivacyLocalization(currentAppStoreDetail)?.id || "");
  if (!appId || !localizationId) return false;
  if (button) setBusy(button, true, "保存中…");
  const payload = values || {
    privacyPolicyUrl: appStoreFieldValue("privacy.privacyPolicyUrl"),
    privacyChoicesUrl: appStoreFieldValue("privacy.privacyChoicesUrl"),
  };
  try {
    const result = await window.appleDeveloper.saveAppStorePrivacyUrls({
      appId,
      localizationId,
      privacyPolicyUrl: payload.privacyPolicyUrl,
      privacyChoicesUrl: payload.privacyChoicesUrl,
    });
    return await refreshAppStorePrivacyFromResult(result);
  } catch (error) {
    if (showErrors) showAppStoreError(error.message || "未知错误", "", "保存失败");
    return false;
  } finally {
    if (button && document.body.contains(button)) setBusy(button, false);
  }
}

async function publishAppStorePrivacy() {
  const button = el("app-privacy-publish");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const localization = primaryPrivacyLocalization(currentAppStoreDetail);
  const missing = privacyMissingItems(currentAppStoreDetail?.privacy || {}, localization);
  if (missing.length) {
    showAppStoreError(missing.join("\n"), "", "App 隐私暂不能发布");
    return;
  }
  if (!appId || !button) return;
  setBusy(button, true, "发布中…");
  try {
    const result = await window.appleDeveloper.publishAppStorePrivacy({ appId });
    await refreshAppStorePrivacyFromResult(result, "App 隐私已发布。", "发布失败");
  } catch (error) {
    showAppStoreError(error.message || "未知错误", "", "发布失败");
  } finally {
    if (document.body.contains(button)) setBusy(button, false);
  }
}

async function createSelectedAppStoreDataUsage() {
  const mask = document.querySelector(".app-privacy-modal-mask");
  const button = el("app-privacy-add");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const categoryId = mask?.querySelector("[data-privacy-category]:checked")?.value || "";
  const purposeId = mask?.querySelector("[data-privacy-purpose]:checked")?.value || "";
  const dataProtectionId = mask?.querySelector("[data-privacy-protection]:checked")?.value || "";
  if (!appId || !categoryId || !purposeId || !dataProtectionId) return;
  setBusy(button, true, "保存中…");
  try {
    const result = await window.appleDeveloper.createAppStoreDataUsage({ appId, categoryId, purposeId, dataProtectionId });
    if (result?.success) mask?.remove();
    await refreshAppStorePrivacyFromResult(result);
  } catch (error) {
    const box = mask?.querySelector(".app-privacy-error");
    if (box) box.textContent = error.message || "保存失败";
  } finally {
    if (document.body.contains(button)) setBusy(button, false);
  }
}

async function deleteAppStoreDataUsage(usageId) {
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  if (!appId || !usageId || !confirm("确定删除这项数据收集设置吗？")) return;
  try {
    const result = await window.appleDeveloper.deleteAppStoreDataUsage({ appId, usageId });
    await refreshAppStorePrivacyFromResult(result);
  } catch (error) {
    showAppStoreError(error.message || "未知错误", "", "删除失败");
  }
}

function appStoreFieldValue(field, fallback = "") {
  const node = document.querySelector(`[data-app-field="${field}"]`);
  if (!node) return fallback;
  if (node.type === "checkbox") return !!node.checked;
  if (node.type === "radio") return document.querySelector(`[data-app-field="${field}"]:checked`)?.value || "";
  return node.value || "";
}

function clearAppStoreValidationErrors() {
  document.querySelectorAll(".app-field-invalid").forEach(node => node.classList.remove("app-field-invalid"));
  document.querySelectorAll(".app-field-error").forEach(node => node.remove());
  document.querySelectorAll(".app-detail-error").forEach(node => node.remove());
}

function clearAppStoreFieldError(field) {
  const node = document.querySelector(`[data-app-field="${field}"]`);
  if (!node) return;
  node.classList.remove("app-field-invalid");
  node.closest(".field")?.querySelector(".app-field-error")?.remove();
}

function showAppStoreFieldError(field, message) {
  const node = document.querySelector(`[data-app-field="${field}"]`);
  if (!node) return false;
  const wrap = node.closest(".field") || node.parentElement;
  node.classList.add("app-field-invalid");
  wrap?.querySelector(".app-field-error")?.remove();
  wrap?.insertAdjacentHTML("beforeend", `<div class="app-field-error">${escapeHTML(message)}</div>`);
  return true;
}

function showAppStoreError(message, field = "", prefix = "保存失败") {
  if (field && showAppStoreFieldError(field, message)) {
    document.querySelector(`[data-app-field="${field}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const main = el("app-detail-main");
  if (main) main.insertAdjacentHTML("afterbegin", `<div class="app-detail-error">${escapeHTML(prefix)}：${escapeHTML(message || "未知错误")}</div>`);
}

function showAppStoreNotice(message, type = "success") {
  document.querySelectorAll(".app-detail-notice").forEach(node => node.remove());
  const main = el("app-detail-main");
  if (!main) return;
  main.insertAdjacentHTML("afterbegin", `<div class="app-detail-notice ${escapeHTML(type)}">${escapeHTML(message)}</div>`);
}

function appStoreFieldFromAppleError(error = "") {
  const text = typeof error === "object"
    ? `${error.message || ""} ${error.pointer || ""} ${error.resource || ""}`
    : String(error || "");
  const map = [
    [/contactFirstName/i, "reviewDetail.contactFirstName"],
    [/contactLastName/i, "reviewDetail.contactLastName"],
    [/contactPhone|phone/i, "reviewDetail.contactPhone"],
    [/contactEmail|email/i, "reviewDetail.contactEmail"],
    [/App Description|description/i, "localization.description"],
    [/keywords/i, "localization.keywords"],
    [/supportUrl/i, "localization.supportUrl"],
    [/marketingUrl/i, "localization.marketingUrl"],
    [/whatsNew/i, "localization.whatsNew"],
    [/versionString|version/i, "version.versionString"],
    [/copyright/i, "version.copyright"],
    [/build/i, "version.build"],
    [/contentRightsDeclaration/i, "appInfo.contentRightsDeclaration"],
    [/bundleId/i, "appInfo.bundleId"],
    [/icpNumber|ICP number/i, "appInfo.icpNumber"],
    [/primaryCategory/i, "appInfo.primaryCategoryId"],
    [/ageRating/i, "appInfo.ageRatingAttributes"],
  ];
  return map.find(([pattern]) => pattern.test(text))?.[1] || "";
}

function appStoreReadableError(error = "") {
  const text = typeof error === "object" ? `${error.message || ""} ${error.detail || ""} ${error.pointer || ""}` : String(error || "");
  if (/the app name you entered is already being used|app name.*already being used/i.test(text)) return "你填写的 App 名称已被使用，请更换一个未使用的名称。如果你拥有该名称的商标权，可向 Apple 提交申诉申请释放此名称。";
  if (/build associated|relationship.*build|\/relationships\/build|build.*not found/i.test(text)) return "请先在“构建版本”里选择一个已处理完成的构建版本。";
  if (/EXPORT_COMPLIANCE|export compliance|encryption|usesNonExemptEncryption|appEncryptionDeclaration|合规证明/i.test(text)) return "此构建版本缺少出口合规证明信息。";
  if (/versionString/i.test(text)) return "版本号不能为空，请到“准备提交”页面填写版本号后再保存。";
  if (/icpNumber|Invalid ICP number/i.test(text)) return "备案号错误。请前往中国工业和信息化部政务服务平台查询确认后再保存。";
  if (/contactFirstName/i.test(text)) return "联系人名字不能为空，请在 App 审核信息里填写。";
  if (/description/i.test(text) && /at least\s*10|minimum(?:\s+of)?\s*10|too short|shorter than\s*10|至少\s*10|最少\s*10/i.test(text)) return "App 描述至少需要 10 个字符。";
  if (/keywords/i.test(text)) return "请填写关键词。";
  if (/supportUrl/i.test(text)) return "请填写有效的技术支持网址 (URL)。";
  if (/privacyPolicyUrl/i.test(text)) return "请到“App 隐私”填写隐私政策网址。";
  if (/APP_DATA_USAGES_REQUIRED|data usages|data usage/i.test(text)) return "请到“App 隐私”发布数据使用回答。";
  return String(typeof error === "object" ? (error.message || error.detail || "保存失败") : error);
}

function showAppStoreResultErrors(result, prefix = "保存失败") {
  clearAppStoreValidationErrors();
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (/提交审核/.test(prefix)) {
    showAppStoreReviewSubmitError(result);
    return;
  }
  let firstField = "";
  const globalMessages = [];
  const activeLocalizationId = String(activeAppStoreLocalization(currentAppStoreDetail)?.id || "");
  for (const item of errors) {
    const message = appStoreReadableError(item);
    const field = appStoreFieldFromAppleError(item);
    const resourceId = String(item?.resource || "").split("/").filter(Boolean).pop() || "";
    const otherLocalization = field.startsWith("localization.") && resourceId !== activeLocalizationId
      && (currentAppStoreDetail?.localizations || []).some(row => row.id === resourceId);
    if (otherLocalization) {
      globalMessages.push(`${appStoreErrorLocalePrefix(item)}${message}`);
      continue;
    }
    const descriptionLength = String(appStoreFieldValue("localization.description") || "").trim().length;
    if (field === "localization.description" && descriptionLength >= 10 && message === "App 描述至少需要 10 个字符。") {
      globalMessages.push(`Apple 返回描述长度错误，但当前输入为 ${descriptionLength} 个字符。请刷新 App 详情后重试。`);
      continue;
    }
    if (field && showAppStoreFieldError(field, message)) {
      if (!firstField) firstField = field;
    }
  }
  if (globalMessages.length) showAppStoreError(globalMessages[0], "", prefix);
  if (firstField) {
    document.querySelector(`[data-app-field="${firstField}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (globalMessages.length) return;
  const messages = errors.map(item => item?.message || item?.detail || "").filter(Boolean);
  showAppStoreError(messages[0] || result?.error || "未知错误", "", prefix);
}

function appStoreReviewRequirementMessage(item) {
  const text = `${item?.message || item?.detail || item || ""} ${item?.pointer || ""} ${item?.resource || ""}`;
  const localePrefix = appStoreErrorLocalePrefix(item);
  if (/resource cannot be reviewed|associated errors/i.test(text)) return "";
  if (/build associated|relationship.*build|关联的版本|build.*not found|\/relationships\/build/i.test(text)) return "你必须在“构建版本”中选择一个已处理完成的构建版本。";
  if (/EXPORT_COMPLIANCE|export compliance|encryption|usesNonExemptEncryption|appEncryptionDeclaration|合规证明/i.test(text)) return "此构建版本缺少出口合规证明信息。";
  if (/attribute ['\"]?description|App Description|\/description/i.test(text)) return `${localePrefix}描述 - 此栏为必填项，且至少需要 10 个字符。`;
  if (/attribute ['\"]?keywords|\/keywords/i.test(text)) return `${localePrefix}关键词 - 此栏为必填项。`;
  if (/attribute ['\"]?supportUrl|\/supportUrl/i.test(text)) return `${localePrefix}技术支持网址 (URL) - 此栏为必填项。`;
  if (/APP_DATA_USAGES_REQUIRED|published answers.*data usages|data usage.*publish|appDataUsages/i.test(text)) return "提交 App 以供审核前，必须在“App 隐私”部分发布数据使用回答。";
  if (/contentRightsDeclaration/i.test(text)) return "你必须在 App 信息中设置内容版权信息。";
  if (/icpNumber|ICP number/i.test(text)) return "ICP 备案号无效，请检查后重新输入。";
  if (/bundleId/i.test(text)) return "套装 ID 无效或当前状态不允许修改。";
  if (/primaryCategory/i.test(text)) return "你必须为 App 选择主要类别。";
  if (/ageRating/i.test(text)) return "必须回答要求的年龄分级问题。";
  if (/privacyPolicyUrl/i.test(text)) return "你必须在“App 隐私”页面输入隐私政策网址 (URL)。";
  if (/privacy|App 隐私/i.test(text)) return "提交 App 以供审核前，需要在 App 隐私部分提供相关信息。";
  const cleaned = String(item?.message || item?.detail || item || "").replace(/appStoreVersions with id '[^']+'/i, "当前版本").trim();
  return cleaned || "需要补充一项提交审核所需的信息。";
}

function appStoreErrorLocalePrefix(item = {}) {
  const resource = String(item.resource || "");
  const id = resource.split("/").filter(Boolean).pop() || "";
  const versionLocalization = (currentAppStoreDetail?.localizations || []).find(row => row.id === id);
  const infoLocalization = (currentAppStoreDetail?.appInfo?.localizations || []).find(row => row.id === id);
  const locale = versionLocalization?.locale || infoLocalization?.locale || "";
  return locale ? `${appStoreLocaleName(locale)} - ` : "";
}

function appStoreReviewRequirementGroup(item) {
  const text = `${item?.message || item?.detail || item || ""} ${item?.pointer || ""} ${item?.resource || ""}`;
  return /description|keywords|supportUrl|marketingUrl|promotionalText|whatsNew|localization/i.test(text) ? "field" : "global";
}

function showAppStoreReviewSubmitError(result = {}) {
  document.querySelectorAll(".app-review-submit-error").forEach(node => node.remove());
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const source = errors.length ? errors : [result?.error || "无法添加以供审核"];
  const grouped = { global: [], field: [] };
  source.forEach(item => {
    const message = appStoreReviewRequirementMessage(item);
    if (message && !grouped[appStoreReviewRequirementGroup(item)].includes(message)) grouped[appStoreReviewRequirementGroup(item)].push(message);
  });
  if (!grouped.global.length && !grouped.field.length) grouped.global.push("当前版本暂时无法提交审核，请检查必填信息。");
  const main = el("app-detail-main");
  const anchor = main?.querySelector(".app-release-title");
  const errorPanel = (title, messages, intro = "") => messages.length ? `<section class="app-review-submit-error">
    <div class="app-review-submit-icon">!</div>
    <div class="app-review-submit-copy">
      <h4>${escapeHTML(title)}</h4>
      ${intro ? `<p>${escapeHTML(intro)}</p>` : ""}
      <ul>${messages.map(message => `<li>${escapeHTML(message)}</li>`).join("")}</ul>
    </div>
  </section>` : "";
  const html = errorPanel("无法添加以供审核", grouped.global, "要开始审核流程，必须提供以下项目：")
    + errorPanel("你在此页上有一个或多个错误。", grouped.field);
  if (anchor) anchor.insertAdjacentHTML("afterend", html);
  else if (main) main.insertAdjacentHTML("afterbegin", html);
  document.querySelector(".app-review-submit-error")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function validateAppStoreBeforeSave() {
  clearAppStoreValidationErrors();
  const errors = [];
  const description = appStoreFieldValue("localization.description").trim();
  if (description.length < 10) errors.push(["localization.description", "App 描述至少需要 10 个字符。"]);
  const contactFields = [
    ["reviewDetail.contactFirstName", "请输入联系名字。"],
    ["reviewDetail.contactLastName", "请输入联系姓氏。"],
    ["reviewDetail.contactPhone", "请输入电话号码。"],
    ["reviewDetail.contactEmail", "请输入电子邮件。"],
  ];
  for (const [field, message] of contactFields) {
    if (!String(appStoreFieldValue(field) || "").trim()) errors.push([field, message]);
  }
  const email = String(appStoreFieldValue("reviewDetail.contactEmail") || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(["reviewDetail.contactEmail", "请输入有效的电子邮件。"]);
  const releaseType = appStoreFieldValue("version.releaseType", "AFTER_APPROVAL");
  const scheduledDate = appStoreFieldValue("version.earliestReleaseDate", "");
  if (releaseType === "SCHEDULED" && !scheduledDate) errors.push(["version.earliestReleaseDate", "请选择计划发布时间。"]) ;
  if (releaseType === "SCHEDULED" && scheduledDate && new Date(scheduledDate).getTime() <= Date.now()) errors.push(["version.earliestReleaseDate", "计划发布时间必须晚于当前时间。"]) ;
  errors.forEach(([field, message]) => showAppStoreFieldError(field, message));
  if (errors.length) document.querySelector(`[data-app-field="${errors[0][0]}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return errors.length === 0;
}

function appStoreVersionPayload() {
  const version = currentAppStoreDetail.selectedVersion || {};
  const localization = activeAppStoreLocalization(currentAppStoreDetail);
  const review = currentAppStoreDetail.reviewDetail || {};
  const appInfo = currentAppStoreDetail.appInfo || {};
  const appInfoLocalization = (appInfo.localizations || [])[0] || {};
  const primaryCategoryId = appStoreFieldValue("appInfo.primaryCategoryId", appInfo.primaryCategory?.id || "");
  const secondaryCategoryId = appStoreFieldValue("appInfo.secondaryCategoryId", appInfo.secondaryCategory?.id || "");
  const releaseType = appStoreFieldValue("version.releaseType", version.releaseType || "AFTER_APPROVAL");
  const localReleaseDate = appStoreFieldValue("version.earliestReleaseDate", "");
  const earliestReleaseDate = releaseType === "SCHEDULED" && localReleaseDate ? new Date(localReleaseDate).toISOString() : null;
  return {
    appId: currentAppStoreApp.id || currentAppStoreDetail.app?.id,
    versionId: version.id,
    platform: version.platform || "IOS",
    localizationId: localization.id,
    reviewDetailId: review.id,
    appInfo: {
      id: appInfo.id,
      ageRatingDeclarationId: appInfo.ageRatingDeclarationId,
      bundleId: appStoreFieldValue("appInfo.bundleId", currentAppStoreApp?.bundleId || currentAppStoreDetail?.app?.bundleId || ""),
      icpNumber: appStoreFieldValue("appInfo.icpNumber", currentAppStoreDetail?.app?.icpNumber || ""),
      ageRatingAttributes: parseAppStoreJSONField("appInfo.ageRatingAttributes"),
      localizationId: appInfoLocalization.id,
      localization: {
        name: appStoreFieldValue("appInfo.name", appInfoLocalization.name || currentAppStoreApp?.name || ""),
        subtitle: appStoreFieldValue("appInfo.subtitle", appInfoLocalization.subtitle || ""),
      },
      categories: {
        primaryCategoryId,
        secondaryCategoryId,
        primaryCategory: findAppCategory(primaryCategoryId),
        secondaryCategory: findAppCategory(secondaryCategoryId),
      },
      contentRightsDeclaration: appStoreFieldValue("appInfo.contentRightsDeclaration", currentAppStoreDetail?.app?.contentRightsDeclaration || ""),
    },
    localization: {
      promotionalText: appStoreFieldValue("localization.promotionalText", localization.promotionalText || ""),
      description: appStoreFieldValue("localization.description", localization.description || ""),
      keywords: appStoreFieldValue("localization.keywords", localization.keywords || ""),
      supportUrl: appStoreFieldValue("localization.supportUrl", localization.supportUrl || ""),
      marketingUrl: appStoreFieldValue("localization.marketingUrl", localization.marketingUrl || ""),
      ...(window.AppVersionRules.isUpdateVersion(currentAppStoreDetail, version) ? { whatsNew: appStoreFieldValue("localization.whatsNew", localization.whatsNew || "") } : {}),
    },
    version: {
      versionString: appStoreFieldValue("version.versionString", version.versionString || ""),
      copyright: appStoreFieldValue("version.copyright", version.copyright || ""),
      releaseType,
      earliestReleaseDate,
    },
    reviewDetail: {
      demoAccountRequired: appStoreFieldValue("reviewDetail.demoAccountRequired", review.demoAccountRequired),
      demoAccountName: appStoreFieldValue("reviewDetail.demoAccountName", review.demoAccountName || ""),
      demoAccountPassword: appStoreFieldValue("reviewDetail.demoAccountPassword", review.demoAccountPassword || ""),
      contactFirstName: appStoreFieldValue("reviewDetail.contactFirstName", review.contactFirstName || ""),
      contactLastName: appStoreFieldValue("reviewDetail.contactLastName", review.contactLastName || ""),
      contactPhone: appStoreFieldValue("reviewDetail.contactPhone", review.contactPhone || ""),
      contactEmail: appStoreFieldValue("reviewDetail.contactEmail", review.contactEmail || ""),
      notes: appStoreFieldValue("reviewDetail.notes", review.notes || ""),
    },
  };
}

function parseAppStoreJSONField(field) {
  const value = appStoreFieldValue(field);
  if (!String(value || "").trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mergeSavedAppStoreFields(detail, saved) {
  const next = { ...detail };
  if (saved.app) next.app = { ...detail.app, ...saved.app };
  if (saved.appInfo) next.appInfo = { ...detail.appInfo, ...saved.appInfo };
  if (Object.prototype.hasOwnProperty.call(saved, "reviewDetail")) next.reviewDetail = saved.reviewDetail;
  if (saved.selectedVersion) {
    const keys = ["state", "appStoreState", "appVersionState", "versionString", "copyright", "releaseType", "earliestReleaseDate", "reviewDetailId"];
    const fields = Object.fromEntries(keys.filter(key => saved.selectedVersion[key] !== undefined).map(key => [key, saved.selectedVersion[key]]));
    const update = version => version?.id === saved.selectedVersion.id ? { ...version, ...fields } : version;
    next.selectedVersion = update(detail.selectedVersion);
    next.versions = (detail.versions || []).map(update);
  }
  if (saved.localizations) {
    next.localizations = (detail.localizations || []).map(item => {
      const row = saved.localizations.find(row => row.id === item.id);
      if (!row) return item;
      const { screenshotSetIds, previewSetIds, ...fields } = row;
      return { ...item, ...fields };
    });
  }
  return next;
}

async function saveAppStoreDetail() {
  const button = el("app-detail-save");
  const pane = document.querySelector(".app-detail")?.dataset?.pane || "release";
  const activeButton = pane === "info" ? document.querySelector(".app-info-save") || button : button;
  if (appStoreSaveInFlight || !activeButton || !currentAppStoreDetail || !currentAppStoreApp) return;
  if (pane === "release" && !appStoreVersionEditable(currentAppStoreDetail.selectedVersion || {})) return;
  if (pane !== "info" && !validateAppStoreBeforeSave()) return;
  const appId = currentAppStoreApp.id;
  const requestSeq = ++appStoreDetailRequestSeq;
  const revision = appStoreEditRevision;
  let saved = false;
  appStoreSaveInFlight = true;
  setBusy(activeButton, true, "保存中…");
  try {
    const payload = appStoreVersionPayload();
    if (pane === "info") {
      delete payload.localization;
      delete payload.version;
      delete payload.reviewDetail;
    } else delete payload.appInfo;
    const result = await window.appleDeveloper.saveAppStoreVersion(payload);
    if (result?.success) clearAppStoreDetailCache(appId);
    if (requestSeq !== appStoreDetailRequestSeq || currentAppStoreApp?.id !== appId) return;
    if (!result?.success) {
      showAppStoreResultErrors(result, "保存失败");
      return;
    }
    saved = true;
    updateCurrentAppStoreDetail(mergeSavedAppStoreFields(currentAppStoreDetail, result.detail), { clearCache: true });
    const visiblePane = document.querySelector(".app-detail")?.dataset.pane;
    if (visiblePane && revision === appStoreEditRevision) switchAppStorePane({ ...currentAppStoreApp, ...currentAppStoreDetail.app }, visiblePane);
    showAppStoreNotice(revision === appStoreEditRevision ? "保存成功。" : "保存成功。保存期间新增的修改尚未保存。");
  } catch (error) {
    if (requestSeq === appStoreDetailRequestSeq && currentAppStoreApp?.id === appId) showAppStoreError(error.message || "未知错误", appStoreFieldFromAppleError(error.message));
  } finally {
    appStoreSaveInFlight = false;
    if (activeButton.isConnected) {
      setBusy(activeButton, false);
      activeButton.disabled = saved && revision === appStoreEditRevision;
    }
  }
}

async function submitAppStoreReview(options = {}) {
  if (options?.currentTarget) options = {};
  const button = el("app-detail-submit");
  const menuButton = el("app-detail-submit-menu");
  if (!button || !currentAppStoreDetail || !currentAppStoreApp) return;
  if (!appStoreVersionEditable(currentAppStoreDetail.selectedVersion || {})) return;
  if (!el("app-detail-save")?.disabled) {
    button.disabled = true;
    button.title = "请先保存修改后再添加以供审核";
    if (menuButton) menuButton.disabled = true;
    showAppStoreError("请先保存当前修改，再添加以供审核。", "", "还有未保存的修改");
    return;
  }
  // 让 Apple 对版本、全部语言、隐私和构建资源做统一提审校验。
  clearAppStoreValidationErrors();
  setBusy(button, true, "提交中…");
  if (menuButton) menuButton.disabled = true;
  try {
    const payload = appStoreVersionPayload();
    const result = await window.appleDeveloper.submitAppStoreReview({
      appId: payload.appId,
      versionId: payload.versionId,
      platform: payload.platform,
      submissionId: String(options?.submissionId || ""),
      forceNewSubmission: options?.forceNewSubmission === true,
    });
    if (!result?.success) {
      showAppStoreResultErrors(result, "提交审核失败");
      return;
    }
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    openAppStoreVersionReviewDraftAfterCreate(result.reviewSubmissionId);
  } catch (error) {
    showAppStoreError(error.message || "未知错误", appStoreFieldFromAppleError(error.message), "提交审核失败");
  } finally {
    setBusy(button, false);
    if (menuButton) menuButton.disabled = false;
  }
}

async function deleteAppStoreMediaItem(kind, id) {
  if (!id || !confirm("确定删除这个媒体文件吗？")) return;
  await deleteAppStoreMedia(kind === "preview" ? [] : [id], kind === "preview" ? [id] : []);
}

async function deleteAllVisibleAppStoreMedia() {
  const buttons = Array.from(document.querySelectorAll("[data-app-media-delete]"));
  if (!buttons.length || !confirm("确定删除当前尺寸下的全部媒体文件吗？")) return;
  const screenshotIds = buttons.filter(button => button.dataset.appMediaKind !== "preview").map(button => button.dataset.appMediaDelete);
  const previewIds = buttons.filter(button => button.dataset.appMediaKind === "preview").map(button => button.dataset.appMediaDelete);
  await deleteAppStoreMedia(screenshotIds, previewIds);
}

async function deleteAppStoreMedia(screenshotIds, previewIds) {
  const main = el("app-detail-main");
  try {
    const result = await window.appleDeveloper.deleteAppStoreMedia({
      appId: currentAppStoreApp?.id || currentAppStoreDetail?.app?.id,
      screenshotIds,
      previewIds,
    });
    if (!result?.success) throw new Error(result?.error || "删除失败");
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
  } catch (error) {
    if (main) main.insertAdjacentHTML("afterbegin", `<div class="app-detail-error">删除失败：${escapeHTML(error.message || "未知错误")}</div>`);
  }
}

async function uploadVisibleAppStoreScreenshot() {
  const button = el("app-media-select-file");
  const main = el("app-detail-main");
  const appId = currentAppStoreApp?.id || currentAppStoreDetail?.app?.id;
  const localization = activeAppStoreLocalization(currentAppStoreDetail);
  if (!button || !appId || !localization.id) return;
  setBusy(button, true, "上传中…");
  try {
    const result = await window.appleDeveloper.uploadAppStoreScreenshot({
      appId,
      localizationId: localization.id,
      device: appStoreMediaDevice,
    });
    if (result?.canceled) return;
    if (result?.needsResize) {
      openAppStoreScreenshotResizeModal(result);
      return;
    }
    if (!result?.success) throw new Error(result?.error || "截图上传失败");
    updateCurrentAppStoreDetail(result.detail, { clearCache: true });
    appStoreMediaUploads = [];
    switchAppStorePane({ ...currentAppStoreApp, ...(currentAppStoreDetail?.app || {}) }, "release");
  } catch (error) {
    if (main) main.insertAdjacentHTML("afterbegin", `<div class="app-detail-error">上传失败：${escapeHTML(error.message || "未知错误")}</div>`);
  } finally {
    if (document.body.contains(button)) setBusy(button, false);
  }
}

async function refreshAppStoreAppsAfterCreate(createdApp, payload) {
  const optimisticApp = {
    id: String(createdApp?.id || ""),
    name: createdApp?.name || payload.name,
    bundleId: createdApp?.bundleId || payload.bundleId,
    primaryLocale: createdApp?.primaryLocale || payload.primaryLocale,
    sku: createdApp?.sku || payload.sku,
    ...createdApp,
  };
  if (optimisticApp.id) {
    appStoreApps = [optimisticApp, ...appStoreApps.filter(item => String(item.id) !== optimisticApp.id)];
    renderAppStoreListFromCache();
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 600));
    const refreshed = await window.appleDeveloper.appStoreApps().catch(() => null);
    if (!refreshed?.success) continue;
    const rows = refreshed.apps || [];
    const hasCreatedApp = optimisticApp.id && rows.some(item => String(item.id) === optimisticApp.id);
    appStoreApps = hasCreatedApp || !optimisticApp.id
      ? rows
      : [optimisticApp, ...rows.filter(item => String(item.id) !== optimisticApp.id)];
    renderAppStoreListFromCache();
    if (hasCreatedApp || !optimisticApp.id) return;
  }
}

async function createAppStoreApp() {
  const button = el("app-store-create-submit");
  if (!button) return;
  button.dataset.loading = "1";
  const payload = {
    platforms: appStoreCreateSelectedPlatforms(),
    platform: appStoreCreateSelectedPlatform(),
    name: el("app-store-name").value.trim(),
    primaryLocale: el("app-store-locale").value,
    bundleId: el("app-store-bundle").value.trim(),
    sku: el("app-store-sku").value.trim(),
    companyName: appStoreCreateIsOrganization === false ? "" : (el("app-store-company-name")?.value.trim() || ""),
    isOrganization: appStoreCreateIsOrganization === true,
    access: document.querySelector('input[name="app-store-access"]:checked')?.value || "full",
  };
  if (!payload.platforms.length) { el("app-store-create-error").textContent = "请选择至少一个平台"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  if (!payload.name) { el("app-store-create-error").textContent = "请输入 App 名称"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  if (!payload.primaryLocale) { el("app-store-create-error").textContent = "请选择主要语言"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  if (!payload.bundleId) { el("app-store-create-error").textContent = "请选择套装 ID"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  if (!payload.sku) { el("app-store-create-error").textContent = "请输入 SKU"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  if (appStoreCreateIsOrganization !== false && !payload.companyName) { el("app-store-create-error").textContent = "当前 Apple 账户没有可用的公司名称，请先完善法律实体信息"; delete button.dataset.loading; appStoreSyncCreateSubmitState(); return; }
  setBusy(button, true, "创建中…");
  el("app-store-create-error").textContent = "";
  try {
    if (!await ensureAppStoreTermsAccepted({ prompt: true })) {
      el("app-store-create-error").textContent = "请先同意 App Store Connect 服务条款";
      return;
    }
    const result = await window.appleDeveloper.createAppStoreApp(payload);
    if (!result?.success) throw new Error(result?.error || "App 创建失败");
    closeAppStoreCreateModal({ reset: true });
    await refreshAppStoreAppsAfterCreate(result.app, payload);
  } catch (error) {
    el("app-store-create-error").textContent = appStoreReadableError(error.message);
  } finally {
    delete button.dataset.loading;
    setBusy(button, false);
    appStoreSyncCreateSubmitState();
  }
}

function normalizeIPAAppPassword(value) {
  const compact = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "");
  if (!compact) return { value: "", error: "请输入 App 专用密码" };
  if (!/^[A-Za-z0-9]+$/.test(compact)) return { value: "", error: "专用密码只能包含英文字母和数字" };
  if (compact.length !== 16) return { value: "", error: "专用密码长度必须是 16 位" };
  return { value: compact.toLowerCase().match(/.{1,4}/g).join("-") };
}

function formatIPAAppPasswordInput(input) {
  if (!input) return;
  const compact = String(input.value || "").replace(/\s+/g, "").replace(/-/g, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16).toLowerCase();
  input.value = compact.match(/.{1,4}/g)?.join("-") || "";
}

function insertIPAAppPasswordPaste(input, pastedText) {
  if (!input) return;
  const value = String(input.value || "");
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  input.value = value.slice(0, start) + String(pastedText || "") + value.slice(end);
  formatIPAAppPasswordInput(input);
}

function setIPAAppPasswordField(value) {
  const input = el("ipa-upload-password");
  if (!input) return;
  const normalized = normalizeIPAAppPassword(value);
  input.value = normalized.value || String(value || "").trim();
}

function setIPAUploadStartState(running, label = "开始上传") {
  const button = el("ipa-upload-start");
  if (!button) return;
  setBusy(button, !!running, running ? label : undefined);
  button.disabled = !!running;
  if (el("ipa-upload-choose")) el("ipa-upload-choose").disabled = !!running;
  if (el("ipa-upload-check-apple")) el("ipa-upload-check-apple").disabled = !!running;
  if (el("ipa-upload-validate")) el("ipa-upload-validate").disabled = !!running;
  if (el("ipa-upload-provider")) el("ipa-upload-provider").disabled = !!running;
  if (el("ipa-upload-description-choose")) el("ipa-upload-description-choose").disabled = !!running;
}

function setIPAUploadAIState(show, text = "AI 解析") {
  const button = el("ipa-upload-ai-parse");
  if (!button) return;
  button.classList.toggle("hidden", !show);
  button.disabled = !!ipaUploadAnalysisDialogBusy;
  button.textContent = text;
}

function setIPAUploadErrorCopyState() {
  const button = el("ipa-upload-copy-error");
  const hasErrors = !!el("ipa-upload-log")?.querySelector(".error");
  if (!button) return;
  button.classList.toggle("hidden", !hasErrors);
  button.disabled = !hasErrors;
  if (!hasErrors) {
    button.classList.remove("copied");
    button.querySelector("span").textContent = "复制报错";
    button.title = "";
  }
}

function syncIPAUploadControls() {
  setIPAUploadStartState(ipaUploadTaskRunning, "上传中…");
  setIPAUploadAIState(!!ipaUploadLastError && !ipaUploadTaskRunning);
  setIPAUploadErrorCopyState();
}

function clearIPAUploadFailureState() {
  ipaUploadLastError = "";
  ipaUploadLastFailureTask = null;
  ipaUploadLastTaskEvents = [];
  setIPAUploadAIState(false);
}

function setIPAUploadFailureState(message, task = null, events = []) {
  ipaUploadLastError = String(message || "").trim();
  ipaUploadLastFailureTask = task || null;
  ipaUploadLastTaskEvents = Array.isArray(events) ? events.slice(-30) : [];
  setIPAUploadAIState(!!ipaUploadLastError);
}

function renderIPAUploadPage() {
  const page = el("page-ipa-upload");
  page.innerHTML = `<div class="ipa-upload-layout">
    <section class="ipa-upload-card" id="ipa-upload-form">
      <h2>上传 IPA 到 App Store Connect</h2>
      <p class="ipa-upload-intro">通过软件内置的苹果上传组件提交，完整显示苹果的校验错误。账号有多个上传团队时，需要选择 IPA 所属团队。</p>
      <div class="field"><label>IPA 文件</label><div class="ipa-file-row"><div class="ipa-file-path" id="ipa-upload-file-path">请选择 .ipa 文件</div><button class="secondary" id="ipa-upload-choose" type="button">选择文件</button></div></div>
      <div class="field hidden" id="ipa-upload-description-field"><label>AppStoreInfo.plist</label><div class="ipa-file-row"><div class="ipa-file-path" id="ipa-upload-description-path">请选择与 IPA 同次导出的文件</div><button class="secondary" id="ipa-upload-description-choose" type="button">选择描述文件</button></div><div class="field-note">Windows 需要打包时一同导出的 AppStoreInfo.plist。上传环境已内置，无需安装 Xcode、Python 或 Java。</div></div>
      <div class="ipa-upload-grid">
        <div class="field"><label>Apple ID</label><input id="ipa-upload-apple-id" class="account-locked-input" autocomplete="username" value="${escapeHTML(launchAppleId)}" placeholder="name@example.com" readonly aria-readonly="true"><div class="field-note">当前账户 Apple ID 已锁定，不可修改</div></div>
        <div class="field"><label>App 专用密码</label><div class="ipa-password-row"><input id="ipa-upload-password" type="text" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx" readonly aria-readonly="true"><button class="secondary ipa-password-edit" id="ipa-app-password-edit" type="button">修改</button></div><div class="field-note">已保存在本机安全存储中，上传时自动使用</div></div>
      </div>
      <div class="ipa-upload-note"><span>这里需要的是 Apple ID 的“App 专用密码”，不是 Apple ID 登录密码。App 专用密码会使用系统安全存储加密保存在本机，不会写入上传日志。</span><button class="secondary" id="ipa-app-password-setup" type="button">从 Apple 账户创建</button></div>
      <div class="ipa-upload-env" id="ipa-upload-network-info">正在识别当前账户登录网络…</div>
      <div class="ipa-upload-env" id="ipa-upload-env">正在检测上传环境…</div>
      <div class="field hidden" id="ipa-upload-provider-field"><label for="ipa-upload-provider">苹果上传团队</label><select id="ipa-upload-provider"><option value="">请选择 IPA 所属的上传团队</option></select></div>
      <div class="ipa-upload-actions"><button class="secondary" id="ipa-upload-validate" type="button">读取 IPA 信息</button><button class="secondary" id="ipa-upload-check-apple" type="button">查询苹果处理结果</button><button class="primary" id="ipa-upload-start" type="button">开始上传</button></div>
    </section>
    <section class="ipa-upload-card">
      <div class="ipa-log-head"><h2>上传日志</h2><span class="ipa-task-state" id="ipa-upload-task-state">待上传</span></div>
      <div class="ipa-build-summary" id="ipa-upload-metadata">选择 IPA 后显示实际 Bundle ID、版本号和 Build。</div>
      <div class="ipa-apple-feedback" id="ipa-upload-apple-feedback" role="status">文件提交后会继续核对苹果处理状态，也可查询已经上传的包。</div>
      <div class="ipa-upload-log" id="ipa-upload-log"><div class="ipa-upload-empty">选择 IPA 并开始上传后，进度会显示在这里。</div></div>
      <div class="ipa-log-actions">
        <button class="secondary hidden" id="ipa-upload-open-testflight" type="button">打开对应 TestFlight</button>
        <button class="secondary ipa-log-copy hidden" id="ipa-upload-copy-error" type="button" disabled aria-label="复制红色报错内容">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>
          <span>复制报错</span>
        </button>
        <button class="secondary hidden" id="ipa-upload-ai-parse" type="button">AI 解析上传错误</button>
      </div>
    </section>
  </div>`;
  el("ipa-upload-choose").addEventListener("click", chooseIPAUploadFile);
  el("ipa-upload-description-choose").addEventListener("click", async () => {
    if (ipaUploadTaskRunning || ipaUploadStartPending) return;
    const result = await window.uploader.selectDescription();
    if (!result || result.canceled || ipaUploadTaskRunning || ipaUploadStartPending) return;
    selectedIPAUploadDescriptionPath = result.path || "";
    el("ipa-upload-description-path").textContent = result.filename || "请选择与 IPA 同次导出的文件";
  });
  el("ipa-app-password-edit").addEventListener("click", openIPAAppPasswordEdit);
  el("ipa-app-password-setup").addEventListener("click", openIPAAppPasswordSetup);
  el("ipa-upload-start").addEventListener("click", () => startIPAUploadFromCertificateManager());
  el("ipa-upload-validate").addEventListener("click", () => startIPAUploadFromCertificateManager({ validateOnly: true }));
  el("ipa-upload-check-apple").addEventListener("click", checkIPAUploadAppleState);
  el("ipa-upload-open-testflight").addEventListener("click", openIPAUploadTestFlight);
  el("ipa-upload-copy-error").addEventListener("click", copyIPAUploadErrorLog);
  el("ipa-upload-ai-parse").addEventListener("click", openIPAUploadAnalysisDialog);
  refreshIPAUploadNetwork();
  refreshIPAUploadEnvironment();
  syncIPAUploadControls();
  if (activeIPAUploadTaskId) { renderedIPAUploadEventCount = 0; startIPAUploadPolling(); }
}

function populateIPAUploadProxyOptions() {
  const select = el("ipa-upload-proxy");
  if (!select) return;
  select.replaceChildren(new Option(proxyRows.length ? "请选择代理" : "代理池暂无可用代理", ""));
  proxyRows.forEach((proxy, index) => select.add(new Option(`${proxy.note || proxy.name || "代理"} · ${proxy.host}:${proxy.port}`, String(index))));
}

async function refreshIPAUploadEnvironment() {
  const status = el("ipa-upload-env");
  if (!status || !window.uploader) return;
  try {
    const result = await window.uploader.transporterStatus();
    el("ipa-upload-description-field")?.classList.toggle("hidden", !result?.requiresAssetDescription);
    status.textContent = result?.available ? "上传环境可用 · 软件内置安全上传组件" : "上传环境不可用：软件内置上传组件不完整";
    status.style.color = result?.available ? "#16803c" : "#dc2626";
  } catch (error) {
    status.textContent = `上传环境检测失败：${error.message}`;
    status.style.color = "#dc2626";
  }
}

async function refreshIPAUploadNetwork() {
  const info = el("ipa-upload-network-info");
  if (!info) return;
  try {
    const context = await window.appleDeveloper.uploadContext();
    if (context?.appleId && el("ipa-upload-apple-id")) {
      el("ipa-upload-apple-id").value = context.appleId;
      el("ipa-upload-apple-id").readOnly = true;
      el("ipa-upload-apple-id").setAttribute("aria-readonly", "true");
    }
    if (context?.appPassword) setIPAAppPasswordField(context.appPassword);
    info.textContent = `上传网络已自动跟随该账户登录网络 · ${context?.proxyLabel || "本机网络直连"}`;
    info.style.color = "#2563eb";
  } catch (error) {
    info.textContent = `账户登录网络识别失败：${error.message}`;
    info.style.color = "#dc2626";
  }
}

function ensureIPAAppPasswordEditDialog() {
  if (el("ipa-app-password-edit-mask")) return;
  const mask = document.createElement("div");
  mask.id = "ipa-app-password-edit-mask";
  mask.className = "mask";
  mask.innerHTML = `<div class="dialog ipa-app-password-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="ipa-app-password-edit-title">
    <div class="dialog-head"><span id="ipa-app-password-edit-title">修改 App 专用密码</span><button id="ipa-app-password-edit-close" type="button" aria-label="关闭">×</button></div>
    <div class="dialog-body">
      <div class="field"><label for="ipa-app-password-edit-value">App 专用密码</label><input id="ipa-app-password-edit-value" type="text" autocomplete="off" spellcheck="false" inputmode="text" maxlength="19" placeholder="xxxx-xxxx-xxxx-xxxx"><div class="field-note">请输入 16 位英文字母或数字，格式为 xxxx-xxxx-xxxx-xxxx</div></div>
      <div class="error" id="ipa-app-password-edit-error"></div>
      <div class="actions"><button class="secondary" id="ipa-app-password-edit-cancel" type="button">取消</button><button class="primary" id="ipa-app-password-edit-save" type="button">保存</button></div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.classList.remove("show");
  el("ipa-app-password-edit-close").addEventListener("click", close);
  el("ipa-app-password-edit-cancel").addEventListener("click", close);
  mask.addEventListener("click", event => { if (event.target === mask) close(); });
  el("ipa-app-password-edit-value").addEventListener("input", event => {
    formatIPAAppPasswordInput(event.target);
    el("ipa-app-password-edit-error").textContent = "";
  });
  el("ipa-app-password-edit-value").addEventListener("paste", event => {
    const text = event.clipboardData?.getData("text/plain") || event.clipboardData?.getData("text") || "";
    if (!text) return;
    event.preventDefault();
    insertIPAAppPasswordPaste(event.currentTarget, text);
    el("ipa-app-password-edit-error").textContent = "";
  });
  el("ipa-app-password-edit-save").addEventListener("click", saveIPAAppPasswordEdit);
}

function openIPAAppPasswordEdit() {
  ensureIPAAppPasswordEditDialog();
  const input = el("ipa-app-password-edit-value");
  input.value = el("ipa-upload-password")?.value || "";
  el("ipa-app-password-edit-error").textContent = "";
  el("ipa-app-password-edit-mask").classList.add("show");
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

async function saveIPAAppPasswordEdit() {
  const input = el("ipa-app-password-edit-value");
  const error = el("ipa-app-password-edit-error");
  const normalized = normalizeIPAAppPassword(input?.value);
  if (normalized.error) { error.textContent = normalized.error; return; }
  const button = el("ipa-app-password-edit-save");
  setBusy(button, true, "保存中…");
  error.textContent = "";
  try {
    const saved = await window.appleDeveloper.saveAppPasswordLocal(normalized.value);
    if (!saved?.success) throw new Error(saved?.error || "App 专用密码保存失败");
    setIPAAppPasswordField(normalized.value);
    el("ipa-app-password-edit-mask").classList.remove("show");
    appendIPAUploadLog("success", "App 专用密码已保存到本机安全存储。");
  } catch (errorValue) {
    error.textContent = errorValue.message || "App 专用密码保存失败";
  } finally { setBusy(button, false); }
}

function ensureIPAUploadAnalysisDialog() {
  if (el("ipa-upload-ai-mask")) return;
  const mask = document.createElement("div");
  mask.id = "ipa-upload-ai-mask";
  mask.className = "mask ipa-upload-ai-mask";
  mask.innerHTML = `<div class="dialog ipa-upload-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ipa-upload-ai-title">
    <div class="dialog-head"><span id="ipa-upload-ai-title">AI 解析上传错误</span><button id="ipa-upload-ai-close" type="button" aria-label="关闭">×</button></div>
    <div class="dialog-body">
      <div class="ipa-upload-ai-loading" id="ipa-upload-ai-loading"><i class="loading-spinner"></i><span id="ipa-upload-ai-status">正在解析…</span></div>
      <div class="ipa-upload-ai-result hidden" id="ipa-upload-ai-result"></div>
      <div class="error" id="ipa-upload-ai-error"></div>
      <div class="actions">
        <button class="primary hidden" id="ipa-upload-ai-retry" type="button">重新解析</button>
        <button class="secondary ipa-upload-ai-copy hidden" id="ipa-upload-ai-copy" type="button" disabled aria-label="复制 AI 反馈内容">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path></svg>
          <span>复制内容</span>
        </button>
        <button class="secondary" id="ipa-upload-ai-close-foot" type="button">关闭</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.classList.remove("show");
  el("ipa-upload-ai-close").addEventListener("click", close);
  el("ipa-upload-ai-close-foot").addEventListener("click", close);
  mask.addEventListener("click", event => { if (event.target === mask) close(); });
  el("ipa-upload-ai-retry").addEventListener("click", runIPAUploadAIAnalysis);
  el("ipa-upload-ai-copy").addEventListener("click", copyIPAUploadAIResult);
}

async function writeIPAClipboardText(value) {
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (_error) {}
  }
  if (!copied) {
    const input = document.createElement("textarea");
    input.value = value;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("剪贴板写入失败");
  }
}

async function copyIPAUploadErrorLog() {
  const log = el("ipa-upload-log");
  const button = el("ipa-upload-copy-error");
  const label = button?.querySelector("span");
  const value = Array.from(log?.querySelectorAll(".error") || [])
    .map(row => String(row.textContent || ""))
    .filter(Boolean)
    .join("\n");
  if (!button || !label || !value) return;
  button.disabled = true;
  button.title = "";
  try {
    await writeIPAClipboardText(value);
    label.textContent = "已复制";
    button.classList.add("copied");
  } catch (error) {
    label.textContent = "复制失败";
    button.title = error?.message || "无法写入剪贴板";
  }
  window.setTimeout(() => {
    label.textContent = "复制报错";
    button.classList.remove("copied");
    setIPAUploadErrorCopyState();
  }, 1600);
}

async function copyIPAUploadAIResult() {
  const resultBox = el("ipa-upload-ai-result");
  const button = el("ipa-upload-ai-copy");
  const label = button?.querySelector("span");
  const value = String(resultBox?.textContent || "");
  if (!button || !label || !value || resultBox.classList.contains("hidden")) return;
  button.disabled = true;
  button.title = "";
  try {
    await writeIPAClipboardText(value);
    label.textContent = "已复制";
    button.classList.add("copied");
  } catch (error) {
    label.textContent = "复制失败";
    button.title = error?.message || "无法写入剪贴板";
  }
  window.setTimeout(() => {
    label.textContent = "复制内容";
    button.classList.remove("copied");
    button.disabled = resultBox.classList.contains("hidden");
  }, 1600);
}

async function openIPAUploadAnalysisDialog() {
  ensureIPAUploadAnalysisDialog();
  const mask = el("ipa-upload-ai-mask");
  mask.classList.add("show");
  el("ipa-upload-ai-error").textContent = "";
  el("ipa-upload-ai-result").classList.add("hidden");
  el("ipa-upload-ai-loading").classList.remove("hidden");
  el("ipa-upload-ai-retry").classList.add("hidden");
  el("ipa-upload-ai-copy").classList.add("hidden");
  el("ipa-upload-ai-copy").disabled = true;
  el("ipa-upload-ai-status").textContent = "正在解析…";
  ipaUploadAnalysisDialogBusy = true;
  setIPAUploadAIState(true, "AI 解析");
  await runIPAUploadAIAnalysis();
}

async function runIPAUploadAIAnalysis() {
  const status = el("ipa-upload-ai-status");
  const loading = el("ipa-upload-ai-loading");
  const resultBox = el("ipa-upload-ai-result");
  const errorBox = el("ipa-upload-ai-error");
  const retryButton = el("ipa-upload-ai-retry");
  const copyButton = el("ipa-upload-ai-copy");
  if (!status || !loading || !resultBox) return;
  ipaUploadAnalysisDialogBusy = true;
  setIPAUploadAIState(true, "AI 解析");
  loading.classList.remove("hidden");
  resultBox.classList.add("hidden");
  errorBox.textContent = "";
  retryButton.classList.add("hidden");
  retryButton.disabled = true;
  copyButton.classList.add("hidden");
  copyButton.disabled = true;
  copyButton.title = "";
  copyButton.querySelector("span").textContent = "复制内容";
  copyButton.classList.remove("copied");
  const analysisPayload = {
    taskId: ipaUploadLastFailureTask?.taskId || activeIPAUploadTaskId || "",
    errorMessage: ipaUploadLastError || "上传失败",
    appleId: el("ipa-upload-apple-id")?.value?.trim() || "",
    ipaName: selectedIPAUploadPath ? selectedIPAUploadPath.split(/[\\/]/).pop() : "",
    events: ipaUploadLastTaskEvents,
  };
  try {
    const response = await window.uploader.analyzeUploadError(analysisPayload);
    if (!response?.success) throw new Error(response?.error || "AI 解析失败");
    loading.classList.add("hidden");
    resultBox.textContent = response.analysis || "未返回分析结果";
    resultBox.classList.remove("hidden");
    status.textContent = "解析完成";
    retryButton.classList.remove("hidden");
    retryButton.disabled = false;
    copyButton.classList.remove("hidden");
    copyButton.disabled = false;
  } catch (error) {
    loading.classList.add("hidden");
    errorBox.textContent = error.message || "AI 解析失败";
    status.textContent = "解析失败";
    retryButton.classList.remove("hidden");
    retryButton.disabled = false;
  } finally {
    ipaUploadAnalysisDialogBusy = false;
    setIPAUploadAIState(true, "AI 解析");
  }
}

function ensureAppPasswordDialog() {
  if (el("app-password-mask")) return;
  const mask = document.createElement("div");
  mask.id = "app-password-mask";
  mask.className = "mask";
  mask.innerHTML = `<div class="dialog" style="width:520px">
    <div class="dialog-head">设置 App 专用密码<button id="app-password-close" type="button">×</button></div>
    <div class="dialog-body" style="padding-top:20px">
      <div class="ipa-upload-note" style="margin-bottom:16px"><span id="app-password-status">正在准备 Apple Account 接口会话…</span></div>
      <div id="app-password-verify-fields" class="hidden">
        <div class="section-title">安全验证方式</div>
        <div class="method-cards">
          <label class="method-card"><input type="radio" name="app-password-method" value="device" checked><span><strong>受信任设备</strong><small>使用 Apple 设备上显示的验证码</small></span></label>
          <label class="method-card"><input type="radio" name="app-password-method" value="sms"><span><strong>短信验证</strong><small>发送验证码到受信任手机号</small></span></label>
        </div>
        <div class="field"><label>6 位验证码</label><input id="app-password-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="请输入验证码"></div>
      </div>
      <div id="app-password-create-fields" class="hidden">
        <div class="field"><label>专用密码备注</label><input id="app-password-description" maxlength="50" value="IPAUploader" placeholder="例如：IPAUploader"></div>
      </div>
      <div class="error" id="app-password-error"></div>
      <div class="actions"><button class="secondary" id="app-password-cancel" type="button">取消</button><button class="primary" id="app-password-next" type="button" disabled>请稍候…</button></div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.classList.remove("show");
  el("app-password-close").addEventListener("click", close);
  el("app-password-cancel").addEventListener("click", close);
  el("app-password-next").addEventListener("click", advanceAppPasswordDialog);
  mask.querySelectorAll('input[name="app-password-method"]').forEach(input => input.addEventListener("change", async event => {
    if (event.target.value !== "sms" || !event.target.checked) return;
    el("app-password-error").textContent = "";
    el("app-password-status").textContent = "正在发送短信验证码…";
    const result = await window.appleDeveloper.chooseAppPasswordMethod("sms");
    if (!result?.success) el("app-password-error").textContent = result?.error || "短信验证码发送失败";
    else el("app-password-status").textContent = "短信验证码已发送，请输入 6 位验证码。";
  }));
}

function setAppPasswordDialogStage(stage, status) {
  ensureAppPasswordDialog();
  el("app-password-verify-fields").classList.toggle("hidden", stage !== "verify");
  el("app-password-create-fields").classList.toggle("hidden", stage !== "create");
  el("app-password-status").textContent = status;
  const next = el("app-password-next");
  next.dataset.stage = stage;
  next.disabled = stage === "loading";
  next.textContent = stage === "verify" ? "发送并验证" : stage === "create" ? "创建并自动填入" : "请稍候…";
}

async function openIPAAppPasswordSetup() {
  const button = el("ipa-app-password-setup");
  ensureAppPasswordDialog();
  el("app-password-mask").classList.add("show");
  el("app-password-error").textContent = "";
  setAppPasswordDialogStage("loading", "正在通过接口登录 Apple Account…");
  setBusy(button, true, "正在连接…");
  try {
    appendIPAUploadLog("info", "正在通过接口登录 Apple Account…");
    const result = await window.appleDeveloper.openAppPasswordSetup({ clientFingerprint: generateAppleClientFingerprint() });
    if (!result?.success) throw new Error(result?.error || "Apple Account 登录失败");
    if (result.requires2FA) setAppPasswordDialogStage("verify", "Apple Account 登录成功，请完成安全验证。");
    else {
      appendIPAUploadLog("success", "Apple Account 接口会话已就绪。");
      setAppPasswordDialogStage("create", "Apple Account 接口会话已就绪，请设置备注。");
    }
  } catch (error) {
    appendIPAUploadLog("error", error.message);
    el("app-password-error").textContent = error.message;
    setAppPasswordDialogStage("loading", "Apple Account 接口连接失败");
  } finally { setBusy(button, false); }
}

async function advanceAppPasswordDialog() {
  const next = el("app-password-next");
  const stage = next.dataset.stage;
  el("app-password-error").textContent = "";
  if (stage === "verify") {
    const code = el("app-password-code").value.trim();
    if (!/^\d{6}$/.test(code)) { el("app-password-error").textContent = "请输入有效的 6 位验证码"; return; }
    const method = document.querySelector('input[name="app-password-method"]:checked')?.value || "device";
    setBusy(next, true, "正在验证…");
    try {
      if (method === "device") {
        const methodResult = await window.appleDeveloper.chooseAppPasswordMethod("device");
        if (!methodResult?.success) throw new Error(methodResult?.error || "设备验证准备失败");
      }
      const verified = await window.appleDeveloper.verifyAppPasswordCode(code);
      if (!verified?.success) throw new Error(verified?.error || "验证码校验失败");
      appendIPAUploadLog("success", "Apple Account 安全验证通过。");
      setAppPasswordDialogStage("create", "验证成功，请设置专用密码备注。");
    } catch (error) { el("app-password-error").textContent = error.message; }
    finally { if (next.dataset.stage === "verify") setBusy(next, false); }
    return;
  }
  if (stage === "create") {
    const description = el("app-password-description").value.trim();
    if (!description) { el("app-password-error").textContent = "请输入专用密码备注"; return; }
    setBusy(next, true, "正在创建…");
    try {
      const created = await window.appleDeveloper.createAppPassword({ description });
      if (!created?.success) throw new Error(created?.error || "App 专用密码创建失败");
      const normalized = normalizeIPAAppPassword(created.password);
      if (normalized.error) throw new Error(normalized.error);
      setIPAAppPasswordField(normalized.value);
      const saved = await window.appleDeveloper.saveAppPasswordLocal(normalized.value);
      if (!saved?.success) throw new Error(saved?.error || "App 专用密码已创建，但本机保存失败");
      appendIPAUploadLog("success", `App 专用密码“${created.description || description}”已创建并自动回填。`);
      el("app-password-mask").classList.remove("show");
    } catch (error) { el("app-password-error").textContent = error.message; }
    finally { setBusy(next, false); }
  }
}

async function chooseIPAUploadFile() {
  if (ipaUploadTaskRunning || ipaUploadStartPending) return;
  const result = await window.uploader.selectIPA();
  if (ipaUploadTaskRunning || ipaUploadStartPending) return;
  if (!result || result.canceled) return;
  selectedIPAUploadPath = result.path || "";
  selectedIPAUploadDescriptionPath = "";
  if (el("ipa-upload-description-path")) el("ipa-upload-description-path").textContent = "请选择与 IPA 同次导出的文件";
  activeIPAUploadTaskId = "";
  if (ipaUploadPollTimer) clearInterval(ipaUploadPollTimer);
  ipaUploadPollTimer = null;
  el("ipa-upload-file-path").textContent = result.filename || selectedIPAUploadPath;
  el("ipa-upload-file-path").title = selectedIPAUploadPath;
  renderIPAUploadAppleFeedback({ metadata: result.metadata });
  el("ipa-upload-task-state").textContent = "待上传或查询";
  el("ipa-upload-task-state").style.color = "#64748b";
  if (result.metadataError) appendIPAUploadLog("error", result.metadataError);
}

function renderIPAUploadAppleFeedback(task = {}) {
  const metadata = task.metadata;
  const summary = el("ipa-upload-metadata");
  if (summary) summary.textContent = metadata ? `Bundle ID：${metadata.bundleId} · 版本：${metadata.version} · Build：${metadata.build}` : "选择 IPA 后显示实际 Bundle ID、版本号和 Build。";
  const apple = task.appleState;
  const details = [];
  if (apple?.app) details.push(`对应 App：${apple.app.name || apple.app.id}（${apple.app.bundleId || metadata?.bundleId || ""}）`);
  if (apple?.reason) details.push(apple.reason);
  if (apple?.errors?.length) details.push(...apple.errors);
  if (apple?.checkedAt) details.push(`最近核对：${new Date(apple.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`);
  if (task.receiptBuildId) details.push(`苹果构建回执：${task.receiptBuildId}`);
  if (task.status === "submitted" && !details.length) details.push(task.deliveryConfirmed ? "文件已提交，正在等待苹果返回对应构建的处理结果。" : "正在查询这个包的苹果处理结果，本次操作不会重新上传。");
  if (task.status === "processing") details.unshift("苹果仍在处理构建，处理通过前不能确认 TestFlight 可用。");
  if (task.status === "success" && task.statusText !== "TestFlight 内部测试可用") details.unshift("苹果已确认构建处理完成，测试可用性请以 TestFlight 具体状态为准。");
  if (task.validatedOnly) details.unshift("IPA 信息已读取。本次未提交苹果校验或上传。");
  if (task.duplicateDelivery) details.unshift("苹果提示该文件此前已经上传，本次未确认生成新构建。请以对应版本和 Build 的苹果处理结果为准。");
  const providerSelect = el("ipa-upload-provider");
  if (providerSelect && task.providerChoices?.length) {
    const selected = providerSelect.value;
    providerSelect.innerHTML = '<option value="">请选择 IPA 所属的上传团队</option>' + task.providerChoices.map(provider => `<option value="${escapeHTML(provider)}">${escapeHTML(provider)}</option>`).join("");
    providerSelect.value = selected;
    el("ipa-upload-provider-field")?.classList.remove("hidden");
  }
  const feedback = el("ipa-upload-apple-feedback");
  if (feedback) feedback.textContent = details.join("\n") || "文件提交后会继续核对苹果处理状态，也可查询已经上传的包。";
  const openButton = el("ipa-upload-open-testflight");
  if (openButton) {
    openButton.classList.toggle("hidden", !task.testflightUrl);
    openButton.dataset.url = task.testflightUrl || "";
    openButton.dataset.taskId = task.id || "";
  }
}

async function openIPAUploadTestFlight() {
  const button = el("ipa-upload-open-testflight");
  if (!button || button.disabled) return;
  button.disabled = true;
  const navigationToken = pageSwitchToken;
  try {
    if (!authenticated || appleLoginInProgress) throw new Error("请先登录上传时使用的 Apple 账户");
    const result = await window.appleDeveloper.ipaUploadTestFlightApp(button.dataset.taskId);
    if (navigationToken !== pageSwitchToken || !button.isConnected) return;
    if (!result?.success) throw new Error(result?.error || "无法读取上传对应的 App");
    // Build the App host without triggering unrelated list/bootstrap requests.
    if (!el("apps-capture-ready")) renderAppsPage({ prepare: false });
    await showPage("apps");
    if (pageSwitchToken !== navigationToken + 1 || !authenticated || !el("app-store-content")) return;
    ++appStoreDetailRequestSeq;
    closeAppStoreDetailLoading();
    const app = appStoreApps.find(item => String(item.id) === String(result.app.id)) || result.app;
    currentAppStoreApp = app;
    currentAppStoreDetail = { app, partial: true, testFlightContextToken: result.contextToken, appsListPartial: !appStoreApps.length, selectedVersion: { platform: result.platform || "IOS" }, versions: [...(app.versions || []), { platform: result.platform || "IOS" }] };
    currentInAppPurchases = null; currentInAppPurchaseDetail = null;
    currentReviewSubmissionDetail = null; currentReviewSubmissionLoadingId = "";
    if (!appStoreApps.some(item => String(item.id) === String(app.id))) appStoreApps.push(app);
    switchAppStorePane(app, "testflight");
  } catch (error) { showAppStoreError(error.message || "TestFlight 打开失败", "", "无法打开对应 TestFlight"); }
  finally { if (button.isConnected) button.disabled = false; }
}

function startIPAUploadPolling() {
  if (ipaUploadPollTimer) clearInterval(ipaUploadPollTimer);
  ipaUploadPollTimer = setInterval(pollIPAUploadFromCertificateManager, 1200);
  pollIPAUploadFromCertificateManager();
}

async function checkIPAUploadAppleState() {
  if (ipaUploadTaskRunning || ipaUploadStartPending) return;
  const requestedPath = selectedIPAUploadPath;
  const requestedTaskId = activeIPAUploadTaskId;
  if (!selectedIPAUploadPath && !activeIPAUploadTaskId) { appendIPAUploadLog("error", "请先选择要核对的 IPA 文件"); return; }
  const button = el("ipa-upload-check-apple");
  setBusy(button, true, "正在查询…");
  try {
    const result = await window.uploader.checkAppleState({ taskId: activeIPAUploadTaskId, ipaPath: selectedIPAUploadPath, appleId: el("ipa-upload-apple-id")?.value.trim() || launchAppleId });
    if (selectedIPAUploadPath !== requestedPath || activeIPAUploadTaskId !== requestedTaskId || ipaUploadStartPending || ipaUploadTaskRunning) return;
    if (!result?.taskId || result.error) throw new Error(result?.error || "苹果处理结果查询启动失败");
    if (activeIPAUploadTaskId !== result.taskId) {
      activeIPAUploadTaskId = result.taskId;
      renderedIPAUploadEventCount = 0;
      clearIPAUploadFailureState();
    }
    renderIPAUploadAppleFeedback({ metadata: result.metadata });
    startIPAUploadPolling();
  } catch (error) { appendIPAUploadLog("error", error.message || "苹果处理结果查询失败"); }
  finally { setBusy(button, false); }
}

function appendIPAUploadLog(level, message, time = "") {
  const log = el("ipa-upload-log");
  if (!log) return;
  log.querySelector(".ipa-upload-empty")?.remove();
  const row = document.createElement("div");
  row.className = level || "info";
  row.textContent = `${time ? `[${time}] ` : ""}${message || ""}`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  setIPAUploadErrorCopyState();
}

async function startIPAUploadFromCertificateManager({ validateOnly = false } = {}) {
  if (ipaUploadTaskRunning || ipaUploadStartPending) return;
  const button = el("ipa-upload-start");
  clearIPAUploadFailureState();
  const appleId = el("ipa-upload-apple-id").value.trim();
  const password = el("ipa-upload-password").value;
  if (!selectedIPAUploadPath) { appendIPAUploadLog("error", "请先选择 IPA 文件"); return; }
  if (!appleId) { appendIPAUploadLog("error", "当前 Apple ID 未加载完成，请稍后再试"); return; }
  const normalized = validateOnly ? { value: "" } : normalizeIPAAppPassword(password);
  if (normalized.error) { appendIPAUploadLog("error", normalized.error); return; }
  ipaUploadStartPending = true;
  activeIPAUploadTaskId = "";
  if (ipaUploadPollTimer) clearInterval(ipaUploadPollTimer);
  ipaUploadPollTimer = null;
  el("ipa-upload-log").replaceChildren();
  setIPAUploadErrorCopyState();
  renderedIPAUploadEventCount = 0;
  appendIPAUploadLog("info", validateOnly ? "正在读取 IPA 信息，本次不会提交苹果校验或上传…" : "正在准备 IPA，随后使用该账户登录网络提交苹果校验及上传…");
  setIPAUploadStartState(true, "启动中…");
  try {
    if (!validateOnly) {
      const saved = await window.appleDeveloper.saveAppPasswordLocal(normalized.value);
      if (!saved?.success) throw new Error(saved?.error || "App 专用密码保存失败");
    }
    const result = await window.uploader.start({
      ipaPath: selectedIPAUploadPath,
      assetDescriptionPath: selectedIPAUploadDescriptionPath,
      appleId,
      password: normalized.value,
      useAppleDeveloperProxy: true,
      validateOnly,
      ascProvider: el("ipa-upload-provider")?.value || "",
    });
    if (result?.error) throw new Error(result.error);
    activeIPAUploadTaskId = result.taskId;
    ipaUploadTaskRunning = true;
    el("ipa-upload-task-state").textContent = "正在读取 IPA 信息";
    el("ipa-upload-task-state").style.color = "#2563eb";
    setIPAUploadStartState(true, "正在读取 IPA 信息…");
    startIPAUploadPolling();
  } catch (error) {
    appendIPAUploadLog("error", error.message);
    setIPAUploadFailureState(error.message);
    el("ipa-upload-task-state").textContent = validateOnly ? "IPA 信息未读取完成" : "未开始上传";
    el("ipa-upload-task-state").style.color = "#dc2626";
    setIPAUploadStartState(false);
  } finally { ipaUploadStartPending = false; }
}

async function pollIPAUploadFromCertificateManager() {
  if (!activeIPAUploadTaskId || ipaUploadPollInFlight) return;
  const taskId = activeIPAUploadTaskId;
  ipaUploadPollInFlight = true;
  try {
    const task = await window.uploader.status(taskId);
    if (taskId !== activeIPAUploadTaskId) return;
    if (task?.error && !task.events) throw new Error(task.error);
    const events = Array.isArray(task.events) ? task.events : [];
    events.slice(renderedIPAUploadEventCount).forEach(event => appendIPAUploadLog(event.level, event.message, event.time));
    renderedIPAUploadEventCount = events.length;
    ipaUploadLastTaskEvents = events;
    const state = el("ipa-upload-task-state");
    state.textContent = task.statusText || (task.status === "error" ? "上传失败" : task.status === "running" ? "上传中" : "处理结果未确认");
    state.style.color = ({ success: "#16803c", error: "#dc2626", warning: "#9a6700", info: "#2563eb" })[task.statusLevel] || "#64748b";
    renderIPAUploadAppleFeedback(task);
    if (task.status === "error" || task.status === "processing_error") {
      const lastError = [...events].reverse().find(event => event.level === "error")?.message || task.error || "上传失败";
      setIPAUploadFailureState(lastError, task, events);
    } else if (task.status !== "running") clearIPAUploadFailureState();
    ipaUploadTaskRunning = task.status === "running";
    setIPAUploadStartState(ipaUploadTaskRunning || ipaUploadStartPending, task.stage === "inspection" ? "正在读取 IPA 信息…" : task.stage === "provider" ? "查询上传团队…" : "苹果校验及上传中…");
    if (ipaUploadTaskRunning) {
      setIPAUploadAIState(false);
    }
    if (task.status !== "running" && !task.monitorActive) {
      if (ipaUploadPollTimer) clearInterval(ipaUploadPollTimer);
      ipaUploadPollTimer = null;
    }
  } catch (error) {
    if (taskId !== activeIPAUploadTaskId) return;
    appendIPAUploadLog("error", error.message);
    el("ipa-upload-task-state").textContent = "状态读取失败";
    if (ipaUploadPollTimer) clearInterval(ipaUploadPollTimer);
    ipaUploadPollTimer = null;
  } finally { ipaUploadPollInFlight = false; }
}

function automationLog(message, state = "") {
  const log = el("automation-log");
  if (!log) return;
  const row = document.createElement("div");
  row.className = state;
  row.textContent = message;
  log.appendChild(row);
  row.scrollIntoView({ block: "nearest" });
}

function renderAutomationDevices(devices = []) {
  const box = el("automation-devices");
  if (!box) return;
  box.innerHTML = devices.length ? devices.map(item => `<label class="automation-device"><input type="checkbox" name="automation-device" value="${escapeHTML(item.id)}"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(`${item.type} · ${item.udid}`)}</small></label>`).join("") : '<div class="automation-device"><span></span><strong>暂无已启用设备</strong><small>仍可创建 App Store 描述文件</small></div>';
}

function automationSelectedBundle(bundleId, identifier = "") {
  return (automationOptions?.bundleIds || []).find(item => String(item.id) === String(bundleId) || (identifier && item.identifier === identifier));
}

function normalizeAutomationCertificate(result, typeId, fallbackName) {
  const certificate = result?.certificate || {};
  return {
    ...certificate,
    id: result?.certificateId || certificate.id || certificate.certificateId || certificate.certRequestId || "",
    typeId,
    name: certificate.name || certificate.displayName || fallbackName,
  };
}

function collectAutomationSyncFailures(sync, label = "资料") {
  const failures = [];
  const visit = (value, pathLabel) => {
    if (!value || typeof value !== "object") return;
    if (value.success === false) failures.push({ label: pathLabel, error: value.error || (value.skipped ? "服务器同步被跳过" : "未知错误") });
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object" && (child.success === false || child.success === true || child.skipped === true)) visit(child, key);
    }
  };
  visit(sync, label);
  return failures;
}

function assertAutomationServerSync(sync, label) {
  const failures = collectAutomationSyncFailures(sync, label).filter(item => item.error !== "服务器同步被跳过");
  const skipped = collectAutomationSyncFailures(sync, label).find(item => item.error === "服务器同步被跳过");
  if (failures.length) throw new Error(`${label}已在 Apple 创建成功，但同步到服务器失败：${failures[0].error}`);
  if (skipped) throw new Error(`${label}已在 Apple 创建成功，但没有绑定浏览器账户，无法在浏览器下载证书。请从浏览器开发者账户列表启动证书管理后重试。`);
}

function isAutomationPushCertificate(certificate) {
  return ["JKG5JZ54H7", "UPV3DW712I", "BKLRAVXMGM"].includes(String(certificate?.typeId || ""));
}

async function syncAutomationCertificatesToServer(certificates, password, pushPassword = "") {
  const rows = (certificates || []).filter(Boolean);
  if (!rows.length) return;
  automationLog("正在同步证书和 P12 到服务器");
  const regularCertificates = rows.filter(item => !isAutomationPushCertificate(item));
  const pushCertificates = rows.filter(isAutomationPushCertificate);
  if (regularCertificates.length) {
    const result = await window.appleDeveloper.syncLocalCertificateArtifacts({ certificates: regularCertificates, password });
    if (!result?.success) throw new Error(result?.error || "证书和 P12 同步到服务器失败");
  }
  if (pushCertificates.length) {
    const result = await window.appleDeveloper.syncLocalCertificateArtifacts({ certificates: pushCertificates, password: pushPassword || password });
    if (!result?.success) throw new Error(result?.error || "推送证书和 P12 同步到服务器失败");
  }
  automationLog("证书和 P12 已同步到服务器", "done");
}

async function finalizeAutomationArtifacts({ certificates = [], profiles = [], bundleIdentifier = "" } = {}) {
  automationLog("正在核对服务器证书并清理旧文件");
  const result = await window.appleDeveloper.finalizeAutomationArtifacts({ certificates, profiles, bundleIdentifier });
  if (!result?.success) throw new Error(result?.error || "服务器证书资料收尾失败");
  markAppleDeveloperResourcePagesStale();
  automationLog(`服务器证书已核对${result.removed ? `，清理 ${result.removed} 个旧文件` : ""}`, "done");
}

async function serverHasCertificateArtifacts() {
  const result = await window.appleDeveloper.serverCertificatePackageOptions?.();
  if (!result?.success) return false;
  return result.hasArtifacts === true || Number(result.artifactCount || 0) > 0 || (Array.isArray(result.bundles) && result.bundles.length > 0);
}

const AUTOMATION_CERTIFICATE_REQUIREMENTS = {
  development: { label: "测试 Apple Development 证书", typeIds: ["83Q87W3TGH", "5QPB9NHCEI"] },
  distribution: { label: "正式 Apple Distribution 证书", typeIds: ["WXV89964HE", "R58UK2EWSO"] },
};

function automationCertificateFileGaps(requirements = [], certificates = [], serverReadiness = []) {
  const rows = Array.isArray(certificates) ? certificates : [];
  const serverRows = Array.isArray(serverReadiness) ? serverReadiness : [];
  return [...new Set(requirements)].map(key => {
    const requirement = AUTOMATION_CERTIFICATE_REQUIREMENTS[key];
    if (!requirement) return null;
    const certificate = rows.find(item => requirement.typeIds.includes(String(item?.typeId || "")) && !/revoked|expired|invalid/i.test(String(item?.status || item?.state || "")));
    if (!certificate?.id) return { key, label: requirement.label, reason: "Apple 中尚未创建" };
    const ready = serverRows.some(item => String(item?.certificateId || "") === String(certificate.id) && requirement.typeIds.includes(String(item?.typeId || certificate.typeId || "")) && item?.ready === true);
    return ready ? null : { key, label: requirement.label, reason: "服务器缺少对应的 P12 或私钥文件" };
  }).filter(Boolean);
}

async function ensureAutomationCertificateFiles({ requirements = [], rebuildCertificate = false, rebuildLabel = "重建证书", flowLabel = "一键创建", certificates = [] } = {}) {
  if (rebuildCertificate || !requirements.length) return { allowed: true, message: "" };
  const readiness = await window.appleDeveloper.automationCertificateReadiness?.();
  if (!readiness?.success) return { allowed: false, message: readiness?.error || "服务器证书文件读取失败，请稍后重试" };
  const gaps = automationCertificateFileGaps(requirements, certificates, readiness.certificateReadiness);
  if (!gaps.length) return { allowed: true, message: "" };
  const message = `${flowLabel}无法开始：\n\n${gaps.map(item => `• ${item.label}：${item.reason}`).join("\n")}。\n\n为避免生成后无法下载 P12，请先勾选“${rebuildLabel}”，填写 P12 导出密码后重新开始。`;
  alert(message);
  return { allowed: false, message };
}

async function prepareServerCertificateRebuild(scope = "") {
  automationLog("正在清理服务器旧证书套件");
  const result = await window.appleDeveloper.clearServerCertificateArtifacts?.({ scope });
  if (!result?.success) throw new Error(result?.error || "服务器旧证书套件清理失败");
  automationLog(`服务器旧证书套件已清理${result.deleted ? `（${result.deleted} 个文件）` : ""}`, "done");
  return true;
}

async function confirmAutomationRebuildCheckbox(input) {
  // Enable the password field immediately. The confirmation lookup can take
  // a moment on Windows and should not make a checked input appear inert.
  updateAutomationPasswordFields();
  if (!input?.checked) {
    return;
  }
  if (await serverHasCertificateArtifacts()) {
    const confirmed = confirm("重新配置会导致原来已经配置的证书文件失效，服务器原先的证书和描述文件也会自动删除。确定继续重新配置吗？");
    if (!confirmed) input.checked = false;
  }
  updateAutomationPasswordFields();
}

function updateAutomationPasswordFields() {
  const rebuild = !!el("automation-rebuild-certificate")?.checked;
  const createPush = !!el("automation-create-push")?.checked;
  const p12Input = el("automation-p12-password");
  const p12Field = p12Input?.closest(".field");
  if (p12Field) p12Field.classList.toggle("hidden", !rebuild);
  if (p12Input) {
    // Visibility is the control here; keeping the DOM input enabled avoids
    // Electron/Windows retaining a stale disabled state after a mode change.
    p12Input.disabled = false;
    p12Input.style.pointerEvents = "auto";
    p12Input.style.userSelect = "text";
  }
  const pushInput = el("automation-push-password");
  const pushField = pushInput?.closest(".field");
  if (pushField) pushField.classList.toggle("hidden", !createPush);
  if (pushInput) {
    pushInput.disabled = false;
    pushInput.style.pointerEvents = "auto";
    pushInput.style.userSelect = "text";
  }
}

async function ensureAutomationPushCapability(bundleId, identifier = "") {
  const selectedBundle = automationSelectedBundle(bundleId, identifier);
  if (!bundleId || !selectedBundle) throw new Error("无法找到需要开启推送的 Bundle ID");
  automationLog("正在检查 Bundle ID 推送能力");
  const detailResult = await window.appleDeveloper.bundleIdDetail({ id: bundleId });
  if (!detailResult?.success) throw new Error(detailResult?.error || "Bundle ID 推送能力读取失败");
  const detail = detailResult.bundleId || {};
  const capabilities = Array.isArray(detail.capabilities) ? detail.capabilities : [];
  const push = capabilities.find(item => item.id === "PUSH_NOTIFICATIONS");
  if (push?.enabled) {
    automationLog("Bundle ID 已开启推送通知", "done");
    return;
  }
  if (detail.editable === false) throw new Error("当前账户没有修改此 Bundle ID 推送能力的权限");
  const payloadCapabilities = capabilities
    .filter(item => item.id)
    .map(item => ({ id: item.id, enabled: item.id === "PUSH_NOTIFICATIONS" ? true : item.enabled === true, settings: item.settings || [] }));
  if (!payloadCapabilities.some(item => item.id === "PUSH_NOTIFICATIONS")) payloadCapabilities.push({ id: "PUSH_NOTIFICATIONS", enabled: true, settings: [] });
  const updated = await window.appleDeveloper.updateBundleId({ id: bundleId, name: detail.name || selectedBundle.name || "App", capabilities: payloadCapabilities });
  if (!updated?.success) throw new Error(updated?.error || "Bundle ID 推送能力开启失败");
  automationLog("Bundle ID 推送通知已开启", "done");
}

async function createAutomationPushCertificate(bundleId, identifier = "") {
  const selectedBundle = automationSelectedBundle(bundleId, identifier);
  if (!bundleId || !selectedBundle) throw new Error("请选择推送证书关联的 Bundle ID");
  await ensureAutomationPushCapability(bundleId, identifier);
  const existingResult = await window.appleDeveloper.certificates();
  if (existingResult?.success) {
    const selectedIdentifier = String(selectedBundle.identifier || identifier || "");
    const existingPush = (existingResult.certificates || []).find(item =>
      [String(item.ownerId || ""), String(item.appIdId || ""), String(item.bundleId || ""), String(item.bundleIdentifier || ""), String(item.name || "")].some(value => value === String(bundleId) || (!!selectedIdentifier && value.includes(selectedIdentifier)))
      && ["UPV3DW712I", "BKLRAVXMGM"].includes(String(item.typeId || ""))
      && !/revoked|expired|invalid/i.test(String(item.status || ""))
    );
    if (existingPush) {
      automationLog(`已存在该包名推送证书，正在撤销后重新创建：${existingPush.name || selectedBundle.identifier || identifier}`);
      const revoked = await window.appleDeveloper.revokeCertificate({ id: existingPush.id, typeId: existingPush.typeId });
      if (!revoked?.success) throw new Error(revoked?.error || `推送证书 ${existingPush.name || existingPush.id} 撤销失败`);
      automationLog("旧包名推送证书已撤销", "done");
    }
  }
  automationLog("正在检查推送证书创建权限");
  const typeResult = await window.appleDeveloper.certificateTypes();
  if (!typeResult?.success) throw new Error(typeResult?.error || "推送证书权限检查失败");
  const pushType = (typeResult.types || []).find(item => item.id === "UPV3DW712I");
  if (!pushType) throw new Error("当前组织不支持 APNs SSL 推送证书");
  automationLog(`正在创建推送证书：${selectedBundle.identifier || identifier}`);
  const created = await window.appleDeveloper.createCertificate({ typeId: "UPV3DW712I", appIdId: bundleId });
  if (!created?.success) {
    if (/current Apple Push Services certificate|pending certificate request|已有|待处理|数量上限|7460/i.test(String(created?.error || ""))) {
      throw new Error("Apple 已有当前有效或待处理的推送证书，无法直接创建新的推送 P12。请勾选“重建证书”后重新执行，系统会先撤销旧推送证书再创建新的推送 P12。");
    }
    throw new Error(created?.error || "推送证书创建失败");
  }
  assertAutomationServerSync(created.sync, "推送证书");
  const certificate = normalizeAutomationCertificate(created, "UPV3DW712I", `APNs ${selectedBundle.identifier || identifier}`);
  if (!certificate.id) throw new Error("推送证书已创建，但没有返回证书 ID，请刷新后重试");
  automationLog("推送证书创建完成", "done");
  return certificate;
}

async function openAutomationAddDevice() {
  openDeviceAddAfterDeviceLoad = true;
  await showPage("devices");
  if (!el("page-devices")?.classList.contains("active")) openDeviceAddAfterDeviceLoad = false;
}

async function loadAutomationOptions() {
  const select = el("automation-bundle");
  select.innerHTML = '<option value="">正在读取…</option>';
  const result = await window.appleDeveloper.profileOptions();
  if (!result?.success) throw new Error(result?.error || "自动化选项读取失败");
  automationOptions = result;
  select.innerHTML = '<option value="">请选择 Bundle ID</option>' + (result.bundleIds || []).map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(`${item.name} · ${item.identifier}`)}</option>`).join("");
  renderAutomationDevices(result.devices || []);
}

async function refreshAutomationIfActive() {
  if (!authenticated || !el("page-one-click")?.classList.contains("active") || !el("automation-bundle")) return;
  el("automation-error").textContent = "正在读取当前组织的 Bundle ID、证书和设备…";
  try {
    await loadAutomationOptions();
    el("automation-error").textContent = "";
  } catch (error) {
    el("automation-error").textContent = error.message || "自动化数据读取失败";
  }
}

function renderAutomationDownloadDialog() {
  if (!automationDownloadOpen) return "";
  const content = automationDownloadLoading
    ? '<div class="automation-dialog-loading">正在读取已同步包名…</div>'
    : automationDownloadError
      ? `<div class="automation-dialog-error">${escapeHTML(automationDownloadError)}</div>`
      : automationDownloadBundles.length
        ? `<div class="automation-bundle-list">${automationDownloadBundles.map(item => {
          const bundleId = String(item.bundleId || "");
          const available = item.available !== false;
          const selected = available && bundleId === String(automationDownloadSelected);
          const detail = item.repairingP12
            ? "下载时将自动修复 P12"
            : (available ? `${Number(item.profileCount || 0)} 个描述文件` : "资料不完整");
          return `<button class="automation-bundle-row ${selected ? "selected" : ""} ${available ? "" : "unavailable"}" type="button" data-download-bundle="${escapeHTML(bundleId)}" ${available ? "" : "disabled"}><span class="automation-bundle-radio"></span><span><strong>${escapeHTML(bundleId)}</strong><small>描述名称：${escapeHTML(item.name || bundleId)}</small>${available ? "" : `<small class="automation-bundle-error">${escapeHTML(item.error || "关联证书资料不可用")}</small>`}</span><em>${escapeHTML(detail)}</em></button>`;
        }).join("")}</div>`
        : '<div class="automation-dialog-empty">当前账户没有可下载的已同步证书文件。</div>';
  return `<div class="automation-dialog-mask" id="automation-download-mask"><section class="automation-dialog automation-bundle-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-download-title"><header><div><h2 id="automation-download-title">选择要下载的 Bundle ID</h2><p>下载当前开发者账户已同步的证书和描述文件。</p></div><button class="automation-dialog-close" type="button" data-close-automation-download aria-label="关闭">×</button></header><div class="automation-dialog-body">${content}<div class="automation-dialog-status" id="automation-download-status"></div></div><footer><button class="secondary" type="button" data-close-automation-download>取消</button><button class="primary" id="automation-download-selected" type="button" ${automationDownloadSelected && !automationDownloadLoading ? "" : "disabled"}>↓ 下载 ZIP 文件包</button></footer></section></div>`;
}

function bindAutomationDownloadDialog() {
  document.querySelectorAll("[data-close-automation-download]").forEach(button => button.addEventListener("click", () => {
    automationDownloadOpen = false;
    renderOneClickPage();
  }));
  document.querySelectorAll("[data-download-bundle]").forEach(button => button.addEventListener("click", () => {
    if (button.disabled) return;
    automationDownloadSelected = button.dataset.downloadBundle || "";
    renderOneClickPage();
  }));
  el("automation-download-selected")?.addEventListener("click", downloadSelectedServerCertificatePackage);
  el("automation-download-mask")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) {
      automationDownloadOpen = false;
      renderOneClickPage();
    }
  });
}

async function openAutomationDownloadDialog() {
  automationDownloadOpen = true;
  automationDownloadLoading = true;
  automationDownloadBundles = [];
  automationDownloadSelected = "";
  automationDownloadError = "";
  renderOneClickPage();
  const result = await window.appleDeveloper.serverCertificatePackageOptions?.();
  if (!automationDownloadOpen) return;
  if (!result?.success) automationDownloadError = result?.error || "包名读取失败";
  else {
    automationDownloadBundles = Array.isArray(result.bundles) ? result.bundles : [];
    automationDownloadSelected = String(automationDownloadBundles.find(item => item.available !== false)?.bundleId || "");
    automationDownloadPassword = String(result.p12Password || "");
  }
  automationDownloadLoading = false;
  renderOneClickPage();
}

async function downloadSelectedServerCertificatePackage() {
  if (!automationDownloadSelected) return;
  const button = el("automation-download-selected");
  const status = el("automation-download-status");
  setBusy(button, true, "正在准备 ZIP…");
  if (status) status.textContent = "正在下载服务器证书文件…";
  try {
    const result = await window.appleDeveloper.downloadServerCertificatePackage({ bundleId: automationDownloadSelected, p12Password: automationDownloadPassword });
    if (!result?.success && !result?.canceled) throw new Error(result?.error || "证书文件下载失败");
    if (status) status.textContent = result?.canceled ? "已取消下载" : "文件已保存";
  } catch (error) {
    if (status) status.textContent = error.message || "证书文件下载失败";
  } finally {
    setBusy(button, false);
  }
}

function closeAutomationCompletionDownloadDialog() {
  automationCompletionDownloadOpen = false;
  document.getElementById("automation-completion-download-mask")?.remove();
}

function returnToOneClickHomeAfterAutomationDownload() {
  closeAutomationCompletionDownloadDialog();
  automationDownloadOpen = false;
  automationArtifacts = null;
  renderOneClickPage();
}

function openAutomationCompletionDownloadDialog() {
  if (!automationArtifacts) return;
  closeAutomationCompletionDownloadDialog();
  automationCompletionDownloadOpen = true;
  const certificateCount = Array.isArray(automationArtifacts.certificates) ? automationArtifacts.certificates.length : 0;
  const profileCount = Array.isArray(automationArtifacts.profiles) ? automationArtifacts.profiles.length : 0;
  const mask = document.createElement("div");
  mask.className = "automation-dialog-mask";
  mask.id = "automation-completion-download-mask";
  mask.innerHTML = `<section class="automation-dialog automation-bundle-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-completion-download-title"><header><div><h2 id="automation-completion-download-title">证书和描述文件已创建</h2><p>本次已完成 ${certificateCount} 张证书和 ${profileCount} 个描述文件，是否立即下载 ZIP 文件包？</p></div><button class="automation-dialog-close" type="button" data-close-automation-completion-download aria-label="关闭">×</button></header><div class="automation-dialog-body"><div class="automation-dialog-empty">ZIP 文件包包含本次创建的 P12 证书和描述文件。</div><div class="automation-dialog-status" id="automation-completion-download-status"></div></div><footer><button class="secondary" type="button" data-close-automation-completion-download>取消</button><button class="primary" id="automation-completion-download-button" type="button">↓ 下载 ZIP 文件包</button></footer></section>`;
  document.body.appendChild(mask);
  const close = () => returnToOneClickHomeAfterAutomationDownload();
  mask.querySelectorAll("[data-close-automation-completion-download]").forEach(button => button.addEventListener("click", close));
  mask.addEventListener("click", event => {
    if (event.target === mask) close();
  });
  mask.querySelector("#automation-completion-download-button")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const status = mask.querySelector("#automation-completion-download-status");
    const result = await downloadAutomationArtifacts({ button, errorTarget: status });
    if (result?.success || result?.canceled) returnToOneClickHomeAfterAutomationDownload();
  });
}

function renderOneClickPage() {
  const page = el("page-one-click");
  page.innerHTML = `<div class="automation-home-head"><h1>一键操作</h1><p>选择需要自动完成的任务，进入后再设置 Bundle ID、设备及导出信息。</p></div><div class="automation-home-grid"><button class="automation-home-card" type="button" data-automation="release"><span class="automation-home-icon">⇧</span><strong>一键创建上架证书和描述</strong><p>自动生成发布证书、Ad Hoc 与 App Store 描述文件。</p></button><button class="automation-home-card" type="button" data-automation="test"><span class="automation-home-icon">◇</span><strong>一键创建测试证书和描述</strong><p>自动生成开发证书与设备测试描述文件。</p></button><button class="automation-home-card" type="button" data-automation="all"><span class="automation-home-icon">✦</span><strong>一键创建全部证书和文件</strong><p>集中生成上架及测试流程需要的全部文件。</p></button><button class="automation-home-card" type="button" data-automation="download"><span class="automation-home-icon">↓</span><strong>一键下载证书和描述</strong><p>选择包名后下载服务器中已同步的证书、P12 和描述文件。</p></button></div>${renderAutomationDownloadDialog()}`;
  page.querySelector('[data-automation="release"]').addEventListener("click", renderReleaseAutomationPage);
  page.querySelector('[data-automation="test"]').addEventListener("click", renderTestAutomationPage);
  page.querySelector('[data-automation="all"]').addEventListener("click", renderAllAutomationPage);
  page.querySelector('[data-automation="download"]').addEventListener("click", openAutomationDownloadDialog);
  bindAutomationDownloadDialog();
}

function renderAutomationComingPage(title) {
  el("page-one-click").innerHTML = `<button class="automation-back" id="automation-back" type="button">‹ 返回一键操作</button><div class="automation-form"><div class="automation-placeholder"><div><strong>${escapeHTML(title)}</strong><span>该自动化流程正在接入中</span></div></div></div>`;
  el("automation-back").addEventListener("click", renderOneClickPage);
}

function bindAutomationForm(startHandler) {
  el("automation-back").addEventListener("click", renderOneClickPage);
  document.querySelectorAll('input[name="automation-bundle-mode"]').forEach(input => input.addEventListener("change", () => { const isNew = input.checked && input.value === "new"; if (input.checked) { el("automation-existing").classList.toggle("hidden", isNew); el("automation-new").classList.toggle("hidden", !isNew); } }));
  el("automation-device-select-all").addEventListener("change", event => document.querySelectorAll('input[name="automation-device"]').forEach(input => { input.checked = event.target.checked; }));
  el("automation-add-device")?.addEventListener("click", openAutomationAddDevice);
  el("automation-rebuild-certificate")?.addEventListener("change", event => { updateAutomationPasswordFields(); confirmAutomationRebuildCheckbox(event.target).catch(error => { event.target.checked = false; updateAutomationPasswordFields(); el("automation-error").textContent = error.message || "重建证书确认失败"; }); });
  el("automation-create-push")?.addEventListener("change", updateAutomationPasswordFields);
  el("automation-start").addEventListener("click", startHandler);
  el("automation-download-button").addEventListener("click", downloadAutomationArtifacts);
  updateAutomationPasswordFields();
  if (authenticated) loadAutomationOptions().catch(error => { el("automation-error").textContent = error.message; });
  else el("automation-error").textContent = "正在恢复 Apple 登录状态，请稍候…";
}

function renderTestAutomationPage() {
  const page = el("page-one-click");
  page.innerHTML = `<button class="automation-back" id="automation-back" type="button">‹ 返回一键操作</button><div class="automation-form"><h2>一键创建测试证书和描述</h2><p class="automation-intro">可使用已有 Apple Development 开发证书，也可勾选重建，并创建包含测试设备的 iOS Development 描述文件。</p><div class="automation-mode"><label><input type="radio" name="automation-bundle-mode" value="existing" checked>选择已有 Bundle ID</label><label><input type="radio" name="automation-bundle-mode" value="new">添加新 Bundle ID</label></div><div id="automation-existing"><div class="field"><label>Bundle ID</label><select id="automation-bundle"><option value="">正在读取…</option></select></div></div><div class="automation-new-bundle hidden" id="automation-new"><div class="field"><label>描述名称</label><input id="automation-bundle-name" maxlength="100" placeholder="例如 My App"></div><div class="field"><label>Bundle ID</label><input id="automation-bundle-identifier" maxlength="255" placeholder="例如 com.company.app"></div></div><label class="automation-select-all automation-push-option"><input id="automation-create-push" type="checkbox">同时创建推送证书</label><div class="hint">勾选后会先确保 Bundle ID 已开启推送通知，再创建 APNs SSL（Sandbox & Production）证书。</div><div class="field automation-push-password"><label>推送 P12 密码</label><input id="automation-push-password" type="password" autocomplete="new-password" placeholder="请输入推送 P12 密码"></div><div class="automation-device-tools"><div class="section-title">测试设备</div><button class="secondary automation-add-device" id="automation-add-device" type="button">添加设备</button><label class="automation-select-all"><input id="automation-device-select-all" type="checkbox">全选设备</label></div><div class="hint">开发测试描述文件必须至少包含一台已启用设备。</div><div class="automation-devices" id="automation-devices"></div><div class="field" style="margin-top:16px"><label>P12 导出密码</label><input id="automation-p12-password" type="password" autocomplete="new-password" placeholder="用于保护开发证书 P12 文件"></div><label class="automation-select-all" style="margin-top:10px"><input id="automation-rebuild-certificate" type="checkbox">重建证书</label><div class="automation-warning">未勾选时优先使用已有开发证书；如果没有已有证书会自动创建。勾选后会撤销当前同类开发证书并重新创建。</div><div class="error" id="automation-error"></div><div class="automation-actions"><button class="primary" id="automation-start" type="button">开始全自动创建</button></div><div class="automation-progress" id="automation-progress"><div class="automation-log" id="automation-log"></div><div class="automation-download" id="automation-download"><button class="primary" id="automation-download-button" type="button">下载 ZIP 文件包</button><span class="hint">ZIP 内包含开发 P12 和 Development 描述文件</span></div></div></div>`;
  bindAutomationForm(startTestAutomation);
}

function renderReleaseAutomationPage() {
  const page = el("page-one-click");
  page.innerHTML = `<button class="automation-back" id="automation-back" type="button">‹ 返回一键操作</button><div class="automation-form"><h2>一键创建上架证书和描述</h2><p class="automation-intro">选择已有 Bundle ID 或按规则新建。系统可使用已有 Apple Distribution 证书，也可勾选重建，并创建 App Store 与 Ad Hoc 描述文件。</p><div class="automation-mode"><label><input type="radio" name="automation-bundle-mode" value="existing" checked>选择已有 Bundle ID</label><label><input type="radio" name="automation-bundle-mode" value="new">添加新 Bundle ID</label></div><div id="automation-existing"><div class="field"><label>Bundle ID</label><select id="automation-bundle"><option value="">正在读取…</option></select></div></div><div class="automation-new-bundle hidden" id="automation-new"><div class="field"><label>描述名称</label><input id="automation-bundle-name" maxlength="100" placeholder="例如 My App"></div><div class="field"><label>Bundle ID</label><input id="automation-bundle-identifier" maxlength="255" placeholder="例如 com.company.app"></div></div><label class="automation-select-all automation-push-option"><input id="automation-create-push" type="checkbox">同时创建推送证书</label><div class="hint">勾选后会先确保 Bundle ID 已开启推送通知，再创建 APNs SSL（Sandbox & Production）证书。</div><div class="field automation-push-password"><label>推送 P12 密码</label><input id="automation-push-password" type="password" autocomplete="new-password" placeholder="请输入推送 P12 密码"></div><div class="automation-device-tools"><div class="section-title">测试设备（可不选）</div><button class="secondary automation-add-device" id="automation-add-device" type="button">添加设备</button><label class="automation-select-all"><input id="automation-device-select-all" type="checkbox">全选设备</label></div><div class="hint">不选择时只创建 App Store 描述文件；只有勾选设备时才会额外创建 Ad Hoc 描述文件。</div><div class="automation-devices" id="automation-devices"></div><div class="field" style="margin-top:16px"><label>P12 导出密码</label><input id="automation-p12-password" type="password" autocomplete="new-password" placeholder="用于保护最终下载的 P12 文件"></div><label class="automation-select-all" style="margin-top:10px"><input id="automation-rebuild-certificate" type="checkbox">重建证书</label><div class="automation-warning">未勾选时优先使用已有发布证书；如果没有已有证书会自动创建。勾选后会撤销当前同类发布证书并重新创建。</div><div class="error" id="automation-error"></div><div class="automation-actions"><button class="primary" id="automation-start" type="button">开始全自动创建</button></div><div class="automation-progress" id="automation-progress"><div class="automation-log" id="automation-log"></div><div class="automation-download" id="automation-download"><button class="primary" id="automation-download-button" type="button">下载 ZIP 文件包</button><span class="hint">ZIP 内包含 P12、Ad Hoc 和 App Store 描述文件；勾选推送时包含推送 P12</span></div></div></div>`;
  bindAutomationForm(startReleaseAutomation);
}

function renderAllAutomationPage() {
  const page = el("page-one-click");
  page.innerHTML = `<button class="automation-back" id="automation-back" type="button">‹ 返回一键操作</button><div class="automation-form"><h2>一键创建全部证书和描述文件</h2><p class="automation-intro">一次完成 Apple Development、Apple Distribution 证书，以及 Development、Ad Hoc、App Store 描述文件。</p><div class="automation-mode"><label><input type="radio" name="automation-bundle-mode" value="existing" checked>选择已有 Bundle ID</label><label><input type="radio" name="automation-bundle-mode" value="new">添加新 Bundle ID</label></div><div id="automation-existing"><div class="field"><label>Bundle ID</label><select id="automation-bundle"><option value="">正在读取…</option></select></div></div><div class="automation-new-bundle hidden" id="automation-new"><div class="field"><label>描述名称</label><input id="automation-bundle-name" maxlength="100" placeholder="例如 My App"></div><div class="field"><label>Bundle ID</label><input id="automation-bundle-identifier" maxlength="255" placeholder="例如 com.company.app"></div></div><label class="automation-select-all automation-push-option"><input id="automation-create-push" type="checkbox">同时创建推送证书</label><div class="hint">勾选后会先确保 Bundle ID 已开启推送通知，再创建 APNs SSL（Sandbox & Production）证书。</div><div class="field automation-push-password"><label>推送 P12 密码</label><input id="automation-push-password" type="password" autocomplete="new-password" placeholder="请输入推送 P12 密码"></div><div class="automation-device-tools"><div class="section-title">测试设备</div><button class="secondary automation-add-device" id="automation-add-device" type="button">添加设备</button><label class="automation-select-all"><input id="automation-device-select-all" type="checkbox">全选设备</label></div><div class="hint">Development 与 Ad Hoc 描述文件必须包含至少一台已启用设备。</div><div class="automation-devices" id="automation-devices"></div><div class="field" style="margin-top:16px"><label>P12 导出密码</label><input id="automation-p12-password" type="password" autocomplete="new-password" placeholder="用于保护两张证书的 P12 文件"></div><label class="automation-select-all" style="margin-top:10px"><input id="automation-rebuild-certificate" type="checkbox">重建开发证书和发布证书</label><div class="automation-warning">默认优先使用已有有效证书；勾选后会撤销同类旧证书并重新创建，旧证书将立即失效。</div><div class="error" id="automation-error"></div><div class="automation-actions"><button class="primary" id="automation-start" type="button">开始创建全部文件</button></div><div class="automation-progress" id="automation-progress"><div class="automation-log" id="automation-log"></div><div class="automation-download" id="automation-download"><button class="primary" id="automation-download-button" type="button">下载全部 ZIP 文件包</button><span class="hint">包含开发与发布 P12、Development、Ad Hoc、App Store 描述文件；勾选推送时包含推送 P12</span></div></div></div>`;
  bindAutomationForm(startAllAutomation);
}

function confirmAllAutomationWithoutDevices() {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "device-action-overlay";
    overlay.innerHTML = `<div class="device-action-dialog device-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-no-device-title"><div class="device-action-head"><h2 id="automation-no-device-title">还未添加设备 UDID</h2><button class="device-action-close" type="button" aria-label="关闭">×</button></div><div class="device-action-body"><p class="device-action-copy">当前没有勾选测试设备。如果继续，本次将只创建 Apple Distribution 正式证书和 App Store 描述文件，不会创建 Apple Development 证书、Development 和 Ad Hoc 描述文件。</p></div><div class="device-action-foot"><button class="secondary" data-continue type="button">继续创建</button><button class="primary" data-add-device type="button">添加设备</button></div></div>`;
    document.body.appendChild(overlay);
    const finish = action => { overlay.remove(); resolve(action); };
    overlay.querySelector(".device-action-close").addEventListener("click", () => finish("cancel"));
    overlay.querySelector("[data-add-device]").addEventListener("click", () => finish("add-device"));
    overlay.querySelector("[data-continue]").addEventListener("click", () => finish("continue"));
  });
}

function automationProfileTypeId(profile = {}) {
  const primary = String(profile?.profileType || "").trim();
  const fallback = String(profile?.type || "").trim();
  const raw = !primary || primary === "—" ? fallback : primary;
  const value = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const isIOS = value.startsWith("IOS_");
  if (isIOS && value.includes("DEVELOPMENT")) return "IOS_APP_DEVELOPMENT";
  if (isIOS && (value.includes("ADHOC") || value.includes("AD_HOC"))) return "IOS_APP_ADHOC";
  if (isIOS && (value.includes("APP_STORE") || value.includes("APPSTORE"))) return "IOS_APP_STORE";
  return value;
}

async function removeExistingAutomationProfiles({ profiles = [], bundleId = "", bundleIdentifier = "", specs = [], certificateIds = [] } = {}) {
  const targetTypes = new Set(specs.map(spec => automationProfileTypeId(spec)).filter(Boolean));
  const targetBundleId = String(bundleId || "").trim();
  const targetIdentifier = String(bundleIdentifier || "").trim().toLowerCase();
  const targetCertificateIds = new Set(certificateIds.map(String).map(value => value.trim()).filter(Boolean));
  if ((!targetTypes.size || (!targetBundleId && !targetIdentifier)) && !targetCertificateIds.size) return 0;
  const matches = [];
  for (const original of profiles) {
    let profile = { ...original };
    const hasType = String(profile.profileType || profile.type || "").trim() && String(profile.profileType || profile.type || "").trim() !== "—";
    const hasBundleIdentity = String(profile.bundleId || "").trim() || String(profile.bundleIdentifier || "").trim();
    const profileCertificateIds = Array.isArray(profile.certificateIds) ? profile.certificateIds.map(String).map(value => value.trim()).filter(Boolean) : [];
    const hasCertificateIds = profileCertificateIds.length > 0;
    const quickType = automationProfileTypeId(profile);
    const shouldLookup = ((!hasType || targetTypes.has(quickType)) && (!hasType || !hasBundleIdentity)) || (targetCertificateIds.size > 0 && !hasCertificateIds);
    if (shouldLookup && typeof window.appleDeveloper.profileBundle === "function") {
      try {
        const detail = await window.appleDeveloper.profileBundle({
          id: profile.id,
          name: profile.name,
          bundleId: profile.bundleId,
          bundleIdentifier: profile.bundleIdentifier,
          bundleName: profile.bundleName,
          profileType: profile.profileType,
          certificateIds: profile.certificateIds,
          deviceIds: profile.deviceIds,
        });
        if (detail?.success && detail.profile) profile = { ...profile, ...detail.profile };
      } catch (error) {
        console.warn(`旧描述文件详情读取失败（${profile.id}）：`, error.message || error);
      }
    }
    const certificateMatches = targetCertificateIds.size > 0 && (Array.isArray(profile.certificateIds) ? profile.certificateIds : []).some(id => targetCertificateIds.has(String(id).trim()));
    const profileBundleId = String(profile.bundleId || "").trim();
    const profileIdentifier = String(profile.bundleIdentifier || "").trim().toLowerCase();
    const bundleMatches = (targetBundleId && profileBundleId === targetBundleId) || (targetIdentifier && profileIdentifier === targetIdentifier);
    const profileTypeMatches = targetTypes.has(automationProfileTypeId(profile));
    if ((certificateMatches || (profileTypeMatches && bundleMatches)) && profile.id) matches.push(profile);
  }
  for (const profile of matches) {
    automationLog(`正在删除旧描述文件：${profile.name || profile.id}`);
    const removed = await window.appleDeveloper.deleteProfile({ id: profile.id });
    if (!removed?.success) throw new Error(removed?.error || `描述文件 ${profile.name || profile.id} 删除失败`);
  }
  if (matches.length) automationLog(`已删除 ${matches.length} 个旧描述文件`, "done");
  return matches.length;
}

async function startAllAutomation() {
  const errorBox = el("automation-error"); errorBox.textContent = "";
  const isNew = document.querySelector('input[name="automation-bundle-mode"]:checked')?.value === "new";
  const rebuild = !!el("automation-rebuild-certificate")?.checked;
  const passwordInput = el("automation-p12-password").value;
  const password = passwordInput || defaultP12Password();
  const createPushCertificate = !!el("automation-create-push")?.checked;
  const pushPasswordInput = el("automation-push-password")?.value || "";
  const pushPassword = pushPasswordInput;
  let bundleId = el("automation-bundle").value;
  const bundleName = el("automation-bundle-name").value.trim();
  const identifier = el("automation-bundle-identifier").value.trim();
  if (rebuild && !passwordInput) { errorBox.textContent = "请输入 P12 导出密码"; return; }
  if (createPushCertificate && !pushPasswordInput) { errorBox.textContent = "请输入推送 P12 密码"; return; }
  if (isNew && (!bundleName || !identifier)) { errorBox.textContent = "请填写描述名称和 Bundle ID"; return; }
  if (!isNew && !bundleId) { errorBox.textContent = "请选择 Bundle ID"; return; }
  const selectedDeviceIds = [...document.querySelectorAll('input[name="automation-device"]:checked')].map(input => input.value);
  const includeDeviceArtifacts = selectedDeviceIds.length > 0;
  if (!includeDeviceArtifacts) {
    const action = await confirmAllAutomationWithoutDevices();
    if (action === "add-device") { await openAutomationAddDevice(); return; }
    if (action !== "continue") return;
  }
  const button = el("automation-start"); setBusy(button, true, "正在预检…");
  el("automation-progress").classList.add("show"); el("automation-log").replaceChildren(); el("automation-download").classList.remove("show"); automationArtifacts = null;
  try {
    const options = await window.appleDeveloper.profileOptions();
    if (!options?.success) throw new Error(options?.error || "当前组织数据读取失败");
    automationOptions = options;
    const certificateGuard = await ensureAutomationCertificateFiles({
      requirements: includeDeviceArtifacts ? ["development", "distribution"] : ["distribution"],
      rebuildCertificate: rebuild,
      rebuildLabel: "重建开发证书和发布证书",
      flowLabel: "一键创建全部证书和描述文件",
      certificates: automationOptions.certificates,
    });
    if (!certificateGuard.allowed) { errorBox.textContent = certificateGuard.message; return; }
    const allDeviceIds = selectedDeviceIds;
    if (isNew) {
      if (!/^[A-Za-z0-9 ]+$/.test(bundleName) || !/^[A-Za-z0-9.-]+$/.test(identifier)) throw new Error("描述名称或 Bundle ID 格式不正确");
      automationLog(`正在创建 Bundle ID：${identifier}`);
      const created = await window.appleDeveloper.createBundleId({ name: bundleName, identifier, capabilities: ["IN_APP_PURCHASE", ...(createPushCertificate ? ["PUSH_NOTIFICATIONS"] : [])] });
      if (!created?.success) throw new Error(created?.error || "Bundle ID 创建失败");
      automationOptions = await window.appleDeveloper.profileOptions();
      bundleId = automationOptions.bundleIds?.find(item => item.identifier === identifier)?.id;
      if (!bundleId) throw new Error("Bundle ID 已创建，但 Apple 暂未返回，请稍后重试");
    }
    const selectedBundle = (automationOptions.bundleIds || []).find(item => item.id === bundleId);
    const baseName = (isNew ? bundleName : selectedBundle?.name) || "App";
    const bundleIdentifier = selectedBundle?.identifier || identifier;
    const profilesResult = await window.appleDeveloper.profiles();
    if (!profilesResult?.success) throw new Error(profilesResult?.error || "描述文件读取失败");
    const certTypes = [...(includeDeviceArtifacts ? [{ id: "83Q87W3TGH", legacy: "5QPB9NHCEI", name: "Apple Development" }] : []), { id: "WXV89964HE", legacy: "R58UK2EWSO", name: "Apple Distribution" }];
    const certificates = [];
    const rebuiltCertificateIds = [];
    for (const type of certTypes) {
      const existing = (automationOptions.certificates || []).filter(item => [type.id, type.legacy].includes(item.typeId));
      if (rebuild) for (const cert of existing) {
        if (cert.id) rebuiltCertificateIds.push(String(cert.id));
        automationLog(`正在撤销旧证书：${cert.name}`);
        const revoked = await window.appleDeveloper.revokeCertificate({ id: cert.id, typeId: cert.typeId });
        if (!revoked?.success) throw new Error(revoked?.error || `证书 ${cert.name} 撤销失败`);
      }
      let certificate = rebuild ? null : existing[0];
      if (!certificate) {
        automationLog(`正在创建 ${type.name} 证书`);
        const created = await window.appleDeveloper.createCertificate({ typeId: type.id, appIdId: "" });
        if (!created?.success) throw new Error(created?.error || `${type.name} 创建失败`);
        assertAutomationServerSync(created.sync, `${type.name} 证书`);
        certificate = { ...(created.certificate || {}), id: created.certificateId || created.certificate?.id, typeId: type.id, name: created.certificate?.name || type.name };
      }
      if (!certificate?.id) throw new Error(`${type.name} 没有返回证书 ID`);
      certificates.push(certificate); automationLog(`${type.name} 已就绪`, "done");
    }
    const pushCertificate = createPushCertificate ? await createAutomationPushCertificate(bundleId, bundleIdentifier) : null;
    if (createPushCertificate && !pushCertificate) throw new Error("已勾选推送证书，但没有生成可导出 P12 的推送证书，请勾选重建后重试");
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const developmentCertificate = certificates.find(item => ["83Q87W3TGH", "5QPB9NHCEI"].includes(item.typeId));
    const distributionCertificate = certificates.find(item => ["WXV89964HE", "R58UK2EWSO"].includes(item.typeId));
    if (!distributionCertificate) throw new Error("正式发布证书没有返回有效 ID");
    const specs = [
      ...(includeDeviceArtifacts ? [
        { key: "development", type: "IOS_APP_DEVELOPMENT", name: `${baseName} Development ${stamp}`, cert: developmentCertificate, devices: allDeviceIds },
        { key: "adhoc", type: "IOS_APP_ADHOC", name: `${baseName} AdHoc ${stamp}`, cert: distributionCertificate, devices: allDeviceIds },
      ] : []),
      { key: "store", type: "IOS_APP_STORE", name: `${baseName} AppStore ${stamp}`, cert: distributionCertificate, devices: [] },
    ];
    const profiles = {};
    await removeExistingAutomationProfiles({ profiles: profilesResult.profiles || [], bundleId, bundleIdentifier, specs, certificateIds: rebuiltCertificateIds });
    await syncAutomationCertificatesToServer([...certificates, pushCertificate].filter(Boolean), password, pushPassword);
    for (const spec of specs) {
      automationLog(`正在创建 ${spec.type} 描述文件`);
      const created = await window.appleDeveloper.createProfile({ profileType: spec.type, name: spec.name, bundleId, bundleIdentifier, bundleName: baseName, certificateIds: [spec.cert.id], deviceIds: spec.devices });
      if (!created?.success) throw new Error(created?.error || `${spec.name} 创建失败`);
      assertAutomationServerSync(created.sync, `${spec.name} 描述文件`);
      profiles[spec.key] = created.profile; automationLog(`${spec.name} 创建完成`, "done");
    }
    await finalizeAutomationArtifacts({ certificates: [...certificates, pushCertificate].filter(Boolean), profiles: Object.values(profiles), bundleIdentifier });
    automationArtifacts = { certificates: [...certificates, pushCertificate].filter(Boolean), profiles: Object.values(profiles), certificate: distributionCertificate, store: profiles.store, adhoc: profiles.adhoc, development: profiles.development, password, pushPassword, bundleIdentifier, includePush: createPushCertificate, packageName: includeDeviceArtifacts ? `${baseName}_All_Certificate_Files` : `${baseName}_Distribution_Files` };
    if (!includeDeviceArtifacts) el("automation-download-button").textContent = "下载正式证书 ZIP 文件包";
    el("automation-download").classList.add("show"); automationLog(includeDeviceArtifacts ? "全部证书和描述文件创建完成" : "正式证书和 App Store 描述文件创建完成", "done");
    openAutomationCompletionDownloadDialog();
  } catch (error) { errorBox.textContent = error.message; automationLog(error.message, "error"); }
  finally { setBusy(button, false); }
}

async function startTestAutomation() {
  const errorBox = el("automation-error"); errorBox.textContent = "";
  const isNew = document.querySelector('input[name="automation-bundle-mode"]:checked')?.value === "new";
  const rebuildCertificate = !!el("automation-rebuild-certificate")?.checked;
  const createPushCertificate = !!el("automation-create-push")?.checked;
  const passwordInput = el("automation-p12-password").value;
  const password = passwordInput || defaultP12Password();
  const pushPasswordInput = el("automation-push-password")?.value || "";
  const pushPassword = pushPasswordInput;
  let bundleId = el("automation-bundle").value;
  const bundleName = el("automation-bundle-name").value.trim();
  const identifier = el("automation-bundle-identifier").value.trim();
  if (rebuildCertificate && !passwordInput) { errorBox.textContent = "请输入 P12 导出密码"; return; }
  if (createPushCertificate && !pushPasswordInput) { errorBox.textContent = "请输入推送 P12 密码"; return; }
  if (isNew && (!bundleName || !identifier)) { errorBox.textContent = "请填写描述名称和 Bundle ID"; return; }
  if (isNew && (!/^[A-Za-z0-9 ]+$/.test(bundleName) || !/^[A-Za-z0-9.-]+$/.test(identifier) || identifier.startsWith(".") || identifier.endsWith(".") || identifier.includes(".."))) { errorBox.textContent = "描述名称仅限英文、数字和空格；Bundle ID 仅限字母、数字、点和连字符"; return; }
  if (!isNew && !bundleId) { errorBox.textContent = "请选择 Bundle ID"; return; }
  const button = el("automation-start"); setBusy(button, true, "正在预检…");
  el("automation-progress").classList.add("show"); el("automation-log").replaceChildren(); el("automation-download").classList.remove("show"); automationArtifacts = null;
  try {
    automationLog("预检 1/5：正在刷新当前组织数据");
    const refreshedOptions = await window.appleDeveloper.profileOptions();
    if (!refreshedOptions?.success) throw new Error(refreshedOptions?.error || "当前组织数据读取失败");
    automationOptions = refreshedOptions;
    if (isNew && (automationOptions.bundleIds || []).some(item => String(item.identifier).toLowerCase() === identifier.toLowerCase())) throw new Error(`Identifier“${identifier}”已经创建过了，请选择已有 Bundle ID，不要重复创建`);
    if (!isNew && !(automationOptions.bundleIds || []).some(item => item.id === bundleId)) throw new Error("选择的 Bundle ID 已不存在，请刷新后重新选择");
    const certificateGuard = await ensureAutomationCertificateFiles({
      requirements: ["development"],
      rebuildCertificate,
      rebuildLabel: "重建证书",
      flowLabel: "一键创建测试证书和描述",
      certificates: automationOptions.certificates,
    });
    if (!certificateGuard.allowed) { errorBox.textContent = certificateGuard.message; return; }
    automationLog("Bundle ID 检查通过", "done");
    const selectedDevices = [...document.querySelectorAll('input[name="automation-device"]:checked')].map(input => input.value);
    const deviceIds = selectedDevices;
    automationLog("预检 2/5：正在检查测试设备");
    if (!deviceIds.length) throw new Error("创建开发描述文件必须勾选至少一台测试设备");
    automationLog(`测试设备检查通过，将使用 ${deviceIds.length} 台设备`, "done");
    automationLog("预检 3/5：正在检查开发证书权限与数量限制");
    const existing = (automationOptions.certificates || []).filter(item => ["83Q87W3TGH", "5QPB9NHCEI"].includes(item.typeId));
    const rebuiltCertificateIds = rebuildCertificate ? existing.map(item => String(item.id || "").trim()).filter(Boolean) : [];
    const typeResult = await window.appleDeveloper.certificateTypes();
    if (!typeResult?.success) throw new Error(typeResult?.error || "开发证书权限检查失败");
    const developmentType = (typeResult.types || []).find(item => item.id === "83Q87W3TGH");
    if (!developmentType) throw new Error("当前组织不支持 Apple Development 证书");
    if ((rebuildCertificate || !existing.length) && !developmentType.allowed && !(developmentType.reasonCode === 7460 && existing.length)) throw new Error(developmentType.reason || "当前组织没有创建开发证书的权限");
    automationLog("开发证书权限检查通过", "done");
    automationLog("预检 4/5：正在读取已有描述文件");
    const profileResult = await window.appleDeveloper.profiles();
    if (!profileResult?.success) throw new Error(profileResult?.error || "已有描述文件读取失败");
    automationLog("描述文件接口检查通过", "done");
    automationLog("预检 5/5：P12 密码与下载参数检查通过", "done");
    automationLog("全部预检通过，尚未撤销或重新创建任何证书", "done");
    setBusy(button, true, "自动创建中…");
    if (isNew) {
      automationLog(`正在创建 Bundle ID：${identifier}`);
      const createdBundle = await window.appleDeveloper.createBundleId({ name: bundleName, identifier, capabilities: ["IN_APP_PURCHASE", ...(createPushCertificate ? ["PUSH_NOTIFICATIONS"] : [])] });
      if (!createdBundle?.success) throw new Error(createdBundle?.error || "Bundle ID 创建失败");
      const refreshed = await window.appleDeveloper.profileOptions();
      if (!refreshed?.success) throw new Error(refreshed?.error || "Bundle ID 已创建，但无法刷新数据");
      automationOptions = refreshed;
      bundleId = refreshed.bundleIds?.find(item => item.identifier === identifier)?.id;
      if (!bundleId) throw new Error("Bundle ID 已提交，但 Apple 暂未返回，请稍后重试");
      automationLog("Bundle ID 创建完成", "done");
    }
    let certificate = existing[0] ? { ...existing[0], id: existing[0].id, typeId: existing[0].typeId, name: existing[0].name || "Apple Development" } : null;
    if (rebuildCertificate || !certificate) {
      for (const cert of existing) {
        automationLog(`正在撤销旧开发证书：${cert.name}`);
        const revoked = await window.appleDeveloper.revokeCertificate({ id: cert.id, typeId: cert.typeId });
        if (!revoked?.success) throw new Error(revoked?.error || `证书 ${cert.name} 撤销失败`);
      }
      if (existing.length) automationLog(`已撤销 ${existing.length} 张旧开发证书`, "done");
      automationLog("正在创建新的 Apple Development 证书");
      const certResult = await window.appleDeveloper.createCertificate({ typeId: "83Q87W3TGH", appIdId: "" });
      if (!certResult?.success) throw new Error(certResult?.error || "开发证书创建失败");
      assertAutomationServerSync(certResult.sync, "开发证书");
      certificate = { ...(certResult.certificate || {}), id: certResult.certificateId || certResult.certificate?.id || certResult.certificate?.certificateId, typeId: "83Q87W3TGH", name: certResult.certificate?.name || certResult.certificate?.displayName || "Apple Development" };
    } else {
      automationLog(`使用已有开发证书：${certificate.name}`, "done");
    }
    if (!certificate.id) throw new Error("开发证书已创建，但没有返回证书 ID，请刷新后重试");
    automationLog("开发证书创建完成", "done");
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const selectedBundle = (automationOptions.bundleIds || []).find(item => item.id === bundleId);
    const baseName = (isNew ? bundleName : selectedBundle?.name) || "App";
    const bundleIdentifier = selectedBundle?.identifier || identifier;
    const pushCertificate = createPushCertificate ? await createAutomationPushCertificate(bundleId, bundleIdentifier) : null;
    if (createPushCertificate && !pushCertificate) throw new Error("已勾选推送证书，但没有生成可导出 P12 的推送证书，请勾选重建后重试");
    const profileName = `${baseName} Development ${stamp}`;
    await removeExistingAutomationProfiles({ profiles: profileResult.profiles || [], bundleId, bundleIdentifier, specs: [{ type: "IOS_APP_DEVELOPMENT" }], certificateIds: rebuiltCertificateIds });
    await syncAutomationCertificatesToServer([certificate, pushCertificate].filter(Boolean), password, pushPassword);
    automationLog(`正在创建 Development 描述文件（${deviceIds.length} 台设备）`);
    const profile = await window.appleDeveloper.createProfile({ profileType: "IOS_APP_DEVELOPMENT", name: profileName, bundleId, bundleIdentifier, bundleName: baseName, certificateIds: [certificate.id], deviceIds });
    if (!profile?.success) throw new Error(profile?.error || "Development 描述文件创建失败");
    assertAutomationServerSync(profile.sync, "Development 描述文件");
    automationLog("Development 描述文件创建完成", "done");
    await finalizeAutomationArtifacts({ certificates: [certificate, pushCertificate].filter(Boolean), profiles: [profile.profile], bundleIdentifier });
    automationArtifacts = { certificates: [certificate, pushCertificate].filter(Boolean), certificate, development: profile.profile, store: null, adhoc: null, password, pushPassword, bundleIdentifier, includePush: createPushCertificate, packageName: `${baseName}_Development_Files` };
    el("automation-download").classList.add("show");
    automationLog("测试证书和描述文件创建完成", "done");
    openAutomationCompletionDownloadDialog();
  } catch (error) { errorBox.textContent = error.message; automationLog(error.message, "error"); }
  finally { setBusy(button, false); }
}

async function startReleaseAutomation() {
  const errorBox = el("automation-error"); errorBox.textContent = "";
  const isNew = document.querySelector('input[name="automation-bundle-mode"]:checked')?.value === "new";
  const rebuildCertificate = !!el("automation-rebuild-certificate")?.checked;
  const createPushCertificate = !!el("automation-create-push")?.checked;
  const passwordInput = el("automation-p12-password").value;
  const password = passwordInput || defaultP12Password();
  const pushPasswordInput = el("automation-push-password")?.value || "";
  const pushPassword = pushPasswordInput;
  if (rebuildCertificate && !passwordInput) { errorBox.textContent = "请输入 P12 导出密码"; return; }
  if (createPushCertificate && !pushPasswordInput) { errorBox.textContent = "请输入推送 P12 密码"; return; }
  if (!automationOptions) { errorBox.textContent = "正在读取 Apple 数据，请稍后再试"; return; }
  let bundleId = el("automation-bundle").value;
  const bundleName = el("automation-bundle-name").value.trim();
  const identifier = el("automation-bundle-identifier").value.trim();
  if (isNew && (!bundleName || !identifier)) { errorBox.textContent = "请填写描述名称和 Bundle ID"; return; }
  if (isNew && (!/^[A-Za-z0-9 ]+$/.test(bundleName) || !/^[A-Za-z0-9.-]+$/.test(identifier) || identifier.startsWith(".") || identifier.endsWith(".") || identifier.includes(".."))) { errorBox.textContent = "描述名称仅限英文、数字和空格；Bundle ID 仅限字母、数字、点和连字符"; return; }
  if (!isNew && !bundleId) { errorBox.textContent = "请选择 Bundle ID"; return; }
  const button = el("automation-start"); setBusy(button, true, "正在预检…");
  el("automation-progress").classList.add("show"); el("automation-log").replaceChildren(); el("automation-download").classList.remove("show"); automationArtifacts = null;
  try {
    automationLog("预检 1/5：正在刷新当前组织数据");
    const refreshedOptions = await window.appleDeveloper.profileOptions();
    if (!refreshedOptions?.success) throw new Error(refreshedOptions?.error || "当前组织数据读取失败");
    automationOptions = refreshedOptions;
    if (isNew && (automationOptions.bundleIds || []).some(item => String(item.identifier).toLowerCase() === identifier.toLowerCase())) throw new Error(`Identifier“${identifier}”已经创建过了，请选择已有 Bundle ID，不要重复创建`);
    if (!isNew && !(automationOptions.bundleIds || []).some(item => item.id === bundleId)) throw new Error("选择的 Bundle ID 已不存在，请刷新后重新选择");
    const certificateGuard = await ensureAutomationCertificateFiles({
      requirements: ["distribution"],
      rebuildCertificate,
      rebuildLabel: "重建证书",
      flowLabel: "一键创建上架证书和描述",
      certificates: automationOptions.certificates,
    });
    if (!certificateGuard.allowed) { errorBox.textContent = certificateGuard.message; return; }
    automationLog("Bundle ID 检查通过", "done");
    const chosenDevices = [...document.querySelectorAll('input[name="automation-device"]:checked')].map(input => input.value);
    const deviceIds = chosenDevices;
    automationLog("预检 2/5：正在检查测试设备");
    automationLog(deviceIds.length ? `测试设备检查通过，将使用 ${deviceIds.length} 台设备` : "当前组织没有可用测试设备，将只创建 App Store 描述文件", deviceIds.length ? "done" : "error");
    automationLog("预检 3/5：正在检查发布证书权限与数量限制");
    const existing = (automationOptions.certificates || []).filter(item => ["WXV89964HE", "R58UK2EWSO"].includes(item.typeId));
    const rebuiltCertificateIds = rebuildCertificate ? existing.map(item => String(item.id || "").trim()).filter(Boolean) : [];
    const typeResult = await window.appleDeveloper.certificateTypes();
    if (!typeResult?.success) throw new Error(typeResult?.error || "发布证书权限检查失败");
    const releaseType = (typeResult.types || []).find(item => item.id === "WXV89964HE");
    if (!releaseType) throw new Error("当前组织不支持 Apple Distribution 证书");
    if ((rebuildCertificate || !existing.length) && !releaseType.allowed && !(releaseType.reasonCode === 7460 && existing.length)) throw new Error(releaseType.reason || "当前组织没有创建发布证书的权限");
    automationLog("发布证书权限检查通过", "done");
    automationLog("预检 4/5：正在读取已有描述文件");
    const profileResult = await window.appleDeveloper.profiles();
    if (!profileResult?.success) throw new Error(profileResult?.error || "已有描述文件读取失败");
    automationLog("描述文件接口检查通过", "done");
    automationLog("预检 5/5：P12 密码与下载参数检查通过", "done");
    automationLog("全部预检通过，尚未撤销或重新创建任何证书", "done");
    setBusy(button, true, "自动创建中…");
    if (isNew) {
      automationLog(`正在创建 Bundle ID：${identifier}`);
      const createdBundle = await window.appleDeveloper.createBundleId({ name: bundleName, identifier, capabilities: ["IN_APP_PURCHASE", ...(createPushCertificate ? ["PUSH_NOTIFICATIONS"] : [])] });
      if (!createdBundle?.success) throw new Error(createdBundle?.error || "Bundle ID 创建失败");
      const refreshed = await window.appleDeveloper.profileOptions();
      if (!refreshed?.success) throw new Error(refreshed?.error || "Bundle ID 已创建，但无法刷新数据");
      automationOptions = refreshed;
      bundleId = refreshed.bundleIds?.find(item => item.identifier === identifier)?.id;
      if (!bundleId) throw new Error("Bundle ID 已提交，但 Apple 暂未返回，请稍后重试");
      automationLog("Bundle ID 创建完成", "done");
    }
    let certificate = existing[0] ? { ...existing[0], id: existing[0].id, typeId: existing[0].typeId, name: existing[0].name || "Apple Distribution" } : null;
    if (rebuildCertificate || !certificate) {
      for (const cert of existing) {
        automationLog(`正在撤销旧发布证书：${cert.name}`);
        const revoked = await window.appleDeveloper.revokeCertificate({ id: cert.id, typeId: cert.typeId });
        if (!revoked?.success) throw new Error(revoked?.error || `证书 ${cert.name} 撤销失败`);
      }
      if (existing.length) automationLog(`已撤销 ${existing.length} 张旧发布证书`, "done");
      automationLog("正在创建新的 Apple Distribution 证书");
      const certResult = await window.appleDeveloper.createCertificate({ typeId: "WXV89964HE", appIdId: "" });
      if (!certResult?.success) throw new Error(certResult?.error || "发布证书创建失败");
      assertAutomationServerSync(certResult.sync, "发布证书");
      certificate = { ...(certResult.certificate || {}), id: certResult.certificateId || certResult.certificate?.id || certResult.certificate?.certificateId, typeId: "WXV89964HE", name: certResult.certificate?.name || certResult.certificate?.displayName || "Apple Distribution" };
    } else {
      automationLog(`使用已有发布证书：${certificate.name}`, "done");
    }
    if (!certificate.id) throw new Error("发布证书已创建，但没有返回证书 ID，请刷新后重试");
    automationLog("发布证书创建完成", "done");
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const selectedBundle = (automationOptions.bundleIds || []).find(item => item.id === bundleId);
    const baseName = (isNew ? bundleName : selectedBundle?.name) || "App";
    const bundleIdentifier = selectedBundle?.identifier || identifier;
    const pushCertificate = createPushCertificate ? await createAutomationPushCertificate(bundleId, bundleIdentifier) : null;
    if (createPushCertificate && !pushCertificate) throw new Error("已勾选推送证书，但没有生成可导出 P12 的推送证书，请勾选重建后重试");
    const storeName = `${baseName} AppStore ${stamp}`;
    const adhocName = `${baseName} AdHoc ${stamp}`;
    await removeExistingAutomationProfiles({ profiles: profileResult.profiles || [], bundleId, bundleIdentifier, specs: [{ type: "IOS_APP_STORE" }, ...(deviceIds.length ? [{ type: "IOS_APP_ADHOC" }] : [])], certificateIds: rebuiltCertificateIds });
    await syncAutomationCertificatesToServer([certificate, pushCertificate].filter(Boolean), password, pushPassword);
    automationLog("正在创建 App Store 描述文件");
    const store = await window.appleDeveloper.createProfile({ profileType: "IOS_APP_STORE", name: storeName, bundleId, bundleIdentifier, bundleName: baseName, certificateIds: [certificate.id], deviceIds: [] });
    if (!store?.success) throw new Error(store?.error || "App Store 描述文件创建失败");
    assertAutomationServerSync(store.sync, "App Store 描述文件");
    automationLog("App Store 描述文件创建完成", "done");
    let adhoc = null;
    if (deviceIds.length) {
      automationLog(`正在创建 Ad Hoc 描述文件（${deviceIds.length} 台设备）`);
      adhoc = await window.appleDeveloper.createProfile({ profileType: "IOS_APP_ADHOC", name: adhocName, bundleId, bundleIdentifier, bundleName: baseName, certificateIds: [certificate.id], deviceIds });
      if (!adhoc?.success) throw new Error(adhoc?.error || "Ad Hoc 描述文件创建失败");
      assertAutomationServerSync(adhoc.sync, "Ad Hoc 描述文件");
      automationLog("Ad Hoc 描述文件创建完成", "done");
    } else automationLog("账户没有可用测试设备，已跳过 Ad Hoc 描述文件", "error");
    await finalizeAutomationArtifacts({ certificates: [certificate, pushCertificate].filter(Boolean), profiles: [store.profile, adhoc?.profile].filter(Boolean), bundleIdentifier });
    automationArtifacts = { certificates: [certificate, pushCertificate].filter(Boolean), certificate, store: store.profile, adhoc: adhoc?.profile || null, password, pushPassword, bundleIdentifier, includePush: createPushCertificate, packageName: `${baseName}_Distribution_Files` };
    el("automation-download").classList.add("show");
    automationLog("自动创建流程完成", "done");
    openAutomationCompletionDownloadDialog();
  } catch (error) { errorBox.textContent = error.message; automationLog(error.message, "error"); }
  finally { setBusy(button, false); }
}

async function downloadAutomationArtifacts({ button = el("automation-download-button"), errorTarget = el("automation-error") } = {}) {
  if (!automationArtifacts) return { success: false, error: "没有可下载的证书文件" };
  if (!button) return { success: false, error: "下载按钮不可用" };
  setBusy(button, true, "正在下载…");
  try {
    const { certificate, certificates, profiles, store, adhoc, development, password, pushPassword, bundleIdentifier, includePush } = automationArtifacts;
    const result = await window.appleDeveloper.downloadAutomationZip({ certificate, certificates, profiles, store, adhoc, development, password, pushPassword, includePush, bundleIdentifier, packageName: automationArtifacts.packageName || `${store?.name || "Apple_Distribution"}_Files` });
    if (!result?.success && !result?.canceled) throw new Error(result?.error || "ZIP 文件包下载失败");
    return result;
  } catch (error) {
    if (errorTarget) errorTarget.textContent = error.message || "ZIP 文件包下载失败";
    return { success: false, error: error.message || "ZIP 文件包下载失败" };
  }
  finally { setBusy(button, false); }
}

function profilePageActive(token = profileBundleLookupToken) {
  return token === profileBundleLookupToken && !!el("page-profiles") && authenticated;
}

const PROFILE_LIST_LOAD_TIMEOUT_MS = 20000;

function readProfilesWithTimeout(timeoutMs = PROFILE_LIST_LOAD_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({
      success: false,
      timedOut: true,
      error: `读取超过 ${Math.ceil(timeoutMs / 1000)} 秒，请检查网络后重试`,
    }), timeoutMs);
    Promise.resolve()
      .then(() => window.appleDeveloper.profiles())
      .then(result => finish(result), error => finish({ success: false, error: error?.message || "无法获取描述文件" }));
  });
}

function cancelProfileBundleLookups() {
  profileBundleLookupToken += 1;
  if (profileBundleLookupTimer) clearTimeout(profileBundleLookupTimer);
  profileBundleLookupTimer = null;
  if (profileBundleLookupTimerResolve) profileBundleLookupTimerResolve(false);
  profileBundleLookupTimerResolve = null;
}

function waitProfileBundleLookup(ms, token) {
  return new Promise(resolve => {
    if (!profilePageActive(token)) return resolve(false);
    profileBundleLookupTimerResolve = resolve;
    profileBundleLookupTimer = setTimeout(() => {
      profileBundleLookupTimer = null;
      profileBundleLookupTimerResolve = null;
      resolve(profilePageActive(token));
    }, ms);
  });
}

function profileBundleCell(profileId) {
  return [...document.querySelectorAll("[data-profile-bundle-cell]")].find(cell => cell.dataset.profileBundleCell === String(profileId || ""));
}

function profileBundleDisplay(profile = {}, fallback = "—") {
  return String(profile.bundleIdentifier || profile.bundleName || fallback || "—");
}

async function startProfileBundleLookups(rows = [], token = profileBundleLookupToken) {
  const queue = (Array.isArray(rows) ? rows : []).filter(item => item?.id && !item.bundleIdentifier);
  for (let index = 0; index < queue.length; index += 1) {
    if (!profilePageActive(token)) return;
    if (index > 0 && !await waitProfileBundleLookup(1000, token)) return;
    const item = queue[index];
    const cell = profileBundleCell(item.id);
    if (cell) {
      cell.classList.add("loading");
      cell.classList.remove("error");
      cell.textContent = "读取中…";
      cell.title = "后台读取包名中，不影响列表操作";
    }
    try {
      const result = await window.appleDeveloper.profileBundle({
        id: item.id,
        name: item.name,
        bundleId: item.bundleId,
        bundleIdentifier: item.bundleIdentifier,
        bundleName: item.bundleName,
        profileType: item.profileType,
        certificateIds: item.certificateIds,
        deviceIds: item.deviceIds,
      });
      if (!profilePageActive(token)) return;
      const profile = result?.profile || {};
      const value = result?.success ? profileBundleDisplay(profile) : "未读取";
      const nextCell = profileBundleCell(item.id);
      if (nextCell) {
        nextCell.classList.toggle("error", !result?.success || value === "—" || value === "未读取");
        nextCell.classList.remove("loading");
        nextCell.textContent = value;
        nextCell.title = result?.success ? value : (result?.error || "包名读取失败");
      }
      if (result?.success) {
        pageProfileDeleteButton(item.id)?.setAttribute("data-bundle", profile.bundleIdentifier || profile.bundleName || "");
      }
    } catch (error) {
      if (!profilePageActive(token)) return;
      const nextCell = profileBundleCell(item.id);
      if (nextCell) {
        nextCell.classList.remove("loading");
        nextCell.classList.add("error");
        nextCell.textContent = "未读取";
        nextCell.title = error.message || "包名读取失败";
      }
    }
  }
}

function pageProfileDeleteButton(profileId) {
  return [...document.querySelectorAll(".profile-delete")].find(button => button.dataset.id === String(profileId || ""));
}

function profileCanRecoverCertificate(profile = {}) {
  const state = String(profile.state || "").trim().toUpperCase();
  if (["REVOKED", "EXPIRED", "INVALID", "DISABLED", "INACTIVE"].includes(state)) return true;
  const expiration = new Date(profile.expirationDate || "");
  return !Number.isNaN(expiration.getTime()) && expiration.getTime() <= Date.now();
}

function recoveredProfileName(name = "") {
  return String(name || "描述文件");
}

function profileRecoveryPurpose({ originalName = "描述文件", certificateAction = "" } = {}) {
  return `“一键恢复描述”用于替换因证书过期、撤销或失效而无法继续使用的描述文件。\n\n软件会先识别原描述文件的证书类型；本次将${certificateAction}，再按原 Bundle ID、描述类型和测试设备创建替代描述文件。证书、P12 和新描述文件都会同步到服务器。\n\n新资料核验成功后，原失效描述文件会自动删除；不会撤销旧证书。\n\n确定恢复“${originalName}”吗？`;
}

async function performProfileCertificateRecovery({ profileId = "", originalName = "描述文件", showPurpose = true } = {}) {
  const planned = await window.appleDeveloper.profileRecoveryPlan({ profileId });
  if (!planned?.success || !planned.plan) throw new Error(planned?.error || "描述文件恢复预检失败");
  const plan = planned.plan;
  const certificateAction = plan.action === "reuse"
    ? `复用已有 ${plan.certificateTypeName || "同类型"} 证书“${plan.certificate?.name || plan.certificate?.id || ""}”`
    : `新建 ${plan.certificateTypeName || "同类型"} 证书`;
  if (showPurpose && !confirm(profileRecoveryPurpose({ originalName, certificateAction }))) return { canceled: true };
  let p12Password = "";
  if (plan.action === "create") {
    p12Password = prompt(`原 ${plan.certificateTypeName || "签名"} 证书没有可复用的有效资料。\n\n将新建同类型证书并生成 P12，请输入新 P12 密码：`, "") ?? "";
    p12Password = p12Password.trim();
    if (!p12Password) return { canceled: true };
  }
  let certificate;
  if (plan.action === "reuse") {
    certificate = plan.certificate;
    if (plan.reuseNeedsSync) {
      const synced = await window.appleDeveloper.syncRecoveryCertificate({ certificate });
      if (!synced?.success) throw new Error(synced?.error || "复用证书同步失败");
    }
  } else {
    const created = await window.appleDeveloper.createCertificate({ typeId: plan.certificateTypeId, p12Password });
    if (!created?.success) throw new Error(created?.error || `${plan.certificateTypeName || "证书"}创建失败`);
    assertAutomationServerSync(created.sync, `${plan.certificateTypeName || "证书"}`);
    certificate = {
      ...(created.certificate || {}),
      id: created.certificateId || created.certificate?.id,
      typeId: plan.certificateTypeId,
      name: created.certificate?.name || plan.certificateTypeName || "恢复证书",
    };
    if (!certificate.id) throw new Error("新证书没有返回 ID，请刷新后重试");
    const synced = await window.appleDeveloper.syncLocalCertificateArtifacts({ certificates: [certificate], password: p12Password });
    if (!synced?.success) throw new Error(synced?.error || "新证书 P12 同步到服务器失败");
  }
  const profile = plan.profile || {};
  const createdProfile = await window.appleDeveloper.createProfile({
    profileType: profile.profileType,
    name: recoveredProfileName(profile.name),
    bundleId: profile.bundleId,
    bundleIdentifier: profile.bundleIdentifier,
    bundleName: profile.bundleName,
    certificateIds: [certificate.id],
    deviceIds: profile.deviceIds || [],
  });
  if (!createdProfile?.success) throw new Error(createdProfile?.error || "替代描述文件创建失败");
  assertAutomationServerSync(createdProfile.sync, "替代描述文件");
  const finalized = await window.appleDeveloper.finalizeProfileRecovery({ certificate, profile: createdProfile.profile });
  if (!finalized?.success) throw new Error(finalized?.error || "恢复资料服务器核对失败");
  const removed = await window.appleDeveloper.deleteProfile({ id: profile.id });
  if (!removed?.success) throw new Error(`新描述文件已创建并同步，但原失效描述文件删除失败：${removed?.error || "未知错误"}`);
  markAppleDeveloperResourcePagesStale();
  return { success: true, action: plan.action, certificateTypeName: plan.certificateTypeName || "同类型" };
}

async function recoverProfileCertificate(button) {
  const originalName = button.dataset.name || "描述文件";
  setBusy(button, true, "正在预检…");
  try {
    const result = await performProfileCertificateRecovery({ profileId: button.dataset.id, originalName });
    if (result?.canceled) return;
    alert(`描述文件已恢复。\n\n已${result.action === "reuse" ? "复用" : "新建"}${result.certificateTypeName}证书，并已同步证书、P12 和新描述文件到服务器。原失效描述文件已删除。`);
    await loadProfiles();
  } catch (error) {
    alert(error.message || "描述文件恢复失败");
  } finally {
    setBusy(button, false);
  }
}

async function recoverAllInvalidProfiles(button, profiles = []) {
  const targets = profiles.filter(profileCanRecoverCertificate);
  if (!targets.length) return alert("当前没有需要恢复的失效描述文件");
  const purpose = `“一键恢复描述”用于批量替换当前列表中因证书过期、撤销或失效而无法使用的描述文件。\n\n系统会逐条识别原证书类型，优先复用同类型有效证书；确实没有可复用证书时才新建，并要求输入该证书的 P12 密码。每条新资料同步并核验服务器成功后，会自动删除对应的旧失效描述文件。\n\n本次将处理 ${targets.length} 个失效描述文件；不会撤销旧证书。确定继续吗？`;
  if (!confirm(purpose)) return;
  setBusy(button, true, "正在恢复…");
  const succeeded = [];
  const failed = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      button.textContent = `正在恢复 ${index + 1}/${targets.length}…`;
      try {
        const result = await performProfileCertificateRecovery({ profileId: target.id, originalName: target.name, showPurpose: false });
        if (result?.success) succeeded.push(target.name || target.id);
      } catch (error) {
        failed.push(`${target.name || target.id}：${error.message || "恢复失败"}`);
      }
    }
    markAppleDeveloperResourcePagesStale();
    await loadProfiles();
    alert(failed.length ? `已恢复 ${succeeded.length} 个描述文件。\n\n以下 ${failed.length} 个未完成：\n${failed.map(item => `• ${item}`).join("\n")}` : `已完成 ${succeeded.length} 个失效描述文件的恢复。新资料已同步服务器，旧失效描述文件已删除。`);
  } finally {
    setBusy(button, false);
  }
}

async function loadProfiles() {
  cancelProfileBundleLookups();
  const loadToken = profileBundleLookupToken;
  const page = el("page-profiles");
  page.innerHTML = '<div class="module"><div class="module-bar"><span class="module-title">描述文件管理</span></div><div class="loading-state">正在读取 Apple Developer 数据…</div></div>';
  const result = await readProfilesWithTimeout();
  if (!profilePageActive(loadToken)) return;
  if (!result?.success) {
    if (result?.authenticated === false) applyStatus({ authenticated: false });
    if (result?.teamRequired) ensureTeamSelection(true);
    const title = result?.timedOut ? "读取超时" : "读取失败";
    page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">描述文件管理</span><button class="primary" onclick="refreshModule('profiles')">重试</button></div><div class="empty"><div class="empty-icon">!</div><strong>${title}</strong><span>${escapeHTML(result?.error || "无法获取描述文件")}</span></div></div>`;
    return;
  }
  const rows = result.profiles || [];
  const content = rows.length ? `<div class="profile-table-wrap"><table class="data-table profile-table"><thead><tr><th>名称</th><th>包名</th><th>类型</th><th>平台</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(item => {
    const bundleText = profileBundleDisplay(item, item.bundleIdentifier ? "—" : "读取中…");
    const loading = !item.bundleIdentifier;
    const recoverButton = profileCanRecoverCertificate(item)
      ? `<button class="secondary profile-recover" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.name)}">一键恢复描述</button>`
      : "";
    return `<tr><td class="bundle-name">${escapeHTML(item.name)}</td><td class="profile-bundle-id ${loading ? "loading" : ""}" data-profile-bundle-cell="${escapeHTML(item.id)}" title="${escapeHTML(loading ? "后台读取包名中，不影响列表操作" : bundleText)}">${escapeHTML(bundleText)}</td><td>${escapeHTML(localizedProfileType(item))}</td><td>${escapeHTML(item.platform)}</td><td>${escapeHTML(formatCertificateDate(item.expirationDate))}</td><td class="profile-status">${escapeHTML(localizedProfileStatus(item))}</td><td><div class="profile-actions"><button class="secondary profile-download" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.name)}">下载</button>${recoverButton}<button class="profile-delete" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.name)}" data-bundle="${escapeHTML(item.bundleIdentifier || item.bundleName || "")}">删除</button></div></td></tr>`;
  }).join("")}</tbody></table></div>` : '<div class="empty"><div class="empty-icon">◇</div><strong>暂无描述文件</strong><span>点击“创建描述文件”开始创建</span></div>';
  const invalidProfileCount = rows.filter(profileCanRecoverCertificate).length;
  page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">描述文件管理</span><span class="table-meta">共 ${Number(result.total || rows.length)} 条</span><div class="module-actions"><button class="secondary" id="add-profile" type="button">创建描述文件</button><button class="secondary" id="recover-all-profiles" type="button" ${invalidProfileCount ? "" : "disabled"}>一键恢复描述</button><button class="primary icon-button icon-refresh" id="profiles-refresh" type="button" title="刷新" aria-label="刷新"><span aria-hidden="true">↻</span></button></div></div>${content}</div>`;
  startProfileBundleLookups(rows, loadToken);
  el("add-profile")?.addEventListener("click", showCreateProfile);
  el("recover-all-profiles")?.addEventListener("click", event => recoverAllInvalidProfiles(event.currentTarget, rows));
  el("profiles-refresh")?.addEventListener("click", () => refreshModule("profiles"));
  page.querySelectorAll(".profile-download").forEach(button => button.addEventListener("click", async () => {
    setBusy(button, true, "下载中…");
    try { const result = await window.appleDeveloper.downloadProfile({ id: button.dataset.id, name: button.dataset.name }); if (!result?.success && !result?.canceled) throw new Error(result?.error || "描述文件下载失败"); }
    catch (error) { alert(error.message); }
    finally { setBusy(button, false); }
  }));
  page.querySelectorAll(".profile-recover").forEach(button => button.addEventListener("click", () => recoverProfileCertificate(button)));
  page.querySelectorAll(".profile-delete").forEach(button => button.addEventListener("click", async () => {
    const description = `${button.dataset.name || "描述文件"}${button.dataset.bundle ? `（${button.dataset.bundle}）` : ""}`;
    if (!confirm(`确定删除描述文件 ${description} 吗？\n\n删除后无法恢复，使用该描述文件签名的后续构建将需要重新生成描述文件。`)) return;
    setBusy(button, true, "删除中…");
    try {
      const removed = await window.appleDeveloper.deleteProfile({ id: button.dataset.id });
      if (!removed?.success) throw new Error(removed?.error || "描述文件删除失败");
      await loadProfiles();
    } catch (error) {
      alert(error.message || "描述文件删除失败");
      setBusy(button, false);
    }
  }));
}

function profileSelectedType() { return profileOptions?.types?.find(item => item.id === document.querySelector('input[name="profile-type"]:checked')?.value); }
function profileSelectedBundle() { return (profileOptions?.bundleIds || []).find(item => String(item.id) === String(profileSelectedBundleId)); }
function profileSelectedCertificate() { return (profileOptions?.certificates || []).find(item => String(item.id) === String(profileSelectedCertificateId)); }
function checkedProfileValues(name) {
  if (name === "profile-device") return [...profileSelectedDeviceIds];
  if (name === "profile-bundle") return profileSelectedBundleId ? [profileSelectedBundleId] : [];
  if (name === "profile-certificate") return profileSelectedCertificateId ? [profileSelectedCertificateId] : [];
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
}
function profileOption(name, value, title, detail, radio = true) { return `<label class="profile-option"><input type="${radio ? "radio" : "checkbox"}" name="${name}" value="${escapeHTML(value)}"><span><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)}</small></span></label>`; }
function profileMatchesQuery(item, query, fields) {
  if (!query) return true;
  return fields.map(field => String(item?.[field] || "")).join(" ").toLowerCase().includes(query);
}
function profilePlatformPill(platform) {
  const label = String(platform || "IOS").trim().toUpperCase() || "IOS";
  return `<span class="profile-platform-pill">${escapeHTML(label)}</span>`;
}
function profileCertificateStatusMeta(item = {}) {
  const expiration = new Date(item.expirationDate || "");
  if (!Number.isNaN(expiration.getTime())) {
    const remainingDays = Math.ceil((expiration.getTime() - Date.now()) / 86400000);
    if (remainingDays < 0) return { text: "已过期", tone: "expired" };
    if (remainingDays <= 30) return { text: "将过期", tone: "warning" };
  }
  const state = String(item.status || item.state || "").toUpperCase();
  if (["REVOKED", "INVALID", "DISABLED", "EXPIRED"].includes(state)) return { text: localizedCertificateStatus(item.status || item.state), tone: "expired" };
  return { text: "有效", tone: "valid" };
}
function profileCertificateUsable(item = {}) {
  const status = profileCertificateStatusMeta(item);
  return status.tone !== "expired";
}
function renderProfileBundleOptions() {
  const all = profileOptions?.bundleIds || [];
  if (profileSelectedBundleId && !all.some(item => String(item.id) === String(profileSelectedBundleId))) profileSelectedBundleId = "";
  const query = (el("profile-bundle-search")?.value || "").trim().toLowerCase();
  const rows = all.filter(item => profileMatchesQuery(item, query, ["name", "identifier", "platform"]));
  if (el("profile-bundle-count")) el("profile-bundle-count").textContent = `共 ${all.length} 个 Bundle ID · 单选`;
  el("profile-bundle-options").innerHTML = rows.length ? `<div class="profile-picker-table profile-bundle-picker"><div class="profile-picker-head"><span></span><span>名称</span><span>Bundle ID</span><span>平台</span></div>${rows.map(item => { const selected = String(item.id) === String(profileSelectedBundleId); return `<label class="profile-picker-row ${selected ? "selected" : ""}"><input type="radio" name="profile-bundle" value="${escapeHTML(item.id)}" ${selected ? "checked" : ""}><span class="profile-picker-name">${escapeHTML(item.name)}</span><span class="profile-picker-code">${escapeHTML(item.identifier)}</span><span>${profilePlatformPill(item.platform)}</span></label>`; }).join("")}</div>` : '<div class="profile-empty-option">没有找到匹配的 Bundle ID</div>';
  el("profile-bundle-options").querySelectorAll('input[name="profile-bundle"]').forEach(input => input.addEventListener("change", () => { profileSelectedBundleId = input.value; el("profile-create-error").textContent = ""; renderProfileBundleOptions(); }));
  updateProfileCreateSelectionSummary();
}
function renderProfileCertificateOptions() {
  const type = profileSelectedType();
  const allowed = new Set(type?.certificateTypeIds || []);
  const all = (profileOptions?.certificates || []).filter(item => allowed.has(item.typeId) && profileCertificateUsable(item));
  if (profileSelectedCertificateId && !all.some(item => String(item.id) === String(profileSelectedCertificateId))) profileSelectedCertificateId = "";
  const query = (el("profile-certificate-search")?.value || "").trim().toLowerCase();
  const rows = all.filter(item => profileMatchesQuery({ ...item, localizedType: localizedCertificateType(item), formattedExpiration: formatCertificateDate(item.expirationDate) }, query, ["name", "localizedType", "formattedExpiration", "status"]));
  if (el("profile-certificate-count")) el("profile-certificate-count").textContent = `共 ${all.length} 张可用 · 单选`;
  el("profile-certificate-options").innerHTML = rows.length ? `<div class="profile-picker-table profile-certificate-picker"><div class="profile-picker-head"><span></span><span>名称</span><span>证书类型</span><span>到期时间</span><span>状态</span></div>${rows.map(item => { const selected = String(item.id) === String(profileSelectedCertificateId); const status = profileCertificateStatusMeta(item); return `<label class="profile-picker-row ${selected ? "selected" : ""}"><input type="radio" name="profile-certificate" value="${escapeHTML(item.id)}" ${selected ? "checked" : ""}><span class="profile-picker-name">${escapeHTML(item.name)}</span><span>${escapeHTML(localizedCertificateType(item))}</span><span class="profile-picker-date">${escapeHTML(formatCertificateDate(item.expirationDate))}</span><span><span class="profile-status-pill ${status.tone}">${escapeHTML(status.text)}</span></span></label>`; }).join("")}</div>` : '<div class="profile-empty-option">当前团队没有适用于该类型的有效证书</div>';
  el("profile-certificate-options").querySelectorAll('input[name="profile-certificate"]').forEach(input => input.addEventListener("change", () => { profileSelectedCertificateId = input.value; el("profile-create-error").textContent = ""; renderProfileCertificateOptions(); }));
  updateProfileCreateSelectionSummary();
}
function updateProfileCreateSelectionSummary() {
  const target = el("profile-create-selection");
  if (!target) return;
  if (profileCreateStep === 1) {
    const bundle = profileSelectedBundle();
    target.innerHTML = bundle ? `已选择： <strong>${escapeHTML(bundle.name)}</strong> · Bundle ID： <b>${escapeHTML(bundle.identifier)}</b>` : "请选择一个 Bundle ID";
    return;
  }
  if (profileCreateStep === 2) {
    const certificate = profileSelectedCertificate();
    target.innerHTML = certificate ? `已选择证书： <strong>${escapeHTML(certificate.name)}</strong> · 可被多个描述文件复用` : "请选择一张签名证书";
    return;
  }
  if (profileCreateStep === 3) {
    const type = profileSelectedType();
    target.textContent = type?.needsDevices ? `已选择设备：${profileSelectedDeviceIds.size} 台` : "该类型不需要选择设备";
    return;
  }
  target.textContent = profileCreateStep === 4 ? "确认信息后将创建并下载描述文件" : "按步骤选择描述文件类型、Bundle ID、证书和设备";
}

function renderProfileDevices() {
  const type = profileSelectedType();
  const tools = el("profile-device-tools");
  if (!type?.needsDevices) {
    tools.classList.add("hidden");
    el("profile-device-options").innerHTML = '<div class="profile-no-device-needed">该类型的描述文件不包含测试设备，可以直接进入下一步。</div>';
    return;
  }
  tools.classList.remove("hidden");
  const query = el("profile-device-search").value.trim().toLowerCase();
  const rows = (profileOptions.devices || []).filter(item => !query || `${item.name} ${item.type} ${item.udid}`.toLowerCase().includes(query));
  const selected = profileSelectedDeviceIds;
  el("profile-device-options").innerHTML = rows.length ? `<div class="profile-device-list"><div class="profile-device-head"><span></span><span>设备名称</span><span>设备类型</span><span>UDID</span></div>${rows.map(item => `<label class="profile-device-row"><input type="checkbox" name="profile-device" value="${escapeHTML(item.id)}" ${selected.has(String(item.id)) ? "checked" : ""}><span class="profile-device-name">${escapeHTML(item.name)}</span><span class="profile-device-type">${escapeHTML(item.type)}</span><span class="profile-device-udid">${escapeHTML(item.udid)}</span></label>`).join("")}</div>` : '<div class="profile-device-no-result">没有找到匹配的设备</div>';
  el("profile-device-options").querySelectorAll('input[name="profile-device"]').forEach(input => input.addEventListener("change", () => { input.checked ? profileSelectedDeviceIds.add(input.value) : profileSelectedDeviceIds.delete(input.value); updateProfileDeviceSelection(); }));
  updateProfileDeviceSelection();
}

function updateProfileDeviceSelection() {
  const all = [...document.querySelectorAll('input[name="profile-device"]')];
  const checked = all.filter(input => input.checked);
  const totalSelected = checkedProfileValues("profile-device").length;
  const selectAll = el("profile-device-select-all");
  selectAll.checked = all.length > 0 && checked.length === all.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  el("profile-device-count").textContent = `已选择 ${totalSelected} 台${all.length ? ` · 当前显示 ${all.length} 台` : ""}`;
  updateProfileCreateSelectionSummary();
}

async function showCreateProfile() {
  profileOptions = null; profileCreateStep = 0; profileSelectedBundleId = ""; profileSelectedCertificateId = ""; profileSelectedDeviceIds = new Set();
  el("profile-create-mask").classList.add("show");
  el("profile-create-error").textContent = "正在读取当前团队的真实 App ID、证书和设备…";
  el("profile-create-next").disabled = true;
  el("profile-name-input").value = ""; el("profile-offline-input").checked = false;
  if (el("profile-bundle-search")) el("profile-bundle-search").value = "";
  if (el("profile-certificate-search")) el("profile-certificate-search").value = "";
  if (el("profile-device-search")) el("profile-device-search").value = "";
  el("profile-type-options").innerHTML = '<div class="profile-empty-option">正在读取描述文件类型…</div>';
  el("profile-bundle-options").innerHTML = '<div class="profile-empty-option">正在读取 Bundle ID…</div>';
  el("profile-certificate-options").innerHTML = '<div class="profile-empty-option">请选择描述文件类型后继续</div>';
  renderProfileCreateStep();
  try {
    const result = await window.appleDeveloper.profileOptions();
    if (!result?.success) throw new Error(result?.error || "描述文件选项读取失败");
    profileOptions = result;
    const typeGroup = (group, title) => `<section class="profile-type-group"><h3>${title}</h3>${(result.types || []).filter(item => item.group === group).map(item => profileOption("profile-type", item.id, item.name, item.description)).join("")}</section>`;
    el("profile-type-options").innerHTML = typeGroup("development", "开发") + typeGroup("distribution", "分发");
    el("profile-type-options").querySelectorAll('input[name="profile-type"]').forEach(input => input.addEventListener("change", () => { profileSelectedCertificateId = ""; profileSelectedDeviceIds = new Set(); updateProfileCreateSelectionSummary(); }));
    renderProfileBundleOptions();
    el("profile-create-error").textContent = "";
    el("profile-create-next").disabled = false;
    renderProfileCreateStep();
  } catch (error) { el("profile-create-error").textContent = error.message; }
}

function renderProfileCreateStep() {
  document.querySelectorAll(".profile-create-step").forEach(section => section.classList.toggle("active", Number(section.dataset.profileStep) === profileCreateStep));
  [...el("profile-create-progress").children].forEach((item, index) => item.classList.toggle("done", index <= profileCreateStep));
  el("profile-create-back").style.visibility = profileCreateStep ? "visible" : "hidden";
  el("profile-create-next").textContent = profileCreateStep === 4 ? "创建并下载" : "下一步";
  updateProfileCreateSelectionSummary();
}

function validateProfileCreateStep() {
  if (profileCreateStep === 0 && !profileSelectedType()) return "请选择描述文件类型";
  if (profileCreateStep === 1 && !profileSelectedBundleId) return "请选择 Bundle ID";
  if (profileCreateStep === 2 && !profileSelectedCertificateId) return "请选择一张有效签名证书";
  if (profileCreateStep === 3 && profileSelectedType()?.needsDevices && !checkedProfileValues("profile-device").length) return "请至少选择一台已启用设备";
  if (profileCreateStep === 4 && !el("profile-name-input").value.trim()) return "请输入描述文件名称";
  return "";
}

function prepareProfileStep(step) {
  const type = profileSelectedType();
  if (step === 1) renderProfileBundleOptions();
  if (step === 2) {
    renderProfileCertificateOptions();
  }
  if (step === 3) {
    el("profile-step-four-title").textContent = type?.needsDevices ? "4. 选择设备" : "4. 设备（无需选择）";
    el("profile-device-search").value = "";
    renderProfileDevices();
  }
  if (step === 4) {
    const bundle = profileSelectedBundle();
    const certificateNames = checkedProfileValues("profile-certificate").map(id => profileOptions.certificates.find(item => item.id === id)?.name).filter(Boolean);
    const deviceNames = checkedProfileValues("profile-device").map(id => profileOptions.devices.find(item => item.id === id)?.name).filter(Boolean);
    el("profile-offline-row").classList.toggle("hidden", type?.group !== "development");
    el("profile-create-summary").innerHTML = `<dt>类型</dt><dd>${escapeHTML(type?.name)}</dd><dt>App ID</dt><dd>${escapeHTML(`${bundle?.name || ""} (${bundle?.identifier || ""})`)}</dd><dt>证书</dt><dd>${escapeHTML(certificateNames.join("、"))}</dd><dt>设备</dt><dd>${escapeHTML(type?.needsDevices ? deviceNames.join("、") : "不需要")}</dd>`;
  }
  updateProfileCreateSelectionSummary();
}

async function advanceProfileCreate() {
  const error = validateProfileCreateStep(); el("profile-create-error").textContent = error;
  if (error) return;
  if (profileCreateStep < 4) { profileCreateStep += 1; prepareProfileStep(profileCreateStep); renderProfileCreateStep(); return; }
  const button = el("profile-create-next"); setBusy(button, true, "Apple 正在生成…");
  try {
    const selectedBundleId = profileSelectedBundleId;
    const selectedBundle = (profileOptions.bundleIds || []).find(item => item.id === selectedBundleId);
    const result = await window.appleDeveloper.createProfile({ profileType: profileSelectedType().id, name: el("profile-name-input").value.trim(), bundleId: selectedBundleId, bundleIdentifier: selectedBundle?.identifier || "", bundleName: selectedBundle?.name || "", certificateIds: checkedProfileValues("profile-certificate"), deviceIds: checkedProfileValues("profile-device"), offline: !el("profile-offline-row").classList.contains("hidden") && el("profile-offline-input").checked });
    if (!result?.success) throw new Error(result?.error || "描述文件创建失败");
    const download = await window.appleDeveloper.downloadProfile({ id: result.profile.id, name: result.profile.name });
    if (!download?.success && !download?.canceled) throw new Error(download?.error || "描述文件已创建，但下载失败");
    el("profile-create-mask").classList.remove("show"); await loadProfiles();
  } catch (error) { el("profile-create-error").textContent = error.message; }
  finally { setBusy(button, false); }
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const certificateTypeChineseNames = {
  "83Q87W3TGH": "Apple 开发证书",
  "WXV89964HE": "Apple 发布证书",
  "5QPB9NHCEI": "iOS 应用开发证书",
  "R58UK2EWSO": "IOS发布(appstore和正式环境测试)",
  "749Y1QAGU7": "Mac 开发证书",
  "HXZEUKP0FP": "Mac 应用发布证书",
  "2PQI8IDXNH": "Mac 安装包发布证书",
  "OYVN2GW35E": "Developer ID 安装包证书",
  "W0EURJRMC5": "Developer ID 应用证书",
  "JKG5JZ54H7": "Apple 推送证书（测试环境）",
  "UPV3DW712I": "Apple 推送证书（测试与生产环境）",
  "Y3B2F3TYSI": "Wallet 凭证类型证书",
  "OTN2F3NNP6": "Wallet 订单类型证书",
  "3T2ZP62QW8": "网站推送证书",
  "XNL7FFDH2T": "Swift 软件包集合证书",
  "R8RN858G54": "Swift 软件包证书",
  "FGQUP4785Z": "WatchKit 服务证书",
  "E5D663CMZW": "VoIP 服务证书",
  "T44PTHVNID": "Apple Pay 支付处理证书",
  "MD8Q2VRT6A": "Apple Pay 商户身份证书",
};

const certificateTypeChineseFallbacks = {
  "Apple Development": "Apple 开发证书", "Apple Distribution": "Apple 发布证书",
  "iOS Development": "iOS 应用开发证书", "iOS Distribution": "IOS发布(appstore和正式环境测试)",
  "Mac Development": "Mac 开发证书", "Mac App Distribution": "Mac 应用发布证书",
  "Mac Installer Distribution": "Mac 安装包发布证书", "Developer ID Installer": "Developer ID 安装包证书",
  "Developer ID Application": "Developer ID 应用证书",
};

function localizedCertificateType(item) {
  return certificateTypeChineseNames[item.typeId] || certificateTypeChineseFallbacks[item.typeName] || item.typeName || "未知证书";
}

function formatCertificateDate(value) {
  if (!value || value === "—") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function localizedCertificateStatus(value) {
  return ({ Issued: "已签发", Active: "有效", Expired: "已过期", Revoked: "已撤销", Pending: "待处理" })[String(value)] || value || "—";
}

function localizedProfileStatus(item) {
  const expiration = new Date(item?.expirationDate || "");
  if (!Number.isNaN(expiration.getTime()) && expiration.getTime() <= Date.now()) return "已过期";
  const value = String(item?.state || "").trim().toUpperCase();
  return ({
    ACTIVE: "有效",
    ENABLED: "有效",
    VALID: "有效",
    EXPIRED: "已过期",
    INVALID: "无效",
    REVOKED: "已撤销",
    DISABLED: "已停用",
    INACTIVE: "未启用",
    PENDING: "待处理",
    PROCESSING: "处理中",
  })[value] || "状态未知";
}

function localizedProfileType(item) {
  const value = String(item?.profileType || item?.type || "").toUpperCase();
  return ({
    IOS_APP_DEVELOPMENT: "iOS App 开发",
    TVOS_APP_DEVELOPMENT: "tvOS App 开发",
    MAC_APP_DEVELOPMENT: "macOS App 开发",
    DRIVERKIT_APP_DEVELOPMENT: "DriverKit 开发",
    IOS_APP_ADHOC: "Ad Hoc 分发",
    TVOS_APP_ADHOC: "tvOS Ad Hoc 分发",
    IOS_APP_STORE: "App Store Connect",
    TVOS_APP_STORE: "tvOS App Store Connect",
    MAC_APP_STORE: "Mac App Store Connect",
    MAC_APP_DIRECT: "Developer ID",
  })[value] || item?.type || "未知类型";
}

async function loadBundleIds() {
  const page = el("page-bundle");
  page.innerHTML = '<div class="module"><div class="module-bar"><span class="module-title">Bundle ID 管理</span></div><div class="loading-state">正在读取 Apple Developer 数据…</div></div>';
  const result = await window.appleDeveloper.bundleIds();
  if (!result?.success) {
    if (result?.authenticated === false) applyStatus({ authenticated: false });
    if (result?.teamRequired) ensureTeamSelection(true);
    page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">Bundle ID 管理</span><button class="primary" onclick="refreshModule('bundle')">重试</button></div><div class="empty"><div class="empty-icon">!</div><strong>读取失败</strong><span>${escapeHTML(result?.error || "无法获取 Bundle ID")}</span></div></div>`;
    return;
  }
  const rows = result.bundleIds || [];
  const content = rows.length ? `<table class="data-table bundle-table"><thead><tr><th>名称</th><th>Bundle ID</th><th>平台</th><th>操作</th></tr></thead><tbody>${rows.map(item => `<tr><td class="bundle-name">${escapeHTML(item.name)}</td><td class="bundle-id">${escapeHTML(item.identifier)}</td><td>${escapeHTML(item.platform)}</td><td><div class="bundle-actions"><button class="secondary bundle-edit" type="button" data-id="${escapeHTML(item.id)}">修改</button><button class="bundle-delete" type="button" data-id="${escapeHTML(item.id)}" data-name="${escapeHTML(item.name)}" data-identifier="${escapeHTML(item.identifier)}">删除</button></div></td></tr>`).join("")}</tbody></table>` : '<div class="empty"><div class="empty-icon">◉</div><strong>暂无 Bundle ID</strong><span>当前开发者团队下没有可显示的数据</span></div>';
  page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">Bundle ID 管理</span><span class="table-meta">共 ${Number(result.total || rows.length)} 条</span><div class="module-actions"><button class="secondary" id="add-bundle-id" type="button">添加 Bundle ID</button><button class="primary icon-button icon-refresh" id="bundle-refresh" type="button" title="刷新" aria-label="刷新"><span aria-hidden="true">↻</span></button></div></div><div class="bundle-table-wrap">${content}</div></div>`;
  el("add-bundle-id")?.addEventListener("click", showCreateBundleId);
  el("bundle-refresh")?.addEventListener("click", () => refreshModule("bundle"));
  page.querySelectorAll(".bundle-edit").forEach(button => button.addEventListener("click", () => showEditBundleId(button.dataset.id)));
  page.querySelectorAll(".bundle-delete").forEach(button => button.addEventListener("click", () => deleteBundleId(button)));
}

function bundleCapabilityIconHTML(capability = {}) {
  const image = String(capability.imageUrl || "");
  const url = image.startsWith("/") ? `https://developer.apple.com${image}` : image;
  if (/^https:\/\/developer\.apple\.com\/.+\.svg$/i.test(url)) return `<img src="${escapeHTML(url)}" alt="">`;
  return `<span>${escapeHTML(String(capability.name || capability.id || "?").trim().slice(0, 1).toUpperCase() || "?")}</span>`;
}

const BUNDLE_CAPABILITY_COMMON_ORDER = [
  "ASSOCIATED_DOMAINS",
  "IN_APP_PURCHASE",
  "SIGN_IN_WITH_APPLE",
  "APPLE_ID_AUTH",
  "PUSH_NOTIFICATIONS",
  "APP_GROUPS",
  "ICLOUD",
  "APPLE_PAY",
  "GAME_CENTER",
  "MAPS",
];

const BUNDLE_CAPABILITY_ZH = {
  IN_APP_PURCHASE: { name: "App 内购买项目", description: "允许 App 销售数字内容、订阅或其他 App 内购买项目。" },
  ASSOCIATED_DOMAINS: { name: "Associated Domains", description: "用于 Universal Links、Shared Web Credentials、App Clips 等域名关联和回调能力。" },
  ASSOCIATED_DOMAINS_MANAGED: { name: "Associated Domains（MDM 管理）", description: "用于 MDM 管理的关联域名能力，和普通 Universal Links 回调能力不同。" },
  PUSH_NOTIFICATIONS: { name: "推送通知", description: "启用 Apple Push Notification service，让 App 接收远程通知。" },
  SIGN_IN_WITH_APPLE: { name: "苹果登录", description: "允许用户使用 Apple ID 登录 App 或网站。" },
  APPLE_ID_AUTH: { name: "苹果登录", description: "允许用户使用 Apple ID 登录 App 或网站。" },
  APP_GROUPS: { name: "App Groups", description: "让同一开发团队的多个 App 或扩展共享容器和数据。" },
  ICLOUD: { name: "iCloud", description: "允许 App 使用 iCloud 容器、CloudKit 或文档存储。" },
  APPLE_PAY: { name: "Apple Pay", description: "允许 App 通过 Apple Pay 处理支付。" },
  GAME_CENTER: { name: "Game Center", description: "启用排行榜、成就、多人游戏等 Game Center 功能。" },
  MAPS: { name: "地图", description: "允许 App 使用 Apple Maps 相关服务。" },
  WALLET: { name: "钱包", description: "允许 App 使用或呈现 Wallet 凭证、票券、优惠券等内容。" },
  WEATHERKIT: { name: "WeatherKit", description: "允许 App 访问当前天气和天气预报数据。" },
  VMNET: { name: "VMNet", description: "允许 App 管理虚拟网络接口。" },
  VIRTUALIZATION: { name: "虚拟化", description: "允许 App 使用 Virtualization 框架创建或管理虚拟机。" },
  CLASSKIT: { name: "ClassKit", description: "允许教育类 App 与“课业”共享进度和活动。" },
  GROUP_ACTIVITIES: { name: "同播共享", description: "允许 App 使用 SharePlay 进行群组活动。" },
  USER_MANAGEMENT: { name: "用户管理", description: "允许共享 iPad 环境下的用户管理能力。" },
  APP_ATTEST: { name: "App Attest", description: "帮助服务端验证请求来自真实 App 实例。" },
};

function bundleCapabilitySignature(capability = {}) {
  return `${capability.id || ""} ${capability.name || ""} ${capability.description || ""} ${capability.imageUrl || ""} ${capability.sfSymbolIcon || ""}`.toUpperCase();
}

function bundleCapabilityIsManagedAssociatedDomains(capability = {}) {
  const signature = bundleCapabilitySignature(capability);
  return signature.includes("ASSOCIATED DOMAINS") && /MDM|MANAGED|MANAGEMENT/.test(signature);
}

function bundleCapabilityIsRegularAssociatedDomains(capability = {}) {
  const id = String(capability.id || "").toUpperCase();
  const signature = bundleCapabilitySignature(capability);
  return id === "ASSOCIATED_DOMAINS" || (signature.includes("ASSOCIATED DOMAINS") && !bundleCapabilityIsManagedAssociatedDomains(capability));
}

function bundleCapabilityText(capability = {}, field = "name", language = bundleCapabilityLanguage) {
  if (language !== "zh") return String(capability[field] || capability.id || "");
  if (bundleCapabilityIsManagedAssociatedDomains(capability)) return BUNDLE_CAPABILITY_ZH.ASSOCIATED_DOMAINS_MANAGED[field] || String(capability[field] || capability.id || "");
  const id = String(capability.id || "").toUpperCase();
  const byId = BUNDLE_CAPABILITY_ZH[id]?.[field];
  if (byId) return byId;
  const englishName = String(capability.name || "");
  const matched = Object.entries(BUNDLE_CAPABILITY_ZH).find(([key]) => englishName.toUpperCase().includes(key.replace(/_/g, " ")));
  return matched?.[1]?.[field] || String(capability[field] || capability.id || "");
}

function bundleCapabilityRank(capability = {}) {
  const id = String(capability.id || "").toUpperCase();
  const name = String(capability.name || "").toUpperCase();
  if (bundleCapabilityIsManagedAssociatedDomains(capability)) return 60;
  if (bundleCapabilityIsRegularAssociatedDomains(capability)) return BUNDLE_CAPABILITY_COMMON_ORDER.indexOf("ASSOCIATED_DOMAINS");
  const direct = BUNDLE_CAPABILITY_COMMON_ORDER.findIndex(item => item === id || (item !== "ASSOCIATED_DOMAINS" && name.includes(item.replace(/_/g, " "))));
  if (direct >= 0) return direct;
  if (/UNIVERSAL LINKS/i.test(capability.name || capability.description || "")) return BUNDLE_CAPABILITY_COMMON_ORDER.indexOf("ASSOCIATED_DOMAINS");
  if (/SIGN IN WITH APPLE|APPLE ID/i.test(capability.name || capability.description || "")) return BUNDLE_CAPABILITY_COMMON_ORDER.indexOf("SIGN_IN_WITH_APPLE");
  if (/PUSH|APNS|NOTIFICATION/i.test(capability.name || capability.description || "")) return BUNDLE_CAPABILITY_COMMON_ORDER.indexOf("PUSH_NOTIFICATIONS");
  return 1000;
}

function sortedBundleCapabilities(capabilities = []) {
  return [...capabilities].sort((left, right) => {
    const rankDelta = bundleCapabilityRank(left) - bundleCapabilityRank(right);
    if (rankDelta) return rankDelta;
    const enabledDelta = Number(right.enabled === true) - Number(left.enabled === true);
    if (enabledDelta) return enabledDelta;
    return String(left.name || left.id || "").localeCompare(String(right.name || right.id || ""), undefined, { sensitivity: "base" });
  });
}

function bundleCapabilityNotes(capability = {}) {
  if (bundleCapabilityLanguage === "en") {
    const notes = [];
    if (capability.id === "IN_APP_PURCHASE" && capability.enabledByDefault) notes.push("Enabled by Apple by default. Cannot be turned off.");
    if (capability.developmentOnly) notes.push("Development only.");
    if (capability.distributionApprovalRequired) notes.push("Distribution may require Apple approval.");
    if (capability.canRequestFromPortal && !capability.editable) notes.push("Requires a request in Apple Developer.");
    if (capability.hasExistingFeatureRequest) notes.push("Existing capability request found.");
    if (Array.isArray(capability.supportedSDKs) && capability.supportedSDKs.length) notes.push(`Supports ${capability.supportedSDKs.slice(0, 5).join(", ")}${capability.supportedSDKs.length > 5 ? ", etc." : ""}.`);
    if (!notes.length && capability.documentationURL) notes.push("Apple documentation available.");
    return notes.join(" ");
  }
  const notes = [];
  if (capability.id === "IN_APP_PURCHASE" && capability.enabledByDefault) notes.push("Apple 默认能力，不可关闭。");
  if (capability.developmentOnly) notes.push("仅 Development 使用。");
  if (capability.distributionApprovalRequired) notes.push("分发使用可能需要 Apple 审批。");
  if (capability.canRequestFromPortal && !capability.editable) notes.push("需要在 Apple Developer 申请开通。");
  if (capability.hasExistingFeatureRequest) notes.push("已有能力申请记录。");
  if (Array.isArray(capability.supportedSDKs) && capability.supportedSDKs.length) notes.push(`支持 ${capability.supportedSDKs.slice(0, 5).join("、")}${capability.supportedSDKs.length > 5 ? " 等" : ""}。`);
  if (!notes.length && capability.documentationURL) notes.push("可查看 Apple 官方文档。");
  return notes.join(" ");
}

function bundleCapabilitySelectedOptions(capability = {}) {
  const selected = new Set();
  (capability.settings || []).forEach(setting => {
    (setting.options || []).forEach(option => {
      if (setting.key && option.key) selected.add(`${setting.key}:${option.key}`);
    });
  });
  return selected;
}

function renderBundleCapabilitySettings(capability = {}) {
  const selected = bundleCapabilitySelectedOptions(capability);
  const settings = (capability.settingsSchema || []).filter(setting => setting.visible !== false && (setting.options || []).some(option => option.visible !== false));
  if (!settings.length) return "";
  return `<div class="capability-settings">${settings.map(setting => {
    const options = (setting.options || []).filter(option => option.visible !== false);
    return options.map(option => {
      const key = `${setting.key}:${option.key}`;
      const checked = selected.has(key) || (!capability.enabled && setting.enabledByDefault && option.enabledByDefault);
      const optionLabel = bundleCapabilityLanguage === "zh" && option.key === "PUSH_NOTIFICATION_FEATURE_BROADCAST" ? "广播推送通知" : (option.name || option.key);
      return `<label class="capability-suboption"><input class="bundle-capability-setting" type="checkbox" data-bundle-capability-id="${escapeHTML(capability.id)}" data-setting-key="${escapeHTML(setting.key)}" data-option-key="${escapeHTML(option.key)}" ${checked ? "checked" : ""}>${escapeHTML(optionLabel)}</label>`;
    }).join("");
  }).join("")}</div>`;
}

function renderBundleCapabilityEditor(detail = {}, options = {}) {
  const allowPushConfigure = options.allowPushConfigure !== false;
  const capabilities = sortedBundleCapabilities(Array.isArray(detail.capabilities) ? detail.capabilities : []);
  if (!capabilities.length) return '<div class="capability-empty">Apple 未返回可配置的 Capabilities。</div>';
  const rows = capabilities.map(capability => {
    const locked = capability.id === "IN_APP_PURCHASE" && capability.enabledByDefault;
    const disabled = !detail.editable || capability.editable === false || locked;
    const notes = bundleCapabilityNotes(capability);
    const displayName = bundleCapabilityText(capability, "name");
    const displayDescription = bundleCapabilityText(capability, "description");
    const search = `${capability.id} ${capability.name} ${capability.description} ${displayName} ${displayDescription} ${notes}`.toLowerCase();
    return `<div class="bundle-capability-row ${capability.enabled ? "enabled" : ""} ${disabled ? "disabled" : ""}" data-capability-row data-search="${escapeHTML(search)}">
      <div class="bundle-capability-enable"><input class="bundle-capability-toggle" type="checkbox" data-bundle-capability-id="${escapeHTML(capability.id)}" ${capability.enabled ? "checked" : ""} ${disabled ? "disabled" : ""}></div>
      <div class="bundle-capability-main">
        <div class="bundle-capability-name"><span class="bundle-capability-icon">${bundleCapabilityIconHTML(capability)}</span><span><strong>${escapeHTML(displayName || capability.id)}</strong><small>${escapeHTML(displayDescription || capability.id)}</small></span></div>
        ${capability.id === "PUSH_NOTIFICATIONS" && allowPushConfigure ? `<div class="capability-config-row ${capability.enabled ? "" : "hidden"}"><button class="secondary" data-push-config type="button" ${capability.enabled ? "" : "disabled"}>${bundleCapabilityLanguage === "zh" ? "配置" : "Configure"}</button><span class="capability-count" data-capability-count="PUSH_NOTIFICATIONS">${bundleCapabilityLanguage === "zh" ? "证书" : "Certificates"} (${Number(capability.certificateCount || 0)})</span></div>` : ""}
        ${renderBundleCapabilitySettings(capability)}
      </div>
      <div class="bundle-capability-notes">${notes ? escapeHTML(notes) : "—"}</div>
    </div>`;
  }).join("");
  return `<div class="capability-toolbar"><input id="bundle-capability-search" placeholder="${bundleCapabilityLanguage === "zh" ? "搜索能力 / Capability" : "Search Capabilities"}"><label class="capability-language"><span>${bundleCapabilityLanguage === "zh" ? "语言" : "Language"}</span><select id="bundle-capability-language"><option value="zh" ${bundleCapabilityLanguage === "zh" ? "selected" : ""}>中文</option><option value="en" ${bundleCapabilityLanguage === "en" ? "selected" : ""}>English</option></select></label><span>${bundleCapabilityLanguage === "zh" ? `共 ${capabilities.length} 项` : `${capabilities.length} items`}</span></div>
    <div class="bundle-capability-table"><div class="bundle-capability-head"><span>${bundleCapabilityLanguage === "zh" ? "启用" : "ENABLE"}</span><span>${bundleCapabilityLanguage === "zh" ? "名称" : "NAME"}</span><span>${bundleCapabilityLanguage === "zh" ? "备注" : "NOTES"}</span></div>${rows}</div>`;
}

function bundleCapabilityEditorDetail(listId = "bundle-edit-capabilities") {
  return listId === "bundle-create-capabilities" ? creatingBundleDetail : editingBundleDetail;
}

function setBundleCapabilityEditorDetail(listId = "bundle-edit-capabilities", detail) {
  if (listId === "bundle-create-capabilities") creatingBundleDetail = detail;
  else editingBundleDetail = detail;
}

function syncBundleCapabilityEditorState(listId = "bundle-edit-capabilities") {
  const detail = bundleCapabilityEditorDetail(listId);
  if (!detail?.capabilities) return;
  const states = new Map(bundleCapabilityPayloadFromEditor(listId).map(item => [item.id, item]));
  const nextDetail = { ...detail, capabilities: detail.capabilities.map(capability => {
    const state = states.get(capability.id);
    if (!state) return capability;
    return { ...capability, enabled: state.enabled === true, settings: state.settings || [] };
  }) };
  setBundleCapabilityEditorDetail(listId, nextDetail);
}

function bindBundleCapabilityEditor(listId = "bundle-edit-capabilities", options = {}) {
  const list = el(listId);
  if (!list) return;
  const updateRow = input => {
    const row = input.closest("[data-capability-row]");
    if (!row) return;
    row.classList.toggle("enabled", input.checked);
    row.querySelector(".capability-config-row")?.classList.toggle("hidden", !input.checked);
    row.querySelectorAll(".bundle-capability-setting,[data-push-config]").forEach(node => { node.disabled = !input.checked; });
  };
  list.querySelectorAll(".bundle-capability-toggle").forEach(input => {
    updateRow(input);
    input.addEventListener("change", () => updateRow(input));
  });
  list.querySelectorAll("[data-push-config]").forEach(button => button.addEventListener("click", async event => {
    event.preventDefault();
    const detail = bundleCapabilityEditorDetail(listId);
    if (options.allowPushConfigure !== false && detail?.id) await showPushConfigureDialog(detail.id, detail.name);
  }));
  list.querySelector("#bundle-capability-search")?.addEventListener("input", event => {
    const keyword = event.currentTarget.value.trim().toLowerCase();
    list.querySelectorAll("[data-capability-row]").forEach(row => row.classList.toggle("hidden", keyword && !row.dataset.search.includes(keyword)));
  });
  list.querySelector("#bundle-capability-language")?.addEventListener("change", event => {
    syncBundleCapabilityEditorState(listId);
    bundleCapabilityLanguage = event.currentTarget.value === "en" ? "en" : "zh";
    try { localStorage.setItem(BUNDLE_CAPABILITY_LANGUAGE_KEY, bundleCapabilityLanguage); } catch {}
    list.innerHTML = renderBundleCapabilityEditor(bundleCapabilityEditorDetail(listId) || {}, options);
    bindBundleCapabilityEditor(listId, options);
  });
}

function bundleCapabilityPayloadFromEditor(containerId = "") {
  const root = containerId ? el(containerId) : document;
  if (!root) return [];
  const settings = new Map();
  root.querySelectorAll(".bundle-capability-setting").forEach(input => {
    if (!input.checked) return;
    const id = input.dataset.bundleCapabilityId || "";
    const settingKey = input.dataset.settingKey || "";
    const optionKey = input.dataset.optionKey || "";
    if (!id || !settingKey || !optionKey) return;
    if (!settings.has(id)) settings.set(id, new Map());
    if (!settings.get(id).has(settingKey)) settings.get(id).set(settingKey, []);
    settings.get(id).get(settingKey).push({ key: optionKey });
  });
  return [...root.querySelectorAll(".bundle-capability-toggle")].map(input => {
    const id = input.dataset.bundleCapabilityId || "";
    const capabilitySettings = settings.get(id);
    return {
      id,
      enabled: input.checked,
      settings: capabilitySettings ? [...capabilitySettings.entries()].map(([key, options]) => ({ key, options })) : [],
    };
  }).filter(item => item.id);
}

function bundleCapabilitySettingEnabled(capabilityId, optionKey, containerId = "") {
  const root = containerId ? el(containerId) : document;
  if (!root) return false;
  return [...root.querySelectorAll(`.bundle-capability-setting[data-bundle-capability-id="${capabilityId}"]`)].some(input => input.dataset.optionKey === optionKey && input.checked);
}

function localizedDeviceStatus(value) {
  return ({ ENABLED: "已启用", DISABLED: "已停用", PROCESSING: "处理中" })[String(value).toUpperCase()] || value || "—";
}

async function showDeviceDetail(deviceId) {
  const page = el("page-devices");
  page.innerHTML = '<div class="module"><div class="module-bar"><span class="module-title">设备详情</span></div><div class="loading-state">正在读取设备详情…</div></div>';
  const response = await window.appleDeveloper.deviceDetail({ id: deviceId });
  if (!response?.success) {
    page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">设备详情</span></div><div class="empty"><strong>读取失败</strong><span>${escapeHTML(response?.error || "无法读取设备详情")}</span><button class="primary" id="device-detail-error-back" type="button" style="margin-top:16px">返回列表</button></div></div>`;
    el("device-detail-error-back").addEventListener("click", () => loadDevices());
    return;
  }
  const device = response.device;
  const enabled = String(device.status).toUpperCase() === "ENABLED";
  page.innerHTML = `<div class="device-renewal">
    <button class="device-renewal-back" id="device-detail-back" type="button">‹ 返回所有设备</button>
    <div class="device-renewal-head"><h2>设备详情</h2><div class="device-detail-actions"><button class="primary" id="device-detail-save" type="button" disabled>保存备注名</button>${enabled ? '<button class="device-disable" id="device-detail-disable" type="button">禁用设备</button>' : '<button class="device-enable" id="device-detail-enable" type="button">恢复设备</button>'}</div></div>
    <div class="device-detail-grid">
      <div class="device-detail-item"><label for="device-detail-name">设备备注名</label><input id="device-detail-name" maxlength="100" value="${escapeHTML(device.name)}"></div>
      <div class="device-detail-item"><label>设备类型</label><strong>${escapeHTML(device.type)}</strong></div>
      <div class="device-detail-item"><label>设备 ID（UDID/UUID）</label><strong class="device-udid">${escapeHTML(device.udid)}</strong></div>
      <div class="device-detail-item"><label>设备型号</label><strong>${escapeHTML(device.model)}</strong></div>
      <div class="device-detail-item"><label>当前状态</label><strong class="${enabled ? "device-status-enabled" : "device-status-disabled"}">${escapeHTML(localizedDeviceStatus(device.status))}</strong></div>
      <div class="device-detail-item"><label>平台</label><strong>${escapeHTML(device.platform)}</strong></div>
    </div>
    <div class="device-renewal-error" id="device-detail-error"></div>
  </div>`;
  const nameInput = el("device-detail-name");
  const save = el("device-detail-save");
  const showError = message => { el("device-detail-error").textContent = message || ""; };
  nameInput.addEventListener("input", () => { save.disabled = !nameInput.value.trim() || nameInput.value.trim() === device.name; });
  el("device-detail-back").addEventListener("click", () => loadDevices());
  save.addEventListener("click", async () => {
    setBusy(save, true, "正在保存…"); showError("");
    try {
      const result = await Promise.race([window.appleDeveloper.updateDevice({ id: device.id, name: nameInput.value.trim(), platform: device.platform }), new Promise((_, reject) => setTimeout(() => reject(new Error("保存设备备注名超时")), 25000))]);
      if (!result?.success) throw new Error(result?.error || "保存设备备注名失败");
      await showDeviceDetail(device.id);
    } catch (error) { showError(error.message); setBusy(save, false); }
  });
  el("device-detail-disable")?.addEventListener("click", async event => {
    if (!confirm(`确定禁用设备“${device.name}”吗？\n\n禁用后仍会占用当前会员年度的注册额度。`)) return;
    const button = event.currentTarget; setBusy(button, true, "正在禁用…"); showError("");
    try {
      const result = await Promise.race([window.appleDeveloper.disableDevice({ id: device.id, platform: device.platform, single: true }), new Promise((_, reject) => setTimeout(() => reject(new Error("设备禁用超时")), 25000))]);
      if (!result?.success) throw new Error(result?.error || "设备禁用失败");
      await showDeviceDetail(device.id);
    } catch (error) { showError(error.message); setBusy(button, false); }
  });
  el("device-detail-enable")?.addEventListener("click", async event => {
    if (!confirm(`确定恢复设备“${device.name}”吗？`)) return;
    const button = event.currentTarget; setBusy(button, true, "正在恢复…"); showError("");
    try {
      const result = await Promise.race([window.appleDeveloper.enableDevice({ id: device.id, udid: device.udid, platform: device.platform }), new Promise((_, reject) => setTimeout(() => reject(new Error("设备恢复超时")), 25000))]);
      if (!result?.success) throw new Error(result?.error || "设备恢复失败");
      await showDeviceDetail(device.id);
    } catch (error) { showError(error.message); setBusy(button, false); }
  });
}

let temporaryUdidRows = [];
let temporaryUdidClock = null;

function temporaryUdidRemaining(createdAt) {
  const elapsed = Date.now() - Date.parse(String(createdAt || ""));
  const remaining = 24 * 60 * 60 * 1000 - elapsed;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return { ms: remaining, text: `剩余 ${Math.floor(remaining / 3600000)} 小时 ${Math.floor((remaining % 3600000) / 60000)} 分` };
}

function temporaryUdidDisplay(item = {}) {
  const model = item.product || item.model || item.device_model || item.device_type || "Apple 设备";
  const remark = item.remark || item.note || item.device_name || item.name || model || "扫码设备";
  const system = item.system_version || item.os_version || item.version || "";
  return { model: String(model || "Apple 设备"), remark: String(remark || "扫码设备"), system: String(system || ""), udid: String(item.udid || "") };
}

function showDeviceSuccessDialog(message) {
  closeDeviceActionDialog();
  const overlay = document.createElement("div");
  overlay.className = "device-action-overlay";
  overlay.innerHTML = `<div class="device-action-dialog device-success-dialog"><div class="device-action-head"><h2>添加成功</h2><button class="device-action-close" type="button">×</button></div><div class="device-action-body"><div class="device-success-mark">✓</div><p class="device-action-copy">${escapeHTML(message || "UDID 已成功添加到 Apple Developer。")}</p></div><div class="device-action-foot"><button class="primary" data-done type="button">知道了</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector(".device-action-close").onclick = closeDeviceActionDialog;
  overlay.querySelector("[data-done]").onclick = closeDeviceActionDialog;
}

function renderTemporaryUdids() {
  const box = el("temporary-udid-list");
  const count = el("temporary-udid-count");
  if (!box || !count) return;
  const showTemporaryError = message => {
    const target = el("device-add-error");
    if (target) target.textContent = message || "";
    else if (message) alert(message);
  };
  const visible = temporaryUdidRows.filter(item => temporaryUdidRemaining(item.created_at));
  count.textContent = String(visible.length);
  box.innerHTML = visible.length ? visible.map(item => {
    const remaining = temporaryUdidRemaining(item.created_at);
    const display = temporaryUdidDisplay(item);
    return `<article class="temporary-udid-item" data-id="${Number(item.id)}"><div class="temporary-udid-top"><div class="temporary-udid-device"><b>${escapeHTML(display.remark)}</b><small>${escapeHTML([display.model, display.system ? `iOS ${display.system}` : ""].filter(Boolean).join(" · "))}</small></div><span class="temporary-udid-life">${escapeHTML(remaining.text)}</span></div><dl class="temporary-udid-info"><dt>手机型号</dt><dd>${escapeHTML(display.model)}</dd><dt>UDID</dt><dd class="temporary-udid-code">${escapeHTML(display.udid)}</dd><dt><label for="temporary-udid-remark-${Number(item.id)}">备注</label></dt><dd><input id="temporary-udid-remark-${Number(item.id)}" class="temporary-udid-remark" maxlength="100" value="${escapeHTML(display.remark)}"></dd></dl><div class="temporary-udid-actions"><button class="primary temporary-udid-add" type="button">一键添加到开发者账户</button><button class="temporary-udid-delete" type="button">删除</button></div></article>`;
  }).join("") : '<div class="temporary-udid-empty">暂无24小时内识别的设备</div>';
  box.querySelectorAll(".temporary-udid-delete").forEach(button => button.addEventListener("click", async () => {
    const row = button.closest(".temporary-udid-item"), id = Number(row?.dataset.id || 0);
    if (!id || !confirm("删除后将不保留该 UDID 记录，确定继续？")) return;
    setBusy(button, true, "删除中…");
    const response = await window.appleDeveloper.deleteTemporaryUdid(id).catch(error => ({ success:false,error:error.message }));
    if (!response?.success) { showTemporaryError(response?.error || "UDID 删除失败"); setBusy(button, false); return; }
    temporaryUdidRows = temporaryUdidRows.filter(item => Number(item.id) !== id); renderTemporaryUdids();
  }));
  box.querySelectorAll(".temporary-udid-add").forEach(button => button.addEventListener("click", async () => {
    const id = Number(button.closest(".temporary-udid-item")?.dataset.id || 0);
    const row = button.closest(".temporary-udid-item");
    const item = visible.find(row => Number(row.id) === id);
    if (!item) return;
    setBusy(button, true, "正在添加…"); showTemporaryError("");
    const display = temporaryUdidDisplay(item);
    const remark = row?.querySelector(".temporary-udid-remark")?.value?.trim() || display.remark;
    const payload = { name: remark, udid: display.udid, platform:"ios" };
    const response = await window.appleDeveloper.addDevice(payload).catch(error => ({ success:false,error:error.message }));
    if (!response?.success) { showTemporaryError(response?.error || "添加设备失败"); setBusy(button, false); return; }
    const deleted = await window.appleDeveloper.deleteTemporaryUdid(id).catch(error => ({ success:false,error:error.message }));
    temporaryUdidRows = temporaryUdidRows.filter(item => Number(item.id) !== id);
    renderTemporaryUdids();
    showDeviceSuccessDialog(deleted?.success === false ? "UDID 已成功添加到 Apple Developer，但临时记录删除失败，请手动删除。" : "UDID 已成功添加到 Apple Developer，临时记录已删除。");
  }));
}

async function loadTemporaryUdids() {
  const box = el("temporary-udid-list");
  if (box) box.innerHTML = '<div class="temporary-udid-empty">正在读取最近设备…</div>';
  const response = await window.appleDeveloper.temporaryUdids().catch(error => ({ success:false,error:error.message }));
  if (!response?.success) { if (box) box.innerHTML = `<div class="temporary-udid-empty">${escapeHTML(response?.error || "UDID 列表读取失败")}</div>`; return; }
  temporaryUdidRows = Array.isArray(response.items) ? response.items : [];
  renderTemporaryUdids();
  clearInterval(temporaryUdidClock);
  temporaryUdidClock = setInterval(() => { if (!el("temporary-udid-list")) return clearInterval(temporaryUdidClock); renderTemporaryUdids(); }, 60000);
}

function showAddDevice(result) {
  const page = el("page-devices");
  const canIOS = result.permissions?.canAddIOS;
  const canMac = result.permissions?.canAddMac;
  page.innerHTML = `<div class="device-renewal device-add-page">
    <button class="device-renewal-back" id="device-add-back" type="button">‹ 返回所有设备</button>
    <div class="device-add-layout"><section class="device-add-main"><div class="device-renewal-head"><h2>注册新设备</h2></div>
    <div class="device-add-intro">注册设备后，设备可加入用于 App 开发和安装的描述文件。UDID 注册后无法修改，只能修改设备名称或停用设备。</div><form class="device-add-form" id="device-add-form">
      <div class="field"><label for="device-add-platform">设备平台</label><select id="device-add-platform">${canIOS ? '<option value="ios">iOS、iPadOS、tvOS、watchOS、visionOS</option>' : ""}${canMac ? '<option value="mac">macOS</option>' : ""}</select></div>
      <div class="field"><label for="device-add-name">设备名称</label><input id="device-add-name" maxlength="100" required placeholder="例如：测试 iPhone"></div>
      <section class="device-id-methods" aria-labelledby="device-id-method-title"><div class="device-id-methods-head"><h3 id="device-id-method-title">获取设备 UDID</h3><span>选择一种方式</span></div><div id="device-id-method-tabs" class="device-id-method-tabs" role="tablist" aria-label="获取 UDID 方式">
        ${canIOS ? '<button class="device-id-method-tab active" type="button" role="tab" aria-selected="true" data-udid-method="scan"><strong>手机扫码自动识别</strong><span>推荐，识别后自动回填</span></button>' : ''}
        <button class="device-id-method-tab${canIOS ? '' : ' active'}" type="button" role="tab" aria-selected="${canIOS ? 'false' : 'true'}" data-udid-method="finder"><strong>Mac 自动识别</strong><span>USB / 同网已配对设备</span></button>
        <button class="device-id-method-tab" type="button" role="tab" aria-selected="false" data-udid-method="windows"><strong>Windows Apple Devices / iTunes</strong><span>兼容 Windows 10/11</span></button>
      </div><div id="device-id-method-guide" class="device-id-method-guide"${canIOS ? ' hidden' : ''}></div></section>
      <div class="field"><label for="device-add-udid">设备标识符（UDID/UUID）</label><input id="device-add-udid" required autocomplete="off" spellcheck="false" placeholder="输入设备 UDID"></div>
      ${canIOS ? `<section class="device-enrollment" id="device-enrollment-panel"><div class="device-enrollment-copy"><h3>手机扫码自动识别</h3><ol><li>使用相机扫描右侧二维码</li><li>进入官网同款 UDID 识别页面</li><li>按提示下载并安装描述文件</li><li>识别成功后自动回填 UDID</li></ol><p id="device-enrollment-status">正在生成一次性二维码…</p></div><div class="device-enrollment-qr" id="device-enrollment-qr"></div></section>` : ""}
      <div class="device-renewal-error" id="device-add-error"></div>
      <div class="device-add-footer"><button class="secondary" id="device-add-cancel" type="button">取消</button><button class="primary" id="device-add-validate" type="submit">继续</button></div>
    </form></section><aside class="temporary-udid-panel"><div class="temporary-udid-head"><div class="temporary-udid-title"><h3>最近识别的设备</h3><span class="temporary-udid-count" id="temporary-udid-count">0</span></div><p>只显示当前 Apple 开发者账户24小时内扫码识别的设备，倒计时在软件本地计算。</p></div><div class="temporary-udid-list" id="temporary-udid-list"></div><div class="temporary-udid-note">删除后服务器不保留 UDID 历史记录。</div></aside></div>
  </div>`;
  loadTemporaryUdids();
  const back = () => loadDevices();
  el("device-add-back").addEventListener("click", back);
  el("device-add-cancel").addEventListener("click", back);
  const methodGuide = el("device-id-method-guide");
  const enrollmentPanel = el("device-enrollment-panel");
  const platformSelect = el("device-add-platform");
  const scanMethodTab = el("device-id-method-tabs")?.querySelector('[data-udid-method="scan"]');
  let deviceDetectTimer = null;
  let deviceDetectBusy = false;
  const methodGuides = {
    finder: '<div class="device-auto-detect"><div class="device-auto-summary scanning" data-device-detect-summary><span class="device-auto-state" data-device-detect-icon aria-hidden="true">↻</span><div class="device-auto-copy"><strong data-device-detect-title>正在扫描 Apple 设备…</strong><span data-device-detect-detail>正在查找 USB 和同网已配对设备</span></div><button class="device-auto-refresh loading" type="button" data-detect-udid title="立即扫描" aria-label="立即扫描"><span aria-hidden="true">↻</span></button></div><div class="device-id-detected-list" data-detected-udid-list></div><div class="device-auto-empty-actions" data-device-empty-actions hidden><button class="device-auto-retry" type="button" data-detect-udid>↻&nbsp; 重新扫描</button><button class="device-auto-finder" type="button" data-open-udid-method="finder">打开 Finder 完成设置</button></div><div class="device-id-method-status" role="status" aria-live="polite">正在扫描本机已信任的 Apple 设备…</div></div>',
    windows: '<ol><li>Windows 10/11 建议打开“Apple 设备（Apple Devices）”，旧环境可使用最新版 iTunes。</li><li>连接 iPhone 或 iPad，在设备上点“信任此电脑”并输入锁屏密码。</li><li>选择设备，打开“通用”或“摘要”，点击“序列号”切换到 UDID。</li><li>按 <b>Ctrl + C</b> 复制，再粘贴到下方 UDID 输入框。</li></ol><button class="device-id-method-action" type="button" data-open-udid-method="windows">打开 Apple Devices</button><div class="device-id-method-status" role="status" aria-live="polite"></div>'
  };
  const setUdidMethod = method => {
    if (deviceDetectTimer) { clearInterval(deviceDetectTimer); deviceDetectTimer = null; }
    if (method === "scan" && platformSelect?.value === "mac") method = "finder";
    el("device-id-method-tabs")?.querySelectorAll("[data-udid-method]").forEach(button => {
      const active = button.dataset.udidMethod === method;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const scan = method === "scan";
    if (enrollmentPanel) enrollmentPanel.hidden = !scan;
    if (methodGuide) {
      methodGuide.hidden = scan;
      methodGuide.innerHTML = scan ? "" : (methodGuides[method] || methodGuides.finder);
      const status = methodGuide.querySelector(".device-id-method-status");
      const list = methodGuide.querySelector("[data-detected-udid-list]");
      const summary = methodGuide.querySelector("[data-device-detect-summary]");
      const summaryIcon = methodGuide.querySelector("[data-device-detect-icon]");
      const summaryTitle = methodGuide.querySelector("[data-device-detect-title]");
      const summaryDetail = methodGuide.querySelector("[data-device-detect-detail]");
      const emptyActions = methodGuide.querySelector("[data-device-empty-actions]");
      const detectButtons = Array.from(methodGuide.querySelectorAll("[data-detect-udid]"));
      const setDetectSummary = (state, title, detail) => {
        if (!summary || !summaryTitle || !summaryDetail) return;
        summary.classList.remove("scanning", "success", "empty", "error");
        summary.classList.add(state);
        summaryTitle.textContent = title;
        summaryDetail.textContent = detail;
        if (summaryIcon) summaryIcon.textContent = state === "success" ? "✓" : (state === "error" ? "×" : (state === "scanning" ? "↻" : "!"));
      };
      const action = methodGuide.querySelector("[data-open-udid-method]");
      action?.addEventListener("click", async () => {
        action.disabled = true;
        if (summary) setDetectSummary("scanning", "正在打开 Finder…", "请稍候");
        if (status) { status.classList.remove("error"); status.textContent = "正在打开…"; }
        try {
          const result = await window.appleDeveloper.openUdidMethod(action.dataset.openUdidMethod);
          if (summary) setDetectSummary(result?.success === false ? "error" : "empty", result?.success === false ? "Finder 打开失败" : "Finder 已打开", result?.message || result?.error || "请完成设备信任或 Wi-Fi 同步设置");
          if (status) {
            status.classList.toggle("error", result?.success === false);
            status.textContent = result?.message || result?.error || "操作已完成。";
          }
        } catch (error) {
          if (summary) setDetectSummary("error", "Finder 打开失败", error.message || "请稍后重试");
          if (status) { status.classList.add("error"); status.textContent = error.message || "打开失败。"; }
        } finally { action.disabled = false; }
      });
      const detectDevices = async () => {
        if (deviceDetectBusy || !el("device-add-udid")) return;
        deviceDetectBusy = true;
        detectButtons.forEach(button => {
          button.disabled = true;
          button.classList.toggle("loading", button.classList.contains("device-auto-refresh"));
        });
        if (!list?.children.length) {
          setDetectSummary("scanning", "正在扫描 Apple 设备…", "正在查找 USB 和同网已配对设备");
          if (emptyActions) emptyActions.hidden = true;
        }
        if (status) { status.classList.remove("error"); status.textContent = "正在扫描本机已信任的 Apple 设备…"; }
        try {
          const result = await window.appleDeveloper.detectUdidDevices();
          if (!methodGuide.querySelector("[data-detect-udid]")) return;
          const devices = Array.isArray(result?.devices) ? result.devices : [];
          const applyDevice = device => {
            const udidInput = el("device-add-udid");
            const nameInput = el("device-add-name");
            if (!device || !udidInput || !nameInput) return;
            udidInput.value = device.udid || "";
            if (!nameInput.value.trim()) nameInput.value = device.name || device.model || "Apple 设备";
            const connection = device.connection === "wifi" ? "同一网络" : "USB";
            setDetectSummary("success", "已识别 " + devices.length + " 台设备", (device.name || device.model || "设备") + " 已回填 · " + connection + " · 每 4 秒自动刷新");
            if (status) {
              status.classList.remove("error");
              status.textContent = (device.name || device.model || "设备") + " 已回填 UDID（" + connection + "）";
            }
            list?.querySelectorAll("[data-detected-index]").forEach(item => {
              item.classList.toggle("active", Number(item.dataset.detectedIndex) === devices.indexOf(device));
            });
          };
          if (list) {
            list.innerHTML = devices.map((device, index) => '<button type="button" class="device-id-detected-item" data-detected-index="' + index + '"><span class="device-id-detected-choice" aria-hidden="true"></span><span class="device-id-detected-name"><strong>' + escapeHTML(device.name || device.model || "Apple 设备") + '</strong><small>' + escapeHTML(device.model || "") + (device.version ? " · iOS " + escapeHTML(device.version) : "") + '</small></span><code>' + escapeHTML(device.udid) + '</code><span class="device-id-detected-connection">' + (device.connection === "wifi" ? "同一网络" : "USB") + '</span></button>').join("");
            list.querySelectorAll("[data-detected-index]").forEach(button => {
              button.addEventListener("click", () => applyDevice(devices[Number(button.dataset.detectedIndex)]));
            });
          }
          if (emptyActions) emptyActions.hidden = devices.length > 0;
          const wired = devices.filter(device => device.connection === "usb");
          const automatic = devices.length === 1 ? devices[0] : (wired.length === 1 ? wired[0] : null);
          const currentUdid = String(el("device-add-udid")?.value || "").trim().toUpperCase();
          if (automatic && (!currentUdid || currentUdid === String(automatic.udid || "").toUpperCase())) {
            applyDevice(automatic);
          } else if (devices.find(device => String(device.udid || "").toUpperCase() === currentUdid)) {
            applyDevice(devices.find(device => String(device.udid || "").toUpperCase() === currentUdid));
          } else if (!devices.length && status) {
            const message = result?.warning || result?.error || "请连接并信任设备；同网识别需先在 Finder 开启 Wi-Fi 同步。";
            setDetectSummary(result?.success === false ? "error" : "empty", "暂未发现可用设备", message);
            status.textContent = message;
            status.classList.toggle("error", result?.success === false);
          } else if (status) {
            setDetectSummary("success", "已识别 " + devices.length + " 台设备", "请选择要登记的设备 · 每 4 秒自动刷新");
            status.classList.remove("error");
            status.textContent = "发现 " + devices.length + " 台已信任设备，请选择要登记的设备。";
          }
        } catch (error) {
          if (emptyActions) emptyActions.hidden = false;
          setDetectSummary("error", "设备扫描失败", error.message || "请稍后重试，或打开 Finder 检查设备连接");
          if (status) { status.classList.add("error"); status.textContent = error.message || "设备扫描失败。"; }
        } finally {
          deviceDetectBusy = false;
          detectButtons.forEach(button => {
            button.disabled = false;
            button.classList.remove("loading");
          });
        }
      };
      detectButtons.forEach(button => button.addEventListener("click", detectDevices));
      if (method === "finder") {
        detectDevices();
        deviceDetectTimer = setInterval(() => {
          const active = el("device-id-method-tabs")?.querySelector('[data-udid-method="finder"].active');
          if (!active || !el("device-add-udid")) {
            clearInterval(deviceDetectTimer);
            deviceDetectTimer = null;
            return;
          }
          detectDevices();
        }, 4000);
      }
    }
  };
  el("device-id-method-tabs")?.querySelectorAll("[data-udid-method]").forEach(button => {
    button.addEventListener("click", () => setUdidMethod(button.dataset.udidMethod || "scan"));
  });
  platformSelect?.addEventListener("change", () => {
    const macPlatform = platformSelect.value === "mac";
    if (scanMethodTab) {
      scanMethodTab.disabled = macPlatform;
      scanMethodTab.title = macPlatform ? "macOS 设备不能使用 iPhone/iPad 描述文件扫码识别" : "";
    }
    if (macPlatform) setUdidMethod("finder");
  });
  if (platformSelect?.value === "mac" && scanMethodTab) scanMethodTab.disabled = true;
  setUdidMethod(canIOS ? "scan" : "finder");
  if (canIOS) {
    window.appleDeveloper.startDeviceEnrollment().then(session => {
      const qr = el("device-enrollment-qr");
      const status = el("device-enrollment-status");
      if (!qr || !status) return;
      if (!session?.success) { status.textContent = session?.error || "二维码生成失败，请手动输入 UDID"; return; }
      qr.innerHTML = `<img src="${escapeHTML(session.qrDataURL)}" alt="设备 UDID 登记二维码"><small>二维码 20 分钟内有效</small>`;
      status.textContent = "等待手机扫码并安装描述文件…";
      const timer = setInterval(async () => {
        if (!el("device-enrollment-qr")) { clearInterval(timer); return; }
        const enrollment = await window.appleDeveloper.deviceEnrollmentStatus(session.token).catch(() => null);
        if (enrollment?.status !== "completed" || !enrollment.udid) return;
        clearInterval(timer);
        el("device-add-udid").value = enrollment.udid;
        if (!el("device-add-name").value.trim()) el("device-add-name").value = enrollment.name || enrollment.product || "扫码设备";
        status.textContent = "识别成功，设备信息已自动回填";
        status.classList.add("success");
        loadTemporaryUdids();
      }, 2000);
    }).catch(error => {
      if (el("device-enrollment-status")) el("device-enrollment-status").textContent = error.message || "二维码生成失败，请手动输入 UDID";
    });
  }
  el("device-add-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = el("device-add-validate");
    const input = { platform: el("device-add-platform").value, name: el("device-add-name").value.trim(), udid: el("device-add-udid").value.trim() };
    const temporaryRow = temporaryUdidRows.find(item => String(item.udid || "").replace(/-/g, "").toLowerCase() === input.udid.replace(/-/g, "").toLowerCase());
    if (temporaryRow?.id) input.temporaryUdidId = Number(temporaryRow.id);
    el("device-add-error").textContent = "";
    setBusy(button, true, "正在校验…");
    try {
      const response = await Promise.race([
        window.appleDeveloper.validateDevice(input),
        new Promise((_, reject) => setTimeout(() => reject(new Error("设备校验超时，请刷新设备列表后重试")), 25000)),
      ]);
      if (!response?.success) throw new Error(response?.error || "设备信息校验失败");
      showAddDeviceConfirmation(result, input, response.device);
    } catch (error) { el("device-add-error").textContent = error.message; setBusy(button, false); }
  });
}

function showAddDeviceConfirmation(result, input, device = {}) {
  const page = el("page-devices");
  const name = String(device.name || input.name);
  const udid = String(device.deviceNumber || device.udid || input.udid);
  const platform = String(device.devicePlatform || input.platform).toLowerCase();
  page.innerHTML = `<div class="device-renewal device-add-page">
    <div class="device-renewal-head"><h2>确认新设备</h2></div>
    <div class="device-add-intro">请确认设备信息正确。注册后无法修改 UDID，只能修改名称或停用设备。</div>
    <div class="device-add-confirm"><dl><dt>设备名称</dt><dd>${escapeHTML(name)}</dd><dt>型号</dt><dd>${escapeHTML(device.model || "Apple 未识别具体型号")}</dd><dt>平台</dt><dd>${platform === "mac" || platform === "mac_os" || platform === "macos" ? "macOS" : "iOS 系列"}</dd><dt>UDID/UUID</dt><dd class="device-add-udid">${escapeHTML(udid)}</dd></dl></div>
    <div class="device-renewal-error" id="device-add-error"></div>
    <div class="device-add-footer"><button class="secondary" id="device-add-confirm-back" type="button">返回修改</button><button class="primary" id="device-add-register" type="button">注册设备</button></div>
  </div>`;
  el("device-add-confirm-back").addEventListener("click", () => showAddDevice(result));
  el("device-add-register").addEventListener("click", async () => {
    const button = el("device-add-register");
    setBusy(button, true, "正在注册…");
    try {
      const response = await Promise.race([
        window.appleDeveloper.addDevice({ name, udid, platform }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("设备注册超时，请返回设备列表确认是否已经注册")), 25000)),
      ]);
      if (!response?.success) throw new Error(response?.error || "设备注册失败");
      if (input.temporaryUdidId) {
        await window.appleDeveloper.deleteTemporaryUdid(input.temporaryUdidId).catch(() => null);
        temporaryUdidRows = temporaryUdidRows.filter(item => Number(item.id) !== Number(input.temporaryUdidId));
      }
      page.innerHTML = '<div class="device-renewal device-add-page"><div class="device-renewal-success">设备已成功注册，现在可以加入开发和测试描述文件。</div><div class="actions"><button class="primary" id="device-add-done" type="button">完成</button></div></div>';
      el("device-add-done").addEventListener("click", () => loadDevices());
    } catch (error) { el("device-add-error").textContent = error.message; setBusy(button, false); }
  });
}

function showDeviceRenewal(result) {
  const page = el("page-devices");
  const rows = (result.devices || []).filter(item => String(item.status).toUpperCase() === "ENABLED");
  page.innerHTML = `<div class="device-renewal">
    <button class="device-renewal-back" id="device-renewal-back" type="button">‹ 返回所有设备</button>
    <div class="device-renewal-head"><h2>更新设备列表</h2><button class="primary" id="device-renewal-submit" type="button">继续</button></div>
    <div class="device-renewal-copy">新的会员年度已经开始，请确认设备列表仍然是最新的。完成此过程后，才能添加新设备。<br><br>请选择本会员年度需要保留的设备，取消选择需要移除的设备。这里只显示当前已启用的设备；以前停用的设备将被自动移除。</div>
    <div class="device-renewal-list">
      <label class="device-renewal-row header"><input id="device-renewal-all" type="checkbox" checked><span>全选</span><span class="device-renewal-count" id="device-renewal-count"></span></label>
      ${rows.map((item, index) => `<label class="device-renewal-row"><input class="device-renewal-item" type="checkbox" checked data-id="${escapeHTML(item.id)}"><span>${escapeHTML(item.name)}</span><span class="device-udid">${escapeHTML(item.udid)}</span></label>`).join("")}
    </div>
    <div class="device-renewal-error" id="device-renewal-error"></div>
  </div>`;
  const all = el("device-renewal-all");
  const items = [...page.querySelectorAll(".device-renewal-item")];
  const updateCount = () => {
    const selected = items.filter(input => input.checked).length;
    el("device-renewal-count").textContent = `已选择 ${selected}/${items.length} 台设备`;
    all.checked = selected === items.length;
    all.indeterminate = selected > 0 && selected < items.length;
  };
  all.addEventListener("change", () => { items.forEach(input => { input.checked = all.checked; }); updateCount(); });
  items.forEach(input => input.addEventListener("change", updateCount));
  el("device-renewal-back").addEventListener("click", () => loadDevices());
  el("device-renewal-submit").addEventListener("click", () => {
    showDeviceRenewalConfirmation(result, items.filter(input => input.checked).map(input => input.dataset.id));
  });
  updateCount();
}

function showDeviceRenewalConfirmation(result, selectedIds) {
  const page = el("page-devices");
  const selected = new Set(selectedIds);
  const rows = (result.devices || []).filter(item => selected.has(item.id));
  const benefits = result.deviceBenefits || [];
  page.innerHTML = `<div class="device-renewal">
    <div class="device-renewal-head"><div class="device-renewal-head-copy"><h2>确认设备并重置列表</h2><p>${rows.length ? "请先确认需要保留的设备。" : "你已选择移除全部设备。"}</p></div><div class="device-renewal-actions"><button class="secondary" id="device-confirm-back" type="button">返回设备列表</button><button class="primary" id="device-reset-submit" type="button" disabled>重置设备列表</button></div></div>
    <div class="device-renewal-copy">完成后会直接返回设备列表，并刷新当前状态。</div>
    <div class="device-benefits">${benefits.map(item => `<div class="device-benefit"><span>${escapeHTML(item.label)}</span><strong>${Number(item.available)}</strong></div>`).join("")}</div>
    <div class="section-title">更新后的设备列表（${rows.length}）</div>
    <div class="device-renewal-list device-confirm-list">${rows.map((item, index) => `<div class="device-renewal-row device-confirm-row"><span>${index + 1}</span><span>${escapeHTML(item.name)}</span><span class="device-udid">${escapeHTML(item.udid)}</span></div>`).join("") || '<div class="empty" style="height:100px">不保留任何设备</div>'}</div>
    <label class="device-ack"><input id="device-reset-ack" type="checkbox"><span>我确认：在本会员年度内停用的任何设备，仍会计入已注册设备总数。此操作提交后无法撤销。</span></label>
    <div class="device-renewal-error" id="device-renewal-error"></div>
  </div>`;
  const submit = el("device-reset-submit");
  el("device-reset-ack").addEventListener("change", event => { submit.disabled = !event.target.checked; });
  el("device-confirm-back").addEventListener("click", () => showDeviceRenewal(result));
  submit.addEventListener("click", async () => {
    if (!el("device-reset-ack").checked) return;
    setBusy(submit, true, "正在处理…");
    try {
      const response = await window.appleDeveloper.resetDevices({ deviceIds: selectedIds });
      if (!response?.success) throw new Error(response?.error || "设备列表重置失败");
      markDeviceRenewalCompleted();
      await refreshModule("devices");
    } catch (error) {
      el("device-renewal-error").textContent = error.message;
      setBusy(submit, false);
    }
  });
}

function closeDeviceActionDialog() { document.querySelector(".device-action-overlay")?.remove(); }

function openDeviceRenameDialog(device) {
  closeDeviceActionDialog();
  const overlay = document.createElement("div");
  overlay.className = "device-action-overlay";
  overlay.innerHTML = `<form class="device-action-dialog device-rename-dialog"><div class="device-action-head"><h2>重命名设备</h2><button class="device-action-close" type="button">×</button></div><div class="device-action-body"><p class="device-action-copy">修改设备在 Apple Developer 中显示的名称，UDID 不会改变。</p><div class="field"><label for="device-rename-input">设备名称</label><input id="device-rename-input" maxlength="100" value="${escapeHTML(device.name)}" required></div><div class="device-action-error"></div></div><div class="device-action-foot"><button class="secondary" data-cancel type="button">取消</button><button class="primary" type="submit">保存</button></div></form>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector("form"), input = overlay.querySelector("#device-rename-input"), errorBox = overlay.querySelector(".device-action-error");
  overlay.querySelector(".device-action-close").onclick = closeDeviceActionDialog;
  overlay.querySelector("[data-cancel]").onclick = closeDeviceActionDialog;
  form.onsubmit = async event => {
    event.preventDefault();
    const name = input.value.trim(), button = form.querySelector('[type="submit"]');
    if (!name) { errorBox.textContent = "请输入设备名称"; return; }
    if (name === device.name) { closeDeviceActionDialog(); return; }
    setBusy(button, true, "保存中…"); errorBox.textContent = "";
    const response = await window.appleDeveloper.updateDevice({ id: device.id, name, platform: device.platform }).catch(error => ({ success: false, error: error.message }));
    if (!response?.success) { errorBox.textContent = response?.error || "设备重命名失败"; setBusy(button, false); return; }
    closeDeviceActionDialog(); await loadDevices();
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function parseDeviceImportText(text, platform) {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    let fields = line.includes("\t") ? line.split("\t") : line.includes(",") ? line.split(",") : (line.match(/^(\S+)\s+(.+)$/)?.slice(1) || [line]);
    fields = fields.map(value => value.trim()).filter(Boolean);
    if (index === 0 && fields.some(value => /^(udid|名称|name|设备名称)$/i.test(value))) return null;
    const firstLooksLikeUdid = /^[A-Za-z0-9-]{16,}$/.test(fields[0] || "");
    const udid = firstLooksLikeUdid ? fields[0] : fields[1];
    const name = firstLooksLikeUdid ? fields.slice(1).join(" ") : fields[0];
    return name && udid ? { name, udid, platform } : null;
  }).filter(Boolean);
}

function markDeviceRenewalCompleted() {
  deviceRenewalSuppressNextLoad = true;
  lastDeviceRenewalCompletedAt = Date.now();
}

function openDeviceBatchImportDialog() {
  closeDeviceActionDialog();
  const overlay = document.createElement("div");
  overlay.className = "device-action-overlay";
  overlay.innerHTML = `<div class="device-action-dialog"><div class="device-action-head"><h2>批量导入设备</h2><button class="device-action-close" type="button">×</button></div><div class="device-action-body"><p class="device-action-copy">每行一台设备：UDID 后面可跟名称（用 Tab、逗号或空格分隔）。</p><div class="device-action-row"><button class="secondary" id="device-import-from-file" type="button">↥&nbsp; 从文件导入</button><select id="device-import-platform"><option value="IOS">IOS</option><option value="MAC_OS">MAC_OS</option><option value="TV_OS">TV_OS</option><option value="WATCH_OS">WATCH_OS</option><option value="VISION_OS">VISION_OS</option><option value="UNIVERSAL">UNIVERSAL</option></select><span class="device-import-count">已解析 <b>0</b> 台</span><input id="device-import-dialog-file" type="file" accept=".csv,.txt,.tsv" hidden></div><textarea class="device-import-text" id="device-import-text" placeholder="00008030-001234567890ABCD    小明的 iPhone&#10;00008020-000987654321DCBA, 测试 iPad"></textarea><div class="device-action-error"></div></div><div class="device-action-foot"><button class="secondary" data-cancel type="button">取消</button><button class="primary" id="device-import-submit" type="button" disabled>导入 0 台</button></div></div>`;
  document.body.appendChild(overlay);
  const textarea = overlay.querySelector("#device-import-text"), platform = overlay.querySelector("#device-import-platform"), submit = overlay.querySelector("#device-import-submit"), errorBox = overlay.querySelector(".device-action-error"), count = overlay.querySelector(".device-import-count b");
  const parsed = () => parseDeviceImportText(textarea.value, platform.value);
  const update = () => { const total = parsed().length; count.textContent = String(total); submit.textContent = `导入 ${total} 台`; submit.disabled = total === 0; errorBox.textContent = ""; };
  textarea.addEventListener("input", update); platform.addEventListener("change", update);
  overlay.querySelector(".device-action-close").onclick = closeDeviceActionDialog;
  overlay.querySelector("[data-cancel]").onclick = closeDeviceActionDialog;
  overlay.querySelector("#device-import-from-file").onclick = () => overlay.querySelector("#device-import-dialog-file").click();
  overlay.querySelector("#device-import-dialog-file").onchange = async event => { const file = event.target.files?.[0]; if (file) { textarea.value = await file.text(); update(); } };
  submit.onclick = async () => {
    const items = parsed(); if (!items.length) return;
    setBusy(submit, true, `正在导入 0/${items.length}`); errorBox.textContent = "";
    let succeeded = 0; const failures = [];
    for (const [index, item] of items.entries()) {
      submit.textContent = `正在导入 ${index + 1}/${items.length}`;
      const response = await window.appleDeveloper.addDevice(item).catch(error => ({ success: false, error: error.message }));
      if (response?.success) succeeded += 1; else failures.push(`${item.name}：${response?.error || "导入失败"}`);
    }
    if (failures.length) { errorBox.textContent = `成功 ${succeeded} 台，失败 ${failures.length} 台：${failures.join("；")}`; setBusy(submit, false); update(); return; }
    closeDeviceActionDialog(); await loadDevices();
  };
  setTimeout(() => textarea.focus(), 0);
}

async function loadDevices() {
  const page = el("page-devices");
  const shouldOpenAddDevice = openDeviceAddAfterDeviceLoad;
  openDeviceAddAfterDeviceLoad = false;
  page.innerHTML = '<div class="device-list-page"><div class="device-list-heading"><div><h2>设备</h2><p>注册用于开发与 Ad Hoc 分发的设备</p></div></div><div class="module"><div class="loading-state">正在读取 Apple 设备列表…</div></div></div>';
  const result = await window.appleDeveloper.devices();
  if (!result?.success) {
    if (result?.authenticated === false) applyStatus({ authenticated: false });
    if (result?.teamRequired) ensureTeamSelection(true);
    page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">测试设备管理</span><button class="primary" onclick="refreshModule('devices')">重试</button></div><div class="empty"><strong>读取失败</strong><span>${escapeHTML(result?.error || "无法获取设备列表")}</span></div></div>`;
    return;
  }
  if (result.team) {
    currentSelectedTeam = { ...(currentSelectedTeam || {}), ...result.team };
  }
  const rows = result.devices || [];
  const renewalReviewRequired = result.renewalReviewRequired && !deviceRenewalSuppressNextLoad;
  deviceRenewalSuppressNextLoad = false;
  const canAdd = !renewalReviewRequired && (result.permissions?.canAddIOS || result.permissions?.canAddMac);
  if (shouldOpenAddDevice && canAdd) {
    showAddDevice(result);
    return;
  }
  const notice = renewalReviewRequired ? `<div class="device-notice"><span class="device-notice-icon">⚠</span><span class="device-notice-text">${escapeHTML(result.notice)}</span><button class="primary" id="device-renewal-continue" type="button">继续</button></div>` : "";
  const table = rows.length ? `<div class="device-table-wrap"><table class="data-table device-table device-list-table"><thead><tr><th>名称</th><th>UDID</th><th>平台</th><th>设备类型</th><th>状态</th><th>操作</th></tr></thead><tbody id="device-table-body">${rows.map(item => {
    const enabled = String(item.status).toUpperCase() === "ENABLED";
    const platform = String(item.platform || item.type || "—").toUpperCase();
    const statusText = localizedDeviceStatus(item.status);
    return `<tr class="${enabled ? "" : "device-row-disabled"}" data-search="${escapeHTML(`${item.name} ${item.udid} ${platform} ${item.type} ${item.model}`.toLowerCase())}"><td class="bundle-name">${escapeHTML(item.name)}</td><td class="device-udid">${escapeHTML(item.udid)}</td><td>${escapeHTML(platform)}</td><td>${escapeHTML(String(item.type || item.model || "—").toUpperCase())}</td><td><span class="device-state ${enabled ? "enabled" : "disabled"}">${escapeHTML(statusText)}</span></td><td><div class="device-row-actions"><button class="device-rename" type="button" data-id="${escapeHTML(item.id)}">重命名</button><button class="${enabled ? "device-stop" : "device-start"}" type="button" data-id="${escapeHTML(item.id)}">${enabled ? "停用" : "启用"}</button></div></td></tr>`;
  }).join("")}</tbody></table></div>` : '<div class="empty"><div class="empty-icon">▣</div><strong>暂无测试设备</strong><span>当前团队没有可显示的数据</span></div>';
  page.innerHTML = `<div class="device-list-page">${notice}<div class="device-list-heading"><div><h2>设备</h2><p>注册用于开发与 Ad Hoc 分发的设备</p></div><div class="device-list-tools"><label class="device-search-wrap"><span>⌕</span><input class="device-search" id="device-search" placeholder="搜索名称 / ID / UDID"></label><button class="secondary" id="device-refresh" type="button">↻&nbsp; 刷新</button><button class="secondary" id="device-batch-import" type="button" ${canAdd ? "" : "disabled"}>↥&nbsp; 批量导入</button>${renewalReviewRequired ? '<button class="secondary" id="device-reset-list" type="button">↻&nbsp; 重置设备</button>' : ""}<button class="primary device-register" id="device-add" type="button" ${canAdd ? "" : "disabled"}>＋ 注册设备</button></div></div><div class="module device-list-module">${table}</div></div>`;
  el("device-search")?.addEventListener("input", event => {
    const keyword = event.target.value.trim().toLowerCase();
    page.querySelectorAll("#device-table-body tr").forEach(row => row.classList.toggle("hidden", keyword && !row.dataset.search.includes(keyword)));
  });
  el("device-refresh")?.addEventListener("click", loadDevices);
  el("device-renewal-continue")?.addEventListener("click", () => showDeviceRenewal(result));
  el("device-reset-list")?.addEventListener("click", () => showDeviceRenewal(result));
  el("device-add")?.addEventListener("click", () => {
    if (!canAdd) return;
    showAddDevice(result);
  });
  page.querySelectorAll(".device-rename").forEach(button => button.addEventListener("click", () => {
    const device = rows.find(item => item.id === button.dataset.id);
    if (device) openDeviceRenameDialog(device);
  }));
  page.querySelectorAll(".device-stop,.device-start").forEach(button => button.addEventListener("click", async () => {
    const device = rows.find(item => item.id === button.dataset.id);
    if (!device) return;
    const enabling = button.classList.contains("device-start");
    if (!confirm(`确定${enabling ? "启用" : "停用"}设备“${device.name}”吗？`)) return;
    setBusy(button, true, "处理中…");
    const response = enabling
      ? await window.appleDeveloper.enableDevice({ id: device.id, udid: device.udid, platform: device.platform })
      : await window.appleDeveloper.disableDevice({ id: device.id, platform: device.platform, single: true });
    if (!response?.success) { alert(response?.error || `设备${enabling ? "启用" : "停用"}失败`); setBusy(button, false); return; }
    await loadDevices();
  }));
  el("device-batch-import")?.addEventListener("click", openDeviceBatchImportDialog);
  if (shouldOpenAddDevice && !canAdd) {
    setTimeout(() => alert(renewalReviewRequired ? "当前会员年度需要先重置设备列表，完成后才能添加设备。" : "当前团队没有添加设备权限。"), 0);
  }
}

async function showEditBundleId(resourceId) {
  const mask = el("bundle-edit-mask");
  const errorBox = el("bundle-edit-error");
  editingBundleDetail = null;
  errorBox.textContent = "正在读取 Identifier 配置…";
  el("bundle-edit-submit").disabled = true;
  mask.classList.add("show");
  try {
    const result = await window.appleDeveloper.bundleIdDetail({ id: resourceId });
    if (!result?.success) throw new Error(result?.error || "Identifier 详情读取失败");
    editingBundleDetail = result.bundleId;
    el("bundle-edit-resource-id").value = editingBundleDetail.id;
    el("bundle-edit-name").value = editingBundleDetail.name;
    el("bundle-edit-identifier").value = editingBundleDetail.identifier;
    el("bundle-edit-capabilities").innerHTML = renderBundleCapabilityEditor(editingBundleDetail);
    bindBundleCapabilityEditor();
    errorBox.textContent = "";
    el("bundle-edit-submit").disabled = !editingBundleDetail.editable;
  } catch (error) { errorBox.textContent = error.message; }
}

function closeEditBundleId() { el("bundle-edit-mask").classList.remove("show"); editingBundleDetail = null; }

function pushCertificateSection(title, description, typeId, certificates) {
  const rows = certificates.length ? `<div class="push-cert-list">${certificates.map(item => `<div class="push-cert-item"><div><strong>${escapeHTML(item.name)}</strong><small>到期时间：${escapeHTML(formatCertificateDate(item.expirationDate))} · ${escapeHTML(localizedCertificateStatus(item.status))}</small></div><div class="push-cert-actions"><button class="secondary push-config-download" type="button" data-id="${escapeHTML(item.id)}" data-type="${escapeHTML(item.typeId)}" data-filename="${escapeHTML(item.downloadFileName || "certificate.cer")}">下载</button><button class="certificate-revoke push-config-revoke" type="button" data-id="${escapeHTML(item.id)}" data-type="${escapeHTML(item.typeId)}" data-name="${escapeHTML(item.name)}">撤销</button></div></div>`).join("")}</div>` : '<div class="push-cert-empty">当前没有有效证书</div>';
  return `<section class="push-cert-section"><h4>${title}</h4><p>${description}</p>${rows}<button class="secondary push-create" type="button" data-type="${typeId}">创建证书</button></section>`;
}

async function showPushConfigureDialog(appId, appName = "") {
  pushConfigureApp = { id: appId, name: appName };
  el("push-config-content").innerHTML = '<div class="loading-state">正在读取推送证书…</div>';
  el("push-config-error").textContent = "";
  el("push-config-mask").classList.add("show");
  try {
    const result = await window.appleDeveloper.certificates();
    if (!result?.success) throw new Error(result?.error || "推送证书读取失败");
    const rows = (result.certificates || []).filter(item => item.ownerId === appId);
    if (editingBundleDetail?.id === appId) {
      const count = document.querySelector('[data-capability-count="PUSH_NOTIFICATIONS"]');
      if (count) count.textContent = `Certificates (${rows.length})`;
    }
    const development = rows.filter(item => item.typeId === "JKG5JZ54H7");
    const production = rows.filter(item => item.typeId === "UPV3DW712I" || item.typeId === "BKLRAVXMGM");
    el("push-config-content").innerHTML = pushCertificateSection("开发环境 SSL 证书", "创建用于 APNs 沙盒（开发）环境的客户端 SSL 证书。", "JKG5JZ54H7", development) + pushCertificateSection("生产环境 SSL 证书", "创建用于 APNs 沙盒与生产环境的客户端 SSL 证书。", "UPV3DW712I", production);
    el("push-config-content").querySelectorAll(".push-create").forEach(button => button.addEventListener("click", async () => {
      const typeId = button.dataset.type;
      const p12Password = prompt("请输入此推送证书的 P12 密码", "");
      if (p12Password === null) return;
      if (!String(p12Password).trim()) { el("push-config-error").textContent = "P12 密码不能为空"; return; }
      setBusy(button, true, "正在创建…");
      el("push-config-error").textContent = "";
      try {
        const created = await window.appleDeveloper.createCertificate({ typeId, appIdId: appId, p12Password: String(p12Password).trim() });
        if (!created?.success) throw new Error(created?.error || "推送证书创建失败");
        const certificateType = created.certificate?.certificateType || {};
        const download = await window.appleDeveloper.downloadCertificate({ id: created.certificateId, typeId, filename: certificateType.downloadFileName || "certificate.cer" });
        if (!download?.success && !download?.canceled) throw new Error(download?.error || "证书已创建，但下载失败");
        await showPushConfigureDialog(appId, appName);
      } catch (error) { el("push-config-error").textContent = error.message; }
      finally { setBusy(button, false); }
    }));
    el("push-config-content").querySelectorAll(".push-config-download").forEach(button => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const download = await window.appleDeveloper.downloadCertificate({ id: button.dataset.id, typeId: button.dataset.type, filename: button.dataset.filename });
        if (!download?.success && !download?.canceled) throw new Error(download?.error || "证书下载失败");
      } catch (error) { el("push-config-error").textContent = error.message; }
      finally { button.disabled = false; }
    }));
    el("push-config-content").querySelectorAll(".push-config-revoke").forEach(button => button.addEventListener("click", async () => {
      if (!confirm(`确定撤销推送证书“${button.dataset.name || "Apple 推送证书"}”吗？撤销后无法恢复。`)) return;
      button.disabled = true;
      try {
        const revoked = await window.appleDeveloper.revokeCertificate({ id: button.dataset.id, typeId: button.dataset.type });
        if (!revoked?.success) throw new Error(revoked?.error || "证书撤销失败");
        await showPushConfigureDialog(appId, appName);
      } catch (error) { el("push-config-error").textContent = error.message; button.disabled = false; }
    }));
  } catch (error) {
    el("push-config-content").innerHTML = '<div class="push-cert-empty">推送证书读取失败</div>';
    el("push-config-error").textContent = error.message;
  }
}

function closePushConfigureDialog() { el("push-config-mask").classList.remove("show"); pushConfigureApp = null; }

async function submitEditBundleId() {
  if (!editingBundleDetail) return;
  const button = el("bundle-edit-submit");
  const errorBox = el("bundle-edit-error");
  const name = el("bundle-edit-name").value.trim();
  if (!name) { errorBox.textContent = "请输入 Description"; return; }
  setBusy(button, true, "保存中…");
  errorBox.textContent = "";
  try {
    const capabilities = bundleCapabilityPayloadFromEditor();
    const push = capabilities.find(item => item.id === "PUSH_NOTIFICATIONS");
    const result = await window.appleDeveloper.updateBundleId({ id: editingBundleDetail.id, name, capabilities, broadcastCapability: push?.enabled === true && bundleCapabilitySettingEnabled("PUSH_NOTIFICATIONS", "PUSH_NOTIFICATION_FEATURE_BROADCAST") });
    if (!result?.success) throw new Error(result?.error || "Identifier 修改失败");
    closeEditBundleId();
    await loadBundleIds();
  } catch (error) { errorBox.textContent = error.message; }
  finally { setBusy(button, false); }
}

async function loadCertificates() {
  const page = el("page-certificates");
  page.innerHTML = '<div class="module"><div class="module-bar"><span class="module-title">证书管理</span></div><div class="loading-state">正在读取 Apple 证书…</div></div>';
  const result = await window.appleDeveloper.certificates();
  if (!result?.success) {
    page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">证书管理</span><button class="primary" onclick="refreshModule('certificates')">重试</button></div><div class="empty"><strong>读取失败</strong><span>${escapeHTML(result?.error || "无法获取证书")}</span></div></div>`;
    return;
  }
  const rows = result.certificates || [];
  const fallbackP12Password = defaultP12Password();
  const content = rows.length ? `<table class="data-table certificate-table"><thead><tr><th>名称</th><th>类型</th><th>平台</th><th>到期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(item => { const p12Password = escapeHTML(item.p12Password || fallbackP12Password); return `<tr><td class="bundle-name">${escapeHTML(item.name)}</td><td>${escapeHTML(localizedCertificateType(item))}</td><td>${escapeHTML(item.platform)}</td><td class="certificate-date">${escapeHTML(formatCertificateDate(item.expirationDate))}</td><td>${escapeHTML(localizedCertificateStatus(item.status))}</td><td><div class="certificate-actions"><span class="certificate-p12-label">P12 密码:<strong class="certificate-p12-password-text">${p12Password}</strong></span><button class="secondary certificate-p12-edit" type="button" data-id="${escapeHTML(item.id)}">修改</button><button class="secondary certificate-p12" data-id="${escapeHTML(item.id)}" data-type="${escapeHTML(item.typeId)}" data-name="${escapeHTML(item.name)}">下载 P12</button><button class="certificate-revoke" data-id="${escapeHTML(item.id)}" data-type="${escapeHTML(item.typeId)}" data-name="${escapeHTML(item.name)}" data-type-name="${escapeHTML(localizedCertificateType(item))}">撤销证书</button></div></td></tr>`; }).join("")}</tbody></table>` : '<div class="empty"><div class="empty-icon">✿</div><strong>暂无证书</strong><span>当前团队下没有可显示的证书</span></div>';
  page.innerHTML = `<div class="module"><div class="module-bar"><span class="module-title">证书管理</span><span class="table-meta">共 ${Number(result.total || rows.length)} 条</span><div class="module-actions"><button class="secondary" id="add-certificate" type="button">创建证书</button><button class="primary icon-button icon-refresh" id="certificates-refresh" type="button" title="刷新" aria-label="刷新"><span aria-hidden="true">↻</span></button></div></div><div class="certificate-table-wrap">${content}</div></div>`;
  el("add-certificate")?.addEventListener("click", () => showCreateCertificate());
  el("certificates-refresh")?.addEventListener("click", () => refreshModule("certificates"));
  page.querySelectorAll(".certificate-p12-edit").forEach(button => button.addEventListener("click", () => editCertificateP12Password(button)));
  page.querySelectorAll(".certificate-p12").forEach(button => button.addEventListener("click", async () => {
    const password = button.closest("tr")?.querySelector(".certificate-p12-password-text")?.textContent?.trim() || defaultP12Password();
    if (!password) { alert("P12 导出密码不能为空"); return; }
    button.disabled = true;
    try { const result = await window.appleDeveloper.exportP12({ id: button.dataset.id, typeId: button.dataset.type, name: button.dataset.name, password }); if (!result?.success && !result?.canceled) throw new Error(result?.error || "P12 导出失败"); if (result?.success) saveP12Password(password); }
    catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }));
  page.querySelectorAll(".certificate-revoke").forEach(button => button.addEventListener("click", async () => {
    const description = `${button.dataset.name || "Apple 证书"}（${button.dataset.typeName || "未知类型"}）`;
    if (!confirm(`确定撤销 ${description} 吗？\n\n撤销后该证书会立即失效，无法恢复，可能导致已签名的开发或分发流程受影响。`)) return;
    button.disabled = true;
    button.textContent = "撤销中…";
    try {
      const result = await window.appleDeveloper.revokeCertificate({ id: button.dataset.id, typeId: button.dataset.type });
      if (!result?.success) throw new Error(result?.error || "证书撤销失败");
      await loadCertificates();
    } catch (error) {
      alert(error.message || "证书撤销失败");
      button.disabled = false;
      button.textContent = "撤销证书";
    }
  }));
}

async function showCreateCertificate(preselectTypeId = "", preselectAppId = "") {
  const list = el("certificate-type-list");
  const submit = el("certificate-create-submit");
  list.innerHTML = '<div class="loading-state">正在读取 Apple 可创建状态…</div>';
  submit.disabled = true;
  el("certificate-create-error").textContent = "";
  el("certificate-app-id-field").classList.add("hidden");
  el("certificate-app-id").innerHTML = '<option value="">请选择 App ID</option>';
  el("certificate-p12-password").value = "";
  el("certificate-p12-password-confirm").value = "";
  el("certificate-create-mask").classList.add("show");
  try {
    const result = await window.appleDeveloper.certificateTypes();
    if (!result?.success) throw new Error(result?.error || "无法读取证书类型状态");
    certificateTypes = result.types || [];
    const renderGroup = (category, title) => `<section class="certificate-type-group"><h4>${title}</h4><div class="certificate-type-options">${certificateTypes.filter(type => type.category === category).map(type => `<label class="certificate-type-option ${type.allowed ? "" : "disabled"}"><input type="radio" name="certificate-type" value="${escapeHTML(type.id)}" ${type.allowed ? "" : "disabled"}><span><strong>${escapeHTML(type.name)} · ${escapeHTML(type.platform)}</strong><small>${escapeHTML(type.description)}</small>${type.allowed ? "" : `<small class="certificate-type-reason">不可创建：${escapeHTML(type.reason)}</small>`}</span></label>`).join("")}</div></section>`;
    list.innerHTML = renderGroup("software", "软件签名证书") + renderGroup("service", "服务证书");
    const first = list.querySelector('input[name="certificate-type"]:not(:disabled)');
    if (first) first.checked = true;
    const preferred = preselectTypeId ? list.querySelector(`input[name="certificate-type"][value="${preselectTypeId}"]:not(:disabled)`) : null;
    if (preferred) preferred.checked = true;
    submit.disabled = !certificateTypes.some(type => type.allowed);
    const bundleResult = await window.appleDeveloper.bundleIds();
    certificateAppIds = bundleResult?.success ? (bundleResult.bundleIds || []).filter(item => !item.wildcard && !String(item.identifier || "").includes("*")) : [];
    el("certificate-app-id").innerHTML = '<option value="">请选择 App ID</option>' + certificateAppIds.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.name)} (${escapeHTML(item.identifier)})</option>`).join("");
    if (preselectAppId && certificateAppIds.some(item => item.id === preselectAppId)) el("certificate-app-id").value = preselectAppId;
    list.querySelectorAll('input[name="certificate-type"]').forEach(input => input.addEventListener("change", updateCertificateAppIdField));
    updateCertificateAppIdField();
  } catch (error) {
    list.innerHTML = '<div class="loading-state">证书类型读取失败</div>';
    el("certificate-create-error").textContent = error.message;
  }
}
function updateCertificateAppIdField() {
  const typeId = document.querySelector('input[name="certificate-type"]:checked')?.value || "";
  const requiresAppId = typeId === "JKG5JZ54H7" || typeId === "UPV3DW712I";
  el("certificate-app-id-field").classList.toggle("hidden", !requiresAppId);
  el("certificate-create-submit").disabled = !typeId || (requiresAppId && !certificateAppIds.length);
  if (requiresAppId && !certificateAppIds.length) el("certificate-create-error").textContent = "当前团队没有可用于推送证书的 App ID";
  else el("certificate-create-error").textContent = "";
}
function closeCreateCertificate() { el("certificate-create-mask").classList.remove("show"); }
async function submitCreateCertificate() {
  const button = el("certificate-create-submit");
  const errorBox = el("certificate-create-error");
  errorBox.textContent = "";
  setBusy(button, true, "正在生成并创建…");
  try {
    const selected = document.querySelector('input[name="certificate-type"]:checked');
    if (!selected) throw new Error("请选择证书类型");
    const typeId = selected.value;
    const appIdId = el("certificate-app-id").value;
    if ((typeId === "JKG5JZ54H7" || typeId === "UPV3DW712I") && !appIdId) throw new Error("请选择推送证书关联的 App ID");
    const p12Password = el("certificate-p12-password").value.trim();
    const p12PasswordConfirm = el("certificate-p12-password-confirm").value.trim();
    if (!p12Password) throw new Error("请输入此证书的 P12 密码");
    if (p12Password !== p12PasswordConfirm) throw new Error("两次输入的 P12 密码不一致");
    const result = await window.appleDeveloper.createCertificate({ typeId, appIdId, p12Password });
    if (!result?.success) throw new Error(result?.error || "证书创建失败");
    closeCreateCertificate();
    const certificateType = result.certificate?.certificateType || {};
    await window.appleDeveloper.downloadCertificate({
      id: result.certificateId,
      typeId,
      filename: certificateType.downloadFileName || "certificate.cer",
    });
    await loadCertificates();
  } catch (error) { errorBox.textContent = error.message; }
  finally { setBusy(button, false); }
}

async function deleteBundleId(button) {
  const identifier = button.dataset.identifier || "";
  const name = button.dataset.name || identifier;
  if (!confirm(`确定删除 Bundle ID“${name}”（${identifier}）吗？\n\n删除后无法恢复，并可能影响关联的证书和描述文件。`)) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "删除中…";
  try {
    const result = await window.appleDeveloper.deleteBundleId({ id: button.dataset.id, identifier });
    if (!result?.success) throw new Error(result?.error || "Bundle ID 删除失败");
    await loadBundleIds();
  } catch (error) {
    alert(error.message || "Bundle ID 删除失败");
    button.disabled = false;
    button.textContent = original;
  }
}

async function showCreateBundleId() {
  el("bundle-name-input").value = "";
  el("bundle-identifier-input").value = "";
  creatingBundleDetail = null;
  el("bundle-create-capabilities").innerHTML = '<div class="capability-empty">正在读取 Apple Capabilities…</div>';
  el("bundle-create-error").textContent = "";
  el("bundle-create-submit").disabled = true;
  el("bundle-create-mask").classList.add("show");
  el("bundle-name-input").focus();
  try {
    const result = await window.appleDeveloper.bundleCapabilities();
    if (!result?.success) throw new Error(result?.error || "Capabilities 读取失败");
    creatingBundleDetail = { editable: true, capabilities: result.capabilities || [] };
    el("bundle-create-capabilities").innerHTML = renderBundleCapabilityEditor(creatingBundleDetail, { allowPushConfigure: false });
    bindBundleCapabilityEditor("bundle-create-capabilities", { allowPushConfigure: false });
    el("bundle-create-submit").disabled = false;
  } catch (error) {
    el("bundle-create-error").textContent = error.message || "Capabilities 读取失败";
    el("bundle-create-capabilities").innerHTML = '<div class="capability-empty">Apple 未返回可创建的 Capabilities。</div>';
  }
}

function closeCreateBundleId() { el("bundle-create-mask").classList.remove("show"); creatingBundleDetail = null; }

async function submitCreateBundleId() {
  const name = el("bundle-name-input").value.trim();
  const identifier = el("bundle-identifier-input").value.trim();
  const errorBox = el("bundle-create-error");
  errorBox.textContent = "";
  if (!name) { errorBox.textContent = "请输入描述名称"; return; }
  if (!identifier) { errorBox.textContent = "请输入 Bundle ID"; return; }
  if (!/^[A-Za-z0-9.-]+$/.test(identifier) || identifier.startsWith(".") || identifier.endsWith(".") || identifier.includes("..")) {
    errorBox.textContent = "Bundle ID 格式无效，仅允许字母、数字、点和连字符";
    return;
  }
  if (!creatingBundleDetail?.capabilities?.length) { errorBox.textContent = "Capabilities 尚未加载完成，请稍后重试"; return; }
  const capabilities = bundleCapabilityPayloadFromEditor("bundle-create-capabilities");
  const push = capabilities.find(item => item.id === "PUSH_NOTIFICATIONS");
  const button = el("bundle-create-submit");
  setBusy(button, true, "正在创建…");
  try {
    const result = await window.appleDeveloper.createBundleId({ name, identifier, capabilities, broadcastCapability: push?.enabled === true && bundleCapabilitySettingEnabled("PUSH_NOTIFICATIONS", "PUSH_NOTIFICATION_FEATURE_BROADCAST", "bundle-create-capabilities") });
    if (!result?.success) throw new Error(result?.error || "Bundle ID 创建失败");
    closeCreateBundleId();
    await loadBundleIds();
  } catch (error) { errorBox.textContent = error.message; }
  finally { setBusy(button, false); }
}

function formatAccessDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function maskDeveloperAccount(value) {
  const account = String(value || "").trim();
  if (!account) return "-";
  const [name, domain] = account.split("@");
  if (!domain) return `${account.slice(0, 2)}xxxxx`;
  return `${name.slice(0, 2)}xxxxx`;
}

function applyTopAccountStatus() {
  const developerText = authenticated && launchAppleId
    ? `开发者账户:${launchAppleId}`
    : authenticated
    ? "开发者账户:未获取"
    : "开发者账户:未登录";
  if (el("developer-status")) el("developer-status").textContent = developerText;
  const accountLabel = launchAppleId && (authenticated || browserBoundLaunch) ? launchAppleId : "登录";
  el("account-logo")?.classList.toggle("signed-out", !authenticated);
  if (el("account-current-id")) el("account-current-id").textContent = accountLabel;
  if (el("account-avatar")) el("account-avatar").textContent = launchAppleId && (authenticated || browserBoundLaunch) ? launchAppleId.slice(0, 1).toUpperCase() : "?";
  if (el("account-summary-id")) el("account-summary-id").textContent = accountLabel;
  if (el("account-summary-avatar")) el("account-summary-avatar").textContent = launchAppleId && (authenticated || browserBoundLaunch) ? launchAppleId.slice(0, 1).toUpperCase() : "?";
}

async function refreshTopDeveloperAccount() {
  if (!authenticated) { applyTopAccountStatus(); return; }
  const generation = homeOverviewGeneration;
  try {
    const result = await loadHomeAccountInfo();
    if (generation !== homeOverviewGeneration) return;
    const appleId = String(result?.account?.appleId || "").trim();
    if (result?.success && appleId) {
      launchAppleId = appleId;
      if (el("apple-id") && !el("apple-id").value) el("apple-id").value = appleId;
      if (el("ipa-upload-apple-id")) el("ipa-upload-apple-id").value = appleId;
    }
  } catch {}
  applyTopAccountStatus();
}

function applyAccess(access) {
  currentAccess = access || null;
  const badge = el("access-expiry");
  const explicitExpiry = access?.activated ? access.authorizationExpiresAt : access?.trialExpiresAt;
  let expiryText = formatAccessDate(explicitExpiry);
  if (!expiryText && access?.allowed && Number.isFinite(Number(access.remainingDays ?? access.trialDays))) {
    const days = Math.max(0, Number(access.remainingDays ?? access.trialDays));
    expiryText = formatAccessDate(Date.now() + days * 24 * 60 * 60 * 1000);
  }
  if (expiryText) badge.textContent = expiryText;
  else if (access?.authorizationExpired) badge.textContent = "已到期";
  else if (access && access.allowed === false) badge.textContent = "已到期";
  else badge.textContent = "—";
}

function clearAccessPaymentFlow() {
  accessPaymentRequestId += 1;
  if (accessPaymentTimer) clearInterval(accessPaymentTimer);
  accessPaymentTimer = null;
  accessPaymentOrderNo = "";
  const area = el("access-payment-area");
  if (area) {
    area.classList.remove("show");
    area.innerHTML = "";
  }
}

function renderAccessPaymentSummary(result) {
  const area = el("access-payment-area");
  if (!area) return;
  const method = ["alipay", "wechat"].includes(result?.pay_method) ? result.pay_method : accessPaymentMethod;
  const label = method === "wechat" ? "微信支付" : "支付宝付款";
  const amount = Number(result?.amount || 0);
  const original = Math.max(amount, Number(result?.original_price || amount));
  const savings = Math.max(0, Number(result?.savings || (original - amount)));
  const paymentPane = result?.payment_flow === "embedded" && result?.pay_url
    ? `<iframe src="${escapeHTML(result.pay_url)}" title="${label}" style="width:100%;height:230px;border:1px solid #d8e0eb;border-radius:8px;background:#fff"></iframe>`
    : (result?.qr_image ? `<div class="access-payment-qr-box"><img src="${escapeHTML(result.qr_image)}" alt="${label}二维码"></div>` : "<strong>付款订单已创建，请在付款页面完成支付</strong>");
  area.innerHTML = `${paymentPane}<span class="access-price"><b>${label}</b><strong>¥${amount.toFixed(2)}</strong>${savings > 0 ? `<del>¥${original.toFixed(2)}</del><em>立省 ¥${savings.toFixed(2)}</em>` : ""}<small id="access-payment-status">等待支付…</small></span>`;
  area.classList.add("show");
}

function setAccessPaymentMethod(method) {
  accessPaymentMethod = method === "wechat" ? "wechat" : "alipay";
  document.querySelectorAll("[data-access-pay-method]").forEach(button => {
    const active = button.dataset.accessPayMethod === accessPaymentMethod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function finalizeAccessPayment(orderNo) {
  const statusNode = el("access-payment-status");
  if (statusNode) statusNode.textContent = "支付成功，正在领取授权码…";
  const revealed = await window.appleDeveloper.revealAccessCode(orderNo);
  if (!revealed?.success || !revealed.code) throw new Error(revealed?.error || "支付成功，但授权码领取失败");
  const activated = await window.appleDeveloper.activateAccess(revealed.code);
  if (!activated?.success) throw new Error(activated?.error || "支付成功，但授权开通失败");
  if (statusNode) statusNode.textContent = "支付成功，正在刷新授权时间…";
  const refreshed = await window.appleDeveloper.access().catch(() => null);
  const activatedExpiry = Date.parse(activated.access?.authorizationExpiresAt || "") || 0;
  const refreshedExpiry = Date.parse(refreshed?.access?.authorizationExpiresAt || "") || 0;
  const latestAccess = refreshed?.success && refreshed?.access && refreshedExpiry >= activatedExpiry
    ? refreshed.access
    : activated.access;
  applyAccess(latestAccess);
  const destination = pendingAccessPage;
  closeAccessDialog();
  if (destination) await showPage(destination, true);
  if (destination === "home" || el("page-home")?.classList.contains("active")) renderHomePage();
}

async function resolveAccessPaymentIdentity() {
  let appleId = String(launchAppleId || homeAccountInfo?.account?.appleId || "").trim();
  let accountId = String(launchAccountId || browserDesktopAccount?.id || "").trim();
  const context = await window.appleDeveloper.launchContext().catch(() => null);
  if (!appleId && context?.appleId) appleId = String(context.appleId || "").trim();
  if (!accountId && context?.accountId) accountId = String(context.accountId || "").trim();
  if (!accountId && context?.desktopAccount?.id) accountId = String(context.desktopAccount.id || "").trim();
  if (!appleId && authenticated) {
    const result = await loadHomeAccountInfo().catch(() => null);
    const resolvedAppleId = String(result?.account?.appleId || "").trim();
    if (resolvedAppleId) appleId = resolvedAppleId;
  }
  if (appleId) launchAppleId = appleId;
  if (accountId) launchAccountId = accountId;
  return { appleId, accountId };
}

async function checkAccessPaymentStatus({ manual = false, requestId = accessPaymentRequestId, orderNo = accessPaymentOrderNo } = {}) {
  const error = el("access-error");
  if (!orderNo) {
    if (manual && error) error.textContent = "支付订单正在生成，请稍后再试";
    return;
  }
  const status = await window.appleDeveloper.accessPaymentStatus(orderNo).catch(() => ({}));
  if (requestId !== accessPaymentRequestId || orderNo !== accessPaymentOrderNo) return;
  const statusNode = el("access-payment-status");
  if (statusNode) statusNode.textContent = status.status === "paid" ? "支付成功，正在开通…" : "等待支付…";
  if (status.status !== "paid") {
    if (manual && error) error.textContent = "还没有查询到支付成功，请稍后再试";
    return;
  }
  clearAccessPaymentFlow();
  try {
    await finalizeAccessPayment(orderNo);
  } catch (paymentError) {
    if (error) error.textContent = paymentError.message || "支付后开通失败";
  }
}

async function startAccessPayment(method = accessPaymentMethod) {
  setAccessPaymentMethod(method);
  clearAccessPaymentFlow();
  const requestId = accessPaymentRequestId;
  const selectedMethod = accessPaymentMethod;
  const error = el("access-error");
  if (error) error.textContent = "";
  const button = el("access-purchase");
  if (button) {
    button.disabled = true;
    button.textContent = "正在生成…";
  }
  const area = el("access-payment-area");
  if (area) {
    const label = selectedMethod === "wechat" ? "微信" : "支付宝";
    area.innerHTML = `<div class="access-payment-fallback">正在生成${label}支付二维码…</div>`;
    area.classList.add("show");
  }
  try {
    const identity = await resolveAccessPaymentIdentity();
    if (requestId !== accessPaymentRequestId) return;
    if (!identity.appleId && !identity.accountId) throw new Error("请先登录 Apple ID");
    const payload = {
      pay_method: selectedMethod,
      code_type: "normal",
      developer_account_id: identity.accountId || identity.appleId || "",
      developer_apple_id: identity.appleId || identity.accountId || "",
      purchase_source: browserBoundLaunch ? "certificate_manager_browser" : "certificate_manager_standalone",
    };
    const result = await window.appleDeveloper.createAccessPayment(payload);
    if (requestId !== accessPaymentRequestId) return;
    if (!result?.success) throw new Error(result?.error || "付款码生成失败");
    accessPaymentOrderNo = String(result.order_no || "");
    if (!accessPaymentOrderNo) throw new Error("付款码生成失败");
    const copy = el("access-copy");
    if (copy) copy.textContent = `${selectedMethod === "wechat" ? "微信" : "支付宝"}付款完成后，系统会自动领取核验码并开通 Apple 证书管理。`;
    renderAccessPaymentSummary(result);
    if (button) {
      button.disabled = false;
      button.textContent = "重新生成支付二维码";
    }
    const orderNo = accessPaymentOrderNo;
    accessPaymentTimer = setInterval(() => {
      if (requestId !== accessPaymentRequestId || !el("access-mask")?.classList.contains("show")) {
        clearAccessPaymentFlow();
        return;
      }
      void checkAccessPaymentStatus({ requestId, orderNo });
    }, 2000);
  } catch (paymentError) {
    if (requestId !== accessPaymentRequestId) return;
    if (accessPaymentTimer) clearInterval(accessPaymentTimer);
    accessPaymentTimer = null;
    accessPaymentOrderNo = "";
    if (area) {
      area.innerHTML = '<div class="access-payment-fallback">支付二维码生成失败，请点击下方按钮重试。</div>';
      area.classList.add("show");
    }
    if (error) error.textContent = paymentError.message || "付款码生成失败";
    if (button) {
      button.disabled = false;
      button.textContent = "重新生成支付二维码";
    }
  }
}

function accessRenewalCopy() {
  const remainingDays = Math.max(0, Math.ceil(Number(currentAccess?.remainingDays) || 0));
  if (currentAccess?.authorizationExpired) {
    return "核验码授权已到期，请输入新的核验码继续使用 Apple 证书管理，或扫码支付自动开通。";
  }
  if (remainingDays > 0) {
    return `当前账户还剩 ${remainingDays} 天，请输入核验码继续使用 Apple 证书管理，或扫码支付自动开通。`;
  }
  return "免费试用已结束，请输入核验码继续使用 Apple 证书管理，或扫码支付自动开通。";
}

function showAccessRenewalDialog(requestedPage = "home") {
  pendingAccessPage = requestedPage;
  el("access-copy").textContent = accessRenewalCopy();
  el("access-error").textContent = "";
  el("access-code").value = "";
  clearAccessPaymentFlow();
  setAccessPaymentMethod("alipay");
  el("access-mask").classList.add("show");
  void startAccessPayment("alipay");
  setTimeout(() => el("access-code").focus(), 50);
}

async function refreshAccess(showDialog = false, requestedPage = "") {
  const result = await window.appleDeveloper.access();
  if (!result?.success) {
    if (showDialog) alert(result?.error || "授权状态读取失败");
    return false;
  }
  applyAccess(result.access);
  if (result.access?.allowed) return true;
  if (showDialog) {
    showAccessRenewalDialog(requestedPage);
  }
  return false;
}

function yieldToPaint() {
  if (typeof requestAnimationFrame !== "function") {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function showPageLoading(token, message = "正在加载…") {
  const overlay = el("page-loading-overlay");
  if (!overlay) return;
  overlay.dataset.token = String(token);
  const textNode = el("page-loading-text");
  if (textNode) textNode.textContent = message;
  overlay.hidden = false;
  overlay.classList.add("show");
  overlay.setAttribute("aria-busy", "true");
}

function hidePageLoading(token) {
  const overlay = el("page-loading-overlay");
  if (!overlay) return;
  if (token != null && overlay.dataset.token && overlay.dataset.token !== String(token)) return;
  overlay.classList.remove("show");
  overlay.hidden = true;
  overlay.removeAttribute("data-token");
  overlay.setAttribute("aria-busy", "false");
}

function activatePage(name) {
  if (name !== "profiles") cancelProfileBundleLookups();
  document.querySelectorAll(".page").forEach(page => page.classList.remove("active"));
  document.querySelectorAll(".nav").forEach(nav => nav.classList.toggle("active", nav.dataset.page === name));
  document.getElementById(`page-${name}`)?.classList.add("active");
  const crumb = document.getElementById("crumb");
  if (crumb) crumb.textContent = name === "home" ? "功能总览" : (modules[name]?.title || "");
}

async function showPage(name, skipAccessCheck = false) {
  const token = ++pageSwitchToken;
  const firstVisit = !initializedPages.has(name);
  activatePage(name);
  const loadingTitle = firstVisit ? PAGE_LOADING_TITLES[name] : "";
  if (loadingTitle) showPageLoading(token, loadingTitle);
  else hidePageLoading();
  if (firstVisit) {
    await yieldToPaint();
    if (token !== pageSwitchToken) return;
  }
  try {
    if (!skipAccessCheck && firstVisit && name !== "home" && name !== "help") {
      if (!await refreshAccess(true, name)) return;
      if (token !== pageSwitchToken) return;
    }
    initializedPages.add(name);
    if (name === "home" && firstVisit) {
      renderHomePage();
      await loadHomeOverview();
    }
    if (name === "one-click" && firstVisit) renderOneClickPage();
    if (firstVisit && modules[name]) buildModulePage(name);
    if (firstVisit && name === "bundle" && authenticated) await loadBundleIds();
    if (firstVisit && name === "profiles" && authenticated) await loadProfiles();
    if (firstVisit && name === "certificates" && authenticated) await loadCertificates();
    if (firstVisit && name === "devices" && authenticated) await loadDevices();
  } finally {
    hidePageLoading(token);
  }
}

function initializeInterfaceAfterLogin() {
  ++appStoreDetailRequestSeq;
  appStoreDetailCache.clear();
  appStoreDetailPending.clear();
  closeAppStoreDetailLoading();
  cancelProfileBundleLookups();
  clearInterval(reviewGuidancePollTimer);
  reviewGuidancePollTimer = null;
  clearInterval(ipaUploadPollTimer);
  ipaUploadPollTimer = null;
  document.querySelectorAll(".review-chat-mask,.review-login-reminder-mask,.review-bind-mask,.app-pricing-modal,.app-info-modal-mask,.app-privacy-modal-mask,.automation-completion-download-mask").forEach(node => node.remove());
  document.querySelectorAll(".mask.show").forEach(mask => mask.classList.remove("show"));
  el("account-popover")?.classList.remove("show");
  appStoreBundleIds = [];
  appStoreApps = [];
  currentAppStoreApp = null;
  currentAppStoreDetail = null;
  currentInAppPurchases = null;
  currentInAppPurchaseDetail = null;
  certificateTypes = [];
  certificateAppIds = [];
  editingBundleDetail = null;
  pushConfigureApp = null;
  profileOptions = null;
  profileCreateStep = 0;
  profileSelectedDeviceIds = new Set();
  automationOptions = null;
  automationArtifacts = null;
  automationCompletionDownloadOpen = false;
  currentAgreement = null;
  currentPaidAppAgreement = null;
  initializedPages.clear();
  homeBusinessStatus = null;
  appStoreBusinessStatusPromise = null;
  homeDeveloperAgreementPromise = null;
  homeAccountInfoPromise = null;
  homeTermsStatus = null;
  homeDeveloperAgreementStatus = null;
  homeAccountInfo = null;
  resetHomeOverviewCache();
  homeStatusLoading = false;
  currentLegalEntityDraft = null;
  currentLegalEntityMfa = null;
  currentComplianceDraft = null;
  reviewGuidancePendingAfterLogin = false;
  ["home", "one-click", "apps", "bundle", "profiles", "certificates", "devices", "ipa-upload", "help"].forEach(key => {
    const page = document.getElementById(`page-${key}`);
    if (page) page.innerHTML = "";
  });
  Object.keys(modules).forEach(buildModulePage);
  showPage("home", true);
}

function applyStatus(status) {
  const wasAuthenticated = authenticated;
  authenticated = !!status?.authenticated;
  if (authenticated && !wasAuthenticated) initializeInterfaceAfterLogin();
  applyTopAccountStatus();
  if (authenticated) setTimeout(() => refreshTopDeveloperAccount(), 100);
  if (el("account-logout-label")) el("account-logout-label").textContent = authenticated ? "退出登录" : "登录 Apple ID";
  el("login-required").classList.toggle("show", !authenticated);
  Object.keys(modules).forEach(buildModulePage);
  if (authenticated) {
    // Login can be launched from the review reminder. Always close the login
    // mask before mounting the full-page chat, otherwise the invisible mask
    // remains above the sidebar and consumes every click.
    el("login-mask")?.classList.remove("show");
    refreshAutomationIfActive();
    loadAgreementStatus();
    setTimeout(() => refreshAccess(false), 500);
    const cachedBusiness = readCachedAppStoreBusinessStatus();
    if (cachedBusiness) homeBusinessStatus = cachedBusiness;
    warmAppStoreBusinessStatus().catch(() => {});
    if (el("page-home")?.classList.contains("active")) loadHomeOverview({ force: true });
    document.querySelector(".review-login-reminder-mask")?.remove();
    // A successful login always starts from a clean home page. The user must
    // confirm the developer team before opening review guidance or modules.
    reviewGuidancePendingAfterLogin = false;
  } else {
    cancelProfileBundleLookups();
    clearInterval(reviewGuidancePollTimer);
    reviewGuidancePollTimer = null;
    document.querySelector(".review-chat-mask")?.remove();
    document.querySelector(".review-login-reminder-mask")?.remove();
    el("account-popover")?.classList.remove("show");
    const accountContent = el("account-info-content");
    if (accountContent) {
      accountContent.className = "account-info-loading";
      accountContent.textContent = "未登录 Apple ID";
    }
    ++appStoreDetailRequestSeq;
    appStoreDetailCache.clear();
    appStoreDetailPending.clear();
    closeAppStoreDetailLoading();
    appStoreApps = [];
    appStoreBundleIds = [];
    currentAppStoreApp = null;
    currentAppStoreDetail = null;
    currentInAppPurchases = null;
    currentInAppPurchaseDetail = null;
    currentAgreement = null;
    initializedPages.clear();
    homeBusinessStatus = null;
    homeTermsStatus = null;
    homeDeveloperAgreementStatus = null;
    homeAccountInfo = null;
    resetHomeOverviewCache();
    homeStatusLoading = false;
    currentLegalEntityDraft = null;
    currentLegalEntityMfa = null;
    currentComplianceDraft = null;
    renderHomePage();
    el("agreement-notice").classList.remove("show");
    if (status?.appStoreConnectAuthenticationRequired) {
      setTimeout(() => recoverAppStoreConnectAuthentication(), 0);
    }
  }
}

function showLogoutDialog() {
  el("account-popover")?.classList.remove("show");
  el("account-logo")?.setAttribute("aria-expanded", "false");
  el("logout-error").textContent = "";
  el("logout-mask").classList.add("show");
}

function closeLogoutDialog() { el("logout-mask").classList.remove("show"); }

async function confirmLogout(keepLoginInfo) {
  const button = el(keepLoginInfo ? "logout-keep" : "logout-forget");
  setBusy(button, true, "正在退出…");
  el("logout-error").textContent = "";
  try {
    const status = await window.appleDeveloper.logout({ keepLoginInfo });
    if (status?.error) throw new Error(status.error);
    if (status?.closeApplication) {
      closeLogoutDialog();
      return;
    }
    if (!keepLoginInfo) {
      launchAppleId = "";
      if (el("apple-id")) { el("apple-id").value = ""; el("apple-id").readOnly = false; }
      if (el("apple-password")) el("apple-password").value = "";
      await refreshSavedAccountHistory();
    }
    closeLogoutDialog();
    applyStatus(status || { authenticated: false });
  } catch (error) { el("logout-error").textContent = error.message || "退出登录失败"; }
  finally { setBusy(button, false); }
}

function formatAccountDate(timestamp) {
  if (!Number(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(Number(timestamp)));
}

function accountStatusText(status) {
  return String(status || "").toLowerCase() === "active" ? "正常" : status || "—";
}

function loginAccessExpired(access) {
  return !!access && (access.allowed === false || access.authorizationExpired === true);
}

function currentPageName() {
  return document.querySelector(".page.active")?.id?.replace(/^page-/, "") || "";
}

function shouldBlockExpiredAccessEvent(event) {
  if (!loginAccessExpired(currentAccess)) return false;
  const pageName = currentPageName();
  if (!pageName || pageName === "home" || pageName === "help") return false;
  const target = event.target?.closest?.("button,a,input,select,textarea,label");
  if (!target) return false;
  if (target.closest("#access-mask,#account-popover,#login-dialog,#logout-dialog,#floating-contact,.top-community-notice,.side")) return false;
  return true;
}

function blockExpiredAccessEvent(event) {
  if (!shouldBlockExpiredAccessEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  showAccessRenewalDialog(currentPageName() || "home");
}

document.addEventListener("click", blockExpiredAccessEvent, true);
document.addEventListener("submit", blockExpiredAccessEvent, true);

function loginAccessLabel(access) {
  if (!access) return "";
  if (loginAccessExpired(access)) return "账户已过期";
  const remainingDays = Number(access.remainingDays);
  if (Number.isFinite(remainingDays)) return `剩余 ${Math.max(0, Math.ceil(remainingDays))} 天`;
  return "";
}

async function loadAccountInfo() {
  const content = el("account-info-content");
  const generation = homeOverviewGeneration;
  content.className = "account-info-loading";
  content.textContent = "正在读取 Apple 账户信息…";
  const result = await loadHomeAccountInfo();
  if (generation !== homeOverviewGeneration) return;
  if (!result?.success) {
    content.textContent = result?.authenticated === false ? "请先登录 Apple ID" : (result?.error || "账户信息读取失败");
    return;
  }
  const account = result.account || {};
  const teams = result.teams || [];
  const team = teams.find(item => item.id === result.selectedTeamId) || teams[0];
  const teamHTML = team ? `<section class="account-team"><div class="account-team-name">${escapeHTML(team.name || "Apple Developer")}</div><dl class="account-info-grid"><dt>团队 ID</dt><dd>${escapeHTML(team.id)}</dd><dt>计划</dt><dd>${escapeHTML(team.program || "—")}</dd><dt>注册身份</dt><dd>${escapeHTML(team.identityType || "—")}</dd><dt>账户角色</dt><dd>${escapeHTML((team.roles || []).join("、") || "—")}</dd><dt>电话</dt><dd>${escapeHTML(team.phone || "—")}</dd><dt>街道地址</dt><dd>${escapeHTML(team.address || "—")}</dd><dt>续订日期</dt><dd>${escapeHTML(formatAccountDate(team.expirationDate))}</dd><dt>年费</dt><dd>${escapeHTML(team.fee || "—")}</dd><dt>设备重置日期</dt><dd>${escapeHTML(formatAccountDate(team.deviceResetDate))}</dd><dt>状态</dt><dd>${escapeHTML(accountStatusText(team.status))}</dd></dl></section>` : "";
  content.className = "";
  const invoiceButton = localStorage.getItem("reviewInvoiceOrderNo") ? '<button class="switch-team-button" id="invoice-now-button" type="button">立即开票</button>' : "";
  content.innerHTML = `<div class="account-popover-head"><div class="account-name-row"><strong>${escapeHTML(account.name || "Apple 开发者")}</strong>${invoiceButton}${teams.length > 1 ? '<button class="switch-team-button" id="switch-team-button" type="button">切换组织</button>' : ""}</div><span>${escapeHTML(account.appleId || "")}</span></div><div class="account-popover-body"><div class="account-info-title">会员资格详细信息</div>${teamHTML || '<div class="account-info-loading">暂无开发者团队</div>'}</div>`;
  el("invoice-now-button")?.addEventListener("click", async event => { event.stopPropagation(); await window.appleDeveloper.openInvoiceCenter(); });
  el("switch-team-button")?.addEventListener("click", async event => { event.stopPropagation(); el("account-popover").classList.remove("show"); await ensureTeamSelection(true); });
}

function markAppleDeveloperResourcePagesStale() {
  initializedPages.delete("profiles");
  initializedPages.delete("certificates");
}

async function refreshModule(key) {
  if (key === "home") {
    await loadHomeOverview({ force: true });
    return;
  }
  if (!authenticated) return showLogin();
  if (key === "apps") {
    if (!el("apps-capture-ready")) renderAppsPage();
    else {
      await refreshCurrentAppStoreView();
    }
    return;
  }
  if (key === "bundle") await loadBundleIds();
  else if (key === "profiles") await loadProfiles();
  else if (key === "certificates") await loadCertificates();
  else if (key === "devices") await loadDevices();
  else buildModulePage(key);
}

function applyNetworkMode() {
  const mode = networkMode();
  const direct = mode === "direct";
  el("custom-proxy").style.opacity = direct ? ".5" : "1";
  el("custom-proxy").style.pointerEvents = direct ? "none" : "auto";
  el("proxy-result").className = "ipbox";
  el("proxy-result").textContent = direct ? "当前选择直连，Apple 登录请求不会使用代理" : "登录前必须检测代理出口 IP";
  if (!browserBoundLaunch) {
    el("network-summary-title").textContent = direct ? "网络：直连" : "网络：自定义代理";
    el("network-summary-detail").textContent = direct ? "未设置代理时使用本机网络" : "请检测代理后再登录";
  }
  verifiedProxyKey = direct ? proxyKey(currentProxy()) : "";
  verifiedProxyIP = "";
}

async function detectCurrentProxy(button) {
  const proxy = currentProxy();
  el("login-error").textContent = "";
  if (!proxy.host || !proxy.port) { el("proxy-result").className = "ipbox bad"; el("proxy-result").textContent = "请先选择或填写代理 IP"; return; }
  setBusy(button, true, "检测中…");
  try {
    const result = await window.appleDeveloper.detectProxy(proxy);
    if (!result?.ok) throw new Error(result?.error || "代理检测失败");
    verifiedProxyKey = proxyKey(proxy);
    verifiedProxyIP = String(result.ip || "");
    el("proxy-result").className = "ipbox ok";
    el("proxy-result").textContent = `检测成功 · 出口 IP：${result.ip}  ${[result.country, result.region, result.city].filter(value => value && value !== "—").join(" ")}`;
  } catch (error) {
    verifiedProxyKey = "";
    verifiedProxyIP = "";
    el("proxy-result").className = "ipbox bad";
    el("proxy-result").textContent = error.message;
  } finally { setBusy(button, false); }
}

document.querySelectorAll(".nav").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.action === "review-guidance") { openReviewGuidance(); return; }
  clearInterval(reviewGuidancePollTimer);
  reviewGuidancePollTimer = null;
  document.querySelector(".review-chat-mask")?.remove();
  showPage(button.dataset.page);
}));
document.querySelectorAll("[data-copy-value]").forEach(button => button.addEventListener("click", async () => {
  const value = String(button.dataset.copyValue || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch (_error) {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  const original = button.textContent;
  button.textContent = "复制成功";
  button.classList.add("copied");
  const qqKind = String(button.dataset.qqKind || "").trim();
  if (qqKind && typeof window.appleDeveloper.openQQContact === "function") {
    window.appleDeveloper.openQQContact({ kind: qqKind, uin: value }).then(result => {
      if (!result?.success) button.title = result?.error || "号码已复制，请手动打开 QQ 搜索";
    }).catch(error => { button.title = error.message || "号码已复制，请手动打开 QQ 搜索"; });
  }
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1600);
}));
const floatingContact = el("floating-contact");
const floatingContactTrigger = el("floating-contact-trigger");
const floatingContactPanel = el("floating-contact-panel");
const setFloatingContactOpen = open => {
  floatingContactPanel.hidden = !open;
  floatingContactTrigger.setAttribute("aria-expanded", String(open));
};
floatingContactTrigger.addEventListener("click", event => {
  event.stopPropagation();
  setFloatingContactOpen(floatingContactPanel.hidden);
});
el("floating-contact-close").addEventListener("click", () => setFloatingContactOpen(false));
floatingContactPanel.addEventListener("click", event => event.stopPropagation());
document.addEventListener("click", event => {
  if (!floatingContactPanel.hidden && !floatingContact.contains(event.target)) setFloatingContactOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !floatingContactPanel.hidden) setFloatingContactOpen(false);
});
document.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click", () => showPage(button.dataset.open)));
const closeAccessDialog = () => { clearAccessPaymentFlow(); el("access-mask").classList.remove("show"); pendingAccessPage = ""; };
el("access-close").addEventListener("click", closeAccessDialog);
el("access-cancel").addEventListener("click", closeAccessDialog);
el("access-code").addEventListener("input", event => { event.target.value = event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16); });
document.querySelectorAll("[data-access-pay-method]").forEach(button => button.addEventListener("click", () => {
  const method = button.dataset.accessPayMethod;
  if (method !== accessPaymentMethod || !accessPaymentOrderNo) void startAccessPayment(method);
}));
el("access-purchase").addEventListener("click", () => { void startAccessPayment(accessPaymentMethod); });
el("access-payment-refresh").addEventListener("click", () => { void checkAccessPaymentStatus({ manual: true }); });
el("access-submit").addEventListener("click", async () => {
  const button = el("access-submit");
  const code = el("access-code").value.trim();
  if (!/^[A-Z0-9]{6,16}$/.test(code)) { el("access-error").textContent = "请输入有效核验码"; return; }
  setBusy(button, true, "核验中…");
  el("access-error").textContent = "";
  try {
    const result = await window.appleDeveloper.activateAccess(code);
    if (!result?.success) throw new Error(result?.error || "核验失败");
    applyAccess(result.access);
    const destination = pendingAccessPage;
    closeAccessDialog();
    if (destination) await showPage(destination, true);
  } catch (error) {
    el("access-error").textContent = error.message;
  } finally { setBusy(button, false); }
});
el("login-button").addEventListener("click", async () => authenticated ? showLogoutDialog() : showLogin());
el("account-info-button").addEventListener("click", async event => {
  event.stopPropagation();
  el("account-popover").classList.add("detail");
  await loadAccountInfo();
});
el("account-detail-back").addEventListener("click", event => {
  event.stopPropagation();
  el("account-popover").classList.remove("detail");
});
el("account-switch-button").addEventListener("click", async event => {
  event.stopPropagation();
  if (browserBoundLaunch) return;
  el("account-popover").classList.remove("show", "detail");
  el("account-logo").setAttribute("aria-expanded", "false");
  await showLogin();
});
el("logout-close")?.addEventListener("click", closeLogoutDialog);
el("logout-cancel")?.addEventListener("click", closeLogoutDialog);
el("logout-keep")?.addEventListener("click", () => confirmLogout(true));
el("logout-forget")?.addEventListener("click", () => confirmLogout(false));
const reviewGuidanceFloat = el("review-guidance-button");
if (reviewGuidanceFloat) {
  let drag = null;
  reviewGuidanceFloat.addEventListener("pointerdown", event => {
    const rect = reviewGuidanceFloat.getBoundingClientRect();
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
    reviewGuidanceFloat.setPointerCapture(event.pointerId);
    reviewGuidanceFloat.classList.add("dragging");
  });
  reviewGuidanceFloat.addEventListener("pointermove", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX; const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const left = Math.max(8, Math.min(window.innerWidth - reviewGuidanceFloat.offsetWidth - 8, drag.left + dx));
    const top = Math.max(66, Math.min(window.innerHeight - reviewGuidanceFloat.offsetHeight - 8, drag.top + dy));
    reviewGuidanceFloat.style.left = `${left}px`; reviewGuidanceFloat.style.top = `${top}px`;
    reviewGuidanceFloat.style.right = "auto"; reviewGuidanceFloat.style.bottom = "auto";
  });
  reviewGuidanceFloat.addEventListener("pointerup", event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = drag.moved; drag = null; reviewGuidanceFloat.classList.remove("dragging");
    if (!moved) openReviewGuidance();
  });
  reviewGuidanceFloat.addEventListener("pointercancel", () => { drag = null; reviewGuidanceFloat.classList.remove("dragging"); });
}
el("account-logo").addEventListener("click", async event => {
  event.stopPropagation();
  if (!authenticated) { await showLogin(); return; }
  const popover = el("account-popover");
  const opening = !popover.classList.contains("show");
  popover.classList.toggle("show", opening);
  popover.classList.remove("detail");
  el("account-logo").setAttribute("aria-expanded", String(opening));
});
document.addEventListener("click", event => {
  if (!event.target.closest(".account-menu-wrap")) {
    el("account-popover").classList.remove("show", "detail");
    el("account-logo").setAttribute("aria-expanded", "false");
  }
});
el("login-close").addEventListener("click", closeLogin);
el("agreement-refresh").addEventListener("click", loadAgreementStatus);
el("agreement-view").addEventListener("click", openAgreementDialog);
el("agreement-close").addEventListener("click", closeAgreementDialog);
el("agreement-cancel").addEventListener("click", closeAgreementDialog);
el("agreement-confirm").addEventListener("change", event => { el("agreement-accept").disabled = !event.target.checked; });
el("agreement-accept").addEventListener("click", acceptCurrentAgreement);
el("paid-agreement-cancel")?.addEventListener("click", closePaidAppAgreementDialog);
el("paid-agreement-confirm")?.addEventListener("change", updatePaidAgreementAcceptState);
el("paid-agreement-accept")?.addEventListener("click", acceptPaidAppAgreement);
el("paid-agreement-download")?.addEventListener("click", () => downloadPaidAppAgreementDocument("agreement"));
el("paid-agreement-attachments-toggle")?.addEventListener("click", () => {
  const expanded = el("paid-agreement-attachments-toggle")?.getAttribute("aria-expanded") !== "false";
  setPaidAgreementAttachmentExpanded(!expanded);
});
el("paid-agreement-mask")?.addEventListener("click", event => {
  if (event.target === el("paid-agreement-mask")) closePaidAppAgreementDialog();
});
el("team-close").addEventListener("click", () => el("team-mask").classList.remove("show"));
el("bundle-create-close").addEventListener("click", closeCreateBundleId);
el("bundle-create-cancel").addEventListener("click", closeCreateBundleId);
el("bundle-create-submit").addEventListener("click", submitCreateBundleId);
el("bundle-edit-close").addEventListener("click", closeEditBundleId);
el("bundle-edit-cancel").addEventListener("click", closeEditBundleId);
el("bundle-edit-submit").addEventListener("click", submitEditBundleId);
el("push-config-close").addEventListener("click", closePushConfigureDialog);
el("push-config-done").addEventListener("click", closePushConfigureDialog);
el("certificate-create-close").addEventListener("click", closeCreateCertificate);
el("certificate-create-cancel").addEventListener("click", closeCreateCertificate);
el("certificate-create-submit").addEventListener("click", submitCreateCertificate);
el("profile-create-close").addEventListener("click", () => el("profile-create-mask").classList.remove("show"));
el("profile-create-back").addEventListener("click", () => { if (profileCreateStep > 0) { profileCreateStep -= 1; renderProfileCreateStep(); } });
el("profile-create-next").addEventListener("click", advanceProfileCreate);
el("profile-bundle-search").addEventListener("input", renderProfileBundleOptions);
el("profile-certificate-search").addEventListener("input", renderProfileCertificateOptions);
el("profile-device-search").addEventListener("input", renderProfileDevices);
el("profile-device-select-all").addEventListener("change", event => {
  document.querySelectorAll('input[name="profile-device"]').forEach(input => { input.checked = event.target.checked; input.checked ? profileSelectedDeviceIds.add(input.value) : profileSelectedDeviceIds.delete(input.value); });
  updateProfileDeviceSelection();
});
el("confirm-team").addEventListener("click", async () => {
  const selected = document.querySelector('input[name="developer-team"]:checked');
  if (!selected) { el("team-error").textContent = "请选择一个开发者团队"; return; }
  const button = el("confirm-team"); setBusy(button, true, "保存中…");
  try {
    const result = await window.appleDeveloper.selectTeam({ id: selected.value });
    if (!result?.success) throw new Error(result?.error || "团队保存失败");
    el("team-mask").classList.remove("show");
    homeBusinessStatus = null;
    homeAccountInfo = null;
    resetHomeOverviewCache();
    await loadAgreementStatus();
    if (el("page-home")?.classList.contains("active")) await loadHomeOverview({ force: true });
    if (el("page-bundle").classList.contains("active")) await loadBundleIds();
    await refreshAutomationIfActive();
  } catch (error) { el("team-error").textContent = error.message; }
  finally { setBusy(button, false); }
});
el("twofa-back").addEventListener("click", showAccountStep);

el("detect-proxy-custom").addEventListener("click", event => detectCurrentProxy(event.currentTarget));
el("add-login-account").addEventListener("click", () => showLoginForm());
el("login-account-back").addEventListener("click", showAccountStep);
el("toggle-proxy-settings").addEventListener("click", () => el("proxy-settings").classList.toggle("show"));
el("custom-proxy-enabled").addEventListener("change", applyNetworkMode);

async function handleAppleLoginResult(result) {
  if (!result?.success) throw new Error(result?.error || "登录失败");
  if (!result.requires2FA) { appleLoginAwaiting2FA = false; closeLogin({ completed: true }); applyStatus({ authenticated: true }); await refreshSavedAccountHistory(); await refreshTopDeveloperAccount(); await ensureTeamSelection(true); return; }
  twoFARetryBlocked = false;
  document.querySelector(`input[name="twofa-method"][value="${result.initial2FAMethod === "sms" ? "sms" : "device"}"]`).checked = true;
  setTrustedTwoFAPhones(result.trustedPhones || (result.trustedPhone ? [result.trustedPhone] : []), result.initialPhoneId);
  renderTwoFAMethod({ initialCodeAutomaticallySent: result.initialCodeAutomaticallySent === true });
  showVerifyStep();
  (twoFAMethodReady ? el("twofa-code") : el("request-twofa")).focus();
}

async function recoverAppStoreConnectAuthentication() {
  if (appStoreConnectLoginRecoveryInFlight || appleLoginInProgress) return;
  appStoreConnectLoginRecoveryInFlight = true;
  el("login-mask").classList.add("show");
  showLoginForm({ appleId: launchAppleId, locked: !!launchAppleId });
  setLoginProgress(true, "正在恢复 App Store Connect 登录", "正在原环境中使用本机保存的账户信息重新认证。");
  try {
    const result = await window.appleDeveloper.autoLogin({
      clientFingerprint: generateAppleClientFingerprint(),
      forceRefresh: true,
    });
    if (result?.passwordRequired) {
      showLoginForm({ appleId: launchAppleId, locked: !!launchAppleId });
      el("login-error").textContent = result.error || "Apple 会话已过期，请重新输入 Apple ID 密码";
      el("apple-password").focus();
      return;
    }
    await handleAppleLoginResult(result);
  } catch (error) {
    showLoginError(error);
  } finally {
    appStoreConnectLoginRecoveryInFlight = false;
    setLoginProgress(false);
  }
}

async function refreshSavedAccountHistory(preferredAppleId = "") {
  const history = await window.appleDeveloper.loginHistory().catch(() => null);
  const list = el("account-picker-list");
  const accounts = history?.accounts || [];
  if (!accounts.length) { list.innerHTML = '<div class="account-picker-empty">暂无本机账户，请点击“添加账户”。</div>'; return; }
  list.innerHTML = accounts.map(account => {
    const route = account.proxyEnabled ? `代理 · ${escapeHTML(account.lastIp || "未记录 IP")}` : "直连";
    const date = account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString("zh-CN", { hour12: false }) : "未记录";
    const isCurrentAccount = authenticated && String(account.appleId || "").trim().toLowerCase() === String(launchAppleId || "").trim().toLowerCase();
    const expired = loginAccessExpired(account.access);
    const accessLabel = loginAccessLabel(account.access);
    const loginButton = isCurrentAccount || expired ? "" : `<button class="login account-picker-login" type="button" data-apple-id="${escapeHTML(account.appleId)}">登录</button>`;
    const renewButton = expired ? `<button class="account-picker-renew" type="button" data-apple-id="${escapeHTML(account.appleId)}" data-account-id="${escapeHTML(account.accountId || "")}">续费</button>` : "";
    return `<div class="account-picker-row ${expired ? "expired" : ""}"><div><div class="account-picker-email">${escapeHTML(account.appleId)}</div><div class="account-picker-meta"><span class="account-route">${route}</span><span>${expired ? '<b class="account-expired-badge">已过期</b>' : "可自动登录"}</span>${accessLabel && !expired ? `<span>${escapeHTML(accessLabel)}</span>` : ""}<span>最近使用 · ${escapeHTML(date)}</span></div></div><div class="account-picker-actions">${renewButton}${loginButton}</div></div>`;
  }).join("");
  list.querySelectorAll(".account-picker-renew").forEach(button => button.addEventListener("click", async () => {
    launchAppleId = button.dataset.appleId || launchAppleId;
    launchAccountId = button.dataset.accountId || launchAccountId;
    currentAccess = { allowed: false };
    closeLogin();
    showAccessRenewalDialog("home");
  }));
  list.querySelectorAll(".account-picker-login").forEach(button => button.addEventListener("click", async () => {
    if (appleLoginInProgress) return;
    el("login-error").textContent = "";
    setBusy(button, true, "登录中…");
    setLoginProgress(true, "正在自动登录 Apple 账户", "正在恢复该账户保存的会话、设备信息和网络配置。");
    try {
      const selected = await window.appleDeveloper.selectLoginHistory(button.dataset.appleId);
      if (!selected?.success) throw new Error(selected?.error || "账户读取失败");
      homeBusinessStatus = null;
      homeAccountInfo = null;
      homeTermsStatus = null;
      homeDeveloperAgreementStatus = null;
      cancelProfileBundleLookups();
      resetHomeOverviewCache();
      const result = await window.appleDeveloper.autoLogin({ clientFingerprint: generateAppleClientFingerprint() });
      if (result?.passwordRequired) {
        showLoginForm({ appleId: selected.appleId, locked: true, proxy: selected.proxy });
        el("login-error").textContent = result.error || "Apple 会话已过期，请重新输入 Apple ID 密码";
        el("apple-password").focus();
        return;
      }
      await handleAppleLoginResult(result);
    } catch (error) {
      showLoginError(error);
    } finally {
      setBusy(button, false);
      setLoginProgress(false);
    }
  }));
}

el("submit-login").addEventListener("click", async () => {
  const button = el("submit-login");
  if (appleLoginInProgress) return;
  const proxy = currentProxy();
  el("login-error").textContent = "";
  if (!el("apple-id").value.trim() || !el("apple-password").value) { el("login-error").textContent = "请输入 Apple ID 和密码"; return; }
  if (proxy.enabled && verifiedProxyKey !== proxyKey(proxy)) { el("login-error").textContent = "请先检测当前代理出口 IP"; return; }
  setBusy(button, true, "正在安全登录…");
  setLoginProgress(true, "正在登录 Apple 账户", "Apple 会话建立可能需要几十秒，请不要重复点击或关闭窗口。");
  try {
    const result = await window.appleDeveloper.login({ appleId: el("apple-id").value.trim(), password: el("apple-password").value, clientFingerprint: generateAppleClientFingerprint(), proxy, expectedProxyIp: verifiedProxyIP });
    el("apple-password").value = "";
    await handleAppleLoginResult(result);
  } catch (error) { showLoginError(error); }
  finally { setBusy(button, false); setLoginProgress(false); }
});

document.querySelectorAll('input[name="twofa-method"]').forEach(input => input.addEventListener("change", renderTwoFAMethod));
el("twofa-phone").addEventListener("change", resetTwoFADelivery);

el("twofa-code").addEventListener("input", () => {
  el("twofa-code").value = el("twofa-code").value.replace(/\D/g, "").slice(0, 6);
  el("twofa-error").textContent = "";
  updateTwoFASubmit();
});

el("request-twofa").addEventListener("click", async () => {
  if (appleLoginInProgress) return;
  const button = el("request-twofa");
  const method = twoFAMethod();
  const phoneId = method === "sms" ? el("twofa-phone").value : "";
  const hadReadyDelivery = twoFAMethodReady && !el("twofa-code").disabled;
  el("twofa-error").textContent = "";
  if (!hadReadyDelivery) resetTwoFADelivery();
  setBusy(button, true, "发送中…");
  setTwoFADeliveryControlsDisabled(true);
  setLoginProgress(true, "正在发送 Apple 验证码", "正在向 Apple 请求验证码，请稍候…");
  let sent = false;
  try {
    const result = await window.appleDeveloper.choose2FA({ method, phoneId });
    if (!result?.success) throw new Error(result?.error || "获取验证码失败");
    if (result.trustedPhones) setTrustedTwoFAPhones(result.trustedPhones, result.phoneId || phoneId);
    if (result.selectionRequired) {
      el("twofa-status").className = "ipbox";
      el("twofa-status").textContent = "请选择接收手机号，然后再次点击发送验证码";
      el("twofa-phone").focus();
      return;
    }
    twoFAMethodReady = true;
    sent = true;
    if (hadReadyDelivery) el("twofa-code").value = "";
    el("twofa-code").disabled = false;
    el("twofa-status").className = "ipbox ok";
    el("twofa-status").textContent = method === "sms" ? "短信验证码已发送" : "设备验证码已发送，请在受信任设备上查看";
    el("twofa-code").focus();
  } catch (error) {
    if (blockTwoFARetryIfLocked(String(error.message || ""))) {
      el("twofa-status").className = "ipbox bad";
      el("twofa-status").textContent = error.message;
    } else if (hadReadyDelivery) {
      twoFAMethodReady = true;
      el("twofa-code").disabled = false;
      el("twofa-status").className = "ipbox bad";
      el("twofa-status").textContent = `${error.message}；已发送的验证码仍可尝试验证`;
      el("twofa-code").focus();
    } else {
      twoFAMethodReady = false;
      el("twofa-code").disabled = true;
      el("twofa-status").className = "ipbox bad";
      el("twofa-status").textContent = error.message;
    }
  }
  finally {
    setBusy(button, false);
    setTwoFADeliveryControlsDisabled(false);
    setTwoFARequestButtonLabel((sent || hadReadyDelivery) ? "重新发送" : "发送验证码");
    updateTwoFASubmit();
    setLoginProgress(false);
  }
});

el("submit-twofa").addEventListener("click", async () => {
  if (appleLoginInProgress) return;
  const button = el("submit-twofa");
  const code = el("twofa-code").value.trim();
  if (!twoFAMethodReady || !/^\d{6}$/.test(code)) { el("twofa-error").textContent = "请输入有效的 6 位验证码"; return; }
  setBusy(button, true, "验证中…");
  setTwoFADeliveryControlsDisabled(true);
  setLoginProgress(true, "正在验证并登录", "正在验证验证码并建立开发者会话，请稍候…");
  try {
    const result = await window.appleDeveloper.submit2FA(code);
    if (!result?.success) throw new Error(result?.error || "验证失败");
    appleLoginAwaiting2FA = false;
    closeLogin({ completed: true });
    applyStatus({ authenticated: true });
    await refreshSavedAccountHistory();
    await refreshTopDeveloperAccount();
    await ensureTeamSelection(true);
  } catch (error) {
    const message = String(error.message || "验证失败");
    blockTwoFARetryIfLocked(message);
    el("twofa-error").textContent = /code=-?21669/.test(message)
      ? "验证码不正确，请输入本次登录最近收到的验证码；重新发送后旧验证码会失效"
      : message;
  }
  finally { setBusy(button, false); setTwoFADeliveryControlsDisabled(false); updateTwoFASubmit(); setLoginProgress(false); }
});

window.appleDeveloper.onStatus(applyStatus);
window.appleDeveloper.onAppStoreScreenshotProgress?.(updateAppStoreScreenshotProgress);
Object.keys(modules).forEach(buildModulePage);
renderHomePage();
// Select the account partition before status/proxy restoration. Running these
// calls concurrently can initialize the proxy in the temporary admin
// partition and leave the selected account pointing at a dead localhost port.
window.appleDeveloper.launchContext().then(async context => {
  browserBoundLaunch = context?.browserBound === true;
  launchNetwork = context?.network && typeof context.network === "object" ? context.network : { enabled: false, mode: "direct" };
  applyLoginLaunchRestrictions();
  browserDesktopAccount = context?.desktopAccount || null;
  el("account-menu-wrap")?.classList.toggle("browser-bound", browserBoundLaunch);
  el("browser-binding")?.classList.toggle("show", browserBoundLaunch);
  if (el("browser-owner-name")) el("browser-owner-name").textContent = browserDesktopAccount?.username || browserDesktopAccount?.id || "—";
  el("account-switch-button")?.toggleAttribute("hidden", browserBoundLaunch);
  if (el("account-switch-button")) el("account-switch-button").style.display = browserBoundLaunch ? "none" : "";
  if (browserBoundLaunch) {
    el("logout-forget")?.removeAttribute("hidden");
    if (el("logout-forget")) {
      el("logout-forget").style.display = "";
      el("logout-forget").textContent = "不保留信息并关闭";
    }
    if (el("logout-keep")) el("logout-keep").textContent = "保留信息并关闭";
    const title = el("logout-mask")?.querySelector(".logout-title");
    if (title) title.textContent = "退出当前 Apple 账户后，证书管理软件将自动关闭。";
  }
  if (context?.appleId) {
    launchAppleId = context.appleId;
    currentP12Password = context.p12Password || currentP12Password || "123456";
    saveP12Password(currentP12Password);
    const input = el("apple-id");
    input.value = context.appleId;
    input.readOnly = true;
    input.setAttribute("aria-readonly", "true");
    el("apple-id-lock-note").textContent = "已从开发者账户列表选定，不可修改";
    if (el("ipa-upload-apple-id")) el("ipa-upload-apple-id").value = launchAppleId;
  }
  if (context?.accountId) launchAccountId = String(context.accountId || "").trim();

  // A browser-bound launch can start restoring its proxy, cookies and hidden
  // Apple web session inside status(). Put the modal in its non-interactive
  // state before that first asynchronous call so there is no window in which
  // the user can click back, close, or submit a second login attempt.
  const shouldRestoreBoundAccount = !!(context?.appleId && browserBoundLaunch);
  if (shouldRestoreBoundAccount) {
    el("login-error").textContent = "正在使用本机保存的账户信息登录…";
    el("login-mask").classList.add("show");
    showLoginForm({ appleId: context.appleId, locked: true });
    setLoginProgress(true, "正在恢复 Apple 登录", "正在验证本机保存的账户会话，首次恢复可能稍慢。");
  }

  let passwordRequired = false;
  const attemptBoundAutoLogin = async (detail = "正在验证本机保存的账户会话，首次恢复可能稍慢。", options = {}) => {
    setLoginProgress(true, "正在恢复 Apple 登录", detail);
    const result = await window.appleDeveloper.autoLogin({ clientFingerprint: generateAppleClientFingerprint(), forceRefresh: options.forceRefresh === true });
    if (result?.passwordRequired) {
      passwordRequired = true;
      el("login-error").textContent = result.error || "保存的凭据不可用，需要重新输入 Apple ID 密码";
      return;
    }
    await handleAppleLoginResult(result);
  };
  try {
    const status = await window.appleDeveloper.status();
    applyTopAccountStatus();
    applyStatus(status);
    if (status?.authenticated) {
      const teamReady = await ensureTeamSelection(false);
      if (!teamReady && shouldRestoreBoundAccount && lastTeamSelectionError) {
        el("team-mask").classList.remove("show");
        el("login-error").textContent = "当前 Apple 会话无法读取团队，正在按登录流程重新建立会话…";
        await attemptBoundAutoLogin("当前缓存会话无法读取开发者团队，正在重新登录并兑换 Developer 会话。", { forceRefresh: true });
      }
    } else if (shouldRestoreBoundAccount) {
      await attemptBoundAutoLogin();
    }
  } catch (error) {
    if (shouldRestoreBoundAccount) showLoginError(error);
  } finally {
    if (shouldRestoreBoundAccount) setLoginProgress(false);
  }
  if (passwordRequired) el("apple-password").focus();
  if (!appleLoginAwaiting2FA) await refreshAccess(false);
});
loadProxies();
applyNetworkMode();
