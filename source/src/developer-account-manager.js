const el = id => document.getElementById(id);
const escapeHTML = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
let pendingActivationAccountId = "";
let pendingActivationAppleId = "";
let certificateManagerRunning = false;
let runningPollTimer = null;
let editingAccount = null;
const POLICY_NOTICE_KEY = "mayou-developer-policy-notice-v1";
const EXPIRY_NOTICE_KEY_PREFIX = "mayou-developer-renewal-notice-v1";
let pendingRenewalNotice = null;
let renewalPaymentTimer = null;
let renewalPaymentOrderNo = "";
let renewalPaymentMethod = "alipay";
let renewalPaymentRequestId = 0;
const formatDate = value => {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "未注册" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
};
const accessLabel = access => {
  const trialDays = Number(access?.trialDays || 15);
  if (!access?.trialStarted) return `后台未注册，注册后开始 ${trialDays} 天试用`;
  if (access.activated) return `核验码有效期至 ${formatDate(access.authorizationExpiresAt)} · 首次注册 ${formatDate(access.firstLoginAt)}`;
  if (access.authorizationExpired) return `核验码已到期 · 首次注册 ${formatDate(access.firstLoginAt)}`;
  if (!access.allowed) return `试用已到期 · 首次注册 ${formatDate(access.firstLoginAt)}`;
  return `首次注册 ${formatDate(access.firstLoginAt)} · 免费剩余 ${access.remainingDays} 天`;
};
const accessExpired = access => {
  if (!access) return false;
  return access.allowed === false || access.authorizationExpired === true;
};
const accessWarning = access => {
  const days = Number(access?.remainingDays);
  return accessExpired(access) || (Number.isFinite(days) && days > 0 && days <= 5);
};
let browserProxies = [];
const proxyKey = proxy => `${String(proxy?.type || "http").toLowerCase()}://${String(proxy?.host || "").trim()}:${String(proxy?.port || "").trim()}`;
const proxyLabel = proxy => {
  if (!proxy) return "";
  const type = String(proxy.type || "http").toUpperCase();
  const note = String(proxy.note || "").trim();
  return `${type} ${String(proxy.host || "").trim()}:${String(proxy.port || "").trim()}${note ? ` · ${note}` : ""}`;
};
const connectionLabel = row => {
  const mode = String(row?.connectionMode || (row?.proxy ? "custom_proxy" : "direct"));
  if (mode === "browser_proxy") {
    const proxy = row.proxy || {};
    if (proxy.host) return `浏览器代理 · ${proxyLabel(proxy)}`;
    return row.browserProxyKey ? `浏览器代理 · ${row.browserProxyKey}` : "浏览器代理";
  }
  if (mode === "custom_proxy") {
    const proxy = row.proxy || {};
    return proxy?.host ? `自定义代理 · ${proxyLabel(proxy)}` : "自定义代理";
  }
  return "直连";
};
async function loadBrowserProxies() {
  try {
    const result = await window.browserProxy?.loadProxies?.();
    browserProxies = Array.isArray(result?.proxies) ? result.proxies : [];
  } catch {
    browserProxies = [];
  }
}
function renderBrowserProxyOptions() {
  const select = el("browser-proxy");
  if (!select) return;
  if (!browserProxies.length) {
    select.innerHTML = '<option value="">暂无可用代理，请先到代理管理中添加</option>';
    select.value = "";
    return;
  }
  select.innerHTML = browserProxies.map(proxy => `<option value="${proxyKey(proxy)}">${escapeHTML(proxyLabel(proxy))}</option>`).join("");
  if (!browserProxies.some(proxy => proxyKey(proxy) === select.value)) select.value = proxyKey(browserProxies[0]);
}
async function refreshBrowserProxyOptions() {
  await loadBrowserProxies();
  renderBrowserProxyOptions();
}

function selectedBrowserProxy() {
  const key = el("browser-proxy")?.value || "";
  return browserProxies.find(proxy => proxyKey(proxy) === key) || null;
}

function reminderKey(row) {
  const access = row?.access || {};
  return [
    String(row?.id || ""),
    String(access.authorizationExpiresAt || access.trialExpiresAt || ""),
    String(access.remainingDays ?? ""),
  ].join("|");
}

function shouldRemind(row) {
  const access = row?.access || {};
  if (access.activated && Number(access.remainingDays) > 5) return false;
  const days = Number(access.remainingDays);
  const trackable = !!(access.trialStarted || access.activated || access.firstLoginAt || access.authorizationExpiresAt || access.trialExpiresAt);
  return trackable && Number.isFinite(days) && days > 0 && days <= 5;
}

function pickRenewalTarget(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(shouldRemind)
    .sort((left, right) => {
      const leftDays = Number(left?.access?.remainingDays);
      const rightDays = Number(right?.access?.remainingDays);
      if (leftDays !== rightDays) return leftDays - rightDays;
      const leftDate = new Date(left?.access?.authorizationExpiresAt || left?.access?.trialExpiresAt || 0).getTime();
      const rightDate = new Date(right?.access?.authorizationExpiresAt || right?.access?.trialExpiresAt || 0).getTime();
      return leftDate - rightDate;
    })[0] || null;
}

function showPolicyNotice() {
  if (sessionStorage.getItem(POLICY_NOTICE_KEY) === "1") return false;
  const overlay = el("policy-mask");
  if (!overlay || overlay.classList.contains("show")) return false;
  overlay.classList.add("show");
  return true;
}

function flushRenewalNotice() {
  if (!pendingRenewalNotice) return;
  const { row, key } = pendingRenewalNotice;
  if (sessionStorage.getItem(key) === "1") {
    pendingRenewalNotice = null;
    return;
  }
  const overlay = el("renewal-mask");
  if (!overlay) return;
  const access = row?.access || {};
  const remainingDays = Math.max(0, Math.ceil(Number(access.remainingDays) || 0));
  const expired = accessExpired(access);
  el("renewal-account").textContent = `${row?.appleId || "该账户"} · ${expired ? "已到期" : `剩余 ${remainingDays} 天`}`;
  el("renewal-copy").textContent = expired
    ? `你的账户 ${row?.appleId || "未知账户"} 已到期，到期后无法继续启动证书管理，请先续费。`
    : `你的账户 ${row?.appleId || "未知账户"} 将在 ${remainingDays} 天内到期，到期以后无法进行任何服务，请及时续费。`;
  el("renewal-days").textContent = "到期后服务器会按账户有效期策略自动清理证书数据。";
  el("renewal-error").textContent = "";
  overlay.classList.add("show");
  sessionStorage.setItem(key, "1");
}

function openRenewalDialog(row) {
  pendingRenewalNotice = { row, key: `${EXPIRY_NOTICE_KEY_PREFIX}:${reminderKey(row)}` };
  clearRenewalPaymentFlow();
  setRenewalPaymentMethod("alipay");
  flushRenewalNotice();
  setTimeout(() => {
    if (el("renewal-mask")?.classList.contains("show")) openDeveloperRenewalPurchase();
  }, 80);
}

function closeDeveloperPolicyDialog() {
  el("policy-mask")?.classList.remove("show");
  sessionStorage.setItem(POLICY_NOTICE_KEY, "1");
  flushRenewalNotice();
}

function closeDeveloperRenewalDialog() {
  el("renewal-mask")?.classList.remove("show");
  el("renewal-error").textContent = "";
  pendingRenewalNotice = null;
  clearRenewalPaymentFlow();
}

function clearRenewalNoticeForAccount(accountId) {
  const id = String(accountId || "");
  pendingRenewalNotice = null;
  el("renewal-mask")?.classList.remove("show");
  Object.keys(sessionStorage).forEach(key => {
    if (key.startsWith(`${EXPIRY_NOTICE_KEY_PREFIX}:`) && (!id || key.includes(`:${id}|`))) {
      sessionStorage.removeItem(key);
    }
  });
}

function queueAccountNotices(rows) {
  const target = pickRenewalTarget(rows);
  pendingRenewalNotice = target ? { row: target, key: `${EXPIRY_NOTICE_KEY_PREFIX}:${reminderKey(target)}` } : null;
  if (pendingRenewalNotice && sessionStorage.getItem(pendingRenewalNotice.key) === "1") {
    pendingRenewalNotice = null;
  }
  const policyOverlay = el("policy-mask");
  if (sessionStorage.getItem(POLICY_NOTICE_KEY) !== "1") {
    if (policyOverlay?.classList.contains("show")) return;
    if (showPolicyNotice()) return;
  }
  flushRenewalNotice();
}

function clearRenewalPaymentFlow() {
  renewalPaymentRequestId += 1;
  if (renewalPaymentTimer) clearInterval(renewalPaymentTimer);
  renewalPaymentTimer = null;
  renewalPaymentOrderNo = "";
  const area = el("renewal-payment-area");
  if (area) {
    area.classList.remove("show");
    area.innerHTML = "";
  }
}

function setRenewalPaymentMethod(method) {
  renewalPaymentMethod = method === "wechat" ? "wechat" : "alipay";
  document.querySelectorAll("[data-renewal-pay-method]").forEach(button => {
    const active = button.dataset.renewalPayMethod === renewalPaymentMethod;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function finalizeRenewalPayment(orderNo, row) {
  const revealed = await window.developerAccounts.renewalPaymentReveal(orderNo).catch(error => ({ success: false, error: error.message }));
  if (!revealed?.success || !revealed.code) throw new Error(revealed?.error || "支付成功，但核验码领取失败");
  const activated = await window.developerAccounts.activate({ accountId: row?.id || "", appleId: row?.appleId || "", verificationCode: revealed.code }).catch(error => ({ success: false, error: error.message }));
  if (!activated?.success) throw new Error(activated?.error || "支付成功，但账户开通失败");
  clearRenewalNoticeForAccount(row?.id || "");
  await loadAccounts({
    accountId: row?.id || "",
    appleId: row?.appleId || "",
    access: activated.access || null,
  });
}

async function checkRenewalPaymentStatus({ manual = false, requestId = renewalPaymentRequestId, orderNo = renewalPaymentOrderNo, row = pendingRenewalNotice?.row || null } = {}) {
  if (!orderNo) {
    if (manual) el("renewal-error").textContent = "支付订单正在生成，请稍后再试";
    return;
  }
  const status = await window.developerAccounts.renewalPaymentStatus(orderNo).catch(() => ({}));
  if (requestId !== renewalPaymentRequestId || orderNo !== renewalPaymentOrderNo) return;
  const statusNode = el("renewal-payment-status");
  if (statusNode) statusNode.textContent = status.status === "paid" ? "支付成功，正在开通…" : "等待支付…";
  if (status.status !== "paid") {
    if (manual) el("renewal-error").textContent = "还没有查询到支付成功，请稍后再试";
    return;
  }
  renewalPaymentRequestId += 1;
  if (renewalPaymentTimer) clearInterval(renewalPaymentTimer);
  renewalPaymentTimer = null;
  renewalPaymentOrderNo = "";
  try {
    await finalizeRenewalPayment(orderNo, row);
  } catch (error) {
    el("renewal-error").textContent = error.message || "支付后开通失败";
  }
}

async function openDeveloperRenewalPurchase(method = renewalPaymentMethod) {
  setRenewalPaymentMethod(method);
  clearRenewalPaymentFlow();
  const requestId = renewalPaymentRequestId;
  const selectedMethod = renewalPaymentMethod;
  const button = el("renewal-submit");
  if (button) {
    button.disabled = true;
    button.textContent = "打开中…";
  }
  const row = pendingRenewalNotice?.row || null;
  const area = el("renewal-payment-area");
  const label = selectedMethod === "wechat" ? "微信" : "支付宝";
  if (area) {
    area.innerHTML = `<div class="renew-payment-loading">正在生成${label}支付二维码…</div>`;
    area.classList.add("show");
  }
  const result = await window.developerAccounts.createRenewalPayment({
    pay_method: selectedMethod,
    code_type: "normal",
    developer_account_id: row?.id || "",
    developer_apple_id: row?.appleId || "",
    purchase_source: "certificate_manager_browser",
  }).catch(error => ({ success: false, error: error.message }));
  if (requestId !== renewalPaymentRequestId) return;
  if (button) {
    button.disabled = false;
    button.textContent = "重新生成支付二维码";
  }
  if (!result?.success) {
    el("renewal-error").textContent = result?.error || "购买页面打开失败";
    return;
  }
  const amount = Number(result.amount || 0);
  const paymentPane = result.qr_image
    ? `<div class="renew-qr-box"><img class="renew-qr" src="${escapeHTML(result.qr_image)}" alt="${label}支付二维码"></div>`
    : `<iframe class="renew-frame" src="${escapeHTML(result.pay_url || "")}" title="${label}收银台"></iframe>`;
  area.innerHTML = `${paymentPane}<span class="renew-price"><b>${label}支付</b><strong>¥${amount.toFixed(2)}</strong><small id="renewal-payment-status">等待支付…</small></span>`;
  area.classList.add("show");
  renewalPaymentOrderNo = String(result.order_no || "");
  if (!renewalPaymentOrderNo) {
    el("renewal-error").textContent = "付款码生成失败";
    return;
  }
  const orderNo = renewalPaymentOrderNo;
  renewalPaymentTimer = setInterval(() => {
    if (requestId !== renewalPaymentRequestId || !el("renewal-mask")?.classList.contains("show")) {
      clearRenewalPaymentFlow();
      return;
    }
    void checkRenewalPaymentStatus({ requestId, orderNo, row });
  }, 2000);
}

function showActivation(result) {
  pendingActivationAccountId = result.accountId || "";
  pendingActivationAppleId = result.appleId || "";
  el("activate-account").textContent = result.appleId || "";
  el("activate-error").textContent = "";
  el("verification-code").value = "";
  el("activate-mask").classList.add("show");
  setTimeout(() => el("verification-code").focus(), 0);
}

function selectedMode() {
  return el("mode")?.value || "direct";
}

function updateModeUI() {
  const mode = selectedMode();
  el("browser-proxy-panel")?.classList.toggle("hidden", mode !== "browser_proxy");
  el("proxy-panel")?.classList.toggle("hidden", mode !== "custom_proxy");
  const note = el("note");
  if (note) {
    note.textContent = mode === "browser_proxy"
      ? "浏览器代理会直接读取代理管理中已经保存的代理。"
      : mode === "custom_proxy"
        ? "自定义代理会在确认前自动检测是否可用，检测通过后才允许保存。"
        : "直连模式不使用代理，启动时直接连接 Apple 开发者服务。";
  }
}

async function loadAccounts(accessOverride = null) {
  const result = await window.developerAccounts.list();
  if (!result?.success) {
    el("content").innerHTML = `<div class="fatal">${escapeHTML(result?.error || "账户列表读取失败")}</div>`;
    el("add").disabled = true;
    return;
  }
  el("user").textContent = result.username ? `当前用户：${result.username}` : "";
  const overrideAccountId = String(accessOverride?.accountId || "");
  const overrideAppleId = String(accessOverride?.appleId || "").trim().toLowerCase();
  const rows = [...(result.accounts || [])].map(row => {
    const matchesOverride = accessOverride?.access && (
      (overrideAccountId && String(row?.id || "") === overrideAccountId)
      || (overrideAppleId && String(row?.appleId || "").trim().toLowerCase() === overrideAppleId)
    );
    return matchesOverride ? { ...row, access: { ...(row.access || {}), ...accessOverride.access } } : row;
  }).sort((left, right) => {
    const leftDays = Number(left?.access?.remainingDays);
    const rightDays = Number(right?.access?.remainingDays);
    const leftRenew = accessWarning(left?.access) ? 0 : 1;
    const rightRenew = accessWarning(right?.access) ? 0 : 1;
    if (leftRenew !== rightRenew) return leftRenew - rightRenew;
    if (Number.isFinite(leftDays) && Number.isFinite(rightDays) && leftDays !== rightDays) return leftDays - rightDays;
    return String(left?.appleId || "").localeCompare(String(right?.appleId || ""));
  });
  el("count").textContent = `共 ${rows.length} 个`;
  if (!rows.length) {
    el("content").innerHTML = '<div class="empty"><b>暂无开发者账户</b><span>点击右上角“添加账户”开始绑定</span></div>';
    return;
  }
  el("content").innerHTML = `<table><thead><tr><th>Apple ID</th><th>备注</th><th>连接方式</th><th>首次注册 / 权限</th><th style="text-align:right">操作</th></tr></thead><tbody>${rows.map(row => {
    const expired = accessExpired(row.access);
    const canDelete = row.access?.canDelete !== false;
    const deleteControl = canDelete
      ? `<button class="danger remove" data-id="${escapeHTML(row.id)}">删除</button>`
      : `<span class="delete-blocked" style="color:#9a6b00;font-size:12px;line-height:1.25" title="${escapeHTML(row.access?.deleteBlockedReason || "该开发者账户属于当前邮箱对应的码友账户，不能删除")}">邮箱账户绑定，不可删除</span>`;
    return `<tr><td class="apple-id">${escapeHTML(row.appleId)}</td><td class="remark">${escapeHTML(row.remark || "—")}</td><td class="remark">${escapeHTML(connectionLabel(row))}</td><td class="access ${accessWarning(row.access) ? "expired" : ""}">${escapeHTML(accessLabel(row.access))}</td><td><div class="actions"><button class="secondary launch" data-id="${escapeHTML(row.id)}" data-expired="${expired ? "1" : "0"}" ${expired ? "disabled" : ""}>${expired ? "已到期" : "启动"}</button>${expired ? `<button class="secondary renew" type="button" data-id="${escapeHTML(row.id)}">续费</button>` : ""}<button class="secondary force-close hidden" type="button">强制关闭</button><button class="secondary update-password" type="button" data-id="${escapeHTML(row.id)}">更新配置</button><button class="secondary download" data-id="${escapeHTML(row.id)}">下载证书</button>${deleteControl}</div></td></tr>`;
  }).join("")}</tbody></table>`;
  document.querySelectorAll(".renew").forEach(button => button.addEventListener("click", () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    if (account) openRenewalDialog(account);
  }));
  document.querySelectorAll(".update-password").forEach(button => button.addEventListener("click", async () => {
    const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
    if (account) {
      await refreshBrowserProxyOptions();
      showAccountDialog(account);
    }
  }));
  document.querySelectorAll(".launch").forEach(button => button.addEventListener("click", async () => {
    if (button.dataset.expired === "1") {
      const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
      if (account) openRenewalDialog(account);
      return;
    }
    button.disabled = true; button.textContent = "启动中…";
    const result = await window.developerAccounts.launch(button.dataset.id);
    if (result?.activationRequired) showActivation(result);
    else if (!result?.success) {
      if (result?.renewalRequired || result?.expired) {
        const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
        if (account) openRenewalDialog(account);
        else alert(result?.error || "账户已到期，请先续费");
      } else {
      alert(result?.error || "启动失败");
      }
      if (result?.passwordRequired) {
        const account = rows.find(row => String(row.id || "") === String(button.dataset.id || ""));
        if (account) {
          await refreshBrowserProxyOptions();
          showAccountDialog(account);
        }
      }
    }
    await refreshCertificateManagerRunningState();
    if (!certificateManagerRunning) { button.disabled = false; button.textContent = "启动"; }
  }));
  document.querySelectorAll(".download").forEach(button => button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "准备中…";
    const result = await window.developerAccounts.downloadCertificate(button.dataset.id);
    if (!result?.success) alert(result?.error || "下载证书失败");
    button.disabled = false; button.textContent = "下载证书";
  }));
  document.querySelectorAll(".force-close").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("确定强制关闭码友证书管理并重置运行状态吗？")) return;
    button.disabled = true;
    button.textContent = "关闭中…";
    const result = await window.developerAccounts.forceCloseCertificateManager();
    if (!result?.success) alert(result?.error || "强制关闭失败");
    certificateManagerRunning = false;
    applyCertificateManagerRunningState();
    await refreshCertificateManagerRunningState();
  }));
  document.querySelectorAll(".remove").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("确定从我的账户列表中删除该 Apple ID 吗？")) return;
    const result = await window.developerAccounts.remove(button.dataset.id);
    if (!result?.success) alert(result?.error || "删除失败"); else await loadAccounts();
  }));
  applyCertificateManagerRunningState();
}

function applyCertificateManagerRunningState() {
  document.querySelectorAll(".launch").forEach(button => {
    if (button.dataset.expired === "1") {
      button.disabled = true;
      button.textContent = "已到期";
      return;
    }
    // Every click is a new open request. Electron's single-instance handler
    // decides whether to create a process or wake the existing one.
    button.disabled = false;
    button.textContent = certificateManagerRunning ? "打开" : "启动";
  });
  document.querySelectorAll(".force-close").forEach(button => {
    button.classList.toggle("hidden", !certificateManagerRunning);
    button.disabled = false;
    button.textContent = "强制关闭";
  });
}

async function refreshCertificateManagerRunningState() {
  try {
    const result = await window.developerAccounts.certificateManagerRunning();
    certificateManagerRunning = !!result?.running;
    applyCertificateManagerRunningState();
  } catch {}
}

function resetAccountDialog() {
  editingAccount = null;
  el("dialog-title").textContent = "添加开发者账户";
  el("submit").textContent = "确认添加";
  el("apple-id").readOnly = false;
  el("apple-id").setAttribute("autocomplete", "username");
  el("password").value = "";
  el("password").placeholder = "仅加密保存在本机";
  el("password").required = true;
  el("mode-field")?.classList.remove("hidden");
}

function showAccountDialog(account = null) {
  if (!account) {
    resetAccountDialog();
    el("form").reset();
    updateModeUI();
    el("mask").classList.add("show");
    setTimeout(() => el("apple-id").focus(), 0);
    return;
  }
  editingAccount = account;
  el("dialog-title").textContent = "更新账户配置";
  el("submit").textContent = "确认更新";
  el("apple-id").value = account.appleId || "";
  el("apple-id").readOnly = true;
  el("apple-id").setAttribute("autocomplete", "off");
  el("password").value = "";
  el("password").placeholder = "留空则保留当前本机密码";
  el("password").required = false;
  el("remark").value = account.remark || "";
  el("mode").value = account.connectionMode || "direct";
  el("mode-field")?.classList.remove("hidden");
  if (account.browserProxyKey) el("browser-proxy").value = account.browserProxyKey;
  const proxy = account.proxy || {};
  el("proxy-type").value = String(proxy.type || "http").toLowerCase() === "socks5" ? "socks5" : "http";
  el("proxy-host").value = proxy.host || "";
  el("proxy-port").value = proxy.port || "";
  el("proxy-username").value = proxy.username || "";
  el("proxy-password").value = "";
  updateModeUI();
  el("note").textContent = "可更新本机加密保存的 Apple ID 密码、备注及连接方式；账户密码不会上传到服务器。";
  el("mask").classList.add("show");
  setTimeout(() => el("remark").focus(), 0);
}

function closeDialog() {
  el("mask").classList.remove("show");
  el("error").textContent = "";
  resetAccountDialog();
}
el("add").addEventListener("click", async () => { await refreshBrowserProxyOptions(); showAccountDialog(); });
el("close").addEventListener("click", closeDialog);
el("cancel").addEventListener("click", closeDialog);
el("mask").addEventListener("click", event => { if (event.target === el("mask")) closeDialog(); });
el("mode").addEventListener("change", updateModeUI);
el("activate-close").addEventListener("click", () => el("activate-mask").classList.remove("show"));
el("activate-cancel").addEventListener("click", () => el("activate-mask").classList.remove("show"));
el("activate-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = el("activate-submit");
  button.disabled = true;
  el("activate-error").textContent = "";
  const result = await window.developerAccounts.activate({
    accountId: pendingActivationAccountId,
    appleId: pendingActivationAppleId,
    verificationCode: el("verification-code").value,
  });
  button.disabled = false;
  if (!result?.success) { el("activate-error").textContent = result?.error || "开通失败"; return; }
  clearRenewalNoticeForAccount(pendingActivationAccountId);
  el("activate-mask").classList.remove("show");
  await loadAccounts();
});
el("form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = el("submit"); button.disabled = true; el("error").textContent = "";
  const proxy = {
    enabled: true,
    type: el("proxy-type").value,
    host: el("proxy-host").value.trim(),
    port: Number(el("proxy-port").value),
    username: el("proxy-username").value.trim(),
    password: el("proxy-password").value,
  };
  const connectionMode = selectedMode();
  const browserProxy = selectedBrowserProxy();
  if (connectionMode === "browser_proxy" && !browserProxy) {
    el("error").textContent = "请先在代理管理中选择一个可用代理";
    button.disabled = false;
    return;
  }
  if (connectionMode === "custom_proxy" && (!proxy.host || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535)) {
    el("error").textContent = "请填写有效的代理主机和端口";
    button.disabled = false;
    return;
  }
  if (connectionMode === "custom_proxy") {
    const detected = await window.browserProxy?.detectIP?.(proxy);
    if (!detected || !detected.ip || detected.ip === "—") {
      el("error").textContent = detected?.statusText || "代理检测失败，请检查后重试";
      button.disabled = false;
      return;
    }
  }
  if (editingAccount) {
    const result = await window.developerAccounts.updatePassword({
      accountId: editingAccount.id,
      password: el("password").value,
      remark: el("remark").value,
      connectionMode,
      browserProxyKey: connectionMode === "browser_proxy" ? proxyKey(browserProxy) : "",
      proxy: connectionMode === "custom_proxy" ? proxy : null,
      keepProxyPassword: connectionMode === "custom_proxy" && !proxy.password,
    });
    button.disabled = false;
    if (!result?.success) { el("error").textContent = result?.error || "配置更新失败"; return; }
    el("form").reset(); updateModeUI(); closeDialog(); await loadAccounts();
    return;
  }
  if (!el("password").value) { el("error").textContent = "请输入 Apple ID 密码"; button.disabled = false; return; }
  const result = await window.developerAccounts.add({ appleId: el("apple-id").value, password: el("password").value, remark: el("remark").value, connectionMode, browserProxyKey: connectionMode === "browser_proxy" ? proxyKey(browserProxy) : "", proxy: connectionMode === "custom_proxy" ? proxy : null });
  button.disabled = false;
  if (!result?.success) { el("error").textContent = result?.error || "添加失败"; return; }
  el("form").reset(); updateModeUI(); closeDialog(); await loadAccounts();
});
Promise.all([loadBrowserProxies()]).then(() => {
  renderBrowserProxyOptions();
  loadAccounts();
});
updateModeUI();
el("refresh-proxies").addEventListener("click", async () => { await refreshBrowserProxyOptions(); });
document.querySelectorAll("[data-renewal-pay-method]").forEach(button => button.addEventListener("click", () => {
  void openDeveloperRenewalPurchase(button.dataset.renewalPayMethod);
}));
el("renewal-payment-refresh").addEventListener("click", () => {
  void checkRenewalPaymentStatus({ manual: true });
});
refreshCertificateManagerRunningState();
runningPollTimer = setInterval(refreshCertificateManagerRunningState, 1500);
window.addEventListener("beforeunload", () => {
  if (runningPollTimer) clearInterval(runningPollTimer);
});
