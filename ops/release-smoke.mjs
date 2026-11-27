// Post-release smoke checks (#106). The health check only says "the server answers"; this reads what the app and
// C-chan's scheduler actually depend on, from the real private data, and reports a short reason for each failure.
//
//   chat       Reads each companion's conversation snapshot and an events page the way public/conversation-client.mjs
//              does: the target release's own Conversations service answers, the client's own validation parses it.
//   scheduler  A completed scheduler tick (scheduler_ticks, #105) written after the service was restarted.
//
// Strictly read-only: the database is opened with SQLite's read-only flag (a write would throw), no message is
// submitted, no wake is enqueued, and nothing from a conversation is put into a reason (codes and counts only).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_COMPANIONS = 20, REWIND = 50;
const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = error => (typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : /^\w{1,40}$/.test(error?.name ?? '') ? error.name : 'ERROR');

// The running server writes in rollback-journal mode, so a read can meet its lock. Wait in SQLite (busy_timeout), then retry a
// bounded number of times on busy/locked only: any other error is a real failure and is returned at once.
const BUSY_MS = 5000, BUSY_RETRIES = 6, BUSY_PAUSE_MS = 250;
const isBusy = error => [error, error?.cause].some(e => e && (e.errcode === 5 || e.errcode === 6 || /database (table )?is (locked|busy)|SQLITE_(BUSY|LOCKED)/i.test(`${e.message ?? ''} ${e.code ?? ''}`)));
async function retryBusy(fn, sleep = sleepFor) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) { if (!isBusy(error) || attempt >= BUSY_RETRIES) throw error; await sleep(BUSY_PAUSE_MS); }
  }
}

// A read-only handle shaped like the store Conversations uses. BEGIN IMMEDIATE (its read transactions) becomes a plain BEGIN.
const readOnly = db => ({ db: { prepare: sql => db.prepare(sql), exec: sql => db.exec(/^\s*BEGIN\b/i.test(sql) ? 'BEGIN' : sql) } });

// #111: the real server gives Conversations its FileStore, which is where a message's attachments come from; a user message sent
// with only a file has empty text and is valid only with them. FileStore's constructor creates tables, so it is not built here:
// the release's own list() and dto() run on the same read-only handle, over the same conv_files table, and nothing else
// (no file content, no path) is touched. Without that table (data from before files existed) no message has attachments.
async function readOnlyFiles(db, release) {
  const { FileStore } = await import(pathToFileURL(join(release, 'src', 'files.mjs')).href);
  const files = Object.create(FileStore.prototype);
  files.db = db;
  const present = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conv_files'").get() !== undefined;
  const list = FileStore.prototype.list;
  return { list: messageId => present() ? list.call(files, messageId) : [] };
}

function companions(db) {
  const rows = db.prepare("SELECT value_json FROM bootstrap_record WHERE namespace='companion-identity-v1'").all();
  const ids = [];
  for (const row of rows) {
    try { const id = JSON.parse(row.value_json)?.companionId; if (typeof id === 'string' && !ids.includes(id)) ids.push(id); } catch { /* not an identity */ }
  }
  return ids.slice(0, MAX_COMPANIONS);
}

async function chatCheck(db, release, sleep) {
  const failures = [];
  const { Conversations } = await import(pathToFileURL(join(release, 'src', 'conversations.mjs')).href);
  const { createConversationClient, diagnoseResponse } = await import(pathToFileURL(join(release, 'public', 'conversation-client.mjs')).href);
  // Construction reads the schema, so it can meet the server's lock too.
  // Server-only inputs (runner, board lines, push, links, wake tools, group wakes, turn notes, web budget) only act when a
  // turn or wake runs; board inbox lines are not wired by the server since #75. Attachments are the one that shapes a response.
  const files = await readOnlyFiles(db, release);
  const conversations = await retryBusy(() => new Conversations({ store: readOnly(db), files }), sleep);
  const ids = await retryBusy(() => companions(db), sleep);
  let opened = 0, pages = 0;
  for (const [index, companionId] of ids.entries()) {
    // #110: which validation rule the client applied when it rejected a response (field path, rule, counts; never content).
    const seen = []; let rewound = false, served = null, rejected = null;
    const who = `companion ${index + 1}/${ids.length}`;
    const transport = async (action, payload = {}) => {
      seen.push(action);
      // Only the two read actions exist here; the client could never reach a write from open() and poll().
      if (action !== 'snapshot' && action !== 'events') throw Object.assign(new Error(), { code: 'INVALID_REQUEST' });
      // Read an events page that holds real events: start a little before the snapshot's cursor (the client keeps
      // only what is newer than its own cursor, so its state is unchanged).
      const asked = payload;
      if (action === 'events') { rewound = true; payload = { ...payload, cursor: String(Math.max(0, Number(payload.cursor) - REWIND)) }; }
      let response;
      try { response = await retryBusy(() => conversations.handle(companionId, { action, ...payload }), sleep); }
      catch (error) { served = codeOf(error); throw error; }
      const found = diagnoseResponse(action, response, { threadId: asked.threadId, cursor: Number(asked.cursor) });
      if (found) rejected = `${found.code}: ${found.rule}`;
      return response;
    };
    const client = createConversationClient({ transport, requestId: () => { throw new Error('read-only'); } });
    try {
      let state = await client.open();
      if (state.connection !== 'ready' || state.error) { failures.push({ check: 'chat', reason: `${who}: snapshot rejected by the chat client (${served ?? rejected ?? state.error ?? state.connection})` }); continue; }
      opened++;
      if (state.threadId === null) continue; // no conversation yet: nothing to page
      state = await client.poll();
      if (state.connection !== 'ready' || state.error || seen.filter(action => action === 'snapshot').length !== 1 || !rewound) {
        failures.push({ check: 'chat', reason: `${who}: events page rejected by the chat client (${served ?? rejected ?? state.error ?? state.connection})` }); continue;
      }
      pages++;
    } catch (error) { failures.push({ check: 'chat', reason: `${who}: chat read failed (${served ?? rejected ?? codeOf(error)})` }); }
    finally { try { client.disconnect(); } catch { /* nothing to release */ } }
  }
  return { failures, note: `${opened}/${ids.length} companion(s) opened, ${pages} events page(s) read` };
}

async function schedulerCheck(db, since, { waitMs, intervalMs, sleep, now }) {
  const read = () => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const expected = [...tables.has('scheduler_settings') ? db.prepare('SELECT companion_id FROM scheduler_settings WHERE enabled=1').all() : [],
      ...tables.has('scheduler_ticks') ? db.prepare('SELECT companion_id FROM scheduler_ticks').all() : []];
    if (!expected.length) return { none: true };
    if (!tables.has('scheduler_ticks')) return { latest: null };
    const latest = db.prepare('SELECT MAX(ticked_at) AS at FROM scheduler_ticks').get()?.at ?? null;
    return { latest };
  };
  const deadline = now() + waitMs;
  for (;;) {
    let seen;
    try { seen = await retryBusy(read, sleep); } catch (error) { return { failures: [{ check: 'scheduler', reason: `the scheduler tick record is unreadable (${codeOf(error)})` }] }; }
    if (seen.none) return { failures: [], note: 'no scheduler-enabled owner; liveness not checked' };
    if (seen.latest !== null && seen.latest >= since) return { failures: [], note: 'a scheduler tick completed after the restart' };
    if (now() >= deadline) {
      const last = seen.latest === null ? 'never' : `${Math.round((since - seen.latest) / 1000)}s before the restart`;
      return { failures: [{ check: 'scheduler', reason: `no scheduler tick completed within ${Math.round(waitMs / 1000)}s of the restart (last tick: ${last})` }] };
    }
    await sleep(intervalMs);
  }
}

// #110: only the chat check, for a release directory, without releasing anything: opens the data read-only and changes no link,
// service or file. `node ops/release.mjs smoke [release-dir]` runs it.
export async function chatSmoke({ release, dataDir, sleep = sleepFor, busyMs = BUSY_MS } = {}) {
  let db;
  try { db = await retryBusy(() => { const handle = new DatabaseSync(join(dataDir, 'bootstrap.sqlite'), { readOnly: true }); handle.exec(`PRAGMA busy_timeout = ${busyMs}`); return handle; }, sleep); }
  catch (error) { return { ok: false, failures: [{ check: 'chat', reason: `the private database could not be opened read-only (${codeOf(error)})` }], notes: [] }; }
  try {
    const result = await chatCheck(db, release, sleep);
    return { ok: result.failures.length === 0, failures: result.failures, notes: [`chat: ${result.note}`] };
  } catch (error) { return { ok: false, failures: [{ check: 'chat', reason: `the chat check could not run (${codeOf(error)})` }], notes: [] }; }
  finally { try { db.close(); } catch { /* already closed */ } }
}

// release: the directory of the release just started; since: epoch ms taken before the service was started.
export async function smokeCheck({ release, dataDir, since, waitMs = 120000, intervalMs = 2000, sleep = sleepFor, now = Date.now, busyMs = BUSY_MS } = {}) {
  const failures = [], notes = [];
  let db;
  try { db = await retryBusy(() => { const handle = new DatabaseSync(join(dataDir, 'bootstrap.sqlite'), { readOnly: true }); handle.exec(`PRAGMA busy_timeout = ${busyMs}`); return handle; }, sleep); }
  catch (error) { return { ok: false, failures: [{ check: 'chat', reason: `the private database could not be opened read-only (${codeOf(error)})` }], notes }; }
  try {
    for (const [check, run] of [['chat', () => chatCheck(db, release, sleep)], ['scheduler', () => schedulerCheck(db, since, { waitMs, intervalMs, sleep, now })]]) {
      try { const result = await run(); failures.push(...result.failures); if (result.note) notes.push(`${check}: ${result.note}`); }
      catch (error) { failures.push({ check, reason: `the ${check} check could not run (${codeOf(error)})` }); }
    }
  } finally { try { db.close(); } catch { /* already closed */ } }
  return { ok: failures.length === 0, failures, notes };
}
