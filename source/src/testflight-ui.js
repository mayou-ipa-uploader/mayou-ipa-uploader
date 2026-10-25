(function (root) {
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const platforms = { IOS: "iOS", MAC_OS: "macOS", TV_OS: "tvOS", VISION_OS: "visionOS" };
  const locales = { "zh-Hans": "简体中文", "zh-Hant": "繁体中文", "en-US": "英语（美国）", "en-GB": "英语（英国）", "ja": "日语", "ko": "韩语", "fr-FR": "法语", "de-DE": "德语", "es-ES": "西班牙语" };
  const docs = "https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/";
  const uploadStates = { COMPLETE: "完成", PROCESSING: "正在处理", FAILED: "失败" };
  const defaultUploadStates = ["PROCESSING", "FAILED", "COMPLETE"];
  const link = (action, text, attributes = "") => {
    const extraClass = attributes.match(/class="([^"]*)"/)?.[1] || "";
    return `<button class="tf-link ${extraClass}" type="button" data-tf-action="${action}" ${attributes.replace(/class="[^"]*"/, "")}>${text}</button>`;
  };
  const loading = '<div class="tf-loading" role="status"><i class="loading-spinner"></i>正在加载…</div>';
  const empty = text => `<div class="tf-empty">${escape(text)}</div>`;
  const errorHTML = (message, action = "retry") => `<div class="tf-error" role="alert">${escape(message)} ${link(action, "重试")}</div>`;
  const date = value => value && !Number.isNaN(Date.parse(value)) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
  const uploadDate = value => {
    if (!value || Number.isNaN(Date.parse(value))) return "–";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  };
  const safeURL = value => { try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; } };
  function buildStatus(build, now = Date.now()) {
    const beta = build.betaDetail || {};
    const external = beta.externalBuildState || "", internal = beta.internalBuildState || "";
    if (build.expired || (build.expirationDate && Date.parse(build.expirationDate) <= now)) return { text: "已过期", tone: "gray", expired: true };
    if (/FAILED|INVALID/.test(build.processingState || "")) return { text: "处理失败", tone: "red" };
    if (build.processingState === "PROCESSING") return { text: "正在处理", tone: "yellow" };
    if ([internal, external].includes("MISSING_EXPORT_COMPLIANCE")) return { text: "缺少出口合规证明", tone: "warning", encryption: true };
    if ([internal, external].includes("IN_EXPORT_COMPLIANCE_REVIEW")) return { text: "出口合规审核中", tone: "yellow" };
    const labels = { READY_FOR_BETA_SUBMISSION: "准备提交", WAITING_FOR_BETA_REVIEW: "等待审核", IN_BETA_REVIEW: "正在审核", BETA_REJECTED: "已被拒绝", BETA_APPROVED: "可供测试", READY_FOR_BETA_TESTING: "可供测试", IN_BETA_TESTING: "正在测试", EXPIRED: "已过期" };
    const key = external || internal;
    return { text: labels[key] || key || build.processingState || "状态未知", tone: /REJECT/.test(key) ? "red" : /IN_BETA_TESTING|BETA_APPROVED|READY_FOR_BETA_TESTING/.test(key) ? "green" : "yellow" };
  }
  function statusHTML(build) {
    const status = buildStatus(build);
    const days = build.expirationDate ? Math.max(0, Math.ceil((Date.parse(build.expirationDate) - Date.now()) / 86400000)) : null;
    return `<span class="tf-status"><i class="tf-dot ${status.tone}" aria-hidden="true"></i><span>${escape(status.text)}${status.encryption ? ` ${link("encryption", "管理", `data-id="${escape(build.id)}"`)}` : ""}${!status.encryption && !status.expired && Number.isFinite(days) ? `<small>${days} 天后过期</small>` : ""}</span></span>`;
  }
  function shell(app, iconHTML = "") {
    return `<div class="app-detail tf-page" data-pane="testflight" data-app-id="${escape(app.id)}">
      <header class="tf-header"><div class="tf-identity">${iconHTML}<h2>${escape(app.name || "App")}</h2></div><nav aria-label="App 功能">${link("distribution", "分发")}<button class="tf-link active" type="button" aria-current="page">TestFlight</button></nav></header>
      <div class="tf-body"><aside class="tf-side" aria-label="TestFlight 导航"></aside><main class="app-detail-main tf-main" id="app-detail-main">${loading}</main></div></div>`;
  }
  function mount(options) {
    const host = options.root;
    if (!host) return;
    const app = options.app;
    const state = { platform: options.platform || "IOS", versions: [], groups: [], openVersions: new Set(), buildPages: new Map(), sorts: new Map(), uploads: null, uploadsOpen: false, uploadsSeq: 0, uploadsPending: null, uploadStates: [...defaultUploadStates], uploadSort: "-uploadedDate", view: "builds", navSeq: 0, overviewSeq: 0, contextToken: options.contextToken || "", args: {}, dirty: false, metrics: new Map(), metricsPending: new Set() };
    const main = host.querySelector(".tf-main"), side = host.querySelector(".tf-side");
    const live = () => host.isConnected;
    const request = async (action, payload = {}) => {
      const pending = options.api({ action, ...payload, appId: app.id, platform: state.platform, contextToken: state.contextToken });
      // Bound reads including time spent in the main-process queue. Writes keep
      // waiting for their actual result so a timeout cannot invite duplicate writes.
      const reads = ["overview", "builds", "build", "metrics", "uploads", "testers", "internalUsers", "feedback", "info"];
      let timer, result;
      try {
        result = reads.includes(action) ? await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("读取 Apple 数据超时，请重试")), 45000);
        })]) : await pending;
      } finally { clearTimeout(timer); }
      if (!result?.success) throw new Error(result?.error || "TestFlight 请求失败，请重试");
      if (state.contextToken && state.contextToken !== result.contextToken) throw new Error("Apple 账户已切换，请重新打开 TestFlight");
      state.contextToken = result.contextToken;
      return result.data;
    };
    const notice = text => {
      if (!live()) return;
      main.querySelector(".tf-notice")?.remove();
      main.insertAdjacentHTML("afterbegin", `<div class="tf-notice" role="status">${escape(text)}</div>`);
    };
    function sidebar() {
      const available = [...new Set(["IOS", ...(options.versions || []).map(row => row.platform).filter(value => platforms[value])])];
      const nav = (view, text, attrs = "") => `<button type="button" class="${state.view === view ? "active" : ""}" data-tf-action="nav" data-view="${view}" ${attrs}>${escape(text)}</button>`;
      const groups = internal => state.groups.filter(row => row.isInternalGroup === internal).map(row => `<button type="button" class="${state.args.groupId === row.id ? "active" : ""}" data-tf-action="group" data-id="${escape(row.id)}">${escape(row.name)}</button>`).join("");
      side.innerHTML = `<section><h3>构建版本</h3>${available.map(platform => `<button type="button" class="${state.view === "builds" && state.platform === platform ? "active" : ""}" data-tf-action="platform" data-platform="${platform}">${platforms[platform]}</button>`).join("")}</section>
        <section><h3>反馈</h3>${nav("crash", "崩溃")}${nav("screenshot", "截屏")}</section>
        <section><h3>测试员</h3>${nav("testers", "全部")}<div class="tf-group-label">内部测试 ${link("create-group", "+", 'class="tf-plus" aria-label="创建内部测试群组" data-internal="true"')}</div>${groups(true)}${state.groups.some(row => !row.isInternalGroup) ? `<div class="tf-group-label">外部测试 ${link("create-group", "+", 'aria-label="创建外部测试群组" data-internal="false"')}</div>${groups(false)}` : ""}</section>
        <section><h3>其他</h3>${nav("info", "测试信息")}${link("about", "关于 TestFlight 数据 <span class=\"tf-help\">?</span>")}</section>`;
    }
    function buildRows(items) {
      return `<div class="tf-table-scroll"><table class="tf-table tf-build-table"><colgroup><col style="width:19%"><col style="width:25%"><col style="width:10%"><col style="width:11%"><col style="width:12%"><col style="width:11%"><col style="width:12%"></colgroup><thead><tr><th>${link("sort-builds", `构建版本<span class="tf-sort">⌄</span>`)}</th><th>状态</th><th>邀请</th><th>安装</th><th>APP 使用次数</th><th>崩溃</th><th>反馈</th></tr></thead><tbody>${items.map(build => `<tr data-build-id="${escape(build.id)}"><td><span class="tf-build-name">${safeURL(build.iconUrl || app.iconUrl) ? `<img src="${escape(safeURL(build.iconUrl || app.iconUrl))}" alt="">` : '<span class="tf-icon-placeholder"></span>'}${link("build", escape(build.version), `data-id="${escape(build.id)}"`)}</span></td><td>${statusHTML(build)}</td>${["inviteCount", "installCount", "sessionCount", "crashCount", "feedbackCount"].map(key => `<td class="tf-metric" data-metric="${key}">${metricValue(build.id, key)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    function metricValue(buildId, key) {
      const aliases = { inviteCount: ["inviteCount", "invites", "invitedTesters"], installCount: ["installCount", "installs"], sessionCount: ["sessionCount", "sessions"], crashCount: ["crashCount", "crashes"], feedbackCount: ["feedbackCount", "feedbacks"] };
      const data = state.metrics.get(buildId);
      if (!data) return "–";
      const values = data.flatMap(row => {
        const metrics = row.metrics || row;
        const keyName = aliases[key].find(name => metrics[name] !== undefined && metrics[name] !== null);
        return keyName && Number.isFinite(Number(metrics[keyName])) ? [Number(metrics[keyName])] : [];
      });
      return values.length ? new Intl.NumberFormat("zh-CN").format(values.reduce((a, b) => a + b, 0)) : "–";
    }
    function loadMetrics(builds) {
      for (const build of builds) {
        if (state.metrics.has(build.id) || state.metricsPending.has(build.id)) continue;
        state.metricsPending.add(build.id);
        request("metrics", { buildId: build.id }).then(data => {
          state.metrics.set(build.id, data);
          if (!live()) return;
          main.querySelectorAll("[data-build-id]").forEach(row => {
            if (row.dataset.buildId === build.id) row.querySelectorAll("[data-metric]").forEach(cell => { cell.textContent = metricValue(build.id, cell.dataset.metric); });
          });
        }).catch(error => {
          if (!live()) return;
          main.querySelectorAll("[data-build-id]").forEach(row => {
            if (row.dataset.buildId === build.id) row.querySelectorAll("[data-metric]").forEach(cell => { cell.title = `指标暂未读取成功：${error.message}`; });
          });
        }).finally(() => state.metricsPending.delete(build.id));
      }
    }
    function uploadsHTML() {
      if (!state.uploads) return loading;
      if (state.uploads.error && !state.uploads.items?.length) return errorHTML(state.uploads.error, "retry-uploads");
      if (!state.uploads.items.length) return empty(state.uploadStates.length === 3 ? "暂无构建版本上传记录。" : "没有符合所选状态的构建版本上传记录。") + (state.uploadStates.length < 3 ? link("clear-upload-filter", "清除筛选条件", 'class="tf-clear-filter"') : "");
      return `<div class="tf-table-scroll"><table class="tf-table tf-upload-table" aria-label="构建版本上传"><colgroup><col style="width:41%"><col style="width:30%"><col style="width:29%"></colgroup><thead><tr><th scope="col">版本和构建</th><th scope="col">状态</th><th scope="col" aria-sort="${state.uploadSort.startsWith("-") ? "descending" : "ascending"}">${link("sort-uploads", `创建日期<i class="tf-sort-chevron ${state.uploadSort.startsWith("-") ? "" : "ascending"}" aria-hidden="true"></i>`)}</th></tr></thead><tbody>${state.uploads.items.map(row => {
        const code = typeof row.state === "string" ? row.state : row.state?.state;
        const messages = ["errors", "warnings", "infos"].flatMap(key => row.state?.[key] || []);
        const build = [...state.buildPages.values()].flatMap(page => page.items || []).find(build => build.id === row.buildId);
        const icon = safeURL(build?.iconUrl || app.iconUrl);
        const name = `${escape(row.cfBundleShortVersionString || "–")} (${escape(row.cfBundleVersion || "–")})`;
        const iconHTML = icon ? `<img src="${escape(icon)}" alt="">` : '<span class="tf-icon-placeholder"></span>';
        const version = code === "COMPLETE" && row.buildId ? link("build", `${iconHTML}<span>${name}</span>`, `class="tf-build-name" data-id="${escape(row.buildId)}"`) : `<span class="tf-build-name">${iconHTML}<span>${name}</span></span>`;
        const status = `<span class="tf-upload-status"><span class="tf-upload-status-icon ${code === "COMPLETE" ? "complete" : code === "FAILED" ? "failed" : "processing"}" aria-hidden="true">${code === "FAILED" ? "×" : ""}${code === "COMPLETE" && row.state?.warnings?.length ? '<i class="tf-upload-warning">!</i>' : ""}</span><span>${escape(uploadStates[code] || code || "–")}</span></span>`;
        return `<tr><td>${version}</td><td>${messages.length ? link("upload-detail", status, `data-id="${escape(row.id)}" aria-label="${escape(`${name} ${uploadStates[code] || code}，查看上传信息`)}"`) : status}</td><td>${uploadDate(row.uploadedDate)}</td></tr>`;
      }).join("")}</tbody></table></div>${state.uploads.error ? errorHTML(state.uploads.error, "retry-uploads") : state.uploads.next ? link("more-uploads", state.uploadsPending ? "正在加载…" : "查看更多", state.uploadsPending ? "disabled" : "") : ""}`;
    }
    function uploadToolbar() {
      const label = state.uploadStates.length === 3 ? "所有状态" : Object.keys(uploadStates).filter(code => state.uploadStates.includes(code)).map(code => uploadStates[code]).join("、");
      return `<div class="tf-upload-toolbar"><p>查看构建版本上传进度，包括警告、错误和上传日志。 ${link("docs", "进一步了解")}</p><details class="tf-upload-filter"><summary>${escape(label)}<i class="tf-sort-chevron" aria-hidden="true"></i></summary><div class="tf-filter-popover"><label class="tf-filter-all"><input type="checkbox" data-upload-all ${state.uploadStates.length === 3 ? "checked" : ""}>所有状态</label><div class="tf-filter-options">${Object.entries(uploadStates).map(([code, label]) => `<label><input type="checkbox" data-upload-state value="${code}" ${state.uploadStates.includes(code) ? "checked" : ""}>${label}</label>`).join("")}</div><footer><button type="button" class="tf-button primary" data-tf-action="apply-upload-filter" disabled>应用</button></footer></div></details></div>`;
    }
    function drawBuilds() {
      if (!live() || state.view !== "builds") return;
      const filter = main.querySelector(".tf-upload-filter[open]");
      const draft = filter ? [...filter.querySelectorAll("[data-upload-state]:checked")].map(input => input.value) : null;
      main.innerHTML = `<div class="tf-title"><h1>${platforms[state.platform]} 构建版本</h1><p>以下构建版本可供测试。 ${link("docs", "进一步了解构建版本状态和指标")}</p></div>
        ${state.groupsError ? errorHTML(`群组读取失败：${state.groupsError}`) : !state.groups.length ? `<div class="tf-info-banner"><span class="tf-info-icon">i</span><span>要开始测试 App 并收集相关反馈，请创建群组并使用测试员的电子邮件来进行邀请。 ${link("create-group", "创建群组")}</span></div>` : ""}
        <section class="tf-accordion tf-uploads"><button class="tf-section-toggle" data-tf-action="toggle-uploads" type="button" aria-expanded="${state.uploadsOpen}"><i class="tf-chevron ${state.uploadsOpen ? "open" : ""}"></i>构建版本上传</button>${state.uploadsOpen ? `<div class="tf-section-content">${uploadToolbar()}${uploadsHTML()}</div>` : ""}</section>
        ${state.versions.map(version => {
          const open = state.openVersions.has(version.id), data = state.buildPages.get(version.id);
          return `<section class="tf-accordion" data-version-id="${escape(version.id)}"><button class="tf-section-toggle" type="button" data-tf-action="toggle-version" data-id="${escape(version.id)}" aria-expanded="${open}"><i class="tf-chevron ${open ? "open" : ""}"></i>版本 ${escape(version.version)}</button>${open ? `<div class="tf-section-content">${!data ? loading : data.error ? errorHTML(data.error) : data.items.length ? buildRows(data.items) : empty("此版本暂无构建版本。")}${data?.next ? link("more-builds", "载入更多", `data-id="${escape(version.id)}"`) : ""}</div>` : ""}</section>`;
        }).join("")}${!state.versions.length ? empty("尚未上传构建版本。上传后可在此查看苹果的处理结果。") : ""}${state.versionsNext ? link("more-versions", "载入更多版本") : ""}`;
      if (draft) {
        const nextFilter = main.querySelector(".tf-upload-filter");
        if (nextFilter) {
          nextFilter.open = true;
          nextFilter.querySelectorAll("[data-upload-state]").forEach(input => { input.checked = draft.includes(input.value); });
          syncUploadFilter(nextFilter);
        }
      }
    }
    function syncUploadFilter(filter) {
      const selected = [...filter.querySelectorAll("[data-upload-state]:checked")].map(input => input.value);
      const all = filter.querySelector("[data-upload-all]"); all.checked = selected.length === 3; all.indeterminate = selected.length > 0 && selected.length < 3;
      filter.querySelector('[data-tf-action="apply-upload-filter"]').disabled = !selected.length || selected.length === state.uploadStates.length && selected.every(code => state.uploadStates.includes(code));
    }
    async function loadBuilds(versionId, more = false) {
      const platform = state.platform, seq = state.overviewSeq;
      const previous = state.buildPages.get(versionId);
      try {
        const data = await request("builds", { versionId, sort: state.sorts.get(versionId) || "-version", next: more ? previous?.next : "" });
        if (!live() || platform !== state.platform || seq !== state.overviewSeq) return;
        state.buildPages.set(versionId, { ...data, items: more ? [...previous.items, ...data.items] : data.items });
        drawBuilds(); loadMetrics(data.items);
      } catch (error) { if (live() && seq === state.overviewSeq) { state.buildPages.set(versionId, { error: error.message }); drawBuilds(); } }
    }
    async function overview(more = false) {
      const seq = ++state.overviewSeq;
      if (!more) main.innerHTML = loading;
      try {
        const data = await request("overview", { next: more ? state.versionsNext : "" });
        if (!live() || seq !== state.overviewSeq) return;
        state.versions = more ? [...state.versions, ...data.versions.items] : data.versions.items;
        state.versionsNext = data.versions.next; state.groups = data.groups; state.groupsError = data.groupsError;
        if (!more && state.versions[0]) state.openVersions.add(state.versions[0].id);
        side.inert = false; sidebar(); drawBuilds();
        ensureBuildLists();
      } catch (error) { if (live() && seq === state.overviewSeq) main.innerHTML = errorHTML(error.message); }
    }
    async function loadUploads(more = false) {
      if (state.uploadsPending) return;
      const seq = ++state.uploadsSeq, platform = state.platform, previous = state.uploads;
      const token = {}; state.uploadsPending = token;
      if (more && !previous?.next) { state.uploadsPending = null; return; }
      if (more) state.uploads = { ...previous, error: "" }; else state.uploads = null;
      drawBuilds();
      try {
        const data = await request("uploads", { next: more ? previous.next : "", states: state.uploadStates, sort: state.uploadSort });
        if (!live() || seq !== state.uploadsSeq || platform !== state.platform) return;
        state.uploads = { ...data, items: [...new Map((more ? [...previous.items, ...data.items] : data.items).map(row => [row.id, row])).values()] };
      } catch (error) {
        if (live() && seq === state.uploadsSeq && platform === state.platform) state.uploads = { ...(more ? previous : {}), error: error.message };
      } finally {
        if (state.uploadsPending === token) { state.uploadsPending = null; drawBuilds(); }
      }
    }
    function resetUploads() {
      ++state.uploadsSeq; state.uploadsPending = null; state.uploads = null;
    }
    function ensureBuildLists() {
      if (state.uploadsOpen && !state.uploads) loadUploads();
      for (const version of state.versions) if (state.openVersions.has(version.id) && !state.buildPages.has(version.id)) loadBuilds(version.id);
    }
    function modal(title, body, buttons = "") {
      const mask = document.createElement("div"); mask.className = "tf-modal-mask";
      mask.innerHTML = `<section class="tf-modal" role="dialog" aria-modal="true" aria-label="${escape(title)}"><header><h2>${escape(title)}</h2><button type="button" class="tf-close" aria-label="关闭">×</button></header><div class="tf-modal-body">${body}<div class="tf-modal-error" role="alert"></div></div><footer><button class="tf-button" data-close type="button">取消</button>${buttons}</footer></section>`;
      host.append(mask);
      const close = () => { if (!mask.dataset.busy) mask.remove(); };
      mask.querySelector(".tf-close").onclick = close; mask.querySelector("[data-close]").onclick = close;
      mask.addEventListener("click", event => { if (event.target === mask) close(); });
      mask.addEventListener("keydown", event => { if (event.key === "Escape") close(); if (event.key === "Tab") { const list = [...mask.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')].filter(node => !node.hidden); if (event.shiftKey && document.activeElement === list[0]) { event.preventDefault(); list.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === list.at(-1)) { event.preventDefault(); list[0]?.focus(); } } });
      mask.querySelector("input,textarea,select,button")?.focus(); return mask;
    }
    async function commit(mask, work, done) {
      if (mask.dataset.busy) return;
      mask.dataset.busy = "1";
      const controls = [...mask.querySelectorAll("button,input,textarea,select")].map(node => [node, node.disabled]);
      controls.forEach(([node]) => { node.disabled = true; });
      const message = mask.querySelector(".tf-modal-error"); message.textContent = "正在保存…";
      try { const result = await work(); if (!live() || !mask.isConnected) return; mask.remove(); if (done) await done(result); }
      catch (error) { if (mask.isConnected) { delete mask.dataset.busy; controls.forEach(([node, disabled]) => { node.disabled = disabled; }); message.textContent = error.message; } }
    }
    function createGroup(internal = true, existing = null) {
      const mask = modal(existing ? "编辑群组" : "创建群组", `<label>群组名称<input name="name" maxlength="100" value="${escape(existing?.name || "")}" placeholder="输入群组名称"></label>${!existing ? `<div class="tf-choice"><label><input type="radio" name="kind" value="internal" ${internal ? "checked" : ""}>内部测试</label><label><input type="radio" name="kind" value="external" ${internal ? "" : "checked"}>外部测试</label></div>` : ""}<label class="tf-check"><input type="checkbox" name="automatic" ${existing?.hasAccessToAllBuilds !== false ? "checked" : ""}>启用自动分发</label><p class="tf-muted">自动将新的可用构建版本分发给此内部测试群组。</p>`, '<button class="tf-button primary" data-save type="button">创建</button>');
      const save = mask.querySelector("[data-save]"); save.textContent = existing ? "保存" : "创建";
      const sync = () => { const internalGroup = existing ? existing.isInternalGroup : mask.querySelector('[name="kind"]:checked').value === "internal"; mask.querySelector('[name="automatic"]').closest("label").hidden = !internalGroup; mask.querySelector(".tf-muted").hidden = !internalGroup; save.disabled = !mask.querySelector('[name="name"]').value.trim(); };
      mask.querySelectorAll("input").forEach(node => node.addEventListener("input", sync)); sync();
      save.onclick = () => commit(mask, () => request(existing ? "saveGroup" : "createGroup", { groupId: existing?.id, name: mask.querySelector('[name="name"]').value, internal: existing ? existing.isInternalGroup : mask.querySelector('[name="kind"]:checked').value === "internal", automatic: mask.querySelector('[name="automatic"]').checked }), async data => {
        if (existing) state.groups = state.groups.map(row => row.id === existing.id ? { ...row, name: data?.name || mask.querySelector('[name="name"]').value } : row);
        else state.groups.push(data);
        await navigate("group", { groupId: existing?.id || data.id }); notice(existing ? "群组已保存。" : "群组已创建。");
      });
    }
    const localeSelect = (selected, extra = []) => `<select name="locale" aria-label="语言">${[...new Set([selected, ...extra, ...Object.keys(locales)])].filter(Boolean).map(locale => `<option value="${escape(locale)}" ${selected === locale ? "selected" : ""}>${escape(locales[locale] || locale)}</option>`).join("")}</select>`;
    const field = (label, name, value, type = "text", extra = "") => `<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value || "")}" ${extra}></label>`;
    function infoForm(data) {
      const locale = state.args.locale || data.betaAppLocalizations?.[0]?.locale || app.primaryLocale || "zh-Hans";
      const local = data.betaAppLocalizations.find(row => row.locale === locale) || { locale };
      const review = data.betaAppReviewDetails[0];
      main.innerHTML = `<form class="tf-form" data-info-form><div class="tf-heading-row"><h1>测试信息</h1><button class="tf-button primary" type="submit" disabled>保存</button></div>${data.errors.length ? errorHTML(data.errors.join("；")) : ""}<section><div class="tf-heading-row"><h2>Beta 版 App 信息</h2>${localeSelect(locale, data.betaAppLocalizations.map(row => row.locale))}</div><label>Beta 版 App 描述<textarea name="description" maxlength="4000" rows="6">${escape(local.description || "")}</textarea></label><div class="tf-form-grid">${field("反馈电子邮件", "feedbackEmail", local.feedbackEmail, "email")}${field("营销网址", "marketingUrl", local.marketingUrl, "url")}${field("隐私政策网址", "privacyPolicyUrl", local.privacyPolicyUrl, "url")}</div></section>
        ${review ? `<section><h2>Beta 版 App 审核信息</h2><div class="tf-form-grid">${field("名字", "contactFirstName", review.contactFirstName)}${field("姓氏", "contactLastName", review.contactLastName)}${field("电话号码", "contactPhone", review.contactPhone, "tel")}${field("电子邮件", "contactEmail", review.contactEmail, "email")}</div><label class="tf-check"><input type="checkbox" name="demoAccountRequired" ${review.demoAccountRequired ? "checked" : ""}>需要登录</label><div class="tf-form-grid">${field("用户名", "demoAccountName", review.demoAccountName)}${field("密码", "demoAccountPassword", review.demoAccountPassword, "password")}</div><label>备注<textarea name="notes" maxlength="4000" rows="4">${escape(review.notes || "")}</textarea></label></section>` : ""}
        ${data.betaLicenseAgreements[0]?.agreementText ? `<section><h2>许可协议</h2><p class="tf-prewrap">${escape(data.betaLicenseAgreements[0].agreementText)}</p></section>` : ""}<div class="tf-form-message" role="status"></div></form>`;
      const form = main.querySelector("form"), save = form.querySelector('[type="submit"]');
      form.elements.locale.onchange = () => { const next = form.elements.locale.value; form.elements.locale.value = locale; guard(() => { state.args.locale = next; infoForm(data); }); };
      form.addEventListener("input", event => { if (event.target.name === "locale") return; state.dirty = true; save.disabled = !!data.errors.length; });
      form.onsubmit = async event => {
        event.preventDefault(); if (save.disabled) return;
        const values = Object.fromEntries(new FormData(form));
        const controls = [...form.querySelectorAll("input,textarea,select,button")]; controls.forEach(node => { node.disabled = true; });
        const localization = { ...local, ...Object.fromEntries(["description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl"].map(key => [key, values[key]])), locale };
        const nextReview = review ? { ...review, ...Object.fromEntries(["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountPassword", "notes"].map(key => [key, values[key]])), demoAccountRequired: values.demoAccountRequired === "on" } : undefined;
        try { await request("saveInfo", { localization, review: nextReview }); if (!form.isConnected) return; state.dirty = false; data.betaAppLocalizations = [...data.betaAppLocalizations.filter(row => row.locale !== locale), localization]; if (nextReview) data.betaAppReviewDetails = [nextReview]; notice("测试信息保存成功。"); }
        catch (error) { if (form.isConnected) form.querySelector(".tf-form-message").textContent = error.message; }
        finally { if (form.isConnected) { controls.forEach(node => { node.disabled = false; }); save.disabled = !state.dirty; } }
      };
    }
    function testersHTML(data, groupId = "") {
      return `<div class="tf-toolbar"><form data-tester-search><input name="search" type="search" aria-label="搜索测试员" placeholder="搜索测试员" value="${escape(state.args.search || "")}"><button class="tf-button" type="submit">搜索</button></form>${groupId ? link("add-testers", "添加测试员", `data-id="${escape(groupId)}"`) : ""}</div>${data.items.length ? `<table class="tf-table"><thead><tr><th>测试员</th><th>状态</th><th>安装的版本</th><th>邀请方式</th></tr></thead><tbody>${data.items.map(row => `<tr><td>${escape(row.email || "匿名测试员")}<small>${escape([row.firstName, row.lastName].filter(Boolean).join(" "))}</small></td><td>${escape(({ INVITED: "已邀请", ACCEPTED: "已接受", INSTALLED: "已安装", NOT_INVITED: "未邀请" })[row.state] || row.state || "—")}</td><td>${escape([row.installedCfBundleShortVersionString, row.installedCfBundleVersion && `(${row.installedCfBundleVersion})`].filter(Boolean).join(" ") || "—")}</td><td>${escape(({ EMAIL: "电子邮件", PUBLIC_LINK: "公开链接" })[row.inviteType] || row.inviteType || "—")}</td></tr>`).join("")}</tbody></table>` : empty("暂无测试员。创建群组并添加测试员以开始测试。")}${data.next ? link("more-testers", "载入更多测试员") : ""}`;
    }
    function wireTesterSearch() {
      const form = main.querySelector("[data-tester-search]");
      if (form) form.onsubmit = event => { event.preventDefault(); navigate(state.view, { ...state.args, search: form.elements.search.value }); };
    }
    async function addTesters(groupId) {
      const group = state.groups.find(row => row.id === groupId); if (!group) return;
      const mask = modal("添加测试员", group.isInternalGroup ? loading : '<label>电子邮件地址<textarea name="emails" rows="6" placeholder="每行填写一位测试员的电子邮件地址"></textarea></label><p>Apple 将通过电子邮件向添加的测试员发送 TestFlight 邀请。</p>', '<button class="tf-button primary" data-save disabled type="button">添加</button>');
      const save = mask.querySelector("[data-save]"); let users = [], next = "";
      if (group.isInternalGroup) {
        const load = async more => {
          try {
            const data = await request("internalUsers", { next: more ? next : "" }); if (!mask.isConnected) return;
            users = more ? [...users, ...data.items] : data.items; next = data.next;
            const selected = new Set([...mask.querySelectorAll("[data-user]:checked")].map(node => node.dataset.user));
            mask.querySelector(".tf-modal-body").innerHTML = `<p>选择有权访问此 App 的 App Store Connect 用户。</p><div class="tf-user-picker">${users.map(user => `<label class="tf-check"><input type="checkbox" data-user="${escape(user.id)}" ${selected.has(user.id) ? "checked" : ""}><span>${escape(user.email)}<small>${escape([user.firstName, user.lastName].filter(Boolean).join(" "))}</small></span></label>`).join("") || empty("没有可用的内部测试员。")}</div>${next ? '<button type="button" class="tf-link" data-more-users>载入更多</button>' : ""}<div class="tf-modal-error" role="alert"></div>`;
            mask.querySelector("[data-more-users]")?.addEventListener("click", () => load(true));
            mask.querySelectorAll("[data-user]").forEach(node => node.onchange = () => { save.disabled = !mask.querySelector("[data-user]:checked"); });
          } catch (error) { if (mask.isConnected) mask.querySelector(".tf-modal-body").innerHTML = `<div class="tf-modal-error">${escape(error.message)}</div>`; }
        };
        await load(false);
      } else mask.querySelector("textarea").oninput = event => { save.disabled = !event.target.value.trim(); };
      save.onclick = () => {
        const testers = group.isInternalGroup ? users.filter(user => [...mask.querySelectorAll("[data-user]:checked")].some(input => input.dataset.user === user.id)) : mask.querySelector("textarea").value.split(/[\s,;，；]+/).filter(Boolean).map(email => ({ email }));
        commit(mask, () => request("addTesters", { groupId, testers }), async () => { await navigate("group", { groupId }); notice("测试员已添加。"); });
      };
    }
    async function addGroupBuilds(groupId) {
      const mask = modal("添加构建版本", loading, '<button type="button" class="tf-button primary" data-save disabled>添加</button>');
      try {
        const overview = await request("overview"); if (!mask.isConnected) return;
        const versions = overview.versions.items;
        mask.querySelector(".tf-modal-body").innerHTML = `<label>版本<select name="version">${versions.map(row => `<option value="${escape(row.id)}">${escape(row.version)}</option>`).join("")}</select></label><div data-build-picker>${loading}</div><div class="tf-modal-error"></div>`;
        const select = mask.querySelector("select"); let seq = 0, next = "", builds = [];
        const load = async more => {
          const requestSeq = ++seq;
          try {
            const data = await request("builds", { versionId: select.value, next: more ? next : "" }); if (!mask.isConnected || requestSeq !== seq) return;
            next = data.next; builds = more ? [...builds, ...data.items] : data.items;
            mask.querySelector("[data-build-picker]").innerHTML = builds.map(build => `<label class="tf-check"><input type="checkbox" data-build-choice="${escape(build.id)}" ${build.expired || build.processingState !== "VALID" || build.groups.some(row => row.id === groupId) ? "disabled" : ""}><span>${escape(build.version)} · ${escape(buildStatus(build).text)}</span></label>`).join("") + (next ? '<button type="button" class="tf-link" data-more>载入更多</button>' : "");
            mask.querySelector("[data-more]")?.addEventListener("click", () => load(true));
            mask.querySelectorAll("[data-build-choice]").forEach(node => node.onchange = () => { mask.querySelector("[data-save]").disabled = !mask.querySelector("[data-build-choice]:checked"); });
          } catch (error) { if (mask.isConnected) mask.querySelector(".tf-modal-error").textContent = error.message; }
        };
        select.onchange = () => load(false);
        if (versions.length) await load(false); else mask.querySelector("[data-build-picker]").innerHTML = empty("暂无构建版本。");
        mask.querySelector("[data-save]").onclick = () => commit(mask, () => request("addGroupBuilds", { groupId, buildIds: [...mask.querySelectorAll("[data-build-choice]:checked")].map(node => node.dataset.buildChoice) }), () => navigate("group", { groupId, tab: "builds" }));
      } catch (error) { if (mask.isConnected) mask.querySelector(".tf-modal-body").innerHTML = `<div class="tf-modal-error">${escape(error.message)}</div>`; }
    }
    function buildDetail(build) {
      state.build = build;
      const locale = state.args.locale || build.localizations[0]?.locale || app.primaryLocale || "zh-Hans";
      const local = build.localizations.find(row => row.locale === locale) || {};
      const metadata = state.args.tab === "metadata";
      main.innerHTML = `${link("back-builds", `‹ ${platforms[state.platform]} 构建版本`)}<div class="tf-heading-row"><h1>${escape(build.preReleaseVersion?.version || "")} (${escape(build.version)})</h1>${statusHTML(build)}</div><div class="tf-subtabs">${link("build-tab", "测试信息", `data-tab="info" class="${metadata ? "" : "active"}"`)}${link("build-tab", "构建版本元数据", `data-tab="metadata" class="${metadata ? "active" : ""}"`)}</div>
        ${metadata ? `<h2>构建版本详情</h2><dl class="tf-metadata">${[["版本", build.preReleaseVersion?.version], ["构建版本", build.version], ["上传日期", date(build.uploadedDate)], ["到期日期", date(build.expirationDate)], ["最低系统版本", build.minOsVersion], ["处理状态", build.processingState], ["支持的设备", (build.deviceFamilies || []).join("、")], ["使用非豁免加密", build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined ? "未提供" : build.usesNonExemptEncryption ? "是" : "否"]].map(([label, value]) => `<dt>${label}</dt><dd>${escape(value || "—")}</dd>`).join("")}</dl>` : `<form class="tf-form" data-build-form><div class="tf-heading-row"><h2>测试内容</h2><span>${localeSelect(locale, build.localizations.map(row => row.locale))} <button class="tf-button primary" type="submit" disabled>保存</button></span></div><p>让测试员知道你希望他们在此构建版本中测试哪些内容。</p><textarea name="whatsNew" rows="7" maxlength="4000" aria-label="测试内容">${escape(local.whatsNew || "")}</textarea><div class="tf-form-message" role="status"></div></form><section class="tf-detail-section"><h2>群组</h2>${build.groups.length ? build.groups.map(row => `<p>${link("group", escape(row.name || row.id), `data-id="${escape(row.id)}"`)}</p>`).join("") : empty("此构建版本尚未添加到任何测试群组。")}</section>`}`;
      const form = main.querySelector("[data-build-form]");
      if (form) {
        form.elements.locale.onchange = () => { const next = form.elements.locale.value; form.elements.locale.value = locale; guard(() => { state.args.locale = next; buildDetail(build); }); };
        form.elements.whatsNew.oninput = () => { state.dirty = true; form.querySelector('[type="submit"]').disabled = false; };
        form.onsubmit = async event => {
          event.preventDefault(); const button = form.querySelector('[type="submit"]'); if (button.disabled) return;
          const text = form.elements.whatsNew.value; button.disabled = true; form.elements.whatsNew.disabled = true; form.elements.locale.disabled = true;
          try { await request("saveBuildInfo", { buildId: build.id, localizationId: local.id, locale, whatsNew: text }); if (form.isConnected) { state.dirty = false; Object.assign(local, { locale, whatsNew: text }); if (!build.localizations.includes(local)) build.localizations.push(local); notice("测试内容保存成功。"); } }
          catch (error) { if (form.isConnected) { form.querySelector(".tf-form-message").textContent = error.message; button.disabled = false; } }
          finally { if (form.isConnected) { form.elements.whatsNew.disabled = false; form.elements.locale.disabled = false; } }
        };
      }
    }
    async function encryption(buildId) {
      const mask = modal("App 加密文稿", '<p>你的 App 采用了哪种类型的加密算法？</p><div class="tf-encryption-options">' + [["standard", "专有或未被国际标准化组织（IEEE、IETF、ITU 等）视为标准的加密算法。"], ["apple", "代替在 Apple 操作系统中使用或访问加密，或与这些操作同时使用的标准加密算法。"], ["both", "兼用上述的两种算法"], ["none", "不属于上述的任意一种算法"]].map(([value, text]) => `<label class="tf-check"><input type="radio" name="encryption" value="${value}">${text}</label>`).join("") + '</div><p class="tf-muted">请按 App 实际使用的加密类型填写。Apple 将根据你的答案确定是否需要进一步提供文稿。</p>', '<button class="tf-button primary" data-save type="button" disabled>保存</button>');
      const save = mask.querySelector("[data-save]"); mask.querySelectorAll("input").forEach(node => node.onchange = () => { save.disabled = false; });
      save.onclick = () => commit(mask, () => request("saveEncryption", { buildId, usesNonExemptEncryption: mask.querySelector("input:checked").value !== "none" }), async () => {
        state.buildPages.clear(); state.metrics.delete(buildId);
        if (state.view === "build") await navigate("build", { buildId }); else await overview();
        notice("出口合规答案已保存。构建状态以 Apple 最新反馈为准。");
      });
    }
    async function navigate(view, args = {}) {
      const seq = ++state.navSeq; state.view = view; state.args = args; state.dirty = false; sidebar(); main.scrollTop = 0; main.innerHTML = loading;
      if (view === "builds") { drawBuilds(); ensureBuildLists(); return; }
      if (!["info", "build", "testers", "group", "crash", "screenshot"].includes(view)) {
        main.innerHTML = '<section class="tf-development" role="status"><span aria-hidden="true">⌘</span><h1>正在开发</h1><p>此功能暂未开放，敬请期待。</p></section>';
        return;
      }
      try {
        if (view === "info") { const data = await request("info"); if (live() && seq === state.navSeq) infoForm(data); }
        else if (view === "build") { const data = await request("build", { buildId: args.buildId }); if (live() && seq === state.navSeq) buildDetail(data); }
        else if (view === "testers" || view === "group") {
          const group = state.groups.find(row => row.id === args.groupId);
          const data = await request(view === "group" && args.tab === "builds" ? "builds" : "testers", args);
          if (!live() || seq !== state.navSeq) return;
          state.listData = data;
          main.innerHTML = `<div class="tf-heading-row"><h1>${escape(group?.name || "所有测试员")}</h1>${group ? link("edit-group", "编辑", `data-id="${escape(group.id)}"`) : ""}</div>${group ? `<p class="tf-muted">${group.isInternalGroup ? "内部测试" : "外部测试"}${group.hasAccessToAllBuilds ? " · 自动分发构建版本" : ""}</p><div class="tf-subtabs">${link("group-tab", "测试员", 'data-tab="testers"')}${link("group-tab", "构建版本", 'data-tab="builds"')}</div>` : ""}${args.tab === "builds" ? `${link("add-builds", "添加构建版本", `data-id="${escape(args.groupId)}"`)}${data.items.length ? buildRows(data.items) : empty("此群组暂无构建版本。")}${data.next ? link("more-group-builds", "载入更多") : ""}` : testersHTML(data, args.groupId)}`;
          wireTesterSearch(); if (args.tab === "builds") loadMetrics(data.items);
        } else if (view === "crash" || view === "screenshot") {
          const data = await request("feedback", { kind: view }); if (!live() || seq !== state.navSeq) return;
          state.listData = data; drawFeedback();
        }
      } catch (error) { if (live() && seq === state.navSeq) main.innerHTML = errorHTML(error.message); }
    }
    function drawFeedback() {
      const data = state.listData;
      main.innerHTML = `<h1>${state.view === "crash" ? "崩溃反馈" : "截屏反馈"}</h1><p class="tf-muted">测试员通过 TestFlight 提交的反馈。</p>${data.items.length ? `<table class="tf-table"><thead><tr><th>测试员</th><th>构建版本</th><th>设备</th><th>日期</th><th>反馈</th></tr></thead><tbody>${data.items.map(row => `<tr><td>${escape(row.tester?.email || row.email || "匿名测试员")}</td><td>${escape(row.build?.version || "—")}</td><td>${escape(row.deviceModel || row.devicePlatform || "—")}</td><td>${date(row.createdDate)}</td><td>${link("feedback-detail", escape(row.comment || "查看详情"), `data-id="${escape(row.id)}"`)}</td></tr>`).join("")}</tbody></table>` : empty("暂无反馈。")}${data.next ? link("more-feedback", "载入更多反馈") : ""}`;
    }
    function guard(work) {
      if (!state.dirty) return work();
      const mask = modal("更改尚未保存", "<p>离开此页面会丢弃尚未保存的更改。</p>", '<button type="button" class="tf-button primary" data-leave>离开</button>');
      mask.querySelector("[data-leave]").onclick = () => { mask.remove(); state.dirty = false; work(); };
    }
    host.addEventListener("change", event => {
      const filter = event.target.closest(".tf-upload-filter"); if (!filter) return;
      if (event.target.matches("[data-upload-all]")) filter.querySelectorAll("[data-upload-state]").forEach(input => { input.checked = event.target.checked; });
      syncUploadFilter(filter);
    });
    host.addEventListener("keydown", event => {
      if (event.key === "Escape") { const filter = main.querySelector(".tf-upload-filter[open]"); if (filter) { filter.open = false; filter.querySelector("summary").focus(); } }
    });
    host.addEventListener("click", async event => {
      const filter = main.querySelector(".tf-upload-filter[open]");
      if (filter && !filter.contains(event.target)) filter.open = false;
      const button = event.target.closest("[data-tf-action]"); if (!button || button.disabled || !host.contains(button)) return;
      const action = button.dataset.tfAction, itemId = button.dataset.id;
      try {
        if (action === "distribution") guard(options.onDistribution);
        else if (action === "switch") guard(options.onSwitch);
        else if (action === "analytics") notice("分析功能正在开发");
        else if (action === "docs") options.openExternal(docs);
        else if (action === "nav") guard(() => navigate(button.dataset.view));
        else if (action === "platform") guard(() => { ++state.navSeq; state.view = "builds"; state.args = {}; state.platform = button.dataset.platform; state.buildPages.clear(); state.openVersions.clear(); state.uploadStates = [...defaultUploadStates]; state.uploadSort = "-uploadedDate"; resetUploads(); sidebar(); overview(); });
        else if (action === "toggle-version") { state.openVersions.has(itemId) ? state.openVersions.delete(itemId) : state.openVersions.add(itemId); drawBuilds(); if (state.openVersions.has(itemId) && !state.buildPages.has(itemId)) loadBuilds(itemId); }
        else if (action === "toggle-uploads") { state.uploadsOpen = !state.uploadsOpen; drawBuilds(); if (state.uploadsOpen && !state.uploads) loadUploads(); }
        else if (action === "more-uploads") { button.disabled = true; await loadUploads(true); }
        else if (action === "retry-uploads") await loadUploads(Boolean(state.uploads?.items?.length && state.uploads?.next));
        else if (action === "sort-uploads") { state.uploadSort = state.uploadSort === "-uploadedDate" ? "uploadedDate" : "-uploadedDate"; resetUploads(); await loadUploads(); }
        else if (action === "apply-upload-filter" || action === "clear-upload-filter") {
          const selected = action === "clear-upload-filter" ? [...defaultUploadStates] : [...button.closest(".tf-upload-filter").querySelectorAll("[data-upload-state]:checked")].map(input => input.value);
          if (!selected.length) return;
          const menu = main.querySelector(".tf-upload-filter"); if (menu) menu.open = false;
          state.uploadStates = selected; resetUploads(); await loadUploads();
        }
        else if (action === "more-versions") { button.disabled = true; await overview(true); }
        else if (action === "more-builds") { button.disabled = true; await loadBuilds(itemId, true); }
        else if (action === "sort-builds") { const versionId = button.closest("[data-version-id]")?.dataset.versionId; if (versionId) { state.sorts.set(versionId, state.sorts.get(versionId) === "version" ? "-version" : "version"); state.buildPages.delete(versionId); drawBuilds(); loadBuilds(versionId); } else notice("群组构建排序功能正在开发"); }
        else if (action === "build") guard(() => navigate("build", { buildId: itemId }));
        else if (action === "back-builds") guard(() => navigate("builds"));
        else if (action === "build-tab") guard(() => { state.args.tab = button.dataset.tab; buildDetail(state.build); });
        else if (action === "create-group") guard(() => createGroup(button.dataset.internal !== "false"));
        else if (action === "edit-group") createGroup(true, state.groups.find(row => row.id === itemId));
        else if (action === "group") guard(() => navigate("group", { groupId: itemId }));
        else if (action === "group-tab") navigate("group", { ...state.args, tab: button.dataset.tab });
        else if (action === "add-testers") await addTesters(itemId);
        else if (action === "add-builds") await addGroupBuilds(itemId);
        else if (action === "encryption") guard(() => encryption(itemId));
        else if (action === "more-testers" || action === "more-group-builds" || action === "more-feedback") {
          button.disabled = true; const seq = state.navSeq;
          const data = await request(action === "more-feedback" ? "feedback" : action === "more-group-builds" ? "builds" : "testers", { ...state.args, kind: state.view, next: state.listData.next });
          if (!live() || seq !== state.navSeq) return;
          state.listData = { ...data, items: [...state.listData.items, ...data.items] };
          if (action === "more-feedback") drawFeedback();
          else { const table = button.previousElementSibling; const holder = document.createElement("div"); holder.innerHTML = action === "more-group-builds" ? buildRows(data.items) : testersHTML(data); const tbody = main.querySelector("tbody"); if (tbody) tbody.insertAdjacentHTML("beforeend", holder.querySelector("tbody")?.innerHTML || ""); button.disabled = false; button.hidden = !data.next; }
        } else if (action === "retry") { if (state.view === "builds") { state.buildPages.clear(); resetUploads(); await overview(); } else await navigate(state.view, state.args); }
        else if (action === "upload-detail") {
          const row = state.uploads?.items.find(item => item.id === itemId); if (!row) return;
          const sections = Object.entries({ errors: "错误", warnings: "警告", infos: "信息" }).filter(([key]) => row.state?.[key]?.length);
          const messages = sections.map(([key, label], index) => `<details class="tf-upload-messages" ${index === 0 ? "open" : ""}><summary>${label} (${row.state[key].length})</summary>${row.state[key].map(message => `<p>${typeof message === "string" ? escape(message) : `${message.code ? `<strong>${escape(message.code)}: </strong>` : ""}${escape(message.description || message.detail || message.message || "")}`}</p>`).join("")}</details>`).join("");
          const mask = modal(`构建版本上传 ${row.cfBundleShortVersionString || "–"} (${row.cfBundleVersion || "–"})`, messages || "<p>Apple 未返回错误或警告。</p>", '<button class="tf-button primary" type="button" data-done>完成</button>');
          mask.querySelector("[data-close]").remove(); mask.querySelector("[data-done]").onclick = () => mask.remove();
        } else if (action === "feedback-detail") {
          const row = state.listData?.items.find(item => item.id === itemId); if (!row) return;
          modal("测试员反馈", `<p class="tf-prewrap">${escape(row.comment || "无文字反馈")}</p><dl class="tf-metadata"><dt>日期</dt><dd>${date(row.createdDate)}</dd><dt>设备</dt><dd>${escape(row.deviceModel || "—")}</dd><dt>系统</dt><dd>${escape(row.osVersion || "—")}</dd></dl>${(row.screenshots || []).map(item => safeURL(item.url || item.asset?.url) ? `<img class="tf-feedback-image" src="${escape(safeURL(item.url || item.asset?.url))}" alt="测试员提交的截屏">` : "").join("")}`);
        } else if (action === "about") modal("关于 TestFlight 数据", "<p>邀请、安装、App 使用次数、崩溃和反馈指标由 Apple 提供，可能延迟更新。没有可用数据时显示“–”。构建版本自上传之日起最多可供测试 90 天，实际有效期以 Apple 返回的到期时间为准。</p>");
        else notice("该功能正在开发");
      } catch (error) { if (live()) { button.disabled = false; notice(error.message); } }
    });
    host.tfRefresh = () => guard(() => { state.buildPages.clear(); resetUploads(); state.metrics.clear(); state.view === "builds" ? overview() : navigate(state.view, state.args); });
    sidebar(); side.inert = true; overview();
  }
  const api = { shell, mount, buildStatus };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MayouTestFlight = api;
})(typeof window === "object" ? window : globalThis);
