import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBoardPrivateInspector } from '../src/board-private-inspector.mjs';
import { projectInspectionDigest } from '../src/board-boundary.mjs';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKERS = ['SYNTHETIC-PRIVATE-CONVERSATION-729', 'SYNTHETIC-PRIVATE-MEMORY-148', 'SYNTHETIC-PRIVATE-PERSONALITY-902',
  'SYNTHETIC-PRIVATE-GOAL-657', 'https://example.invalid/private/secret-829', 'SYNTHETIC-PRIVATE-CREDENTIAL-354', 'SYNTHETIC-PRIVATE-IDENTIFIER-873'];
function fixture() {
  const f = { clock: 100000, version: 'synthetic-combined-revision-1', markers: [...MARKERS], owner: OWNER, complete: true, freshUntil: 120000, calls: 0, load: null };
  f.inspector = createBoardPrivateInspector({ now: () => f.clock, loadPrivateContext: owner => {
    f.calls++; if (f.load) return f.load(owner);
    return { version: f.version, companionId: f.owner, complete: f.complete, freshUntil: f.freshUntil, markers: f.markers };
  } }); return f;
}
function envelope(operation = 'ticket', value = 'Inspect the named public project artifact.') {
  const publicRequestKey = randomUUID(), projectId = 'synthetic-project';
  const template = { title: 'Review public release', instructions: value, acceptanceCriteria: 'Return project-only findings.' };
  const call = operation === 'ticket' ? { tool: 'create_ticket', args: { project_id: projectId, title: template.title, description: value,
    acceptance_criteria: template.acceptanceCriteria, idempotency_key: publicRequestKey } }
    : operation === 'attachment' ? { tool: 'upload_attachment', args: { thread_id: 'public-thread', filename: 'project-work.json',
      content_base64: Buffer.from(JSON.stringify({ version: 1, projectId, template })).toString('base64'), idempotency_key: publicRequestKey, content_type: 'application/json' } }
      : { tool: 'post_message', args: { thread_id: 'public-thread', body: value, idempotency_key: publicRequestKey } };
  return { version: 1, operation, projectId, publicRequestKey, call };
}
function request(f, payload = envelope()) {
  return { version: 1, operation: payload.operation, projectId: payload.projectId, payloadDigest: projectInspectionDigest(payload), payload,
    nonce: randomUUID(), issuedAt: f.clock, expiresAt: f.clock + 10000 };
}
const binding = result => ({ privateVersion: result.privateVersion, payloadDigest: result.payloadDigest, nonce: result.nonce, expiresAt: result.expiresAt });
const fixed = error => error.code === 'PRIVATE_INSPECTION_UNAVAILABLE' && error.message === 'Private boundary inspection is unavailable.'
  && !Object.hasOwn(error, 'cause') && !JSON.stringify(error).includes('SYNTHETIC-PRIVATE');

test('four exact compiled project shapes can pass a complete synthetic corpus and receipts are private, bound and one-shot', async () => {
  const f = fixture();
  for (const operation of ['ticket', 'reply', 'comment', 'attachment']) {
    const input = request(f, envelope(operation)), result = await f.inspector.inspect(OWNER, input);
    assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'nonce', 'payloadDigest', 'privateVersion', 'verdict']);
    assert.equal(result.verdict, 'allow'); assert.equal(result.payloadDigest, input.payloadDigest); assert.match(result.privateVersion, /^[A-Za-z0-9_-]{43}$/);
    for (const secret of [...MARKERS, OWNER, f.version]) assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(f.inspector.assertCurrent(OWNER, binding(result)), true);
    assert.throws(() => f.inspector.assertCurrent(OWNER, binding(result)), fixed);
  }
  assert.equal(f.calls, 8);
});

test('known conversation, memory, personality, goal, link, ID and credential markers deny every outbound content channel', async () => {
  const f = fixture();
  for (const operation of ['ticket', 'reply', 'comment', 'attachment']) for (const marker of MARKERS) {
    const result = await f.inspector.inspect(OWNER, request(f, envelope(operation, 'Project text ' + marker)));
    assert.equal(result.verdict, 'deny'); assert.throws(() => f.inspector.assertCurrent(OWNER, binding(result)), fixed);
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test('bounded common encodings and Unicode normalization cannot hide a known marker', async () => {
  const f = fixture(), marker = MARKERS[0];
  const encodings = [marker.toLowerCase(), marker.split('').join('\u200b'), [...marker].map(character => String.fromCharCode(character.charCodeAt(0) + 0xfee0)).join(''),
    [...marker].map(character => '%' + character.charCodeAt(0).toString(16)).join(''),
    [...marker].map(character => '%25' + character.charCodeAt(0).toString(16)).join(''),
    [...marker].map(character => '&#' + character.charCodeAt(0) + ';').join(''),
    [...marker].map(character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join(''),
    Buffer.from(marker).toString('base64'), Buffer.from(marker).toString('base64url'), 'hex:' + Buffer.from(marker).toString('hex'),
    Buffer.from(marker).toString('base64').split('').join('\u200b'),
    [...Buffer.from(marker).toString('base64')].map(character => String.fromCharCode(character.charCodeAt(0) + 0xfee0)).join('')];
  for (const value of encodings) {
    assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('comment', value)))).verdict, 'deny');
    assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('reply', 'Reference ' + value + ' for this project.')))).verdict, 'deny');
    assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('attachment', 'Reference ' + value + ' for this project.')))).verdict, 'deny');
  }
  f.markers = ['SYNTHETIC-PRIVATE-EMOJI-😀'];
  assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('reply', 'SYNTHETIC-PRIVATE-EMOJI-\\ud83d\\ude00')))).verdict, 'deny');
  let nested = marker; for (let count = 0; count < 4; count++) nested = Buffer.from(nested).toString('base64');
  await assert.rejects(f.inspector.inspect(OWNER, request(f, envelope('reply', nested))), fixed);
});

test('the full envelope includes public retry keys, destination references and generated attachment content', async () => {
  const f = fixture(), metadata = envelope('reply');
  f.markers.push(metadata.publicRequestKey);
  assert.equal((await f.inspector.inspect(OWNER, request(f, metadata))).verdict, 'deny');
  const destination = envelope('comment'); destination.call.args.thread_id = OWNER;
  assert.equal((await f.inspector.inspect(OWNER, request(f, destination))).verdict, 'deny');
  const attachment = envelope('attachment', Buffer.from(MARKERS[1]).toString('base64'));
  assert.equal((await f.inspector.inspect(OWNER, request(f, attachment))).verdict, 'deny');
  for (const change of [payload => { payload.call.args.filename = MARKERS[0] + '.json'; },
    payload => { payload.call.args.content_base64 = '/w=='; }, payload => { payload.call.args.content_base64 = 'not valid base64!'; },
    payload => { payload.call.args.content_base64 = Buffer.from(JSON.stringify({ version: 1, projectId: payload.projectId, template: { title: 'A', instructions: 'B', acceptanceCriteria: 'C' } })).toString('base64') + '='; },
    payload => { payload.call.args.content_base64 = Buffer.from('{"version":1,"projectId":"wrong","template":{}}').toString('base64'); },
    payload => { payload.call.args.extra_metadata = MARKERS[0]; }]) {
    const input = request(f, envelope('attachment')); change(input.payload); await assert.rejects(f.inspector.inspect(OWNER, input), fixed);
  }
});

test('common credentials, sensitive query links and local/private links deny independently of seeded markers', async () => {
  const f = fixture(); f.markers = [];
  const values = ['sk-proj-' + 'a'.repeat(32), 'ghp_' + 'b'.repeat(30), '-----BEGIN PRIVATE KEY-----', 'Authorization: Bearer synthetic-token-123',
    'password=synthetic-secret', '__Secure-blackout_session=' + 'z'.repeat(43), 'https://example.invalid/public?access_token=synthetic-secret',
    'https://user:password@example.invalid/public', 'http://127.0.0.1/private', 'http://2130706433/private', 'http://localhost./private',
    'http://service.internal/private', 'http://192.168.1.2/private', 'http://[::1]/private', 'file:///home/synthetic/private', 'C:\\Users\\Synthetic\\.codex\\auth.json'];
  for (const [index, value] of values.entries()) assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('reply', value)))).verdict, 'deny', 'Guarded credential/link fixture ' + index);
  assert.equal((await f.inspector.inspect(OWNER, request(f, envelope('reply', 'Read https://example.invalid/public/docs; report public findings.')))).verdict, 'allow');
});

test('unavailable, incomplete, stale, foreign or unbounded corpus sources fail closed without diagnostics', async () => {
  const f = fixture();
  await assert.rejects(createBoardPrivateInspector({ now: () => f.clock }).inspect(OWNER, request(f)), fixed);
  for (const load of [() => { throw new Error('SYNTHETIC-PRIVATE-ERROR /private/credentials'); }, () => Promise.resolve({}),
    () => ({ version: 'v1', companionId: OTHER, complete: true, freshUntil: f.clock + 1000, markers: [] }),
    () => ({ version: 'v1', companionId: OWNER, complete: false, freshUntil: f.clock + 1000, markers: [] }),
    () => ({ version: 'v1', companionId: OWNER, complete: true, freshUntil: f.clock, markers: [] }),
    () => ({ version: 'v1', companionId: OWNER, complete: true, freshUntil: f.clock + 1000, markers: ['x'.repeat(4097)] }),
    () => ({ version: 'v1', companionId: OWNER, complete: true, freshUntil: f.clock + 1000, markers: Array(1025).fill('synthetic') })]) {
    f.load = load; await assert.rejects(f.inspector.inspect(OWNER, request(f)), fixed);
  }
});

test('final synchronous assertion fences marker changes, combined authority revision, freshness, scope and expiry', async () => {
  for (const change of [f => { f.markers.push('A newly private synthetic value'); }, f => { f.version = 'synthetic-revoked-goal-generation'; },
    f => { f.owner = OTHER; }, f => { f.complete = false; }, f => { f.freshUntil = f.clock + 1; }, f => { f.clock += 10000; }]) {
    const f = fixture(), result = await f.inspector.inspect(OWNER, request(f)); change(f);
    assert.throws(() => f.inspector.assertCurrent(OWNER, binding(result)), fixed);
  }
  const f = fixture(), result = await f.inspector.inspect(OWNER, request(f));
  assert.throws(() => f.inspector.assertCurrent(OTHER, binding(result)), fixed);
  for (const change of [value => ({ ...value, nonce: randomUUID() }), value => ({ ...value, payloadDigest: '0'.repeat(64) }),
    value => ({ ...value, expiresAt: value.expiresAt + 1 }), value => ({ ...value, extra: 'private' })]) {
    assert.throws(() => f.inspector.assertCurrent(OWNER, change(binding(result))), fixed);
  }
  assert.equal(f.inspector.assertCurrent(OWNER, binding(result)), true);
});

test('challenge digest, scope, deadline and nonce replay refuse; unsafe descriptors never execute', async () => {
  const f = fixture(), good = request(f);
  for (const change of [value => ({ ...value, payloadDigest: '0'.repeat(64) }), value => ({ ...value, projectId: 'other-project' }),
    value => ({ ...value, operation: 'comment' }), value => ({ ...value, expiresAt: value.issuedAt + 10001 }),
    value => ({ ...value, issuedAt: f.clock + 1 }), value => ({ ...value, extra: MARKERS[0] })]) {
    await assert.rejects(f.inspector.inspect(OWNER, change(good)), fixed);
  }
  await f.inspector.inspect(OWNER, good); await assert.rejects(f.inspector.inspect(OWNER, good), fixed);
  let reads = 0;
  const unsafe = { ...request(f) }; Object.defineProperty(unsafe, 'payload', { enumerable: true, get() { reads++; throw new Error(MARKERS[0]); } });
  await assert.rejects(f.inspector.inspect(OWNER, unsafe), fixed); assert.equal(reads, 0);
  const payload = envelope(); Object.defineProperty(payload.call.args, 'description', { enumerable: true, get() { reads++; throw new Error(MARKERS[0]); } });
  await assert.rejects(f.inspector.inspect(OWNER, { ...request(f), payload }), fixed); assert.equal(reads, 0);
});
