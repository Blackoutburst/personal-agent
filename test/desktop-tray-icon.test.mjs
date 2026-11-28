import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeAppIcon, iconPath } = require('../desktop/src/icon.js');
const { FALLBACK_ICON_PNG_BASE64 } = require('../desktop/src/fallback-icon.js');
const pkg = require('../desktop/package.json');
const desktop = new URL('../desktop/', import.meta.url).pathname;

// Minimal glob check for electron-builder "files" entries: exact path, dir/**/*, or dir/**.
function packaged(rel) {
  return pkg.build.files.some((g) => g === rel || (g.endsWith('/**/*') && rel.startsWith(g.slice(0, -4))) || (g.endsWith('/**') && rel.startsWith(g.slice(0, -2))));
}

test('packaged: the tray/window icon path is inside the app dir and its file is in the package file list (#112)', () => {
  const abs = iconPath('/app.asar');
  assert.equal(abs, path.join('/app.asar', 'build', 'icon.png'));
  const rel = path.relative('/app.asar', abs).split(path.sep).join('/');
  assert.ok(fs.existsSync(path.join(desktop, rel)), 'icon exists in the source tree');
  assert.ok(packaged(rel), `${rel} must be listed in desktop/package.json build.files, else the packaged app has no icon file`);
  assert.ok(!packaged('build/definitely-missing.png'), 'the matcher does not match everything');
});

test('every file main.js loads as an icon is in the package file list', () => {
  const main = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  assert.ok(!/path\.join\(__dirname, 'build'/.test(main), 'main.js resolves build assets only through iconPath()');
  assert.ok(packaged('src/fallback-icon.js'), 'fallback icon module ships');
});

test('an empty createFromPath image (missing asset) falls back to the bundled default instead of a blank tray', () => {
  const logs = [];
  const mk = (empty) => ({ isEmpty: () => empty, resize(o) { return { ...this, size: o.width, resized: true }; } });
  const ni = {
    createFromPath: () => mk(true),
    createFromBuffer: (buf) => { assert.ok(buf.subarray(1, 4).toString() === 'PNG'); return mk(false); },
  };
  const img = makeAppIcon({ nativeImage: ni, iconPath: '/missing.png', log: (...a) => logs.push(a) })(false, 32);
  assert.equal(img.isEmpty(), false);
  assert.equal(img.size, 32);
  assert.match(String(logs[0][0]), /missing or empty/);
  assert.equal(Buffer.from(FALLBACK_ICON_PNG_BASE64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('a throwing createFromPath also falls back; a good file is used as is', () => {
  const good = { isEmpty: () => false, resize() { return { good: true }; } };
  let fell = false;
  const ni = { createFromPath: () => { throw new Error('boom'); }, createFromBuffer: () => { fell = true; return good; } };
  makeAppIcon({ nativeImage: ni, iconPath: 'x', log: () => {} })(false, 16);
  assert.ok(fell);
  fell = false;
  const ni2 = { createFromPath: () => good, createFromBuffer: () => { fell = true; return good; } };
  makeAppIcon({ nativeImage: ni2, iconPath: 'x', log: () => {} })(false, 16);
  assert.equal(fell, false);
});

test('desktop version raised past 0.5.0 so the in-app update delivers the fix', () => {
  const [a, b, c] = pkg.version.split('.').map(Number);
  assert.ok(a > 0 || b > 5 || (b === 5 && c >= 1), pkg.version);
});
