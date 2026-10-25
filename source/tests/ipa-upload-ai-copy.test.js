const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "certificate-manager.js"), "utf8");
const rendererHTML = fs.readFileSync(path.join(__dirname, "..", "src", "certificate-manager.html"), "utf8");

function copyHelperSource() {
  return renderer.slice(
    renderer.indexOf("async function writeIPAClipboardText"),
    renderer.indexOf("async function openIPAUploadAnalysisDialog"),
  );
}

test("复制报错按钮位于 AI 解析左侧", () => {
  const pageBlock = renderer.slice(
    renderer.indexOf("function renderIPAUploadPage"),
    renderer.indexOf("function populateIPAUploadProxyOptions"),
  );
  assert.match(pageBlock, /id="ipa-upload-copy-error"[\s\S]*id="ipa-upload-ai-parse"/);
  assert.match(pageBlock, /addEventListener\("click", copyIPAUploadErrorLog\)/);
  assert.match(rendererHTML, /\.ipa-log-actions\{[^}]*gap:10px/);
});

test("复制报错只拷贝红色错误行", async () => {
  const copiedValues = [];
  const classes = new Set();
  const label = { textContent: "复制报错" };
  const button = {
    disabled: false,
    title: "",
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    querySelector: () => label,
  };
  const errorRows = [
    { textContent: "[22:20:41] ERROR: Certificate Revoked" },
    { textContent: "[22:20:42] <main> DBG-X: Returning 1" },
  ];
  const log = { querySelectorAll: selector => selector === ".error" ? errorRows : [] };
  const sandbox = {
    el: id => ({ "ipa-upload-log": log, "ipa-upload-copy-error": button }[id] || null),
    navigator: { clipboard: { writeText: async value => copiedValues.push(value) } },
    document: {},
    window: { setTimeout: () => {} },
  };

  vm.runInNewContext(`${copyHelperSource()}; copyPromise = copyIPAUploadErrorLog();`, sandbox);
  await sandbox.copyPromise;

  assert.deepEqual(copiedValues, [errorRows.map(row => row.textContent).join("\n")]);
  assert.equal(label.textContent, "已复制");
  assert.equal(classes.has("copied"), true);
});

test("AI 解析成功后显示复制按钮", () => {
  const dialogBlock = renderer.slice(
    renderer.indexOf("function ensureIPAUploadAnalysisDialog"),
    renderer.indexOf("function ensureAppPasswordDialog"),
  );
  assert.match(dialogBlock, /id="ipa-upload-ai-copy"/);
  assert.match(dialogBlock, /copyButton\.classList\.remove\("hidden"\)/);
  assert.match(dialogBlock, /copyButton\.disabled = false/);
  assert.match(dialogBlock, /copyButton\.classList\.add\("hidden"\)/);
  assert.match(rendererHTML, /\.ipa-upload-ai-copy\{[^}]*display:inline-flex/);
});

test("AI 反馈复制保留完整文本并显示成功状态", async () => {
  const copiedValues = [];
  const classes = new Set();
  const label = { textContent: "复制内容" };
  const resultBox = {
    textContent: "第一行\n```bash\nfind \"$APP_PATH\"\n```\n最后一行",
    classList: { contains: () => false },
  };
  const button = {
    disabled: false,
    title: "",
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
    querySelector: selector => selector === "span" ? label : null,
  };
  let reset = null;
  const sandbox = {
    el: id => ({ "ipa-upload-ai-result": resultBox, "ipa-upload-ai-copy": button }[id] || null),
    navigator: { clipboard: { writeText: async value => copiedValues.push(value) } },
    document: {},
    window: { setTimeout: callback => { reset = callback; } },
  };

  vm.runInNewContext(`${copyHelperSource()}; copyPromise = copyIPAUploadAIResult();`, sandbox);
  await sandbox.copyPromise;

  assert.deepEqual(copiedValues, [resultBox.textContent]);
  assert.equal(label.textContent, "已复制");
  assert.equal(button.disabled, true);
  assert.equal(classes.has("copied"), true);
  reset();
  assert.equal(label.textContent, "复制内容");
  assert.equal(button.disabled, false);
});

test("AI 反馈复制在 Clipboard API 被拒绝时回退到 textarea", async () => {
  const classes = new Set();
  const label = { textContent: "复制内容" };
  const resultBox = { textContent: "需要完整复制的 AI 反馈", classList: { contains: () => false } };
  const button = {
    disabled: false,
    title: "",
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    querySelector: () => label,
  };
  const textarea = {
    value: "",
    readOnly: false,
    style: {},
    selected: false,
    removed: false,
    select() { this.selected = true; },
    remove() { this.removed = true; },
  };
  let appended = null;
  let execCommand = "";
  const sandbox = {
    el: id => ({ "ipa-upload-ai-result": resultBox, "ipa-upload-ai-copy": button }[id] || null),
    navigator: { clipboard: { writeText: async () => { throw new Error("权限被拒绝"); } } },
    document: {
      createElement: name => {
        assert.equal(name, "textarea");
        return textarea;
      },
      body: { appendChild: input => { appended = input; } },
      execCommand: command => {
        execCommand = command;
        return true;
      },
    },
    window: { setTimeout: () => {} },
  };

  vm.runInNewContext(`${copyHelperSource()}; copyPromise = copyIPAUploadAIResult();`, sandbox);
  await sandbox.copyPromise;

  assert.equal(appended, textarea);
  assert.equal(textarea.value, resultBox.textContent);
  assert.equal(textarea.selected, true);
  assert.equal(textarea.removed, true);
  assert.equal(execCommand, "copy");
  assert.equal(label.textContent, "已复制");
  assert.equal(classes.has("copied"), true);
});
