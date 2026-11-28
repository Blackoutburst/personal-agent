'use strict';
// Builds the raw BGRA bitmap for the unread-dot icon from an already resized nativeImage-like object.
// The bitmap length is the source of truth: on Windows at a DPI scale toBitmap() may not be size*size*4 (#93), and
// createFromBitmap throws "invalid buffer size" when width*height*4 differs from the buffer. So the dimensions are
// derived from the buffer itself and must be a whole square, otherwise this throws (the caller keeps the plain icon).
const { withDot } = require('./dot');
const { FALLBACK_ICON_PNG_BASE64 } = require('./fallback-icon');
function dottedBitmap(img) {
  const raw = img.toBitmap({ scaleFactor: 1 });
  const side = Math.round(Math.sqrt(raw.length / 4));
  if (!(side > 0) || side * side * 4 !== raw.length) throw new Error(`icon bitmap of ${raw.length} bytes is not a square BGRA image`);
  const buffer = withDot(raw, side);
  return { buffer, width: side, height: side };
}

// The cached icon factory main.js uses (nativeImage is injected so tests can run this exact code against a stand-in that
// enforces createFromBitmap's contract). Any failure in the dotted path keeps the plain icon and logs (#93).
// A missing or undecodable file makes createFromPath return an EMPTY image without throwing (that is the blank tray square, #112),
// so the result is checked with isEmpty() and the bundled default is used instead.
function loadBaseIcon(nativeImage, iconPath, log) {
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img && !img.isEmpty()) return img;
    log(`app icon at ${iconPath} is missing or empty, using the bundled default`);
  } catch (e) { log('app icon failed to load, using the bundled default:', e); }
  return nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON_PNG_BASE64, 'base64'));
}

function makeAppIcon({ nativeImage, iconPath, log = console.error }) {
  const cache = new Map();
  return function appIcon(unreadLook, size) {
    const key = `${unreadLook}:${size}`;
    if (!cache.has(key)) {
      let img = loadBaseIcon(nativeImage, iconPath, log).resize({ width: size, height: size, quality: 'best' });
      if (unreadLook) {
        try { const b = dottedBitmap(img); img = nativeImage.createFromBitmap(b.buffer, { width: b.width, height: b.height }); }
        catch (e) { log('unread icon failed, using the plain icon:', e); }
      }
      cache.set(key, img);
    }
    return cache.get(key);
  };
}
// Where the icon lives: build/ is the electron-builder resources dir; by the config and code it is NOT part of the app
// files unless package.json "files" lists build/icon.png (inferred, never confirmed by listing a real app.asar). __dirname is inside app.asar when packaged; Electron reads asar paths transparently.
const path = require('node:path');
const iconPath = (appDir) => path.join(appDir, 'build', 'icon.png');
module.exports = { dottedBitmap, makeAppIcon, iconPath };
