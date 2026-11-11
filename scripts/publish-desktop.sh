#!/usr/bin/env bash
# Publishes the newest desktop build (desktop/dist, from scripts/build-desktop.sh) to the server's download folder:
# copies the installer, its blockmap and latest.yml (electron-updater feed) to $COMPANION_DATA_DIR/downloads/ and writes desktop.json. No server restart is needed (docs/DESKTOP.md).
set -euo pipefail
cd "$(dirname "$0")/.."
data="${COMPANION_DATA_DIR:-$HOME/personal-agent-data}"
version="$(node -p "require('./desktop/package.json').version")"
exe="desktop/dist/Companion-Setup-${version}-x64.exe"
for f in "$exe" "$exe.blockmap" desktop/dist/latest.yml; do
  [ -f "$f" ] || { echo "missing $f; run scripts/build-desktop.sh first" >&2; exit 1; }
done
grep -q "^version: ${version}\$" desktop/dist/latest.yml || { echo "desktop/dist/latest.yml is not for version $version" >&2; exit 1; }
mkdir -p "$data/downloads"
# Order matters for a running app: the installer and blockmap first, latest.yml and desktop.json (what clients read) last.
cp "$exe" "$exe.blockmap" "$data/downloads/"
cp desktop/dist/latest.yml "$data/downloads/latest.yml.tmp"
mv "$data/downloads/latest.yml.tmp" "$data/downloads/latest.yml"
printf '{"version":"%s","file":"%s"}\n' "$version" "$(basename "$exe")" > "$data/downloads/desktop.json.tmp"
mv "$data/downloads/desktop.json.tmp" "$data/downloads/desktop.json"
echo "published $version to $data/downloads"
sha256sum "$data/downloads/$(basename "$exe")"
