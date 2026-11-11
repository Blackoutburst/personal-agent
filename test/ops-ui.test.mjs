import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpsUI, duration } from '../public/ops-ui.mjs';
import { createStudioUI, APPS } from '../public/studio-ui.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this._text = ''; this.className = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, run) { this.listeners[type] = run; }
  focus() {}
  click() { this.listeners.click?.(); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const DATA = { at: 1_760_000_000_000,
  agents: [{ runId: 'a-1', name: 'coder-ops', role: 'coder', model: 'sonnet', state: 'running', live: true, ticketNumber: 75, ticketTitle: '<b>Ops</b>', turns: 3, maxTurns: 80, heartbeatAgeSeconds: 20 }],
  pipeline: { todo: [], in_progress: [{ id: 't1', number: 75, title: 'Ops' }], review: [], blocked: [], done: [{ id: 't0', number: 70, title: 'Done one' }] },
  decisions: [{ at: 1_760_000_000_000, kind: 'escalate', text: 'escalated #75 to opus' }],
  usage: { windows: { last24h: { total: { runs: 1, turns: 3, seconds: 120 }, models: { sonnet: { runs: 1, turns: 3, seconds: 120 } } }, last7d: { total: { runs: 2, turns: 9, seconds: 400 }, models: {} } }, limitHits: 0, note: 'x' } };
function fixture(handler) {
  const home = new Element('section'), timers = [];
  const document = { createElement: tag => new Element(tag) };
  const calls = [];
  const fetchImpl = async (url, options) => { const input = JSON.parse(options.body); calls.push(input); const r = await handler(input);
    return { ok: !r.status || r.status < 400, status: r.status ?? 200, json: async () => r.body ?? r }; };
  const ui = createOpsUI({ document, fetchImpl, home, setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => { timers.length = 0; } });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(home); return nodes; };
  return { ui, home, calls, timers, all };
}
test('Ops shows agents, pipeline, decisions and usage as plain text and refreshes on a timer', async () => {
  const f = fixture(() => DATA);
  await f.ui.show();
  const text = f.home.textContent;
  for (const part of ['coder-ops', 'sonnet', '#75', '<b>Ops</b>', 'En cours (1)', 'Terminé (1)', 'escalated #75 to opus', '24 dernières heures']) assert.ok(text.includes(part), part);
  assert.equal(f.all().some(node => ['script', 'img', 'iframe', 'a'].includes(node.tag)), false);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 10_000);
  await f.timers[0].run(); await flush(); assert.equal(f.calls.filter(call => call.action === 'ops').length, 2);
  f.ui.hide(); assert.equal(f.timers.length, 0);
});
test('clicking a ticket loads its Board message history; read-only means no write action is ever sent', async () => {
  const f = fixture(input => input.action === 'ops' ? DATA : { ticketNumber: 75, title: 'Ops', messages: [{ at: 1, author: 'C-chan', text: 'accepted because X' }] });
  await f.ui.show();
  f.all().find(node => node.className === 'ops-ticket' && node.textContent.includes('#75')).click(); await flush();
  assert.match(f.home.textContent, /C-chan : accepted because X/);
  assert.deepEqual([...new Set(f.calls.map(call => call.action))], ['ops', 'opsMessages']);
});
test('an unavailable runner shows a retry note, and clear() drops everything', async () => {
  let fail = true; const f = fixture(() => fail ? { status: 503, body: { error: { code: 'OPS_UNAVAILABLE' } } } : DATA);
  await f.ui.show(); assert.match(f.home.textContent, /Actualiser/); assert.match(f.home.textContent, /pas disponible/);
  fail = false; await f.ui.load(); assert.match(f.home.textContent, /coder-ops/);
  f.ui.clear(); assert.equal(f.home.textContent.includes('coder-ops'), false);
});
test('Ops is a Studio app tile and durations read well', () => {
  assert.ok(APPS.some(app => app.id === 'ops')); assert.equal(duration(30), '30 s'); assert.equal(duration(600), '10 min');
});
