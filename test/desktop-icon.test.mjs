import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dotGeometry as webGeometry } from '../public/unread-mark.mjs';
const require = createRequire(import.meta.url);
const { dotGeometry, withDot } = require('../desktop/src/dot.js');
const { createUnread } = require('../desktop/src/unread.js');
const { setExeIcon, readExeIcons, icoImages } = require('../desktop/src/exe-icon.js');

test('dot geometry is the web favicon geometry at every size', () => {
  for (const s of [16, 24, 32, 48, 64, 128, 192, 256]) assert.deepEqual(dotGeometry(s), webGeometry(s), String(s));
});

test('withDot paints a red dot with a white ring top right and leaves the rest untouched', () => {
  const size = 64, bg = Buffer.alloc(size * size * 4);
  for (let i = 0; i < bg.length; i += 4) { bg[i] = 0x40; bg[i + 1] = 0x80; bg[i + 2] = 0xc0; bg[i + 3] = 255; }
  const out = withDot(bg, size);
  const at = (b, x, y) => [...b.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  const { x, y, radius, ring } = dotGeometry(size);
  assert.deepEqual(at(out, x, y), [0x2d, 0x32, 0xe5, 255]);                   // BGRA red centre
  assert.deepEqual(at(out, x, y + radius + 1), [255, 255, 255, 255]);          // white ring
  assert.deepEqual(at(out, 2, size - 3), at(bg, 2, size - 3));                 // far corner unchanged
  assert.notEqual(out, bg); assert.deepEqual(at(bg, x, y), [0x40, 0x80, 0xc0, 255]); // input not mutated
});

test('the window icon look follows unread: dotted on a new message, plain once read', () => {
  const looks = [];
  const u = createUnread({ onChange: (n) => looks.push(n > 0) });
  u.arrive({ source: 'chat', detail: null, id: '1' }, { looking: false });
  u.clear(); u.clear();
  u.arrive({ source: 'chat', detail: null, id: '2' }, { looking: true }); // being looked at: no dot
  assert.deepEqual(looks, [true, false]);
});

test('main.js applies the dotted icon to window and tray from the unread count', () => {
  const m = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(m, /win\.setIcon\(appIcon\(n > 0, 256\)\)/);
  assert.match(m, /tray\.setImage\(appIcon\(n > 0, 32\)\)/);
});

test('build/icon.ico is multi-size with PNG-compressed 256', () => {
  const ico = fs.readFileSync(new URL('../desktop/build/icon.ico', import.meta.url));
  const sizes = icoImages(ico).map((i) => i.width);
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), `size ${s}`);
});

// Needs a built exe: runs after scripts/build-desktop.sh (desktop/dist/win-unpacked/Companion.exe); skipped, visibly, in a clean checkout.
test('exe icon can be set and read back (portable executable fixture)', { skip: !fs.existsSync(new URL('../desktop/dist/win-unpacked/Companion.exe', import.meta.url)) }, () => {
  const exe = fs.readFileSync(new URL('../desktop/dist/win-unpacked/Companion.exe', import.meta.url));
  const ico = fs.readFileSync(new URL('../desktop/build/icon.ico', import.meta.url));
  const got = readExeIcons(setExeIcon(exe, ico)).map((i) => i.sha256).sort();
  assert.deepEqual(got, icoImages(ico).map((i) => i.sha256).sort());
});

// #93. Root cause: desktop/main.js (0.4.0, appIcon, line 44) did
//   nativeImage.createFromBitmap(withDot(img.toBitmap(), size), { width: size, height: size })
// i.e. it trusted the REQUESTED size for the dimensions. Electron's createFromBitmap throws "invalid buffer size" unless
// buffer.length === width*height*4, and the buffer length comes from the image's actual bitmap, which is not size*size*4
// whenever the image carries a scale factor other than 1 (Windows DPI). The stand-ins below enforce that same contract.
const { dottedBitmap, makeAppIcon } = require('../desktop/src/icon.js');

// An image whose bitmap is (size*scale)^2*4 bytes, like a DPI-scaled nativeImage.
const scaledImg = (size, scale) => ({ toBitmap: () => Buffer.alloc(Math.round(size * scale) ** 2 * 4, 0x80) });
// nativeImage stand-in with Electron's createFromBitmap size check (the exact message), recording what it was given.
function strictNativeImage(scale) {
  const made = [];
  return {
    made,
    createFromPath: () => ({ resize: ({ width }) => ({ plain: true, size: width, ...scaledImg(width, scale) }) }),
    createFromBitmap(buffer, { width, height }) {
      if (buffer.length !== width * height * 4) throw new Error('invalid buffer size');
      const img = { bitmap: true, width, height, length: buffer.length };
      made.push(img); return img;
    },
  };
}
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SCALES = [1, 1.25, 1.5, 2, 3];

test('#93 repro: the 0.4.0 calculation (requested size as dimensions) throws "invalid buffer size" on a DPI-scaled image', () => {
  const ni = strictNativeImage(2);
  const old = (img, size) => ni.createFromBitmap(withDot(img.toBitmap(), size), { width: size, height: size }); // main.js 0.4.0
  assert.doesNotThrow(() => old(scaledImg(32, 1), 32));                 // scale 1 happened to work, which is why it passed before
  assert.throws(() => old(scaledImg(32, 2), 32), /invalid buffer size/); // 64x64 bitmap declared as 32x32
  assert.throws(() => old(scaledImg(256, 1.5), 256), /invalid buffer size/);
});

test('real makeAppIcon: dotted icon passes the createFromBitmap contract (length === w*h*4) for every size and scale', () => {
  for (const scale of SCALES) for (const size of SIZES) {
    const ni = strictNativeImage(scale), logs = [];
    const icon = makeAppIcon({ nativeImage: ni, iconPath: 'x', log: (...a) => logs.push(a) })(true, size);
    assert.deepEqual(logs, [], `${size}@${scale}`);
    assert.equal(icon.bitmap, true, `${size}@${scale} is the dotted icon`);
    assert.equal(icon.length, icon.width * icon.height * 4);
    assert.equal(icon.width, icon.height);
    assert.equal(icon.width, Math.round(size * scale), `${size}@${scale}`);
  }
});

test('real makeAppIcon: window 256 and tray 32 specifically, plain icon when read', () => {
  const ni = strictNativeImage(1), appIcon = makeAppIcon({ nativeImage: ni, iconPath: 'x' });
  assert.deepEqual([appIcon(true, 256).width, appIcon(true, 32).width], [256, 32]);
  assert.equal(appIcon(false, 32).plain, true);
  assert.equal(appIcon(true, 32), appIcon(true, 32)); // cached
});

test('real makeAppIcon: a bad bitmap is caught and logged, and the plain icon is kept (never throws)', () => {
  const ni = strictNativeImage(1), logs = [];
  ni.createFromPath = () => ({ resize: () => ({ plain: true, toBitmap: () => Buffer.alloc(32 * 32 * 4 + 4) }) });
  const icon = makeAppIcon({ nativeImage: ni, iconPath: 'x', log: (...a) => logs.push(a) })(true, 32);
  assert.equal(icon.plain, true); assert.equal(logs.length, 1); assert.match(String(logs[0][1]), /not a square/);
  ni.createFromBitmap = () => { throw new Error('invalid buffer size'); }; // even if createFromBitmap itself throws
  ni.createFromPath = () => ({ resize: () => ({ plain: true, toBitmap: () => Buffer.alloc(32 * 32 * 4) }) });
  assert.equal(makeAppIcon({ nativeImage: ni, iconPath: 'x', log: () => {} })(true, 32).plain, true);
});

test('dottedBitmap throws on a non-square buffer', () => {
  assert.throws(() => dottedBitmap(scaledImg(32, 1).toBitmap && { toBitmap: () => Buffer.alloc(32 * 32 * 4 + 4) }), /not a square/);
  assert.throws(() => dottedBitmap({ toBitmap: () => Buffer.alloc(0) }), /not a square/);
});

test('main.js uses makeAppIcon and every renderUnread icon call is guarded', () => {
  const src = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(src, /const appIcon = makeAppIcon\(\{ nativeImage/);
  assert.match(src, /function renderUnread[\s\S]*?try \{[\s\S]*?tray\.setImage[\s\S]*?catch/);
  assert.match(src, /try \{ win\.setIcon\(appIcon\(n > 0, 256\)\); \} catch/);
});
