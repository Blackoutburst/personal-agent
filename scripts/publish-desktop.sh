#!/usr/bin/env bash
# Publishes the newest desktop build (desktop/dist, from scripts/build-desktop.sh) to the server's download folder:
# copies the exe to $COMPANION_DATA_DIR/downloads/ and writes desktop.json. No server restart is needed (docs/DESKTOP.md).
set -euo pipefail
cd "$(dirname "$0")/.."
data="${COMPANION_DATA_DIR:-$HOME/personal-agent-data}"
version="$(node -p "require('./desktop/package.json').version")"
exe="desktop/dist/Companion-Portable-${version}-x64.exe"
[ -f "$exe" ] || { echo "missing $exe; run scripts/build-desktop.sh first" >&2; exit 1; }
mkdir -p "$data/downloads"
cp "$exe" "$data/downloads/"
printf '{"version":"%s","file":"%s"}\n' "$version" "$(basename "$exe")" > "$data/downloads/desktop.json.tmp"
mv "$data/downloads/desktop.json.tmp" "$data/downloads/desktop.json"
echo "published $version to $data/downloads"
sha256sum "$data/downloads/$(basename "$exe")"
