// #110: what Conversations emits (snapshot and events page) must pass the chat client's validation, including old stored rows
// that predate a rule. One test per mismatch found, plus the read-only `release.mjs smoke` command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations, LIMITS } from '../src/conversations.mjs';
import { clientText } from '../src/client-text.mjs';
import { FileStore } from '../src/files.mjs';
import { noteText } from '../src/board-inbox.mjs';
import { diagnoseResponse, TITLE_BYTES } from '../public/conversation-client.mjs';
import { ROOT, COMPANION, THREAD, seedData } from './fixtures/smoke-data.mjs';

const seeded = (t, extra) => {
  const dir = mkdtempSync(join(tmpdir(), 'agree-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data'); mkdirSync(dataDir, { mode: 0o700 });
  seedData(dataDir, { tickAt: 1, extra });
  return { dir, dataDir };
};
// Serve a snapshot and an events page from stored rows and run the client's validation on both.
async function served(t, extra) {
  const { dataDir } = seeded(t, extra);
  const store = new BootstrapStore(dataDir, ROOT); t.after(() => store.close?.());
  const conversations = new Conversations({ store });
  const snapshot = await conversations.handle(COMPANION, { action: 'snapshot' });
  const events = await conversations.handle(COMPANION, { action: 'events', threadId: THREAD, cursor: '0' });
  return { snapshot, events, problems: [diagnoseResponse('snapshot', snapshot), diagnoseResponse('events', events, { threadId: THREAD, cursor: 0 })] };
}
const addMessage = (id, role, text, at) => (db, { now }) =>
  db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,request_id,created_at) VALUES (?,?,?,?,?,?)').run(id, THREAD, role, text, 'r-' + id, now + at);

test('baseline: the seeded conversation validates', async t => {
  const { problems } = await served(t);
  assert.deepEqual(problems, [null, null]);
});

test('a non-ASCII thread title over 80 bytes is accepted (client limit was 80 bytes, server 320)', async t => {
  const long = '日'.repeat(60); // 60 characters, 180 bytes
  const { snapshot, problems } = await served(t, db => db.prepare('UPDATE conv_threads SET title=?').run(long));
  assert.equal(snapshot.threads[0].title, long); assert.ok(Buffer.byteLength(long) > 80 && Buffer.byteLength(long) <= TITLE_BYTES);
  assert.deepEqual(problems, [null, null]);
});

test('a stored title that is empty, over-long or has control characters is emitted as one the client accepts', async t => {
  const { snapshot, problems } = await served(t, db => db.prepare('UPDATE conv_threads SET title=?').run('\u0000\u0001'));
  assert.equal(snapshot.threads[0].title, 'New conversation'); assert.deepEqual(problems, [null, null]);
  const over = await served(t, db => db.prepare('UPDATE conv_threads SET title=?').run('😀'.repeat(200)));
  assert.ok(over.snapshot.threads[0].title.length <= 80); assert.deepEqual(over.problems, [null, null]);
});

test('assistant text with control characters (a terminal escape, NUL) is emitted without them', async t => {
  const { snapshot, events, problems } = await served(t, addMessage('m3', 'assistant', 'ok \u001b[31mred\u0000 done', 3));
  assert.equal(snapshot.messages.at(-1).text, 'ok [31mred done'); assert.deepEqual(problems, [null, null]);
  assert.ok(events.events.length > 0);
});

test('assistant text cut inside a surrogate pair at the character limit is emitted well-formed', async t => {
  const text = 'a'.repeat(LIMITS.assistantChars - 1) + '😀'.slice(0, 1) + 'tail';
  const { snapshot, problems } = await served(t, addMessage('m3', 'assistant', text, 3));
  assert.ok(snapshot.messages.at(-1).text.isWellFormed()); assert.deepEqual(problems, [null, null]);
});

test('assistant text over the byte limit (4-byte characters) and user text over the limits are cut to what the client accepts', async t => {
  const { snapshot, problems } = await served(t, (db, ctx) => {
    addMessage('m3', 'assistant', '😀'.repeat(LIMITS.assistantChars), 3)(db, ctx);
    addMessage('m4', 'user', 'é'.repeat(LIMITS.userChars + 5), 4)(db, ctx);
  });
  assert.ok(Buffer.byteLength(snapshot.messages.at(-2).text) <= LIMITS.assistantBytes);
  assert.ok(Buffer.byteLength(snapshot.messages.at(-1).text) <= LIMITS.userBytes); assert.deepEqual(problems, [null, null]);
});

test('peer text and a turn error that the client would reject are repaired on the way out', async t => {
  const { snapshot, problems } = await served(t, (db, ctx) => {
    db.prepare("INSERT INTO conv_messages(id,thread_id,role,text,created_at,peer_json) VALUES ('p1',?,'peer',?,?,?)").run(THREAD, 'hi\u0000 there', ctx.now + 3,
      JSON.stringify({ direction: 'received', companionId: '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b', name: 'Ada', ownerLabel: 'Ada', sentAtISO: '2025-11-27T10:00:00.000Z' }));
    db.prepare("INSERT INTO conv_turns(thread_id,request_id,companion_id,user_message_id,state,error,created_at,updated_at) VALUES (?,?,?,?,'error',?,?,?)")
      .run(THREAD, 'r-err', COMPANION, 'm1', JSON.stringify({ code: 'bad code', message: 'x'.repeat(900) + '\u0000' }), ctx.now + 4, ctx.now + 4);
  });
  assert.equal(snapshot.turn.error.code, 'PROVIDER_ERROR'); assert.equal(snapshot.turn.error.message.length, 500);
  assert.deepEqual(problems, [null, null]);
});

test('clientText never splits a surrogate pair, never exceeds either limit and keeps clean text as it is', () => {
  assert.equal(clientText('plain text', 100, 100), 'plain text');
  assert.equal(clientText('a\u0000b', 10, 10), 'ab');
  assert.equal(clientText('a\ud800b', 10, 10), 'a�b');
  for (const [chars, bytes] of [[3, 100], [100, 5], [100, 7], [2, 2]]) {
    const out = clientText('😀😀😀😀', chars, bytes);
    assert.ok(out.isWellFormed() && out.length <= chars && Buffer.byteLength(out) <= bytes);
  }
  assert.equal(clientText(null, 5, 5), '');
});

test('a Board activity line with a long emoji name does not split a pair at 60 characters', () => {
  const text = noteText('posted', 'a' + '😀'.repeat(100));
  assert.ok(text.isWellFormed() && text.length <= 300);
});

test('a voice message beyond an hour or with a huge transcript is shown as the client accepts it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agree-files-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = Object.create(FileStore.prototype);
  const row = { id: '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b', name: 'v.ogg', mime: 'audio/ogg', size: 10, sha256: 'a'.repeat(64), direction: 'user', voice: 1,
    duration_ms: 99_999_999, transcript: 'word '.repeat(10000) + '\u0000' };
  const dto = files.dto(row);
  assert.equal(dto.voice.durationMs, 3_600_000); assert.ok(dto.voice.transcript.length <= 20000);
  const messages = [{ id: 'm', threadId: THREAD, role: 'user', text: '', attachments: [dto] }];
  const page = { version: 1, synthetic: false, threads: [{ id: THREAD, title: 'Chat' }], threadId: THREAD, messages, cursor: '1', runtime: { state: 'ready' } };
  assert.equal(diagnoseResponse('snapshot', page), null);
});

test('the client reports an unknown or missing key by its field name only', () => {
  const page = { version: 1, synthetic: false, threads: [], threadId: null, messages: [], cursor: '0', runtime: { state: 'ready' }, SECRET_extra: 1 };
  assert.match(diagnoseResponse('snapshot', page).rule, /^snapshot has an unexpected or unreadable key \(\?\)$|\(SECRET_extra\)/);
  const { runtime, ...missing } = page; delete missing.SECRET_extra;
  assert.equal(diagnoseResponse('snapshot', missing).rule, 'snapshot is missing required key runtime');
});

test('`release.mjs smoke <dir>` runs the chat check read-only against live data, with no service and no release root', t => {
  const { dataDir } = seeded(t, addMessage('m3', 'assistant', 'SECRET \u001b ok', 3));
  const before = createHash('sha256').update(readFileSync(join(dataDir, 'bootstrap.sqlite'))).digest('hex');
  const env = { ...process.env, COMPANION_DATA_DIR: dataDir, COMPANION_SYSTEMCTL: '/nonexistent/systemctl', COMPANION_RELEASE_ROOT: join(dataDir, 'no-root') };
  const run = args => spawnSync(process.execPath, [join(ROOT, 'ops', 'release.mjs'), 'smoke', ...args], { encoding: 'utf8', env });
  const ok = run([ROOT]);
  assert.equal(ok.status, 0, ok.stderr); const body = JSON.parse(ok.stdout);
  assert.equal(body.ok, true); assert.match(body.notes.join(), /1\/1 companion\(s\) opened/); assert.doesNotMatch(ok.stdout, /SECRET/);
  const none = run([]); assert.equal(none.status, 0, none.stderr);
  const bad = run(['a', 'b']); assert.equal(bad.status, 1); assert.match(bad.stderr, /INVALID/);
  const missing = run(['no-such-release']); assert.equal(missing.status, 1);
  assert.equal(createHash('sha256').update(readFileSync(join(dataDir, 'bootstrap.sqlite'))).digest('hex'), before);
});

// Review round 2: turn events on the events page and peer names/labels from stored JSON.
test('a stored turn event with a bad error is repaired on the events page', async t => {
  const body = (state, error) => JSON.stringify({ type: 'turn', requestId: 'r-x', state, ...(error ? { error } : {}) });
  const { events, problems } = await served(t, (db, ctx) => {
    const add = (seq, text) => db.prepare('INSERT INTO conv_events VALUES (?,?,?)').run(THREAD, seq, text);
    add(4, body('error', { code: 'bad code', message: 'x'.repeat(900) + '\u0000' }));
    add(5, body('error', { code: 'E1', message: '' }));
    add(6, body('error', { code: 'OK_CODE', message: 'fine', resetsAt: 'not a date' }));
    add(7, body('error', 'garbage'));
    db.prepare('UPDATE conv_threads SET last_seq=7 WHERE id=?').run(THREAD);
  });
  const errors = events.events.filter(e => e.seq >= 4).map(e => e.error);
  assert.equal(errors[0].code, 'PROVIDER_ERROR'); assert.equal(errors[0].message.length, 500);
  assert.ok(errors[1].message.length > 0); assert.equal(errors[2].code, 'OK_CODE'); assert.equal(errors[2].resetsAt, undefined);
  assert.equal(errors[3].code, 'PROVIDER_ERROR');
  assert.deepEqual(problems, [null, null]);
});

test('a stored peer card with an oversized, empty or padded name or label is repaired', async t => {
  const card = peer => (db, ctx) => db.prepare("INSERT INTO conv_messages(id,thread_id,role,text,created_at,peer_json) VALUES (?,?,'peer',?,?,?)")
    .run('p' + Math.random(), THREAD, 'hello', ctx.now + 3, JSON.stringify({ direction: 'sent', companionId: '3f2b8c1e-4a5d-4e6f-8a7b-9c0d1e2f3a4b', sentAtISO: '2025-11-27T10:00:00.000Z', ...peer }));
  const { snapshot, events, problems } = await served(t, (db, ctx) => {
    card({ name: 'N'.repeat(200), ownerLabel: '  padded \u0000 ' })(db, ctx);
    card({ name: '', ownerLabel: '😀'.repeat(100) })(db, ctx);
    card({ name: 'Ada', ownerLabel: 'Ada', sentAtISO: 'yesterday', companionId: 'nope' })(db, ctx);
  });
  const peers = snapshot.messages.filter(m => m.role === 'peer').map(m => m.peer);
  assert.equal(peers.length, 3);
  assert.equal(peers[0].name.length, 80); assert.equal(peers[0].ownerLabel, 'padded');
  assert.ok(peers[1].name.length > 0 && Buffer.byteLength(peers[1].ownerLabel) <= 320);
  assert.deepEqual(problems, [null, null]);
  assert.ok(events.events.length > 0);
});
