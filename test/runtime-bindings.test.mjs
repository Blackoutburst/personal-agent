import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { RuntimeBindingStore, RuntimeBindingError, RUNTIME_BINDING_AUDIENCE, RUNTIME_AUTHORITY_MAX_TTL_MS } from '../src/runtime-bindings.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INVALID = 'RUNTIME_BINDING_INVALID_REQUEST', MISSING = 'RUNTIME_BINDING_NOT_FOUND';
const CONFLICT = 'RUNTIME_BINDING_CONFLICT', UNAVAILABLE = 'RUNTIME_BINDING_UNAVAILABLE';
const AUTH_UNAVAILABLE = 'RUNTIME_AUTHORITY_UNAVAILABLE', REJECTED = 'RUNTIME_AUTHORITY_REJECTED';
const REF_A = { runtimeId: 'synthetic-runtime-a', runtimeInstance: 'incarnation-a' };
const REF_B = { runtimeId: 'synthetic-runtime-b', runtimeInstance: 'incarnation-b' };
const SHA = text => createHash('sha256').update(text).digest('hex');
const request = (ref, expectedGeneration = 0, requestId = randomUUID()) => ({ requestId, expectedGeneration, ...ref });
const answer = (challenge, context) => ({ challengeDigest: context.challengeDigest,
  receiptDigest: SHA('synthetic-authority-receipt\0' + challenge.nonce), expiresAt: challenge.expiresAt });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-binding-test-')), stores = new Set();
  const f = { dir, open() { const bootstrap = new BootstrapStore(dir, ROOT); stores.add(bootstrap); return bootstrap; },
    close(bootstrap) { bootstrap.close(); stores.delete(bootstrap); }, calls: [], seen: new Set(), enrolled: new Map() };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.bootstrap = f.open();
  for (const label of ['a', 'b']) {
    f[label + 'Key'] = principalKey({ issuer: 'https://synthetic.invalid', subject: 'synthetic-owner-' + label });
    f[label] = f.bootstrap.getOrInsert('companion-identity-v1', f[label + 'Key'], { companionId: randomUUID() }).companionId;
  }
  f.enroll = (ref, companionId, identityKey) => f.enrolled.set(JSON.stringify(ref), { companionId, identityKey });
  f.enroll(REF_A, f.a, f.aKey); f.enroll(REF_B, f.b, f.bKey);
  // This synthetic fixture models independently enrolled authority. It is not real runtime qualification.
  f.verifier = async (challenge, context) => {
    assert.ok(Object.isFrozen(challenge)); assert.ok(Object.isFrozen(context));
    assert.equal(challenge.version, 1); assert.equal(challenge.audience, RUNTIME_BINDING_AUDIENCE);
    assert.ok(['register', 'route', 'rebind'].includes(challenge.action));
    assert.equal(challenge.expiresAt - challenge.issuedAt, RUNTIME_AUTHORITY_MAX_TTL_MS);
    assert.equal(context.challengeDigest, SHA('personal-agent-runtime-challenge-v1\0' + JSON.stringify(challenge)));
    assert.ok(!f.seen.has(challenge.nonce)); f.seen.add(challenge.nonce); f.calls.push(challenge);
    const owner = f.enrolled.get(JSON.stringify({ runtimeId: challenge.runtimeId, runtimeInstance: challenge.runtimeInstance }));
    if (!owner || owner.companionId !== challenge.companionId || owner.identityKey !== challenge.identityKey) return null;
    return answer(challenge, context);
  };
  f.bindings = new RuntimeBindingStore(f.bootstrap, { verifyAuthority: f.verifier });
  return f;
}
async function denied(run, code, secret = '') {
  await assert.rejects(run, error => {
    assert.ok(error instanceof RuntimeBindingError); assert.equal(error.code, code);
    if (secret) assert.ok(!inspect(error, { depth: 5 }).includes(secret));
    return true;
  });
}
function deniedSync(run, code) { assert.throws(run, error => error instanceof RuntimeBindingError && error.code === code); }
function deferredAuthority() {
  let enteredResolve, release;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const verifyAuthority = (challenge, context) => new Promise(resolve => {
    release = () => resolve(answer(challenge, context)); enteredResolve({ challenge, context });
  });
  return { entered, verifyAuthority, release: () => release() };
}

test('default authority cannot register or route; local disconnect is only a generation fence', async t => {
  const f = fixture(t), bindings = new RuntimeBindingStore(f.bootstrap);
  await denied(() => bindings.register(f.a, request(REF_A)), AUTH_UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_owner').get().count, 0);
  const receipt = bindings.disconnect(f.a, { requestId: 'local-initial-fence', expectedGeneration: 0 });
  assert.deepEqual(receipt, { requestId: 'local-initial-fence', action: 'disconnect', generation: 1,
    state: 'disconnected', challengeDigest: null, authorityReceiptDigest: null });
  assert.equal(f.calls.length, 0);
  await denied(() => bindings.resolve(f.a, request(REF_A, 1)), MISSING);
  await denied(() => bindings.register(f.a, request(REF_A)), CONFLICT);
});

test('two independently enrolled owners resolve only exact owner-derived references and generations', async t => {
  const f = fixture(t), first = await f.bindings.register(f.a, request(REF_A)), other = await f.bindings.register(f.b, request(REF_B));
  assert.equal(first.generation, 1); assert.equal(other.generation, 1);
  assert.deepEqual(Object.keys(first), ['requestId', 'action', 'generation', 'state', 'challengeDigest', 'authorityReceiptDigest']);
  assert.ok(!JSON.stringify(first).includes(REF_A.runtimeId));
  const current = await f.bindings.resolve(f.a, request(REF_A, 1, 'owner-a-route'));
  assert.deepEqual({ companionId: current.companionId, runtimeId: current.runtimeId, runtimeInstance: current.runtimeInstance, generation: current.generation },
    { companionId: f.a, ...REF_A, generation: 1 });
  assert.ok(current.verifiedUntil > Date.now());
  assert.equal(f.calls.at(-1).identityKey, f.aKey); assert.equal(f.calls.at(-1).action, 'route');
  const before = f.calls.length;
  await denied(() => f.bindings.resolve(f.b, request(REF_A, 1)), CONFLICT);
  await denied(() => f.bindings.resolve(randomUUID(), request(REF_A, 1)), UNAVAILABLE);
  assert.equal(f.calls.length, before, 'Foreign references fail before authority lookup');
  assert.ok(!JSON.stringify(f.bootstrap.db.prepare('SELECT * FROM runtime_binding_owner').all()).includes('synthetic-owner-'));
});

test('one runtime incarnation remains reserved to one owner even after local disconnect', async t => {
  const f = fixture(t);
  await f.bindings.register(f.a, request(REF_A));
  await denied(() => f.bindings.register(f.b, request(REF_A)), CONFLICT);
  f.bindings.disconnect(f.a, { requestId: 'fence-a', expectedGeneration: 1 });
  await denied(() => f.bindings.register(f.b, request(REF_A)), CONFLICT);
  const distinct = { runtimeId: REF_A.runtimeId, runtimeInstance: 'independently-enrolled-other-incarnation' };
  f.enroll(distinct, f.b, f.bKey);
  assert.equal((await f.bindings.register(f.b, request(distinct))).generation, 1);
});

test('deleted or rewritten inactive reservations cannot be adopted by a foreign owner', async t => {
  for (const change of ['delete', 'rewrite']) {
    const f = fixture(t); await f.bindings.register(f.a, request(REF_A));
    f.bindings.disconnect(f.a, { requestId: 'local-fence', expectedGeneration: 1 });
    if (change === 'delete') f.bootstrap.db.prepare('DELETE FROM runtime_binding_incarnation WHERE runtime_id=?').run(REF_A.runtimeId);
    else f.bootstrap.db.prepare('UPDATE runtime_binding_incarnation SET runtime_instance=? WHERE runtime_id=?').run('rewritten-but-same-count', REF_A.runtimeId);
    const calls = f.calls.length;
    await denied(() => f.bindings.register(f.b, request(REF_A)), UNAVAILABLE);
    deniedSync(() => new RuntimeBindingStore(f.bootstrap, { verifyAuthority: f.verifier }), UNAVAILABLE);
    assert.equal(f.calls.length, calls, 'Reservation corruption fails before authority lookup');
    assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_owner WHERE companion_id=?').get(f.b).count, 0);
  }
});

test('explicit rebind preserves companion identity, fences old references and makes retries metadata-only', async t => {
  const f = fixture(t), original = request(REF_A, 0, 'original-register');
  const first = await f.bindings.register(f.a, original);
  const newer = { runtimeId: REF_A.runtimeId, runtimeInstance: 'incarnation-a-new' }; f.enroll(newer, f.a, f.aKey);
  const rebinding = request(newer, 1, 'explicit-rebind'), second = await f.bindings.rebind(f.a, rebinding);
  assert.equal(second.generation, 2);
  await denied(() => f.bindings.resolve(f.a, request(REF_A, 1)), CONFLICT);
  await denied(() => f.bindings.resolve(f.a, request(REF_A, 2)), CONFLICT);
  const calls = f.calls.length;
  assert.deepEqual(await f.bindings.register(f.a, original), first);
  assert.deepEqual(await f.bindings.rebind(f.a, rebinding), second);
  assert.equal(f.calls.length, calls, 'Historical receipts never refresh authority');
  assert.ok(!Object.hasOwn(first, 'runtimeId')); assert.ok(!Object.hasOwn(first, 'verifiedUntil'));
  await denied(() => f.bindings.register(f.a, { ...original, runtimeInstance: 'different' }), CONFLICT);
  const routed = await f.bindings.resolve(f.a, request(newer, 2));
  assert.equal(routed.companionId, f.a); assert.equal(routed.runtimeInstance, newer.runtimeInstance);
  const fence = { requestId: 'local-fence', expectedGeneration: 2 };
  const disconnected = f.bindings.disconnect(f.a, fence);
  assert.equal(disconnected.generation, 3); assert.deepEqual(f.bindings.disconnect(f.a, fence), disconnected);
  await denied(() => f.bindings.resolve(f.a, request(newer, 2)), CONFLICT);
  await denied(() => f.bindings.resolve(f.a, request(newer, 3)), MISSING);
  assert.deepEqual(await f.bindings.register(f.a, original), first);
  assert.equal((await f.bindings.rebind(f.a, request(newer, 3))).generation, 4, 'Returning to an owned incarnation still needs explicit fresh verified rebind');
  assert.equal(f.bootstrap.get('companion-identity-v1', f.aKey).companionId, f.a);
});

test('restart preserves binding generations, exclusive incarnation ownership and replay receipts', async t => {
  const f = fixture(t), op = request(REF_A, 0, 'persisted-register'), receipt = await f.bindings.register(f.a, op);
  f.close(f.bootstrap);
  const bootstrap = f.open(), restarted = new RuntimeBindingStore(bootstrap, { verifyAuthority: f.verifier });
  assert.deepEqual(await restarted.register(f.a, op), receipt);
  assert.equal((await restarted.resolve(f.a, request(REF_A, 1))).companionId, f.a);
  await denied(() => restarted.register(f.b, request(REF_A)), CONFLICT);
  const noAuthority = new RuntimeBindingStore(bootstrap);
  await denied(() => noAuthority.resolve(f.a, request(REF_A, 1)), AUTH_UNAVAILABLE);
});

test('a local fence cancels an initial registration awaiting independent authority', async t => {
  const f = fixture(t), deferred = deferredAuthority(), bindings = new RuntimeBindingStore(f.bootstrap, deferred);
  const pending = bindings.register(f.a, request(REF_A));
  await deferred.entered;
  const fence = f.bindings.disconnect(f.a, { requestId: 'cancel-pending', expectedGeneration: 0 });
  assert.equal(fence.generation, 1);
  deferred.release(); await denied(() => pending, CONFLICT);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_incarnation').get().count, 0);
  assert.equal(f.bootstrap.db.prepare('SELECT state FROM runtime_binding_owner WHERE companion_id=?').get(f.a).state, 'disconnected');
});

test('late rebind and route callbacks cannot commit or return references after a newer generation', async t => {
  const f = fixture(t); await f.bindings.register(f.a, request(REF_A));
  const oldCandidate = { runtimeId: REF_A.runtimeId, runtimeInstance: 'late-candidate' };
  const winner = { runtimeId: REF_A.runtimeId, runtimeInstance: 'new-current' }; f.enroll(winner, f.a, f.aKey);
  const deferred = deferredAuthority(), delayed = new RuntimeBindingStore(f.bootstrap, deferred);
  const pending = delayed.rebind(f.a, request(oldCandidate, 1)); await deferred.entered;
  await f.bindings.rebind(f.a, request(winner, 1));
  deferred.release(); await denied(() => pending, CONFLICT);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_incarnation WHERE runtime_instance=?').get(oldCandidate.runtimeInstance).count, 0);
  const routeAuthority = deferredAuthority(), pendingRoute = new RuntimeBindingStore(f.bootstrap, routeAuthority).resolve(f.a, request(winner, 2));
  await routeAuthority.entered;
  f.bindings.disconnect(f.a, { requestId: 'cancel-route', expectedGeneration: 2 });
  routeAuthority.release(); await denied(() => pendingRoute, CONFLICT);
});

test('competing owners cannot both commit the same incarnation after asynchronous proofs', async t => {
  const f = fixture(t), left = deferredAuthority(), right = deferredAuthority();
  const a = new RuntimeBindingStore(f.bootstrap, left).register(f.a, request(REF_A));
  const b = new RuntimeBindingStore(f.bootstrap, right).register(f.b, request(REF_A));
  await Promise.all([left.entered, right.entered]); left.release(); right.release();
  const outcomes = await Promise.allSettled([a, b]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, CONFLICT);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_incarnation').get().count, 1);
});

test('immutable identity mapping is rechecked after asynchronous verification', async t => {
  const f = fixture(t), deferred = deferredAuthority();
  const pending = new RuntimeBindingStore(f.bootstrap, deferred).register(f.a, request(REF_A));
  await deferred.entered;
  const changedKey = principalKey({ issuer: 'https://synthetic.invalid', subject: 'different-owner' });
  f.bootstrap.db.prepare('UPDATE bootstrap_record SET key=? WHERE namespace=? AND key=?').run(changedKey, 'companion-identity-v1', f.aKey);
  deferred.release(); await denied(() => pending, UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_owner').get().count, 0);
});

test('authority rejection, malformed responses and expired or excessive proof lifetimes stay fixed and private', async t => {
  const f = fixture(t), secret = 'synthetic-private-verifier-detail'; let getters = 0;
  const variants = [
    [async () => null, REJECTED], [async () => { throw new Error(secret); }, AUTH_UNAVAILABLE],
    [async () => { throw new RuntimeBindingError(REJECTED); }, AUTH_UNAVAILABLE],
    [async () => undefined, AUTH_UNAVAILABLE],
    [async (c, x) => ({ ...answer(c, x), challengeDigest: 'a'.repeat(64) }), AUTH_UNAVAILABLE],
    [async (c, x) => ({ ...answer(c, x), expiresAt: c.issuedAt }), AUTH_UNAVAILABLE],
    [async (c, x) => ({ ...answer(c, x), expiresAt: c.expiresAt + 1 }), AUTH_UNAVAILABLE],
    [async (c, x) => ({ ...answer(c, x), receiptDigest: secret }), AUTH_UNAVAILABLE],
    [async (c, x) => ({ ...answer(c, x), credentials: secret }), AUTH_UNAVAILABLE],
    [async (c, x) => Object.defineProperty(answer(c, x), 'receiptDigest', { enumerable: true, get() { getters++; return secret; } }), AUTH_UNAVAILABLE]
  ];
  for (const [verifyAuthority, code] of variants) {
    const bindings = new RuntimeBindingStore(f.bootstrap, { verifyAuthority });
    await denied(() => bindings.register(f.a, request(REF_A)), code, secret);
  }
  assert.equal(getters, 0);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_owner').get().count, 0);
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_incarnation').get().count, 0);
});

test('each route needs a fresh exact action/nonce-bound proof; old responses cannot be replayed', async t => {
  const f = fixture(t); let oldResponse;
  const record = new RuntimeBindingStore(f.bootstrap, { verifyAuthority: async (c, x) => { oldResponse = answer(c, x); return oldResponse; } });
  await record.register(f.a, request(REF_A));
  const stale = new RuntimeBindingStore(f.bootstrap, { verifyAuthority: async () => oldResponse });
  await denied(() => stale.resolve(f.a, request(REF_A, 1)), AUTH_UNAVAILABLE);
  await f.bindings.resolve(f.a, request(REF_A, 1, 'same-route-id'));
  await f.bindings.resolve(f.a, request(REF_A, 1, 'same-route-id'));
  assert.notEqual(f.calls[0].nonce, f.calls[1].nonce);
  assert.equal(f.calls[0].expectedGeneration, 1);
  assert.equal(f.calls[0].requestId, 'same-route-id');
});

test('unavailable verifier is bounded and late completion cannot write a binding', { timeout: 15000 }, async t => {
  const f = fixture(t), deferred = deferredAuthority(), bindings = new RuntimeBindingStore(f.bootstrap, deferred);
  const started = Date.now(), pending = bindings.register(f.a, request(REF_A));
  const entered = await deferred.entered;
  await denied(() => pending, AUTH_UNAVAILABLE);
  assert.ok(Date.now() - started >= RUNTIME_AUTHORITY_MAX_TTL_MS - 100);
  assert.ok(entered.context.signal.aborted);
  deferred.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_owner').get().count, 0);
});

test('inputs cannot select credentials, private paths, authority keys or unbounded scopes', async t => {
  const f = fixture(t), base = request(REF_A);
  for (const field of ['companionId', 'owner', 'identityKey', 'credentials', 'privatePath', 'publicKey']) {
    await denied(() => f.bindings.register(f.a, { ...base, [field]: 'synthetic-secret-canary' }), INVALID, 'synthetic-secret-canary');
  }
  for (const runtimeId of ['', 'x'.repeat(129), '/private/path', 'private@example.invalid']) {
    await denied(() => f.bindings.register(f.a, { ...base, runtimeId }), INVALID);
  }
  for (const expectedGeneration of [-1, 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await denied(() => f.bindings.register(f.a, { ...base, expectedGeneration }), INVALID);
  }
  const getter = Object.defineProperty({ ...base }, 'runtimeId', { enumerable: true, get() { throw new Error('not invoked'); } });
  await denied(() => f.bindings.register(f.a, getter), INVALID);
  const hostile = new Proxy(base, { getPrototypeOf() { throw new Error('private-input-shape-detail'); } });
  await denied(() => f.bindings.register(f.a, hostile), INVALID, 'private-input-shape-detail');
  deniedSync(() => f.bindings.disconnect(f.a, hostile), INVALID);
  assert.equal(f.calls.length, 0);
});

test('schema, generation and receipt corruption fail closed; a wholesale reset is never adopted', async t => {
  const f = fixture(t), op = request(REF_A), receipt = await f.bindings.register(f.a, op);
  f.bootstrap.db.prepare('UPDATE runtime_binding_owner SET generation=5 WHERE companion_id=?').run(f.a);
  await denied(() => f.bindings.resolve(f.a, request(REF_A, 5)), UNAVAILABLE);
  f.bootstrap.db.prepare('UPDATE runtime_binding_owner SET generation=1 WHERE companion_id=?').run(f.a);
  f.bootstrap.db.prepare('UPDATE runtime_binding_request SET result_json=? WHERE companion_id=?').run(JSON.stringify({ ...receipt, requestId: 'forged' }), f.a);
  await denied(() => f.bindings.register(f.a, op), UNAVAILABLE);
  f.bootstrap.db.prepare('UPDATE runtime_binding_request SET result_json=? WHERE companion_id=?').run(JSON.stringify(receipt), f.a);
  f.bootstrap.db.exec('CREATE TRIGGER unexpected_runtime_hook AFTER INSERT ON runtime_binding_request BEGIN UPDATE runtime_binding_owner SET generation=1; END');
  deniedSync(() => new RuntimeBindingStore(f.bootstrap), UNAVAILABLE);
  await denied(() => f.bindings.resolve(f.a, request(REF_A, 1)), UNAVAILABLE);
  f.bootstrap.db.exec('DROP TRIGGER unexpected_runtime_hook');
  for (const name of ['schema', 'owner', 'incarnation', 'request']) f.bootstrap.db.exec('DROP TABLE runtime_binding_' + name);
  deniedSync(() => new RuntimeBindingStore(f.bootstrap), UNAVAILABLE);
  assert.equal(f.bootstrap.db.prepare("SELECT count(*) count FROM sqlite_master WHERE name GLOB 'runtime_binding_*'").get().count, 0);
});

test('failed persistence atomically rolls back reservation, binding and receipt before a safe retry', async t => {
  const f = fixture(t), op = request(REF_A), actual = f.bootstrap.db.prepare.bind(f.bootstrap.db);
  const commitment = f.bootstrap.get('runtime-binding-ledger-v1', 'reservation-commitment');
  f.bootstrap.db.prepare = sql => sql.startsWith('INSERT INTO runtime_binding_request') ?
    { run() { throw new Error('synthetic-private-sql-detail'); } } : actual(sql);
  try { await denied(() => f.bindings.register(f.a, op), UNAVAILABLE, 'synthetic-private-sql-detail'); }
  finally { f.bootstrap.db.prepare = actual; }
  for (const table of ['owner', 'incarnation', 'request']) assert.equal(f.bootstrap.db.prepare('SELECT count(*) count FROM runtime_binding_' + table).get().count, 0);
  assert.deepEqual(f.bootstrap.get('runtime-binding-ledger-v1', 'reservation-commitment'), commitment);
  assert.equal((await f.bindings.register(f.a, op)).generation, 1);
});
