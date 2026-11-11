import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const OWNER = 'A'.repeat(43), STRANGER = 'C'.repeat(43), issuer = 'https://synthetic.invalid';
const EXE = Buffer.from('MZ fake installer');

async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-download-')));
  const subjects = [{ issuer, subject: 'a' }];
  const app = await startServer({ dataDir: dir, port: 0, mode: 'account', pilotSubjects: subjects,
    validateAccount: async token => token === OWNER ? subjects[0] : token === STRANGER ? { issuer, subject: 'stranger' } : null,
    discordOptions: { connect: false } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const get = async (path, token = OWNER, method = 'GET') => {
    const r = await fetch(app.url + path, { method, headers: { ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}) } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };
  const publish = info => {
    mkdirSync(join(dir, 'downloads'), { recursive: true });
    writeFileSync(join(dir, 'downloads', 'Companion-Setup-0.2.0-x64.exe'), EXE);
    writeFileSync(join(dir, 'downloads', 'desktop.json'), JSON.stringify(info));
  };
  return { dir, get, publish };
}

test('the desktop download answers 404 to the owner when no build is published', async t => {
  const { get } = await setup(t);
  assert.equal((await get('/api/desktop')).status, 404);
  assert.equal((await get('/api/desktop/download')).status, 404);
});

test('the owner gets version, size, sha256 and the exe', async t => {
  const { get, publish } = await setup(t);
  publish({ version: '0.2.0', file: 'Companion-Setup-0.2.0-x64.exe' });
  const sha256 = createHash('sha256').update(EXE).digest('hex');
  const info = await get('/api/desktop');
  assert.equal(info.status, 200);
  assert.deepEqual(JSON.parse(info.body), { version: '0.2.0', size: EXE.length, sha256 });
  const file = await get('/api/desktop/download');
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-disposition'), 'attachment; filename="Companion-0.2.0.exe"');
  assert.equal(file.headers.get('x-content-sha256'), sha256);
  assert.deepEqual(file.body, EXE);
  assert.equal((await get('/api/desktop/download', OWNER, 'HEAD')).status, 200);
  const q = await get('/api/desktop/download?v=0.3.0&x=1');
  assert.equal(q.status, 200, 'a query string is ignored');
  assert.deepEqual(q.body, EXE);
  assert.equal((await get('/api/desktop?cb=1')).status, 200);
  assert.equal((await get('/api/desktop/download/extra?x=1')).status, 404);
});

test('the desktop download needs the owner, not just any signed-in account', async t => {
  const { get, publish } = await setup(t);
  publish({ version: '0.2.0', file: 'Companion-Setup-0.2.0-x64.exe' });
  for (const path of ['/api/desktop', '/api/desktop/download']) {
    assert.equal((await get(path, null)).status, 401, path + ' anonymous');
    assert.notEqual((await get(path, STRANGER)).status, 200, path + ' stranger');
    assert.equal((await get(path, 'B'.repeat(43))).status >= 400, true, path + ' unknown session');
  }
});

test('an invalid desktop.json publishes nothing', async t => {
  const { get, publish } = await setup(t);
  for (const bad of [{ version: '0.2.0', file: '../bootstrap.sqlite' }, { version: 'x', file: 'Companion-Setup-0.2.0-x64.exe' },
    { version: '0.2.0', file: 'missing.exe' }, { version: '0.2.0', file: 'desktop.json' }]) {
    publish(bad);
    assert.equal((await get('/api/desktop')).status, 404, JSON.stringify(bad));
  }
});

test('the update feed serves latest.yml, the installer and its blockmap to the owner only (#89)', async t => {
  const { dir, get, publish } = await setup(t);
  publish({ version: '0.2.0', file: 'Companion-Setup-0.2.0-x64.exe' });
  const yml = 'version: 0.2.0\npath: Companion-Setup-0.2.0-x64.exe\n', map = Buffer.from('blockmap-bytes');
  writeFileSync(join(dir, 'downloads', 'latest.yml'), yml);
  writeFileSync(join(dir, 'downloads', 'Companion-Setup-0.2.0-x64.exe.blockmap'), map);
  const base = '/api/desktop/update/';
  const l = await get(base + 'latest.yml');
  assert.equal(l.status, 200); assert.equal(l.body.toString(), yml); assert.match(l.headers.get('content-type'), /yaml/);
  assert.deepEqual((await get(base + 'Companion-Setup-0.2.0-x64.exe')).body, EXE);
  assert.deepEqual((await get(base + 'Companion-Setup-0.2.0-x64.exe.blockmap')).body, map);
  assert.equal((await get(base + 'latest.yml', OWNER, 'HEAD')).status, 200);
  for (const name of ['latest.yml', 'Companion-Setup-0.2.0-x64.exe']) {
    assert.equal((await get(base + name, null)).status, 401, name + ' anonymous');
    assert.notEqual((await get(base + name, STRANGER)).status, 200, name + ' stranger');
  }
  for (const name of ['desktop.json', 'other.exe', '..%2Fdesktop.json', 'Companion-Setup-0.1.0-x64.exe']) assert.equal((await get(base + name)).status, 404, name);
  rmSync(join(dir, 'downloads', 'latest.yml'));
  assert.equal((await get(base + 'latest.yml')).status, 404);
});
