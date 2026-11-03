import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountHttp } from '../src/account-http.mjs';
import { BootstrapStore } from '../src/store.mjs';

// Synthetic loopback HTTP, accounts and cookies only. No deployed identity service is used.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ISSUER = 'https://synthetic.invalid';
const A = 'A'.repeat(43), B = 'B'.repeat(43), C = 'C'.repeat(43);
const PA = { issuer: ISSUER, subject: 'synthetic-owner-a' };
const PB = { issuer: ISSUER, subject: 'synthetic-owner-b' };
const COOKIE = value => `__Secure-blackout_session=${value}`;
const PRIVATE = 'synthetic-private-error-detail';

async function fixture(t, overrides = {}) {
  const tempRoot = realpathSync(tmpdir());
  const dir = mkdtempSync(join(tempRoot, 'account-http-synthetic-'));
  const store = new BootstrapStore(dir, ROOT);
  const calls = [];
  const active = new Map([[A, PA], [B, PB], [C, { issuer: ISSUER, subject: 'uninvited' }]]);
  let origin;
  const handle = createAccountHttp({ store, pilotSubjects: [PA, PB], allowedOrigins: () => new Set([origin]),
    validateAccount: async proof => { calls.push(proof); await new Promise(resolve => setImmediate(resolve)); return active.get(proof) || null; }, ...overrides });
  const server = createServer(async (req, res) => {
    const result = await handle(req);
    res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(result.closeConnection ? { connection: 'close' } : {}) });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    const actual = realpathSync(dir);
    assert.equal(dirname(actual), tempRoot); assert.ok(basename(actual).startsWith('account-http-synthetic-'));
    rmSync(actual, { recursive: true, force: true });
  });
  function send({ cookie = COOKIE(A), body = '{}', headers = {}, rawHeaders, hold = false, method = 'POST' } = {}) {
    return new Promise((resolve, reject) => {
      const req = request(origin + '/api/session', { method, agent: false,
        headers: rawHeaders ? ['Host', new URL(origin).host, ...rawHeaders] : { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => { req.destroy(); try { resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } });
      });
      req.on('error', reject);
      if (hold) { req.flushHeaders(); req.write('{'); }
      else req.end(body);
    });
  }
  return { send, calls, active, store, get origin() { return origin; } };
}

test('concurrent requests preserve two identities and revalidate after revocation', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => f.send({ cookie: COOKIE(index % 2 ? B : A) })));
  const first = responses[0].body.companionId, second = responses[1].body.companionId;
  assert.notEqual(first, second);
  for (const [index, result] of responses.entries()) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { companionId: index % 2 ? second : first, provider: { state: 'unavailable' }, runtime: { state: 'unavailable' } });
    assert.equal(result.headers['set-cookie'], undefined);
    assert.ok(!result.text.includes(PA.subject) && !result.text.includes(PB.subject));
  }
  f.active.delete(A);
  assert.equal((await f.send()).status, 401);
  assert.equal((await f.send({ cookie: COOKIE(B) })).body.companionId, second);
  assert.equal(f.calls.length, 10); assert.equal(f.store.count(), 2);
});

test('exact Origin and fetch-site guards reject forged requests before validation', async t => {
  const f = await fixture(t);
  for (const origin of [undefined, 'null', 'invalid', 'https://attacker.invalid', f.origin + '/']) {
    const rawHeaders = ['Content-Type', 'application/json', 'Cookie', COOKIE(A), ...(origin ? ['Origin', origin] : [])];
    assert.equal((await f.send({ rawHeaders })).body.error.code, 'ORIGIN_REJECTED');
  }
  assert.equal((await f.send({ headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.send({ rawHeaders: ['Origin', f.origin, 'Origin', f.origin, 'Content-Type', 'application/json', 'Cookie', COOKIE(A)] })).status, 403);
  assert.equal(f.calls.length, 0); assert.equal(f.store.count(), 0);
});

test('WebKit "Origin: null" is admitted only together with a browser-set same-origin fetch site', async t => {
  const f = await fixture(t);
  const send = sites => f.send({ rawHeaders: ['Origin', 'null', 'Content-Type', 'application/json', 'Cookie', COOKIE(A),
    ...sites.flatMap(site => ['Sec-Fetch-Site', site])] });
  assert.equal((await send(['same-origin'])).status, 200);
  for (const sites of [[], ['cross-site'], ['same-site'], ['none'], ['same-origin', 'same-origin']]) {
    assert.equal((await send(sites)).body.error.code, 'ORIGIN_REJECTED', JSON.stringify(sites));
  }
});

test('one account per request: a stale duplicate cookie is ignored, two live accounts or malformed values are refused', async t => {
  const f = await fixture(t);
  for (const cookie of [null, 'blackout_session=' + A, COOKIE(A + 'x'), '__Secure-blackout_session="' + A + '"', COOKIE(A) + '; ' + COOKIE(A + 'x')]) {
    assert.equal((await f.send({ cookie })).status, 401);
  }
  assert.deepEqual(f.calls, [], 'Malformed or missing cookies never reach the validator');
  const base = ['Origin', f.origin, 'Content-Type', 'application/json'];
  assert.equal((await f.send({ rawHeaders: [...base, 'Cookie', COOKIE(A), 'Cookie', COOKIE(B)] })).status, 401, 'Two live accounts are ambiguous');
  f.calls.length = 0;
  const only = (await f.send({ cookie: COOKIE(A) })).body.companionId;
  const STALE = 'S'.repeat(43);
  for (const cookie of [COOKIE(STALE) + '; ' + COOKIE(A), COOKIE(A) + '; ' + COOKIE(STALE), COOKIE(A) + '; ' + COOKIE(A)]) {
    const result = await f.send({ cookie });
    assert.equal(result.status, 200); assert.equal(result.body.companionId, only);
  }
  assert.equal((await f.send({ rawHeaders: [...base, 'Cookie', 'unrelated=synthetic', 'Cookie', COOKIE(A) + '; another=ignored'] })).status, 200);
  assert.equal((await f.send({ cookie: [1, 2, 3, 4].map(n => COOKIE(String(n).repeat(43))).join('; ') })).status, 401, 'At most three candidates');
  assert.equal((await f.send({ cookie: COOKIE(STALE) + '; ' + COOKIE(C) })).body.error.code, 'INVITATION_REQUIRED');
  assert.ok(f.calls.every(value => [A, STALE, C].includes(value)), 'The validator receives only cookie values');
});

test('JSON, media type and byte limits reject identity or runtime fields before validation', async t => {
  const f = await fixture(t);
  assert.equal((await f.send({ headers: { 'Content-Type': 'text/plain' } })).status, 415);
  for (const body of ['', 'invalid', 'null', '[]', '1', '{"issuer":"forged","subject":"forged"}', '{"runtimeId":"forged"}', '{"__proto__":{}}', Buffer.from([0xff])]) {
    assert.equal((await f.send({ body })).status, 400);
  }
  const large = await f.send({ body: JSON.stringify({ padding: 'x'.repeat(1100) }) });
  assert.equal(large.status, 413); assert.equal(large.headers.connection, 'close');
  assert.equal(f.calls.length, 0); assert.equal(f.store.count(), 0);
});

test('unfinished body reaches the three-second deadline and closes its connection', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const result = await f.send({ hold: true });
  assert.equal(result.status, 408); assert.equal(result.body.error.code, 'REQUEST_TIMEOUT');
  assert.equal(result.headers.connection, 'close'); assert.equal(f.calls.length, 0);
});

test('invitation, validator and storage errors expose fixed sanitized responses', async t => {
  const invited = await fixture(t);
  assert.equal((await invited.send({ cookie: COOKIE(C) })).status, 403);
  assert.equal(invited.store.count(), 0);
  for (const overrides of [
    { validateAccount: async () => { throw new Error(PRIVATE); } },
    { store: { getOrInsert() { throw new Error(PRIVATE); } } },
    { store: { getOrInsert() { return { companionId: PRIVATE }; } } },
    { allowedOrigins: () => { throw new Error(PRIVATE); } },
  ]) {
    const f = await fixture(t, overrides);
    const result = await f.send();
    assert.equal(result.status, 503); assert.ok(!result.text.includes(PRIVATE));
    assert.deepEqual(Object.keys(result.body), ['error']);
  }
});
