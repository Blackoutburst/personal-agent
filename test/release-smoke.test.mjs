// Post-release smoke check (#106): chat snapshot + events page read with the client's own validation, scheduler
// liveness from the last completed tick, and read-only against the real data. Nothing here touches a real service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeCheck } from '../ops/release-smoke.mjs';
import { FileStore } from '../src/files.mjs';
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
  assert.match(result.failures[0].reason, /snapshot rejected by the chat client \(INVALID_RESPONSE: snapshot.messages\[\?\] role value\)/);
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
  writeFileSync(join(release, 'src', 'files.mjs'), 'export class FileStore { list() { return []; } }');
  const dataDir = world(t, { tickAt: 5_000_000_000_500 }); let chatPauses = 0;
  const result = await smokeCheck({ release, dataDir, since: 5_000_000_000_000, waitMs: 0, sleep: async () => { chatPauses++; } });
  assert.equal(chatPauses, 0);
  assert.match(result.failures[0].reason, /chat check could not run \(BROKEN_SCHEMA\)/);
});

// #110: real data the client's validation used to reject; the smoke must now pass on it, and a still-invalid response must be
// named by field and rule, with counts and without any conversation content.
const sealed = (t, extra) => world(t, { tickAt: 5_000_000_000_500, extra });
const runChat = (dataDir) => smokeCheck({ release: ROOT, dataDir, since: 5_000_000_000_000, ...clock() });

test('smoke passes on data that used to be rejected: control characters, a split emoji, a non-ASCII title', async t => {
  const dataDir = sealed(t, (db, { THREAD, now }) => {
    db.prepare('UPDATE conv_threads SET title=?').run('日本語のタイトル日本語のタイトル日本語のタイトル'); // 27 characters, 81 bytes
    const message = db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,request_id,created_at) VALUES (?,?,?,?,?,?)');
    message.run('m3', THREAD, 'assistant', 'SECRET_ESC \u001b[31mred\u0000 end', 'r3', now + 3);
    message.run('m4', THREAD, 'assistant', 'x'.repeat(99999) + '😀'.slice(0, 1), 'r4', now + 4); // cut inside a surrogate pair
    message.run('m5', THREAD, 'assistant', '😀'.repeat(99999), 'r5', now + 5); // 399996 bytes: fits
    message.run('m6', THREAD, 'assistant', '😀'.repeat(100000).slice(0, 100000) + 'é'.repeat(5), 'r6', now + 6);
  });
  const result = await runChat(dataDir);
  assert.deepEqual(result.failures, []); assert.equal(result.ok, true);
});

test('smoke names the failing field and rule, with counts, and never conversation content', async t => {
  const { diagnoseResponse } = await import('../public/conversation-client.mjs');
  const thread = '4f6c2a1e-8d3b-4c5a-9e7f-1a2b3c4d5e6f';
  const snapshot = messages => ({ version: 1, synthetic: false, threads: [{ id: thread, title: 'Chat' }], threadId: thread, messages, cursor: '3', runtime: { state: 'ready' } });
  const ok = { id: 'm1', threadId: thread, role: 'assistant', text: 'SECRET_TEXT' };
  const rule = (message, requested) => diagnoseResponse('snapshot', snapshot([message]), { threadId: requested });
  assert.equal(rule(ok), null);
  assert.deepEqual(rule({ ...ok, text: 'SECRET'.repeat(20000) }), { code: 'INVALID_RESPONSE', rule: 'snapshot.messages[assistant] text length 120000>100000' });
  assert.equal(rule({ ...ok, text: 'SECRET\u0000' }).rule, 'snapshot.messages[assistant] text has a control character');
  assert.equal(rule({ ...ok, text: 'SECRET\ud83d' }).rule, 'snapshot.messages[assistant] text has a lone surrogate');
  assert.equal(rule({ ...ok, role: 'user', text: ' ' }).rule, 'snapshot.messages[user] text is empty');
  assert.equal(rule({ ...ok, attachments: [{ id: 'x' }] }).rule, 'snapshot.messages[assistant].attachments[] is missing required key name');
  assert.equal(diagnoseResponse('snapshot', { ...snapshot([ok]), threads: [{ id: thread, title: 'SECRET'.repeat(60) }] }).rule, 'snapshot.threads[] title length 360>80');
  assert.equal(diagnoseResponse('snapshot', snapshot(Array.from({ length: 501 }, (_, i) => ({ ...ok, id: 'm' + i })))).rule, 'snapshot messages count 501>500');
  assert.equal(diagnoseResponse('events', { version: 1, synthetic: false, threadId: thread, cursor: '1', lastSeq: 1, hasMore: false,
    events: [{ seq: 1, threadId: thread, type: 'message', message: { ...ok, text: 'SECRET\u0001' } }] }, { threadId: thread, cursor: 0 }).rule, 'eventsPage.events[].message[assistant] text has a control character');
  for (const bad of [rule({ ...ok, text: 'SECRET\u0000' }), rule({ ...ok, text: 'SECRET'.repeat(20000) })]) assert.doesNotMatch(JSON.stringify(bad), /SECRET/);
});

// #111: the real server serves attachments, and a user message with only a file has empty text. The smoke check must too.
const withFile = (db, { THREAD, COMPANION, now, dataDir }, { text = '', attach = true } = {}) => {
  const files = new FileStore({ store: { db }, dataDir });
  const id = '8b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,request_id,created_at) VALUES (?,?,?,?,?,?)').run('m3', THREAD, 'user', text, 'r3', now + 3);
  db.prepare('INSERT INTO conv_events VALUES (?,?,?)').run(THREAD, 4, JSON.stringify({ type: 'message', messageId: 'm3' }));
  db.prepare('UPDATE conv_threads SET last_seq=4').run();
  if (attach) db.prepare(`INSERT INTO conv_files(id,companion_id,thread_id,message_id,request_id,name,mime,size,sha256,direction,caption,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, COMPANION, THREAD, 'm3', 'f1', 'SECRET_NAME.png', 'image/png', 10, 'a'.repeat(64), 'user', 'SECRET_CAPTION', 'ready', now + 3);
  return files;
};

test('smoke passes on a user message that has only an attachment (empty text), in the snapshot and the events page', async t => {
  const dataDir = sealed(t, (db, context) => withFile(db, context));
  const before = digest(dataDir);
  const result = await runChat(dataDir);
  assert.deepEqual(result.failures, []); assert.equal(result.ok, true);
  assert.match(result.notes.join('\n'), /1\/1 companion\(s\) opened, 1 events page\(s\) read/);
  assert.equal(digest(dataDir), before);
});

test('smoke still fails, naming the rule and no content, on an empty user message without an attachment', async t => {
  const dataDir = sealed(t, (db, context) => withFile(db, context, { attach: false }));
  const result = await runChat(dataDir);
  assert.equal(result.ok, false);
  assert.match(result.failures[0].reason, /INVALID_RESPONSE: snapshot\.messages\[user\] text is empty/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

test('smoke ignores a file that is not ready and works on data without a conv_files table', async t => {
  const dataDir = sealed(t, (db, context) => { withFile(db, context, { text: 'hi' }); db.exec("UPDATE conv_files SET state='uploading'"); });
  assert.equal((await runChat(dataDir)).ok, true);
  const bare = sealed(t, () => {});
  assert.equal((await runChat(bare)).ok, true);
});
