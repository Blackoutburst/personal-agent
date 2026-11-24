// Shared fixtures for the release smoke-check tests (#106): a private database written with the real store, schema and
// conversation code, and a release directory holding the real chat code. Not a test itself.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../../src/store.mjs';
import { Conversations } from '../../src/conversations.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COMPANION = 'companion-smoke-1', THREAD = '4f6c2a1e-8d3b-4c5a-9e7f-1a2b3c4d5e6f';

// dataDir: an existing owner-only directory. tickAt: the scheduler's last completed tick (null: no tick row, scheduler
// not enabled). bad: write a message row the chat client must reject.
export function seedData(dataDir, { tickAt = null, bad = false } = {}) {
  const store = new BootstrapStore(dataDir, ROOT);
  store.getOrInsert('companion-identity-v1', 'owner-smoke', { companionId: COMPANION });
  new Conversations({ store });
  const db = store.db, now = 1_700_000_000_000;
  db.prepare('INSERT INTO conv_threads(id,companion_id,title,last_seq,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(THREAD, COMPANION, 'Chat', 3, now, now);
  db.prepare('INSERT INTO conv_ongoing VALUES (?,?)').run(COMPANION, THREAD);
  const message = db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,request_id,created_at) VALUES (?,?,?,?,?,?)');
  message.run('m1', THREAD, 'user', 'SECRET_USER_TEXT', 'r1', now + 1);
  message.run('m2', THREAD, bad ? 'robot' : 'assistant', 'SECRET_REPLY_TEXT', 'r1', now + 2);
  const event = db.prepare('INSERT INTO conv_events VALUES (?,?,?)');
  event.run(THREAD, 1, JSON.stringify({ type: 'message', messageId: 'm1' }));
  event.run(THREAD, 2, JSON.stringify({ type: 'message', messageId: 'm2' }));
  event.run(THREAD, 3, JSON.stringify({ type: 'turn', requestId: 'r1', state: 'complete' }));
  db.exec('CREATE TABLE IF NOT EXISTS scheduler_ticks(companion_id TEXT PRIMARY KEY,ticked_at INTEGER NOT NULL)');
  if (tickAt !== null) db.prepare('INSERT INTO scheduler_ticks VALUES (?,?)').run(COMPANION, tickAt);
  db.close();
}

// The chat code the smoke check imports from a release directory (src and the browser modules).
export function seedRelease(directory) {
  mkdirSync(join(directory, 'public'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(directory, 'src'), { recursive: true });
  for (const name of readdirSync(join(ROOT, 'public'))) if (name.endsWith('.mjs')) cpSync(join(ROOT, 'public', name), join(directory, 'public', name));
}
