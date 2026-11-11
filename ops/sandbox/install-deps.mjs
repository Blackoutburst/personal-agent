#!/usr/bin/env node
// Make `node --test` runnable in an agent worktree (#78): install the pinned npm packages once per lock file into a
// shared folder under the sandbox root, then link <worktree>/node_modules to it. No install scripts, no bin links.
//   node ops/sandbox/install-deps.mjs [--shared-dir DIR]     (run from the worktree)
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argIndex = process.argv.indexOf('--shared-dir');
const sharedBase = argIndex > 0 ? resolve(process.argv[argIndex + 1]) : process.env.COMPANION_AGENT_DEPS_DIR || '/var/lib/cchan-agents/deps';
const key = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
const target = join(sharedBase, key);

if (!existsSync(join(target, 'node_modules'))) {
  const stage = `${target}.stage-${process.pid}`;
  rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(root, f), join(stage, f));
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', env: { ...process.env, NODE_PATH: [process.env.NODE_PATH, '/usr/share/nodejs'].filter(Boolean).join(':') } });
  if (r.status !== 0) { rmSync(stage, { recursive: true, force: true }); console.error('npm ci failed'); process.exit(1); }
  try { renameSync(stage, target); } catch { rmSync(stage, { recursive: true, force: true }); } // lost a race: the other install is fine
}
const link = join(root, 'node_modules');
let present = false; try { lstatSync(link); present = true; } catch { /* none */ }
if (!present) symlinkSync(join(target, 'node_modules'), link, 'dir');
console.log(JSON.stringify({ ok: true, shared: target, link }));
