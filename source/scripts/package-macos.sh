#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$PROJECT_DIR"
DESKTOP_DIR="$PROJECT_DIR"
APP_NAME="${APP_NAME:-码友证书管理}"
BUNDLE_ID="${BUNDLE_ID:-com.mayou.certificate-manager}"
VARIANT="${VARIANT:-}"
VERSION="${VERSION:-$(node -p "require('$PROJECT_DIR/package.json').version")}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-}"
DIST_DIR="$DESKTOP_DIR/dist"
BUILD_DIR="$DIST_DIR/build"
APP_PATH="$BUILD_DIR/$APP_NAME.app"
DMG_STAGING_DIR="$BUILD_DIR/dmg"
DMG_RW_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-mac-arm64-rw.dmg"
ELECTRON_APP="$DESKTOP_DIR/node_modules/electron/dist/Electron.app"
DAEMON_BIN="$ROOT_DIR/daemon/ipauploader-daemon"
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-mac-arm64.dmg"
ZIP_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-mac-arm64.zip"
BACKGROUND_PATH="$DMG_STAGING_DIR/.background/background.png"
IS_TEST_VARIANT=0
SOURCE_DIR="$PROJECT_DIR"

if [[ "$VARIANT" == "sync-test" || "$VARIANT" == "test" ]]; then
  IS_TEST_VARIANT=1
fi

if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "缺少 Electron.app，请先在证书管理桌面目录执行 npm install"
  exit 1
fi

if [[ ! -x "$DAEMON_BIN" ]]; then
  echo "缺少 daemon 二进制: $DAEMON_BIN"
  echo "请先执行: cd daemon && go build -o ipauploader-daemon ."
  exit 1
fi

mkdir -p "$BUILD_DIR"
find "$BUILD_DIR" -mindepth 1 -maxdepth 1 \( -name '*.app' -o -name 'dmg' \) -exec rm -rf {} +
rm -rf "$APP_PATH" "$DMG_STAGING_DIR" "$DMG_PATH" "$DMG_RW_PATH" "$ZIP_PATH"

echo "复制 Electron.app..."
cp -R "$ELECTRON_APP" "$APP_PATH"

echo "写入应用源码..."
APP_RESOURCES="$APP_PATH/Contents/Resources"
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
if [[ "$IS_TEST_VARIANT" == "1" ]]; then
  touch "$APP_RESOURCES/app/.sync-test-variant"
else
  rm -f "$APP_RESOURCES/app/.sync-test-variant"
fi

echo "打包模式：$([[ "$IS_TEST_VARIANT" == "1" ]] && echo '测试包' || echo '正式包')"

echo "写入 daemon..."
mkdir -p "$APP_RESOURCES/daemon"
cp "$DAEMON_BIN" "$APP_RESOURCES/daemon/ipauploader-daemon"
chmod +x "$APP_RESOURCES/daemon/ipauploader-daemon"

echo "浏览器内核改为登录后按需从服务器下载，不写入安装包。"

echo "精简主程序 Electron 语言资源..."
ELECTRON_LOCALE_ROOT="$APP_PATH/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
for locale_dir in "$ELECTRON_LOCALE_ROOT"/*.lproj; do
  case "$(basename "$locale_dir")" in
    en.lproj|zh_CN.lproj|zh_TW.lproj) ;;
    *) rm -rf "$locale_dir" ;;
  esac
done

echo "写入 IPA 上传组件..."
bash "$ROOT_DIR/scripts/build-upload-guard.sh"
UPLOADER_TARGET="macos-$(uname -m)"
UPLOADER_BIN="$ROOT_DIR/uploader-bin/$UPLOADER_TARGET/ipauploader-upload"
if [[ ! -f "$UPLOADER_BIN" ]]; then
  echo "缺少内置上传执行程序：$UPLOADER_BIN"
  echo "请把对应平台的上传器放入 $ROOT_DIR/uploader-bin/$UPLOADER_TARGET/"
  exit 1
fi
mkdir -p "$APP_RESOURCES/uploader-bin/$UPLOADER_TARGET"
cp "$UPLOADER_BIN" "$APP_RESOURCES/uploader-bin/$UPLOADER_TARGET/ipauploader-upload"
chmod +x "$APP_RESOURCES/uploader-bin/$UPLOADER_TARGET/ipauploader-upload"
JAVA_BIN="$ROOT_DIR/vendor/itms/java/bin/java"
JAVA_FILE_INFO="$(file "$JAVA_BIN")"
case "$(uname -m)" in
  arm64)
    [[ "$JAVA_FILE_INFO" == *"arm64"* ]] || { echo "内置 Java 不是 arm64，不能生成当前 Mac 的可用安装包。"; exit 1; }
    ;;
  x86_64)
    [[ "$JAVA_FILE_INFO" == *"x86_64"* || "$JAVA_FILE_INFO" == *"universal"* ]] || { echo "内置 Java 不是 x86_64，不能生成 Intel Mac 的可用安装包。"; exit 1; }
    ;;
esac
rm -rf "$APP_RESOURCES/vendor/itms"
mkdir -p "$APP_RESOURCES/vendor"
cp -R "$ROOT_DIR/vendor/itms" "$APP_RESOURCES/vendor/itms"
chmod +x "$APP_RESOURCES/vendor/itms/bin/iTMSTransporter"
chmod +x "$APP_RESOURCES/vendor/itms/java/bin/java"

APP_ICON_SOURCE="$ROOT_DIR/assets/app-icons/CertificateManagerIcon.icns"
APP_ICON_PNG_SOURCE="$ROOT_DIR/assets/app-icons/CertificateManagerIcon.png"
if [[ ! -f "$APP_ICON_SOURCE" || ! -f "$APP_ICON_PNG_SOURCE" ]]; then
  echo "缺少应用图标资源：$APP_ICON_SOURCE 或 $APP_ICON_PNG_SOURCE"
  exit 1
fi
cp "$APP_ICON_SOURCE" "$APP_RESOURCES/AppIcon.icns"
cp "$APP_ICON_PNG_SOURCE" "$APP_RESOURCES/AppIcon.png"

PLIST="$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST"
if [[ "$BUNDLE_ID" == "com.mayou.certificate-manager" || "$APP_NAME" == "码友证书管理" ]]; then
  touch "$APP_RESOURCES/app/.certificate-manager-standalone"
  /usr/libexec/PlistBuddy -c "Set :MayouCertificateManagerProtocolVersion 1" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :MayouCertificateManagerProtocolVersion integer 1" "$PLIST"
else
  rm -f "$APP_RESOURCES/app/.certificate-manager-standalone"
fi
if [[ -f "$APP_RESOURCES/AppIcon.icns" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AppIcon.icns" "$PLIST" || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string AppIcon.icns" "$PLIST"
fi

echo "移除隔离属性..."
find "$APP_PATH" -exec xattr -c {} \; 2>/dev/null || true

echo "签名应用..."
if [[ -z "$CODESIGN_IDENTITY" ]]; then
  CODESIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '/"Apple Development:/{print $2; exit}')"
fi
if [[ -n "$CODESIGN_IDENTITY" ]]; then
  echo "使用稳定签名身份: $CODESIGN_IDENTITY"
  echo "逐层签名 Mach-O 文件..."
  while IFS= read -r -d '' nested_file; do
    if file "$nested_file" | grep -q 'Mach-O'; then
      codesign --force --timestamp=none --sign "$CODESIGN_IDENTITY" "$nested_file"
    fi
  done < <(find "$APP_PATH/Contents" -type f -print0)
  echo "逐层签名嵌套 Bundle..."
  while IFS= read -r -d '' nested_bundle; do
    codesign --force --timestamp=none --sign "$CODESIGN_IDENTITY" "$nested_bundle"
  done < <(find "$APP_PATH/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0)
  codesign --force --timestamp=none --sign "$CODESIGN_IDENTITY" "$APP_PATH"
else
  echo "警告：未找到有效代码签名证书，回退到 ad-hoc 签名；钥匙串授权可能在更新后重新询问。"
  codesign --force --deep --sign - "$APP_PATH"
fi

echo "生成 DMG 背景图..."
mkdir -p "$DMG_STAGING_DIR"
mkdir -p "$DMG_STAGING_DIR/.background"
env -u ELECTRON_RUN_AS_NODE "$DESKTOP_DIR/node_modules/.bin/electron" \
  "$DESKTOP_DIR/scripts/create-dmg-background.js" \
  "$BACKGROUND_PATH" \
  "$APP_ICON_PNG_SOURCE" \
  "$APP_NAME"

cp -R "$APP_PATH" "$DMG_STAGING_DIR/$APP_NAME.app"
ln -s /Applications "$DMG_STAGING_DIR/Applications"

echo "生成临时可写 DMG..."
if ! hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$DMG_STAGING_DIR" \
  -ov \
  -fs HFS+ \
  -format UDRW \
  "$DMG_RW_PATH"
then
  echo "警告：系统暂时无法创建 DMG，改为生成可直接解压安装的 ZIP。"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$ZIP_PATH"
  echo "完成:"
  echo "  App: $APP_PATH"
  echo "  ZIP: $ZIP_PATH"
  exit 0
fi

MOUNT_DIR=""
cleanup() {
  if [[ -n "$MOUNT_DIR" && -d "$MOUNT_DIR" ]]; then
    hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "设置 DMG Finder 界面..."
ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$DMG_RW_PATH")"
MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/")); exit}')"
if [[ -z "$MOUNT_DIR" ]]; then
  echo "挂载临时 DMG 失败"
  exit 1
fi

if osascript <<OSA
tell application "Finder"
  set dmgFolder to (POSIX file "$MOUNT_DIR" as alias)
  open dmgFolder
  delay 1
  set win to container window of dmgFolder
  set current view of win to icon view
  try
    set toolbar visible of win to false
  end try
  try
    set statusbar visible of win to false
  end try
  set the bounds of win to {120, 80, 1560, 980}
  set viewOptions to the icon view options of win
  set arrangement of viewOptions to not arranged
  set icon size of viewOptions to 132
  set background picture of viewOptions to (POSIX file "$MOUNT_DIR/.background/background.png" as alias)
  set position of item "$APP_NAME.app" of win to {360, 540}
  set position of item "Applications" of win to {1080, 540}
  update dmgFolder without registering applications
  delay 2
  close win
end tell
OSA
then
  echo "Finder 外观设置完成。"
else
  echo "警告：Finder 外观设置失败，将继续生成标准 DMG。"
fi

sync
if [[ ! -f "$MOUNT_DIR/.DS_Store" ]]; then
  echo "警告：Finder 没有写入 .DS_Store，背景图可能无法显示。"
else
  echo "Finder 背景设置已写入 .DS_Store。"
fi
cleanup
trap - EXIT

echo "压缩最终 DMG..."
hdiutil convert "$DMG_RW_PATH" -format UDZO -imagekey zlib-level=9 -ov -o "$DMG_PATH"
rm -f "$DMG_RW_PATH"
rm -rf "$DMG_STAGING_DIR"

echo "完成:"
echo "  App: $APP_PATH"
echo "  DMG: $DMG_PATH"
