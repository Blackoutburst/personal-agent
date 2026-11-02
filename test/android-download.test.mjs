import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

async function get(app, path) {
  const response = await fetch(app.url + path);
  return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'),
    body: Buffer.from(await response.arrayBuffer()) };
}

test('the Android download is offered only when a valid release is published', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'android-download-'));
  const app = await startServer({ dataDir: dir, port: 0 });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await get(app, '/android.json')).status, 404);
  assert.equal((await get(app, '/companion.apk')).status, 404);

  mkdirSync(join(dir, 'downloads'));
  writeFileSync(join(dir, 'downloads', 'companion-0.3.1.apk'), Buffer.from('PK fake apk'));
  writeFileSync(join(dir, 'downloads', 'android.json'), JSON.stringify({ version: '0.3.1', file: 'companion-0.3.1.apk' }));
  const info = await get(app, '/android.json');
  assert.deepEqual(JSON.parse(info.body), { version: '0.3.1', size: 11 });
  const apk = await get(app, '/companion.apk');
  assert.equal(apk.status, 200);
  assert.equal(apk.type, 'application/vnd.android.package-archive');
  assert.equal(apk.disposition, 'attachment; filename="companion-0.3.1.apk"');
  assert.equal(apk.body.toString(), 'PK fake apk');

  for (const bad of [{ version: '0.3.1', file: '../bootstrap.sqlite' }, { version: 'x', file: 'companion-0.3.1.apk' }, { version: '0.3.1', file: 'missing.apk' }]) {
    writeFileSync(join(dir, 'downloads', 'android.json'), JSON.stringify(bad));
    assert.equal((await get(app, '/companion.apk')).status, 404, JSON.stringify(bad));
  }
});
