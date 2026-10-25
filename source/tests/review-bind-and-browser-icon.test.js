const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const roots = [
  ["standalone", path.join(__dirname, "..", "src")],
  ["browser", path.join(__dirname, "..", "src")],
];

for (const [variant, sourceRoot] of roots) {
  const main = fs.readFileSync(path.join(sourceRoot, "main.js"), "utf8");
  const certificateRenderer = fs.readFileSync(path.join(sourceRoot, "certificate-manager.js"), "utf8");
  const certificateHTML = fs.readFileSync(path.join(sourceRoot, "certificate-manager.html"), "utf8");

  test(`${variant}: 顶部应用菜单完全移除`, () => {
    const menuBlock = main.slice(main.indexOf("function installChineseMenu()"), main.indexOf("function isSameLocalDay"));
    assert.match(menuBlock, /Menu\.setApplicationMenu\(null\)/);
    assert.doesNotMatch(menuBlock, /关于应用|版本号：|label: "编辑"/);
  });

  test(`${variant}: App 选择页展示每个 App 及合计未读消息数`, () => {
    const selectBlock = certificateRenderer.slice(
      certificateRenderer.indexOf("async function openReviewGuidance"),
      certificateRenderer.indexOf("async function loadReviewGuidanceAppsForCurrentAccount"),
    );
    assert.match(selectBlock, /reviewGuidanceTickets\(\)/);
    assert.match(selectBlock, /ticket\?\.user_unread/);
    assert.match(selectBlock, /review-app-unread/);
    assert.match(selectBlock, /\$\{totalUnread\} 条未读消息/);
  });

  test(`${variant}: 审核聊天中的账户弹窗显示在会话层上方`, () => {
    const accountLayer = certificateHTML.match(/\.account-menu-wrap:has\(\.account-popover\.show\)\{z-index:(\d+)\}/);
    const reviewLayer = certificateHTML.match(/\.review-chat-mask\{[^}]*z-index:(\d+)/);
    assert.ok(accountLayer, "缺少账户弹窗打开时的层级规则");
    assert.ok(reviewLayer, "缺少审核聊天层级规则");
    assert.ok(Number(accountLayer[1]) > Number(reviewLayer[1]), "账户弹窗应显示在审核聊天层上方");
  });

  test(`${variant}: 其他 App 未读消息按 App 汇总并排除当前 App`, () => {
    const helperSource = certificateRenderer.slice(
      certificateRenderer.indexOf("function reviewGuidanceOtherAppRows"),
      certificateRenderer.indexOf("async function renderReviewGuidanceChat"),
    );
    const sandbox = {};
    vm.runInNewContext(`${helperSource}; result = reviewGuidanceOtherAppRows([
      { id: 1, app_id: "current", user_unread: 9, updated_at: "2026-09-02T12:00:00Z" },
      { id: 2, app_id: "other", app_name: "其他 App", user_unread: 2, latest_message: "第一条", updated_at: "2026-09-02T11:00:00Z" },
      { id: 3, app_id: "other", app_name: "其他 App", user_unread: 1, latest_message: "第二条", updated_at: "2026-09-02T10:00:00Z" },
      { id: 4, app_id: "read", user_unread: 0, updated_at: "2026-09-02T13:00:00Z" }
    ], { app_id: "current" });`, sandbox);
    const rows = JSON.parse(JSON.stringify(sandbox.result));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].appId, "other");
    assert.equal(rows[0].unread, 3);
    assert.equal(rows[0].latestMessage, "第一条");
  });

  test(`${variant}: 审核聊天悬浮展示其他 App 消息并支持直接切换`, () => {
    const chatBlock = certificateRenderer.slice(
      certificateRenderer.indexOf("async function renderReviewGuidanceChat"),
      certificateRenderer.indexOf("const el = id =>"),
    );
    assert.match(chatBlock, /review-other-apps-toggle/);
    assert.match(chatBlock, /review-other-apps-panel/);
    assert.match(chatBlock, /reviewGuidanceTickets\(\)/);
    assert.match(chatBlock, /renderOtherAppMessages/);
    assert.match(chatBlock, /await renderReviewGuidanceChat\(mask, target\)/);
    assert.match(chatBlock, /暂无其他 App 未读消息/);
    assert.match(certificateHTML, /id="review-other-app-messages"/);
    assert.match(certificateHTML, /\.review-other-app-row/);
  });

  test(`${variant}: 审核码绑定允许服务端完成 App Store 核对`, () => {
    const handler = main.slice(main.indexOf('ipcMain.handle("review-guidance-bind"'), main.indexOf('ipcMain.handle("review-guidance-apps"'));
    assert.match(handler, /AbortSignal\.timeout\(90000\)/);
    assert.match(handler, /catch \(error\)/);
    assert.match(handler, /审核核验码绑定超时/);
  });

  test(`${variant}: 审核服务购买按钮可切换支付宝或微信`, () => {
    const paymentBlock = certificateRenderer.slice(
      certificateRenderer.indexOf('const setPayMethod = method =>'),
      certificateRenderer.indexOf('panel.querySelector("#review-bind-submit").onclick')
    );
    assert.match(paymentBlock, /data-review-pay-method/);
    assert.match(paymentBlock, /event\.stopPropagation\(\)/);
    assert.match(paymentBlock, /setPayMethod\(button\.dataset\.reviewPayMethod\)/);
  });

  test(`${variant}: 审核聊天避免输入法回车误发送和重复提交`, () => {
    const chatBlock = certificateRenderer.slice(
      certificateRenderer.indexOf("async function renderReviewGuidanceChat"),
      certificateRenderer.indexOf("const el = id =>"),
    );
    assert.match(chatBlock, /let sendingMessage = false/);
    assert.match(chatBlock, /let composingMessage = false/);
    assert.match(chatBlock, /if \(sendingMessage\) return/);
    assert.match(chatBlock, /compositionstart/);
    assert.match(chatBlock, /event\.isComposing \|\| event\.keyCode === 229/);
    assert.match(chatBlock, /if \(!sendingMessage\).*requestSubmit/);
  });

  test(`${variant}: 审核聊天展示发送中和发送失败状态`, () => {
    const chatBlock = certificateRenderer.slice(
      certificateRenderer.indexOf("async function renderReviewGuidanceChat"),
      certificateRenderer.indexOf("const el = id =>"),
    );
    assert.match(chatBlock, /review-chat-message-status sending/);
    assert.match(chatBlock, /pendingRow\??\.classList\.add\("failed"\)/);
    assert.match(chatBlock, /status\.className = "review-chat-message-status failed"/);
    assert.match(chatBlock, /status\.replaceChildren\(document\.createTextNode\("!"\)\)/);
  });

  test(`${variant}: 审核聊天只在需要时滚动并统计未读消息`, () => {
    const chatBlock = certificateRenderer.slice(
      certificateRenderer.indexOf("async function renderReviewGuidanceChat"),
      certificateRenderer.indexOf("const el = id =>"),
    );
    assert.match(chatBlock, /const scrollBox = list/);
    assert.match(chatBlock, /scrollBox\.scrollHeight - previousScrollTop - scrollBox\.clientHeight/);
    assert.match(chatBlock, /review-chat-messages"\)\.addEventListener\("scroll"/);
    assert.match(chatBlock, /unreadIncomingCount \+= addedIncomingCount/);
  });

  test(`${variant}: 支付弹窗生成前不显示二维码占位符`, () => {
    assert.doesNotMatch(certificateRenderer, /paymentArea\(\)\.innerHTML = '<div class="review-bind-payment-fallback">请选择支付宝或微信生成付款码/);
    assert.match(certificateRenderer, /review-bind-qr-box/);
  });

  test(`${variant}: macOS Dock 优先使用当前应用包图标`, () => {
    const iconFunction = main.slice(main.indexOf("function currentAppIcon()"), main.indexOf("function isOpenableURL"));
    assert.match(iconFunction, /IPAUPLOADER_APP_ICON/);
    assert.match(iconFunction, /process\.resourcesPath, "AppIcon\.icns"/);
    assert.match(iconFunction, /nativeImage\.createFromPath/);
    assert.doesNotMatch(iconFunction, /return helperIcon/);
    assert.match(iconFunction, /application dock icon failed/);
  });

  test(`${variant}: 独立窗口图标使用与主浏览器一致的全尺寸圆角`, () => {
    const logoFunction = main.slice(main.indexOf("function logoAppIcon"), main.indexOf("function currentAppIcon"));
    const iconFunction = main.slice(main.indexOf("function currentAppIcon()"), main.indexOf("function applyApplicationDockIcon"));
    assert.match(logoFunction, /const canvasSize = 512/);
    assert.match(logoFunction, /const iconInset = 50/);
    assert.match(logoFunction, /const iconSize = 412/);
    assert.match(logoFunction, /const cornerRadius = 93/);
    assert.match(logoFunction, /PNG\.sync\.write\(output\)/);
    assert.doesNotMatch(logoFunction, /<svg/);
    assert.match(iconFunction, /logoAppIcon\(helperIcon\)/);
  });

  test(`${variant}: 浏览器 Helper 继承生成主浏览器图标的同一份 PNG 图稿`, () => {
    const helperFunction = main.slice(main.indexOf("async function openBrowserHelperProcess"), main.indexOf("browserHelperProcesses.set", main.indexOf("async function openBrowserHelperProcess")));
    assert.match(helperFunction, /IPAUPLOADER_APP_ICON/);
    assert.match(helperFunction, /process\.resourcesPath, "AppIcon\.png"/);
    assert.match(helperFunction, /SOURCE_APP_ICON_PNG/);
  });

  test(`${variant}: 浏览器 Helper 在窗口创建前显示环境序号`, () => {
    const openFunction = main.slice(main.indexOf("async function openBrowserEnvironment"), main.indexOf("const progressWin", main.indexOf("async function openBrowserEnvironment")));
    assert.match(openFunction, /if \(IS_BROWSER_HELPER\) setBrowserSerialBadge\(serialNum\)/);
  });

  test(`${variant}: 主程序和独立窗口统一显示码友浏览器`, () => {
    const nameFunction = main.slice(main.indexOf("function resolvedAppName"), main.indexOf("function focusWindow"));
    const kernelFunction = main.slice(main.indexOf("function kernelRuntimePaths"), main.indexOf("async function downloadKernelArchive"));
    assert.match(main, /const BROWSER_APP_NAME = "码友浏览器"/);
    assert.match(nameFunction, /return IS_SYNC_TEST_VARIANT \? `\$\{BROWSER_APP_NAME\}内核测试` : BROWSER_APP_NAME/);
    assert.match(kernelFunction, /CFBundleDisplayName/);
    assert.match(kernelFunction, /`\$\{BROWSER_APP_NAME\}\.exe`/);
    assert.match(kernelFunction, /brandKernelRuntime/);
  });

  test(`${variant}: Windows 内核 ZIP 使用系统 tar.exe 解压`, () => {
    const extractionFunction = main.slice(
      main.indexOf("async function extractKernelArchive"),
      main.indexOf("async function downloadKernelArchive"),
    );
    const ensureFunction = main.slice(
      main.indexOf("async function ensureKernelRuntimeByVersion"),
      main.indexOf("async function resolveKernelRuntime"),
    );
    assert.match(extractionFunction, /process\.platform === "win32"/);
    assert.match(extractionFunction, /runFile\("tar\.exe", \["-xf", paths\.archive, "-C", paths\.root\]\)/);
    assert.match(extractionFunction, /runFile\("\/usr\/bin\/unzip"/);
    assert.match(ensureFunction, /await extractKernelArchive\(paths\)/);
    assert.doesNotMatch(ensureFunction, /\/usr\/bin\/unzip/);
  });

  test(`${variant}: Windows 从注册表识别证书管理自定义安装目录`, () => {
    const discoveryFunctions = main.slice(
      main.indexOf("function readWindowsRegistryString"),
      main.indexOf("function readBundleVersion"),
    );
    const customDirectory = String.raw`D:\自定义软件\码友证书管理`;
    const expectedExecutable = path.win32.join(customDirectory, "码友证书管理.exe");
    const windowsPath = Object.assign({}, path.win32, { win32: path.win32 });
    const discoverySandbox = {
      Buffer,
      app: { getPath: () => String.raw`C:\Users\Tester` },
      execFileSync: () => Buffer.from(customDirectory, "utf8").toString("base64"),
      fs: { existsSync: candidate => candidate === expectedExecutable },
      path: windowsPath,
      process: {
        platform: "win32",
        env: {
          SystemRoot: String.raw`C:\Windows`,
          LOCALAPPDATA: String.raw`C:\Users\Tester\AppData\Local`,
        },
      },
      result: null,
    };
    vm.runInNewContext(`${discoveryFunctions}\nresult = { appPath: certificateManagerAppPath(), executable: certificateManagerExecutablePath(certificateManagerAppPath()) };`, discoverySandbox);
    assert.equal(discoverySandbox.result.appPath, customDirectory);
    assert.equal(discoverySandbox.result.executable, expectedExecutable);

    const metadataFunction = main.slice(
      main.indexOf("function readInstalledCertificateManagerMetadata"),
      main.indexOf("function currentCertificateManagerVersion"),
    );
    const packagePath = path.win32.join(customDirectory, "resources", "app", "package.json");
    const markerPath = path.win32.join(customDirectory, "resources", "app", ".certificate-manager-standalone");
    const metadataSandbox = {
      CERTIFICATE_MANAGER_LAUNCH_PROTOCOL_VERSION: 1,
      fs: {
        existsSync: candidate => candidate === markerPath,
        readFileSync: candidate => {
          assert.equal(candidate, packagePath);
          return JSON.stringify({ name: "apple-certificate-manager", version: "0.1.314" });
        },
      },
      path: windowsPath,
      process: { platform: "win32" },
      result: null,
    };
    vm.runInNewContext(`${metadataFunction}\nresult = readInstalledCertificateManagerMetadata(${JSON.stringify(customDirectory)});`, metadataSandbox);
    assert.equal(metadataSandbox.result.version, "0.1.314");
    assert.equal(metadataSandbox.result.bundleId, "com.mayou.certificate-manager");
    assert.equal(metadataSandbox.result.protocolVersion, 1);
  });

  test(`${variant}: 证书管理只在成功绑定浏览器账户后确认启动`, () => {
    const contextFunctions = main.slice(
      main.indexOf("function removeCertificateManagerLaunchContext"),
      main.indexOf("function applyCertificateManagerServerContext"),
    );
    const acceptFunctions = main.slice(
      main.indexOf("async function acceptCertificateManagerLaunchPayload"),
      main.indexOf("async function promptCertificateManagerDownload"),
    );
    const openStandalone = main.slice(
      main.indexOf("async function openStandaloneCertificateManager"),
      main.indexOf("function isStandaloneCertificateManagerRunning"),
    );
    const startup = main.slice(main.indexOf("app.whenReady().then(async () => {"), main.indexOf('app.on("certificate-error"'));

    assert.match(contextFunctions, /temporaryPath = `\$\{contextPath\}\.tmp`/);
    assert.match(contextFunctions, /fs\.renameSync\(temporaryPath, contextPath\)/);
    const readContext = contextFunctions.slice(contextFunctions.indexOf("function readCertificateManagerLaunchContext"));
    assert.doesNotMatch(readContext, /unlinkSync/);
    assert.match(readContext, /payload\.launchId/);
    assert.match(readContext, /payload\.ownerKey/);
    assert.match(acceptFunctions, /certificateManagerLaunchId = String\(context\.launchId/);
    assert.match(acceptFunctions, /if \(accepted\) removeCertificateManagerLaunchContext\(contextPath\)/);
    assert.match(main, /launchId: certificateManagerLaunchId \|\| ""/);
    assert.match(openStandalone, /waitForCertificateManagerLaunchAcknowledgement\(launchId, context\.account \|\| \{\}\)/);
    assert.match(openStandalone, /status\.launchMode === "browser-bound"/);
    assert.match(openStandalone, /launchAcknowledged: true/);
    assert.match(startup, /pendingCertificateContextError[\s\S]*app\.quit\(\);[\s\S]*return;/);
    assert.match(startup, /if \(contextApplied\) removeCertificateManagerLaunchContext\(CERTIFICATE_MANAGER_CONTEXT_PATH\)/);
    const rendererStartup = certificateRenderer.slice(certificateRenderer.indexOf("window.appleDeveloper.launchContext().then"));
    assert.match(rendererStartup, /context\?\.appleId && browserBoundLaunch/);
    assert.match(rendererStartup, /window\.appleDeveloper\.autoLogin/);
    assert.match(rendererStartup, /await attemptBoundAutoLogin\(\)/);
  });
}
