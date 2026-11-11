#!/usr/bin/env bash
# Builds the Windows x64 portable exe into desktop/dist/. Needs network (npm + Electron downloads).
# npm selection:
#   1. NPM_CLI=/path/to/npm-cli.js, if set;
#   2. the system npm, if `npm -v` runs;
#   3. otherwise a pinned npm release is downloaded into a temp dir, its sha512 integrity is checked
#      against the value pinned below, and it is used.
# A shim named npm is put on PATH because electron-builder shells out to `npm` itself.
set -euo pipefail
NPM_VERSION="10.9.2"
NPM_INTEGRITY="sha512-iriPEPIkoMYUy3F6f3wwSZAU93E0Eg6cHwIR6jzzOXWSy+SD/rOODEs74cVONHKSx2obXtuUoyidVEhISrisgQ=="
NPM_URL="https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"

cd "$(dirname "$0")/../desktop"

if [ -z "${NPM_CLI:-}" ] && ! npm -v >/dev/null 2>&1; then
  echo "system npm does not start; fetching pinned npm ${NPM_VERSION}" >&2
  tmp="$(mktemp -d)"
  curl -fsSL "$NPM_URL" -o "$tmp/npm.tgz"
  got="sha512-$(openssl dgst -sha512 -binary "$tmp/npm.tgz" | openssl base64 -A)"
  if [ "$got" != "$NPM_INTEGRITY" ]; then
    echo "npm tarball integrity mismatch: expected $NPM_INTEGRITY got $got" >&2
    exit 1
  fi
  tar -xzf "$tmp/npm.tgz" -C "$tmp"   # extracts to $tmp/package
  NPM_CLI="$tmp/package/bin/npm-cli.js"
fi

if [ -n "${NPM_CLI:-}" ]; then
  shim="$(mktemp -d)"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$NPM_CLI" > "$shim/npm"
  chmod +x "$shim/npm"
  export PATH="$shim:$PATH"
fi
npm -v >&2
# The two network steps (npm registry, Electron/electron-builder binary downloads) are the only flaky parts of a
# build; retry each up to 3 times so a transient download failure does not need a manual re-run.
retry() {
  n=1
  until "$@"; do
    if [ "$n" -ge 3 ]; then echo "failed after $n attempts: $*" >&2; return 1; fi
    echo "attempt $n failed: $*; retrying in $((n * 5))s" >&2
    sleep $((n * 5)); n=$((n + 1))
  done
}
rm -rf dist
retry npm install --no-audit --no-fund
retry npm run dist
ls -l dist/*.exe
sha256sum dist/*.exe
