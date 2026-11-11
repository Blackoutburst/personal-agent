'use strict';
// Runs electron-builder for the NSIS installer on a host without wine (#89).
// On non-Windows hosts electron-builder builds the uninstaller by *running* the installer stub under wine. For macOS
// Catalina it instead extracts the uninstaller from the stub's bytes (UninstallerReader, pure JS). That branch is
// chosen by isMacOsCatalina(); we make it answer true so the same pure-JS extraction is used here. electron-builder
// is pinned by package-lock.json; if a version bump breaks this, the build fails loudly (it never silently falls back).
// Skipped on Windows, where the real thing works.
if (process.platform !== 'win32') {
  const mac = require('app-builder-lib/out/util/macosVersion');
  if (typeof mac.isMacOsCatalina !== 'function') throw new Error('electron-builder internals changed: isMacOsCatalina not found');
  mac.isMacOsCatalina = () => true;
}
process.argv.splice(2, 0, '--win', 'nsis', '--x64', '--publish', 'never');
require('electron-builder/out/cli/cli');
