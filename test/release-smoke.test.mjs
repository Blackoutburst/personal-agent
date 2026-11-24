// Post-release smoke check (#106): chat snapshot + events page read with the client's own validation, scheduler
// liveness from the last completed tick, and read-only against the real data. Nothing here touches a real service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeCheck } from '../ops/release-smoke.mjs';
import { ROOT, seedData } from './fixtures/smoke-data.mjs';

const world = (t, options) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-smoke-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data'); mkdirSync(dataDir, { mode: 0o700 });
  seedData(dataDir, options);
  return dataDir;
};
const digest = dataDir => createHash('sha256').update(readFileSync(join(dataDir, 'bootstrap.sqlite'))).digest('hex');
// A clock the sleeping check advances, so a dead scheduler is detected without waiting.
const clock = () => { let time = 5_000_000_000_000; return { now: () => time, sleep: async ms => { time += ms; } }; };

test('smoke passes: a real snapshot and events page validate, and a scheduler tick came after the restart', async t => {
  const dataDir = world(t, { tickAt: 5_000_000_000_500 });
  const result = await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, ...clock() });
  assert.deepEqual(result.failures, []); assert.equal(result.ok, true);
  assert.match(result.notes.join('\n'), /1\/1 companion\(s\) opened, 1 events page\(s\) read/);
});

test('smoke waits for the scheduler\'s first tick after the restart', async t => {
  const dataDir = world(t, { tickAt: 1 }), c = clock();
  const { DatabaseSync } = await import('node:sqlite');
  let slept = 0;
  const sleep = async ms => { await c.sleep(ms); if (++slept === 3) { const db = new DatabaseSync(join(dataDir, 'bootstrap.sqlite')); db.exec(`UPDATE scheduler_ticks SET ticked_at=${c.now()}`); db.close(); } };
  const result = await smokeCheck({ release: ROOT, dataDir, since: c.now(), now: c.now, sleep, waitMs: 60000 });
  assert.equal(result.ok, true, JSON.stringify(result.failures)); assert.ok(slept >= 3);
});

test('smoke fails on a chat the client cannot validate, naming chat and no message text', async t => {
  const dataDir = world(t, { tickAt: 5_000_000_000_500, bad: true });
  const result = await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, ...clock() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.check), ['chat']);
  assert.match(result.failures[0].reason, /snapshot rejected by the chat client \(INVALID_RESPONSE\)/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

test('smoke fails when the release cannot serve the chat at all', async t => {
  const dataDir = world(t, { tickAt: 5_000_000_000_500 }), empty = mkdtempSync(join(tmpdir(), 'release-smoke-empty-')); t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = await smokeCheck({ release: empty, dataDir, since: 5_000_000_000_000, ...clock() });
  assert.equal(result.ok, false); assert.match(result.failures[0].reason, /chat check could not run \(ERR_MODULE_NOT_FOUND\)/);
});

test('smoke fails when no scheduler tick completes after the restart', async t => {
  const dataDir = world(t, { tickAt: 4_999_999_000_000 });
  const result = await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, waitMs: 10000, ...clock() });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(item => item.check), ['scheduler']);
  assert.match(result.failures[0].reason, /no scheduler tick completed within 10s of the restart/);
});

test('smoke checks the scheduler too when the chat fails, reporting both reasons', async t => {
  const dataDir = world(t, { tickAt: 1, bad: true });
  const result = await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, waitMs: 0, ...clock() });
  assert.deepEqual(result.failures.map(item => item.check), ['chat', 'scheduler']);
});

test('smoke is read-only: the database is byte-identical afterwards and writes through its handle are refused', async t => {
  for (const options of [{ tickAt: 5_000_000_000_500 }, { tickAt: 1, bad: true }]) {
    const dataDir = world(t, options), before = digest(dataDir);
    await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, waitMs: 0, ...clock() });
    assert.equal(digest(dataDir), before);
  }
  // A missing database is a failure, never created.
  const empty = mkdtempSync(join(tmpdir(), 'release-smoke-nodb-')); t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = await smokeCheck({ release: ROOT, dataDir: empty, since: 0, ...clock() });
  assert.equal(result.ok, false); assert.match(result.failures[0].reason, /could not be opened read-only/);
  assert.deepEqual((await import('node:fs')).readdirSync(empty), []);
});

test('smoke tolerates a brief exclusive lock held by the running server (busy timeout and retry), and still passes', async t => {
  const { spawn } = await import('node:child_process');
  const dataDir = world(t, { tickAt: 5_000_000_000_500 });
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, 300);`, join(dataDir, 'bootstrap.sqlite')], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const result = await smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, ...clock() });
  assert.deepEqual(result.failures, []); assert.equal(result.ok, true);
});

test('smoke rides out a lock held longer than the busy timeout, using real sleeps and the retries', async t => {
  const { spawn } = await import('node:child_process');
  const dataDir = world(t, { tickAt: 5_000_000_000_500 });
  const holder = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked');
    setTimeout(() => { db.exec('COMMIT'); process.exit(0); }, 1500);`, join(dataDir, 'bootstrap.sqlite')], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const started = Date.now(); let pauses = 0;
  const sleep = async ms => { pauses++; await new Promise(resolve => setTimeout(resolve, ms)); };
  // Busy timeout 300 ms, lock 1500 ms: no single wait outlasts the lock, so only the retries (real pauses) get through.
  const result = await smokeCheck({ release: ROOT, dataDir, since: Date.now() - 1000, busyMs: 300, sleep });
  assert.ok(Date.now() - started > 1000, 'the lock was really waited out');
  assert.ok(pauses >= 1, 'a retry pause happened');
  assert.deepEqual(result.failures.filter(f => f.check === 'chat'), []);
});

test('smoke fails at once, without retrying, on a non-busy error while setting up Conversations', async t => {
  const release = mkdtempSync(join(tmpdir(), 'release-smoke-broken-')); t.after(() => rmSync(release, { recursive: true, force: true }));
  mkdirSync(join(release, 'src')); mkdirSync(join(release, 'public'));
  writeFileSync(join(release, 'src', 'conversations.mjs'), "export class Conversations { constructor() { throw Object.assign(new Error('boom'), { code: 'BROKEN_SCHEMA' }); } }");
  writeFileSync(join(release, 'public', 'conversation-client.mjs'), 'export const createConversationClient = () => ({});');
  const dataDir = world(t, { tickAt: 5_000_000_000_500 }); let chatPauses = 0;
  const result = await smokeCheck({ release, dataDir, since: 5_000_000_000_000, waitMs: 0, sleep: async () => { chatPauses++; } });
  assert.equal(chatPauses, 0);
  assert.match(result.failures[0].reason, /chat check could not run \(BROKEN_SCHEMA\)/);
});
