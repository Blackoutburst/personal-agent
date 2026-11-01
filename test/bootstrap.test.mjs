import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { startServer } from '../server.mjs';
import { BootstrapStore } from '../src/store.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cleanup = new WeakMap();
function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), 'personal-agent-test-'));
  const resources = []; cleanup.set(t, resources);
  t.after(async () => {
    for (const resource of resources.reverse()) if (resource.server.listening) await resource.close();
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
function closeAfter(t, app) { cleanup.get(t).push(app); }

function get(app, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(app.url + path, options, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: res.headers['content-type']?.includes('application/json') && text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end();
  });
}

test('default mode exposes no identity, synthetic data, credentials or activation', async t => {
  const dir = workspace(t);
  const app = await startServer({ dataDir: dir, port: 0 });
  closeAfter(t, app);
  assert.equal(app.server.address().address, '127.0.0.1');
  const status = await get(app, '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.service.mode, 'unavailable');
  assert.ok(Object.values(status.json.adapters).every(adapter => adapter.state === 'unavailable'));
  assert.equal(app.store.count(), 0);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.headers['access-control-allow-origin'], undefined);
  assert.ok(!status.text.includes(dir));
  assert.equal((await get(app, '/api/contract-preview')).status, 503);
  assert.equal((await get(app, '/api/contract-preview?mode=demo')).status, 404);
  assert.equal((await get(app, '/api/contract-preview', { headers: { cookie: 'mode=demo', 'x-mode': 'demo' } })).status, 503);
  assert.equal((await get(app, '/api/login', { method: 'POST' })).status, 405);
  assert.equal((await get(app, '/api/activate', { method: 'POST' })).status, 405);
  assert.equal(app.store.count(), 0);
});

test('explicit demo persists only its synthetic fixture and has zero external effects', async t => {
  const dir = workspace(t);
  const app = await startServer({ dataDir: dir, mode: 'demo', port: 0 });
  closeAfter(t, app);
  const preview = await get(app, '/api/contract-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.json.synthetic, true);
  assert.equal(preview.json.account.subject, 'demo-subject');
  assert.deepEqual(preview.json.effects, { externalCalls: 0, claims: 0, modelCalls: 0 });
  assert.equal(preview.json.runtime.state, 'unavailable');
  assert.equal((await get(app, '/api/status')).json.adapters.provider.state, 'unavailable');
  assert.equal(app.store.count(), 1);
  const record = app.store.get('development', 'contract-preview');
  await app.close();
  // The same store in default mode does not expose its development record.
  const unavailable = await startServer({ dataDir: dir, port: 0 });
  closeAfter(t, unavailable);
  assert.deepEqual(unavailable.store.get('development', 'contract-preview'), record);
  assert.equal((await get(unavailable, '/api/contract-preview')).status, 503);
});

test('HTTP host/origin, exact routes, methods and static allowlist hold', async t => {
  const app = await startServer({ dataDir: workspace(t), mode: 'demo', port: 0 });
  closeAfter(t, app);
  assert.equal((await get(app, '/api/status', { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await get(app, '/api/status', { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await get(app, '/api/status', { headers: { origin: app.url } })).status, 200);
  assert.equal((await get(app, '/api/status', { headers: { 'x-forwarded-host': 'attacker.example' } })).status, 200);
  assert.equal((await get(app, '/api/status', { method: 'PUT' })).status, 405);
  assert.equal((await get(app, '/unknown')).status, 404);
  assert.equal((await get(app, '/%2e%2e/server.mjs')).status, 404);
  assert.equal((await get(app, '/bootstrap.sqlite')).status, 404);
  for (const path of ['/', '/app.js', '/styles.css']) assert.equal((await get(app, path)).status, 200);
  const head = await get(app, '/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
});

test('configuration refuses missing/relative/source paths and unknown modes before creating a database', async t => {
  assert.throws(() => new BootstrapStore(undefined, ROOT), /absolute/);
  assert.throws(() => new BootstrapStore('relative', ROOT), /absolute/);
  const inside = join(ROOT, 'rejected-private-data');
  assert.throws(() => new BootstrapStore(inside, ROOT), /outside/);
  assert.equal(existsSync(inside), false);
  const dir = workspace(t);
  await assert.rejects(startServer({ dataDir: dir, mode: 'production' }), /MODE/);
  assert.equal(existsSync(join(dir, 'bootstrap.sqlite')), false);
  // A similarly prefixed sibling directory is external, not a child.
  const source = join(dir, 'source'); mkdirSync(source);
  const sibling = new BootstrapStore(join(dir, 'source-private'), source); sibling.close();
});

test('data directory junctions into source are rejected', t => {
  const dir = workspace(t);
  const source = join(dir, 'source'); mkdirSync(source);
  const link = join(dir, 'data-link');
  try { symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) return t.skip('Filesystem does not allow directory links'); throw error; }
  assert.throws(() => new BootstrapStore(join(link, 'nested'), source), /inside/);
  assert.equal(existsSync(join(source, 'nested')), false);
});

test('an absent Windows drive is rejected promptly instead of looping', t => {
  if (process.platform !== 'win32') return t.skip('Windows drive-root regression');
  const absent = [...'ZYXWVUTSRQPONMLKJIHGFED'].find(letter => !existsSync(`${letter}:\\`));
  if (!absent) return t.skip('No absent drive available');
  const result = spawnSync(process.execPath, ['server.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 2000,
    env: { ...process.env, COMPANION_DATA_DIR: `${absent}:\\companion-test`, COMPANION_MODE: 'unavailable' }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /filesystem root is unavailable/);
});

test('unsupported schema fails closed without rewriting existing bytes', t => {
  const dir = workspace(t); const filename = join(dir, 'bootstrap.sqlite');
  const db = new DatabaseSync(filename); db.exec('PRAGMA application_id=1346454321; PRAGMA user_version=99; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'keep\');'); db.close();
  if (process.platform !== 'win32') chmodSync(filename, 0o600);
  const original = readFileSync(filename);
  assert.throws(() => new BootstrapStore(dir, ROOT), /Unsupported/);
  assert.deepEqual(readFileSync(filename), original);
});
