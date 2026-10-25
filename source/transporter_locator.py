from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TransporterCandidate:
    path: Path
    source: str


def app_base_dir() -> Path:
    """Return the app/resource root for source runs and PyInstaller bundles."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def resource_roots() -> list[Path]:
    roots = [app_base_dir(), Path(__file__).resolve().parent]
    executable_parent = Path(sys.executable).resolve().parent
    roots.append(executable_parent)

    # Electron passes the resolved bundled launcher explicitly.  Keeping this
    # here also makes the Python uploader usable from a packaged Windows app.
    configured = os.environ.get("ITMS_TRANSPORTER_PATH", "").strip()
    if configured:
        configured_path = Path(configured)
        roots.extend([configured_path.parent, configured_path.parent.parent])

    # PyInstaller macOS .app layout:
    # IPAUploader.app/Contents/MacOS/IPAUploader
    # IPAUploader.app/Contents/Resources/vendor/itms/...
    if executable_parent.name == "MacOS" and executable_parent.parent.name == "Contents":
        roots.append(executable_parent.parent / "Resources")

    seen: set[str] = set()
    unique: list[Path] = []
    for root in roots:
        try:
            key = str(root.resolve())
        except OSError:
            key = str(root)
        if key not in seen:
            unique.append(root)
            seen.add(key)
    return unique


def _is_executable(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    if os.name == "nt":
        return path.suffix.lower() in {".cmd", ".bat", ".exe"} or path.name.lower() == "itmstransporter"
    return os.access(path, os.X_OK)


def _bundled_transporter_files(root: Path) -> list[Path]:
    return [
        root / "bin" / "iTMSTransporter",
        root / "bin" / "iTMSTransporter.sh",
        root / "bin" / "iTMSTransporter.cmd",
        root / "bin" / "iTMSTransporter.bat",
        root / "bin" / "iTMSTransporter.exe",
        root / "iTMSTransporter",
        root / "iTMSTransporter.sh",
        root / "iTMSTransporter.cmd",
        root / "iTMSTransporter.bat",
        root / "iTMSTransporter.exe",
    ]


def transporter_candidates() -> list[TransporterCandidate]:
    candidates: list[TransporterCandidate] = []

    configured = os.environ.get("ITMS_TRANSPORTER_PATH", "").strip()
    if configured:
        candidates.append(TransporterCandidate(Path(configured), "软件内置 Transporter"))

    bundled_roots: list[Path] = []
    for root in resource_roots():
        bundled_roots.extend([
            root / "vendor" / "itms" / sys.platform,
            root / "vendor" / "itms" / ("windows" if os.name == "nt" else "macos"),
            root / "vendor" / "itms",
            root / "itms" / sys.platform,
            root / "itms",
        ])
    for root in bundled_roots:
        candidates.extend(TransporterCandidate(item, "软件内置 Transporter") for item in _bundled_transporter_files(root))

    seen: set[str] = set()
    unique: list[TransporterCandidate] = []
    for item in candidates:
        try:
            key = str(item.path.resolve())
        except OSError:
            key = str(item.path)
        if key not in seen:
            unique.append(item)
            seen.add(key)
    return unique


def resolve_transporter() -> TransporterCandidate:
    for candidate in transporter_candidates():
        if _is_executable(candidate.path):
            return candidate
    raise FileNotFoundError("软件内置 iTMSTransporter 不可用，请确认安装包已包含 vendor/itms。")


def transporter_status() -> dict:
    candidates = transporter_candidates()
    for candidate in candidates:
        if _is_executable(candidate.path):
            return {
                "available": True,
                "source": candidate.source,
            }
    return {
        "available": False,
        "source": "",
    }
