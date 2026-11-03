import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const reply = text => ({ text: JSON.stringify({ action: 'message', text }), sessionId: 'native-session' });

function fixture(t, { handler = () => reply('Hello again.') } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-archive-')), store = new BootstrapStore(dir, ROOT);
  let now = 1_000_000;
  const f = { A: randomUUID(), B: randomUUID(), advance(ms = 1000) { now += ms; }, handler };
  f.conv = new Conversations({ store, now: () => now, flushMs: 1,
    runner: { turn: (companionId, turn) => f.handler(companionId, turn) }, systemPrompt: () => 'persona' });
  f.db = store.db;
  t.after(async () => { await f.conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  f.send = async (owner, threadId, text) => {
    await f.conv.handle(owner, { action: 'submit', requestId: 'r-' + randomUUID(), threadId, text });
    await f.conv.idle(); f.advance();
  };
  return f;
}

test('New chat archives the current chat read-only and opens a fresh ongoing chat', async t => {
  const f = fixture(t), A = f.A;
  const first = f.conv.ongoingThread(A);
  await f.send(A, first, 'Remember the blue umbrella.');
  const archive = { action: 'archiveThread', requestId: 'archive-1', threadId: first };
  const result = await f.conv.handle(A, archive);
  assert.equal(result.archivedThreadId, first);
  assert.notEqual(result.threadId, first);
  assert.deepEqual(await f.conv.handle(A, archive), result, 'A retried archive request replays the same result');
  assert.equal(f.conv.ongoingThread(A), result.threadId, 'Proactive messages and Discord now use the new chat');

  const current = await f.conv.handle(A, { action: 'snapshot' });
  assert.equal(current.threadId, result.threadId);
  assert.deepEqual(current.messages, []);
  assert.ok(!current.threads.some(thread => thread.id === first), 'Archived chats are not in the active list');
  assert.equal(current.archivedAt, undefined);

  const old = await f.conv.handle(A, { action: 'snapshot', threadId: first });
  assert.equal(old.threadId, first);
  assert.equal(typeof old.archivedAt, 'number');
  assert.equal(old.messages.length, 2, 'The archived chat keeps its messages');
  assert.ok(old.threads.some(thread => thread.id === first));

  await assert.rejects(f.conv.handle(A, { action: 'submit', requestId: 'late', threadId: first, text: 'Still there?' }),
    error => error.code === 'ARCHIVED' && error.status === 409);
  await assert.rejects(f.conv.handle(A, { action: 'archiveThread', requestId: 'archive-2', threadId: first }),
    error => error.code === 'ARCHIVED');

  const listed = await f.conv.handle(A, { action: 'archivedThreads' });
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].id, first);
  assert.equal(listed.threads[0].messages, 2);
  assert.equal(listed.threads[0].title, 'Remember the blue umbrella.');
  assert.deepEqual((await f.conv.handle(f.B, { action: 'archivedThreads' })).threads, [], 'Another owner sees none of them');
  await assert.rejects(f.conv.handle(f.B, { action: 'snapshot', threadId: first }), error => error.code === 'NOT_FOUND');
  await assert.rejects(f.conv.handle(f.B, { action: 'archiveThread', requestId: 'steal', threadId: result.threadId }), error => error.code === 'NOT_FOUND');

  await f.send(A, result.threadId, 'A fresh start.');
  assert.equal((await f.conv.handle(A, { action: 'snapshot' })).messages.length, 2);
});

test('a chat with a reply in progress cannot be archived, and waiting reminders move to the new chat', async t => {
  let release;
  const f = fixture(t, { handler: () => new Promise(resolve => { release = () => resolve(reply('Done.')); }) });
  const A = f.A, first = f.conv.ongoingThread(A);
  await f.conv.handle(A, { action: 'submit', requestId: 'busy-turn', threadId: first, text: 'Think slowly.' });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(f.conv.handle(A, { action: 'archiveThread', requestId: 'too-soon', threadId: first }), error => error.code === 'BUSY');
  release(); await f.conv.idle();

  // A reminder queued behind another owner turn is still waiting when the chat is archived.
  f.handler = () => reply('Reminder!');
  f.db.prepare(`INSERT INTO conv_wakes(companion_id,id,request_id,thread_id,kind,prompt,fingerprint,state,created_at,updated_at)
    VALUES(?,?,?,?,'reminder','p','f','queued',1,1)`).run(A, randomUUID(), 'wake-waiting', first);
  const { threadId: fresh } = await f.conv.handle(A, { action: 'archiveThread', requestId: 'archive-now', threadId: first });
  assert.equal(f.db.prepare("SELECT thread_id FROM conv_wakes WHERE request_id='wake-waiting'").get().thread_id, fresh);
});
