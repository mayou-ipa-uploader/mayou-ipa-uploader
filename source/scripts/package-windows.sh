#!/usr/bin/env bash
set -euo pipefail

export COPYFILE_DISABLE=1

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$PROJECT_DIR"
DESKTOP_DIR="$PROJECT_DIR"
APP_NAME="${APP_NAME:-码友证书管理}"
BUNDLE_ID="${BUNDLE_ID:-com.mayou.certificate-manager}"
VERSION="${VERSION:-$(node -p "require('$PROJECT_DIR/package.json').version")}"
ARCH="${ARCH:-x64}"
DIST_DIR="$DESKTOP_DIR/dist"
BUILD_DIR="$DIST_DIR/build"
WIN_RUNTIME_DIR="$BUILD_DIR/electron-win32-$ARCH"
APP_DIR="$BUILD_DIR/${APP_NAME}-${VERSION}-win-$ARCH"
ZIP_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-win-$ARCH.zip"
INSTALLER_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-win-$ARCH.exe"
NSIS_SCRIPT="$DESKTOP_DIR/scripts/windows/installer.nsi"
DAEMON_EXE="$BUILD_DIR/ipauploader-daemon-windows-$ARCH.exe"
IS_CERTIFICATE_MANAGER=1
SOURCE_DIR="$PROJECT_DIR"
WINDOWS_RUNTIME_CACHE="$DESKTOP_DIR/build/windows-runtime-cache"
WINDOWS_PYTHON_VERSION="${WINDOWS_PYTHON_VERSION:-3.13.15}"
WINDOWS_PYTHON_URL="${WINDOWS_PYTHON_URL:-https://www.python.org/ftp/python/$WINDOWS_PYTHON_VERSION/python-$WINDOWS_PYTHON_VERSION-embed-amd64.zip}"
WINDOWS_JRE_URL="${WINDOWS_JRE_URL:-https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse}"
MAKENSIS_BIN="${MAKENSIS_BIN:-$(command -v makensis || true)}"
SIGNTOOL_BIN="${SIGNTOOL_BIN:-$(command -v signtool || true)}"
WINDOWS_SIGN_PFX="${WINDOWS_SIGN_PFX:-}"
WINDOWS_SIGN_PASSWORD="${WINDOWS_SIGN_PASSWORD:-}"

if [[ ! -d "$DESKTOP_DIR/node_modules/@electron/get" ]]; then
  echo "缺少 @electron/get，请先在证书管理桌面目录执行 npm install"
  exit 1
fi

if [[ -z "$MAKENSIS_BIN" || ! -x "$MAKENSIS_BIN" ]]; then
  echo "缺少 NSIS 打包工具 makensis。"
  echo "macOS 可执行: brew install makensis"
  exit 1
fi

if [[ ! -f "$NSIS_SCRIPT" ]]; then
  echo "缺少 Windows 安装器脚本: $NSIS_SCRIPT"
  exit 1
fi

mkdir -p "$BUILD_DIR" "$DIST_DIR"
rm -rf "$WIN_RUNTIME_DIR" "$APP_DIR" "$ZIP_PATH" "$INSTALLER_PATH"
mkdir -p "$WINDOWS_RUNTIME_CACHE"

download_cached() {
  local url="$1"
  local target="$2"
  if [[ -f "$target" ]]; then
    return
  fi
  local temporary="${target}.part"
  rm -f "$temporary"
  curl --fail --location --retry 3 --output "$temporary" "$url"
  mv "$temporary" "$target"
}

echo "下载 Windows Electron 运行时..."
if [[ -n "${ELECTRON_ZIP:-}" && -f "$ELECTRON_ZIP" ]]; then
  echo "使用指定的 Electron 缓存: $ELECTRON_ZIP"
else
ELECTRON_ZIP="$(NODE_PATH="$DESKTOP_DIR/node_modules" node <<'NODE'
const path = require("path");
const { downloadArtifact } = require("@electron/get");
const electronVersion = require("electron/package.json").version;
const arch = process.env.ARCH || "x64";
downloadArtifact({
  version: electronVersion,
  platform: "win32",
  arch,
  artifactName: "electron",
}).then(file => {
  console.log(file);
}).catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
NODE
)"
fi

mkdir -p "$WIN_RUNTIME_DIR"
ditto -x -k "$ELECTRON_ZIP" "$WIN_RUNTIME_DIR"
cp -R "$WIN_RUNTIME_DIR" "$APP_DIR"
mv "$APP_DIR/electron.exe" "$APP_DIR/${APP_NAME}.exe"

echo "写入 Windows 应用源码..."
APP_RESOURCES="$APP_DIR/resources"
rm -rf "$APP_RESOURCES/app"
mkdir -p "$APP_RESOURCES/app"
cp "$SOURCE_DIR/package.json" "$APP_RESOURCES/app/package.json"
cp -R "$SOURCE_DIR/src" "$APP_RESOURCES/app/src"
rm -f "$APP_RESOURCES/app/src/generate-apple-csr.py"
if [[ -f "$DESKTOP_DIR/apple-certificate-manager.config.json" ]]; then
  cp "$DESKTOP_DIR/apple-certificate-manager.config.json" "$APP_RESOURCES/app/apple-certificate-manager.config.json"
fi

mkdir -p "$APP_RESOURCES/app/node_modules"
PRODUCTION_DEPENDENCY_PATHS="$(cd "$DESKTOP_DIR" && npm ls --omit=dev --all --parseable)"
while IFS= read -r dependency_path; do
  [[ "$dependency_path" == "$DESKTOP_DIR" ]] && continue
  dependency_relative_path="${dependency_path#"$DESKTOP_DIR/node_modules/"}"
  if [[ "$dependency_relative_path" == "$dependency_path" ]]; then
    echo "无法解析生产依赖路径：$dependency_path"
    exit 1
  fi
  dependency_target="$APP_RESOURCES/app/node_modules/$dependency_relative_path"
  mkdir -p "$(dirname "$dependency_target")"
  cp -R "$dependency_path" "$dependency_target"
done <<< "$PRODUCTION_DEPENDENCY_PATHS"

echo "验证应用运行依赖..."
(
  cd "$APP_RESOURCES/app"
  node -e 'for (const name of Object.keys(require("./package.json").dependencies || {})) require(name)'
)

if [[ "$IS_CERTIFICATE_MANAGER" == "1" ]]; then
  touch "$APP_RESOURCES/app/.certificate-manager-standalone"
  APP_ICON_SOURCE="$ROOT_DIR/assets/app-icons/CertificateManagerIcon.ico"
else
  rm -f "$APP_RESOURCES/app/.certificate-manager-standalone"
  APP_ICON_SOURCE="$ROOT_DIR/assets/app-icons/CertificateManagerIcon.ico"
fi

if [[ ! -f "$APP_ICON_SOURCE" ]]; then
  echo "缺少 Windows 应用图标: $APP_ICON_SOURCE"
  exit 1
fi
cp "$APP_ICON_SOURCE" "$APP_RESOURCES/app.ico"

echo "交叉编译 Windows daemon..."
(cd "$ROOT_DIR/daemon" && GOOS=windows GOARCH=amd64 go build -o "$DAEMON_EXE" .)
mkdir -p "$APP_RESOURCES/daemon"
cp "$DAEMON_EXE" "$APP_RESOURCES/daemon/ipauploader-daemon.exe"

echo "写入 IPA 上传组件..."
UPLOADER_BIN="${UPLOADER_BIN:-$ROOT_DIR/uploader-bin/windows-x64/ipauploader-upload.exe}"
mkdir -p "$APP_RESOURCES/uploader-bin/windows-x64"
if [[ -f "$UPLOADER_BIN" ]]; then
  UPLOADER_RUNTIME_DIR="${UPLOADER_RUNTIME_DIR:-$(dirname "$UPLOADER_BIN")}"
  cp -R "$UPLOADER_RUNTIME_DIR"/. "$APP_RESOURCES/uploader-bin/windows-x64/"
else
  echo "未找到 Windows PyInstaller 上传程序，写入官方嵌入式 Python 上传运行时..."
  PYTHON_ZIP="$WINDOWS_RUNTIME_CACHE/python-$WINDOWS_PYTHON_VERSION-embed-amd64.zip"
  download_cached "$WINDOWS_PYTHON_URL" "$PYTHON_ZIP"
  PORTABLE_PYTHON_DIR="$APP_RESOURCES/uploader-bin/windows-x64/python"
  mkdir -p "$PORTABLE_PYTHON_DIR"
  ditto -x -k "$PYTHON_ZIP" "$PORTABLE_PYTHON_DIR"
  cp "$ROOT_DIR/uploader.py" "$PORTABLE_PYTHON_DIR/uploader.py"
  cp "$ROOT_DIR/appstore_providers.py" "$PORTABLE_PYTHON_DIR/appstore_providers.py"
  cp "$ROOT_DIR/appstore_upload_errors.py" "$PORTABLE_PYTHON_DIR/appstore_upload_errors.py"
  cp "$ROOT_DIR/transporter_locator.py" "$PORTABLE_PYTHON_DIR/transporter_locator.py"
  file "$PORTABLE_PYTHON_DIR/python.exe" | grep -q 'PE32'
fi

mkdir -p "$APP_RESOURCES/vendor/itms"
WINDOWS_ITMS_DIR="${WINDOWS_ITMS_DIR:-}"
if [[ -n "$WINDOWS_ITMS_DIR" && -d "$WINDOWS_ITMS_DIR" ]]; then
  cp -R "$WINDOWS_ITMS_DIR" "$APP_RESOURCES/vendor/itms/windows"
else
  echo "写入 Windows Transporter 与 Java 运行时..."
  WINDOWS_ITMS_TARGET="$APP_RESOURCES/vendor/itms/windows"
  mkdir -p "$WINDOWS_ITMS_TARGET/bin"
  bash "$ROOT_DIR/scripts/build-upload-guard.sh"
  rsync -a --exclude 'java/' --exclude 'bin/iTMSTransporter' "$ROOT_DIR/vendor/itms/" "$WINDOWS_ITMS_TARGET/"
  cp "$DESKTOP_DIR/scripts/windows/iTMSTransporter.cmd" "$WINDOWS_ITMS_TARGET/bin/iTMSTransporter.cmd"
  WINDOWS_JRE_ZIP="$WINDOWS_RUNTIME_CACHE/temurin-jre-21-windows-x64.zip"
  WINDOWS_JRE_EXTRACT="$BUILD_DIR/windows-jre-extract"
  download_cached "$WINDOWS_JRE_URL" "$WINDOWS_JRE_ZIP"
  rm -rf "$WINDOWS_JRE_EXTRACT"
  mkdir -p "$WINDOWS_JRE_EXTRACT"
  ditto -x -k "$WINDOWS_JRE_ZIP" "$WINDOWS_JRE_EXTRACT"
  WINDOWS_JAVA_EXE="$(find "$WINDOWS_JRE_EXTRACT" -type f -path '*/bin/java.exe' -print -quit)"
  if [[ -z "$WINDOWS_JAVA_EXE" ]]; then
    echo "Windows Java 运行时不完整：未找到 java.exe"
    exit 1
  fi
  WINDOWS_JAVA_HOME="$(dirname "$(dirname "$WINDOWS_JAVA_EXE")")"
  mkdir -p "$WINDOWS_ITMS_TARGET/java"
  cp -R "$WINDOWS_JAVA_HOME"/. "$WINDOWS_ITMS_TARGET/java/"
  file "$WINDOWS_ITMS_TARGET/java/bin/java.exe" | grep -q 'PE32'
fi

echo "写入启动脚本..."
cat > "$APP_DIR/启动 ${APP_NAME}.cmd" <<EOF
@echo off
cd /d "%~dp0"
start "" "${APP_NAME}.exe"
EOF
cat > "$APP_DIR/README-Windows.txt" <<EOF
${APP_NAME} ${VERSION} Windows ${ARCH}

使用方法：
1. 解压整个文件夹。
2. 双击“启动 ${APP_NAME}.cmd”或 ${APP_NAME}.exe 启动。

说明：
- 已包含 Windows Electron 运行时和本地 daemon.exe。
- 已包含独立 IPA 上传程序、Java 和 Windows 版 Transporter，不依赖系统安装的 Python 或 Java。
EOF

echo "生成 Windows ZIP..."
(cd "$BUILD_DIR" && zip -qry -X "$ZIP_PATH" "$(basename "$APP_DIR")")

echo "生成 Windows 安装器..."
"$MAKENSIS_BIN" \
  "-DAPP_NAME=$APP_NAME" \
  "-DAPP_VERSION=$VERSION" \
  "-DAPP_ARCH=$ARCH" \
  "-DAPP_ID=$BUNDLE_ID" \
  "-DAPP_EXE=$APP_NAME.exe" \
  "-DAPP_SOURCE_DIR=$APP_DIR" \
  "-DAPP_ICON=$APP_ICON_SOURCE" \
  "-DOUTPUT_FILE=$INSTALLER_PATH" \
  "$NSIS_SCRIPT"

if [[ -n "$WINDOWS_SIGN_PFX" ]]; then
  [[ -n "$SIGNTOOL_BIN" && -x "$SIGNTOOL_BIN" ]] || { echo "已配置 WINDOWS_SIGN_PFX，但找不到 signtool。" >&2; exit 1; }
  [[ -f "$WINDOWS_SIGN_PFX" ]] || { echo "签名证书不存在：$WINDOWS_SIGN_PFX" >&2; exit 1; }
  "$SIGNTOOL_BIN" sign /fd sha256 /f "$WINDOWS_SIGN_PFX" /p "$WINDOWS_SIGN_PASSWORD" /tr http://timestamp.digicert.com /td sha256 "$INSTALLER_PATH"
else
  echo "警告：未配置 WINDOWS_SIGN_PFX，生成的 EXE 未签名，Windows SmartScreen 可能拦截。"
fi

echo "完成:"
echo "  AppDir: $APP_DIR"
echo "  Installer: $INSTALLER_PATH"
echo "  ZIP: $ZIP_PATH"
