const ID = /^[A-Za-z0-9._:-]{1,128}$/, REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PEER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 16777216;
// Mirrors src/conversations.mjs LIMITS.
export const USER_CHARS = 8000, USER_BYTES = 32768;
const ASSISTANT_CHARS = 100000, ASSISTANT_BYTES = 400000;
const RUNTIME_STATES = ['ready', 'signed-out', 'unconfigured', 'provider-missing'], PROVIDERS = ['claude', 'codex'];
const TURN_STATES = ['streaming', 'complete', 'error', 'cancelled'];
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
function attachmentIds(value, code = 'INVALID_REQUEST') {
  try {
    const ids = array(value, 8);
    check(ids.every(id => typeof id === 'string' && FILE_ID.test(id)) && new Set(ids).size === ids.length, code);
    return ids;
  } catch { throw new ConversationError(code); }
}
// The URL is derived from the authenticated file ID, never accepted as a remote media source.
export function parseAttachment(value) {
  const file = plain(value, ['id', 'name', 'mime', 'size', 'sha256', 'direction', 'url'], ['caption']);
  check(typeof file.id === 'string' && FILE_ID.test(file.id) && file.url === `/api/files/${file.id}`);
  text(file.name, 200, 800); check(!/[\\/\u0000-\u001f\u007f]/.test(file.name));
  check(typeof file.mime === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,99}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}$/.test(file.mime));
  check(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 100 * 1024 * 1024 &&
    typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256) && ['user', 'companion'].includes(file.direction));
  if (Object.hasOwn(file, 'caption')) text(file.caption, 1000, 4000, true);
  return { ...file };
}
function request(action, payload) {
  const selected = plain(payload, action === 'snapshot' ? [] : action === 'createThread' ? ['requestId', 'title'] :
    action === 'submit' ? ['requestId', 'threadId', 'text'] : action === 'events' ? ['threadId', 'cursor'] :
    ['cancel', 'deleteThread', 'archiveThread'].includes(action) ? ['requestId', 'threadId'] : action === 'archivedThreads' ? [] : ['invalid-action'],
  action === 'snapshot' ? ['threadId'] : action === 'submit' ? ['attachments'] : [], 'INVALID_REQUEST');
  check(['snapshot', 'createThread', 'submit', 'events', 'cancel', 'deleteThread', 'archiveThread', 'archivedThreads'].includes(action), 'INVALID_REQUEST');
  if (Object.hasOwn(selected, 'threadId')) identifier(selected.threadId, false, 'INVALID_REQUEST');
  if (Object.hasOwn(selected, 'requestId')) identifier(selected.requestId, true, 'INVALID_REQUEST');
  if (action === 'createThread') text(selected.title, 80, 80, false, 'INVALID_REQUEST');
  if (action === 'submit') {
    const ids = Object.hasOwn(selected, 'attachments') ? attachmentIds(selected.attachments) : [];
    text(selected.text, USER_CHARS, USER_BYTES, ids.length > 0, 'INVALID_REQUEST');
  }
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
      if (response.status === 404) throw new ConversationError('RESYNC_REQUIRED', response.status);
      if (!response.ok && response.status !== 409) throw new ConversationError(response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', response.status);
      const maximum = response.status === 409 ? 4096 : LIMIT;
      check(!response.redirected && /^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') || ''));
      const length = response.headers.get('content-length');
      check(length === null || (/^[0-9]+$/.test(length) && Number(length) <= maximum));
      let result;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength; check(size <= maximum); chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          try { result = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ConversationError('INVALID_RESPONSE'); }
        } finally { try { await reader.cancel(); } catch { /* No response data enters errors. */ } reader.releaseLock(); }
      } else { result = await response.text(); check(new TextEncoder().encode(result).length <= maximum); }
      let parsed;
      try { parsed = JSON.parse(result); } catch { throw new ConversationError('INVALID_RESPONSE'); }
      if (response.status === 409) throw new ConversationError(parsed?.error?.code === 'BUSY' ? 'BUSY' : 'CONFLICT', 409);
      return parsed;
    } catch (error) {
      if (response?.status === 409 && !(error instanceof ConversationError && ['BUSY', 'CONFLICT'].includes(error.code))) {
        throw new ConversationError('CONFLICT', 409);
      }
      throw safeError(error);
    }
    finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (response?.body && !response.body.locked) { try { await response.body.cancel(); } catch { /* Ignore consumed-body cancellation. */ } }
    }
  };
}
const FILE_ERRORS = {
  INVALID_REQUEST: 'Choose a valid file (up to 100 MiB; most files are limited to 25 MiB).',
  TOO_LARGE: 'That file exceeds the server limit: 25 MiB, or 100 MiB for supported video.',
  QUOTA: 'Your file storage is full. Delete an old conversation and its files to make room.',
  ACCESS_DENIED: 'Your session ended. Sign in again before uploading.',
  CONFLICT: 'This upload could not be matched. Remove it and choose the file again.',
  NETWORK_ERROR: 'The upload could not be confirmed. Retry to reuse the same upload request.',
  INVALID_RESPONSE: 'The upload response could not be verified. Retry the same file.',
  CANCELLED: 'Upload cancelled.'
};
export class AttachmentError extends Error {
  constructor(code) { super(FILE_ERRORS[code] ?? FILE_ERRORS.NETWORK_ERROR); this.name = 'AttachmentError'; this.code = Object.hasOwn(FILE_ERRORS, code) ? code : 'NETWORK_ERROR'; }
}
// XHR supplies upload progress; cookies and Origin are browser-managed, never placed in a URL.
export function createFileTransport({ xhrFactory = () => new XMLHttpRequest(), fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    upload(file, { threadId, requestId, signal, onProgress = () => {} } = {}) {
      return new Promise((resolve, reject) => {
        let xhr, finished = false;
        const finish = (error, value) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
        const abort = () => { xhr?.abort(); finish(new AttachmentError('CANCELLED')); };
        try {
          check(file instanceof Blob && Number.isSafeInteger(file.size) && file.size <= 100 * 1024 * 1024, 'INVALID_REQUEST');
          check(typeof threadId === 'string' && FILE_ID.test(threadId) && typeof requestId === 'string' && REQUEST_ID.test(requestId), 'INVALID_REQUEST');
          text(file.name, 200, 800); check(!/[\\/\u0000-\u001f\u007f]/.test(file.name), 'INVALID_REQUEST');
          if (signal?.aborted) { abort(); return; }
          xhr = xhrFactory(); xhr.open('POST', 'api/files'); xhr.withCredentials = true; xhr.timeout = 120000;
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Thread-Id', threadId); xhr.setRequestHeader('X-Request-Id', requestId);
          xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name)); xhr.setRequestHeader('Accept', 'application/json');
          xhr.upload.onprogress = event => { if (!finished && event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / Math.max(1, event.total) * 100))); };
          xhr.onerror = xhr.ontimeout = () => finish(new AttachmentError('NETWORK_ERROR'));
          xhr.onabort = () => finish(new AttachmentError('CANCELLED'));
          xhr.onload = () => {
            if (xhr.status === 401 || xhr.status === 403) return finish(new AttachmentError('ACCESS_DENIED'));
            if (xhr.status === 413) {
              let quota = false;
              try { quota = xhr.responseText.length <= 16384 && JSON.parse(xhr.responseText)?.error?.code === 'FILE_QUOTA'; } catch { /* Fixed size failure. */ }
              return finish(new AttachmentError(quota ? 'QUOTA' : 'TOO_LARGE'));
            }
            if (xhr.status === 409) return finish(new AttachmentError('CONFLICT'));
            if (xhr.status === 507 || xhr.status === 429) return finish(new AttachmentError('QUOTA'));
            try {
              check(xhr.responseText.length <= 16384 && /^application\/json(?:\s*;.*)?$/i.test(xhr.getResponseHeader('Content-Type') ?? ''));
              const result = JSON.parse(xhr.responseText);
              if (xhr.status !== 200) {
                if (/QUOTA|STORAGE_FULL/.test(result?.error?.code ?? '')) return finish(new AttachmentError('QUOTA'));
                return finish(new AttachmentError(xhr.status >= 500 ? 'NETWORK_ERROR' : 'INVALID_REQUEST'));
              }
              const selected = plain(result, ['file']), received = parseAttachment(selected.file);
              check(received.direction === 'user'); finish(null, received);
            } catch { finish(new AttachmentError('INVALID_RESPONSE')); }
          };
          signal?.addEventListener('abort', abort, { once: true }); xhr.send(file);
        } catch { finish(new AttachmentError('INVALID_REQUEST')); }
      });
    },
    async remove(id, { signal, knownPending = false } = {}) {
      check(typeof id === 'string' && FILE_ID.test(id), 'INVALID_REQUEST');
      const response = await fetchImpl('api/files/remove', { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ id }), signal });
      if (response.status === 401 || response.status === 403) throw new AttachmentError('ACCESS_DENIED');
      if (response.status === 404 && knownPending === true) return true;
      if (!response.ok || response.redirected) throw new AttachmentError(response.status === 409 ? 'CONFLICT' : 'NETWORK_ERROR');
      check(/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '') && Number(response.headers.get('content-length') ?? 0) <= 1024);
      const body = await response.text(); check(body.length <= 1024);
      const result = plain(JSON.parse(body), ['removed']); check(result.removed === true); return true;
    }
  });
}
function envelope(value, required, optional = []) {
  const selected = plain(value, ['version', 'synthetic', ...required], optional);
  check(selected.version === 1 && typeof selected.synthetic === 'boolean'); return selected;
}
function thread(value) {
  const selected = plain(value, ['id', 'title']);
  return { id: identifier(selected.id), title: text(selected.title, 80, 80) };
}
function feeling(value, role) { check(role === 'assistant' && typeof value === 'string' && /^[a-z-]{1,20}$/.test(value)); return value; }
function message(value, threadId) {
  const selected = plain(value, ['id', 'threadId', 'role', 'text'], ['requestId', 'feeling', 'attachments', 'peer']);
  check(selected.threadId === threadId, 'RESYNC_REQUIRED');
  if (selected.role === 'peer') {
    check(Object.hasOwn(selected, 'peer') && !['requestId', 'feeling', 'attachments'].some(key => Object.hasOwn(selected, key)));
    const peer = plain(selected.peer, ['direction', 'companionId', 'name', 'ownerLabel', 'sentAtISO']);
    check(['sent', 'received'].includes(peer.direction) && typeof peer.companionId === 'string' && peer.companionId.length === 36 && PEER_ID.test(peer.companionId));
    for (const key of ['name', 'ownerLabel']) { text(peer[key], 80, 320); check(peer[key] === peer[key].trim() && !/[\x00-\x1f\x7f]/.test(peer[key])); }
    check(typeof peer.sentAtISO === 'string' && peer.sentAtISO.length === 24 && Number.isFinite(Date.parse(peer.sentAtISO)) && new Date(peer.sentAtISO).toISOString() === peer.sentAtISO);
    return { id: identifier(selected.id), threadId: identifier(selected.threadId), role: 'peer', text: text(selected.text, 4000, 16000), peer };
  }
  check(!Object.hasOwn(selected, 'peer'));
  check(selected.role === 'user' || selected.role === 'assistant');
  const files = Object.hasOwn(selected, 'attachments') ? array(selected.attachments, 8).map(parseAttachment) : [];
  check(new Set(files.map(file => file.id)).size === files.length && files.every(file => file.direction === (selected.role === 'user' ? 'user' : 'companion')));
  return { id: identifier(selected.id), threadId: identifier(selected.threadId), role: selected.role,
    text: text(selected.text, selected.role === 'user' ? USER_CHARS : ASSISTANT_CHARS, selected.role === 'user' ? USER_BYTES : ASSISTANT_BYTES, selected.role === 'assistant' || files.length > 0),
    ...(Object.hasOwn(selected, 'requestId') ? { requestId: identifier(selected.requestId, true) } : {}),
    ...(Object.hasOwn(selected, 'attachments') ? { attachments: files } : {}),
    ...(Object.hasOwn(selected, 'feeling') ? { feeling: feeling(selected.feeling, selected.role) } : {}) };
}
function turnContext(value) {
  const selected = plain(value, ['requestId', 'state'], ['error']);
  identifier(selected.requestId, true); check(TURN_STATES.includes(selected.state));
  if (!Object.hasOwn(selected, 'error')) return selected;
  check(selected.state === 'error');
  const error = plain(selected.error, ['code', 'message'], ['resetsAt']);
  check(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)); text(error.message, 500, 2000);
  check(!Object.hasOwn(error, 'resetsAt') || (typeof error.resetsAt === 'string' && error.resetsAt.length <= 40 && !Number.isNaN(Date.parse(error.resetsAt))));
  return { ...selected, error };
}
function snapshot(value, requested) {
  const selected = envelope(value, ['threads', 'threadId', 'messages', 'cursor', 'runtime'], ['turn', 'archivedAt']);
  const archivedAt = Object.hasOwn(selected, 'archivedAt') ? selected.archivedAt : null;
  check(archivedAt === null || Number.isSafeInteger(archivedAt) && archivedAt > 0 && selected.threadId !== null);
  const threads = array(selected.threads, 200).map(thread); check(new Set(threads.map(item => item.id)).size === threads.length);
  const sourceMessages = array(selected.messages, 500);
  const runtime = plain(selected.runtime, ['state'], ['provider']);
  if (selected.synthetic) check(runtime.state === 'development-double' && !Object.hasOwn(runtime, 'provider'));
  else check(RUNTIME_STATES.includes(runtime.state) && (!Object.hasOwn(runtime, 'provider') || PROVIDERS.includes(runtime.provider)));
  let turn = null;
  if (Object.hasOwn(selected, 'turn')) {
    check(!selected.synthetic && selected.threadId !== null);
    turn = turnContext(selected.turn);
  }
  const head = cursor(selected.cursor);
  if (selected.threadId === null) check(threads.length === 0 && selected.messages.length === 0 && head === 0 && requested === undefined);
  else { identifier(selected.threadId); check(threads.some(item => item.id === selected.threadId)); }
  check(requested === undefined || requested === selected.threadId);
  const messages = sourceMessages.map(item => message(item, selected.threadId));
  check(new Set(messages.map(item => item.id)).size === messages.length);
  return { synthetic: selected.synthetic, threads, threadId: selected.threadId, archivedAt, messages, cursor: selected.cursor, lastSeq: head,
    runtime: { state: runtime.state, ...(runtime.provider ? { provider: runtime.provider } : {}) }, turn };
}
function eventPage(value, threadId, from) {
  const selected = envelope(value, ['threadId', 'events', 'cursor', 'lastSeq', 'hasMore']);
  check(selected.threadId === threadId, 'RESYNC_REQUIRED');
  check(Number.isSafeInteger(selected.lastSeq) && selected.lastSeq >= 0 && typeof selected.hasMore === 'boolean');
  const events = array(selected.events, 100).map(item => {
    const head = plain(item, ['seq', 'threadId', 'type'], ['message', 'requestId', 'state', 'error']);
    check(Number.isSafeInteger(head.seq) && head.seq >= 1 && head.threadId === threadId, 'RESYNC_REQUIRED');
    if (head.type === 'message') { const exact = plain(item, ['seq', 'threadId', 'type', 'message']); return { ...exact, message: message(exact.message, threadId) }; }
    if (head.type === 'noop') return plain(item, ['seq', 'threadId', 'type']);
    check(head.type === 'turn'); const exact = plain(item, ['seq', 'threadId', 'type', 'requestId', 'state'], ['error']);
    const { requestId, state, error } = exact;
    return { ...exact, ...turnContext({ requestId, state, ...(Object.hasOwn(exact, 'error') ? { error } : {}) }) };
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
    (before.role !== 'user' || (before.text === next.text && sameFiles(before.attachments ?? [], next.attachments ?? []))) &&
    (before.role !== 'peer' || (before.text === next.text && ['direction', 'companionId', 'name', 'ownerLabel', 'sentAtISO'].every(key => before.peer[key] === next.peer[key])))); messages[index] = { ...before, ...next }; }
}
function sameFiles(before, after) {
  return before.length === after.length && before.every(file => after.some(other => file.id === other.id));
}
function confirms(message, pending) {
  if (pending?.action !== 'submit' || message.role !== 'user' || message.requestId !== pending.requestId) return false;
  check(message.text === pending.text && sameFiles(message.attachments ?? [], (pending.attachments ?? []).map(id => ({ id }))));
  return true;
}
const initial = () => ({ opened: false, synthetic: false, runtime: null, threads: [], threadId: null, archivedAt: null, messages: [], cursor: null,
  lastSeq: 0, hasMore: false, turn: null, connection: 'disconnected', pending: null, draft: '', error: null });

// pending is a submit {threadId,text} or createThread {title}, plus stable requestId/status.
// Drafts, pending writes and display data live only in memory. There is no scheduler or automatic resubmission.
export function createConversationClient({ transport = createConversationTransport(), requestId = () => globalThis.crypto.randomUUID() } = {}) {
  let state = initial(), epoch = 0, polling = null, files = new Map();
  const listeners = new Set(), active = new Set(), copy = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) { try { listener(copy()); } catch { /* A view cannot bypass display clearing. */ } } };
  const current = version => version === epoch;
  function begin() { epoch++; for (const controller of active) controller.abort(); active.clear(); polling = null; return epoch; }
  function clear(connection = 'disconnected', error = null) { begin(); files.clear(); state = { ...initial(), connection, error }; emit(); return copy(); }
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
    state = { ...state, connection: uncertain ? (code === 'UNAVAILABLE' ? 'unavailable' : 'reconnecting') : state.opened ? 'ready' : 'unavailable',
      error: code, pending: uncertain && pending ? { ...pending, ...(write ? { status: 'uncertain' } : {}) } : null };
    emit();
  }
  async function load(threadId, version, retained = null) {
    try {
      const received = await call('snapshot', threadId === undefined ? {} : { threadId }, version);
      if (!current(version)) return;
      const data = snapshot(received, threadId);
      let pending = retained;
      const confirmed = data.messages.some(item => confirms(item, pending));
      const draft = confirmed && state.draft === pending.text ? '' : state.draft;
      if (confirmed) pending = null;
      state = { ...state, ...data, opened: true, connection: 'ready', hasMore: false, pending, draft, error: null }; emit();
    } catch (error) { failure(error, version, retained); }
  }
  function nextId() { try { return identifier(requestId(), true, 'INVALID_REQUEST'); } catch { throw new ConversationError('INVALID_REQUEST'); } }
  async function open(options = {}) {
    const selected = plain(options, [], ['threadId'], 'INVALID_REQUEST');
    if (Object.hasOwn(selected, 'threadId')) identifier(selected.threadId, false, 'INVALID_REQUEST');
    const version = begin(); files.clear(); state = { ...initial(), connection: 'loading', threadId: selected.threadId ?? null }; emit();
    await load(selected.threadId, version); return copy();
  }
  // Reload the open thread's snapshot (thread titles, final text) without dropping the draft or a pending action.
  async function refresh() {
    check(state.opened && state.connection !== 'loading' && !polling, 'NOT_READY');
    const version = begin(); await load(state.threadId ?? undefined, version, state.pending); return copy();
  }
  async function submitPending(pending, version) {
    try {
      const payload = pending.action === 'submit' ? { requestId: pending.requestId, threadId: pending.threadId, text: pending.text } :
        ['deleteThread', 'archiveThread'].includes(pending.action) ? { requestId: pending.requestId, threadId: pending.threadId } : { requestId: pending.requestId, title: pending.title };
      if (pending.action === 'submit' && pending.attachments?.length) payload.attachments = [...pending.attachments];
      const received = await call(pending.action, payload, version);
      if (!current(version)) return pending.action === 'submit' ? { status: 'rejected', requestId: pending.requestId, text: pending.text, error: 'NOT_READY' } : undefined;
      if (pending.action === 'deleteThread') {
        const body = envelope(received, ['deletedThreadId', 'requestId']);
        check(body.deletedThreadId === pending.threadId && body.requestId === pending.requestId);
        files.clear(); state = { ...initial(), connection: 'loading' }; emit(); await load(undefined, version); return;
      }
      if (pending.action === 'archiveThread') {
        const body = envelope(received, ['archivedThreadId', 'threadId', 'requestId']);
        check(body.archivedThreadId === pending.threadId && body.requestId === pending.requestId); identifier(body.threadId);
        files.clear(); state = { ...initial(), connection: 'loading', threadId: body.threadId }; emit(); await load(body.threadId, version); return;
      }
      if (pending.action === 'createThread') {
        const body = envelope(received, ['thread']), created = thread(body.thread);
        check(created.title === pending.title);
        state = { ...state, pending: null, threadId: created.id }; emit(); await load(created.id, version); return;
      }
      const body = envelope(received, ['accepted']), accepted = plain(body.accepted, ['requestId', 'threadId', 'messageId']);
      check(accepted.requestId === pending.requestId && accepted.threadId === pending.threadId); identifier(accepted.messageId);
      if (state.pending?.requestId !== pending.requestId) return { status: 'accepted', requestId: pending.requestId, text: pending.text }; // Events may already have completed this turn.
      const messages = [...state.messages];
      const attachments = (pending.attachments ?? []).map(id => files.get(id));
      if (attachments.some(file => !file)) { await load(pending.threadId, version, pending); return { status: 'accepted', requestId: pending.requestId, text: pending.text }; }
      upsert(messages, { id: accepted.messageId, threadId: pending.threadId, role: 'user', text: pending.text, requestId: pending.requestId,
        ...(attachments.length ? { attachments } : {}) });
      state = { ...state, messages, pending: { ...pending, status: 'accepted' }, draft: state.draft === pending.text ? '' : state.draft, connection: 'ready', error: null,
        turn: state.turn?.requestId === pending.requestId ? state.turn : { requestId: pending.requestId, state: 'streaming' } }; emit();
      return { status: 'accepted', requestId: pending.requestId, text: pending.text };
    } catch (error) {
      const code = safeError(error).code;
      if (pending.action === 'submit' && current(version) && state.messages.some(message => confirms(message, pending)) &&
        ['NETWORK_ERROR', 'UNAVAILABLE'].includes(code)) return { status: 'accepted', requestId: pending.requestId, text: pending.text };
      const valid = current(version);
      failure(error, version, pending, true);
      if (pending.action === 'submit') return { status: !valid || ['BUSY', 'CONFLICT', 'INVALID_REQUEST', 'ACCESS_DENIED'].includes(code) ? 'rejected' : 'uncertain',
        requestId: pending.requestId, text: pending.text, error: valid ? code : 'NOT_READY' };
    }
  }
  async function create(title) {
    text(title, 80, 80, false, 'INVALID_REQUEST'); check(!state.pending, 'BUSY'); check(state.opened && state.connection === 'ready', 'NOT_READY');
    const pending = { action: 'createThread', requestId: nextId(), title, status: 'submitting' }, version = begin(); files.clear();
    state = { ...initial(), connection: 'loading', pending }; emit(); await submitPending(pending, version); return copy();
  }
  async function send(value = state.draft, attachments = []) {
    const ids = attachmentIds(attachments);
    text(value, USER_CHARS, USER_BYTES, ids.length > 0, 'INVALID_REQUEST'); check(!state.pending || state.pending.status === 'accepted', 'BUSY');
    check(state.opened && state.connection === 'ready' && state.threadId !== null && state.archivedAt === null, 'NOT_READY');
    const pending = { action: 'submit', requestId: nextId(), threadId: state.threadId, text: value,
      ...(ids.length ? { attachments: [...ids] } : {}), status: 'submitting' }, version = epoch;
    state = { ...state, pending, error: null }; emit(); return submitPending(pending, version);
  }
  async function retry() {
    check(state.pending?.status === 'uncertain', 'NOT_READY');
    const pending = { ...state.pending, status: 'submitting' }, version = epoch;
    state = { ...state, pending, error: null }; emit(); await submitPending(pending, version); return copy();
  }
  async function deleteThread() {
    check(state.opened && !state.synthetic && state.threadId !== null && state.connection === 'ready' && (!state.pending || state.pending.status === 'accepted'), 'NOT_READY');
    const pending = { action: 'deleteThread', requestId: nextId(), threadId: state.threadId, status: 'submitting' }, version = begin();
    state = { ...state, pending, error: null }; emit(); await submitPending(pending, version); return copy();
  }
  // "New chat": the open chat moves to the archive (kept, read-only) and a fresh ongoing chat opens.
  async function archiveThread() {
    check(state.opened && !state.synthetic && state.threadId !== null && state.archivedAt === null && state.connection === 'ready'
      && !state.pending && state.turn?.state !== 'streaming', 'NOT_READY');
    const pending = { action: 'archiveThread', requestId: nextId(), threadId: state.threadId, status: 'submitting' }, version = begin();
    state = { ...state, pending, error: null }; emit(); await submitPending(pending, version); return copy();
  }
  // The owner's archived chats, newest first. Read-only metadata; opening one uses select(threadId).
  async function archivedThreads() {
    const body = envelope(await transport('archivedThreads', {}), ['threads']);
    return array(body.threads, 200).map(item => {
      const row = plain(item, ['id', 'title', 'startedAt', 'archivedAt', 'messages']);
      identifier(row.id); text(row.title, 80, 80);
      check([row.startedAt, row.archivedAt, row.messages].every(value => Number.isSafeInteger(value) && value >= 0));
      return row;
    });
  }
  // Stop the running reply of the open thread. The final turn state arrives as an event.
  async function cancel() {
    const turn = state.turn;
    check(state.opened && !state.synthetic && state.connection === 'ready' && state.threadId !== null && turn?.state === 'streaming', 'NOT_READY');
    const version = epoch, threadId = state.threadId;
    state = { ...state, turn: { ...turn, stopping: true }, error: null }; emit();
    try {
      const received = await call('cancel', { requestId: turn.requestId, threadId }, version);
      if (!current(version)) return copy();
      const body = envelope(received, ['cancel']), result = plain(body.cancel, ['requestId', 'threadId', 'state']);
      check(result.requestId === turn.requestId && result.threadId === threadId &&
        ['stopping', 'cancelled', 'complete', 'error'].includes(result.state));
    } catch (error) {
      if (current(version) && state.turn?.requestId === turn.requestId) { const { stopping, ...rest } = state.turn; state = { ...state, turn: rest }; }
      failure(error, version, state.pending);
    }
    return copy();
  }
  function poll() {
    check(state.opened && state.threadId !== null && state.cursor !== null && state.connection !== 'loading', 'NOT_READY');
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
            if (confirms(event.message, pending)) {
              if (draft === pending.text) draft = ''; pending = { ...pending, status: 'accepted' };
            }
          } else if (event.type === 'turn') { turn = { requestId: event.requestId, state: event.state, ...(event.error ? { error: event.error } : {}) };
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
    cancel, refresh, deleteThread, archiveThread, archivedThreads,
    setFiles(value) {
      check(state.opened && state.threadId !== null && state.connection === 'ready', 'NOT_READY');
      const selected = array(value, 8).map(parseAttachment); check(selected.every(file => file.direction === 'user') && new Set(selected.map(file => file.id)).size === selected.length, 'INVALID_REQUEST');
      files = new Map(selected.map(file => [file.id, file]));
    },
    setDraft(value) { text(value, USER_CHARS, USER_BYTES, true, 'INVALID_REQUEST'); state = { ...state, draft: value }; emit(); return copy(); },
    clear: () => clear(), disconnect: () => clear() });
}
