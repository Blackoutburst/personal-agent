import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const urls = require('../desktop/src/urls.js');
const ws = require('../desktop/src/window-state.js');
const { persistentVersion, KEEP_SECONDS } = require('../desktop/src/cookies.js');

test('companion URL is the live preview and internal', () => {
  assert.equal(urls.COMPANION_URL, 'https://blackoutburst.com/personal-agent-preview/');
  assert.ok(urls.isInternal(urls.COMPANION_URL));
  assert.ok(urls.isInternal('https://blackoutburst.com/account/?app=companion&state=x'));
  assert.ok(urls.isInternal('https://blackoutburst.com/api/account/app/session'));
});

test('other origins, lookalikes and other paths are not internal', () => {
  for (const u of [
    'https://board.blackoutburst.com/?ticket=1', 'https://github.com/x/y',
    'https://blackoutburst.com.evil.test/account/', 'http://blackoutburst.com/account/',
    'https://blackoutburst.com/other', 'https://user:p@blackoutburst.com/account/',
    'javascript:alert(1)', 'not a url', '',
  ]) assert.equal(urls.isInternal(u), false, u);
});

test('only http(s) links without credentials open externally', () => {
  assert.ok(urls.isExternalOpenable('https://github.com/a/b'));
  assert.ok(urls.isExternalOpenable('http://example.org/'));
  for (const u of ['file:///C:/Windows/system32/calc.exe', 'javascript:1', 'ms-msdt:x', 'https://a:b@x.test/', 'nope'])
    assert.equal(urls.isExternalOpenable(u), false, u);
});

const screen = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

test('window state: defaults, min size, bad input', () => {
  assert.deepEqual(ws.sanitize(null, screen), { width: 1100, height: 780, maximized: false });
  const s = ws.sanitize({ width: 10, height: 'x', x: 5, y: 5 }, screen);
  assert.equal(s.width, ws.MIN.width);
  assert.equal(s.height, 780);
});

test('window state: keeps visible position, drops off-screen position', () => {
  const ok = ws.sanitize({ width: 800, height: 600, x: 100, y: 80, maximized: true }, screen);
  assert.deepEqual(ok, { width: 800, height: 600, x: 100, y: 80, maximized: true });
  const off = ws.sanitize({ width: 800, height: 600, x: 5000, y: 80 }, screen);
  assert.equal(off.x, undefined);
});

test('window state: save/load round trip and corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const file = path.join(dir, 'sub', 'state.json');
  ws.save(file, { width: 900, height: 700, x: 10, y: 20, maximized: false });
  assert.deepEqual(ws.load(file, screen), { width: 900, height: 700, x: 10, y: 20, maximized: false });
  fs.writeFileSync(file, '{broken');
  assert.equal(ws.load(file, screen).width, 1100);
  assert.equal(ws.load(path.join(dir, 'missing.json'), screen).height, 780);
});

test('session cookies on the site get an expiry; others and persistent ones do not', () => {
  const base = { name: 's', value: 'v', domain: 'blackoutburst.com', path: '/', secure: true, httpOnly: true, session: true, hostOnly: true };
  const next = persistentVersion(base, urls.SITE, 1000);
  assert.equal(next.expirationDate, 1000 + KEEP_SECONDS);
  assert.equal(next.url, 'https://blackoutburst.com/');
  assert.equal(next.domain, undefined);
  assert.equal(persistentVersion({ ...base, session: false, expirationDate: 5 }, urls.SITE), null);
  assert.equal(persistentVersion({ ...base, domain: 'evil.test' }, urls.SITE), null);
  assert.equal(persistentVersion(null, urls.SITE), null);
});

test('update check: newer server version gives a banner, otherwise nothing (#84)', async () => {
  const { isNewer, checkForUpdate, bannerScript, VERSION_URL } = require('../desktop/src/update.js');
  assert.ok(isNewer('0.1.1', '0.1.0') && isNewer('0.10.0', '0.9.9') && isNewer('1.0.0', '0.99.99'));
  for (const [a, b] of [['0.1.0', '0.1.0'], ['0.0.9', '0.1.0'], ['x', '0.1.0'], [undefined, '0.1.0'], ['0.2.0', 'bad']]) assert.equal(isNewer(a, b), false, `${a} ${b}`);
  const answer = (status, body) => async url => { assert.equal(url, VERSION_URL); return { ok: status === 200, json: async () => body }; };
  assert.deepEqual(await checkForUpdate(answer(200, { version: '0.2.0' }), '0.1.0'), { version: '0.2.0' });
  assert.equal(await checkForUpdate(answer(200, { version: '0.1.0' }), '0.1.0'), null);
  assert.equal(await checkForUpdate(answer(404, {}), '0.1.0'), null);
  assert.equal(await checkForUpdate(async () => { throw new Error('offline'); }, '0.1.0'), null);
  const script = bannerScript({ version: '0.2.0"});alert(1)//' });
  assert.ok(script.includes(JSON.stringify('0.2.0"});alert(1)//')) && script.includes('/api/desktop/download'));
  assert.doesNotThrow(() => new Function(script));
});
