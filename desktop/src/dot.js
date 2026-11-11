'use strict';
// The web favicon's unread look (public/unread-mark.mjs): a red dot top right with a white ring, drawn here on a
// raw BGRA bitmap so the window/taskbar/tray icon matches. Pure logic; geometry is the web's dotGeometry.
function dotGeometry(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  const pad = Math.max(1, Math.round(size * 0.02));
  return { x: size - radius - pad, y: radius + pad, radius, ring: Math.max(1, Math.round(size * 0.06)) };
}
// Returns a copy of the size×size BGRA bitmap with the dot; edges are anti-aliased by 1px coverage.
function withDot(bgra, size) {
  const out = Buffer.from(bgra);
  const { x, y, radius, ring } = dotGeometry(size);
  const paint = (r, R, G, B) => {
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      const cov = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(px + 0.5 - x, py + 0.5 - y)));
      if (cov <= 0) continue;
      const i = (py * size + px) * 4;
      out[i] = Math.round(out[i] * (1 - cov) + B * cov);
      out[i + 1] = Math.round(out[i + 1] * (1 - cov) + G * cov);
      out[i + 2] = Math.round(out[i + 2] * (1 - cov) + R * cov);
      out[i + 3] = Math.round(out[i + 3] * (1 - cov) + 255 * cov);
    }
  };
  paint(radius + ring, 255, 255, 255);
  paint(radius, 0xe5, 0x32, 0x2d);
  return out;
}
module.exports = { dotGeometry, withDot, DOT_RGB: [0xe5, 0x32, 0x2d] };
