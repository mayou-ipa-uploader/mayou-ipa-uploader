from __future__ import annotations

import re


def parse_asc_providers(output: str) -> list[str]:
    """Extract App Store Connect provider short names from Transporter output."""
    text = output or ""
    patterns = (
        r"Provider\s+Short\s+Name\s*[:=]\s*([A-Za-z0-9_.-]+)",
        r"provider\s+short\s+name\s*[:=]\s*([A-Za-z0-9_.-]+)",
        r"providerShortName\s*[:=]\s*([A-Za-z0-9_.-]+)",
        r"shortName\s*[:=]\s*([A-Za-z0-9_.-]+)",
        r"<providerShortName>\s*([^<\s]+)\s*</providerShortName>",
        r"<shortName>\s*([^<\s]+)\s*</shortName>",
        r"<itc_provider>\s*([^<\s]+)\s*</itc_provider>",
    )
    found: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            provider = (match.group(1) or "").strip()
            if provider and provider not in seen:
                found.append(provider)
                seen.add(provider)

    in_provider_table = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if in_provider_table:
                in_provider_table = False
            continue
        lower = line.lower()
        if "provider listing" in lower:
            in_provider_table = True
            continue
        if in_provider_table and "short name" in lower:
            continue
        if not in_provider_table:
            continue
        if line.startswith("[") or line.startswith("<") or line.startswith("{"):
            continue
        match = re.match(r"^\d+\s+(.+?)\s+([A-Za-z0-9_.-]{2,})\s*$", line)
        if not match:
            continue
        provider = match.group(2).strip()
        if provider and provider.lower() not in {"name", "short", "provider"} and provider not in seen:
            found.append(provider)
            seen.add(provider)
    return found
