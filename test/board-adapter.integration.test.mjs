import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { GoalStore } from '../src/goals.mjs';
import { createBoardAdapter, adapterStatus } from '../src/adapters.mjs';
import { projectTemplateDigest } from '../src/board-boundary.mjs';
import { createBoardPrivateInspector } from '../src/board-private-inspector.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT = '1'.repeat(32), THREAD = '2'.repeat(32), ACTIONS = { ticket: 'create-task', reply: 'reply', comment: 'comment', attachment: 'attach-project-json' };
const CANARIES = ['PRIVATE-CONVERSATION-TRAP', 'PRIVATE-MEMORY-TRAP', 'PRIVATE-PERSONALITY-TRAP', 'PRIVATE-GOAL-TITLE-TRAP', 'https://private.invalid/synthetic-source?secret=PRIVATE-LINK-TRAP'];
const iso = value => new Date(value).toISOString();
function fixture(t, template = { title: 'Inspect public project release', instructions: 'Review the project release artifact.', acceptanceCriteria: 'Return project-only findings.' }) {
  const directory = mkdtempSync(join(tmpdir(), 'board-boundary-integration-')), store = new BootstrapStore(directory, ROOT);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = { store, now: () => Date.UTC(2026, 10, 1), calls: [], audits: [], resolverCalls: [], template, privacyRevision: 0, verifyHook: null };
  for (const label of ['a', 'b']) {
    f[label + 'Key'] = principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-board-owner-' + label });
    f[label] = store.getOrInsert('companion-identity-v1', f[label + 'Key'], { companionId: randomUUID() }).companionId;
  }
  f.core = new GoalStore(store, { now: f.now, verifyProjectAuthority: async (challenge, context) => {
    await f.verifyHook?.(challenge);
    if (challenge.companionId !== f.a || challenge.identityKey !== f.aKey || challenge.projectId !== PROJECT) return null;
    return { challengeDigest: context.challengeDigest, receiptDigest: 'a'.repeat(64), expiresAt: challenge.expiresAt };
  } });
  const goal = f.core.handle(f.a, { action: 'saveGoal', requestId: randomUUID(), goalId: null, expectedVersion: 0,
    goal: { title: CANARIES[3], desiredOutcome: CANARIES[0], notes: CANARIES[1], plan: CANARIES[2], nextStep: CANARIES[4], reviewAt: null, milestones: [], status: 'active' } });
  f.core.handle(f.a, { action: 'saveCard', requestId: randomUUID(), goalId: goal.goalId, cardId: null, expectedVersion: 0,
    card: { title: 'PRIVATE-POLICY-LABEL-TRAP', projectIds: [PROJECT], actions: Object.values(ACTIONS), taskTypes: ['research'], resources: [CANARIES[4]], maxTasks: 10,
      maxTokens: 100, maxCostMinor: 0, currency: null, notBefore: iso(f.now() - 1000), expiresAt: iso(f.now() + 86400000), reviewEveryDays: 7, requireDecision: [], template } });
  f.snapshot = () => f.core.handle(f.a, { action: 'snapshot' });
  let card = f.snapshot().cards[0]; f.core.handle(f.a, { action: 'confirmCard', requestId: randomUUID(), cardId: card.id, expectedVersion: card.version, previewDigest: card.previewDigest, confirm: true });
  f.templateRef = { id: 'public-release-review', revision: 'catalog-v1', digest: projectTemplateDigest(template) };
  f.inspector = createBoardPrivateInspector({ now: f.now, loadPrivateContext: owner => ({
    version: createHash('sha256').update(JSON.stringify({ owner, state: f.snapshot(), privacyRevision: f.privacyRevision })).digest('hex'),
    companionId: owner, complete: true, freshUntil: f.now() + 10000,
    markers: [...CANARIES, 'PRIVATE-POLICY-LABEL-TRAP', f.a, f.b, f.aKey, f.bKey, ...f.snapshot().goals.map(g => g.id), ...f.snapshot().cards.map(c => c.id)]
  }) });
  f.resolver = async (owner, challenge) => {
    assert.equal(owner, f.a); f.resolverCalls.push(challenge);
    return { version: 1, projectId: PROJECT, templateRef: { ...f.templateRef }, template: { ...template },
      target: challenge.targetRef === null ? null : { threadId: THREAD, projectId: PROJECT }, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
  };
  f.transport = call => { f.calls.push(structuredClone(call)); return { id: '3'.repeat(32) }; };
  f.adapter = overrides => createBoardAdapter({ goalStore: f.core, resolveProjectContent: f.resolver, inspectPrivateBoundary: f.inspector,
    transport: f.transport, audit: event => f.audits.push(structuredClone(event)), now: f.now, ...overrides });
  f.request = async operation => {
    card = f.snapshot().cards[0];
    const reservation = await f.core.reserve(f.a, { cardId: card.id, expectedVersion: card.version, authorizationGeneration: card.authorizationGeneration,
      requestId: randomUUID(), projectId: PROJECT, action: ACTIONS[operation], taskType: 'research', resource: CANARIES[4], tokens: 1, costMinor: 0, currency: null });
    return { operation, reservationId: reservation.reservationId, requestId: randomUUID(), templateRef: { ...f.templateRef }, targetRef: operation === 'ticket' ? null : THREAD };
  };
  return f;
}
async function denied(run) { await assert.rejects(run, error => /^BOARD_BOUNDARY_/.test(error.code)); }

test('shared adapter projects real GoalStore reservations into all four minimal public constructors without private mappings or resource URLs', async t => {
  const f = fixture(t), adapter = f.adapter();
  for (const operation of Object.keys(ACTIONS)) {
    const request = await f.request(operation), result = await adapter.publish(f.a, request);
    assert.equal(result.status, 'submitted'); assert.equal(result.receipt.id, '3'.repeat(32));
    assert.ok(!JSON.stringify(result).includes(request.reservationId));
  }
  assert.deepEqual(f.calls.map(c => c.tool), ['create_ticket', 'post_message', 'post_message', 'upload_attachment']);
  assert.deepEqual(Object.keys(f.calls[0].args).sort(), ['acceptance_criteria', 'description', 'idempotency_key', 'project_id', 'title']);
  assert.deepEqual(Object.keys(f.calls[1].args).sort(), ['body', 'idempotency_key', 'thread_id']);
  const attachment = f.calls[3].args; assert.equal(attachment.filename, 'project-work.json'); assert.equal(attachment.content_type, 'application/json');
  const allPublic = JSON.stringify({ calls: f.calls, audits: f.audits, decodedAttachment: Buffer.from(attachment.content_base64, 'base64').toString('utf8') });
  for (const marker of [...CANARIES, 'PRIVATE-POLICY-LABEL-TRAP', f.a, f.b, f.aKey, f.snapshot().goals[0].id, f.snapshot().cards[0].id]) assert.ok(!allPublic.includes(marker));
  assert.equal(f.snapshot().cards[0].usage.tasks, 4);
});

test('confirmed owner text containing private context cannot be declassified by confirmation or a matching project catalog', async t => {
  const f = fixture(t, { title: 'Project review', instructions: CANARIES[0], acceptanceCriteria: 'Project-only report' });
  for (const operation of Object.keys(ACTIONS)) await denied(() => f.request(operation).then(request => f.adapter().publish(f.a, request)));
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(f.audits).includes(CANARIES[0]));
});

test('owner mismatch and revocation deny before project resolution and cannot reuse a historical reservation', async t => {
  const f = fixture(t), request = await f.request('ticket'), adapter = f.adapter();
  await denied(() => adapter.publish(f.b, request));
  const card = f.snapshot().cards[0]; f.core.handle(f.a, { action: 'revokeCard', requestId: randomUUID(), cardId: card.id, expectedVersion: card.version });
  await denied(() => adapter.publish(f.a, request));
  assert.equal(f.calls.length, 0); assert.equal(f.resolverCalls.length, 0);
});

test('pause during asynchronous inspection fences the final real GoalStore check', async t => {
  const f = fixture(t), request = await f.request('ticket'), inspector = f.inspector;
  const adapter = f.adapter({ inspectPrivateBoundary: { inspect: async (...args) => {
    const proof = await inspector.inspect(...args), goal = f.snapshot().goals[0];
    f.core.handle(f.a, { action: 'saveGoal', requestId: randomUUID(), goalId: goal.id, expectedVersion: goal.version, goal: { ...goal.goal, status: 'paused' } });
    return proof;
  }, assertCurrent: (...args) => inspector.assertCurrent(...args) } });
  await denied(() => adapter.publish(f.a, request)); assert.equal(f.calls.length, 0);
});

test('changed private context during final asynchronous project authority check invalidates the inspected packet', async t => {
  const f = fixture(t), request = await f.request('ticket'); let checks = 0;
  f.verifyHook = async challenge => { if (challenge.purpose === 'checkReservation' && ++checks === 2) f.privacyRevision++; };
  await denied(() => f.adapter().publish(f.a, request)); assert.equal(checks, 2); assert.equal(f.calls.length, 0);
});

test('combined private-context revision fences a local pause queued after the final GoalStore transaction', async t => {
  const f = fixture(t), request = await f.request('ticket'); let checks = 0;
  const goalStore = { checkReservation: async (...args) => {
    const result = await f.core.checkReservation(...args);
    if (++checks === 2) queueMicrotask(() => {
      const goal = f.snapshot().goals[0];
      f.core.handle(f.a, { action: 'saveGoal', requestId: randomUUID(), goalId: goal.id, expectedVersion: goal.version, goal: { ...goal.goal, status: 'paused' } });
    });
    return result;
  } };
  await denied(() => f.adapter({ goalStore }).publish(f.a, request)); assert.equal(checks, 2); assert.equal(f.calls.length, 0);
});

test('default adapters and current HTTP modes never supply a live publication dependency', async t => {
  const f = fixture(t), request = await f.request('ticket');
  await denied(() => createBoardAdapter().publish(f.a, request));
  for (const mode of ['unavailable', 'demo', 'account']) assert.notEqual(adapterStatus(mode).board.state, 'configured');
  assert.equal(f.calls.length, 0);
});
