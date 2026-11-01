import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { createAccountValidator } from '../src/account-validator.mjs';

const issuer = 'https://blackoutburst.com';
const proofA = 'A'.repeat(43), proofB = 'B'.repeat(43), proofC = 'C'.repeat(43);
const pilotSubjects = [{ issuer, subject: 'synthetic-owner-a' }, { issuer, subject: 'synthetic-owner-b' }];
function call(app, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(app.url + path, { method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text,
        json: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body);
  });
}
function session(app, proof, overrides = {}) {
  return call(app, '/api/session', { method: 'POST', body: '{}',
    headers: { origin: app.url, 'content-type': 'application/json', cookie: `__Secure-blackout_session=${proof}` }, ...overrides });
}
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-integration-'));
  const app = await startServer({ dataDir: dir, port: 0, ...options });
  t.after(async () => { await app.close(); rmSync(dir, { force: true, recursive: true }); });
  return app;
}

test('account mode composes fresh HTTP authority, pilot admission and stable companion provisioning', async t => {
  const sessions = new Map([[proofA, 'synthetic-owner-a'], [proofB, 'synthetic-owner-b'], [proofC, 'synthetic-outsider']]);
  let requests = 0, fail = false;
  const authority = createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/internal/account/session');
    assert.equal(req.method, 'GET');
    const proof = req.headers.cookie?.slice('__Secure-blackout_session='.length);
    const subject = sessions.get(proof);
    res.writeHead(fail ? 503 : subject ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(fail ? { error: 'account_validation_unavailable' } : subject ? { user: { id: subject, username: 'synthetic' } } : { error: 'authentication_required' }));
  });
  await new Promise(resolve => authority.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => authority.close(resolve)));
  const validateAccount = createAccountValidator({ endpoint: `http://127.0.0.1:${authority.address().port}/internal/account/session` });
  const app = await fixture(t, { mode: 'account', pilotSubjects, validateAccount });
  const status = await call(app, '/api/status');
  assert.equal(status.json.adapters.account.state, 'configured');
  assert.equal(status.json.adapters.provider.state, 'unavailable');
  assert.equal(requests, 0);
  const results = await Promise.all(Array.from({ length: 6 }, () => session(app, proofA)));
  assert.ok(results.every(result => result.status === 200));
  const own = results[0].json.companionId;
  assert.ok(results.every(result => result.json.companionId === own));
  const other = await session(app, proofB);
  assert.equal(other.status, 200);
  assert.notEqual(other.json.companionId, own);
  assert.deepEqual(Object.keys(other.json).sort(), ['companionId', 'provider', 'runtime']);
  assert.equal(other.headers['cache-control'], 'no-store');
  assert.equal(other.headers['set-cookie'], undefined);
  assert.equal(other.headers['access-control-allow-origin'], undefined);
  assert.equal(app.store.count(), 2);
  assert.equal((await session(app, proofC)).status, 403);
  sessions.delete(proofA);
  assert.equal((await session(app, proofA)).status, 401);
  assert.equal((await session(app, proofB)).json.companionId, other.json.companionId);
  fail = true;
  const unavailable = await session(app, proofB);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.companionId, undefined);
  assert.equal(app.store.count(), 2);
  assert.equal(requests, 11);
});

test('trusted proxy origin is explicit; forwarded headers and runtime selectors confer no access', async t => {
  let validations = 0;
  const app = await fixture(t, { mode: 'account', publicOrigin: 'https://blackoutburst.com', pilotSubjects,
    validateAccount: async () => { validations++; return pilotSubjects[0]; } });
  assert.equal((await session(app, proofA)).status, 403);
  assert.equal((await session(app, proofA, { headers: { origin: 'https://attacker.example', 'x-forwarded-host': 'blackoutburst.com' } })).status, 403);
  const headers = { origin: 'https://blackoutburst.com', 'content-type': 'application/json', cookie: `__Secure-blackout_session=${proofA}` };
  assert.equal((await session(app, proofA, { headers, body: '{"runtimeId":"other-owner"}' })).status, 400);
  assert.equal(validations, 0);
  assert.equal((await session(app, proofA, { headers })).status, 200);
  assert.equal(validations, 1);
  assert.equal((await call(app, '/api/session?runtimeId=other', { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await call(app, '/api/runtime/register', { method: 'POST', headers, body: '{}' })).status, 405);
  assert.equal((await call(app, '/api/session', { headers })).status, 404);
});

test('unavailable/demo ignore real-account startup injections and have no session endpoint', async t => {
  let validations = 0;
  for (const mode of ['unavailable', 'demo']) {
    const app = await fixture(t, { mode, pilotFile: 'does-not-exist', pilotSubjects,
      validateAccount: async () => { validations++; return pilotSubjects[0]; } });
    assert.equal((await session(app, proofA)).status, 405);
    assert.equal((await call(app, '/api/status')).json.adapters.provider.state, 'unavailable');
    assert.equal((await call(app, '/')).status, 200);
  }
  assert.equal(validations, 0);
});

test('account startup refuses absent pilot admission and malformed public-origin configuration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(startServer({ dataDir: dir, mode: 'account', port: 0 }));
  for (const publicOrigin of ['http://blackoutburst.com', 'https://blackoutburst.com/', 'https://user@blackoutburst.com', 'https://blackoutburst.com/path', 'null']) {
    await assert.rejects(startServer({ dataDir: dir, publicOrigin, port: 0 }), /PUBLIC_ORIGIN/);
  }
});
