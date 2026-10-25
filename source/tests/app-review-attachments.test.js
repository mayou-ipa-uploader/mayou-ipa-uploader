const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const { createReviewAttachmentService } = require("../src/app-review-attachments");

const payload = { appId: "app-a", versionId: "version-a", reviewDetailId: "review-a" };
const file = Buffer.from("example video");
const checksum = crypto.createHash("md5").update(file).digest("hex");
const operations = [{ url: "https://upload.apple.com/first", method: "PUT", offset: 0, length: 4, requestHeaders: [{ name: "Content-Type", value: "video/mp4" }] }, { url: "https://upload.apple.com/second", method: "PUT", offset: 4, length: file.length - 4, requestHeaders: [] }];
const attachment = (id, state, extra = {}) => ({ type: "appStoreReviewAttachments", id, attributes: { fileName: "演示.mp4", fileSize: file.length, uploadOperations: operations, assetDeliveryState: { state, errors: [] }, ...extra } });
const version = (appId = "app-a", state = "PREPARE_FOR_SUBMISSION", reviewId = "review-a") => ({ id: "version-a", attributes: { appStoreState: state }, relationships: { app: { data: { id: appId } }, appStoreReviewDetail: { data: reviewId ? { id: reviewId } : null } } });
function backend(options = {}) {
  const calls = [], bytes = [], controller = new AbortController();
  let reads = 0, created = 0;
  const service = createReviewAttachmentService({
    signal: controller.signal,
    fetch: async (url, request = {}) => {
      assert.ok(request.signal);
      calls.push({ url, method: request.method || "GET", data: request.body ? JSON.parse(request.body).data : null });
      const override = options.response?.(url, request, calls); if (override) return { body: override };
      if (url.includes("appStoreVersions/")) return { body: { data: options.version || version() } };
      if (url.includes("appStoreReviewDetails/") && url.endsWith("/appStoreReviewAttachments")) return { body: { data: options.existing || [] } };
      if (url === "/iris/v1/appStoreReviewDetails") return { body: { data: { id: "review-a" } } };
      if (request.method === "POST") return { body: { data: attachment(`attachment-${++created}`, "AWAITING_UPLOAD") } };
      if (request.method === "PATCH") return { body: { data: attachment("attachment-1", "UPLOAD_COMPLETE") } };
      return { body: { data: attachment("attachment-1", ++reads === 1 ? "UPLOAD_COMPLETE" : "COMPLETE", { sourceFileChecksum: checksum }) } };
    },
    chooseFiles: async () => options.selection || { filePaths: ["/mock/演示.mp4"] },
    stat: async () => ({ isFile: () => true, size: file.length }),
    readFile: async () => file,
    upload: async (operation, buffer, _path, signal) => {
      bytes.push(buffer.subarray(operation.offset, operation.offset + operation.length));
      await options.upload?.(operation, signal);
    },
    wait: async () => {},
  });
  return { service, calls, bytes, controller };
}

test("HAR attachment flow reserves the selected review resource, uploads all chunks and waits beyond UPLOAD_COMPLETE", async () => {
  const { service, calls, bytes } = backend();
  const result = await service.run("upload", payload);
  assert.equal(result.uploaded, 1); assert.equal(result.attachments[0].state, "COMPLETE");
  assert.deepEqual(Buffer.concat(bytes), file);
  const post = calls.find(call => call.method === "POST");
  assert.deepEqual(post.data, { type: "appStoreReviewAttachments", attributes: { fileName: "演示.mp4", fileSize: file.length }, relationships: { appStoreReviewDetail: { data: { type: "appStoreReviewDetails", id: "review-a" } } } });
  assert.deepEqual(calls.find(call => call.method === "PATCH").data.attributes, { uploaded: true });
  assert.equal(calls.filter(call => call.method === "GET" && call.url === "/iris/v1/appStoreReviewAttachments/attachment-1").length, 2);
  assert.equal(calls.some(call => /reviewSubmissions|reviewSubmissionItems/.test(call.url)), false);
});

test("wrong app/review, locked version and unsupported files never create attachments", async () => {
  for (const [options, message] of [
    [{ version: version("other-app") }, /App 不匹配/],
    [{ version: version("app-a", "DRAFT", "other-review") }, /审核信息/],
    [{ version: version("app-a", "IN_REVIEW") }, /不可编辑/],
    [{ selection: { filePaths: ["/mock/script.exe"] } }, /不支持/],
  ]) {
    const { service, calls } = backend(options);
    await assert.rejects(service.run("upload", payload), message);
    assert.equal(calls.some(call => call.method !== "GET"), false);
  }
});

test("canceling the picker makes no Apple writes", async () => {
  const { service, calls } = backend({ selection: { canceled: true } });
  assert.equal((await service.run("upload", payload)).canceled, true);
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("version state is rechecked after the file picker", async () => {
  let reads = 0;
  const { service, calls } = backend({ response: url => url.includes("appStoreVersions/") ? { data: version("app-a", ++reads === 1 ? "DRAFT" : "IN_REVIEW") } : null });
  await assert.rejects(service.run("upload", payload), /不可编辑/);
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("an identical confirmed attachment is not uploaded twice", async () => {
  const { service, calls, bytes } = backend({ existing: [attachment("already-uploaded", "COMPLETE", { sourceFileChecksum: checksum })] });
  assert.equal((await service.run("upload", payload)).uploaded, 0);
  assert.equal(bytes.length, 0); assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("cancellation during PUT stops commit and retains the reservation for recovery", async () => {
  const context = backend({ upload: () => context.controller.abort() });
  const result = await context.service.run("upload", payload);
  assert.match(result.error, /已取消/); assert.equal(result.attachments[0].id, "attachment-1");
  assert.equal(context.calls.filter(call => call.method === "PATCH").length, 0);
  assert.equal(context.bytes.length, 1);
});

test("a canceled upload resumes its existing reservation rather than creating a duplicate", async () => {
  let reads = 0;
  const { service, calls } = backend({ existing: [attachment("reserved", "AWAITING_UPLOAD")], response: (url, request) => {
    if (url === "/iris/v1/appStoreReviewAttachments/reserved" && !request.method) return { data: attachment("reserved", ++reads === 1 ? "AWAITING_UPLOAD" : "COMPLETE") };
  } });
  assert.equal((await service.run("upload", payload)).uploaded, 1);
  assert.equal(calls.filter(call => call.method === "POST").length, 0);
  assert.equal(calls.find(call => call.method === "PATCH").url, "/iris/v1/appStoreReviewAttachments/reserved");
});

test("processing timeout is reported honestly and does not repeat a write", async () => {
  const { service, calls } = backend({ response: (url, request) => url === "/iris/v1/appStoreReviewAttachments/attachment-1" && !request.method ? { data: attachment("attachment-1", "UPLOAD_COMPLETE") } : null });
  const result = await service.run("upload", payload);
  assert.match(result.error, /仍在处理中/); assert.equal(result.uploaded, 0);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.method === "PATCH").length, 1);
});

test("multiple selection is rejected before any write", async () => {
  const { service, calls } = backend({ selection: { filePaths: ["/mock/演示.mp4", "/mock/second.mp4"] } });
  await assert.rejects(service.run("upload", payload), /最多上传 1 个/);
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("an existing different attachment must be deleted before a replacement upload", async () => {
  const { service, calls } = backend({ existing: [attachment("existing", "COMPLETE", { fileName: "old.mp4" })] });
  const result = await service.run("upload", payload);
  assert.match(result.error, /先删除/);
  assert.equal(calls.some(call => call.method !== "GET"), false);
});

test("deletion is scoped to the selected version and confirmed by refreshing the list", async () => {
  let deleted = false;
  const { service, calls } = backend({ response: (url, request) => {
    if (request.method === "DELETE") { deleted = true; return {}; }
    if (url.endsWith("/appStoreReviewAttachments")) return { data: deleted ? [] : [attachment("existing", "COMPLETE")] };
  } });
  const result = await service.run("delete", { ...payload, attachmentId: "existing" });
  assert.equal(result.deleted, true);
  assert.equal(result.attachments.length, 0);
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
});

test("deletion refuses foreign attachment IDs, mismatched apps and locked versions", async () => {
  for (const options of [{ existing: [attachment("another", "COMPLETE")] }, { version: version("foreign") }, { version: version("app-a", "IN_REVIEW") }]) {
    const { service, calls } = backend(options);
    await assert.rejects(service.run("delete", { ...payload, attachmentId: "existing" }));
    assert.equal(calls.some(call => call.method !== "GET"), false);
  }
});

test("an uncertain DELETE response is not retried", async () => {
  const { service, calls } = backend({ existing: [attachment("existing", "COMPLETE")], response: (_url, request) => {
    if (request.method === "DELETE") throw new Error("network disconnected");
  } });
  await assert.rejects(service.run("delete", { ...payload, attachmentId: "existing" }), /network disconnected/);
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
});

test("missing review detail is created for the selected version before reserving its attachment", async () => {
  let reads = 0;
  const { service, calls } = backend({ response: url => url.includes("appStoreVersions/") ? { data: version("app-a", "DRAFT", ++reads < 3 ? "" : "review-a") } : null });
  const result = await service.run("upload", { ...payload, reviewDetailId: "" });
  assert.equal(result.uploaded, 1);
  const post = calls.find(call => call.url === "/iris/v1/appStoreReviewDetails");
  assert.equal(post.data.relationships.appStoreVersion.data.id, "version-a");
});

test("invalid upload chunk boundaries never transmit bytes or commit the attachment", async () => {
  const { service, calls, bytes } = backend({ response: (_url, request) => request.method === "POST" ? { data: attachment("attachment-1", "AWAITING_UPLOAD", { uploadOperations: [{ ...operations[0], offset: 1 }] }) } : null });
  assert.match((await service.run("upload", payload)).error, /分片无效/);
  assert.equal(bytes.length, 0); assert.equal(calls.some(call => call.method === "PATCH"), false);
});

test("Apple processing errors retain the real reason and never become an uploaded success", async () => {
  const { service } = backend({ response: (url, request) => url === "/iris/v1/appStoreReviewAttachments/attachment-1" && !request.method ? { data: attachment("attachment-1", "FAILED", { assetDeliveryState: { state: "FAILED", errors: [{ code: "INVALID_FILE", description: "视频格式无效" }] } }) } : null });
  const result = await service.run("upload", payload);
  assert.equal(result.uploaded, 0); assert.equal(result.error, "视频格式无效");
  assert.equal(result.attachments[0].state, "FAILED");
});

test("attachment pagination keeps the review scope and rejects foreign next URLs", async () => {
  const base = "/iris/v1/appStoreReviewDetails/review-a/appStoreReviewAttachments";
  const context = backend({ response: url => url === base ? { data: [attachment("first", "COMPLETE")], links: { next: `https://appstoreconnect.apple.com${base}?cursor=next` } } : url.includes("cursor=next") ? { data: [attachment("second", "COMPLETE")] } : null });
  assert.deepEqual((await context.service.run("list", payload)).attachments.map(row => row.id), ["first", "second"]);
  const foreign = backend({ response: url => url === base ? { data: [], links: { next: "https://foreign.example/attachments" } } : null });
  await assert.rejects(foreign.service.run("list", payload), /分页地址无效/);
});

const renderer = fs.readFileSync(require.resolve("../src/certificate-manager.js"), "utf8");
function rendererFunction(name, context) {
  const start = renderer.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = renderer.slice(start + 1).search(/\n(?:async )?function /);
  vm.runInNewContext(renderer.slice(start, start + 1 + end), context);
}
test("IPA action opens the corresponding in-app TestFlight list and preserves its platform", async () => {
  const button = { disabled: false, isConnected: true, dataset: { taskId: "uploaded-task" } };
  const calls = [];
  const context = { authenticated: true, appleLoginInProgress: false, pageSwitchToken: 1, appStoreDetailRequestSeq: 0, appStoreApps: [],
    el: id => id === "ipa-upload-open-testflight" ? button : {},
    window: { appleDeveloper: { ipaUploadTestFlightApp: async id => { assert.equal(id, "uploaded-task"); return { success: true, app: { id: "uploaded-app", name: "Demo" }, platform: "MAC_OS", contextToken: "account-team" }; } } },
    showPage: async name => { calls.push(name); context.pageSwitchToken++; }, closeAppStoreDetailLoading: () => {},
    switchAppStorePane: (app, pane) => calls.push({ app, pane }), showAppStoreError: message => assert.fail(message),
  };
  rendererFunction("openIPAUploadTestFlight", context);
  await context.openIPAUploadTestFlight();
  assert.equal(calls[0], "apps"); assert.equal(calls[1].app.id, "uploaded-app"); assert.equal(calls[1].pane, "testflight");
  assert.equal(context.currentAppStoreDetail.selectedVersion.platform, "MAC_OS");
  assert.ok(context.currentAppStoreDetail.versions.some(row => row.platform === "MAC_OS"));
  assert.equal(button.disabled, false);
});

test("a late IPA navigation response cannot override a user's newer page choice", async () => {
  let finish;
  const context = { authenticated: true, appleLoginInProgress: false, pageSwitchToken: 1,
    el: () => ({ isConnected: true, dataset: { taskId: "task" } }),
    window: { appleDeveloper: { ipaUploadTestFlightApp: () => new Promise(resolve => { finish = resolve; }) } },
    showPage: () => assert.fail("late navigation"), showAppStoreError: message => assert.fail(message),
  };
  rendererFunction("openIPAUploadTestFlight", context);
  const request = context.openIPAUploadTestFlight(); context.pageSwitchToken++;
  finish({ success: true, app: { id: "old-app" } }); await request;
});

test("attachment updates preserve form nodes, concurrent saves and partial success while deduplicating clicks", async () => {
  const nodes = {};
  for (const name of ["upload", "refresh", "cancel", "list", "status"]) nodes[`app-review-attachment-${name}`] = { disabled: false, isConnected: true, classList: { toggle() {}, add() {} }, addEventListener(event, callback) { this[event] = callback; } };
  const detail = { selectedVersion: { id: "version-a" }, reviewDetail: { id: "review-a", attachmentsContextToken: "account-team" } };
  let finish, count = 0;
  const context = { currentAppStoreApp: { id: "app-a" }, currentAppStoreDetail: detail, el: id => nodes[id],
    window: { appleDeveloper: { appStoreReviewAttachments: () => { count++; return new Promise(resolve => { finish = resolve; }); } } },
    renderAppStoreReviewAttachments: attachments => attachments.map(row => row.fileName).join(), clearAppStoreDetailCache: () => {},
  };
  rendererFunction("bindAppStoreReviewAttachments", context); context.bindAppStoreReviewAttachments();
  const request = nodes["app-review-attachment-upload"].click(); nodes["app-review-attachment-upload"].click();
  assert.equal(count, 1);
  const savedDetail = { ...detail, reviewDetail: { ...detail.reviewDetail, notes: "notes saved during upload" } };
  context.currentAppStoreDetail = savedDetail;
  finish({ success: false, reviewDetailId: "review-a", attachments: [{ id: "first", fileName: "saved.mp4" }], error: "second file failed" }); await request;
  assert.equal(nodes["app-review-attachment-list"].innerHTML, "saved.mp4");
  assert.equal(nodes["app-review-attachment-status"].textContent, "second file failed");
  assert.equal(context.currentAppStoreDetail, savedDetail);
  assert.equal(savedDetail.reviewDetail.notes, "notes saved during upload");
  assert.equal(savedDetail.reviewDetail.attachments[0].fileName, "saved.mp4");
  assert.equal(nodes["app-review-attachment-upload"].disabled, true);
});

test("ready for review permits deleting a review attachment before resubmission", async () => {
  let deleted = false;
  const { service } = backend({ version: version('app-a', 'READY_FOR_REVIEW'), response: (url, request) => {
    if (request.method === 'DELETE') { deleted = true; return {}; }
    if (url.endsWith('/appStoreReviewAttachments')) return { data: deleted ? [] : [attachment('existing', 'COMPLETE')] };
  } });
  assert.equal((await service.run('delete', { ...payload, attachmentId: 'existing' })).deleted, true);
});

test("delete confirmation can be canceled; confirmed repeated clicks submit once and unlock replacement", async () => {
  const nodes = {};
  for (const name of ['upload', 'refresh', 'cancel', 'list', 'status']) nodes[`app-review-attachment-${name}`] = { disabled: false, isConnected: true, classList: { toggle() {}, add() {} }, addEventListener(event, callback) { this[event] = callback; } };
  let confirmed = false, calls = [], finish;
  const button = { disabled: false, dataset: { reviewAttachmentDelete: 'existing' } };
  nodes['app-review-attachment-list'].querySelectorAll = () => [button];
  const c = { currentAppStoreApp: { id: 'app-a' }, currentAppStoreDetail: { selectedVersion: { id: 'version-a' }, reviewDetail: { id: 'review-a', attachmentsContextToken: 'account-team', attachments: [{ id: 'existing', fileName: 'old.mp4' }] } },
    el: id => nodes[id], confirm: () => confirmed,
    renderAppStoreReviewAttachments: rows => rows.map(x => x.fileName).join(), clearAppStoreDetailCache() {},
    window: { appleDeveloper: { appStoreReviewAttachments: p => { calls.push(p); return new Promise(resolve => { finish = resolve; }); } } },
  };
  rendererFunction('bindAppStoreReviewAttachments', c); c.bindAppStoreReviewAttachments();
  const click = () => nodes['app-review-attachment-list'].click({ target: { closest: () => button } });
  click(); assert.equal(calls.length, 0);
  confirmed = true; click(); click(); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'delete'); assert.equal(calls[0].attachmentId, 'existing');
  assert.equal(button.disabled, true);
  finish({ success: true, deleted: true, reviewDetailId: 'review-a', attachments: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.currentAppStoreDetail.reviewDetail.attachments.length, 0);
  assert.equal(nodes['app-review-attachment-upload'].disabled, false);
  assert.match(nodes['app-review-attachment-status'].textContent, /已删除/);
});
