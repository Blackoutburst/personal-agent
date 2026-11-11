'use strict';
// Taskbar overlay badge: a red disc with the unread count, drawn as a raw BGRA bitmap (no canvas, no PNG).
const SIZE = 16;
const GLYPHS = { // 3x5 bitmaps
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001001001001', 8: '111101111101111', 9: '111101111001111',
  '+': '000010111010000',
};
const label = (count) => (count > 9 ? '9+' : String(Math.max(0, Math.floor(count))));

function badgeBitmap(count) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const put = (x, y, r, g, b, a) => { const i = (y * SIZE + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; };
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (Math.hypot(x - c, y - c) <= SIZE / 2 - 0.3) put(x, y, 0xe5, 0x32, 0x2d, 255);
  }
  const text = label(count), scale = text.length === 1 ? 2 : 1;
  const w = text.length * 3 * scale + (text.length - 1) * scale, h = 5 * scale;
  let ox = Math.round((SIZE - w) / 2), oy = Math.round((SIZE - h) / 2);
  for (const ch of text) {
    const g = GLYPHS[ch];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) if (g[gy * 3 + gx] === '1')
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(ox + gx * scale + dx, oy + gy * scale + dy, 255, 255, 255, 255);
    ox += 4 * scale;
  }
  return { width: SIZE, height: SIZE, buffer: buf };
}
module.exports = { SIZE, label, badgeBitmap };
