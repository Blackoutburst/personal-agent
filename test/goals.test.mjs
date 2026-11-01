import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { PrivateStateStore } from '../src/private-state.mjs';
import { GoalStore, GoalError, GOAL_AUTHORITY_AUDIENCE } from '../src/goals.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), DAY = 86400000;
const iso = number => new Date(number).toISOString();
const goalValue = () => ({ title: 'PRIVATE-GOAL-CANARY', desiredOutcome: 'PRIVATE-OUTCOME-CANARY', notes: 'PRIVATE-NOTES-CANARY',
  plan: 'PRIVATE-PLAN-CANARY', nextStep: 'PRIVATE-NEXT-CANARY', reviewAt: null,
  milestones: [{ id: null, title: 'Private milestone', done: false }], status: 'active' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'goals-synthetic-')), stores = new Set(); let now = Date.UTC(2026, 10, 1);
  const f = { calls: [], open() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); }, now: () => now, advance: ms => { now += ms; } };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.store = f.open();
  for (const label of ['a', 'b']) {
    f[label + 'Key'] = principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-owner-' + label });
    f[label] = f.store.getOrInsert('companion-identity-v1', f[label + 'Key'], { companionId: randomUUID() }).companionId;
  }
  f.verifier = async (challenge, context) => {
    f.calls.push(challenge); assert.ok(Object.isFrozen(challenge)); assert.equal(challenge.audience, GOAL_AUTHORITY_AUDIENCE);
    assert.ok(!Object.hasOwn(challenge, 'goalId')); assert.ok(!Object.hasOwn(challenge, 'cardId'));
    if (challenge.identityKey !== f.aKey || challenge.companionId !== f.a || challenge.projectId !== 'project-a' ||
      challenge.action !== 'create-task' || challenge.taskType !== 'research' || challenge.resource !== 'board-queue') return null;
    return { challengeDigest: context.challengeDigest, receiptDigest: createHash('sha256').update('synthetic-' + challenge.nonce).digest('hex'), expiresAt: challenge.expiresAt };
  };
  f.core = new GoalStore(f.store, { now: f.now, verifyProjectAuthority: f.verifier }); return f;
}
function cardValue(f, extra = {}) { return { title: 'Private local policy label', projectIds: ['project-a'], actions: ['create-task'], taskTypes: ['research'], resources: ['board-queue'],
  maxTasks: 2, maxTokens: 100, maxCostMinor: 50, currency: 'USD', notBefore: iso(f.now() - DAY), expiresAt: iso(f.now() + 30 * DAY),
  reviewEveryDays: 7, requireDecision: [], template: { title: 'Review project release', instructions: 'Inspect the public release artifacts.', acceptanceCriteria: 'Return project findings.' }, ...extra }; }
function snapshot(f, owner = f.a, core = f.core) { return core.handle(owner, { action: 'snapshot' }); }
function saveGoal(f, owner = f.a, goal = goalValue(), before = null) {
  return f.core.handle(owner, { action: 'saveGoal', requestId: randomUUID(), goalId: before?.id ?? null, expectedVersion: before?.version ?? 0, goal });
}
function saveCard(f, goalId, card = cardValue(f), before = null) {
  return f.core.handle(f.a, { action: 'saveCard', requestId: randomUUID(), goalId, cardId: before?.id ?? null, expectedVersion: before?.version ?? 0, card });
}
function confirm(f, card = snapshot(f).cards[0], requestId = randomUUID()) {
  return f.core.handle(f.a, { action: 'confirmCard', requestId, cardId: card.id, expectedVersion: card.version, previewDigest: card.previewDigest, confirm: true });
}
function setup(f, policy = cardValue(f)) { const goal = saveGoal(f); saveCard(f, goal.goalId, policy); confirm(f); return snapshot(f); }
function candidate(f, extra = {}) {
  const state = snapshot(f), card = state.cards[0]; return { cardId: card.id, expectedVersion: card.version,
    authorizationGeneration: card.authorizationGeneration, requestId: randomUUID(), projectId: 'project-a', action: 'create-task', taskType: 'research', resource: 'board-queue',
    tokens: 10, costMinor: 5, currency: 'USD', ...extra };
}
function deniedSync(run, code) { assert.throws(run, error => error instanceof GoalError && error.code === 'GOALS_' + code); }
async function denied(run, code) { await assert.rejects(run, error => error instanceof GoalError && error.code === 'GOALS_' + code); }
function deferred() {
  let enteredResolve, release; const entered = new Promise(resolve => { enteredResolve = resolve; });
  return { entered, verifyProjectAuthority: (challenge, context) => new Promise(resolve => { release = () => resolve({ challengeDigest: context.challengeDigest,
    receiptDigest: 'a'.repeat(64), expiresAt: challenge.expiresAt }); enteredResolve(); }), release: () => release() };
}
// Reachable synthetic review history assembled in memory to exercise capacity without thousands of fsyncs.
// Every receipt/fingerprint and the owner document are sealed exactly as server-written state; no production data is used.
function fillReviewHistory(f, { count = 4096, minimumBytes = Infinity } = {}) {
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ?
    '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const { key } = f.store.get('goals-authority-v1', 'integrity-key');
  const mac = (value, purpose) => createHmac('sha256', Buffer.from(key, 'base64url'))
    .update('personal-agent-goals-' + purpose + '-v1\0' + canonical(value)).digest('hex');
  const row = f.store.db.prepare('SELECT * FROM goals_owner WHERE companion_id=?').get(f.a), document = JSON.parse(row.document_json), goal = document.goals[0];
  let bytes = Buffer.byteLength(JSON.stringify(document));
  while (document.requests.length < count && bytes <= minimumBytes) {
    const requestId = ('capacity-review-' + document.requests.length).padEnd(80, 'x');
    const normalized = { action: 'reviewGoal', requestId, goalId: goal.id, expectedVersion: goal.version };
    const beforeDigits = String(goal.version).length, beforeReview = JSON.stringify(goal.reviewedAt).length;
    goal.version++; goal.reviewedAt = iso(f.now());
    const result = { action: 'reviewGoal', requestId, goalId: goal.id, cardId: null, version: goal.version, authorizationGeneration: goal.authorizationGeneration };
    const entry = { requestId, fingerprint: mac(normalized, 'request'), result };
    document.requests.push(entry); bytes += Buffer.byteLength(JSON.stringify(entry)) + 1 + String(goal.version).length - beforeDigits + JSON.stringify(goal.reviewedAt).length - beforeReview;
  }
  const json = JSON.stringify(document); assert.equal(Buffer.byteLength(json), bytes);
  assert.ok(bytes <= 2 * 1024 * 1024, 'The fixture remains valid persisted state, not an oversized/corrupt document');
  f.store.db.prepare('UPDATE goals_owner SET document_json=?,document_mac=? WHERE companion_id=?')
    .run(json, mac({ companionId: f.a, identityKey: f.aKey, json }, 'document'), f.a);
  return { bytes, requests: document.requests.length };
}

test('private goals, stable milestone IDs, progress and review timestamps survive restart and remain owner scoped', t => {
  const f = fixture(t), create = { action: 'saveGoal', requestId: 'create-stable', goalId: null, expectedVersion: 0, goal: goalValue() };
  const receipt = f.core.handle(f.a, create);
  assert.deepEqual(f.core.handle(f.a, { ...create, goal: { ...create.goal } }), receipt);
  let current = snapshot(f).goals[0]; const milestoneId = current.goal.milestones[0].id;
  const edited = { ...current.goal, milestones: [{ ...current.goal.milestones[0], done: true }, { id: null, title: 'Second', done: false }] };
  saveGoal(f, f.a, edited, current); current = snapshot(f).goals[0];
  assert.equal(current.goal.milestones[0].id, milestoneId); assert.deepEqual(current.progress, { done: 1, total: 2 });
  f.core.handle(f.a, { action: 'reviewGoal', requestId: 'review', goalId: current.id, expectedVersion: current.version });
  assert.equal(snapshot(f).goals[0].reviewedAt, iso(f.now()));
  assert.deepEqual(snapshot(f, f.b), { goals: [], cards: [] });
  deniedSync(() => f.core.handle(f.b, { action: 'reviewGoal', requestId: 'foreign', goalId: current.id, expectedVersion: current.version }), 'NOT_FOUND');
  f.close(f.store); f.store = f.open(); f.core = new GoalStore(f.store, { now: f.now, verifyProjectAuthority: f.verifier });
  assert.equal(snapshot(f).goals[0].id, receipt.goalId); assert.equal(snapshot(f).goals[0].goal.milestones[0].id, milestoneId);
});

test('exact version and preview confirmation is private consent only; client-written permission JSON grants nothing', async t => {
  const f = fixture(t), goal = saveGoal(f); const privateState = new PrivateStateStore(f.store);
  privateState.mutate(f.a, { requestId: 'fake-permission', op: 'create', kind: 'permission', expectedVersion: 0, value: { allow: '*', goalId: goal.goalId } });
  assert.equal(snapshot(f).cards.length, 0);
  saveCard(f, goal.goalId); let card = snapshot(f).cards[0];
  deniedSync(() => f.core.handle(f.a, { action: 'confirmCard', requestId: 'bad-preview', cardId: card.id, expectedVersion: card.version, previewDigest: '0'.repeat(64), confirm: true }), 'CONFLICT');
  deniedSync(() => f.core.handle(f.a, { action: 'confirmCard', requestId: 'no-checkbox', cardId: card.id, expectedVersion: card.version, previewDigest: card.previewDigest, confirm: false }), 'INVALID_REQUEST');
  const first = confirm(f, card, 'confirm-once'); f.advance(1000);
  assert.deepEqual(confirm(f, card, 'confirm-once'), first);
  card = snapshot(f).cards[0]; assert.equal(card.state, 'confirmed'); assert.equal(card.confirmedAt, iso(f.now() - 1000));
  const closed = new GoalStore(f.store, { now: f.now });
  await denied(() => closed.evaluate(f.a, candidate(f)), 'PROJECT_AUTHORITY_UNAVAILABLE');
  await denied(() => closed.reserve(f.a, candidate(f)), 'PROJECT_AUTHORITY_UNAVAILABLE');
  assert.equal(snapshot(f).cards[0].usage.tasks, 0);
});

test('static work projections exclude private narrative, identifiers, policy labels and budget metadata', async t => {
  const f = fixture(t); setup(f);
  const evaluation = await f.core.evaluate(f.a, candidate(f));
  assert.deepEqual(evaluation.work, { projectId: 'project-a', action: 'create-task', taskType: 'research', resource: 'board-queue',
    template: cardValue(f).template });
  const projected = JSON.stringify(evaluation.work);
  for (const secret of ['PRIVATE-', 'Private local policy label', f.a, f.aKey, snapshot(f).goals[0].id, snapshot(f).cards[0].id, 'maxTasks', 'costMinor']) assert.ok(!projected.includes(secret));
  assert.equal(evaluation.grant.cardId, snapshot(f).cards[0].id);
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE-'));
});

test('scope intersection, action decisions and exact currency fail closed before reserving', async t => {
  const f = fixture(t); setup(f, cardValue(f, { projectIds: ['project-a', 'project-b'] }));
  await denied(() => f.core.evaluate(f.a, candidate(f, { projectId: 'project-b' })), 'PROJECT_AUTHORITY_DENIED');
  const calls = f.calls.length;
  for (const override of [{ projectId: 'foreign' }, { action: 'delete-task' }, { taskType: 'code-review' }, { resource: 'shell' }, { currency: 'EUR' }]) {
    await denied(() => f.core.reserve(f.a, candidate(f, override)), 'SCOPE_DENIED');
  }
  assert.equal(f.calls.length, calls);
  const old = snapshot(f).cards[0]; saveCard(f, old.goalId, { ...old.card, requireDecision: ['create-task'] }, old); confirm(f);
  await denied(() => f.core.reserve(f.a, candidate(f)), 'DECISION_REQUIRED');
  assert.equal(snapshot(f).cards[0].usage.tasks, 0);
});

test('resource URLs and paths are bounded exact literals with no resolver or wildcard matching', async t => {
  const f = fixture(t), reference = 'https://example.invalid/project/repository?view=review';
  const path = 'C:\\project workspace\\repository\\src\\file.mjs';
  setup(f, cardValue(f, { resources: [reference, path] }));
  const core = new GoalStore(f.store, { now: f.now, verifyProjectAuthority: async (c, x) => ({ challengeDigest: x.challengeDigest, receiptDigest: 'a'.repeat(64), expiresAt: c.expiresAt }) });
  for (const value of [reference, path]) assert.equal((await core.evaluate(f.a, candidate(f, { resource: value }))).work.resource, value);
  await denied(() => core.evaluate(f.a, candidate(f, { resource: reference + '&extra=1' })), 'SCOPE_DENIED');
  const card = snapshot(f).cards[0];
  for (const value of ['project/*', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(513)]) {
    deniedSync(() => saveCard(f, card.goalId, { ...card.card, resources: [value] }, card), 'INVALID_REQUEST');
  }
});

test('lifetime reservations are idempotent, consume caps once and remain held across edits and reviews', async t => {
  const f = fixture(t); setup(f, cardValue(f, { maxTasks: 1 }));
  const input = candidate(f), first = await f.core.reserve(f.a, input);
  const calls = f.calls.length; assert.deepEqual(await f.core.reserve(f.a, input), first); assert.equal(f.calls.length, calls);
  await denied(() => f.core.reserve(f.a, { ...input, tokens: 11 }), 'CONFLICT');
  await denied(() => f.core.reserve(f.a, candidate(f)), 'BUDGET_EXCEEDED');
  assert.equal((await f.core.checkReservation(f.a, { reservationId: first.reservationId })).eligible, true, 'A full cap still permits its already-held reservation');
  let card = snapshot(f).cards[0]; assert.deepEqual(card.usage, { tasks: 1, tokens: 10, costMinor: 5, currency: 'USD' });
  deniedSync(() => saveCard(f, card.goalId, { ...card.card, maxTokens: 9 }, card), 'CONFLICT');
  deniedSync(() => saveCard(f, card.goalId, { ...card.card, currency: 'EUR' }, card), 'CONFLICT');
  saveCard(f, card.goalId, { ...card.card, maxTasks: 2 }, card); confirm(f); card = snapshot(f).cards[0];
  assert.equal(card.usage.tasks, 1); await denied(() => f.core.checkReservation(f.a, { reservationId: first.reservationId }), 'CONFLICT');
  const second = await f.core.reserve(f.a, candidate(f)); assert.notEqual(second.reservationId, first.reservationId);
  assert.equal(snapshot(f).cards[0].usage.tasks, 2);
});

test('pause/resume fences prior grants, does not reapprove and does not refund held estimates', async t => {
  const f = fixture(t); setup(f); const input = candidate(f), held = await f.core.reserve(f.a, input);
  let goal = snapshot(f).goals[0]; saveGoal(f, f.a, { ...goal.goal, status: 'paused' }, goal);
  assert.equal(snapshot(f).cards[0].blockedReason, 'GOALS_PAUSED');
  assert.deepEqual(await f.core.reserve(f.a, input), held, 'Historical retry is receipt-only, never a renewed grant');
  await denied(() => f.core.checkReservation(f.a, { reservationId: held.reservationId }), 'CONFLICT');
  goal = snapshot(f).goals[0]; saveGoal(f, f.a, { ...goal.goal, status: 'active' }, goal);
  assert.equal(snapshot(f).cards[0].blockedReason, 'GOALS_CONFIRMATION_REQUIRED');
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'CONFIRMATION_REQUIRED');
  confirm(f); assert.equal(snapshot(f).cards[0].usage.tasks, 1);
  assert.equal((await f.core.evaluate(f.a, candidate(f))).eligible, true);
});

test('expiry, not-before and review due are absolute; reviewing the private goal never refreshes consent', async t => {
  const f = fixture(t); setup(f, cardValue(f, { notBefore: iso(f.now() + DAY), reviewEveryDays: 10 }));
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'NOT_YET_VALID');
  f.advance(DAY); assert.equal((await f.core.evaluate(f.a, candidate(f))).eligible, true);
  f.advance(9 * DAY); await denied(() => f.core.evaluate(f.a, candidate(f)), 'REVIEW_REQUIRED');
  const goal = snapshot(f).goals[0]; f.core.handle(f.a, { action: 'reviewGoal', requestId: randomUUID(), goalId: goal.id, expectedVersion: goal.version });
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'REVIEW_REQUIRED');
  confirm(f); assert.equal((await f.core.evaluate(f.a, candidate(f))).eligible, true);
  f.advance(20 * DAY); await denied(() => f.core.evaluate(f.a, candidate(f)), 'EXPIRED');
});

test('old confirmation and save receipts cannot resurrect revoked authority or reset usage', async t => {
  const f = fixture(t), goal = saveGoal(f), policy = cardValue(f);
  const save = { action: 'saveCard', requestId: 'save-once', goalId: goal.goalId, cardId: null, expectedVersion: 0, card: policy };
  const saved = f.core.handle(f.a, save), draft = snapshot(f).cards[0];
  const confirmation = { action: 'confirmCard', requestId: 'confirm-once', cardId: draft.id, expectedVersion: draft.version, previewDigest: draft.previewDigest, confirm: true };
  const consent = f.core.handle(f.a, confirmation); await f.core.reserve(f.a, candidate(f));
  const current = snapshot(f).cards[0]; f.core.handle(f.a, { action: 'revokeCard', requestId: 'revoke', cardId: current.id, expectedVersion: current.version });
  assert.deepEqual(f.core.handle(f.a, save), saved); assert.deepEqual(f.core.handle(f.a, confirmation), consent);
  assert.equal(snapshot(f).cards[0].state, 'revoked'); assert.equal(snapshot(f).cards[0].usage.tasks, 1);
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'REVOKED');
});

test('two concurrent at-cap reservations commit only one; duplicate in-flight keys hold budget once', async t => {
  const f = fixture(t); setup(f, cardValue(f, { maxTasks: 1 }));
  const held = [], waiting = new GoalStore(f.store, { now: f.now, verifyProjectAuthority: (c, x) => new Promise(resolve => held.push(() => resolve({ challengeDigest: x.challengeDigest, receiptDigest: 'a'.repeat(64), expiresAt: c.expiresAt }))) });
  const one = waiting.reserve(f.a, candidate(f)), two = waiting.reserve(f.a, candidate(f)); await new Promise(resolve => setImmediate(resolve));
  held.forEach(release => release()); const outcomes = await Promise.allSettled([one, two]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'GOALS_BUDGET_EXCEEDED');
  assert.equal(snapshot(f).cards[0].usage.tasks, 1);
  let card = snapshot(f).cards[0]; saveCard(f, card.goalId, { ...card.card, maxTasks: 2 }, card); confirm(f);
  held.length = 0; const same = candidate(f), a = waiting.reserve(f.a, same), b = waiting.reserve(f.a, same); await new Promise(resolve => setImmediate(resolve));
  held.forEach(release => release()); assert.deepEqual(await a, await b); assert.equal(snapshot(f).cards[0].usage.tasks, 2);
});

test('async profile checks cannot outlive pause, edit, revoke or identity changes', async t => {
  for (const change of ['pause', 'edit', 'revoke', 'identity']) {
    const f = fixture(t); setup(f); const wait = deferred(), waiting = new GoalStore(f.store, { ...wait, now: f.now });
    const pending = waiting.reserve(f.a, candidate(f)); await wait.entered;
    const state = snapshot(f), card = state.cards[0], goal = state.goals[0];
    if (change === 'pause') saveGoal(f, f.a, { ...goal.goal, status: 'paused' }, goal);
    else if (change === 'edit') saveCard(f, card.goalId, { ...card.card, maxTasks: 3 }, card);
    else if (change === 'revoke') f.core.handle(f.a, { action: 'revokeCard', requestId: randomUUID(), cardId: card.id, expectedVersion: card.version });
    else f.store.db.prepare('UPDATE bootstrap_record SET key=? WHERE namespace=? AND key=?').run('b'.repeat(64), 'companion-identity-v1', f.aKey);
    wait.release(); await denied(() => pending, change === 'identity' ? 'UNAVAILABLE' : 'CONFLICT');
    if (change !== 'identity') assert.equal(snapshot(f).cards[0].usage.tasks, 0);
  }
});

test('reservation recheck requires fresh authority and fences a revocation during the check', async t => {
  const f = fixture(t); setup(f); const reservation = await f.core.reserve(f.a, candidate(f));
  const closed = new GoalStore(f.store, { now: f.now });
  await denied(() => closed.checkReservation(f.a, { reservationId: reservation.reservationId }), 'PROJECT_AUTHORITY_UNAVAILABLE');
  const wait = deferred(), waiting = new GoalStore(f.store, { ...wait, now: f.now });
  const pending = waiting.checkReservation(f.a, { reservationId: reservation.reservationId }); await wait.entered;
  const card = snapshot(f).cards[0]; f.core.handle(f.a, { action: 'revokeCard', requestId: randomUUID(), cardId: card.id, expectedVersion: card.version });
  wait.release(); await denied(() => pending, 'CONFLICT'); assert.equal(snapshot(f).cards[0].usage.tasks, 1);
  await denied(() => f.core.checkReservation(f.b, { reservationId: reservation.reservationId }), 'NOT_FOUND');
});

test('bounded exact shapes reject unsafe text, wildcard scopes and forged decision/credential fields', async t => {
  const f = fixture(t);
  for (const bad of [{ ...goalValue(), notes: '\u0000' }, { ...goalValue(), title: '\ud800' }, { ...goalValue(), plan: 'x'.repeat(4097) }, { ...goalValue(), owner: f.b }]) {
    deniedSync(() => saveGoal(f, f.a, bad), 'INVALID_REQUEST');
  }
  const goal = saveGoal(f);
  for (const bad of [cardValue(f, { actions: ['*'] }), cardValue(f, { projectIds: ['https://example.invalid'] }),
    cardValue(f, { notBefore: '2026-11-01T00:00:00Z' }), cardValue(f, { maxCostMinor: 5, currency: null }),
    cardValue(f, { requireDecision: ['delete-task'] }), { ...cardValue(f), credentials: 'private-token-canary' }]) {
    deniedSync(() => saveCard(f, goal.goalId, bad), 'INVALID_REQUEST');
  }
  saveCard(f, goal.goalId); confirm(f);
  for (const field of ['decisionApproved', 'goalId', 'template', 'owner', 'credentials']) {
    await denied(() => f.core.reserve(f.a, { ...candidate(f), [field]: 'forged' }), 'INVALID_REQUEST');
  }
  assert.equal(snapshot(f).cards[0].usage.tasks, 0);
});

test('malformed or expired authority replies do not reflect secrets or consume budgets', async t => {
  const f = fixture(t); setup(f); const secret = 'private-verifier-secret-canary';
  for (const verifyProjectAuthority of [async () => { throw new Error(secret); }, async (c, x) => ({ challengeDigest: x.challengeDigest, receiptDigest: secret, expiresAt: c.expiresAt }),
    async (c, x) => ({ challengeDigest: x.challengeDigest, receiptDigest: 'a'.repeat(64), expiresAt: c.issuedAt }),
    async (c, x) => ({ challengeDigest: x.challengeDigest, receiptDigest: 'a'.repeat(64), expiresAt: c.expiresAt + 1 })]) {
    const core = new GoalStore(f.store, { now: f.now, verifyProjectAuthority });
    await assert.rejects(() => core.reserve(f.a, candidate(f)), error => error.code === 'GOALS_PROJECT_AUTHORITY_UNAVAILABLE' && !inspect(error).includes(secret));
  }
  assert.equal(snapshot(f).cards[0].usage.tasks, 0);
});

test('sealed state, owner markers and schema reject corruption without resetting lifetime budgets', async t => {
  const f = fixture(t); setup(f); await f.core.reserve(f.a, candidate(f));
  const row = f.store.db.prepare('SELECT * FROM goals_owner WHERE companion_id=?').get(f.a), corrupted = JSON.parse(row.document_json);
  corrupted.cards[0].usage.tasks = 0; corrupted.reservations = [];
  f.store.db.prepare('UPDATE goals_owner SET document_json=? WHERE companion_id=?').run(JSON.stringify(corrupted), f.a);
  deniedSync(() => snapshot(f), 'UNAVAILABLE');
  f.store.db.prepare('UPDATE goals_owner SET document_json=? WHERE companion_id=?').run(row.document_json, f.a);
  assert.equal(snapshot(f).cards[0].usage.tasks, 1);
  f.store.db.prepare('DELETE FROM goals_owner WHERE companion_id=?').run(f.a); deniedSync(() => snapshot(f), 'UNAVAILABLE');
  f.store.db.exec('DROP TABLE goals_owner; DROP TABLE goals_schema'); deniedSync(() => new GoalStore(f.store), 'UNAVAILABLE');
});

test('failed owner persistence rolls back initialization marker and can retry safely once', t => {
  const f = fixture(t), actual = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => sql.startsWith('INSERT INTO goals_owner') ? { run() { throw new Error('private-sql-detail'); } } : actual(sql);
  try { deniedSync(() => saveGoal(f), 'UNAVAILABLE'); } finally { f.store.db.prepare = actual; }
  assert.equal(f.store.db.prepare('SELECT count(*) count FROM goals_owner').get().count, 0);
  assert.equal(f.store.get('goals-authority-v1', 'owner.' + f.a), null);
  assert.equal(saveGoal(f).version, 1);
});

test('exhausted control receipts deny both new authority and existing reservations without resetting history', async t => {
  const f = fixture(t); setup(f); const input = candidate(f), held = await f.core.reserve(f.a, input);
  const before = snapshot(f), calls = f.calls.length;
  assert.equal(fillReviewHistory(f).requests, 4096);
  const state = snapshot(f); assert.equal(state.cards[0].blockedReason, 'GOALS_CONTROL_CAPACITY');
  assert.deepEqual(state.cards[0].usage, before.cards[0].usage); assert.deepEqual(state.goals[0].goal, before.goals[0].goal);
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'CONTROL_CAPACITY');
  await denied(() => f.core.reserve(f.a, candidate(f)), 'CONTROL_CAPACITY');
  await denied(() => f.core.checkReservation(f.a, { reservationId: held.reservationId }), 'CONTROL_CAPACITY');
  assert.equal(f.calls.length, calls, 'No verifier request is made after local control capacity is exhausted');
  assert.deepEqual(await f.core.reserve(f.a, input), held, 'A historical metadata receipt remains idempotent, but supplies no usable work');
  const goal = snapshot(f).goals[0]; deniedSync(() => saveGoal(f, f.a, { ...goal.goal, status: 'paused' }, goal), 'UNAVAILABLE');
  assert.equal(snapshot(f).cards[0].blockedReason, 'GOALS_CONTROL_CAPACITY');
});

test('the reserved document margin blocks authorization while preserving room for a local pause', async t => {
  const f = fixture(t); setup(f); const held = await f.core.reserve(f.a, candidate(f));
  for (let i = 1; i < 20; i++) saveGoal(f, f.a, { title: '"'.repeat(160), desiredOutcome: '"'.repeat(2000), notes: '"'.repeat(4096),
    plan: '"'.repeat(4096), nextStep: '"'.repeat(1000), reviewAt: null, milestones: Array.from({ length: 20 }, () => ({ id: null, title: '"'.repeat(160), done: false })), status: 'active' });
  const capacity = fillReviewHistory(f, { count: 4095, minimumBytes: 2 * 1024 * 1024 - 64 * 1024 });
  assert.ok(capacity.requests < 4096); assert.ok(capacity.bytes > 2 * 1024 * 1024 - 64 * 1024);
  assert.equal(snapshot(f).cards[0].blockedReason, 'GOALS_CONTROL_CAPACITY');
  await denied(() => f.core.evaluate(f.a, candidate(f)), 'CONTROL_CAPACITY');
  await denied(() => f.core.checkReservation(f.a, { reservationId: held.reservationId }), 'CONTROL_CAPACITY');
  const goal = snapshot(f).goals[0]; assert.equal(saveGoal(f, f.a, { ...goal.goal, status: 'paused' }, goal).authorizationGeneration, goal.authorizationGeneration + 1);
  assert.equal(snapshot(f).goals[0].goal.status, 'paused'); assert.equal(snapshot(f).cards[0].usage.tasks, 1);
});

test('control capacity is recomputed after asynchronous evaluation, reservation and current-reservation verification', async t => {
  for (const purpose of ['evaluate', 'reserve', 'checkReservation']) {
    const f = fixture(t); setup(f); const held = await f.core.reserve(f.a, candidate(f)), wait = deferred();
    const waiting = new GoalStore(f.store, { ...wait, now: f.now });
    const pending = purpose === 'checkReservation' ? waiting.checkReservation(f.a, { reservationId: held.reservationId }) : waiting[purpose](f.a, candidate(f));
    await wait.entered; fillReviewHistory(f); wait.release(); await denied(() => pending, 'CONTROL_CAPACITY');
    assert.equal(snapshot(f).cards[0].usage.tasks, 1); assert.equal(snapshot(f).cards[0].blockedReason, 'GOALS_CONTROL_CAPACITY');
  }
});
