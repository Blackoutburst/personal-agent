import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatMessageTime, burstEnds, BURST_GAP_MS } from '../public/message-time.mjs';

// Thu 12 Nov 2026 14:40 UTC. Paris is UTC+1 in November.
const now = Date.UTC(2026, 10, 12, 14, 40);
const at = (d, h, m) => Date.UTC(2026, 10, d, h, m);
const f = (ms, timeZone = 'UTC') => formatMessageTime(ms, { now, timeZone });

test('today shows only the 24h time', () => assert.equal(f(at(12, 14, 32)), '14:32'));
test('yesterday, this week and older carry day info', () => {
  assert.equal(f(at(11, 9, 5)), 'Yesterday 09:05');
  assert.equal(f(at(10, 23, 59)), 'Tue 23:59');
  assert.equal(f(at(6, 8, 0)), 'Fri 08:00');
  assert.equal(f(at(5, 8, 0)), '5 Nov 08:00');
  assert.equal(f(Date.UTC(2025, 10, 12, 14, 32)), '12 Nov 2025 14:32');
});
test('the owner timezone decides the clock and the day', () => {
  assert.equal(f(at(12, 14, 32), 'Europe/Paris'), '15:32');
  assert.equal(f(at(11, 23, 30), 'Europe/Paris'), '00:30');
  assert.equal(f(at(11, 23, 30), 'UTC'), 'Yesterday 23:30');
  assert.equal(f(at(11, 23, 30), 'Asia/Tokyo'), '08:30');
});
test('bad input or timezone never throws', () => {
  assert.equal(f(undefined), ''); assert.equal(f(0), '');
  assert.match(f(at(12, 14, 32), 'Not/AZone'), /^\d\d:\d\d$/);
});

test('one time per burst, under its last message', () => {
  const m = (id, role, t) => ({ id, role, at: t });
  const list = [m('a', 'user', at(12, 10, 0)), m('b', 'user', at(12, 10, 1)), m('c', 'assistant', at(12, 10, 2)), m('d', 'assistant', at(12, 10, 3)),
    m('e', 'assistant', at(12, 10, 3) + BURST_GAP_MS + 1), m('f', 'user', at(12, 11, 0))];
  assert.deepEqual([...burstEnds(list, { timeZone: 'UTC' })].sort(), ['b', 'd', 'e', 'f']);
});
test('a burst never spans midnight; app notes and untimed messages carry none', () => {
  const list = [{ id: 'a', role: 'user', at: at(11, 23, 59) }, { id: 'b', role: 'user', at: at(12, 0, 1) }, { id: 'n', role: 'app', at: at(12, 0, 2) }, { id: 'x', role: 'assistant' }];
  assert.deepEqual([...burstEnds(list, { timeZone: 'UTC' })].sort(), ['a', 'b']);
});

test('the web client wires times into the chat list and styles them with the soft ink', () => {
  const app = readFileSync(new URL('../public/companion-app.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/companion.css', import.meta.url), 'utf8');
  assert.match(app, /formatMessageTime/); assert.match(app, /burstEnds/);
  assert.match(css, /\.msg-time \{[^}]*var\(--soft\)/);
});
