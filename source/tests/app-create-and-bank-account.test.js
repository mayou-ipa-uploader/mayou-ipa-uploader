const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const renderer = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.js"), "utf8");
const rendererHTML = fs.readFileSync(path.join(__dirname, "../src/certificate-manager.html"), "utf8");

test("创建 App 弹窗会重新请求套装 ID 列表", () => {
  const block = renderer.slice(
    renderer.indexOf("function showAppStoreCreateModal()"),
    renderer.indexOf("function closeAppStoreCreateModal"),
  );
  assert.match(block, /loadAppStoreBundleIds\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(renderer, /async function loadAppStoreBundleIds\(\)/);
});

test("勾选与法律实体相同时姓名输入框仍可修改", () => {
  const block = renderer.slice(
    renderer.indexOf("function renderBankAccountDialog()"),
    renderer.indexOf("function openBankSearchDialog()"),
  );
  assert.match(block, /id="bank-holder-name"/);
  assert.match(block, /id="bank-holder-name" value="\$\{escapeHTML\(form\.accountHolderName \|\| ""\)\}">/);
  assert.doesNotMatch(
    block,
    /id="bank-holder-name"[^>]*\$\{holderDisabled\}/,
  );
  assert.match(block, /id="bank-holder-type" \$\{holderDisabled\}/);
});

test("CNAPS 校验失败会提示搜索代码并核对卡号", () => {
  const helperSource = renderer.slice(
    renderer.indexOf("function bankCnapsInvalidErrorMessage()"),
    renderer.indexOf("function renderBankAccountDialog()"),
  );
  const sandbox = {};
  vm.runInNewContext(`${helperSource}; result = [
    bankFriendlyError("PPM.banking.bankingAccount.localClearingCode.CHN.validate.invalid"),
    bankFriendlyError("PPM.banking.localclearnacecode.search.invalidLocalClearingCode"),
    bankFriendlyError("其他错误"),
  ];`, sandbox);
  const expected = "1、请点击按钮“不知道你的 CNAPS 代码?”来进行搜索CNAPS 代码以确保信息的准确性;\n2、请核对银行卡号是否正确";
  assert.equal(sandbox.result[0], expected);
  assert.equal(sandbox.result[1], expected);
  assert.equal(sandbox.result[2], "其他错误");
  assert.match(renderer, /bankSetError\(bankFriendlyError\(error\.message \|\| "银行卡添加失败"\)\)/);
  assert.match(rendererHTML, /\.bank-dialog-error\{[^}]*white-space:pre-line/);
});

test("银行搜索结果中的长文本会换行完整显示", () => {
  assert.match(
    rendererHTML,
    /\.bank-search-row>span\{[^}]*min-width:0[^}]*overflow-wrap:anywhere/,
  );
  assert.match(
    rendererHTML,
    /\.bank-search-row b,\.bank-search-row small\{[^}]*white-space:normal[^}]*overflow-wrap:anywhere/,
  );
  assert.doesNotMatch(
    rendererHTML,
    /\.bank-search-row b,\.bank-search-row small\{[^}]*text-overflow:ellipsis/,
  );
});
