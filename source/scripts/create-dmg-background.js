const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const outputPath = process.argv[2];
const iconPath = process.argv[3] || "";
const appName = process.argv[4] || "IPAUploader";

if (!outputPath) {
  console.error("Usage: electron create-dmg-background.js <output.png> [icon.png]");
  process.exit(1);
}

function fileURL(filePath) {
  return `file://${path.resolve(filePath).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function iconHTML() {
  if (iconPath && fs.existsSync(iconPath)) {
    return `<img class="app-logo" src="${fileURL(iconPath)}" />`;
  }
  return `<div class="app-logo fallback-logo">码尚友</div>`;
}

function html() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    width: 1440px;
    height: 900px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    color: #1f2329;
    background:
      radial-gradient(circle at 50% 44%, rgba(226, 235, 247, 0.85), rgba(255,255,255,0) 34%),
      linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  }
  .wrap {
    width: 100%;
    height: 100%;
    position: relative;
    padding-top: 142px;
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: 66px;
    line-height: 1.2;
    font-weight: 800;
    letter-spacing: 0;
  }
  .subtitle {
    margin-top: 24px;
    font-size: 28px;
    color: #5f6570;
  }
  .install-row {
    position: absolute;
    top: 365px;
    left: 0;
    right: 0;
    height: 310px;
  }
  .app-tile, .folder-tile {
    position: absolute;
    top: 0;
    width: 270px;
    text-align: center;
  }
  .app-tile { left: 230px; }
  .folder-tile { right: 230px; }
  .app-card {
    width: 265px;
    height: 265px;
    border-radius: 34px;
    background: rgba(255,255,255,0.78);
    border: 1px solid rgba(210, 216, 226, 0.95);
    box-shadow: 0 22px 55px rgba(31, 43, 69, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .app-logo {
    width: 205px;
    height: 205px;
    object-fit: contain;
  }
  .fallback-logo {
    color: #2a7ed2;
    border: 10px solid #2a7ed2;
    border-radius: 50%;
    font-size: 44px;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .label {
    margin-top: 22px;
    font-size: 30px;
    line-height: 1;
    color: #050505;
    font-weight: 600;
  }
  .arrow {
    position: absolute;
    top: 86px;
    left: 562px;
    width: 320px;
    height: 78px;
    background: linear-gradient(90deg, rgba(73, 138, 247, 0), #3f89f7);
    filter: drop-shadow(0 16px 24px rgba(60, 130, 247, 0.25));
  }
  .arrow::after {
    content: "";
    position: absolute;
    right: -74px;
    top: -44px;
    width: 0;
    height: 0;
    border-top: 83px solid transparent;
    border-bottom: 83px solid transparent;
    border-left: 84px solid #3f89f7;
  }
  .folder {
    width: 265px;
    height: 205px;
    margin-top: 32px;
    border-radius: 18px;
    position: relative;
    background: linear-gradient(180deg, #72cef8 0%, #35a9e9 100%);
    box-shadow: inset 0 0 0 1px rgba(17, 110, 172, 0.16), 0 18px 36px rgba(31, 98, 154, 0.22);
  }
  .folder::before {
    content: "";
    position: absolute;
    left: 0;
    top: -20px;
    width: 118px;
    height: 48px;
    border-radius: 16px 22px 0 0;
    background: linear-gradient(180deg, #4db8f3, #35a9e9);
  }
  .folder::after {
    content: "A";
    position: absolute;
    left: 85px;
    top: 42px;
    font-size: 104px;
    line-height: 1;
    font-weight: 800;
    color: rgba(19, 123, 185, 0.42);
    font-family: "Helvetica Neue", Arial, sans-serif;
  }
  .hint {
    position: absolute;
    left: 270px;
    right: 270px;
    bottom: 68px;
    height: 88px;
    border: 3px dashed #d4d9e2;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 22px;
    color: #606773;
    font-size: 25px;
    background: rgba(255,255,255,0.45);
  }
  .info {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: white;
    background: #428af7;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>安装 ${appName}</h1>
    <div class="subtitle">请将左侧的 ${appName} 拖动到右侧的 Applications 文件夹中</div>
    <div class="install-row">
      <div class="app-tile">
        <div class="app-card">${iconHTML()}</div>
        <div class="label">${appName}</div>
      </div>
      <div class="arrow"></div>
      <div class="folder-tile">
        <div class="folder"></div>
        <div class="label">Applications</div>
      </div>
    </div>
    <div class="hint"><span class="info">i</span><span>安装完成后，您可以在“应用程序”文件夹中找到该应用</span></div>
  </div>
</body>
</html>`;
}

app.commandLine.appendSwitch("disable-gpu");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const image = await win.capturePage();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, image.toPNG());
  app.quit();
});
