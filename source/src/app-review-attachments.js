const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pagePath } = require("./testflight-service");

const EXTENSIONS = ["pdf", "doc", "docx", "rtf", "pages", "xls", "xlsx", "numbers", "zip", "rar", "plist", "crash", "jpg", "png", "mp4", "avi"];
const resourceId = value => {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("缺少有效的 App 或版本 ID，请刷新后重试");
  return encodeURIComponent(id);
};
const rows = body => Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
function normalizeAttachment(row = {}) {
  const attrs = row.attributes || {};
  return { id: String(row.id || ""), fileName: String(attrs.fileName || "附件"), fileSize: Number(attrs.fileSize || 0), sourceFileChecksum: attrs.sourceFileChecksum || "", state: attrs.assetDeliveryState?.state || "", errors: attrs.assetDeliveryState?.errors || [] };
}

function createReviewAttachmentService({ fetch, upload, chooseFiles, signal, readFile = fs.readFile, stat = fs.stat, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const check = () => signal?.throwIfAborted();
  const request = async (url, options = {}) => {
    check();
    const result = await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    check();
    return result.body;
  };
  const write = (url, method, data) => request(url, { method, body: JSON.stringify({ data }) });
  async function context(p) {
    const appId = resourceId(p.appId), versionId = resourceId(p.versionId);
    const body = await request(`/iris/v1/appStoreVersions/${versionId}?include=app,appStoreReviewDetail`);
    const version = rows(body)[0];
    if (version?.id !== p.versionId || version?.relationships?.app?.data?.id !== decodeURIComponent(appId)) throw new Error("所选版本与当前 App 不匹配，请刷新后重试");
    const reviewId = version.relationships?.appStoreReviewDetail?.data?.id || "";
    if (p.reviewDetailId && p.reviewDetailId !== reviewId) throw new Error("审核信息与当前版本不匹配，请刷新后重试");
    return { version, reviewId };
  }
  async function list(reviewId) {
    if (!reviewId) return [];
    const base = `/iris/v1/appStoreReviewDetails/${resourceId(reviewId)}/appStoreReviewAttachments`;
    let url = base;
    const result = [];
    for (let count = 0; url && count < 50; count++) {
      const body = await request(url);
      if (!Array.isArray(body?.data)) throw new Error("Apple 未返回有效的附件列表，请重试");
      result.push(...body.data.map(normalizeAttachment));
      url = body.links?.next ? pagePath(base, body.links.next) : "";
    }
    if (url) throw new Error("附件过多，请到 Apple 官网查看");
    return result;
  }
  async function run(action, p) {
    let { version, reviewId } = await context(p);
    if (action === "list") return { reviewDetailId: reviewId, attachments: await list(reviewId) };
    if (!["upload", "delete"].includes(action)) throw new Error("不支持的附件操作");
    const assertEditable = row => {
      const state = String(row.attributes?.appStoreState || row.attributes?.appVersionState || "");
      if (!/^(DRAFT|PREPARE_FOR_SUBMISSION|READY_TO_SUBMIT|READY_FOR_REVIEW|MISSING_METADATA|REJECTED|DEVELOPER_REJECTED|DEVELOPER_ACTION_NEEDED|PENDING_DEVELOPER_ACTION|UNRESOLVED_ISSUES)$/.test(state)) throw new Error("当前版本不可编辑，无法修改审核附件");
    };
    assertEditable(version);
    if (action === "delete") {
      const attachmentId = resourceId(p.attachmentId);
      const attachments = await list(reviewId);
      if (!attachments.some(item => item.id === p.attachmentId)) throw new Error("该附件不属于当前版本，或已被删除，请刷新附件列表");
      await request(`/iris/v1/appStoreReviewAttachments/${attachmentId}`, { method: "DELETE" });
      // Do not repeat a deletion if its response or the following read is uncertain.
      try {
        const remaining = await list(reviewId);
        return { reviewDetailId: reviewId, attachments: remaining, deleted: !remaining.some(item => item.id === p.attachmentId), error: remaining.some(item => item.id === p.attachmentId) ? "Apple 尚未确认附件删除，请稍后刷新列表" : "" };
      } catch (error) {
        return { reviewDetailId: reviewId, error: `删除请求已发送，暂时无法确认附件列表：${error.message}。请刷新附件确认结果。` };
      }
    }
    const selection = await chooseFiles(EXTENSIONS);
    check();
    if (selection.canceled || !selection.filePaths?.length) return { canceled: true };
    if (selection.filePaths.length !== 1) throw new Error("审核附件最多上传 1 个，请只选择一个文件");
    // Validate every selected file before creating any Apple resources.
    const files = [];
    for (const filePath of selection.filePaths) {
      const info = await stat(filePath);
      if (!info.isFile() || !info.size) throw new Error("请选择非空的附件文件");
      if (!EXTENSIONS.includes(path.extname(filePath).slice(1).toLowerCase())) throw new Error(`不支持的附件格式：${path.basename(filePath)}`);
      files.push({ filePath, fileName: path.basename(filePath), size: info.size });
    }
    // Revalidate after the native file picker, which may remain open for minutes.
    ({ version, reviewId } = await context(p));
    assertEditable(version);
    if (!reviewId) {
      const body = await write("/iris/v1/appStoreReviewDetails", "POST", { type: "appStoreReviewDetails", attributes: {}, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: p.versionId } } } });
      reviewId = body?.data?.id;
      if (!reviewId) throw new Error("Apple 未返回审核信息 ID");
    }
    const attachments = await list(reviewId);
    let uploaded = 0;
    try {
      for (const file of files) {
        check();
        const buffer = await readFile(file.filePath);
        if (buffer.length !== file.size) throw new Error(`文件已发生变化，请重新选择：${file.fileName}`);
        const checksum = crypto.createHash("md5").update(buffer).digest("hex");
        if (attachments.some(item => item.state === "COMPLETE" && item.sourceFileChecksum === checksum && item.fileName === file.fileName)) continue;
        const pending = attachments.find(item => item.fileName === file.fileName && item.fileSize === file.size && item.state !== "COMPLETE" && !/FAIL|ERROR|INVALID|REJECT/.test(item.state));
        if (attachments.length && !pending) throw new Error("审核附件最多上传 1 个，请先删除已有附件再上传新文件");
        if (pending && pending.state !== "AWAITING_UPLOAD") throw new Error(`同名附件正在处理，请刷新列表后确认：${file.fileName}`);
        // Reuse an unfinished reservation after a cancellation/failed PUT.
        const body = pending ? await request(`/iris/v1/appStoreReviewAttachments/${resourceId(pending.id)}`) : await write("/iris/v1/appStoreReviewAttachments", "POST", { type: "appStoreReviewAttachments", attributes: { fileName: file.fileName, fileSize: file.size }, relationships: { appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: reviewId } } } });
        const row = body?.data, operations = row?.attributes?.uploadOperations;
        if (row?.id && !pending) attachments.push(normalizeAttachment(row));
        if (!row?.id || !Array.isArray(operations) || !operations.length) throw new Error("Apple 未返回附件上传信息，请刷新列表确认结果");
        if (pending && row.id !== pending.id) throw new Error("Apple 返回的附件与上传记录不匹配，请刷新后重试");
        let covered = 0;
        for (const operation of [...operations].sort((a, b) => a.offset - b.offset)) {
          if (!/^https:\/\//i.test(operation.url || "") || !Number.isSafeInteger(operation.offset) || operation.offset !== covered || !Number.isSafeInteger(operation.length) || operation.length <= 0 || covered + operation.length > buffer.length) throw new Error("Apple 返回的附件上传分片无效，请刷新后重试");
          covered += operation.length;
        }
        if (covered !== buffer.length) throw new Error("Apple 返回的附件上传分片不完整，请刷新后重试");
        const url = `/iris/v1/appStoreReviewAttachments/${resourceId(row.id)}`;
        for (const operation of operations) { check(); await upload(operation, buffer, file.filePath, signal); }
        // Match the captured HAR: Apple computes the source checksum itself.
        await write(url, "PATCH", { type: "appStoreReviewAttachments", id: row.id, attributes: { uploaded: true } });
        for (let attempt = 0; attempt < 30; attempt++) {
          const current = normalizeAttachment((await request(url))?.data);
          if (current.id !== row.id) throw new Error("Apple 未返回对应附件的处理结果，请刷新列表确认");
          attachments[attachments.findIndex(item => item.id === row.id)] = current;
          if (current.state === "COMPLETE") {
            if (current.sourceFileChecksum && current.sourceFileChecksum !== checksum) throw new Error(`附件校验不一致，请刷新后核对文件：${file.fileName}`);
            uploaded++; break;
          }
          if (/FAIL|ERROR|INVALID|REJECT/.test(current.state)) throw new Error(current.errors.map(item => item.description || item.message || item.code).filter(Boolean).join("；") || `附件处理失败：${file.fileName}`);
          if (attempt === 29) throw new Error(`附件仍在处理中，请稍后刷新列表：${file.fileName}`);
          await wait(1000); check();
        }
      }
      return { reviewDetailId: reviewId, attachments, uploaded };
    } catch (error) {
      // Preserve confirmed successes and resource IDs after partial/uncertain writes.
      return { reviewDetailId: reviewId, attachments, uploaded, error: signal?.aborted ? "附件上传已取消，请刷新列表确认 Apple 已接收的附件" : error.message };
    }
  }
  return { run, list };
}

module.exports = { createReviewAttachmentService, normalizeAttachment, EXTENSIONS };
