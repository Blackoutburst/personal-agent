'use strict';
// electron-builder afterPack: put the companion icon on the app exe without wine (signAndEditExecutable is off).
const fs = require('node:fs');
const path = require('node:path');
const { setExeIcon } = require('../src/exe-icon');
module.exports = async function afterPack(ctx) {
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  fs.writeFileSync(exe, setExeIcon(fs.readFileSync(exe), fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico'))));
};
