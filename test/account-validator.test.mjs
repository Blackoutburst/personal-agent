import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import { createAccountValidator } from '../src/account-validator.mjs';
import { CompanionAccessError, createCompanionProvisioner } from '../src/provisioning.mjs';

// All accounts, cookies and servers in this file are synthetic; no deployed service is contacted.
const COOKIE_A = 'A'.repeat(43);
const COOKIE_B = 'B'.repeat(43);
const ISSUER = 'https://blackoutburst.com';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const PRIVATE = 'synthetic-private-detail-never-return';

async function fixture(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    req.resume(); handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, endpoint: `http://127.0.0.1:${server.address().port}/internal/account/session` };
}

async function closed(operation) {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof CompanionAccessError);
    assert.equal(error.code, 'ACCOUNT_VALIDATION_UNAVAILABLE');
    assert.equal(error.cause, undefined);
    assert.ok(!inspect(error, { depth: 5 }).includes(PRIVATE));
    return true;
  });
}

test('trusted endpoint configuration is literal loopback with one exact path', () => {
  assert.equal(typeof createAccountValidator(), 'function');
  assert.equal(typeof createAccountValidator({ endpoint: 'http://[::1]:9011/internal/account/session' }), 'function');
  for (const endpoint of [
    'http://localhost:9011/internal/account/session', 'https://127.0.0.1:9011/internal/account/session',
    'http://192.0.2.1:9011/internal/account/session', 'http://2130706433:9011/internal/account/session',
    `http://user:${PRIVATE}@127.0.0.1:9011/internal/account/session`,
    'http://127.0.0.1:9011/other', `http://127.0.0.1:9011/internal/account/session?q=${PRIVATE}`,
    `http://127.0.0.1:9011/internal/account/session#${PRIVATE}`, 'http://127.0.0.1:65536/internal/account/session',
  ]) assert.throws(() => createAccountValidator({ endpoint }), error => error.code === 'ACCOUNT_VALIDATION_UNAVAILABLE' && !inspect(error).includes(PRIVATE));
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxBodyBytes: 0 }, { maxBodyBytes: 65_537 }, { issuer: '' }]) {
    assert.throws(() => createAccountValidator(options), { code: 'ACCOUNT_VALIDATION_UNAVAILABLE' });
  }
});

test('absent, forged and raw-header proofs are rejected before network access', async t => {
  const f = await fixture(t, (_, res) => { res.end('{}'); });
  const validate = createAccountValidator({ endpoint: f.endpoint });
  for (const proof of [undefined, null, '', 12, COOKIE_A + 'x', 'A'.repeat(42), `${COOKIE_A}\r\nX-User: forged`,
    `__Secure-blackout_session=${COOKIE_A}`, { cookie: COOKIE_A }, { issuer: ISSUER, subject: ID_A }, new String(COOKIE_A)]) {
    assert.equal(await validate(proof), null);
  }
  assert.equal(f.calls.length, 0);
});

test('each lookup validates the selected cookie and returns only the exact principal', async t => {
  let active = true;
  const f = await fixture(t, (req, res) => {
    if (!active) { res.writeHead(401); return res.end(JSON.stringify({ private: PRIVATE })); }
    const id = req.headers.cookie === `__Secure-blackout_session=${COOKIE_A}` ? ID_A : ID_B;
    res.end(JSON.stringify({ user: { id, email: PRIVATE, username: 'Synthetic', role: 'user', fileBrowserId: '7' }, ignored: PRIVATE }));
  });
  const validate = createAccountValidator({ endpoint: f.endpoint });
  assert.deepEqual(await validate(COOKIE_A), { issuer: ISSUER, subject: ID_A });
  assert.deepEqual(await validate(COOKIE_B), { issuer: ISSUER, subject: ID_B });
  active = false;
  assert.equal(await validate(COOKIE_A), null);
  assert.equal(f.calls.length, 3, 'A prior success must not cache identity or hide revocation');
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.method, 'GET'); assert.equal(call.url, '/internal/account/session');
    assert.equal(call.headers.cookie, `__Secure-blackout_session=${index === 1 ? COOKIE_B : COOKIE_A}`);
    assert.equal(call.headers.authorization, undefined); assert.equal(call.headers['x-user-id'], undefined);
    assert.equal(call.headers['content-length'], undefined);
    assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'connection', 'cookie', 'host']);
  }
});

test('redirects are refused rather than followed', async t => {
  const f = await fixture(t, (req, res) => { res.writeHead(302, { Location: `http://${req.headers.host}/redirect-target` }); res.end(PRIVATE); });
  await closed(() => createAccountValidator({ endpoint: f.endpoint })(COOKIE_A));
  assert.equal(f.calls.length, 1);
});

test('malformed responses, oversized bodies and invalid subjects fail without private details', async t => {
  let response;
  const f = await fixture(t, (_, res) => { res.writeHead(response.status ?? 200); res.end(response.bytes ?? response.body); });
  const validate = createAccountValidator({ endpoint: f.endpoint, maxBodyBytes: 4096 });
  for (response of [
    { status: 500, body: PRIVATE }, { status: 204, body: '' }, { body: `{"private":"${PRIVATE}"` },
    { body: 'null' }, { body: '[]' }, { body: '{}' }, { body: '{"user":null}' }, { body: '{"user":[]}' },
    ...[null, 42, '', '\ud800', 'x'.repeat(2049)].map(id => ({ body: JSON.stringify({ user: { id }, private: PRIVATE }) })),
    { body: JSON.stringify({ user: { id: ID_A }, private: PRIVATE.repeat(200) }) },
    { bytes: Buffer.from([0x7b, 0xff, 0x7d]) },
  ]) await closed(() => validate(COOKIE_A));
  response = { body: JSON.stringify({ user: { id: '  opaque/é:subject  ' } }) };
  assert.deepEqual(await validate(COOKIE_A), { issuer: ISSUER, subject: '  opaque/é:subject  ' });
});

test('total deadline and transport failure close without leaking diagnostics', { timeout: 1500 }, async t => {
  let disconnect = false;
  const f = await fixture(t, (req, res) => {
    if (disconnect) return req.socket.destroy();
    res.writeHead(200); res.write('{');
    const drip = setInterval(() => res.write(' '), 10); // Traffic must not extend the total deadline.
    res.once('close', () => clearInterval(drip));
  });
  const validate = createAccountValidator({ endpoint: f.endpoint, timeoutMs: 50 });
  await closed(() => validate(COOKIE_A));
  disconnect = true;
  await closed(() => validate(COOKIE_A));
  assert.equal(f.calls.length, 2);
});

test('synthetic adapter/provisioner integration denies revoked sessions while retaining identity', async t => {
  let active = true;
  const f = await fixture(t, (_, res) => { res.writeHead(active ? 200 : 401); res.end(JSON.stringify(active ? { user: { id: ID_A } } : {})); });
  const records = new Map();
  const store = { getOrInsert(namespace, key, value) { const id = `${namespace}/${key}`; if (!records.has(id)) records.set(id, value); return records.get(id); } };
  const run = createCompanionProvisioner({ store, validateAccount: createAccountValidator({ endpoint: f.endpoint }), pilotSubjects: [{ issuer: ISSUER, subject: ID_A }] });
  const first = await run(COOKIE_A);
  active = false;
  await assert.rejects(() => run(COOKIE_A), { code: 'AUTHENTICATION_REQUIRED' });
  assert.equal(records.size, 1);
  active = true;
  assert.deepEqual(await run(COOKIE_A), first);
  assert.equal(f.calls.length, 3);
});
