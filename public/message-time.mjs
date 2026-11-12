// #99: the small send time under a chat burst. Pure helpers (tested in test/message-time.test.mjs).
// 24h, en-GB style, in the owner's timezone: "14:32", "Yesterday 14:32", "Tue 14:32", "12 Nov 14:32", "12 Nov 2025 14:32".
export const BURST_GAP_MS = 10 * 60 * 1000;

function zone(timeZone) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone }); return timeZone; } catch { return undefined; }
}
function parts(ms, timeZone, options) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options }).formatToParts(ms)) out[p.type] = p.value;
  return out;
}
const dayNumber = (ms, timeZone) => {
  const p = parts(ms, timeZone, { year: 'numeric', month: 'numeric', day: 'numeric' });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
};

export function formatMessageTime(at, { now = Date.now(), timeZone } = {}) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const tz = zone(timeZone);
  const clock = (() => { const p = parts(ms, tz, { hour: '2-digit', minute: '2-digit' }); return `${p.hour}:${p.minute}`; })();
  const age = dayNumber(now, tz) - dayNumber(ms, tz);
  if (age <= 0) return clock; // today (or a slightly-ahead clock)
  if (age === 1) return `Yesterday ${clock}`;
  if (age < 7) return `${parts(ms, tz, { weekday: 'short' }).weekday} ${clock}`;
  const date = parts(ms, tz, { day: 'numeric', month: 'short', year: 'numeric' });
  const sameYear = date.year === parts(now, tz, { year: 'numeric' }).year;
  return `${date.day} ${date.month}${sameYear ? '' : ' ' + date.year} ${clock}`;
}

// Which messages end a burst (and so carry the time): the next visible message is from another sender, on another
// day, or more than BURST_GAP_MS later; the last message always ends one. Returns a Set of message ids.
export function burstEnds(messages, { timeZone } = {}) {
  const tz = zone(timeZone), shown = messages.filter(m => m && Number(m.at) > 0 && m.role !== 'app' && m.role !== 'peer');
  const ends = new Set();
  shown.forEach((message, i) => {
    const next = shown[i + 1];
    if (!next || next.role !== message.role || next.at - message.at > BURST_GAP_MS || dayNumber(next.at, tz) !== dayNumber(message.at, tz)) ends.add(message.id);
  });
  return ends;
}
