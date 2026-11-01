import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { GoalStore } from '../src/goals.mjs';
import { createGoalsClient, createGoalsTransport, GoalsClientError } from '../public/goals-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const goalValue = () => ({ title: 'SYNTHETIC-PRIVATE-GOAL', desiredOutcome: 'SYNTHETIC-PRIVATE-OUTCOME', notes: 'SYNTHETIC-PRIVATE-NOTES',
  plan: 'Owner-written plan', nextStep: 'Owner-written next step', reviewAt: null, milestones: [], status: 'active' });
const cardValue = () => ({ title: 'Local policy', projectIds: ['synthetic-project'], actions: ['create-task'], taskTypes: ['research'],
  resources: ['/synthetic/project', 'https://example.invalid/public'], maxTasks: 2, maxTokens: 100, maxCostMinor: 50, currency: 'USD',
  notBefore: '2026-10-31T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', reviewEveryDays: 7, requireDecision: [],
  template: { title: 'Review a public artifact', instructions: 'Inspect only the named project artifact.', acceptanceCriteria: 'Return project-only findings.' } });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goals-client-synthetic-')), store = new BootstrapStore(dir, ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-owner' }), { companionId: randomUUID() }).companionId;
  const core = new GoalStore(store, { now: () => Date.UTC(2026, 10, 1) });
  const f = { store, owner, core, calls: [], synthetic: false, afterCommit: null, beforeCall: null };
  f.transport = async (action, payload, context) => {
    f.calls.push({ action, payload: structuredClone(payload), signal: context.signal, expectedCompanionId: context.expectedCompanionId });
    if (f.beforeCall) await f.beforeCall(action, payload, context);
    if ((action !== 'snapshot' || context.expectedCompanionId !== null) && context.expectedCompanionId !== f.owner) throw new GoalsClientError('ACCESS_DENIED');
    let data;
    try { data = core.handle(f.owner, { action, ...payload }); }
    catch (error) { throw new GoalsClientError(error.code === 'GOALS_CONFLICT' ? 'CONFLICT' : error.code === 'GOALS_NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_REQUEST'); }
    if (f.afterCommit) await f.afterCommit(action, payload, data);
    return { version: 1, synthetic: f.synthetic, companionId: f.owner, data };
  };
  f.client = createGoalsClient({ transport: f.transport }); return f;
}
async function setup(f) {
  await f.client.open('account');
  await f.client.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  const goal = f.client.getState().goals[0];
  await f.client.write('saveCard', { goalId: goal.id, cardId: null, expectedVersion: 0, card: cardValue() });
  return f.client.getState();
}

test('actual core DTOs load, private plans stay out of the explicit project template, and no dispatch action is exposed', async t => {
  const f = fixture(t), state = await setup(f), card = state.cards[0];
  assert.equal(state.connection, 'ready'); assert.equal(state.synthetic, false);
  assert.deepEqual(card.preview.template, cardValue().template);
  assert.ok(!JSON.stringify(card.preview).includes('SYNTHETIC-PRIVATE'));
  assert.throws(() => f.client.write('reserve', {}), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => f.client.write('confirmCard', {}), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => f.client.write('reviewGoal', { goalId: state.goals[0].id, expectedVersion: 1, owner: 'forged' }), error => error.code === 'INVALID_REQUEST');
  assert.equal(f.calls.filter(call => call.action === 'confirmCard').length, 0);
  assert.equal(state.companionId, f.owner); assert.equal(f.calls[0].expectedCompanionId, null);
  assert.ok(f.calls.slice(1).every(call => call.expectedCompanionId === f.owner));
});

test('an open workspace binds every later request to its original owner and refuses a valid account switch before creating a goal', async t => {
  const f = fixture(t); await setup(f); const originalOwner = f.owner;
  const other = f.store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-other-owner' }), { companionId: randomUUID() }).companionId;
  f.owner = other;
  await f.client.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  assert.equal(f.calls.at(-1).expectedCompanionId, originalOwner); assert.equal(f.client.getState().connection, 'denied');
  assert.equal(f.client.getState().companionId, null); assert.deepEqual(f.core.handle(other, { action: 'snapshot' }).goals, []);
  await f.client.open('account'); assert.equal(f.client.getState().companionId, other); assert.deepEqual(f.client.getState().goals, []);
  f.afterCommit = () => { f.owner = originalOwner; };
  await f.client.refresh(); assert.equal(f.client.getState().connection, 'denied'); assert.deepEqual(f.client.getState().goals, []);
  f.afterCommit = null; let omit = false;
  const client = createGoalsClient({ transport: async (...args) => { const body = await f.transport(...args); if (omit) delete body.companionId; return body; } });
  await client.open('account'); omit = true; await client.refresh();
  assert.equal(client.getState().connection, 'denied'); assert.equal(client.getState().companionId, null); assert.deepEqual(client.getState().goals, []);
});

test('confirmation requires an explicit current preview review; edits and refresh invalidate it', async t => {
  const f = fixture(t); await setup(f);
  let card = f.client.getState().cards[0];
  assert.throws(() => f.client.confirm(card.id), error => error.code === 'NOT_READY');
  f.client.markPreviewReviewed(card.id); f.client.invalidateReview();
  assert.throws(() => f.client.confirm(card.id), error => error.code === 'NOT_READY');
  f.client.markPreviewReviewed(card.id);
  const selected = f.client.getState().goals[0];
  f.core.handle(f.owner, { action: 'saveGoal', requestId: randomUUID(), goalId: selected.id, expectedVersion: selected.version,
    goal: { ...selected.goal, notes: 'Changed on another synthetic device' } });
  await f.client.refresh();
  assert.equal(f.client.getState().reviewed, null);
  assert.throws(() => f.client.confirm(card.id), error => error.code === 'NOT_READY');
  card = f.client.getState().cards[0]; f.client.markPreviewReviewed(card.id); await f.client.confirm(card.id);
  const sent = f.calls.findLast(call => call.action === 'confirmCard').payload;
  assert.equal(sent.expectedVersion, card.version); assert.equal(sent.previewDigest, card.previewDigest); assert.equal(sent.confirm, true);
  assert.equal(f.client.getState().cards[0].state, 'confirmed');
  assert.equal(f.client.getState().reviewed, null);
});

test('a lost write acknowledgement retries only by explicit intent with the identical payload and key', async t => {
  const f = fixture(t); await f.client.open('account'); let once = true;
  f.afterCommit = action => { if (action === 'saveGoal' && once) { once = false; throw new GoalsClientError('NETWORK_ERROR'); } };
  await f.client.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  assert.equal(f.client.getState().pending.status, 'uncertain');
  assert.equal(f.calls.filter(call => call.action === 'saveGoal').length, 1);
  await f.client.retry();
  const attempts = f.calls.filter(call => call.action === 'saveGoal');
  assert.deepEqual(attempts[0].payload, attempts[1].payload);
  assert.equal(f.client.getState().goals.length, 1); assert.equal(f.client.getState().pending, null);
});

test('uncertain confirmation keeps its exact reviewed version while an acknowledged write needs only refresh', async t => {
  const f = fixture(t); await setup(f); let once = true;
  f.afterCommit = action => { if (action === 'confirmCard' && once) { once = false; throw new GoalsClientError('UNAVAILABLE'); } };
  const card = f.client.getState().cards[0]; f.client.markPreviewReviewed(card.id); await f.client.confirm(card.id);
  assert.equal(f.client.getState().pending.status, 'uncertain'); await f.client.retry();
  const attempts = f.calls.filter(call => call.action === 'confirmCard'); assert.deepEqual(attempts[0].payload, attempts[1].payload);
  assert.equal(f.client.getState().cards[0].version, card.version + 1);
  let failRead = true;
  f.beforeCall = action => { if (action === 'snapshot' && failRead) { failRead = false; throw new GoalsClientError('NETWORK_ERROR'); } };
  const saved = f.client.getState().goals[0];
  await f.client.write('reviewGoal', { goalId: saved.id, expectedVersion: saved.version });
  assert.equal(f.client.getState().pending.status, 'acknowledged');
  assert.throws(() => f.client.retry(), error => error.code === 'NOT_READY');
  await f.client.refresh(); assert.equal(f.client.getState().pending, null);
  assert.equal(f.calls.filter(call => call.action === 'reviewGoal').length, 1);
});

test('denial and marker mismatch clear all private data and late ignored-abort callbacks cannot restore it', async t => {
  const f = fixture(t); await setup(f); let release;
  f.beforeCall = action => action === 'snapshot' ? new Promise(resolve => { release = resolve; }) : undefined;
  const waiting = f.client.refresh(); await Promise.resolve();
  const pending = f.calls.at(-1); f.client.disconnect(); assert.equal(pending.signal.aborted, true); release(); await waiting;
  assert.deepEqual(f.client.getState().goals, []); assert.deepEqual(f.client.getState().cards, []);
  f.beforeCall = null; await f.client.open('account');
  f.beforeCall = () => { throw new GoalsClientError('ACCESS_DENIED'); };
  await f.client.refresh(); assert.equal(f.client.getState().connection, 'denied'); assert.deepEqual(f.client.getState().goals, []);
  f.beforeCall = null; f.synthetic = true; await f.client.open('account');
  assert.equal(f.client.getState().connection, 'unavailable'); assert.deepEqual(f.client.getState().cards, []);
});

test('private goal review does not refresh consent, and pause/resume never restores it', async t => {
  const f = fixture(t); await setup(f); let card = f.client.getState().cards[0];
  f.client.markPreviewReviewed(card.id); await f.client.confirm(card.id);
  const confirmedAt = f.client.getState().cards[0].confirmedAt, dueAt = f.client.getState().cards[0].reviewDueAt;
  let saved = f.client.getState().goals[0]; await f.client.write('reviewGoal', { goalId: saved.id, expectedVersion: saved.version });
  assert.equal(f.client.getState().cards[0].confirmedAt, confirmedAt); assert.equal(f.client.getState().cards[0].reviewDueAt, dueAt);
  for (const status of ['paused', 'active']) {
    saved = f.client.getState().goals[0]; await f.client.write('saveGoal', { goalId: saved.id, expectedVersion: saved.version, goal: { ...saved.goal, status } });
    card = f.client.getState().cards[0]; assert.notEqual(card.confirmedAuthorizationGeneration, card.authorizationGeneration);
  }
});

test('a late acknowledged-write snapshot cannot restore revoked consent, while a late same-session denial still clears it', async t => {
  const f = fixture(t); await setup(f); const card = f.client.getState().cards[0];
  f.client.markPreviewReviewed(card.id); await f.client.confirm(card.id);
  let release, once = true;
  f.afterCommit = action => { if (action === 'snapshot' && once) { once = false; return new Promise(resolve => { release = resolve; }); } };
  const goal = f.client.getState().goals[0], first = f.client.write('reviewGoal', { goalId: goal.id, expectedVersion: goal.version });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.client.getState().pending.status, 'acknowledged'); await f.client.refresh();
  const latest = f.client.getState().cards[0]; await f.client.write('revokeCard', { cardId: latest.id, expectedVersion: latest.version });
  assert.equal(f.client.getState().cards[0].state, 'revoked'); release(); await first;
  assert.equal(f.client.getState().cards[0].state, 'revoked');
  once = true; let deny;
  f.afterCommit = action => { if (action === 'snapshot' && once) { once = false; return new Promise((resolve, reject) => { deny = () => reject(new GoalsClientError('ACCESS_DENIED')); }); } };
  const saved = f.client.getState().goals[0], denied = f.client.write('reviewGoal', { goalId: saved.id, expectedVersion: saved.version });
  while (!deny) await new Promise(resolve => setImmediate(resolve));
  await f.client.refresh(); assert.equal(f.client.getState().goals.length, 1); deny(); await denied;
  assert.equal(f.client.getState().connection, 'denied'); assert.deepEqual(f.client.getState().goals, []); assert.deepEqual(f.client.getState().cards, []);
});

test('bounded same-origin transport accepts a legal large workspace and rejects oversized responses and raw errors', async t => {
  const f = fixture(t); const base = await setup(f), values = { goals: [], cards: [] };
  for (let index = 0; index < 20; index++) {
    const entry = structuredClone(base.goals[0]); entry.id = randomUUID();
    entry.goal.notes = 'n'.repeat(4096); entry.goal.plan = 'p'.repeat(4096); entry.goal.desiredOutcome = 'd'.repeat(2000); entry.goal.nextStep = 's'.repeat(1000);
    const permission = structuredClone(base.cards[0]); permission.id = randomUUID(); permission.goalId = entry.id;
    permission.card.resources = Array.from({ length: 20 }, (_, item) => '/synthetic/' + item + '"'.repeat(490));
    permission.card.template.instructions = 'i'.repeat(4000); permission.card.template.acceptanceCriteria = 'a'.repeat(2000);
    permission.preview.resources = permission.card.resources; permission.preview.template = permission.card.template;
    values.goals.push(entry); values.cards.push(permission);
  }
  const text = JSON.stringify({ version: 1, synthetic: false, companionId: f.owner, data: values }); assert.ok(Buffer.byteLength(text) > 1048576);
  const requests = [];
  const transport = createGoalsTransport({ fetchImpl: async (url, options) => { requests.push({ url, options }); return new Response(text, { headers: { 'content-type': 'application/json' } }); } });
  const client = createGoalsClient({ transport }); await client.open('account'); assert.equal(client.getState().goals.length, 20);
  assert.equal(requests[0].url, 'api/goals'); assert.equal(requests[0].options.credentials, 'same-origin'); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(Object.hasOwn(JSON.parse(requests[0].options.body), 'expectedCompanionId'), false);
  await client.refresh(); assert.equal(JSON.parse(requests[1].options.body).expectedCompanionId, f.owner);
  const oversized = createGoalsTransport({ fetchImpl: async () => new Response(' '.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(oversized('snapshot', {}), error => error.code === 'INVALID_RESPONSE');
  const failing = createGoalsTransport({ fetchImpl: async () => { throw new Error('SYNTHETIC-PRIVATE-ERROR'); } });
  await assert.rejects(failing('snapshot', {}), error => error.code === 'NETWORK_ERROR' && !String(error).includes('PRIVATE'));
});

// Synthetic DOM proof executes the actual controller. It does not stand in for native browser QA.
async function controller(t, mode = 'account') {
  const f = fixture(t); await setup(f);
  f.synthetic = mode === 'demo';
  const html = readFileSync(join(ROOT, 'public/goals.html'), 'utf8'), nodes = new Map(), documentEvents = new Map(), windowEvents = new Map();
  const document = { visibilityState: 'visible', activeElement: null, getElementById: id => { assert.ok(nodes.has(id), 'Unknown controller element'); return nodes.get(id); },
    addEventListener: (name, callback) => documentEvents.set(name, callback) };
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.events = new Map(); this.attributes = new Map(); this.hidden = false; this.disabled = false; this.checked = false; this._value = ''; this._text = ''; this.defaultValue = ''; }
    get value() { return this._value; } set value(value) { this._value = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get firstElementChild() { return this.children[0] ?? null; } get lastElementChild() { return this.children.at(-1) ?? null; }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; assert.ok(index >= 0); this.children.splice(index, 0, child); child.parentNode = this; }
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this._text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); } removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { const list = this.events.get(name) ?? []; list.push(callback); this.events.set(name, list); }
    async fire(name) { for (const callback of this.events.get(name) ?? []) await callback({ target: this, preventDefault() {} }); }
    focus() { document.activeElement = this; } scrollIntoView() {} setCustomValidity(value) { this.validationMessage = value; }
    reportValidity() { return !this.validationMessage; }
    reset() { for (const id of this.formFields ?? []) { const field = nodes.get(id); field.value = field.defaultValue; field.checked = false; field.setCustomValidity(''); } }
  }
  document.createElement = tag => new Element(tag);
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Element(match[1]); node.id = match[3]; node.hidden = /\bhidden\b/.test(match[2]); node.disabled = /\bdisabled\b/.test(match[2]);
    node.defaultValue = /\bvalue="([^"]*)"/.exec(match[2])?.[1] ?? ''; node.value = node.defaultValue; nodes.set(node.id, node);
  }
  for (const match of html.matchAll(/<form id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) nodes.get(match[1]).formFields = [...match[2].matchAll(/\bid="([^"]+)"/g)].map(item => item[1]);
  const timers = new Map(); let timerId = 0;
  const u = Object.assign(f, { nodes, document, statusCalls: [], statusHandler: null, sessionCalls: [], sessionHandler: null,
    async timer(delay) { const timer = [...timers].find(([, item]) => item.delay === delay); assert.ok(timer, 'Expected lifecycle timer'); timers.delete(timer[0]); await timer[1].callback(); await u.flush(); },
    countTimers: delay => [...timers.values()].filter(item => item.delay === delay).length,
    async flush() { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); },
    async visibility(value) { document.visibilityState = value; documentEvents.get('visibilitychange')(); await u.flush(); },
    async page(name, payload = {}) { windowEvents.get(name)?.(payload); await u.flush(); } });
  const wrapped = { ...f.client, write: (action, payload) => f.client.write(action, structuredClone(payload)) };
  const context = vm.createContext({ document, window: { addEventListener: (name, callback) => windowEvents.set(name, callback) }, createGoalsClient: () => wrapped,
    TextEncoder, AbortController, crypto: { randomUUID },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url === 'api/status') { u.statusCalls.push(options); return u.statusHandler ? u.statusHandler(options) : { ok: true, json: async () => ({ service: { mode } }) }; }
      assert.equal(url, 'api/session'); u.sessionCalls.push(options);
      return u.sessionHandler ? u.sessionHandler(options) : { ok: true, redirected: false, json: async () => ({ companionId: f.owner }) };
    } });
  vm.runInContext(readFileSync(join(ROOT, 'public/goals-app.mjs'), 'utf8').replace(/^import[^\n]+\n/, ''), context, { filename: 'goals-app.mjs' });
  await u.flush(); await nodes.get('open-workspace').fire('click'); await u.flush();
  assert.equal(nodes.get('goal-title').value, goalValue().title, JSON.stringify({ connection: f.client.getState().connection, error: f.client.getState().error, status: nodes.get('status').textContent, calls: f.calls.map(call => call.action) })); return u;
}

test('actual controller binds explicit consent to the saved preview and dirty edits disable it without copying private plans', async t => {
  const u = await controller(t), get = id => u.nodes.get(id), card = u.client.getState().cards[0];
  assert.equal(get('confirm-card').disabled, true); assert.equal(get('saved-preview').hidden, false);
  const limits = get('preview-limits').textContent;
  for (const value of ['synthetic-project', 'create-task', 'research', '/synthetic/project', '100', '50', 'USD', '2026-10-31', '2026-12-01', 'Every 7']) assert.ok(limits.includes(value));
  assert.equal(get('template-title').value, cardValue().template.title);
  assert.ok(![limits, ...['preview-title', 'preview-instructions', 'preview-acceptance'].map(id => get(id).textContent)].join('').includes('SYNTHETIC-PRIVATE'));
  get('confirm-review').checked = true; await get('confirm-review').fire('change'); assert.equal(get('confirm-card').disabled, false);
  get('goal-notes').value = 'Unsaved private change'; await get('goal-notes').fire('input');
  assert.equal(get('confirm-card').disabled, true); assert.equal(get('saved-preview').hidden, true); assert.equal(u.client.getState().reviewed, null);
  await get('discard-edits').fire('click');
  get('confirm-review').checked = true; await get('confirm-review').fire('change');
  get('template-instructions').value = 'An unsaved project-only revision'; await get('template-instructions').fire('input');
  assert.equal(get('confirm-card').disabled, true); assert.equal(get('saved-preview').hidden, true); assert.equal(u.client.getState().reviewed, null);
  await get('discard-edits').fire('click');
  get('confirm-review').checked = true; await get('confirm-review').fire('change'); await get('confirm-card').fire('click'); await u.flush();
  const confirmation = u.calls.findLast(call => call.action === 'confirmCard').payload;
  assert.equal(confirmation.expectedVersion, card.version); assert.equal(confirmation.previewDigest, card.previewDigest);
  assert.equal(get('consent-state').textContent, 'Local consent recorded'); assert.ok(get('consent-note').textContent.includes('dispatch remain unavailable'));
  assert.ok(get('consent-note').textContent.includes('Permission review due: 2026-11-08'));
});

test('actual controller keeps focused goal controls stable and never carries a template into a new private goal', async t => {
  const u = await controller(t), get = id => u.nodes.get(id), button = get('goal-list').children[0].children[0];
  button.focus(); get('goal-notes').value = 'Private draft'; await get('goal-notes').fire('input');
  assert.equal(get('goal-list').children[0].children[0], button); assert.equal(u.document.activeElement, button);
  await get('discard-edits').fire('click'); await get('new-goal').fire('click');
  assert.equal(get('template-title').value, ''); assert.equal(get('template-instructions').value, ''); assert.equal(get('card-fields').disabled, true);
  assert.equal(get('confirm-review').checked, false); assert.equal(get('confirm-card').disabled, true);
});

test('actual controller clears private form and preview data on hide or denial and requires an explicit reopen', async t => {
  const u = await controller(t), get = id => u.nodes.get(id);
  get('goal-notes').value = 'Unsaved synthetic private data'; await get('goal-notes').fire('input'); await u.visibility('hidden');
  for (const id of ['goal-title', 'goal-notes', 'template-title', 'template-instructions']) assert.equal(get(id).value, '');
  assert.equal(get('goal-list').children.length, 0); assert.equal(get('preview-instructions').textContent, '');
  const snapshots = u.calls.filter(call => call.action === 'snapshot').length;
  await u.visibility('visible'); assert.equal(u.calls.filter(call => call.action === 'snapshot').length, snapshots);
  assert.equal(get('goal-fields').disabled, true); await get('open-workspace').fire('click'); await u.flush();
  u.beforeCall = () => { throw new GoalsClientError('ACCESS_DENIED'); };
  await get('refresh-workspace').fire('click'); await u.flush();
  assert.equal(get('goal-title').value, ''); assert.equal(get('confirm-review').checked, false); assert.equal(get('goal-list').children.length, 0);
  assert.ok(get('status').textContent.includes('Access ended'));
});

test('actual controller rejects a late status response after hiding during a fresh open', async t => {
  const u = await controller(t), get = id => u.nodes.get(id); let release;
  u.statusHandler = () => new Promise(resolve => { release = resolve; });
  const opening = get('open-workspace').fire('click'); await u.flush(); const request = u.statusCalls.at(-1);
  await u.visibility('hidden'); assert.equal(request.signal.aborted, true);
  release({ ok: true, json: async () => ({ service: { mode: 'account' } }) }); await opening; await u.flush();
  assert.equal(get('goal-title').value, ''); assert.equal(get('goal-list').children.length, 0);
  assert.equal(get('confirm-card').disabled, true); assert.equal(u.client.getState().connection, 'disconnected');
});

test('idle account checks preserve healthy drafts and exact-preview review without refreshing goals or sending mutations', async t => {
  const u = await controller(t), get = id => u.nodes.get(id), actions = u.calls.length;
  get('confirm-review').checked = true; await get('confirm-review').fire('change');
  await u.timer(15000); assert.equal(get('confirm-review').checked, true); assert.equal(get('confirm-card').disabled, false);
  get('goal-notes').value = 'An in-memory private draft'; await get('goal-notes').fire('input');
  await u.timer(15000); assert.equal(get('goal-notes').value, 'An in-memory private draft'); assert.equal(u.calls.length, actions);
  assert.equal(u.sessionCalls.length, 2); assert.equal(u.countTimers(15000), 1);
  for (const request of u.sessionCalls) {
    assert.equal(request.method, 'POST'); assert.equal(request.body, '{}'); assert.equal(request.credentials, 'same-origin');
    assert.equal(request.mode, 'same-origin'); assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store');
  }
  assert.ok(!get('status').textContent.includes(u.owner));
});

test('an actual new-goal form cannot submit the prior owner private draft after a valid account switch', async t => {
  const u = await controller(t), get = id => u.nodes.get(id), originalOwner = u.owner;
  await get('new-goal').fire('click');
  for (const [id, value] of [['goal-title', 'Old owner draft'], ['desired-outcome', 'Old owner private outcome'], ['goal-notes', 'Old owner private notes']]) {
    get(id).value = value; await get(id).fire('input');
  }
  u.owner = u.store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-valid-second-owner' }), { companionId: randomUUID() }).companionId;
  await get('goal-form').fire('submit'); await u.flush();
  assert.equal(u.calls.at(-1).expectedCompanionId, originalOwner); assert.deepEqual(u.core.handle(u.owner, { action: 'snapshot' }).goals, []);
  assert.equal(get('goal-title').value, ''); assert.equal(get('goal-notes').value, ''); assert.equal(get('goal-fields').disabled, true);
});

test('idle denial, valid account change, and unavailability clear private forms and require an explicit reopen', async t => {
  for (const outcome of ['denial', 'account-change', 'unavailable']) {
    const u = await controller(t), get = id => u.nodes.get(id);
    const other = u.store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-other-owner' }), { companionId: randomUUID() }).companionId;
    get('goal-notes').value = 'An old-owner private draft'; await get('goal-notes').fire('input');
    u.sessionHandler = () => outcome === 'account-change' ? { ok: true, json: async () => ({ companionId: other }) }
      : outcome === 'denial' ? { ok: false, status: 401 } : Promise.reject(new Error('SYNTHETIC-PRIVATE-TRANSPORT-DETAIL'));
    await u.timer(15000);
    assert.equal(get('goal-title').value, ''); assert.equal(get('goal-notes').value, ''); assert.equal(get('template-instructions').value, '');
    assert.equal(get('goal-list').children.length, 0); assert.equal(get('confirm-review').checked, false); assert.equal(get('goal-fields').disabled, true);
    assert.equal(u.client.getState().companionId, null); assert.equal(u.countTimers(15000), 0);
    assert.ok(!get('status').textContent.includes('TRANSPORT-DETAIL')); assert.equal(get('open-workspace').hidden, false);
  }
});

test('idle probe deadline clears the page; an aborted older probe cannot clear a freshly reopened workspace', async t => {
  const u = await controller(t), get = id => u.nodes.get(id); let release;
  u.sessionHandler = () => new Promise(resolve => { release = resolve; });
  const probe = u.timer(15000); await u.flush(); const request = u.sessionCalls.at(-1);
  await u.visibility('hidden'); assert.equal(request.signal.aborted, true); await u.visibility('visible');
  await get('open-workspace').fire('click'); await u.flush();
  release({ ok: true, json: async () => ({ companionId: randomUUID() }) }); await probe;
  assert.equal(get('goal-title').value, goalValue().title); assert.equal(u.countTimers(15000), 1);
  u.sessionHandler = options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted synthetic request')), { once: true }));
  const deadline = u.timer(15000); await u.flush(); await u.timer(5000); await deadline;
  assert.equal(get('goal-title').value, ''); assert.equal(get('goal-fields').disabled, true); assert.equal(u.countTimers(15000), 0);
});

test('an explicit synthetic demo never probes the real account session', async t => {
  const u = await controller(t, 'demo'); assert.equal(u.countTimers(15000), 0); assert.equal(u.sessionCalls.length, 0);
  assert.equal(u.client.getState().synthetic, true);
});
