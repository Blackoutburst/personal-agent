'use strict';
// Unread counting and toast de-duplication for the desktop shell. Pure logic, no Electron.
// An "arrival" is what the web client announces for a new companion message: {source: 'chat'|'group', detail, id?}.
const DEDUPE_MS = 4000;   // the same conversation announcing twice inside this window is one toast
const MAX_KEYS = 200;

// Reads the arrival the page left on <html data-companion-arrival>. Anything malformed is dropped.
function parseArrival(raw) {
  let v;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  if (v.source !== 'chat' && v.source !== 'group') return null;
  const detail = typeof v.detail === 'string' && /^[0-9a-zA-Z-]{1,64}$/.test(v.detail) ? v.detail : null;
  const id = typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id).slice(0, 64) : null;
  return { source: v.source, detail, id };
}

const keyOf = (a) => a.id ? `id:${a.source}:${a.id}` : `conv:${a.source}:${a.detail ?? ''}`;

// Hash the app opens on when a toast is clicked.
function targetHash(a) {
  return a && a.source === 'group' && a.detail && /^[0-9a-f-]{36}$/.test(a.detail) ? '#group/' + a.detail : '#chat';
}

function toastFor(a, name) {
  const who = String(name || 'Your companion').replace(/^\(•\)\s*/, '').slice(0, 60) || 'Your companion';
  return { title: who, body: 'New message', hash: targetHash(a) };
}

function createUnread({ now = Date.now, onChange = () => {} } = {}) {
  let count = 0;
  const seen = new Map(); // key -> time
  function arrive(a, { looking = false } = {}) {
    if (!a) return { counted: false, toast: false };
    const t = now(), key = keyOf(a);
    const prev = seen.get(key);
    // An id repeats forever (the same message); a conversation key only inside the window.
    const dup = prev !== undefined && (a.id ? true : t - prev < DEDUPE_MS);
    seen.delete(key); seen.set(key, t);
    while (seen.size > MAX_KEYS) seen.delete(seen.keys().next().value);
    if (dup) return { counted: false, toast: false };
    if (looking) return { counted: false, toast: false };
    count += 1; onChange(count);
    return { counted: true, toast: true };
  }
  function clear() { if (count) { count = 0; onChange(0); } }
  return { arrive, clear, get count() { return count; } };
}

function tooltip(count, name = 'Companion') {
  return count > 0 ? `${name} (${count} unread)` : name;
}

module.exports = { DEDUPE_MS, parseArrival, targetHash, toastFor, createUnread, tooltip };
