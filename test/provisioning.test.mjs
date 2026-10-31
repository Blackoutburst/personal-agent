import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { Worker } from 'node:worker_threads';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey, createCompanionProvisioner } from '../src/provisioning.mjs';

// Injected validators below are synthetic test doubles, never authentication proof.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRINCIPAL = { issuer: 'https://synthetic-issuer.invalid', subject: 'synthetic-pilot' };
const PROOF = { synthetic: true, session: 'test-session-only' };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-provisioning-test-'));
  const stores = new Set();
  const workers = new Set();
  t.after(async () => {
    await Promise.all([...workers].map(worker => worker.terminate()));
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, workers,
    open() { const store = new BootstrapStore(dir, ROOT); stores.add(store); return store; },
    close(store) { store.close(); stores.delete(store); },
  };
}

async function denied(run, code, proof = PROOF, secret = '') {
  await assert.rejects(() => run(proof), error => {
    assert.equal(error.code, code);
    if (secret) assert.ok(!inspect(error, { depth: 5 }).includes(secret), 'Raw validator error must stay private');
    return true;
  });
}

test('untrusted claims cannot provision without a valid, invited account', async t => {
  const store = fixture(t).open();
  const setup = { store, pilotSubjects: [PRINCIPAL] };
  await denied(createCompanionProvisioner(setup), 'ACCOUNT_VALIDATION_UNAVAILABLE', PRINCIPAL);
  await denied(createCompanionProvisioner({ ...setup, validateAccount: async () => null }), 'AUTHENTICATION_REQUIRED');
  for (const account of [undefined, {}, [], { ...PRINCIPAL, subject: '' }]) {
    await denied(createCompanionProvisioner({ ...setup, validateAccount: async () => account }), 'ACCOUNT_VALIDATION_UNAVAILABLE');
  }
  const secret = 'synthetic-validator-private-detail';
  await denied(createCompanionProvisioner({ ...setup, validateAccount: async () => { throw new Error(secret); } }), 'ACCOUNT_VALIDATION_UNAVAILABLE', PROOF, secret);
  for (const account of [{ ...PRINCIPAL, subject: 'Synthetic-pilot' }, { ...PRINCIPAL, issuer: 'https://other-issuer.invalid' }]) {
    await denied(createCompanionProvisioner({ ...setup, validateAccount: async () => account }), 'INVITATION_REQUIRED');
  }
  await denied(createCompanionProvisioner({ store, validateAccount: async () => PRINCIPAL }), 'INVITATION_REQUIRED');
  assert.equal(store.count(), 0, 'Rejected requests must not create a companion record');
});

test('principal tuple identity is stable, distinct and persisted across store reopen', async t => {
  const f = fixture(t);
  const accounts = [PRINCIPAL, { ...PRINCIPAL, subject: 'synthetic-second' }, { ...PRINCIPAL, issuer: 'https://other-issuer.invalid' }];
  assert.match(principalKey(PRINCIPAL), /^[a-f0-9]{64}$/);
  assert.equal(principalKey({ ...PRINCIPAL }), principalKey(PRINCIPAL));
  assert.equal(new Set(accounts.map(principalKey)).size, accounts.length);
  assert.notEqual(principalKey({ issuer: 'https://synthetic.invalid/ab', subject: 'c' }), principalKey({ issuer: 'https://synthetic.invalid/a', subject: 'bc' }));
  let store = f.open();
  let selected = accounts[0];
  const run = createCompanionProvisioner({ store, pilotSubjects: accounts, validateAccount: async proof => { assert.equal(proof, PROOF); return selected; } });
  const first = await run(PROOF);
  assert.equal(typeof first.companionId, 'string');
  assert.ok(first.companionId.length > 0);
  assert.deepEqual(await run(PROOF), first);
  const ids = [first.companionId];
  for (const account of accounts.slice(1)) { selected = account; ids.push((await run(PROOF)).companionId); }
  assert.equal(new Set(ids).size, accounts.length);
  assert.equal(store.count(), accounts.length);
  f.close(store);
  store = f.open();
  const reopened = createCompanionProvisioner({ store, pilotSubjects: accounts, validateAccount: async () => PRINCIPAL });
  assert.deepEqual(await reopened(PROOF), first);
  assert.equal(store.count(), accounts.length);
});

test('validation runs for every request; expired session denies reuse without deleting identity', async t => {
  const store = fixture(t).open();
  let valid = true;
  let validations = 0;
  const run = createCompanionProvisioner({ store, pilotSubjects: [PRINCIPAL], validateAccount: async () => { validations++; return valid ? PRINCIPAL : null; } });
  const first = await run(PROOF);
  valid = false;
  await denied(run, 'AUTHENTICATION_REQUIRED');
  assert.equal(validations, 2);
  assert.equal(store.count(), 1);
  valid = true;
  assert.deepEqual(await run(PROOF), first);
  assert.equal(validations, 3);
});

test('corrupted retained identity fails privately without replacement or overwrite', async t => {
  const store = fixture(t).open();
  const namespace = 'companion-identity-v1';
  const key = principalKey(PRINCIPAL);
  const retained = { companionId: '11111111-1111-4111-8111-111111111111', syntheticPrivateMarker: 'synthetic-retained-private-value' };
  store.getOrInsert(namespace, key, retained);
  const run = createCompanionProvisioner({ store, pilotSubjects: [PRINCIPAL], validateAccount: async () => PRINCIPAL });
  await assert.rejects(() => run(PROOF), error => {
    assert.equal(error.code, 'COMPANION_STATE_INVALID');
    const publicError = inspect(error, { depth: 5 });
    assert.ok(!publicError.includes('syntheticPrivateMarker') && !publicError.includes(retained.syntheticPrivateMarker));
    return true;
  });
  assert.throws(() => store.put(namespace, key, { companionId: '22222222-2222-4222-8222-222222222222' }));
  assert.deepEqual(store.get(namespace, key), retained);
  assert.equal(store.count(), 1);
});

test('independent workers race initialization and first sign-in yet share one companion', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const gates = new Int32Array(barrier);
  const total = 3;
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { BootstrapStore } = await import(workerData.storeUrl);
      const { createCompanionProvisioner } = await import(workerData.provisioningUrl);
      const gates = new Int32Array(workerData.barrier);
      let store;
      try {
        parentPort.postMessage({ phase: 'ready' });
        Atomics.wait(gates, 0, 0);
        store = new BootstrapStore(workerData.dir, workerData.root);
        parentPort.postMessage({ phase: 'opened' });
        Atomics.wait(gates, 1, 0);
        const run = createCompanionProvisioner({ store, pilotSubjects: [workerData.principal], validateAccount: async () => workerData.principal });
        const result = await run({ synthetic: true });
        store.close(); store = null;
        parentPort.postMessage({ phase: 'result', companionId: result.companionId });
      } catch (error) {
        if (store) store.close();
        parentPort.postMessage({ phase: 'failed', message: error.code || error.message });
      }
    })().catch(error => { throw error; });
  `;
  const ids = await new Promise((resolve, reject) => {
    let ready = 0;
    let opened = 0;
    const results = [];
    for (let index = 0; index < total; index++) {
      const worker = new Worker(workerSource, { eval: true, workerData: {
        dir: f.dir, root: ROOT, barrier, principal: PRINCIPAL,
        storeUrl: new URL('../src/store.mjs', import.meta.url).href,
        provisioningUrl: new URL('../src/provisioning.mjs', import.meta.url).href,
      } });
      f.workers.add(worker);
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error('Concurrent provisioning worker failed')); });
      worker.on('message', message => {
        if (message.phase === 'failed') return reject(new Error(message.message));
        if (message.phase === 'ready' && ++ready === total) { Atomics.store(gates, 0, 1); Atomics.notify(gates, 0, total); }
        if (message.phase === 'opened' && ++opened === total) { Atomics.store(gates, 1, 1); Atomics.notify(gates, 1, total); }
        if (message.phase === 'result') { results.push(message.companionId); if (results.length === total) resolve(results); }
      });
    }
  });
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(ids).size, 1);
  const store = f.open();
  assert.equal(store.count(), 1);
});
