from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Callable, Union
from urllib.parse import quote

from appstore_providers import parse_asc_providers
from appstore_upload_errors import extract_appstore_upload_error
from transporter_locator import resolve_transporter

UploadEvent = dict[str, str]
EventCallback = Callable[[str, str], None]
ProxyConfig = dict[str, Union[str, bool]]


def transporter_command(transporter_path: str, *args: str) -> list[str]:
    """Build a launcher command that also works for Windows batch files."""
    suffix = Path(transporter_path).suffix.lower()
    if os.name == "nt" and suffix in {".cmd", ".bat"}:
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", transporter_path, *args]
    return [transporter_path, *args]


def output_indicates_failure(logs: str) -> bool:
    if not logs:
        return False
    lower = logs.lower()
    failure_markers = (
        "failed to upload package",
        "failed to upload archive",
        "upload failed",
        "error uploading",
        "delivery failed",
        "validation failed",
        "exitfailure",
        "this bundle is invalid",
    )
    return any(marker in lower for marker in failure_markers) or bool(re.search(r"\bERROR:\s", logs))


def output_indicates_success(logs: str) -> bool:
    """Require Transporter's final delivery confirmation, not a zero exit alone."""
    return bool(re.search(
        r"UPLOAD SUCCEEDED|uploaded successfully|successfully uploaded|delivery succeeded|"
        r"package upload successful|upload complete(?:d)? successfully|no errors uploading",
        logs,
        re.IGNORECASE,
    ))


def password_env_arg(password: str) -> tuple[str, dict[str, str]]:
    env_name = f"APPSTORE_UPLOAD_PASSWORD_{uuid.uuid4().hex.upper()}"
    env = os.environ.copy()
    env[env_name] = password
    return f"@env:{env_name}", env


def clear_proxy_env(env: dict[str, str]) -> None:
    for name in (
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ):
        env.pop(name, None)


def apply_proxy_env(env: dict[str, str], proxy: ProxyConfig | None) -> str:
    clear_proxy_env(env)
    if not proxy or not proxy.get("enabled"):
        return ""

    proxy_type = str(proxy.get("type") or "http").lower()
    host = str(proxy.get("host") or "").strip()
    port = str(proxy.get("port") or "").strip()
    username = str(proxy.get("username") or "").strip()
    password = str(proxy.get("password") or "").strip()

    if not host or not port:
        raise ValueError("代理已启用，但代理地址或端口为空。")
    if not port.isdigit():
        raise ValueError("代理端口必须是数字。")
    if proxy_type not in {"http", "socks5"}:
        raise ValueError("代理类型只支持 HTTP 或 SOCKS5。")

    auth = ""
    if username:
        auth = quote(username, safe="")
        if password:
            auth += f":{quote(password, safe='')}"
        auth += "@"

    proxy_url = f"{proxy_type}://{auth}{host}:{port}"
    if proxy_type == "http":
        env["http_proxy"] = proxy_url
        env["https_proxy"] = proxy_url
        env["HTTP_PROXY"] = proxy_url
        env["HTTPS_PROXY"] = proxy_url
    else:
        env["all_proxy"] = proxy_url
        env["ALL_PROXY"] = proxy_url
    return proxy_type.upper()


def collect_new_transporter_logs(log_files_before: set[str]) -> str:
    log_dirs = [Path.home() / ".itmstransporter", Path(tempfile.gettempdir())]
    collected: list[str] = []
    for log_dir in log_dirs:
        if not log_dir.exists():
            continue
        try:
            log_files = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        for item in log_files:
            if str(item) in log_files_before:
                continue
            try:
                content = item.read_text(errors="replace").strip()
            except OSError:
                continue
            if content:
                collected.append(f"--- {item.name} ---\n{content}")
    return "\n\n".join(collected)


def snapshot_transporter_logs() -> set[str]:
    before: set[str] = set()
    for log_dir in [Path.home() / ".itmstransporter", Path(tempfile.gettempdir())]:
        if not log_dir.exists():
            continue
        try:
            before.update(str(item) for item in log_dir.glob("*.log"))
        except OSError:
            pass
    return before


def classify_line(line: str) -> str:
    lower = line.lower()
    if "no errors uploading" in lower:
        return "success"
    if "error" in lower or "failed" in lower:
        return "error"
    if "success" in lower or "uploaded successfully" in lower or "delivery succeeded" in lower:
        return "success"
    if "warning" in lower:
        return "warning"
    if "upload" in lower or "progress" in lower or "%" in lower:
        return "progress"
    return "info"


class AppStoreProviderError(Exception):
    pass


def inspect_ipa_info(ipa_path: str) -> dict[str, str]:
    info = {
        "bundle_id": "",
        "version": "",
        "build": "",
        "app_name": Path(ipa_path).stem,
        "team_id": "",
        "application_identifier": "",
        "warning": "",
    }
    try:
        with zipfile.ZipFile(ipa_path, "r") as archive:
            app_prefix = ""
            for name in archive.namelist():
                match = re.match(r"^(Payload/[^/]+\.app/)Info\.plist$", name)
                if match:
                    app_prefix = match.group(1)
                    break
            if not app_prefix:
                info["warning"] = "未找到 Payload/*.app/Info.plist，无法根据 Bundle ID 自动匹配 Provider。"
                return info
            with archive.open(f"{app_prefix}Info.plist") as fp:
                plist = plistlib.load(fp)
            if not isinstance(plist, dict):
                info["warning"] = "Info.plist 内容不是标准字典，无法根据 Bundle ID 自动匹配 Provider。"
                return info
            info.update({
                "bundle_id": str(plist.get("CFBundleIdentifier") or "").strip(),
                "version": str(plist.get("CFBundleShortVersionString") or "").strip(),
                "build": str(plist.get("CFBundleVersion") or "").strip(),
                "app_name": str(
                    plist.get("CFBundleDisplayName")
                    or plist.get("CFBundleName")
                    or plist.get("CFBundleExecutable")
                    or info["app_name"]
                ).strip(),
            })
            profile_name = ""
            profile_data = None
            for name in archive.namelist():
                match = re.match(r"^(Payload/[^/]+\.app/)embedded\.mobileprovision$", name)
                if match:
                    profile_name = match.group(1)
                    break
            if profile_name:
                with archive.open(f"{profile_name}embedded.mobileprovision") as fp:
                    profile_data = fp.read()
            if profile_data:
                decoded = _decode_mobileprovision(profile_data)
                team_ids = decoded.get("TeamIdentifier") or []
                if isinstance(team_ids, (list, tuple)) and team_ids:
                    info["team_id"] = str(team_ids[0] or "").strip()
                entitlements = decoded.get("Entitlements") or {}
                app_identifier = str(
                    entitlements.get("application-identifier")
                    or entitlements.get("com.apple.application-identifier")
                    or ""
                ).strip()
                if app_identifier:
                    info["application_identifier"] = app_identifier
    except zipfile.BadZipFile:
        info["warning"] = "IPA 文件不是有效的 zip 包，无法自动匹配 Provider。"
    except plistlib.InvalidFileException:
        info["warning"] = "Info.plist 解析失败，无法自动匹配 Provider。"
    except Exception as exc:
        info["warning"] = f"IPA 基础信息解析失败：{exc}"
    return info


def validate_ipa_bundle_versions(ipa_path: str) -> None:
    """Catch invalid bundle versions before Transporter can report a false success."""
    bundle_info = re.compile(
        r"^Payload/.*\.(?:app|appex|framework|bundle|xpc)/"
        r"(?:(?:Versions/[^/]+/)?Resources/|Contents/)?Info\.plist$"
    )
    valid_version = re.compile(r"[0-9]+(?:\.[0-9]+){0,2}")
    with zipfile.ZipFile(ipa_path) as archive:
        for member in archive.namelist():
            if not bundle_info.fullmatch(member):
                continue
            try:
                with archive.open(member) as source:
                    info = plistlib.load(source)
            except (OSError, plistlib.InvalidFileException, ValueError) as exc:
                raise ValueError(f"IPA 内的 {member} 无法解析：{exc}") from exc
            version = info.get("CFBundleShortVersionString") if isinstance(info, dict) else None
            if version is not None and (not isinstance(version, str) or not valid_version.fullmatch(version)):
                raise ValueError(
                    f"IPA 校验失败：{member} 的 CFBundleShortVersionString 为 {version!r}，"
                    "必须是用句点分隔的最多三段非负整数（例如 1.8.3）。"
                    "请修正对应框架并重新打包、签名 IPA 后上传。"
                )


def _decode_mobileprovision(profile_data: bytes) -> dict:
    # A mobileprovision is a CMS envelope containing an XML plist. The plist
    # payload is readable without OpenSSL, which keeps the Windows uploader
    # independent from system tools. macOS security remains a compatibility
    # fallback for profiles that do not expose the XML payload directly.
    xml_start = profile_data.find(b"<?xml")
    xml_end = profile_data.find(b"</plist>", xml_start if xml_start >= 0 else 0)
    if xml_start >= 0 and xml_end >= xml_start:
        xml_end += len(b"</plist>")
        try:
            return plistlib.loads(profile_data[xml_start:xml_end])
        except plistlib.InvalidFileException:
            pass

    if os.name == "nt":
        raise RuntimeError("embedded.mobileprovision 中未找到可解析的 plist 内容")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mobileprovision") as tmp:
        tmp.write(profile_data)
        temp_path = tmp.name
    try:
        # Transporter runs with an account-isolated HOME, but macOS security
        # looks up the default keychain from HOME. Keep that lookup on the
        # real user profile while leaving Transporter itself isolated.
        security_env = os.environ.copy()
        real_home = str(security_env.get("IPAUPLOADER_REAL_HOME") or "").strip()
        if real_home:
            security_env["HOME"] = real_home
            security_env["USERPROFILE"] = real_home
        result = subprocess.run(
            ["/usr/bin/security", "cms", "-D", "-i", temp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=security_env,
        )
        if result.returncode != 0:
            message = (result.stderr or b"").decode(errors="replace").strip()
            raise RuntimeError(message or "embedded.mobileprovision 解析失败")
        return plistlib.loads(result.stdout)
    finally:
        try:
            Path(temp_path).unlink(missing_ok=True)
        except OSError:
            pass


def run_transporter_capture(
    cmd: list[str],
    password: str,
    proxy: ProxyConfig | None,
    timeout: int,
) -> tuple[int, str]:
    password_arg, env = password_env_arg(password)
    final_cmd = [password_arg if item == "{PASSWORD}" else item for item in cmd]
    apply_proxy_env(env, proxy)
    result = subprocess.run(
        final_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
        timeout=timeout,
    )
    return result.returncode, result.stdout or ""


def lookup_asc_providers(
    transporter_path: str,
    apple_id: str,
    password: str,
    proxy: ProxyConfig | None,
) -> list[str]:
    cmd = transporter_command(
        transporter_path,
        "-m", "provider",
        "-u", apple_id,
        "-p", "{PASSWORD}",
        "-account_type", "itunes_connect",
        "-v", "informational",
    )
    try:
        return_code, logs = run_transporter_capture(cmd, password, proxy, timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise AppStoreProviderError("自动识别上传团队超时，请稍后重试。") from exc
    except Exception as exc:
        raise AppStoreProviderError(f"自动识别上传团队失败：{exc}") from exc

    if return_code != 0:
        reason = extract_appstore_upload_error(logs)
        raise AppStoreProviderError(reason or "自动识别上传团队失败。")

    providers = parse_asc_providers(logs)
    if not providers:
        raise AppStoreProviderError("已登录 Apple，但没有识别到可用上传团队。请确认该账号有 App Store Connect 团队权限。")
    return providers


def provider_probe_state(return_code: int, logs: str) -> str:
    lower = (logs or "").lower()
    mismatch_patterns = (
        r"no suitable application records",
        r"could not find.*app",
        r"unable to find.*app",
        r"no app record",
        r"bundle identifier.*(not|doesn't|does not|invalid)",
        r"not associated with.*provider",
        r"provider.*not found",
        r"not.*valid provider",
        r"unable to authenticate for provider",
        r"does not have access",
        r"not authorized",
        r"authorization failed",
    )
    if any(re.search(pattern, lower, re.S) for pattern in mismatch_patterns):
        return "mismatch"
    if return_code == 0:
        return "match"
    validation_markers = (
        "error itms-",
        "validation failed",
        "irisapi",
        "cfbundleversion",
        "previousbundleversion",
        "missing app icon",
        "asset validation failed",
        "upload failed",
    )
    if any(marker in lower for marker in validation_markers):
        return "match"
    return "unknown"


def probe_provider_for_bundle(
    transporter_path: str,
    ipa_path: str,
    apple_id: str,
    password: str,
    provider: str,
    proxy: ProxyConfig | None,
) -> tuple[str, str]:
    cmd = transporter_command(
        transporter_path,
        "-m", "verify",
        "-assetFile", ipa_path,
        "-u", apple_id,
        "-p", "{PASSWORD}",
        "-asc_provider", provider,
        "-v", "informational",
    )
    try:
        return_code, logs = run_transporter_capture(cmd, password, proxy, timeout=180)
    except subprocess.TimeoutExpired:
        return "unknown", "验证超时"
    except Exception as exc:
        return "unknown", f"验证异常：{exc}"
    return provider_probe_state(return_code, logs), extract_appstore_upload_error(logs)


def resolve_asc_provider(
    transporter_path: str,
    ipa_path: str,
    apple_id: str,
    password: str,
    asc_provider: str,
    proxy: ProxyConfig | None,
    emit: EventCallback | None,
) -> str:
    manual_provider = (asc_provider or "").strip()
    if manual_provider:
        return manual_provider

    def log(level: str, message: str) -> None:
        if emit:
            emit(level, message)

    ipa_info = inspect_ipa_info(ipa_path)
    bundle_id = ipa_info.get("bundle_id") or ""
    team_id = ipa_info.get("team_id") or ""
    if ipa_info.get("warning"):
        log("warning", ipa_info["warning"])
    if bundle_id:
        version = ipa_info.get("version") or "-"
        build = ipa_info.get("build") or "-"
        log("info", f"已解析 IPA：Bundle ID={bundle_id}，版本={version}，Build={build}")
    if team_id:
        log("info", f"已解析 IPA 签名团队：Team ID={team_id}")
    app_identifier = ipa_info.get("application_identifier") or ""
    if app_identifier:
        log("info", f"已解析 IPA 应用标识：{app_identifier}")

    log("info", "正在通过内置安全上传组件查询账号可用上传团队...")
    providers = lookup_asc_providers(transporter_path, apple_id, password, proxy)
    if team_id:
        exact_matches = [provider for provider in providers if provider.strip().upper() == team_id.strip().upper()]
        if len(exact_matches) == 1:
            log("info", f"已根据 IPA 签名团队自动识别上传团队：{exact_matches[0]}")
            return exact_matches[0]
        if not exact_matches:
            raise AppStoreProviderError(
                "已从 IPA 中识别到签名团队 "
                f"{team_id}，但当前账号可用上传团队为：{', '.join(providers) or '（空）'}。"
                "请切换到对应 Apple Developer 团队，或使用当前团队重新签名 IPA 后再上传。"
            )

    if len(providers) == 1:
        log("info", f"已自动识别上传团队：{providers[0]}")
        return providers[0]

    if not bundle_id:
        raise AppStoreProviderError(
            "账号关联多个上传团队，但当前 IPA 未能解析出 Bundle ID，无法自动确定 Provider。"
            f"候选团队：{'、'.join(providers)}。"
        )

    log("info", f"账号关联多个 Provider，正在根据 Bundle ID {bundle_id} 自动匹配...")
    matches: list[str] = []
    unknown: list[str] = []
    for provider in providers:
        log("info", f"尝试匹配 Provider：{provider}")
        state, reason = probe_provider_for_bundle(transporter_path, ipa_path, apple_id, password, provider, proxy)
        if state == "match":
            matches.append(provider)
            log("info", f"Provider {provider} 与当前 Bundle ID 匹配")
        elif state == "mismatch":
            log("info", f"Provider {provider} 不匹配")
        else:
            unknown.append(provider)
            log("warning", f"Provider {provider} 无法确认：{(reason or '未知原因').splitlines()[0]}")

    if len(matches) == 1:
        log("info", f"已根据 Bundle ID 自动识别上传团队：{matches[0]}")
        return matches[0]
    if len(matches) > 1:
        raise AppStoreProviderError(f"根据 Bundle ID 匹配到多个上传团队，无法安全自动选择：{'、'.join(matches)}。")
    if len(unknown) == 1 and len(providers) > 1:
        raise AppStoreProviderError(f"未能可靠确认上传团队。候选值：{unknown[0]}，请确认该账号是否有当前 App 的上传权限。")
    raise AppStoreProviderError(
        "无法根据当前 IPA 的 Bundle ID 自动确定 Provider。"
        f"已查询到的团队标识：{'、'.join(providers)}。"
    )


def upload_ipa(
    ipa_path: str,
    apple_id: str,
    password: str,
    *,
    asc_provider: str = "",
    proxy: ProxyConfig | None = None,
    on_event: EventCallback | None = None,
) -> tuple[bool, str]:
    """Upload an IPA with the bundled iTMSTransporter."""

    def emit(level: str, message: str) -> None:
        if on_event:
            on_event(level, message)

    log_files_before = snapshot_transporter_logs()
    logs_parts: list[str] = []

    validate_ipa_bundle_versions(ipa_path)

    transporter = resolve_transporter()
    asc_provider = resolve_asc_provider(
        str(transporter.path),
        ipa_path,
        apple_id,
        password,
        asc_provider,
        proxy,
        on_event,
    )
    password_arg, env = password_env_arg(password)
    proxy_label = apply_proxy_env(env, proxy)
    cmd = transporter_command(
        str(transporter.path),
        "-m",
        "upload",
        "-assetFile",
        ipa_path,
        "-u",
        apple_id,
        "-p",
        password_arg,
    )
    if asc_provider:
        cmd.extend(["-asc_provider", asc_provider])

    emit("info", "使用内置上传环境。")
    if proxy_label:
        emit("info", f"代理已启用：{proxy_label}")
    if asc_provider:
        emit("info", f"使用上传团队：{asc_provider}")

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )

    assert process.stdout is not None
    for line in process.stdout:
        clean = line.strip()
        if not clean:
            continue
        logs_parts.append(clean)
        emit(classify_line(clean), clean)

    return_code = process.wait()
    full_logs = "\n".join(logs_parts)

    file_logs = collect_new_transporter_logs(log_files_before)
    if file_logs:
        full_logs = f"{full_logs}\n\n[日志文件]\n{file_logs}".strip()
        for item in file_logs.splitlines():
            if item.strip():
                emit("info", item.strip())

    if return_code != 0 or output_indicates_failure(full_logs):
        error = extract_appstore_upload_error(full_logs)
        emit("error", error)
        return False, error

    if not output_indicates_success(full_logs):
        error = "上传程序已退出，但未返回 Apple 的上传成功确认；请核对 App Store Connect 和完整日志后重试。"
        emit("error", error)
        return False, error

    emit("success", "上传成功，等待 App Store Connect/TestFlight 处理构建。")
    return True, full_logs


class UploadTaskStore:
    def __init__(self) -> None:
        self._tasks: dict[str, dict] = {}
        self._lock = threading.Lock()

    def create(self, task_id: str, filename: str) -> None:
        with self._lock:
            self._tasks[task_id] = {
                "status": "running",
                "filename": filename,
                "events": [],
                "error": "",
                "created_at": time.time(),
                "updated_at": time.time(),
            }

    def event(self, task_id: str, level: str, message: str) -> None:
        event = {"level": level, "message": message, "time": time.strftime("%H:%M:%S")}
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            task["events"].append(event)
            task["updated_at"] = time.time()

    def finish(self, task_id: str, status: str, error: str = "") -> None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            task["status"] = status
            task["error"] = error
            task["updated_at"] = time.time()

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            return {
                **task,
                "events": list(task.get("events") or []),
            }


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload IPA with the bundled upload component")
    parser.add_argument("--ipa", required=True)
    parser.add_argument("--apple-id", required=True)
    parser.add_argument("--password-env", required=True)
    parser.add_argument("--asc-provider", default="")
    parser.add_argument("--proxy-json", default="")
    args = parser.parse_args()

    password = os.environ.get(args.password_env, "")
    if not password:
        print(json.dumps({"type": "event", "level": "error", "message": "缺少 App 专用密码。"}, ensure_ascii=False), flush=True)
        return 2

    proxy = None
    if args.proxy_json:
        try:
            proxy = json.loads(args.proxy_json)
        except json.JSONDecodeError:
            print(json.dumps({"type": "event", "level": "error", "message": "代理配置 JSON 无效。"}, ensure_ascii=False), flush=True)
            return 2

    def emit(level: str, message: str) -> None:
        print(json.dumps({"type": "event", "level": level, "message": message}, ensure_ascii=False), flush=True)

    try:
        ok, output = upload_ipa(
            args.ipa,
            args.apple_id,
            password,
            asc_provider=args.asc_provider,
            proxy=proxy,
            on_event=emit,
        )
    except Exception as exc:
        emit("error", str(exc))
        print(json.dumps({"type": "finish", "ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1

    print(json.dumps({"type": "finish", "ok": ok, "error": "" if ok else output}, ensure_ascii=False), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
