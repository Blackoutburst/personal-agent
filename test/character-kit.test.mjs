import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('the character handbook zip is built from character-kit/ and served from the Look page', async t => {
  const check = spawnSync('python3', [join(ROOT, 'ops/build-character-kit.py'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'character-kit-'));
  const app = await startServer({ dataDir: dir, port: 0 });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = await fetch(app.url + '/character-kit.zip');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, readFileSync(join(ROOT, 'public/character-kit.zip')));
  assert.equal(body.subarray(0, 2).toString(), 'PK');
  const names = body.toString('latin1');
  for (const entry of ['HANDBOOK.md', 'character.json', 'prompts/1-base.txt', 'tools/art.py', 'tools/export.py', 'refs/framing-and-style.png'])
    assert.ok(names.includes('companion-character-kit/' + entry), entry);
  // Only the app's own art ships: no third-party style sheets or design references.
  assert.ok(!/style\.png|design\.(png|jpe?g)|sheet_/.test(names.replace(/framing-and-style\.png/g, '')));
  assert.match(readFileSync(join(ROOT, 'public/index.html'), 'utf8'), /href="character-kit\.zip" download/);
});
