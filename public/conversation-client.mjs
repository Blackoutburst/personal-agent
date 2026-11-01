const ID = /^[A-Za-z0-9._:-]{1,128}$/, REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
const LIMIT = 262144;
const MESSAGES = {
  INVALID_REQUEST: 'Check the conversation input.', BUSY: 'Resolve the pending request first.', NOT_READY: 'Open the development conversation first.',
  ACCESS_DENIED: 'Access was denied. Open again after checking your session.', UNAVAILABLE: 'The conversation service is unavailable.',
  NETWORK_ERROR: 'The request could not be confirmed. Retry the same pending request.', INVALID_RESPONSE: 'The conversation response could not be verified.',
  RESYNC_REQUIRED: 'The conversation needed a fresh snapshot.', CONFLICT: 'The request conflicts with retained state.'
};
export class ConversationError extends Error {
  constructor(code, status = null) {
    if (!Object.hasOwn(MESSAGES, code)) code = 'INVALID_RESPONSE';
    super(MESSAGES[code]); this.name = 'ConversationError'; this.code = code; this.status = status;
  }
}
function safeError(error) {
  try { if (error instanceof ConversationError && Object.hasOwn(MESSAGES, error.code)) return new ConversationError(error.code,
    Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : null); } catch { /* Fixed fallback. */ }
  return new ConversationError('NETWORK_ERROR');
}
function check(condition, code = 'INVALID_RESPONSE') { if (!condition) throw new ConversationError(code); }
function plain(value, required, optional = [], code = 'INVALID_RESPONSE') {
  try {
    check(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    check(keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) && descriptors[key].enumerable &&
      Object.hasOwn(descriptors[key], 'value')) && required.every(key => Object.hasOwn(descriptors, key)), code);
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { throw new ConversationError(code); }
}
function identifier(value, request = false, code = 'INVALID_RESPONSE') {
  check(typeof value === 'string' && (request ? REQUEST_ID : ID).test(value), code); return value;
}
function array(value, maximum) {
  try {
    check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    check(keys.length === value.length + 1);
    return Array.from({ length: value.length }, (_, index) => { const item = descriptors[index];
      check(item?.enumerable && Object.hasOwn(item, 'value')); return item.value; });
  } catch { throw new ConversationError('INVALID_RESPONSE'); }
}
function text(value, maximum, bytes, empty = false, code = 'INVALID_RESPONSE') {
  check(typeof value === 'string' && value.length <= maximum && (empty || value.trim().length > 0), code);
  // Reject malformed UTF-16 without relying on a browser-specific String extension.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); check(next >= 0xdc00 && next <= 0xdfff, code); }
    else check(unit < 0xdc00 || unit > 0xdfff, code);
  }
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).length <= bytes, code);
  return value;
}
function cursor(value, code = 'INVALID_RESPONSE') {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)), code); return Number(value);
}
function request(action, payload) {
  const selected = plain(payload, action === 'snapshot' ? [] : action === 'createThread' ? ['requestId', 'title'] :
    action === 'submit' ? ['requestId', 'threadId', 'text'] : action === 'events' ? ['threadId', 'cursor'] : ['invalid-action'],
  action === 'snapshot' ? ['threadId'] : [], 'INVALID_REQUEST');
  check(['snapshot', 'createThread', 'submit', 'events'].includes(action), 'INVALID_REQUEST');
  if (Object.hasOwn(selected, 'threadId')) identifier(selected.threadId, false, 'INVALID_REQUEST');
  if (Object.hasOwn(selected, 'requestId')) identifier(selected.requestId, true, 'INVALID_REQUEST');
  if (action === 'createThread') text(selected.title, 80, 80, false, 'INVALID_REQUEST');
  if (action === 'submit') text(selected.text, 1000, 4096, false, 'INVALID_REQUEST');
  if (action === 'events') cursor(selected.cursor, 'INVALID_REQUEST');
  return { action, ...selected };
}

// Fixed relative URL and same-origin policy: this transport cannot select a remote endpoint.
export function createConversationTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async (action, payload = {}, { signal } = {}) => {
    const body = JSON.stringify(request(action, payload)), controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    let response;
    try {
      check(typeof fetchImpl === 'function', 'UNAVAILABLE');
      response = await fetchImpl('api/conversation', { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body });
      if (response.status === 401 || response.status === 403) throw new ConversationError('ACCESS_DENIED', response.status);
      if (!response.ok) throw new ConversationError(response.status === 409 ? 'CONFLICT' : response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', response.status);
      check(!response.redirected && /^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') || ''));
      const length = response.headers.get('content-length');
      check(length === null || (/^[0-9]+$/.test(length) && Number(length) <= LIMIT));
      let result;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength; check(size <= LIMIT); chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          try { result = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ConversationError('INVALID_RESPONSE'); }
        } finally { try { await reader.cancel(); } catch { /* No response data enters errors. */ } reader.releaseLock(); }
      } else { result = await response.text(); check(new TextEncoder().encode(result).length <= LIMIT); }
      try { return JSON.parse(result); } catch { throw new ConversationError('INVALID_RESPONSE'); }
    } catch (error) { throw safeError(error); }
    finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (response?.body && !response.body.locked) { try { await response.body.cancel(); } catch { /* Ignore consumed-body cancellation. */ } }
    }
  };
}
function envelope(value, required, optional = []) {
  const selected = plain(value, ['version', 'synthetic', ...required], optional);
  check(selected.version === 1 && selected.synthetic === true); return selected;
}
function thread(value) {
  const selected = plain(value, ['id', 'title']);
  return { id: identifier(selected.id), title: text(selected.title, 80, 80) };
}
function message(value, threadId) {
  const selected = plain(value, ['id', 'threadId', 'role', 'text'], ['requestId']);
  check(selected.threadId === threadId, 'RESYNC_REQUIRED');
  check(selected.role === 'user' || selected.role === 'assistant');
  return { id: identifier(selected.id), threadId: identifier(selected.threadId), role: selected.role,
    text: text(selected.text, selected.role === 'user' ? 1000 : 16384, selected.role === 'user' ? 4096 : 65536, selected.role === 'assistant'),
    ...(Object.hasOwn(selected, 'requestId') ? { requestId: identifier(selected.requestId, true) } : {}) };
}
function snapshot(value, requested) {
  const selected = envelope(value, ['threads', 'threadId', 'messages', 'cursor', 'runtime']);
  const threads = array(selected.threads, 100).map(thread); check(new Set(threads.map(item => item.id)).size === threads.length);
  const sourceMessages = array(selected.messages, 500);
  const runtime = plain(selected.runtime, ['state']); check(runtime.state === 'development-double');
  const head = cursor(selected.cursor);
  if (selected.threadId === null) check(threads.length === 0 && selected.messages.length === 0 && head === 0 && requested === undefined);
  else { identifier(selected.threadId); check(threads.some(item => item.id === selected.threadId)); }
  check(requested === undefined || requested === selected.threadId);
  const messages = sourceMessages.map(item => message(item, selected.threadId));
  check(new Set(messages.map(item => item.id)).size === messages.length);
  return { threads, threadId: selected.threadId, messages, cursor: selected.cursor, lastSeq: head, runtime: { state: 'development-double' } };
}
function eventPage(value, threadId, from) {
  const selected = envelope(value, ['threadId', 'events', 'cursor', 'lastSeq', 'hasMore']);
  check(selected.threadId === threadId, 'RESYNC_REQUIRED');
  check(Number.isSafeInteger(selected.lastSeq) && selected.lastSeq >= 0 && typeof selected.hasMore === 'boolean');
  const events = array(selected.events, 100).map(item => {
    const head = plain(item, ['seq', 'threadId', 'type'], ['message', 'requestId', 'state']);
    check(Number.isSafeInteger(head.seq) && head.seq >= 1 && head.threadId === threadId, 'RESYNC_REQUIRED');
    if (head.type === 'message') { const exact = plain(item, ['seq', 'threadId', 'type', 'message']); return { ...exact, message: message(exact.message, threadId) }; }
    check(head.type === 'turn'); const exact = plain(item, ['seq', 'threadId', 'type', 'requestId', 'state']);
    identifier(exact.requestId, true); check(['streaming', 'complete', 'error'].includes(exact.state)); return exact;
  });
  check(events.every((item, index) => index === 0 || item.seq === events[index - 1].seq + 1), 'RESYNC_REQUIRED');
  const end = cursor(selected.cursor);
  check(end === (events.at(-1)?.seq ?? from) && selected.lastSeq >= end && selected.hasMore === (end < selected.lastSeq) &&
    (events.length > 0 || !selected.hasMore), 'RESYNC_REQUIRED');
  const fresh = events.filter(item => item.seq > from);
  check(!fresh.length || fresh[0].seq === from + 1, 'RESYNC_REQUIRED');
  return { events: fresh, end: Math.max(from, end), lastSeq: selected.lastSeq };
}
function upsert(messages, next) {
  const index = messages.findIndex(item => item.id === next.id);
  if (index === -1) { check(messages.length < 500); messages.push(next); }
  else { const before = messages[index]; check(before.threadId === next.threadId && before.role === next.role &&
    (!before.requestId || !next.requestId || before.requestId === next.requestId) &&
    (before.role !== 'user' || before.text === next.text)); messages[index] = { ...before, ...next }; }
}
const initial = () => ({ synthetic: false, runtime: null, threads: [], threadId: null, messages: [], cursor: null,
  lastSeq: 0, hasMore: false, turn: null, connection: 'disconnected', pending: null, draft: '', error: null });

// pending is a submit {threadId,text} or createThread {title}, plus stable requestId/status.
// Drafts, pending writes and display data live only in memory. There is no scheduler or automatic resubmission.
export function createConversationClient({ transport = createConversationTransport(), requestId = () => globalThis.crypto.randomUUID() } = {}) {
  let state = initial(), epoch = 0, polling = null;
  const listeners = new Set(), active = new Set(), copy = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) { try { listener(copy()); } catch { /* A view cannot bypass display clearing. */ } } };
  const current = version => version === epoch;
  function begin() { epoch++; for (const controller of active) controller.abort(); active.clear(); polling = null; return epoch; }
  function clear(connection = 'disconnected', error = null) { begin(); state = { ...initial(), connection, error }; emit(); return copy(); }
  async function call(action, payload, version) {
    if (!current(version)) return undefined;
    const controller = new AbortController(); active.add(controller);
    try { return await transport(action, payload, { signal: controller.signal }); }
    finally { active.delete(controller); }
  }
  function failure(error, version, pending = null, write = false) {
    if (!current(version)) return;
    const code = safeError(error).code;
    if (code === 'ACCESS_DENIED') { clear('denied', 'ACCESS_DENIED'); return; }
    if (code === 'INVALID_RESPONSE' || code === 'RESYNC_REQUIRED') { clear('unavailable', 'INVALID_RESPONSE'); return; }
    const uncertain = code === 'NETWORK_ERROR' || code === 'UNAVAILABLE';
    state = { ...state, connection: uncertain ? (code === 'UNAVAILABLE' ? 'unavailable' : 'reconnecting') : state.synthetic ? 'ready' : 'unavailable',
      error: code, pending: uncertain && pending ? { ...pending, ...(write ? { status: 'uncertain' } : {}) } : null };
    emit();
  }
  async function load(threadId, version, retained = null) {
    try {
      const received = await call('snapshot', threadId === undefined ? {} : { threadId }, version);
      if (!current(version)) return;
      const data = snapshot(received, threadId);
      let pending = retained;
      const confirmed = pending?.action === 'submit' && data.messages.some(item => item.role === 'user' && item.requestId === pending.requestId);
      const draft = confirmed && state.draft === pending.text ? '' : state.draft;
      if (confirmed) pending = null;
      state = { ...state, ...data, synthetic: true, connection: 'ready', hasMore: false, turn: null, pending, draft, error: null }; emit();
    } catch (error) { failure(error, version, retained); }
  }
  function nextId() { try { return identifier(requestId(), true, 'INVALID_REQUEST'); } catch { throw new ConversationError('INVALID_REQUEST'); } }
  async function open(options = {}) {
    const selected = plain(options, [], ['threadId'], 'INVALID_REQUEST');
    if (Object.hasOwn(selected, 'threadId')) identifier(selected.threadId, false, 'INVALID_REQUEST');
    const version = begin(); state = { ...initial(), connection: 'loading', threadId: selected.threadId ?? null }; emit();
    await load(selected.threadId, version); return copy();
  }
  async function submitPending(pending, version) {
    try {
      const payload = pending.action === 'submit' ? { requestId: pending.requestId, threadId: pending.threadId, text: pending.text } :
        { requestId: pending.requestId, title: pending.title };
      const received = await call(pending.action, payload, version);
      if (!current(version)) return;
      if (pending.action === 'createThread') {
        const body = envelope(received, ['thread']), created = thread(body.thread);
        check(created.title === pending.title);
        state = { ...state, pending: null, threadId: created.id }; emit(); await load(created.id, version); return;
      }
      const body = envelope(received, ['accepted']), accepted = plain(body.accepted, ['requestId', 'threadId', 'messageId']);
      check(accepted.requestId === pending.requestId && accepted.threadId === pending.threadId); identifier(accepted.messageId);
      if (state.pending?.requestId !== pending.requestId) return; // Events may already have completed this turn.
      const messages = [...state.messages];
      upsert(messages, { id: accepted.messageId, threadId: pending.threadId, role: 'user', text: pending.text, requestId: pending.requestId });
      state = { ...state, messages, pending: { ...pending, status: 'accepted' }, draft: state.draft === pending.text ? '' : state.draft, connection: 'ready', error: null,
        turn: state.turn?.requestId === pending.requestId ? state.turn : { requestId: pending.requestId, state: 'streaming' } }; emit();
    } catch (error) {
      const code = safeError(error).code;
      if (pending.action === 'submit' && current(version) && state.pending?.requestId !== pending.requestId &&
        ['NETWORK_ERROR', 'UNAVAILABLE'].includes(code)) return;
      failure(error, version, pending, true);
    }
  }
  async function create(title) {
    text(title, 80, 80, false, 'INVALID_REQUEST'); check(!state.pending, 'BUSY'); check(state.synthetic && state.connection === 'ready', 'NOT_READY');
    const pending = { action: 'createThread', requestId: nextId(), title, status: 'submitting' }, version = begin();
    state = { ...initial(), connection: 'loading', pending }; emit(); await submitPending(pending, version); return copy();
  }
  async function send(value = state.draft) {
    text(value, 1000, 4096, false, 'INVALID_REQUEST'); check(!state.pending, 'BUSY');
    check(state.synthetic && state.connection === 'ready' && state.threadId !== null, 'NOT_READY');
    const pending = { action: 'submit', requestId: nextId(), threadId: state.threadId, text: value, status: 'submitting' }, version = epoch;
    state = { ...state, pending, error: null }; emit(); await submitPending(pending, version); return copy();
  }
  async function retry() {
    check(state.pending?.status === 'uncertain', 'NOT_READY');
    const pending = { ...state.pending, status: 'submitting' }, version = epoch;
    state = { ...state, pending, error: null }; emit(); await submitPending(pending, version); return copy();
  }
  function poll() {
    check(state.synthetic && state.threadId !== null && state.cursor !== null && state.connection !== 'loading', 'NOT_READY');
    if (polling) return polling.promise;
    const version = epoch, threadId = state.threadId, from = cursor(state.cursor), ticket = {};
    ticket.promise = (async () => {
      try {
        const received = await call('events', { threadId, cursor: String(from) }, version);
        if (!current(version)) return copy();
        const page = eventPage(received, threadId, from), messages = [...state.messages];
        let turn = state.turn, pending = state.pending, draft = state.draft;
        for (const event of page.events) {
          if (event.type === 'message') { upsert(messages, event.message);
            if (pending?.action === 'submit' && event.message.role === 'user' && event.message.requestId === pending.requestId) {
              if (draft === pending.text) draft = ''; pending = { ...pending, status: 'accepted' };
            }
          } else { turn = { requestId: event.requestId, state: event.state };
            if (pending?.requestId === event.requestId && event.state !== 'streaming') pending = null;
          }
        }
        const lastSeq = Math.max(state.lastSeq, page.lastSeq);
        state = { ...state, messages, turn, pending, draft, cursor: String(page.end), lastSeq, hasMore: page.end < lastSeq, connection: 'ready', error: null }; emit();
      } catch (error) {
        if (current(version) && error instanceof ConversationError && error.code === 'RESYNC_REQUIRED') {
          const pending = state.pending, draft = state.draft, next = begin();
          state = { ...initial(), threadId, pending, draft, connection: 'loading', error: 'RESYNC_REQUIRED' }; emit(); await load(threadId, next, pending);
        } else failure(error, version, state.pending);
      }
      return copy();
    })().finally(() => { if (polling === ticket) polling = null; });
    polling = ticket; return ticket.promise;
  }
  return Object.freeze({ getState: copy,
    subscribe(listener) { check(typeof listener === 'function', 'INVALID_REQUEST'); listeners.add(listener); listener(copy()); return () => listeners.delete(listener); },
    open, select(threadId) { identifier(threadId, false, 'INVALID_REQUEST'); return open({ threadId }); }, create, send, retry, poll,
    setDraft(value) { text(value, 1000, 4096, true, 'INVALID_REQUEST'); state = { ...state, draft: value }; emit(); return copy(); },
    clear: () => clear(), disconnect: () => clear() });
}
