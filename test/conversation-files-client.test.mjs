import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConversationClient, createConversationTransport, createFileTransport, parseAttachment, ConversationError, AttachmentError } from '../public/conversation-client.mjs';

const threadId = randomUUID(), otherThread = randomUUID(), fileId = randomUUID();
const file = (overrides = {}) => ({ id: fileId, name: 'holiday.gif', mime: 'image/gif', size: 12, sha256: 'a'.repeat(64), direction: 'user', url: `/api/files/${fileId}`, ...overrides });
const snapshot = (messages = [], selected = threadId) => ({ version: 1, synthetic: false,
  threads: selected ? [{ id: threadId, title: 'First' }, { id: otherThread, title: 'Second' }] : [],
  threadId: selected, messages, cursor: '0', runtime: { state: 'ready', provider: 'claude' } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const invalid = error => error instanceof ConversationError && ['INVALID_RESPONSE', 'INVALID_REQUEST'].includes(error.code);

test('files-only sends keep uploaded metadata through an exact lost-ACK retry and canonical events', async () => {
  const calls = []; let fail = true, user;
  const client = createConversationClient({ transport: async (action, payload) => {
    calls.push({ action, payload: structuredClone(payload) });
    if (action === 'snapshot') return snapshot();
    if (action === 'submit') {
      user ??= { id: randomUUID(), threadId, role: 'user', text: payload.text, requestId: payload.requestId, attachments: [file()] };
      if (fail) { fail = false; throw new Error('private network detail'); }
      return { version: 1, synthetic: false, accepted: { requestId: payload.requestId, threadId, messageId: user.id } };
    }
    return { version: 1, synthetic: false, threadId, cursor: '3', lastSeq: 3, hasMore: false, events: [
      { seq: 1, threadId, type: 'message', message: user },
      { seq: 2, threadId, type: 'message', message: { id: randomUUID(), threadId, role: 'assistant', text: '', requestId: user.requestId,
        attachments: [file({ direction: 'companion', caption: 'Here it is.' })] } },
      { seq: 3, threadId, type: 'turn', requestId: user.requestId, state: 'complete' }
    ] };
  } });
  await client.open(); const metadata = file(); client.setFiles([metadata]); metadata.name = 'mutated';
  const ids = [fileId]; await client.send('', ids); ids.length = 0;
  assert.equal(client.getState().pending.status, 'uncertain');
  await client.retry();
  const writes = calls.filter(call => call.action === 'submit'); assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].payload, writes[1].payload); assert.deepEqual(writes[0].payload.attachments, [fileId]);
  assert.equal(client.getState().messages[0].attachments[0].name, 'holiday.gif');
  assert.equal(client.getState().messages[0].text, '');
  await client.poll();
  assert.equal(client.getState().messages.length, 2); assert.equal(client.getState().messages[1].attachments[0].caption, 'Here it is.');
  assert.equal(client.getState().pending, null); assert.equal(client.getState().turn.state, 'complete');
  assert.ok(!JSON.stringify(client.getState()).includes('private network detail'));
});

test('unregistered IDs use canonical snapshot metadata and request bounds reject before transport', async () => {
  let writes = 0, user;
  const client = createConversationClient({ transport: async (action, payload) => {
    if (action === 'snapshot') return snapshot(user ? [user] : []);
    writes++; user = { id: randomUUID(), threadId, role: 'user', text: '', requestId: payload.requestId, attachments: [file()] };
    return { version: 1, synthetic: false, accepted: { requestId: payload.requestId, threadId, messageId: user.id } };
  } });
  await client.open();
  for (const ids of [[fileId, fileId], Array.from({ length: 9 }, () => randomUUID()), ['not-a-file'], new Array(1)]) {
    await assert.rejects(client.send('', ids), invalid);
  }
  assert.equal(writes, 0); await client.send('', [fileId]);
  assert.deepEqual(client.getState().messages[0].attachments, [file()]); assert.equal(writes, 1);
});

test('malformed or remote attachment metadata clears the entire private snapshot', async () => {
  for (const bad of [file({ url: 'https://elsewhere.invalid/private.gif' }), file({ url: `/api/files/${randomUUID()}` }),
    file({ name: '../private' }), file({ mime: 'image/svg+xml;script=true' }), file({ size: Infinity }), file({ sha256: 'a' }),
    file({ direction: 'companion' }), { ...file(), owner: 'someone' }]) {
    const client = createConversationClient({ transport: async () => snapshot([{ id: randomUUID(), threadId, role: 'user', text: '', attachments: [bad] }]) });
    await client.open(); const state = client.getState();
    assert.equal(state.connection, 'unavailable'); assert.equal(state.error, 'INVALID_RESPONSE'); assert.deepEqual(state.messages, []);
  }
  assert.equal(parseAttachment(file({ mime: 'application/octet-stream', size: 0 })).size, 0, 'unknown formats remain downloadable');
});

test('a canonical request-ID match with different file IDs never confirms the pending payload', async () => {
  let requestId;
  const client = createConversationClient({ transport: async (action, payload) => {
    if (action === 'submit') { requestId = payload.requestId; throw new Error(); }
    return snapshot(requestId ? [{ id: randomUUID(), threadId, role: 'user', text: '', requestId,
      attachments: [file({ id: otherThread, url: `/api/files/${otherThread}` })] }] : []);
  } });
  await client.open(); await client.send('', [fileId]); await client.refresh();
  assert.equal(client.getState().error, 'INVALID_RESPONSE'); assert.deepEqual(client.getState().messages, []);
});

test('canonical multi-file display ordering may differ without changing the exact retry payload', async () => {
  const second = file({ id: randomUUID() }); second.url = `/api/files/${second.id}`;
  let user;
  const client = createConversationClient({ transport: async (action, payload) => {
    if (action === 'snapshot') return snapshot(user ? [user] : []);
    if (action === 'submit') {
      user = { id: randomUUID(), threadId, role: 'user', text: '', requestId: payload.requestId, attachments: [second, file()] };
      return { version: 1, synthetic: false, accepted: { requestId: payload.requestId, threadId, messageId: user.id } };
    }
    return { version: 1, synthetic: false, threadId, events: [{ seq: 1, threadId, type: 'message', message: user }], cursor: '1', lastSeq: 1, hasMore: false };
  } });
  await client.open(); client.setFiles([file(), second]); await client.send('', [fileId, second.id]);
  assert.deepEqual(client.getState().pending.attachments, [fileId, second.id]); await client.poll();
  assert.equal(client.getState().error, null); assert.deepEqual(client.getState().messages[0].attachments.map(file => file.id), [second.id, fileId]);
});

test('delete retries the exact confirmation request and late responses cannot restore another owner display', async () => {
  const calls = []; let fail = true, deleted = false;
  const client = createConversationClient({ transport: async (action, payload) => {
    calls.push({ action, payload: structuredClone(payload) });
    if (action === 'snapshot') return snapshot([], deleted ? null : threadId);
    deleted = true;
    if (fail) { fail = false; throw new Error(); }
    return { version: 1, synthetic: false, deletedThreadId: threadId, requestId: payload.requestId };
  } });
  await client.open(); await client.deleteThread(); assert.equal(client.getState().pending.status, 'uncertain');
  await client.retry();
  const writes = calls.filter(call => call.action === 'deleteThread'); assert.deepEqual(writes[0], writes[1]);
  assert.equal(client.getState().threadId, null); assert.deepEqual(client.getState().messages, []);

  const late = deferred(); let hold = false;
  const other = createConversationClient({ transport: async (action, payload) => action === 'submit' ? late.promise : snapshot([], hold ? otherThread : threadId) });
  await other.open(); other.setFiles([file()]); const old = other.send('', [fileId]);
  const requestId = other.getState().pending.requestId; hold = true; await other.select(otherThread);
  late.resolve({ version: 1, synthetic: false, accepted: { requestId, threadId, messageId: randomUUID() } }); await old;
  assert.equal(other.getState().threadId, otherThread); assert.deepEqual(other.getState().messages, []);
  other.clear(); assert.deepEqual(other.getState().messages, []);
});

test('conversation transport accepts only the finite attachment/delete schema and sends exact file IDs', async () => {
  const calls = [], transport = createConversationTransport({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{}', { headers: { 'content-type': 'application/json' } });
  } });
  const payload = { threadId, requestId: 'stable.1', text: '', attachments: [fileId] };
  await transport('submit', payload); await transport('deleteThread', { threadId, requestId: 'delete.1' });
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'submit', ...payload });
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.redirect, 'error');
  await assert.rejects(transport('submit', { ...payload, owner: 'someone' }), invalid); assert.equal(calls.length, 2);
});

function xhrFixture() {
  const requests = [];
  class Xhr {
    constructor() { this.upload = {}; this.headers = {}; requests.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    getResponseHeader() { return 'application/json'; }
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
    answer(status, result) { this.status = status; this.responseText = JSON.stringify(result); this.onload(); }
  }
  return { requests, transport: createFileTransport({ xhrFactory: () => new Xhr() }) };
}

test('raw upload reports progress and retries with unchanged thread/key/name/bytes without credentials in URLs', async () => {
  const f = xhrFixture(), original = new File(['GIF89a'], 'café.gif'), progress = [], options = { threadId, requestId: 'stable.upload', onProgress: value => progress.push(value) };
  const first = f.transport.upload(original, options), xhr = f.requests[0];
  xhr.upload.onprogress({ lengthComputable: true, loaded: 3, total: 6 }); xhr.onerror();
  await assert.rejects(first, error => error instanceof AttachmentError && error.code === 'NETWORK_ERROR');
  const second = f.transport.upload(original, options), retried = f.requests[1]; retried.answer(200, { file: file() });
  assert.equal((await second).id, fileId); assert.deepEqual(progress, [50]);
  assert.equal(xhr.url, 'api/files'); assert.equal(xhr.method, 'POST'); assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers['X-File-Name'], 'caf%C3%A9.gif'); assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(xhr.headers, retried.headers); assert.equal(xhr.body, retried.body);
});

test('upload cancellation and cap/quota/session errors stay fixed and never expose server diagnostics', async () => {
  for (const [status, expected] of [[413, 'TOO_LARGE'], [507, 'QUOTA'], [401, 'ACCESS_DENIED'], [403, 'ACCESS_DENIED'], [409, 'CONFLICT']]) {
    const f = xhrFixture(), pending = f.transport.upload(new File([], 'empty.txt'), { threadId, requestId: 'upload' });
    f.requests[0].answer(status, { error: { message: 'private-secret-canary' } });
    await assert.rejects(pending, error => error instanceof AttachmentError && error.code === expected && !error.message.includes('canary'));
  }
  const f = xhrFixture(), controller = new AbortController();
  const pending = f.transport.upload(new File([], 'empty.txt'), { threadId, requestId: 'upload', signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.code === 'CANCELLED');
  f.requests[0].answer(200, { file: file() });
  const quota = xhrFixture(), reserved = quota.transport.upload(new File([], 'empty.txt'), { threadId, requestId: 'upload' });
  quota.requests[0].answer(413, { error: { code: 'FILE_QUOTA', message: 'private' } });
  await assert.rejects(reserved, error => error.code === 'QUOTA' && /storage is full/.test(error.message));
});

test('pending remove uses the exact authenticated endpoint and refuses foreign-session acknowledgements', async () => {
  let sent;
  const transport = createFileTransport({ fetchImpl: async (url, options) => {
    sent = { url, options }; return new Response(JSON.stringify({ removed: true }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(await transport.remove(fileId), true); assert.equal(sent.url, 'api/files/remove');
  assert.deepEqual(JSON.parse(sent.options.body), { id: fileId }); assert.equal(sent.options.credentials, 'same-origin');
  const denied = createFileTransport({ fetchImpl: async () => new Response('', { status: 401 }) });
  await assert.rejects(denied.remove(fileId), error => error.code === 'ACCESS_DENIED');
  const absent = createFileTransport({ fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(absent.remove(fileId), error => error instanceof AttachmentError);
  assert.equal(await absent.remove(fileId, { knownPending: true }), true, 'only an already-known pending upload treats 404 as confirmed absence');
});
