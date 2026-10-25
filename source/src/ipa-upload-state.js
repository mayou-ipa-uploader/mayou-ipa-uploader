"use strict";

const yauzl = require("yauzl");
const binaryPlist = require("bplist-parser");
const xmlPlist = require("plist");

const MAIN_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/;
const MAX_PLIST_BYTES = 4 * 1024 * 1024;

// Read the identity needed to correlate Apple's receipt. Apple validates the
// main app and embedded frameworks; local version-format rules are disabled.
async function inspectIPA(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(new Error(`IPA 无法读取：${error.message}`));
      let metadata = null;
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", entry => {
        if (!MAIN_PLIST.test(entry.fileName)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > MAX_PLIST_BYTES) {
          fail(new Error(`IPA 内的 ${entry.fileName} 过大，无法安全读取`));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_PLIST_BYTES) {
              stream.destroy(new Error(`IPA 内的 ${entry.fileName} 超出读取上限`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            if (finished) return;
            try {
              const data = Buffer.concat(chunks);
              const info = data.subarray(0, 8).toString() === "bplist00"
                ? binaryPlist.parseBuffer(data)[0]
                : xmlPlist.parse(data.toString("utf8"));
              if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error("不是标准属性字典");
              const version = info.CFBundleShortVersionString;
              if (MAIN_PLIST.test(entry.fileName)) {
                if (metadata) throw new Error("IPA 含有多个主 App，无法确定上传目标");
                const platformName = String(info.DTPlatformName || info.CFBundleSupportedPlatforms?.[0] || "iphoneos").toLowerCase();
                metadata = {
                  bundleId: String(info.CFBundleIdentifier || "").trim(),
                  version: String(version || "").trim(),
                  build: String(info.CFBundleVersion || "").trim(),
                  name: String(info.CFBundleDisplayName || info.CFBundleName || "").trim(),
                  platform: /appletv/.test(platformName) ? "TV_OS" : /xros|vision/.test(platformName) ? "VISION_OS" : /macos/.test(platformName) ? "MAC_OS" : "IOS",
                };
              }
              zip.readEntry();
            } catch (error) { fail(new Error(`IPA 信息读取失败：${entry.fileName}：${error.message}`)); }
          });
        });
      });
      zip.on("end", () => {
        if (finished) return;
        finished = true;
        if (!metadata?.bundleId || !metadata.version || !metadata.build) {
          reject(new Error("IPA 主 App 缺少 Bundle ID、版本号或 Build，无法确认苹果处理的是否为本次上传的包"));
          return;
        }
        resolve(metadata);
      });
      zip.readEntry();
    });
  });
}

function hasAppleDeliveryConfirmation(events) {
  const text = events.map(event => String(event.message || "")).join("\n");
  if (/\b0 packages? (?:was|were) (?:uploaded successfully|successfully uploaded)\b|\bUPLOAD SUCCEEDED with 0 packages?\b/i.test(text)) return false;
  return /\b[1-9]\d* packages? (?:was|were) (?:uploaded successfully|successfully uploaded)\b|\bUPLOAD SUCCEEDED\b|\bNo errors uploading\b|\bdelivery succeeded\b/i.test(text);
}

function apiRows(body) {
  if (!Array.isArray(body?.data)) throw new Error("Apple 构建接口未返回有效列表，请重新登录后查询");
  return body.data;
}

function included(body, row, relationship) {
  const ref = row?.relationships?.[relationship]?.data;
  return (body.included || []).find(item => item.type === ref?.type && item.id === ref?.id);
}

function currentUploadDate(attributes, startedAt) {
  if (!startedAt) return true; // Explicitly querying a previously uploaded IPA.
  const date = Date.parse(attributes.uploadedDate || attributes.createdDate || "");
  return Number.isFinite(date) && date >= Date.parse(startedAt) - 5000;
}

function stateDetails(rows = []) {
  return (Array.isArray(rows) ? rows : []).map(row => [row.code, row.description || row.detail || row.message].filter(Boolean).join(": ")).filter(Boolean);
}

function buildState(row, body) {
  const attributes = row.attributes || {};
  const beta = included(body, row, "buildBetaDetail")?.attributes || {};
  const receipt = included(body, row, "buildUpload")?.attributes?.state || {};
  const processingState = String(attributes.processingState || "");
  const internalBuildState = String(beta.internalBuildState || "");
  const externalBuildState = String(beta.externalBuildState || "");
  const failed = ["FAILED", "INVALID"].includes(processingState) || internalBuildState === "PROCESSING_EXCEPTION";
  const betaProcessing = ["PROCESSING", "IN_EXPORT_COMPLIANCE_REVIEW"].includes(internalBuildState);
  return {
    phase: failed ? "failed" : processingState === "PROCESSING" || (processingState === "VALID" && betaProcessing) ? "processing" : processingState === "VALID" ? "valid" : "unknown",
    buildId: String(row.id || ""), processingState, internalBuildState, externalBuildState,
    expired: attributes.expired === true || internalBuildState === "EXPIRED",
    uploadedDate: String(attributes.uploadedDate || ""),
    errors: stateDetails(receipt.errors), warnings: stateDetails(receipt.warnings),
    source: "App Store Connect builds",
  };
}

function queryPath(resource, params) {
  return `${resource}?${new URLSearchParams(params)}`;
}

// The upload resource/state and beta-state fields follow Apple's OpenAPI
// schema. Iris is the authenticated web API already used by this app; when
// it does not expose upload receipts, builds remain the source of truth.
async function queryAppleBuildState({ metadata, startedAt, expectedBuildId, app: knownApp }, fetch) {
  let app = knownApp;
  if (!app) {
    const { body } = await fetch(queryPath("/iris/v1/apps", { "filter[bundleId]": metadata.bundleId, "fields[apps]": "name,bundleId", limit: "20" }));
    const matches = apiRows(body).filter(row => row.type === "apps" && row.attributes?.bundleId === metadata.bundleId);
    if (matches.length !== 1) {
      return { phase: "unknown", reason: `当前 App Store Connect 账号或团队未唯一匹配到 ${metadata.bundleId}。请确认登录账号、所属团队及正在查看的 App`, source: "App Store Connect apps", checkedAt: new Date().toISOString() };
    }
    app = { id: String(matches[0].id), name: String(matches[0].attributes.name || ""), bundleId: metadata.bundleId };
  }
  const buildPath = queryPath("/iris/v1/builds", {
    "filter[app]": app.id, "filter[version]": metadata.build,
    "filter[preReleaseVersion.version]": metadata.version, "filter[preReleaseVersion.platform]": metadata.platform,
    include: "preReleaseVersion,buildBetaDetail", sort: "-uploadedDate", limit: "100",
  });
  const uploadPath = queryPath(`/iris/v1/apps/${encodeURIComponent(app.id)}/buildUploads`, {
    "filter[cfBundleShortVersionString]": metadata.version, "filter[cfBundleVersion]": metadata.build,
    "filter[platform]": metadata.platform, include: "build", sort: "-uploadedDate", limit: "100",
  });
  const [buildResult, uploadResult] = await Promise.allSettled([fetch(buildPath), fetch(uploadPath)]);
  let build = null;
  let upload = null;
  let buildReadFailed = buildResult.status === "rejected";
  const queryWarnings = [];
  // Transporter returns the upload ID before Apple creates its build relationship.
  // Match that receipt directly so processing and validation errors remain visible.
  if (uploadResult.status === "fulfilled") {
    try { upload = apiRows(uploadResult.value.body).find(row => row.type === "buildUploads" && (!expectedBuildId || row.id === expectedBuildId || row.relationships?.build?.data?.id === expectedBuildId) && row.attributes?.cfBundleShortVersionString === metadata.version && row.attributes?.cfBundleVersion === metadata.build && row.attributes?.platform === metadata.platform && (expectedBuildId || currentUploadDate(row.attributes, startedAt))); }
    catch (error) { queryWarnings.push(error.message); }
  } else { queryWarnings.push(`上传处理记录查询失败：${uploadResult.reason?.message || "未知错误"}`); }
  const linkedBuildId = upload?.relationships?.build?.data?.id;
  if (buildResult.status === "fulfilled") {
    try { build = apiRows(buildResult.value.body).find(row => {
      const version = included(buildResult.value.body, row, "preReleaseVersion")?.attributes || {};
      const appRef = row.relationships?.app?.data;
      return row.type === "builds" && (!expectedBuildId || row.id === expectedBuildId || row.id === linkedBuildId) && (!appRef || appRef.id === app.id) && row.attributes?.version === metadata.build && version.version === metadata.version && version.platform === metadata.platform && (expectedBuildId || currentUploadDate(row.attributes, startedAt));
    }); } catch (error) { buildReadFailed = true; queryWarnings.push(error.message); }
  } else { queryWarnings.push(`构建查询失败：${buildResult.reason?.message || "未知错误"}`); }
  const uploadAttributes = upload?.attributes || {};
  const uploadState = typeof uploadAttributes.state === "object" ? uploadAttributes.state : { state: uploadAttributes.state };
  const receipt = { uploadId: String(upload?.id || ""), errors: stateDetails(uploadState.errors), warnings: stateDetails(uploadState.warnings) };
  let state;
  if (uploadState.state === "FAILED") {
    state = { phase: "failed", processingState: "FAILED", source: "App Store Connect buildUploads", ...receipt };
  } else if (build) {
    state = buildState(build, buildResult.value.body);
    if (upload) state = { ...state, ...receipt };
  } else if (["PROCESSING", "COMPLETE"].includes(uploadState.state)) {
    state = { phase: "processing", processingState: uploadState.state, source: "App Store Connect buildUploads", ...receipt };
  } else if (buildReadFailed && !upload) {
    state = { phase: "query_error", reason: queryWarnings.join("；") };
  } else {
    state = { phase: "waiting", reason: "苹果尚未返回对应版本和 Build 的构建；文件提交不等于处理通过。请等待后再次查询，并查看苹果处理邮件", ...receipt };
  }
  return { ...state, app, queryWarnings, checkedAt: new Date().toISOString() };
}

function uploadPresentation(task) {
  const state = task.appleState || {};
  if (task.status === "running") return { text: task.stage === "inspection" ? "正在读取 IPA 信息" : task.stage === "provider" ? "查询苹果上传团队" : "苹果校验及上传中", level: "info" };
  if (task.status === "validated") return { text: "IPA 信息已读取，尚未上传", level: "info" };
  if (task.status === "error") return task.uncertainOutcome ? { text: "上传结果未确认", level: "warning" } : { text: task.stage === "inspection" ? "IPA 信息读取失败" : task.stage === "provider" ? "上传准备失败" : "上传失败", level: "error" };
  if (state.phase === "failed") return { text: "苹果处理失败", level: "error" };
  if (state.phase === "valid") {
    if (state.expired) return { text: "构建已过期", level: "warning" };
    if (state.internalBuildState === "MISSING_EXPORT_COMPLIANCE" || (!state.internalBuildState && state.externalBuildState === "MISSING_EXPORT_COMPLIANCE")) return { text: "需补充出口合规", level: "warning" };
    if (state.internalBuildState === "IN_EXPORT_COMPLIANCE_REVIEW") return { text: "出口合规审核中", level: "warning" };
    if (["READY_FOR_BETA_TESTING", "IN_BETA_TESTING"].includes(state.internalBuildState)) return { text: "TestFlight 内部测试可用", level: "success" };
    return { text: "苹果处理完成", level: "success" };
  }
  if (state.phase === "query_error" || state.phase === "unknown" || task.monitorPaused) return { text: "处理结果未确认", level: "warning" };
  if (state.phase === "processing") return { text: state.internalBuildState === "IN_EXPORT_COMPLIANCE_REVIEW" ? "出口合规审核中" : "苹果处理中", level: state.internalBuildState === "IN_EXPORT_COMPLIANCE_REVIEW" ? "warning" : "info" };
  if (task.duplicateDelivery) return { text: "苹果提示文件已存在，待核对构建", level: "warning" };
  return { text: task.deliveryConfirmed ? "文件已提交，待苹果确认" : state.phase ? "未查到对应构建" : "正在查询苹果状态", level: "warning" };
}

module.exports = { inspectIPA, hasAppleDeliveryConfirmation, queryAppleBuildState, uploadPresentation };
