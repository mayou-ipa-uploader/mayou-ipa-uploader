const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = name => fs.readFileSync(path.join(__dirname, "../src", name), "utf8");

test("Apple ID login password is encrypted locally and never sent to the server store", () => {
  const main = source("main.js");
  const manager = source("developer-account-manager.js");
  const managerHTML = source("developer-account-manager.html");
  assert.match(main, /encryptLocalSecret\(password\)/);
  assert.match(main, /decryptDeveloperAccountPassword/);
  assert.match(main, /if \(!isEncryptedLocalSecret\(row\.password\)\) migratePassword\.run\(encryptLocalSecret\(row\.password\)/);
  assert.match(main, /password=excluded\.password/);
  assert.match(main, /function recordStandaloneLoginSuccess\(appleId\)/);
  const historyRecorder = main.slice(main.indexOf("function recordStandaloneLoginSuccess"), main.indexOf("function selectStandaloneLoginHistory"));
  assert.doesNotMatch(historyRecorder, /password:/);
  assert.match(main, /password: decryptDeveloperAccountPassword\(row\.password\)/);
  assert.match(manager, /el\("password"\)/);
  assert.match(managerHTML, /id="password"/);
  assert.match(managerHTML, /账户密码仅保存在本机/);
  assert.match(managerHTML, /不会上传或保存到码尚友服务器/);
});

test("certificate manager login displays privacy and public environment notice", () => {
  const html = source("certificate-manager.html");
  assert.match(html, /仅经加密保存在当前设备/);
  assert.match(html, /不会上传或保存到码尚友服务器/);
  assert.match(html, /网吧、共享电脑或不可信公共网络/);
  assert.match(html, /certificate-user-agreement\.html/);
  assert.match(html, /certificate-privacy-policy\.html/);
});
