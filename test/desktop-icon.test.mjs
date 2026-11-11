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

// #93: the real buffer-building code, fed an image-like object for every size the app uses (and DPI-scaled bitmaps).
const { dottedBitmap } = require('../desktop/src/icon.js');
const fakeImg = (bytes) => ({ toBitmap: () => Buffer.alloc(bytes, 0x80) });

test('dottedBitmap: buffer length equals width*height*4 for every size used (window 256, tray 32, others)', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const b = dottedBitmap(fakeImg(size * size * 4));
    assert.equal(b.width, size); assert.equal(b.height, size);
    assert.equal(b.buffer.length, b.width * b.height * 4, String(size));
  }
});

test('dottedBitmap: a DPI-scaled bitmap (e.g. 32px asked, 64px returned) gets matching dimensions, not the requested size', () => {
  const b = dottedBitmap(fakeImg(64 * 64 * 4));
  assert.deepEqual([b.width, b.height, b.buffer.length], [64, 64, 64 * 64 * 4]);
});

test('dottedBitmap throws on a non-square buffer, so the caller keeps the plain icon', () => {
  assert.throws(() => dottedBitmap(fakeImg(32 * 32 * 4 + 4)), /not a square/);
  assert.throws(() => dottedBitmap(fakeImg(0)), /not a square/);
});

test('main.js wraps the icon path so an error can never reach the main process', () => {
  const src = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
  assert.match(src, /try \{ const b = dottedBitmap\(img\)[\s\S]*?catch \(e\) \{ console\.error/);
  assert.match(src, /function renderUnread[\s\S]*?try \{[\s\S]*?tray\.setImage/);
});
