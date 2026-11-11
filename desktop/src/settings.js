'use strict';
// Local desktop settings (userData/settings.json). Off by default; unknown or mistyped values fall back.
const fs = require('node:fs');
const SHORTCUT = 'Control+Alt+C';
const DEFAULTS = Object.freeze({ autostart: false });

function normalize(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return { autostart: v.autostart === true };
}
function load(file) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { ...DEFAULTS }; }
}
function save(file, settings) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalize(settings)));
  fs.renameSync(tmp, file);
}
// Electron login-item options: portable exe path, started hidden in the tray.
function loginItem(enabled, exePath) {
  return { openAtLogin: enabled === true, path: exePath, args: enabled === true ? ['--hidden'] : [] };
}
module.exports = { SHORTCUT, DEFAULTS, normalize, load, save, loginItem };
