import { createHash, randomUUID } from 'node:crypto';

const NAMESPACE = 'development-conversation-v1', KEY = 'state', MAX_BYTES = 12288;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/, HASH = /^[a-f0-9]{64}$/;
const PREFIX = 'CONVERSATION_DEMO_';
const MESSAGES = {
  INVALID_REQUEST: 'The synthetic conversation request is invalid.',
  NOT_FOUND: 'The synthetic conversation was not found.',
  CONFLICT: 'The synthetic conversation request conflicts with a previous request.',
  CAPACITY: 'The synthetic conversation fixture is full.',
  UNAVAILABLE: 'The synthetic conversation fixture is unavailable.'
};
const PARTIAL = 'Synthetic reply.';
const REPLY = 'Synthetic reply. No AI, tool, permission or external action was used.';

export class ConversationDemoError extends Error {
  constructor(code) {
    const suffix = typeof code === 'string' && code.startsWith(PREFIX) ? code.slice(PREFIX.length) : code;
    const selected = Object.hasOwn(MESSAGES, suffix) ? suffix : 'UNAVAILABLE';
    super(MESSAGES[selected]); this.name = 'ConversationDemoError'; this.code = PREFIX + selected;
  }
}
function requireDemo(condition, code = 'UNAVAILABLE') { if (!condition) throw new ConversationDemoError(code); }
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function shape(value, required, optional = [], code = 'UNAVAILABLE') {
  try {
    requireDemo(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireDemo(required.every(key => keys.includes(key)) && keys.every(key => typeof key === 'string' &&
      [...required, ...optional].includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { throw new ConversationDemoError(code); }
}
function text(value, bytes, characters = bytes) {
  return typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    value.length <= characters && Buffer.byteLength(value, 'utf8') <= bytes;
}
function fingerprint(value) { return createHash('sha256').update('personal-agent-synthetic-conversation-v1\0' + JSON.stringify(value)).digest('hex'); }
function input(payload) {
  const { action } = shape(payload, ['action'], ['threadId', 'cursor', 'requestId', 'title', 'text'], 'INVALID_REQUEST');
  if (action === 'snapshot') {
    const value = shape(payload, ['action'], ['threadId'], 'INVALID_REQUEST');
    requireDemo(!Object.hasOwn(value, 'threadId') || matches(value.threadId, UUID), 'INVALID_REQUEST'); return value;
  }
  if (action === 'events') {
    const value = shape(payload, ['action', 'threadId', 'cursor'], [], 'INVALID_REQUEST');
    requireDemo(matches(value.threadId, UUID) && matches(value.cursor, /^(0|[1-9][0-9]{0,15})$/) && Number.isSafeInteger(Number(value.cursor)), 'INVALID_REQUEST'); return value;
  }
  if (action === 'createThread') {
    const value = shape(payload, ['action', 'requestId', 'title'], [], 'INVALID_REQUEST');
    requireDemo(matches(value.requestId, REQUEST) && text(value.title, 80), 'INVALID_REQUEST');
    return { action, requestId: value.requestId, title: value.title };
  }
  requireDemo(action === 'submit', 'INVALID_REQUEST');
  const value = shape(payload, ['action', 'requestId', 'threadId', 'text'], [], 'INVALID_REQUEST');
  requireDemo(matches(value.requestId, REQUEST) && matches(value.threadId, UUID) && text(value.text, 4096, 1000), 'INVALID_REQUEST');
  return { action, requestId: value.requestId, threadId: value.threadId, text: value.text };
}
function dto(fields) { return { version: 1, synthetic: true, ...fields }; }
function eventsFor(thread) {
  const events = [];
  for (let index = 0; index < thread.messages.length; index += 2) {
    const user = thread.messages[index], assistant = thread.messages[index + 1], seq = index / 2 * 5;
    events.push(
      { seq: seq + 1, threadId: thread.id, type: 'message', message: user },
      { seq: seq + 2, threadId: thread.id, type: 'turn', requestId: user.requestId, state: 'streaming' },
      { seq: seq + 3, threadId: thread.id, type: 'message', message: { ...assistant, text: PARTIAL } },
      { seq: seq + 4, threadId: thread.id, type: 'message', message: assistant },
      { seq: seq + 5, threadId: thread.id, type: 'turn', requestId: user.requestId, state: 'complete' }
    );
  }
  return events;
}

// Explicit development fixture only: no account/provider/runtime/network adapter exists here.
// One bounded JSON record commits paired messages and retry receipts together. Deterministic
// synthetic events are regenerated from those messages, never an executing/production tenant log.
export class ConversationDemo {
  #store;
  constructor(bootstrapStore) {
    this.#store = bootstrapStore;
    try { this.#validate(this.#store.getOrInsert(NAMESPACE, KEY, { version: 1, threads: [], requests: [] })); }
    catch { throw new ConversationDemoError('UNAVAILABLE'); }
  }
  #validate(value) {
    const state = shape(value, ['version', 'threads', 'requests']);
    requireDemo(state.version === 1 && Array.isArray(state.threads) && state.threads.length <= 5 && Array.isArray(state.requests));
    requireDemo(Buffer.byteLength(JSON.stringify(state)) <= MAX_BYTES);
    const ids = new Set(), requests = new Map(), expected = new Map();
    for (const raw of state.requests) {
      const row = shape(raw, ['requestId', 'action', 'digest', 'threadId', 'messageId']);
      requireDemo(matches(row.requestId, REQUEST) && !requests.has(row.requestId) && matches(row.digest, HASH) &&
        matches(row.threadId, UUID) && (row.action === 'createThread' ? row.messageId === null : row.action === 'submit' && matches(row.messageId, UUID)));
      requests.set(row.requestId, row);
    }
    for (const raw of state.threads) {
      const thread = shape(raw, ['id', 'title', 'messages']);
      requireDemo(matches(thread.id, UUID) && !ids.has(thread.id) && text(thread.title, 80) && Array.isArray(thread.messages) && thread.messages.length % 2 === 0);
      ids.add(thread.id);
      const creates = [...requests.values()].filter(row => row.action === 'createThread' && row.threadId === thread.id);
      requireDemo(creates.length === 1);
      const created = creates[0]; expected.set(created.requestId, fingerprint({ action: 'createThread', requestId: created.requestId, title: thread.title }));
      for (let index = 0; index < thread.messages.length; index += 2) {
        const pair = thread.messages.slice(index, index + 2).map(message => shape(message, ['id', 'threadId', 'role', 'text', 'requestId']));
        const [user, assistant] = pair;
        for (const message of pair) {
          requireDemo(matches(message.id, UUID) && !ids.has(message.id) && message.threadId === thread.id && matches(message.requestId, REQUEST)); ids.add(message.id);
        }
        requireDemo(user.role === 'user' && text(user.text, 4096, 1000) && assistant.role === 'assistant' && assistant.text === REPLY && assistant.requestId === user.requestId);
        const receipt = requests.get(user.requestId);
        requireDemo(receipt?.action === 'submit' && receipt.threadId === thread.id && receipt.messageId === user.id && !expected.has(user.requestId));
        expected.set(user.requestId, fingerprint({ action: 'submit', requestId: user.requestId, threadId: thread.id, text: user.text }));
      }
    }
    requireDemo(expected.size === requests.size && [...requests.values()].every(row => expected.get(row.requestId) === row.digest));
    return state;
  }
  handle(payload) {
    const op = input(payload);
    try {
      this.#store.db.exec('BEGIN IMMEDIATE');
      try {
        const state = this.#validate(this.#store.get(NAMESPACE, KEY));
        let result;
        if (op.action === 'snapshot') {
          const thread = Object.hasOwn(op, 'threadId') ? state.threads.find(row => row.id === op.threadId) : state.threads[0];
          requireDemo(!Object.hasOwn(op, 'threadId') || thread, 'NOT_FOUND');
          result = dto({ threads: state.threads.map(({ id, title }) => ({ id, title })), threadId: thread?.id ?? null,
            messages: thread?.messages ?? [], cursor: String((thread?.messages.length ?? 0) / 2 * 5), runtime: { state: 'development-double' } });
        } else if (op.action === 'events') {
          const thread = state.threads.find(row => row.id === op.threadId); requireDemo(thread, 'NOT_FOUND');
          const events = eventsFor(thread), from = Number(op.cursor); requireDemo(from <= events.length, 'INVALID_REQUEST');
          const page = events.slice(from, from + 3), cursor = from + page.length;
          result = dto({ threadId: thread.id, events: page, cursor: String(cursor), lastSeq: events.length, hasMore: cursor < events.length });
        } else {
          const digest = fingerprint(op), cached = state.requests.find(row => row.requestId === op.requestId);
          requireDemo(!cached || cached.digest === digest, 'CONFLICT');
          let thread = state.threads.find(row => row.id === (cached?.threadId ?? op.threadId)), messageId = cached?.messageId ?? null;
          if (!cached) {
            if (op.action === 'createThread') {
              requireDemo(state.threads.length < 5, 'CAPACITY');
              thread = { id: randomUUID(), title: op.title, messages: [] }; state.threads.push(thread);
            } else {
              requireDemo(thread, 'NOT_FOUND'); messageId = randomUUID();
              thread.messages.push({ id: messageId, threadId: thread.id, role: 'user', text: op.text, requestId: op.requestId },
                { id: randomUUID(), threadId: thread.id, role: 'assistant', text: REPLY, requestId: op.requestId });
            }
            state.requests.push({ requestId: op.requestId, action: op.action, digest, threadId: thread.id, messageId });
            requireDemo(Buffer.byteLength(JSON.stringify(state)) <= MAX_BYTES, 'CAPACITY');
            this.#store.put(NAMESPACE, KEY, state);
          }
          result = op.action === 'createThread' ? dto({ thread: { id: thread.id, title: thread.title } }) :
            dto({ accepted: { requestId: op.requestId, threadId: thread.id, messageId } });
        }
        this.#store.db.exec('COMMIT'); return result;
      } catch (error) { try { this.#store.db.exec('ROLLBACK'); } catch { /* Fixed public errors only. */ } throw error; }
    } catch (error) { throw error instanceof ConversationDemoError ? error : new ConversationDemoError('UNAVAILABLE'); }
  }
}
