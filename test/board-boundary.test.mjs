import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { createBoardBoundary, BoardBoundaryError, projectTemplateDigest, projectInspectionDigest } from '../src/board-boundary.mjs';
import { createBoardPrivateInspector } from '../src/board-private-inspector.mjs';

const PROJECT = '1'.repeat(32), THREAD = '2'.repeat(32), RESULT = '3'.repeat(32);
const ACTION = { ticket: 'create-task', reply: 'reply', comment: 'comment', attachment: 'attach-project-json' };
const approvedTemplate = () => ({ title: 'Review project release', instructions: 'Inspect the enrolled public release.', acceptanceCriteria: 'Return project findings.' });
function fixture(operation = 'ticket') {
  const f = { owner: randomUUID(), reservation: randomUUID(), card: randomUUID(), now: 2000000000000,
    calls: [], audits: [], authorityCalls: 0, catalogCalls: 0, active: true, generation: 1, operation,
    projectTemplate: approvedTemplate(), privateVersion: 'private-context-v1', markers: ['PRIVATE-CONVERSATION-CANARY',
      'PRIVATE-MEMORY-CANARY', 'PRIVATE-PERSONALITY-CANARY', 'PRIVATE-GOAL-CANARY', 'PRIVATE-CREDENTIAL-CANARY', 'https://private.example.invalid/sensitive-link'] };
  f.ref = () => ({ id: 'approved-release-template', revision: 'project-source-revision-1', digest: projectTemplateDigest(f.projectTemplate) });
  f.goalStore = { checkReservation: async (owner, input) => {
    f.authorityCalls++; assert.equal(owner, f.owner); assert.deepEqual(input, { reservationId: f.reservation });
    if (!f.active) throw new Error('PRIVATE-CONTROL-DETAIL');
    return { eligible: true, work: { projectId: PROJECT, action: ACTION[f.operation], taskType: 'research',
      resource: 'https://private.example.invalid/sensitive-link', template: structuredClone(f.projectTemplate) },
    grant: { cardId: f.card, cardVersion: f.generation, authorizationGeneration: 1, reservationId: f.reservation,
      authorityReceiptDigest: 'a'.repeat(64), verifiedUntil: f.now + 10000 } };
  } };
  f.resolveProjectContent = async (owner, challenge) => {
    f.catalogCalls++; assert.equal(owner, f.owner);
    return { version: 1, projectId: PROJECT, templateRef: f.ref(), template: structuredClone(f.projectTemplate),
      target: challenge.targetRef === null ? null : { threadId: challenge.targetRef, projectId: PROJECT }, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
  };
  f.inspector = createBoardPrivateInspector({ now: () => f.now, loadPrivateContext: owner => {
    assert.equal(owner, f.owner); return { version: f.privateVersion, companionId: owner, complete: true, freshUntil: f.now + 60000,
      markers: [f.card, f.reservation, ...f.markers] };
  } });
  f.transport = call => { f.calls.push(structuredClone(call)); assert.ok(Object.isFrozen(call) && Object.isFrozen(call.args)); return { id: RESULT }; };
  f.audit = event => f.audits.push(structuredClone(event));
  f.request = () => ({ operation: f.operation, reservationId: f.reservation, requestId: 'PRIVATE-REQUEST-CANARY',
    templateRef: f.ref(), targetRef: f.operation === 'ticket' ? null : THREAD });
  f.boundary = extra => createBoardBoundary({ goalStore: f.goalStore, resolveProjectContent: f.resolveProjectContent,
    inspectPrivateBoundary: f.inspector, transport: f.transport, audit: f.audit, now: () => f.now, ...extra });
  return f;
}
async function denied(f, run, code) {
  await assert.rejects(run, error => {
    assert.ok(error instanceof BoardBoundaryError); assert.equal(error.code, 'BOARD_BOUNDARY_' + code);
    for (const marker of [...f.markers, f.owner, f.reservation, f.card, 'PRIVATE-REQUEST-CANARY']) assert.ok(!inspect(error).includes(marker));
    return true;
  });
  assert.equal(f.calls.length, 0);
  for (const event of f.audits) {
    assert.deepEqual(Object.keys(event).sort(), ['code', 'event']); assert.equal(event.event, 'board_payload_denied');
    assert.match(event.code, /^BOARD_BOUNDARY_[A-Z_]+$/);
  }
}
function deferred() { let resolve; return { promise: new Promise(yes => { resolve = yes; }), release: () => resolve() }; }

test('qualified synthetic sources compile four exact tool payloads without owner context, resource or grant metadata', async () => {
  for (const operation of Object.keys(ACTION)) {
    const f = fixture(operation), result = await f.boundary().publish(f.owner, f.request());
    assert.equal(result.status, 'submitted'); assert.equal(result.receipt.id, RESULT); assert.equal(f.authorityCalls, 2); assert.equal(f.catalogCalls, 1);
    assert.equal(f.calls.length, 1); const call = f.calls[0];
    assert.equal(call.args.idempotency_key, result.publicRequestKey); assert.match(result.publicRequestKey, /^[a-f0-9-]{36}$/);
    if (operation === 'ticket') {
      assert.equal(call.tool, 'create_ticket');
      assert.deepEqual(Object.keys(call.args).sort(), ['acceptance_criteria', 'description', 'idempotency_key', 'project_id', 'title']);
      assert.equal(call.args.description, f.projectTemplate.instructions);
    } else if (operation === 'attachment') {
      assert.equal(call.tool, 'upload_attachment'); assert.equal(call.args.filename, 'project-work.json'); assert.equal(call.args.content_type, 'application/json');
      assert.deepEqual(JSON.parse(Buffer.from(call.args.content_base64, 'base64').toString()), { version: 1, projectId: PROJECT, template: f.projectTemplate });
    } else {
      assert.equal(call.tool, 'post_message'); assert.deepEqual(Object.keys(call.args).sort(), ['body', 'idempotency_key', 'thread_id']);
      assert.equal(call.args.body, f.projectTemplate.title + '\n\n' + f.projectTemplate.instructions + '\n\nAcceptance criteria:\n' + f.projectTemplate.acceptanceCriteria);
    }
    const emitted = JSON.stringify({ calls: f.calls, audits: f.audits, result });
    for (const marker of [...f.markers, f.owner, f.card, f.reservation, 'PRIVATE-REQUEST-CANARY', 'session_id', 'resource', 'grant']) assert.ok(!emitted.includes(marker));
    assert.deepEqual(f.audits, [{ event: 'board_payload_handoff', operation }]);
  }
});

test('default dependencies and unconfigured transport never reach any effect', async () => {
  const f = fixture();
  await denied(f, () => createBoardBoundary({ audit: f.audit }).publish(f.owner, f.request()), 'UNAVAILABLE');
  f.audits.length = 0;
  await denied(f, () => f.boundary({ transport: null }).publish(f.owner, f.request()), 'TRANSPORT_UNAVAILABLE');
  assert.equal(f.authorityCalls, 0); assert.equal(f.catalogCalls, 0);
});

test('all raw payload, identity, session, retry, arbitrary attachment and unsupported operation inputs are closed', async () => {
  for (const field of ['body', 'title', 'facts', 'factRefs', 'metadata', 'log', 'filename', 'bytes', 'session_id', 'tool', 'approvedWork', 'publicRequestKey']) {
    const f = fixture(); await denied(f, () => f.boundary().publish(f.owner, { ...f.request(), [field]: 'PRIVATE-CREDENTIAL-CANARY' }), 'INVALID_REQUEST');
    assert.equal(f.authorityCalls, 0);
  }
  for (const operation of ['update_ticket', 'human_request', 'create_project', 'register_agent', 'search', 'delete', 'worker-report', 'binary-upload']) {
    const f = fixture(); await denied(f, () => f.boundary().publish(f.owner, { ...f.request(), operation }), 'INVALID_REQUEST');
  }
});

test('an exact confirmed template is not declassification when it contains private markers or encoded private context', async () => {
  for (const operation of Object.keys(ACTION)) for (const field of ['title', 'instructions', 'acceptanceCriteria']) {
    const f = fixture(operation); f.projectTemplate[field] = 'Project proposal: PRIVATE-GOAL-CANARY';
    await denied(f, () => f.boundary().publish(f.owner, f.request()), 'PRIVATE_CONTEXT');
  }
  for (const encoded of [encodeURIComponent('PRIVATE-MEMORY-CANARY'), Buffer.from('PRIVATE-CONVERSATION-CANARY').toString('base64'),
    Buffer.from('PRIVATE-PERSONALITY-CANARY').toString('hex')]) {
    const f = fixture(); f.projectTemplate.instructions = 'Project note ' + encoded;
    await denied(f, () => f.boundary().publish(f.owner, f.request()), 'PRIVATE_CONTEXT');
  }
});

test('project catalog pins, owner consent, qualified targets and fresh deadlines must all match exactly', async () => {
  const variants = [
    ['SOURCE_DENIED', value => { value.projectId = '4'.repeat(32); }],
    ['SOURCE_DENIED', value => { value.templateRef.revision = 'other-revision'; }],
    ['SOURCE_DENIED', value => { value.template.instructions = 'Unapproved dynamic project facts'; }],
    ['SOURCE_DENIED', value => { value.nonce = 'wrong-nonce'; }],
    ['SOURCE_UNAVAILABLE', value => { value.workerReport = 'PRIVATE-CONVERSATION-CANARY'; }],
    ['STALE', value => { value.expiresAt += 1; }],
    ['STALE', (value, f) => { value.expiresAt = f.now; }]
  ];
  for (const [code, mutate] of variants) {
    const f = fixture(), original = f.resolveProjectContent;
    const resolver = async (...args) => { const value = await original(...args); mutate(value, f); return value; };
    await denied(f, () => f.boundary({ resolveProjectContent: resolver }).publish(f.owner, f.request()), code);
  }
  for (const change of ['threadId', 'projectId']) {
    const f = fixture('reply'), original = f.resolveProjectContent;
    await denied(f, () => f.boundary({ resolveProjectContent: async (...args) => { const value = await original(...args); value.target[change] = 'wrong-target'; return value; } })
      .publish(f.owner, f.request()), 'SOURCE_DENIED');
  }
});

test('private checker denial, missing or forged receipts, stale context and async current guards stop all handoffs', async () => {
  for (const mutate of [value => { value.payloadDigest = 'b'.repeat(64); }, value => { value.nonce = 'wrong'; },
    value => { value.extra = 'PRIVATE-MEMORY-CANARY'; }, value => { value.privateVersion = 'invalid'; }]) {
    const f = fixture(), inspector = { ...f.inspector, inspect: async (...args) => { const value = await f.inspector.inspect(...args); mutate(value); return value; } };
    await denied(f, () => f.boundary({ inspectPrivateBoundary: inspector }).publish(f.owner, f.request()), 'PRIVACY_UNAVAILABLE');
  }
  const f = fixture();
  await denied(f, () => f.boundary({ inspectPrivateBoundary: { ...f.inspector, assertCurrent: async () => true } }).publish(f.owner, f.request()), 'PRIVACY_UNAVAILABLE');
  const changed = fixture(), original = changed.goalStore.checkReservation;
  changed.goalStore.checkReservation = async (...args) => { const result = await original(...args); if (changed.authorityCalls === 2) changed.privateVersion = 'changed-during-authority'; return result; };
  await denied(changed, () => changed.boundary().publish(changed.owner, changed.request()), 'PRIVACY_UNAVAILABLE');
});

test('pause/revoke during catalog or privacy lookup denies publication after the required final reservation check', async () => {
  for (const phase of ['catalog', 'inspection']) {
    const f = fixture(), hold = deferred(); let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const resolver = async (...args) => { const value = await f.resolveProjectContent(...args); if (phase === 'catalog') { entered(); await hold.promise; } return value; };
    const inspector = { ...f.inspector, inspect: async (...args) => { const value = await f.inspector.inspect(...args); if (phase === 'inspection') { entered(); await hold.promise; } return value; } };
    const pending = f.boundary({ resolveProjectContent: resolver, inspectPrivateBoundary: inspector }).publish(f.owner, f.request());
    await ready; f.active = false; hold.release(); await denied(f, () => pending, 'AUTHORITY_DENIED');
  }
});

test('a changed private/control version between final async authority completion and handoff is fenced synchronously', async () => {
  const f = fixture(), original = f.goalStore.checkReservation;
  f.goalStore.checkReservation = async (...args) => {
    const value = await original(...args);
    if (f.authorityCalls === 2) queueMicrotask(() => { f.privateVersion = 'changed-local-control-version'; f.active = false; });
    return value;
  };
  await denied(f, () => f.boundary().publish(f.owner, f.request()), 'PRIVACY_UNAVAILABLE');
});

test('final grant and exact static work must remain current even if a dependency returns a different allowed version', async () => {
  const f = fixture(), original = f.goalStore.checkReservation;
  f.goalStore.checkReservation = async (...args) => { const result = await original(...args); if (f.authorityCalls === 2) result.grant.cardVersion++; return result; };
  await denied(f, () => f.boundary().publish(f.owner, f.request()), 'STALE');
  const wrong = fixture('reply'); wrong.goalStore.checkReservation = async () => ({ eligible: true, work: { projectId: PROJECT, action: 'create-task', taskType: 'research',
    resource: 'project', template: approvedTemplate() }, grant: { cardId: wrong.card, cardVersion: 1, authorizationGeneration: 1, reservationId: wrong.reservation,
    authorityReceiptDigest: 'a'.repeat(64), verifiedUntil: wrong.now + 10000 } });
  await denied(wrong, () => wrong.boundary().publish(wrong.owner, wrong.request()), 'AUTHORITY_DENIED');
});

test('unknown callbacks, getters, toJSON and raw dependency errors are never serialized to transport or audit', async () => {
  const f = fixture(); let invoked = 0;
  const request = Object.defineProperty({ ...f.request() }, 'requestId', { enumerable: true, get() { invoked++; return 'PRIVATE-CREDENTIAL-CANARY'; } });
  await denied(f, () => f.boundary().publish(f.owner, request), 'INVALID_REQUEST'); assert.equal(invoked, 0);
  const getter = fixture(), original = getter.resolveProjectContent;
  await denied(getter, () => getter.boundary({ resolveProjectContent: async (...args) => Object.defineProperty(await original(...args), 'template', {
    enumerable: true, get() { invoked++; return { toJSON() { throw new Error('PRIVATE-CREDENTIAL-CANARY'); } }; } }) }).publish(getter.owner, getter.request()), 'SOURCE_UNAVAILABLE');
  assert.equal(invoked, 0);
  const raw = fixture(); await denied(raw, () => raw.boundary({ resolveProjectContent: async () => { throw new Error('PRIVATE-CONVERSATION-CANARY'); } }).publish(raw.owner, raw.request()), 'SOURCE_UNAVAILABLE');
});

test('transport uncertainty never echoes a raw response or exception and performs no automatic retry', async () => {
  for (const response of ['throw', 'reject', 'extra-field', 'invalid-id']) {
    const f = fixture(); let attempts = 0;
    const transport = () => { attempts++; if (response === 'throw') throw new Error('PRIVATE-CREDENTIAL-CANARY');
      if (response === 'reject') return Promise.reject(new Error('PRIVATE-MEMORY-CANARY'));
      return response === 'extra-field' ? { id: RESULT, debug: 'PRIVATE-CONVERSATION-CANARY' } : { id: 'PRIVATE-GOAL-CANARY' }; };
    await assert.rejects(() => f.boundary({ transport }).publish(f.owner, f.request()), error => error.code === 'BOARD_BOUNDARY_TRANSPORT_UNCERTAIN' && !inspect(error).includes('CANARY'));
    assert.equal(attempts, 1);
    for (const audit of f.audits) assert.ok(!JSON.stringify(audit).includes('CANARY'));
  }
});

test('shared inspection digest binds every compiled field and independent public retry metadata', async () => {
  const f = fixture(); let packet;
  const inspector = { ...f.inspector, inspect: async (owner, input) => { packet = input; return f.inspector.inspect(owner, input); } };
  await f.boundary({ inspectPrivateBoundary: inspector }).publish(f.owner, f.request());
  assert.equal(projectInspectionDigest(packet.payload), packet.payloadDigest);
  const changed = structuredClone(packet.payload); changed.call.args.description += ' changed';
  assert.notEqual(projectInspectionDigest(changed), packet.payloadDigest);
  assert.ok(!JSON.stringify(packet.payload).includes('PRIVATE-REQUEST-CANARY'));
  assert.notEqual(packet.payload.publicRequestKey, f.owner); assert.notEqual(packet.payload.publicRequestKey, f.reservation);
  const raw = structuredClone(packet.payload); raw.call.args.session_id = 'PRIVATE-CREDENTIAL-CANARY';
  assert.throws(() => projectInspectionDigest(raw), error => error.code === 'BOARD_BOUNDARY_INVALID_REQUEST');
});
