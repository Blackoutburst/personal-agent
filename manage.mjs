#!/usr/bin/env node
// Server admin tool for the per-owner agents.
//   node manage.mjs owners             list configured owners and their agent status
//   node manage.mjs login <label>      run the provider's own sign-in for that owner (run by the owner)
//   node manage.mjs ask <label> <text> send one smoke-test message and stream the reply
// Environment: COMPANION_DATA_DIR, COMPANION_RUNTIME_FILE, COMPANION_RUNTIME_DIR,
// optional COMPANION_CLAUDE_BIN / COMPANION_CODEX_BIN.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from './src/store.mjs';
import { loadRuntimeConfig, companionIdFor } from './src/runtime-config.mjs';
import { CompanionRunner, RunnerError } from './src/runner.mjs';
import * as claude from './src/providers/claude.mjs';
import * as codex from './src/providers/codex.mjs';

const ADAPTERS = { claude, codex };
const ROOT = dirname(fileURLToPath(import.meta.url));

function fail(message) { console.error(message); process.exit(1); }

const [command, label, ...rest] = process.argv.slice(2);
const { COMPANION_DATA_DIR: dataDir, COMPANION_RUNTIME_FILE: runtimeFile, COMPANION_RUNTIME_DIR: runtimeDir } = process.env;
if (!['owners', 'login', 'ask'].includes(command)) fail('Usage: node manage.mjs owners | login <label> | ask <label> <text>');
if (!dataDir || !runtimeFile || !runtimeDir) fail('Set COMPANION_DATA_DIR, COMPANION_RUNTIME_FILE and COMPANION_RUNTIME_DIR.');

const owners = loadRuntimeConfig(runtimeFile);
const store = new BootstrapStore(dataDir, ROOT);
const binaries = { claude: process.env.COMPANION_CLAUDE_BIN || undefined, codex: process.env.COMPANION_CODEX_BIN || undefined };
const runner = new CompanionRunner({ store, owners, runtimeDir, binaries, statusTtlMs: 0 });
const ownerByLabel = () => owners.find(owner => owner.label === label) ?? fail(`Unknown owner "${label}". Configured: ${owners.map(o => o.label).join(', ')}`);

try {
  if (command === 'owners') {
    for (const owner of owners) {
      const companionId = companionIdFor(store, owner);
      const s = await runner.ownerStatus(owner);
      const status = s.state === 'ready' && s.plan ? `ready (${s.plan})` : s.state;
      console.log(`${owner.label.padEnd(16)} ${owner.provider.padEnd(7)} ${status.padEnd(20)} ${companionId ? 'web account linked' : 'not signed in to the web app yet'}`);
    }
  } else if (command === 'login') {
    const owner = ownerByLabel(), { home, workspace } = runner.paths(owner);
    const spec = ADAPTERS[owner.provider].loginCommand({ binary: binaries[owner.provider], home });
    console.log(`Signing in ${owner.label} to ${owner.provider}. Use your own account.`);
    const code = await new Promise(resolve => spawn(spec.binary, spec.args, { cwd: workspace, env: { ...process.env, ...spec.env }, stdio: 'inherit' })
      .on('error', e => { console.error(e.message); resolve(1); }).on('close', resolve));
    process.exitCode = code;
  } else {
    ownerByLabel();
    const text = rest.join(' ').trim() || 'Say hello in one short sentence.';
    const reply = await runner.turnForLabel(label, { prompt: text, onEvent: e => e.type === 'delta' && process.stdout.write(e.text) });
    process.stdout.write('\n');
    console.error(`session ${reply.sessionId}${reply.rate?.status ? `, rate ${reply.rate.status}` : ''}`);
  }
} catch (error) {
  if (error instanceof RunnerError) fail(`\n${error.code}: ${error.message}${error.detail ? ` (${error.detail})` : ''}`);
  throw error;
} finally {
  store.close();
}
