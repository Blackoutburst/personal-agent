import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { createGoalsClient, createGoalsTransport } from '../public/goals-client.mjs';

const goalValue = () => ({ title: 'SYNTHETIC-PRIVATE-TITLE', desiredOutcome: 'SYNTHETIC-PRIVATE-OUTCOME', notes: 'SYNTHETIC-PRIVATE-NOTES',
  plan: 'A private sample plan', nextStep: 'A private sample step', reviewAt: null,
  milestones: [{ id: null, title: 'A private sample milestone', done: false }], status: 'active' });
const cardValue = () => ({ title: 'Synthetic consent', projectIds: ['synthetic-project'], actions: ['create_ticket'], taskTypes: ['research'],
  resources: ['repo:synthetic'], maxTasks: 2, maxTokens: 100, maxCostMinor: 0, currency: null,
  notBefore: '2000-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', reviewEveryDays: 7, requireDecision: [],
  template: { title: 'Approved project title', instructions: 'Only these project instructions.', acceptanceCriteria: 'A checked project outcome.' } });
async function fixture(t, mode, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goals-integration-test-'));
  const app = await startServer({ dataDir, mode, port: 0, ...options });
  t.after(async () => { if (app.server.listening) await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return app;
}
function clientFor(app, token = () => null, intercept) {
  const transport = createGoalsTransport({ fetchImpl: async (path, options) => {
    const cookie = token();
    const response = await fetch(new URL(path, app.url + '/'), { ...options,
      headers: { ...options.headers, Origin: app.url, ...(cookie ? { Cookie: '__Secure-blackout_session=' + cookie } : {}) } });
    if (intercept) await intercept(JSON.parse(options.body), response);
    return response;
  } });
  return createGoalsClient({ transport });
}

test('actual HTTP/client goal workflow preserves exact confirmation retries and current revoked state across clients', async t => {
  const app = await fixture(t, 'demo');
  let loseConfirm = true; const confirmKeys = [];
  const a = clientFor(app, () => null, async payload => {
    if (payload.action !== 'confirmCard') return;
    confirmKeys.push(payload.requestId);
    if (loseConfirm) { loseConfirm = false; throw new TypeError('Synthetic acknowledgment lost after commit'); }
  });
  await a.open('demo');
  await a.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  const g = a.getState().goals[0];
  await a.write('saveCard', { goalId: g.id, cardId: null, expectedVersion: 0, card: cardValue() });
  const c = a.getState().cards[0];
  assert.ok(!JSON.stringify(c.preview).includes('SYNTHETIC-PRIVATE'));
  a.markPreviewReviewed(c.id); await a.confirm(c.id);
  assert.equal(a.getState().pending.status, 'uncertain');
  const b = clientFor(app); await b.open('demo');
  assert.equal(b.getState().cards[0].state, 'confirmed');
  const committedVersion = b.getState().cards[0].version;
  await a.retry();
  assert.deepEqual(confirmKeys, [confirmKeys[0], confirmKeys[0]]);
  assert.equal(a.getState().cards[0].version, committedVersion);
  assert.equal(a.getState().cards[0].usage.tasks, 0);
  const current = b.getState().cards[0];
  await b.write('revokeCard', { cardId: current.id, expectedVersion: current.version });
  await a.refresh();
  assert.equal(a.getState().cards[0].state, 'revoked');
  assert.equal(a.getState().reviewed, null);
  assert.equal(a.getState().companionId, b.getState().companionId);
});

test('actual HTTP/client binding rejects an old private draft after switching to a different valid account', async t => {
  const a = { issuer: 'https://synthetic.invalid', subject: 'synthetic-a' }, b = { issuer: 'https://synthetic.invalid', subject: 'synthetic-b' };
  const app = await fixture(t, 'account', { pilotSubjects: [a, b], validateAccount: async value => value === 'a'.repeat(43) ? a : b });
  let token = 'a'.repeat(43);
  const client = clientFor(app, () => token);
  await client.open('account');
  const ownerA = client.getState().companionId;
  await client.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  assert.equal(client.getState().goals.length, 1);
  token = 'b'.repeat(43);
  await client.write('saveGoal', { goalId: null, expectedVersion: 0, goal: goalValue() });
  assert.equal(client.getState().connection, 'denied');
  assert.equal(client.getState().goals.length, 0); assert.equal(client.getState().cards.length, 0);
  assert.equal(client.getState().pending, null); assert.equal(client.getState().companionId, null);
  const ownerB = clientFor(app, () => token); await ownerB.open('account');
  assert.notEqual(ownerB.getState().companionId, ownerA);
  assert.equal(ownerB.getState().goals.length, 0, 'The previous private form was not written to the new owner');
  token = 'a'.repeat(43); await client.open('account');
  assert.equal(client.getState().companionId, ownerA); assert.equal(client.getState().goals.length, 1);
});
