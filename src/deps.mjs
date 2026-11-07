// Optional npm dependencies (#68, docs/MINECRAFT.md). The web service itself uses Node built-ins only; a feature that
// needs a package (the Minecraft connector needs mineflayer) loads it through here, lazily, so a missing package can
// only switch that feature off and never stops the service.
//
// Where packages are found, in order:
//   1. COMPANION_DEPS_DIR (a directory holding node_modules), when set;
//   2. the release's shared dependency folder <install root>/deps/<sha256 of package-lock.json>, which
//      ops/release.mjs fills with `npm ci` once per lock file (release folders stay Git source only);
//   3. ordinary Node resolution from this checkout (a development `npm ci`).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class DependencyError extends Error {
  constructor(name) { super(`DEPENDENCY_MISSING: ${name}`); this.name = 'DependencyError'; this.code = 'DEPENDENCY_MISSING'; }
}

// The lock-file key shared with ops/release.mjs.
export function lockKey(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function dependencyDirs({ root = ROOT, env = process.env } = {}) {
  const dirs = [];
  if (env.COMPANION_DEPS_DIR) dirs.push(env.COMPANION_DEPS_DIR);
  try {
    // Releases live at <install root>/releases/<sha>; the shared folder is <install root>/deps/<lock key>.
    const shared = join(root, '..', '..', 'deps', lockKey(readFileSync(join(root, 'package-lock.json'))));
    if (existsSync(join(shared, 'node_modules'))) dirs.push(shared);
  } catch { /* no lock file: development only */ }
  dirs.push(root);
  return dirs;
}

// require() a CommonJS package (mineflayer and its plugins are CommonJS) from the first folder that has it.
export function loadPackage(name, options = {}) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(name)) throw new DependencyError(String(name));
  for (const dir of dependencyDirs(options)) {
    try { return createRequire(join(dir, 'package.json'))(name); }
    catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new DependencyError(name);
}
