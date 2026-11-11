#!/usr/bin/env bash
# Builds the Windows x64 installer into desktop/dist/. Needs network (npm + Electron + NSIS downloads).
# If the system npm is broken, set NPM_CLI=/path/to/npm-cli.js; a shim named npm is put on PATH
# because electron-builder shells out to `npm` itself.
set -euo pipefail
cd "$(dirname "$0")/../desktop"
if [ -n "${NPM_CLI:-}" ]; then
  shim="$(mktemp -d)"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$NPM_CLI" > "$shim/npm"
  chmod +x "$shim/npm"
  export PATH="$shim:$PATH"
fi
rm -rf dist
npm install --no-audit --no-fund
npm run dist
ls -l dist/*.exe
sha256sum dist/*.exe
