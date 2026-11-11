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
module.exports = { dottedBitmap };
