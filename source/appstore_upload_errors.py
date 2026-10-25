from __future__ import annotations


def extract_appstore_upload_error(logs: str) -> str:
    """Return the useful Apple/Transporter failure section."""
    text = (logs or "").strip()
    if not text:
        return "未知上传错误（无详细日志）"

    lines = text.splitlines()
    markers = (
        "*** Error:",
        "***Error:",
        "ERROR ITMS-",
        "UPLOAD FAILED",
        "NSLocalizedFailureReason",
        "NSLocalizedDescription",
        "Error Domain=",
        "VALIDATION_ERROR",
        "STATE_ERROR",
        "iris-code",
        "Unable to perform software analysis",
    )
    for index, line in enumerate(lines):
        if any(marker in line for marker in markers):
            return "\n".join(lines[index:]).strip()

    return text
