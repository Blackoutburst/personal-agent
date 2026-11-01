import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const ID = '11111111-1111-4111-8111-111111111111';
const SESSION = { companionId: ID, provider: { state: 'unavailable' }, runtime: { state: 'unavailable' } };
const PROMPT = 'Check your current platform sign-in to continue.';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    fire(type) { return (listeners.get(type) || []).map(handler => handler({ type })); },
  };
}

async function client(mode = 'account') {
  const ids = ['preview-button', 'preview-status', 'preview-result', 'account-button', 'account-status',
    'companion-identity', 'account-panel', 'demo-badge', 'connection-notice', 'foundation-notice',
    'storage-state', 'service-version', 'preview-json', 'preview-message'];
  const elements = new Map(ids.map(id => [`#${id}`, { ...eventTarget(), textContent: '', hidden: true, disabled: false, dataset: {} }]));
  elements.get('#account-status').textContent = PROMPT;
  const cards = ['account', 'board', 'provider', 'runtime'].map(name => {
    const children = new Map([['.state', { textContent: '', dataset: {} }], ['.adapter-reason', { textContent: '' }]]);
    return { dataset: { adapter: name }, querySelector(selector) { assert.ok(children.has(selector)); return children.get(selector); } };
  });
  const document = { ...eventTarget(), visibilityState: 'visible',
    querySelector(selector) { assert.ok(elements.has(selector), `Unknown synthetic DOM selector ${selector}`); return elements.get(selector); },
    querySelectorAll(selector) { assert.equal(selector, '[data-adapter]'); return cards; },
  };
  const window = eventTarget();
  const calls = [];
  const pending = [];
  const timers = new Set();
  const response = (body, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body });
  runInNewContext(APP, {
    document, window, AbortController,
    // Timers are tracked without wall-clock waits; these tests exercise lifecycle races.
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    fetch(path, options) {
      calls.push({ path, options });
      if (path === 'api/status') return Promise.resolve(response({ service: { mode, name: 'Synthetic foundation', version: 'test' },
        adapters: Object.fromEntries(['account', 'board', 'provider', 'runtime'].map(name => [name, { state: 'unavailable', reason: 'Synthetic status' }])),
        storage: { state: 'ready', mode: 'synthetic' } }));
      assert.equal(path, 'api/session', 'Unexpected fetch must not reach a real service');
      return new Promise(resolve => pending.push({ resolve, options }));
    },
  }, { filename: 'public/app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return {
    document, window, calls, pending, timers,
    element(id) { return elements.get('#' + id); },
    click() { return elements.get('#account-button').fire('click')[0]; },
    settle(index, body = SESSION, ok = true) { pending[index].resolve(response(body, ok)); },
    visible(state) { document.visibilityState = state; document.fire('visibilitychange'); },
  };
}

function assertCleared(c) {
  assert.equal(c.element('companion-identity').hidden, true);
  assert.equal(c.element('companion-identity').textContent, '');
  assert.equal(c.element('account-status').textContent, PROMPT);
}

test('a hidden then visible tab cannot restore identity from a previous in-flight request', async () => {
  const c = await client();
  assert.equal(c.element('account-panel').hidden, false);
  const old = c.click();
  assert.equal(c.pending.length, 1);
  c.visible('hidden');
  assertCleared(c);
  c.visible('visible');
  c.settle(0);
  await old;
  assertCleared(c); // Visibility is visible again: only epoch invalidation rejects this result.
  assert.equal(c.element('account-button').disabled, false);
  const fresh = c.click();
  c.settle(1);
  await fresh;
  assert.equal(c.element('companion-identity').textContent, `Companion ${ID}`);
  assert.equal(c.element('companion-identity').hidden, false);
  assert.match(c.element('account-status').textContent, /account is verified/);
  assert.equal(c.timers.size, 0);
});

test('pageshow invalidates both late success and late denial status', async () => {
  for (const ok of [true, false]) {
    const c = await client();
    const old = c.click();
    c.window.fire('pageshow');
    assertCleared(c);
    c.settle(0, ok ? SESSION : { error: { message: 'Synthetic stale denial must not replace the new page state.' } }, ok);
    await old;
    assertCleared(c);
    assert.equal(c.timers.size, 0);
  }
});

test('a denied next check clears the old identity before and after the response', async () => {
  const c = await client();
  const first = c.click(); c.settle(0); await first;
  assert.equal(c.element('companion-identity').hidden, false);
  const next = c.click();
  assert.equal(c.element('companion-identity').hidden, true);
  assert.equal(c.element('companion-identity').textContent, '');
  assert.doesNotMatch(c.element('account-status').textContent, /account is verified/);
  c.settle(1, { error: { message: 'Synthetic session revoked.' } }, false);
  await next;
  assert.equal(c.element('companion-identity').hidden, true);
  assert.equal(c.element('companion-identity').textContent, '');
  assert.equal(c.element('account-status').textContent, 'Synthetic session revoked.');
  for (const { options } of c.pending) {
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
  }
});

test('pagehide aborts pending fetches and a delayed completion cannot restore the display', async () => {
  const c = await client();
  const old = c.click();
  c.window.fire('pagehide');
  assert.equal(c.pending[0].options.signal.aborted, true);
  c.window.fire('pageshow');
  // The synthetic fetch deliberately ignores abort, modeling an already completing response.
  c.settle(0);
  await old;
  assertCleared(c);
});

test('demo and unavailable modes keep the account panel hidden and perform no account check', async () => {
  for (const mode of ['demo', 'unavailable']) {
    const c = await client(mode);
    assert.equal(c.element('account-panel').hidden, true);
    assert.equal(c.element('demo-badge').hidden, mode !== 'demo');
    assert.equal(c.element('preview-button').disabled, mode !== 'demo');
    assert.equal(c.calls.length, 1); assert.equal(c.calls[0].path, 'api/status');
    assertCleared(c);
  }
});
