'use strict';
// Runs electron-builder for the NSIS installer on a host without wine (#89).
// On non-Windows hosts electron-builder builds the uninstaller by *running* the installer stub under wine. For macOS
// Catalina it instead extracts the uninstaller from the stub's bytes (UninstallerReader, pure JS). That branch is chosen
// by isMacOsCatalina(); we make it answer true so the pure-JS extraction is used, wine or no wine on this host.
// Guards, so a change in electron-builder cannot quietly send this build down another path (e.g. wine):
//   1. electron-builder and app-builder-lib must be exactly the pinned version (package.json pins it exactly);
//   2. NsisTarget.js must still contain the isMacOsCatalina() -> UninstallerReader branch;
//   3. at exit, the override must have been asked and UninstallerReader.exec must have succeeded, else the build fails.
// Skipped on Windows, where the real thing works.
const fs = require('node:fs');
const path = require('node:path');
const PINNED = require('../package.json').devDependencies['electron-builder'];

function fail(msg) { console.error('build-nsis: ' + msg); process.exit(1); }

if (process.platform !== 'win32') {
  const root = path.dirname(require.resolve('app-builder-lib/package.json'));
  for (const name of ['electron-builder', 'app-builder-lib']) {
    const v = require(`${name}/package.json`).version;
    if (v !== PINNED) fail(`${name} is ${v}, this script is only checked against ${PINNED}. Re-verify the wine-free uninstaller path, then update the pin.`);
  }
  const source = fs.readFileSync(path.join(root, 'out/targets/nsis/NsisTarget.js'), 'utf8');
  if (!/isMacOsCatalina\)\(\)\)\s*\{\s*try\s*\{\s*await nsisUtil_1\.UninstallerReader\.exec\(/.test(source)) {
    fail('electron-builder internals changed: NsisTarget no longer uses isMacOsCatalina() -> UninstallerReader.exec. Not falling back to wine.');
  }
  const mac = require('app-builder-lib/out/util/macosVersion');
  const nsisUtil = require('app-builder-lib/out/targets/nsis/nsisUtil');
  if (typeof mac.isMacOsCatalina !== 'function' || typeof nsisUtil.UninstallerReader?.exec !== 'function') fail('electron-builder internals changed: isMacOsCatalina or UninstallerReader.exec not found.');
  let asked = 0, extracted = 0;
  mac.isMacOsCatalina = () => { asked++; return true; };
  const exec = nsisUtil.UninstallerReader.exec;
  nsisUtil.UninstallerReader.exec = async (...a) => { const r = await exec.apply(nsisUtil.UninstallerReader, a); extracted++; return r; };
  process.on('exit', (code) => {
    if (code === 0 && (asked < 1 || extracted < 1)) { console.error(`build-nsis: the wine-free uninstaller path was not used (asked ${asked}, extracted ${extracted}); the installer is not trusted.`); process.exitCode = 1; }
  });
}
process.argv.splice(2, 0, '--win', 'nsis', '--x64', '--publish', 'never');
require('electron-builder/out/cli/cli');
