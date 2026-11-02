import { createHash, randomUUID } from 'node:crypto';
import { RunnerError } from './runner.mjs';

// Real conversations (M1, ticket #8). Everything is scoped by the server-side companion ID;
// nothing the browser sends selects another companion, provider home or session.
// Turns run on the server independently of any client: closing the page never stops a reply.

export const LIMITS = Object.freeze({ userChars: 8000, userBytes: 32768, assistantChars: 100000, titleChars: 80,
  threads: 200, snapshotMessages: 60, eventsPage: 100 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const DEFAULT_TITLE = 'New conversation';
const FLUSH_MS = 400;
const ERROR_MESSAGES = {
  INTERRUPTED: 'The server restarted during this reply. Send your message again to retry.',
  BUSY: 'Wait for the current reply to finish or stop it first.'
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conv_threads(id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, title TEXT NOT NULL,
  provider_session TEXT, last_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS conv_threads_owner ON conv_threads(companion_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS conv_messages(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, request_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS conv_messages_thread ON conv_messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS conv_events(thread_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id, seq));
CREATE TABLE IF NOT EXISTS conv_requests(companion_id TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
  result TEXT NOT NULL, PRIMARY KEY(companion_id, request_id));
CREATE TABLE IF NOT EXISTS conv_turns(thread_id TEXT NOT NULL, request_id TEXT NOT NULL, companion_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL, assistant_message_id TEXT, state TEXT NOT NULL, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(thread_id, request_id));
CREATE INDEX IF NOT EXISTS conv_turns_open ON conv_turns(state);
`;

export class ConversationError extends Error {
  constructor(code, status) { super(code); this.name = 'ConversationError'; this.code = code; this.status = status; }
}
const invalid = () => new ConversationError('INVALID_REQUEST', 400);
const notFound = () => new ConversationError('NOT_FOUND', 404);

function wellFormed(value, chars, bytes) {
  return typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && value.length <= chars &&
    Buffer.byteLength(value) <= bytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function only(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  for (const key of Object.keys(payload)) if (!keys.includes(key)) throw invalid();
  return payload;
}
// Parse one protocol request. Actions: snapshot, events, createThread, submit, cancel.
export function parseRequest(payload) {
  const { action } = only(payload, ['action', 'threadId', 'cursor', 'requestId', 'title', 'text']);
  const id = value => { if (typeof value !== 'string' || !UUID.test(value)) throw invalid(); return value; };
  const request = value => { if (typeof value !== 'string' || !REQUEST.test(value)) throw invalid(); return value; };
  if (action === 'snapshot') { only(payload, ['action', 'threadId']); return { action, threadId: payload.threadId === undefined ? undefined : id(payload.threadId) }; }
  if (action === 'events') {
    only(payload, ['action', 'threadId', 'cursor']);
    if (typeof payload.cursor !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(payload.cursor)) throw invalid();
    return { action, threadId: id(payload.threadId), cursor: Number(payload.cursor) };
  }
  if (action === 'createThread') {
    only(payload, ['action', 'requestId', 'title']);
    if (!wellFormed(payload.title, LIMITS.titleChars, LIMITS.titleChars * 4)) throw invalid();
    return { action, requestId: request(payload.requestId), title: payload.title.trim() };
  }
  if (action === 'submit') {
    only(payload, ['action', 'requestId', 'threadId', 'text']);
    if (!wellFormed(payload.text, LIMITS.userChars, LIMITS.userBytes)) throw invalid();
    return { action, requestId: request(payload.requestId), threadId: id(payload.threadId), text: payload.text };
  }
  if (action === 'cancel') {
    only(payload, ['action', 'requestId', 'threadId']);
    return { action, requestId: request(payload.requestId), threadId: id(payload.threadId) };
  }
  throw invalid();
}

function titleFrom(text) {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length <= 60 ? line : line.slice(0, 57).trimEnd() + '…';
}

export class Conversations {
  #db; #runner; #now; #systemPrompt; #flushMs; #session; #allowedTools;
  #queues = new Map(); #active = new Map(); #closing = false;

  // runner: a CompanionRunner (or null when no runtime is configured).
  // systemPrompt(companionId, {fresh, recent}) returns the instructions for a turn: fresh is true when a
  // new provider session starts, recent holds the messages before it for continuity.
  // session: when to start a new provider session (continuity then comes from the companion's files).
  constructor({ store, runner = null, systemPrompt = () => null, now = Date.now, flushMs = FLUSH_MS, allowedTools = [],
    session = { maxTurns: 40, idleMs: 6 * 3600_000, recentMessages: 16 } }) {
    this.#db = store.db; this.#runner = runner; this.#now = now; this.#systemPrompt = systemPrompt; this.#flushMs = flushMs;
    this.#session = session; this.#allowedTools = allowedTools;
    this.#db.exec(SCHEMA);
    const columns = new Set(this.#db.prepare('PRAGMA table_info(conv_threads)').all().map(column => column.name));
    if (!columns.has('session_turns')) this.#db.exec('ALTER TABLE conv_threads ADD COLUMN session_turns INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('session_at')) this.#db.exec('ALTER TABLE conv_threads ADD COLUMN session_at INTEGER NOT NULL DEFAULT 0');
  }

  // The next turn of every thread of this companion starts a new provider session
  // (for example after a memory was forgotten, so the old one doesn't linger in context).
  resetSessions(companionId) {
    this.#db.prepare('UPDATE conv_threads SET provider_session=NULL, session_turns=0 WHERE companion_id=?').run(companionId);
  }

  #resume(thread) {
    if (!thread.provider_session) return null;
    if (thread.session_turns >= this.#session.maxTurns || this.#now() - thread.session_at > this.#session.idleMs) return null;
    return thread.provider_session;
  }

  // After a restart: turns that never started are run again; a turn that was running may already
  // have had effects at the provider, so it is reported as interrupted instead of silently repeated.
  recover() {
    const open = this.#db.prepare("SELECT * FROM conv_turns WHERE state IN ('queued','running') ORDER BY created_at").all();
    for (const turn of open) {
      if (turn.state === 'running') this.#finish(turn, 'error', { code: 'INTERRUPTED', message: ERROR_MESSAGES.INTERRUPTED });
      else this.#enqueue(turn.companion_id, turn.thread_id, turn.request_id);
    }
    return open.length;
  }

  // Wait until every queued or running turn has settled.
  async idle() { while (this.#queues.size) await Promise.allSettled([...this.#queues.values()]); }

  // Graceful stop: running replies end now and are recorded as interrupted (as after a crash);
  // queued turns stay queued and run after the next start.
  async shutdown() {
    this.#closing = true;
    for (const controller of this.#active.values()) controller.abort();
    await this.idle();
  }

  async handle(companionId, payload, { runtime = async () => ({ state: 'unconfigured' }) } = {}) {
    const op = parseRequest(payload);
    if (op.action === 'snapshot') return this.#snapshot(companionId, op.threadId, await runtime());
    if (op.action === 'events') return this.#events(companionId, op.threadId, op.cursor);
    if (op.action === 'cancel') return this.#cancel(companionId, op.threadId, op.requestId);
    return this.#write(companionId, op);
  }

  #thread(companionId, threadId) {
    const thread = this.#db.prepare('SELECT * FROM conv_threads WHERE id=? AND companion_id=?').get(threadId, companionId);
    if (!thread) throw notFound();
    return thread;
  }

  #append(threadId, event) {
    const { last_seq: last } = this.#db.prepare('SELECT last_seq FROM conv_threads WHERE id=?').get(threadId);
    const seq = last + 1;
    this.#db.prepare('INSERT INTO conv_events VALUES (?,?,?)').run(threadId, seq, JSON.stringify(event));
    this.#db.prepare('UPDATE conv_threads SET last_seq=?, updated_at=? WHERE id=?').run(seq, this.#now(), threadId);
    return seq;
  }

  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.#db.exec('COMMIT'); return result; }
    catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* not in a transaction */ } throw error; }
  }

  #message(row) {
    return { id: row.id, threadId: row.thread_id, role: row.role, text: row.text, ...(row.request_id ? { requestId: row.request_id } : {}) };
  }

  #snapshot(companionId, threadId, runtime) {
    const threads = this.#db.prepare('SELECT id, title FROM conv_threads WHERE companion_id=? ORDER BY updated_at DESC, id LIMIT ?')
      .all(companionId, LIMITS.threads).map(row => ({ id: row.id, title: row.title }));
    const selected = threadId === undefined ? (threads[0] ? this.#thread(companionId, threads[0].id) : null) : this.#thread(companionId, threadId);
    let messages = [], cursor = 0, turn = null;
    if (selected) {
      // Read consistently: messages and the cursor they correspond to.
      ({ messages, cursor, turn } = this.#tx(() => {
        const rows = this.#db.prepare('SELECT * FROM (SELECT rowid AS r, * FROM conv_messages WHERE thread_id=? ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r')
          .all(selected.id, LIMITS.snapshotMessages);
        const open = this.#db.prepare("SELECT request_id, state FROM conv_turns WHERE thread_id=? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(selected.id);
        const { last_seq: seq } = this.#db.prepare('SELECT last_seq FROM conv_threads WHERE id=?').get(selected.id);
        return { messages: rows.map(row => this.#message(row)), cursor: seq, turn: open ? { requestId: open.request_id, state: 'streaming' } : null };
      }));
    }
    return { version: 1, synthetic: false, threads, threadId: selected?.id ?? null, messages, cursor: String(cursor),
      runtime: { state: runtime.state, ...(runtime.provider ? { provider: runtime.provider } : {}) }, ...(turn ? { turn } : {}) };
  }

  #events(companionId, threadId, from) {
    const thread = this.#thread(companionId, threadId);
    if (from > thread.last_seq) throw invalid();
    const rows = this.#db.prepare('SELECT seq, body FROM conv_events WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?').all(threadId, from, LIMITS.eventsPage);
    const parsed = rows.map(row => ({ seq: row.seq, ...JSON.parse(row.body) }));
    // A message event refers to the message; its current text is sent once per page (the latest event).
    const lastFor = new Map();
    parsed.forEach((event, index) => { if (event.type === 'message') lastFor.set(event.messageId, index); });
    const events = parsed.map((event, index) => {
      if (event.type !== 'message') return { seq: event.seq, threadId, ...event };
      if (lastFor.get(event.messageId) !== index) return { seq: event.seq, threadId, type: 'noop' };
      const row = this.#db.prepare('SELECT * FROM conv_messages WHERE id=?').get(event.messageId);
      return { seq: event.seq, threadId, type: 'message', message: this.#message(row) };
    });
    const cursor = events.at(-1)?.seq ?? from;
    return { version: 1, synthetic: false, threadId, events, cursor: String(cursor), lastSeq: thread.last_seq, hasMore: cursor < thread.last_seq };
  }

  #write(companionId, op) {
    const digest = createHash('sha256').update(JSON.stringify(op)).digest('hex');
    const result = this.#tx(() => {
      const cached = this.#db.prepare('SELECT digest, result FROM conv_requests WHERE companion_id=? AND request_id=?').get(companionId, op.requestId);
      if (cached) {
        if (cached.digest !== digest) throw new ConversationError('CONFLICT', 409);
        return { replay: true, body: JSON.parse(cached.result) };
      }
      const now = this.#now();
      let body;
      if (op.action === 'createThread') {
        const count = this.#db.prepare('SELECT COUNT(*) AS n FROM conv_threads WHERE companion_id=?').get(companionId).n;
        if (count >= LIMITS.threads) throw new ConversationError('CAPACITY', 409);
        const id = randomUUID();
        this.#db.prepare('INSERT INTO conv_threads(id, companion_id, title, created_at, updated_at) VALUES (?,?,?,?,?)').run(id, companionId, op.title, now, now);
        body = { version: 1, synthetic: false, thread: { id, title: op.title } };
      } else {
        const thread = this.#thread(companionId, op.threadId);
        const busy = this.#db.prepare("SELECT 1 FROM conv_turns WHERE thread_id=? AND state IN ('queued','running')").get(thread.id);
        if (busy) throw new ConversationError('BUSY', 409);
        const messageId = randomUUID();
        this.#db.prepare('INSERT INTO conv_messages VALUES (?,?,?,?,?,?)').run(messageId, thread.id, 'user', op.text, op.requestId, now);
        this.#db.prepare("INSERT INTO conv_turns VALUES (?,?,?,?,NULL,'queued',NULL,?,?)").run(thread.id, op.requestId, companionId, messageId, now, now);
        if (thread.title === DEFAULT_TITLE) this.#db.prepare('UPDATE conv_threads SET title=? WHERE id=?').run(titleFrom(op.text), thread.id);
        this.#append(thread.id, { type: 'message', messageId });
        this.#append(thread.id, { type: 'turn', requestId: op.requestId, state: 'streaming' });
        body = { version: 1, synthetic: false, accepted: { requestId: op.requestId, threadId: thread.id, messageId } };
      }
      this.#db.prepare('INSERT INTO conv_requests VALUES (?,?,?,?)').run(companionId, op.requestId, digest, JSON.stringify(body));
      return { replay: false, body };
    });
    if (op.action === 'submit' && !result.replay) this.#enqueue(companionId, op.threadId, op.requestId);
    return result.body;
  }

  #cancel(companionId, threadId, requestId) {
    this.#thread(companionId, threadId);
    const turn = this.#db.prepare('SELECT * FROM conv_turns WHERE thread_id=? AND request_id=? AND companion_id=?').get(threadId, requestId, companionId);
    if (!turn) throw notFound();
    if (turn.state === 'queued') this.#finish(turn, 'cancelled');
    else if (turn.state === 'running') this.#active.get(`${threadId}:${requestId}`)?.abort();
    return { version: 1, synthetic: false, cancel: { requestId, threadId, state: turn.state === 'queued' ? 'cancelled' : turn.state === 'running' ? 'stopping' : turn.state } };
  }

  // One turn at a time per companion, so "running" always means the provider was really started.
  #enqueue(companionId, threadId, requestId) {
    const previous = this.#queues.get(companionId) ?? Promise.resolve();
    const next = previous.then(() => this.#run(companionId, threadId, requestId)).catch(() => {});
    this.#queues.set(companionId, next);
    next.finally(() => { if (this.#queues.get(companionId) === next) this.#queues.delete(companionId); });
  }

  #finish(turn, state, error = null) {
    this.#tx(() => {
      const current = this.#db.prepare('SELECT state FROM conv_turns WHERE thread_id=? AND request_id=?').get(turn.thread_id, turn.request_id);
      if (!['queued', 'running'].includes(current?.state)) return;
      this.#db.prepare('UPDATE conv_turns SET state=?, error=?, updated_at=? WHERE thread_id=? AND request_id=?')
        .run(state, error ? JSON.stringify(error) : null, this.#now(), turn.thread_id, turn.request_id);
      this.#append(turn.thread_id, { type: 'turn', requestId: turn.request_id, state, ...(error ? { error } : {}) });
    });
  }

  async #run(companionId, threadId, requestId) {
    const turn = this.#db.prepare('SELECT * FROM conv_turns WHERE thread_id=? AND request_id=?').get(threadId, requestId);
    if (turn?.state !== 'queued' || this.#closing) return;
    if (!this.#runner) { this.#finish(turn, 'error', describe(new RunnerError('NO_RUNTIME'))); return; }
    const thread = this.#db.prepare('SELECT * FROM conv_threads WHERE id=?').get(threadId);
    const user = this.#db.prepare('SELECT text FROM conv_messages WHERE id=?').get(turn.user_message_id);
    this.#db.prepare("UPDATE conv_turns SET state='running', updated_at=? WHERE thread_id=? AND request_id=?").run(this.#now(), threadId, requestId);
    const controller = new AbortController(), key = `${threadId}:${requestId}`;
    this.#active.set(key, controller);
    let assistantId = null, text = '', written = '', timer = null;
    const flush = () => {
      timer = null;
      if (text === written) return;
      const value = text.slice(0, LIMITS.assistantChars);
      this.#tx(() => {
        if (!assistantId) {
          assistantId = randomUUID();
          this.#db.prepare('INSERT INTO conv_messages VALUES (?,?,?,?,?,?)').run(assistantId, threadId, 'assistant', value, requestId, this.#now());
          this.#db.prepare('UPDATE conv_turns SET assistant_message_id=? WHERE thread_id=? AND request_id=?').run(assistantId, threadId, requestId);
        } else this.#db.prepare('UPDATE conv_messages SET text=? WHERE id=?').run(value, assistantId);
        this.#append(threadId, { type: 'message', messageId: assistantId });
      });
      written = text;
    };
    const schedule = () => { if (!timer) timer = setTimeout(flush, this.#flushMs); };
    const resume = this.#resume(thread);
    if (!resume) this.#db.prepare('UPDATE conv_threads SET provider_session=NULL, session_turns=0 WHERE id=?').run(threadId);
    const recent = resume ? [] : this.#db.prepare(`SELECT role, text FROM (SELECT rowid AS r, role, text, created_at FROM conv_messages
      WHERE thread_id=? AND id<>? ORDER BY created_at DESC, r DESC LIMIT ?) ORDER BY created_at, r`)
      .all(threadId, turn.user_message_id, this.#session.recentMessages);
    try {
      const reply = await this.#runner.turn(companionId, {
        prompt: user.text, resume, systemPrompt: this.#systemPrompt(companionId, { fresh: !resume, recent }), allowedTools: this.#allowedTools, signal: controller.signal,
        onEvent: event => {
          if (event.type === 'session') this.#db.prepare('UPDATE conv_threads SET provider_session=? WHERE id=?').run(event.id, threadId);
          else if (event.type === 'delta') { text += event.text; schedule(); }
        }
      });
      if (reply.sessionId) this.#db.prepare('UPDATE conv_threads SET provider_session=? WHERE id=?').run(reply.sessionId, threadId);
      this.#db.prepare('UPDATE conv_threads SET session_turns=session_turns+1, session_at=? WHERE id=?').run(this.#now(), threadId);
      clearTimeout(timer);
      text = reply.text || text;
      flush();
      this.#finish(turn, 'complete');
    } catch (error) {
      clearTimeout(timer); flush();
      if (this.#closing) this.#finish(turn, 'error', { code: 'INTERRUPTED', message: ERROR_MESSAGES.INTERRUPTED });
      else if (error instanceof RunnerError && error.code === 'CANCELLED') this.#finish(turn, 'cancelled');
      else this.#finish(turn, 'error', describe(error));
    } finally { this.#active.delete(key); }
  }
}

// Provider reset times arrive as Unix seconds, milliseconds or a date string; the API always sends ISO 8601.
function isoTime(value) {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  const date = new Date(ms);
  return Number.isFinite(ms) && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function describe(error) {
  if (error instanceof RunnerError) {
    const resetsAt = isoTime(error.resetsAt);
    return { code: error.code, message: error.message, ...(resetsAt ? { resetsAt } : {}) };
  }
  return { code: 'PROVIDER_ERROR', message: 'Your agent could not complete this reply.' };
}
