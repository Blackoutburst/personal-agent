import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const goal = () => ({ title: 'Synthetic private goal', desiredOutcome: 'Synthetic desired outcome', notes: 'Synthetic private narrative',
  plan: 'Synthetic proposed plan', nextStep: 'First synthetic milestone', reviewAt: null,
  milestones: [{ id: null, title: 'Synthetic milestone', done: false }], status: 'active' });
const card = () => ({ title: 'Synthetic consent card', projectIds: ['synthetic-project'], actions: ['create_ticket'],
  taskTypes: ['research'], resources: ['https://example.invalid/project'], maxTasks: 3, maxTokens: 2000, maxCostMinor: 0,
  currency: null, notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', reviewEveryDays: 7,
  requireDecision: [], template: { title: 'Approved synthetic project work', instructions: 'Only these synthetic project instructions.', acceptanceCriteria: 'Check the synthetic project outcome.' } });
async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goals-http-test-')), apps = [];
  t.after(async () => { for (const app of apps) if (app.server.listening) await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return async mode => { const app = await startServer({ dataDir, mode, port: 0, ...options }); apps.push(app); return app; };
}
async function post(app, body, cookie, headers = {}, path = '/api/goals') {
  const response = await fetch(app.url + path, { method: 'POST', headers: { Origin: app.url,
    'Content-Type': 'application/json', ...(cookie ? { Cookie: '__Secure-blackout_session=' + cookie } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('actual account HTTP goals stay owner-private and revalidate every request', async t => {
  const a = { issuer: 'https://synthetic.invalid', subject: 'owner-a' }, b = { issuer: 'https://synthetic.invalid', subject: 'owner-b' };
  let active = true, validations = 0;
  const open = await fixture(t, { pilotSubjects: [a, b], validateAccount: async value => {
    validations++; return !active ? null : value === 'a'.repeat(43) ? a : value === 'b'.repeat(43) ? b : null;
  } });
  const app = await open('account'), ca = 'a'.repeat(43), cb = 'b'.repeat(43);
  const ownerA = (await post(app, { action: 'snapshot' }, ca)).body.companionId;
  const saved = await post(app, { action: 'saveGoal', requestId: 'new-goal', goalId: null, expectedVersion: 0, goal: goal(), expectedCompanionId: ownerA }, ca);
  assert.equal(saved.status, 200); assert.equal(saved.body.version, 1); assert.equal(saved.body.synthetic, false);
  const goalId = saved.body.data.goalId;
  assert.equal((await post(app, { action: 'snapshot' }, ca)).body.data.goals[0].goal.notes, goal().notes);
  const foreign = await post(app, { action: 'snapshot' }, cb);
  assert.deepEqual(foreign.body.data, { goals: [], cards: [] });
  const swap = await post(app, { action: 'saveGoal', requestId: 'swap-goal', goalId, expectedVersion: 1, goal: goal(), expectedCompanionId: foreign.body.companionId }, cb);
  assert.equal(swap.status, 404); assert.ok(!JSON.stringify(swap.body).includes(goal().notes));
  const beforeMissing = validations;
  assert.equal((await post(app, { action: 'snapshot' })).status, 401); assert.equal(validations, beforeMissing);
  active = false;
  const expired = await post(app, { action: 'snapshot' }, ca);
  assert.equal(expired.status, 401); assert.equal(expired.headers.get('cache-control'), 'no-store');
  assert.equal(validations, beforeMissing + 1);
});

test('goal/card CAS, exact preview confirmation, pause and revoke use the same guarded HTTP contract', async t => {
  const app = await (await fixture(t))('demo');
  const owner = (await post(app, { action: 'snapshot' })).body.companionId;
  const scoped = payload => post(app, { ...payload, expectedCompanionId: owner });
  const request = { action: 'saveGoal', requestId: 'create-goal-once', goalId: null, expectedVersion: 0, goal: goal() };
  const saved = await scoped(request); assert.equal(saved.status, 200); assert.equal(saved.body.synthetic, true);
  assert.deepEqual((await scoped(request)).body, saved.body);
  const goalId = saved.body.data.goalId;
  const drafted = await scoped({ action: 'saveCard', requestId: 'draft-card', goalId, cardId: null, expectedVersion: 0, card: card() });
  assert.equal(drafted.status, 200);
  const current = (await post(app, { action: 'snapshot' })).body.data.cards[0];
  assert.equal((await scoped({ action: 'confirmCard', requestId: 'wrong-preview', cardId: current.id,
    expectedVersion: current.version, previewDigest: '0'.repeat(64), confirm: true })).status, 409);
  const confirmed = await scoped({ action: 'confirmCard', requestId: 'confirm-current', cardId: current.id,
    expectedVersion: current.version, previewDigest: current.previewDigest, confirm: true });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.version, 1, 'Protocol version is separate from card revision');
  let snapshot = (await post(app, { action: 'snapshot' })).body.data;
  assert.equal(snapshot.cards[0].state, 'confirmed'); assert.equal(snapshot.cards[0].usage.tasks, 0);
  const g = snapshot.goals[0];
  const paused = await scoped({ action: 'saveGoal', requestId: 'pause-goal', goalId, expectedVersion: g.version,
    goal: { ...g.goal, status: 'paused' } }); assert.equal(paused.status, 200);
  snapshot = (await post(app, { action: 'snapshot' })).body.data;
  assert.equal(snapshot.cards[0].blockedReason, 'GOALS_PAUSED');
  const revoked = await scoped({ action: 'revokeCard', requestId: 'revoke-card', cardId: snapshot.cards[0].id,
    expectedVersion: snapshot.cards[0].version }); assert.equal(revoked.status, 200);
  assert.equal((await post(app, { action: 'snapshot' })).body.data.cards[0].state, 'revoked');
  assert.deepEqual((await scoped({ action: 'confirmCard', requestId: 'confirm-current', cardId: current.id,
    expectedVersion: current.version, previewDigest: current.previewDigest, confirm: true })).body, confirmed.body);
  assert.equal((await post(app, { action: 'snapshot' })).body.data.cards[0].state, 'revoked', 'A historical confirmation receipt cannot revive authority');
});

test('demo state is not exposed in account/default mode and browser fields cannot enable internal dispatch', async t => {
  const principal = { issuer: 'https://synthetic.invalid', subject: 'account-owner' };
  const open = await fixture(t, { pilotSubjects: [principal], validateAccount: async () => principal });
  const demo = await open('demo');
  const demoOwner = (await post(demo, { action: 'snapshot' })).body.companionId;
  assert.equal((await post(demo, { action: 'saveGoal', requestId: 'synthetic-fixture', goalId: null, expectedVersion: 0, goal: goal(), expectedCompanionId: demoOwner })).status, 200);
  await demo.close();
  const account = await open('account');
  assert.deepEqual((await post(account, { action: 'snapshot' }, 'a'.repeat(43))).body.data, { goals: [], cards: [] });
  for (const action of ['reserve', 'evaluate', 'checkReservation', 'dispatch']) {
    assert.equal((await post(account, { action, verifyProjectAuthority: true, mode: 'demo' }, 'a'.repeat(43))).status, 400);
  }
  const forged = await post(account, { action: 'snapshot', companionId: 'forged-other-owner' }, 'a'.repeat(43));
  assert.equal(forged.status, 400);
  await account.close();
  const unavailable = await open('unavailable');
  assert.equal((await post(unavailable, { action: 'snapshot', mode: 'demo' }, undefined, { 'x-mode': 'demo' })).status, 503);
});

test('changing a valid account cannot save a previous open workspace into the new owner', async t => {
  const a = { issuer: 'https://synthetic.invalid', subject: 'owner-a' }, b = { issuer: 'https://synthetic.invalid', subject: 'owner-b' };
  const app = await (await fixture(t, { pilotSubjects: [a, b], validateAccount: async token => token === 'a'.repeat(43) ? a : b }))('account');
  const ca = 'a'.repeat(43), cb = 'b'.repeat(43);
  const first = (await post(app, { action: 'snapshot' }, ca)).body.companionId;
  const request = { action: 'saveGoal', requestId: 'stale-owner-create', goalId: null, expectedVersion: 0, goal: goal(), expectedCompanionId: first };
  const switched = await post(app, request, cb);
  assert.equal(switched.status, 401); assert.equal(switched.body.error.code, 'ACCOUNT_CHANGED');
  assert.ok(!JSON.stringify(switched.body).includes(goal().notes));
  assert.equal((await post(app, { action: 'snapshot', expectedCompanionId: first }, cb)).status, 401);
  assert.deepEqual((await post(app, { action: 'snapshot' }, cb)).body.data, { goals: [], cards: [] });
  assert.equal((await post(app, { ...request, expectedCompanionId: undefined }, ca)).status, 409);
  assert.deepEqual((await post(app, { action: 'snapshot' }, ca)).body.data, { goals: [], cards: [] });
  assert.equal((await post(app, request, ca)).status, 200);
});

test('goal API reuses exact Origin, body, method and private-route rejection', async t => {
  const app = await (await fixture(t))('demo');
  assert.equal((await post(app, { action: 'snapshot' }, undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post(app, { action: 'snapshot' }, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(app, { action: 'snapshot' }, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(app, 'x'.repeat(65537))).status, 413);
  assert.equal((await fetch(app.url + '/api/goals')).status, 405);
  assert.equal((await fetch(app.url + '/api/goals?mode=demo')).status, 404);
  assert.equal((await fetch(app.url + '/src/goals.mjs')).status, 404);
});
