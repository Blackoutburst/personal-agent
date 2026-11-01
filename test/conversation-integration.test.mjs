import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { createConversationClient, createConversationTransport } from '../public/conversation-client.mjs';

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'conversation-integration-test-'));
  const apps = [];
  t.after(async () => { for (const app of apps) if (app.server.listening) await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return async mode => { const app = await startServer({ dataDir, port: 0, mode, ...options }); apps.push(app); return app; };
}
function clientFor(target, intercept) {
  const transport = createConversationTransport({ fetchImpl: async (path, options) => {
    const app = target();
    const response = await fetch(new URL(path, app.url + '/'), { ...options,
      headers: { ...options.headers, Origin: app.url, Cookie: '__Secure-blackout_session=' + 's'.repeat(43) } });
    if (intercept) await intercept(JSON.parse(options.body), response);
    return response;
  } });
  return createConversationClient({ transport });
}
async function drain(client) {
  for (let count = 0; count < 10; count++) {
    const state = client.getState();
    if (!state.hasMore && !state.pending) return state;
    await client.poll();
  }
  assert.fail('Synthetic turn did not reconcile within its bounded fixture pages');
}

test('real local HTTP fixture supports two clients, streaming replay and uncertain retry without duplicates', async t => {
  const app = await (await fixture(t))('demo');
  let loseNext = false;
  const submitted = [];
  const a = clientFor(() => app, async payload => {
    if (payload.action !== 'submit') return;
    submitted.push(payload.requestId);
    if (loseNext) { loseNext = false; throw new TypeError('Synthetic lost acknowledgment after commit'); }
  });
  await a.open(); await a.create('Synthetic shared fixture');
  const threadId = a.getState().threadId;
  await a.send('Sample text with https://example.invalid/ and <script>plain text</script>');
  await a.poll();
  assert.equal(a.getState().hasMore, true);
  assert.equal(a.getState().turn.state, 'streaming');
  assert.equal(a.getState().messages[1].text, 'Synthetic reply.');
  await drain(a);
  const b = clientFor(() => app);
  await b.open({ threadId });
  assert.deepEqual(b.getState().messages, a.getState().messages);
  await b.send('A second synthetic device message'); await drain(b);
  await a.poll(); await drain(a);
  assert.deepEqual(a.getState().messages, b.getState().messages, 'Idle client polling joins the same committed stream');
  loseNext = true;
  await a.send('Synthetic retry-safe message');
  const uncertain = a.getState().pending;
  assert.equal(uncertain.status, 'uncertain');
  await a.retry(); await drain(a);
  assert.deepEqual(submitted.slice(-2), [uncertain.requestId, uncertain.requestId]);
  await b.poll(); await drain(b);
  assert.equal(b.getState().messages.length, 6);
  assert.equal(b.getState().messages.filter(message => message.requestId === uncertain.requestId && message.role === 'user').length, 1);
  assert.deepEqual(a.getState().messages, b.getState().messages);
});

test('actual account endpoint denial clears a previously populated client including draft and pending state', async t => {
  const principal = { issuer: 'https://synthetic.invalid', subject: 'synthetic-owner' };
  let validations = 0;
  const open = await fixture(t, { pilotSubjects: [principal], validateAccount: async () => { validations++; return null; } });
  const demo = await open('demo'), account = await open('account');
  let target = demo;
  const client = clientFor(() => target);
  await client.open(); await client.create('Synthetic history'); await client.send('Synthetic only'); await drain(client);
  client.setDraft('Synthetic draft'); assert.equal(client.getState().messages.length, 2);
  target = account;
  await client.poll();
  const state = client.getState();
  assert.equal(state.connection, 'denied'); assert.equal(state.messages.length, 0);
  assert.equal(state.draft, ''); assert.equal(state.pending, null); assert.equal(state.threads.length, 0);
  assert.equal(validations, 1, 'The server revalidated the current synthetic session');
});
