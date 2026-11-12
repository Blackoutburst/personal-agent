'use strict';
// Builds the raw BGRA bitmap for the unread-dot icon from an already resized nativeImage-like object.
// The bitmap length is the source of truth: on Windows at a DPI scale toBitmap() may not be size*size*4 (#93), and
// createFromBitmap throws "invalid buffer size" when width*height*4 differs from the buffer. So the dimensions are
// derived from the buffer itself and must be a whole square, otherwise this throws (the caller keeps the plain icon).
const { withDot } = require('./dot');
function dottedBitmap(img) {
  const raw = img.toBitmap({ scaleFactor: 1 });
  const side = Math.round(Math.sqrt(raw.length / 4));
  if (!(side > 0) || side * side * 4 !== raw.length) throw new Error(`icon bitmap of ${raw.length} bytes is not a square BGRA image`);
  const buffer = withDot(raw, side);
  return { buffer, width: side, height: side };
}

// The cached icon factory main.js uses (nativeImage is injected so tests can run this exact code against a stand-in that
// enforces createFromBitmap's contract). Any failure in the dotted path keeps the plain icon and logs (#93).
function makeAppIcon({ nativeImage, iconPath, log = console.error }) {
  const cache = new Map();
  return function appIcon(unreadLook, size) {
    const key = `${unreadLook}:${size}`;
    if (!cache.has(key)) {
      let img = nativeImage.createFromPath(iconPath).resize({ width: size, height: size, quality: 'best' });
      if (unreadLook) {
        try { const b = dottedBitmap(img); img = nativeImage.createFromBitmap(b.buffer, { width: b.width, height: b.height }); }
        catch (e) { log('unread icon failed, using the plain icon:', e); }
      }
      cache.set(key, img);
    }
    return cache.get(key);
  };
}
module.exports = { dottedBitmap, makeAppIcon };
