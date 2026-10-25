// Requests follow the TestFlight pages captured in the user's HAR files.
// The caller supplies the active account's session; this module has no credentials.
const ORIGIN = "https://appstoreconnect.apple.com";
const rows = body => Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
const refs = (row, key) => { const data = row?.relationships?.[key]?.data; return Array.isArray(data) ? data : data ? [data] : []; };
const included = (body, type, id) => (body?.included || []).find(row => row.type === type && row.id === id);
const entity = row => row ? { id: row.id, ...row.attributes } : null;
const id = value => {
  const text = String(value || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(text)) throw new Error("缺少有效的 Apple 资源 ID，请刷新后重试");
  return encodeURIComponent(text);
};
function query(path, params) {
  return `/iris/v1/${path}?${new URLSearchParams(Object.entries(params).filter(([key, value]) => value !== undefined && (value !== "" || key.startsWith("fields[")))).toString()}`;
}
function pagePath(base, next) {
  if (!next) return base;
  const expected = new URL(base, ORIGIN), actual = new URL(next, ORIGIN);
  if (actual.origin !== ORIGIN || actual.pathname !== expected.pathname || actual.username || actual.password) throw new Error("Apple 分页地址无效");
  for (const [key, value] of expected.searchParams) {
    const normalize = text => text && (key === "include" || key.startsWith("fields[") || key.startsWith("filter[")) ? text.split(",").sort().join(",") : text;
    if (key !== "cursor" && normalize(actual.searchParams.get(key)) !== normalize(value)) throw new Error("Apple 分页参数与当前 App 不匹配");
  }
  return actual.pathname + actual.search;
}
function page(body, map = entity) {
  return { items: rows(body).map(map), next: body?.links?.next || "", total: body?.meta?.paging?.total ?? rows(body).length };
}
function assetURL(asset) {
  const url = String(asset?.templateUrl || asset?.url || "").replace(/\{w\}/g, "80").replace(/\{h\}/g, "80").replace(/\{f\}/g, "png");
  try { const parsed = new URL(url); return parsed.protocol === "https:" && /(^|\.)mzstatic\.com$/.test(parsed.hostname) ? url : ""; } catch { return ""; }
}
function normalizeBuild(row, body) {
  const related = (key, type) => included(body, type, refs(row, key)[0]?.id);
  return {
    ...entity(row),
    preReleaseVersion: entity(related("preReleaseVersion", "preReleaseVersions")),
    betaDetail: entity(related("buildBetaDetail", "buildBetaDetails")),
    betaReview: entity(related("betaAppReviewSubmission", "betaAppReviewSubmissions")),
    iconUrl: assetURL(row.attributes?.iconAssetToken) || assetURL(related("icons", "buildIcons")?.attributes?.iconAsset),
    localizations: refs(row, "betaBuildLocalizations").map(ref => entity(included(body, "betaBuildLocalizations", ref.id))).filter(Boolean),
    groups: refs(row, "betaGroups").map(ref => entity(included(body, "betaGroups", ref.id)) || { id: ref.id }),
    bundles: refs(row, "buildBundles").map(ref => entity(included(body, "buildBundles", ref.id))).filter(Boolean),
  };
}
const BUILD_INCLUDE = "app,preReleaseVersion,buildBetaDetail,betaAppReviewSubmission,betaBuildLocalizations,icons,buildBundles,betaGroups";
function createTestFlightService(fetch) {
  const get = async path => {
    const body = (await fetch(path)).body;
    if (!body || !Object.prototype.hasOwnProperty.call(body, "data")) throw new Error("Apple 未返回有效的 TestFlight 数据，请稍后重试");
    return body;
  };
  const write = async (path, method, data) => (await fetch(`/iris/v1/${path}`, { method, body: JSON.stringify({ data }) })).body;
  const belongs = async (type, resourceId, appId, extra = "") => {
    const body = await get(query(`${type}/${id(resourceId)}`, { include: extra || "app" }));
    const row = rows(body)[0];
    if (row?.id !== String(resourceId) || !refs(row, "app").some(ref => ref.id === String(appId))) throw new Error("所选 TestFlight 内容与当前 App 不匹配，请刷新后重试");
    return { row, body };
  };
  const groupRows = async appId => {
    let path = query("betaGroups", { "filter[app]": appId, sort: "name", limit: 200 });
    const result = [];
    for (let count = 0; path && count < 50; count++) {
      const body = await get(path); result.push(...rows(body));
      path = body.links?.next ? pagePath(query("betaGroups", { "filter[app]": appId, sort: "name", limit: 200 }), body.links.next) : "";
    }
    if (path) throw new Error("群组数量过多，请在 Apple 官网查看完整列表");
    return result;
  };
  const group = async (appId, groupId) => {
    const row = (await groupRows(appId)).find(row => row.id === groupId);
    if (!row) throw new Error("群组不属于当前 App，请刷新后重试");
    return row;
  };
  const api = {
    async overview(p) {
      const path = query("preReleaseVersions", { "filter[app]": p.appId, "filter[platform]": p.platform, sort: "-version", limit: 25 });
      const results = await Promise.allSettled([get(pagePath(path, p.next)), groupRows(p.appId)]);
      if (results[0].status === "rejected") throw results[0].reason;
      return { versions: page(results[0].value), groups: results[1].status === "fulfilled" ? results[1].value.map(entity) : [], groupsError: results[1].status === "rejected" ? results[1].reason.message : "" };
    },
    async builds(p) {
      const params = { "filter[app]": p.appId, sort: p.sort === "version" ? "version" : "-version", limit: 10, include: BUILD_INCLUDE, "limit[betaBuildLocalizations]": 50, "limit[betaGroups]": 200 };
      if (p.groupId) { await group(p.appId, p.groupId); params["filter[betaGroups]"] = p.groupId; }
      else params["filter[preReleaseVersion]"] = id(p.versionId);
      const body = await get(pagePath(query("builds", params), p.next));
      return page(body, row => normalizeBuild(row, body));
    },
    async build(p) {
      const { row, body } = await belongs("builds", p.buildId, p.appId, BUILD_INCLUDE);
      return normalizeBuild(row, body);
    },
    async metrics(p) {
      const build = await api.build(p);
      const bundleIds = build.bundles.length > 1 ? build.bundles.map(row => row.bundleId).filter(Boolean).join(",") : "";
      const body = await get(query(`builds/${id(p.buildId)}/metrics/betaBuildUsages`, { "filter[bundleIds]": bundleIds }));
      return rows(body).map(entity);
    },
    async uploads(p) {
      const states = p.states === undefined ? ["PROCESSING", "FAILED", "COMPLETE"] : p.states;
      if (!Array.isArray(states) || !states.length || states.some(state => !["PROCESSING", "FAILED", "COMPLETE"].includes(state))) throw new Error("请选择有效的上传状态");
      const sort = p.sort || "-uploadedDate";
      if (!["uploadedDate", "-uploadedDate"].includes(sort)) throw new Error("上传日期排序无效");
      const body = await get(pagePath(query(`apps/${id(p.appId)}/buildUploads`, { include: "build", "fields[builds]": "", "filter[platform]": p.platform, "filter[state]": [...new Set(states)].join(","), sort, limit: 10 }), p.next));
      if (!Array.isArray(body.data)) throw new Error("Apple 未返回有效的上传记录列表，请重试");
      return page(body, row => ({ ...entity(row), buildId: refs(row, "build")[0]?.id || "" }));
    },
    async testers(p) {
      if (p.groupId) await group(p.appId, p.groupId);
      const params = { "filter[apps]": p.appId, "filter[betaGroups]": p.groupId || "", "filter[$search]": String(p.search || "").trim(), sort: ["email", "-email", "state", "-state"].includes(p.sort) ? p.sort : "state", limit: 50 };
      return page(await get(pagePath(query("betaTesters", params), p.next)));
    },
    async internalUsers(p) {
      return page(await get(pagePath(query("users", { "filter[visibleApps]": p.appId, "fields[users]": "email,firstName,lastName,roles", "filter[$search]": String(p.search || "").trim(), sort: "email", limit: 50 }), p.next)));
    },
    async createGroup(p) {
      const name = String(p.name || "").trim();
      if (!name || name.length > 100) throw new Error("请输入不超过 100 个字符的群组名称");
      const body = await write("betaGroups", "POST", { type: "betaGroups", attributes: { name, isInternalGroup: p.internal !== false, hasAccessToAllBuilds: p.internal !== false && p.automatic === true }, relationships: { app: { data: { type: "apps", id: p.appId } } } });
      if (!body.data?.id) throw new Error("Apple 已响应，但未返回群组 ID，请刷新群组列表确认");
      return entity(body.data);
    },
    async saveGroup(p) {
      const current = await group(p.appId, p.groupId);
      const name = String(p.name || "").trim();
      if (!name || name.length > 100) throw new Error("请输入有效的群组名称");
      return entity((await write(`betaGroups/${id(p.groupId)}`, "PATCH", { type: "betaGroups", id: p.groupId, attributes: { name, ...(current.attributes?.isInternalGroup ? { hasAccessToAllBuilds: p.automatic === true } : {}) } })).data);
    },
    async addGroupBuilds(p) {
      await group(p.appId, p.groupId);
      const ids = [...new Set(p.buildIds || [])];
      if (!ids.length || ids.length > 100) throw new Error("请选择构建版本");
      for (const buildId of ids) await belongs("builds", buildId, p.appId);
      await write(`betaGroups/${id(p.groupId)}/relationships/builds`, "POST", ids.map(buildId => ({ type: "builds", id: buildId })));
      return { saved: true };
    },
    async addTesters(p) {
      const target = await group(p.appId, p.groupId);
      const testers = (p.testers || []).map(row => ({ id: null, email: String(row.email || "").trim(), firstName: String(row.firstName || ""), lastName: String(row.lastName || ""), assignmentResult: null, errors: [] }));
      if (!testers.length || testers.length > 100 || testers.some(row => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))) throw new Error("请选择测试员或输入有效的电子邮件地址（最多 100 位）");
      if (target.attributes?.isInternalGroup) {
        let next = "", users = [];
        do { const result = await api.internalUsers({ ...p, next }); users.push(...result.items); next = result.next; } while (next && users.length < 2000);
        if (testers.some(tester => !users.some(user => user.email?.toLowerCase() === tester.email.toLowerCase()))) throw new Error("内部测试员必须是可访问此 App 的 App Store Connect 用户");
      }
      const body = await write("bulkBetaTesterAssignments", "POST", { type: "bulkBetaTesterAssignments", attributes: { betaTesters: testers }, relationships: { betaGroup: { data: { type: "betaGroups", id: p.groupId } } } });
      const assignments = body.data?.attributes?.betaTesters;
      if (!Array.isArray(assignments)) throw new Error("Apple 未返回测试员添加结果，请刷新列表确认");
      const failures = assignments.filter(row => row.errors?.length || /FAIL|ERROR/.test(row.assignmentResult || ""));
      if (failures.length) throw new Error(failures.map(row => `${row.email}：${row.errors?.map(error => error.detail || error.message || error.code).join("；") || row.assignmentResult}`).join("\n"));
      return { saved: true };
    },
    async feedback(p) {
      const type = p.kind === "crash" ? "betaFeedbackCrashSubmissions" : "betaFeedbackScreenshotSubmissions";
      const body = await get(pagePath(query(`apps/${id(p.appId)}/${type}`, { include: "tester,build", "fields[builds]": "version,preReleaseVersion,buildBundles", sort: "-createdDate", limit: p.kind === "crash" ? 100 : 60 }), p.next));
      return page(body, row => ({ ...entity(row), screenshots: (row.attributes?.sizedScreenshots || []).map(item => ({ url: item.fits1024?.url || item.original?.url || item.fits512?.url || "" })), tester: entity(included(body, "betaTesters", refs(row, "tester")[0]?.id)), build: entity(included(body, "builds", refs(row, "build")[0]?.id)) }));
    },
    async info(p) {
      const names = ["betaAppLocalizations", "betaAppReviewDetails", "betaLicenseAgreements"];
      const results = await Promise.allSettled(names.map(type => get(query(type, { "filter[app]": p.appId, limit: type === names[0] ? 50 : 1 }))));
      const result = { errors: [] };
      results.forEach((entry, index) => {
        if (entry.status === "fulfilled") result[names[index]] = rows(entry.value).map(entity);
        else { result[names[index]] = []; result.errors.push(entry.reason.message); }
      });
      return result;
    },
    async saveInfo(p) {
      const current = await api.info(p);
      if (current.errors.length) throw new Error(current.errors.join("；"));
      const local = p.localization;
      if (local) {
        const previous = current.betaAppLocalizations.find(row => row.locale === local.locale);
        if (local.id && previous?.id !== local.id) throw new Error("测试信息语言已变化，请刷新后重试");
        const attributes = Object.fromEntries(["description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl"].filter(key => local[key] !== undefined && String(local[key]) !== String(previous?.[key] || "")).map(key => [key, String(local[key])]));
        if (Object.keys(attributes).length) {
          if (previous) await write(`betaAppLocalizations/${id(previous.id)}`, "PATCH", { type: "betaAppLocalizations", id: previous.id, attributes });
          else {
            if (!local.locale) throw new Error("请选择语言");
            await write("betaAppLocalizations", "POST", { type: "betaAppLocalizations", attributes: { ...attributes, locale: local.locale }, relationships: { app: { data: { type: "apps", id: p.appId } } } });
          }
        }
      }
      if (p.review) {
        const previous = current.betaAppReviewDetails[0];
        if (!previous?.id || p.review.id !== previous.id) throw new Error("测试审核信息未读取成功，请刷新后重试");
        const allowed = ["contactFirstName", "contactLastName", "contactPhone", "contactEmail", "demoAccountName", "demoAccountPassword", "demoAccountRequired", "notes"];
        const attributes = Object.fromEntries(allowed.filter(key => p.review[key] !== undefined && p.review[key] !== previous[key]).map(key => [key, p.review[key]]));
        if (Object.keys(attributes).length) await write(`betaAppReviewDetails/${id(previous.id)}`, "PATCH", { type: "betaAppReviewDetails", id: previous.id, attributes });
      }
      return { saved: true };
    },
    async saveBuildInfo(p) {
      const build = await api.build(p);
      const previous = build.localizations.find(row => row.locale === p.locale);
      if (p.localizationId && previous?.id !== p.localizationId) throw new Error("所选构建语言不匹配");
      const whatsNew = String(p.whatsNew || "");
      if (whatsNew.length > 4000 || !p.locale) throw new Error("请选择语言，测试内容最多 4000 个字符");
      if (previous) await write(`betaBuildLocalizations/${id(previous.id)}`, "PATCH", { type: "betaBuildLocalizations", id: previous.id, attributes: { whatsNew } });
      else await write("betaBuildLocalizations", "POST", { type: "betaBuildLocalizations", attributes: { locale: p.locale, whatsNew }, relationships: { build: { data: { type: "builds", id: p.buildId } } } });
      return { saved: true };
    },
    async saveEncryption(p) {
      await belongs("builds", p.buildId, p.appId);
      if (typeof p.usesNonExemptEncryption !== "boolean") throw new Error("请选择加密算法类型");
      await write(`builds/${id(p.buildId)}`, "PATCH", { type: "builds", id: p.buildId, attributes: { usesNonExemptEncryption: p.usesNonExemptEncryption } });
      return { saved: true };
    },
  };
  return { async run(action, payload = {}) {
    if (!Object.prototype.hasOwnProperty.call(api, action)) throw new Error("不支持的 TestFlight 操作");
    const p = { ...payload, appId: String(payload.appId || ""), platform: payload.platform || "IOS" };
    id(p.appId);
    if (!["IOS", "MAC_OS", "TV_OS", "VISION_OS"].includes(p.platform)) throw new Error("不支持的平台");
    return api[action](p);
  } };
}
module.exports = { createTestFlightService, normalizeBuild, pagePath, assetURL };
