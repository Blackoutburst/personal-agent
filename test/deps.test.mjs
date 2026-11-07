import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackage, lockKey, dependencyDirs, DependencyError } from '../src/deps.mjs';

test('optional packages load from the release\'s shared deps folder, else fail as DEPENDENCY_MISSING (#68)', t => {
  const base = mkdtempSync(join(tmpdir(), 'deps-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'releases', 'a'.repeat(40)), lock = '{"lockfileVersion":3,"packages":{}}';
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'package-lock.json'), lock);
  assert.throws(() => loadPackage('synthetic-pkg-68', { root, env: {} }), error => error instanceof DependencyError && error.code === 'DEPENDENCY_MISSING');
  const shared = join(base, 'deps', lockKey(Buffer.from(lock)), 'node_modules', 'synthetic-pkg-68');
  mkdirSync(shared, { recursive: true }); writeFileSync(join(shared, 'index.js'), 'module.exports = { from: "shared" };');
  assert.deepEqual(loadPackage('synthetic-pkg-68', { root, env: {} }), { from: 'shared' });
  assert.equal(dependencyDirs({ root, env: { COMPANION_DEPS_DIR: '/x' } })[0], '/x');
  assert.throws(() => loadPackage('../escape', { root, env: {} }), DependencyError);
});
