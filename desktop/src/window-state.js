'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { width: 1100, height: 780 };
const MIN = { width: 420, height: 560 };

// Keep only a saved rectangle that still intersects a visible display.
function sanitize(raw, displays = []) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const width = Math.max(MIN.width, num(s.width) ?? DEFAULTS.width);
  const height = Math.max(MIN.height, num(s.height) ?? DEFAULTS.height);
  const out = { width, height, maximized: s.maximized === true };
  const x = num(s.x), y = num(s.y);
  if (x !== null && y !== null) {
    const visible = displays.some((d) => {
      const b = d.workArea || d.bounds || d;
      return x + 100 <= b.x + b.width && x + width - 100 >= b.x && y >= b.y && y + 50 <= b.y + b.height;
    });
    if (visible) { out.x = x; out.y = y; }
  }
  return out;
}

function load(file, displays) {
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), displays); }
  catch { return sanitize(null, displays); }
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, MIN, sanitize, load, save };
