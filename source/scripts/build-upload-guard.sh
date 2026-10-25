#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAVA_TOOLS="${JAVA_TOOLS:-$ROOT/vendor/itms/java/bin}"
ASM="$ROOT/vendor/ipa-upload-guard/asm-9.7.1.jar"
EXPECTED_ASM_SHA256=8cadd43ac5eb6d09de05faecca38b917a040bb9139c7edeb4cc81c740b713281
if [[ ! -s "$ASM" ]]; then
  mkdir -p "$(dirname "$ASM")"
  curl --fail --location --retry 2 'https://repo.maven.apache.org/maven2/org/ow2/asm/asm/9.7.1/asm-9.7.1.jar' --output "$ASM"
fi
ACTUAL_ASM_SHA256="$(shasum -a 256 "$ASM" | awk '{print $1}')"
[[ "$ACTUAL_ASM_SHA256" == "$EXPECTED_ASM_SHA256" ]] || { echo 'ASM dependency checksum mismatch' >&2; exit 1; }
GUARD_BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$GUARD_BUILD_DIR"' EXIT
"$JAVA_TOOLS/javac" --release 11 -cp "$ASM" -d "$GUARD_BUILD_DIR" "$ROOT/scripts/java/TransporterBuildGuard.java"
(cd "$GUARD_BUILD_DIR" && "$JAVA_TOOLS/jar" xf "$ASM")
rm -f "$GUARD_BUILD_DIR/module-info.class"
cat > "$GUARD_BUILD_DIR/guard-manifest.txt" <<'EOF'
Manifest-Version: 1.0
Premain-Class: com.mayou.upload.TransporterBuildGuard

EOF
mkdir -p "$ROOT/vendor/itms/lib"
"$JAVA_TOOLS/jar" cfm "$ROOT/vendor/itms/lib/mayou-upload-guard.jar" "$GUARD_BUILD_DIR/guard-manifest.txt" -C "$GUARD_BUILD_DIR" com -C "$GUARD_BUILD_DIR" org
cp "$ROOT/vendor/ipa-upload-guard/LICENSE.txt" "$ROOT/vendor/itms/lib/mayou-upload-guard-LICENSE.txt"
echo 'Built cross-platform upload version guard (Java 11+)'
