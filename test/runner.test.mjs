import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { ISSUER } from '../src/pilot-config.mjs';
import { CompanionRunner, RunnerError } from '../src/runner.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import * as claude from '../src/providers/claude.mjs';
import * as codex from '../src/providers/codex.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Fake `claude`: records its home/args/prompt, then replays a stream chosen by the prompt.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.CLAUDE_CONFIG_DIR, args = process.argv.slice(2);
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: fs.existsSync(path.join(home, 'signed-in')), subscriptionType: 'pro' }));
  process.exit(0);
}
let prompt = ''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => {
  fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
  const out = v => process.stdout.write(JSON.stringify(v) + '\\n');
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const session = resume || 'sess-' + path.basename(path.dirname(home));
  out({ type: 'system', subtype: 'init', session_id: session });
  if (!fs.existsSync(path.join(home, 'signed-in'))) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: session });
    process.exit(1);
  }
  if (prompt.includes('LIMIT')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1800000000 } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached', session_id: session });
    process.exit(1);
  }
  if (prompt.includes('SLOW')) { setTimeout(() => {}, 60000); return; }
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1800000000 } });
  for (const part of ['Hello ', 'from ', path.basename(path.dirname(home))]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from ' + path.basename(path.dirname(home)), session_id: session, usage: { output_tokens: 3 } });
});
`;

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.CODEX_HOME, args = process.argv.slice(2);
if (args[0] === 'login') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
let prompt = ''; process.stdin.on('data', c => prompt += c); process.stdin.on('end', () => {
  fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ args, prompt }) + '\\n');
  const out = v => process.stdout.write(JSON.stringify(v) + '\\n');
  const resume = args[1] === 'resume' ? args[2] : null;
  out({ type: resume ? 'thread.resumed' : 'thread.started', thread_id: resume || 'thread-1' });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex reply' } });
  out({ type: 'turn.completed', usage: { output_tokens: 2 } });
});
`;

function setup({ providers = { blackout: 'claude', screamer: 'claude' }, signedIn = ['blackout', 'screamer'], timeoutMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-runner-'));
  const bin = join(dir, 'bin');
  const store = new BootstrapStore(join(dir, 'data'), ROOT);
  const fakes = {};
  for (const [name, source] of [['claude', FAKE_CLAUDE], ['codex', FAKE_CODEX]]) {
    const file = join(dir, `fake-${name}.cjs`); writeFileSync(file, source); chmodSync(file, 0o755); fakes[name] = file;
  }
  const owners = parseRuntimeConfig(JSON.stringify({ owners: Object.entries(providers).map(([label, provider]) =>
    ({ subject: `subject-${label}`, label, provider })) }));
  const ids = {};
  for (const owner of owners) {
    ids[owner.label] = store.getOrInsert('companion-identity-v1', principalKey({ issuer: ISSUER, subject: owner.subject }), { companionId: randomUUID() }).companionId;
  }
  const runner = new CompanionRunner({ store, owners, runtimeDir: join(dir, 'runtimes'), binaries: fakes, timeoutMs, statusTtlMs: 0 });
  for (const label of signedIn) {
    const owner = owners.find(o => o.label === label);
    writeFileSync(join(runner.paths(owner).home, 'signed-in'), '');
  }
  const calls = label => {
    const owner = owners.find(o => o.label === label), file = join(runner.paths(owner).home, 'calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  return { dir, store, runner, ids, calls, bin, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('each owner is answered by their own agent home and workspace', async t => {
  const env = setup(); t.after(env.cleanup);
  const deltas = [];
  const reply = await env.runner.turn(env.ids.blackout, { prompt: 'hi', onEvent: e => e.type === 'delta' && deltas.push(e.text) });
  assert.equal(reply.text, 'Hello from blackout');
  assert.equal(reply.sessionId, 'sess-blackout');
  assert.equal(deltas.join(''), 'Hello from blackout');
  assert.equal(reply.rate.status, 'allowed');
  const other = await env.runner.turn(env.ids.screamer, { prompt: 'hi' });
  assert.equal(other.text, 'Hello from screamer');
  assert.equal(env.calls('blackout').length, 1);
  assert.equal(env.calls('screamer').length, 1);
  assert.match(env.calls('blackout')[0].cwd, /runtimes\/blackout\/workspace$/);
});

test('prompt goes through stdin and session resume, system prompt and tools are passed', async t => {
  const env = setup(); t.after(env.cleanup);
  await env.runner.turn(env.ids.blackout, { prompt: 'line one\n"quoted" $HOME', resume: 'sess-42', systemPrompt: 'Be kind.', allowedTools: ['WebSearch'] });
  const [call] = env.calls('blackout');
  assert.equal(call.prompt, 'line one\n"quoted" $HOME');
  assert.deepEqual(call.args.slice(call.args.indexOf('--resume'), call.args.indexOf('--resume') + 2), ['--resume', 'sess-42']);
  assert.ok(call.args.includes('Be kind.'));
  assert.ok(call.args.includes('WebSearch'));
});

test('unknown or foreign companion ids never reach an agent', async t => {
  const env = setup(); t.after(env.cleanup);
  for (const id of [randomUUID(), 'blackout', null, undefined, '../screamer']) {
    await assert.rejects(env.runner.turn(id, { prompt: 'hi' }), e => e instanceof RunnerError && e.code === 'NO_RUNTIME');
  }
  assert.equal(env.calls('blackout').length + env.calls('screamer').length, 0);
  assert.deepEqual(await env.runner.status(randomUUID()), { state: 'unconfigured' });
});

test('signed-out owner gets a clear status and error, without touching the other owner', async t => {
  const env = setup({ signedIn: ['screamer'] }); t.after(env.cleanup);
  assert.equal((await env.runner.status(env.ids.blackout)).state, 'signed-out');
  assert.equal((await env.runner.status(env.ids.screamer)).state, 'ready');
  await assert.rejects(env.runner.turn(env.ids.blackout, { prompt: 'hi' }), e => e.code === 'NOT_SIGNED_IN');
  assert.equal(env.calls('screamer').length, 0);
});

test('usage limit is reported with its reset time and no fallback', async t => {
  const env = setup(); t.after(env.cleanup);
  await assert.rejects(env.runner.turn(env.ids.blackout, { prompt: 'LIMIT' }), e => e.code === 'USAGE_LIMIT' && e.resetsAt === 1800000000);
  assert.equal(env.calls('screamer').length, 0);
});

test('timeout and cancellation stop the agent process', async t => {
  const env = setup({ timeoutMs: 300 }); t.after(env.cleanup);
  await assert.rejects(env.runner.turn(env.ids.blackout, { prompt: 'SLOW' }), e => e.code === 'TIMEOUT');
  const controller = new AbortController();
  env.runner.timeoutMs = 60_000;
  const pending = env.runner.turn(env.ids.screamer, { prompt: 'SLOW', signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, e => e.code === 'CANCELLED');
});

test('turns of one owner are serialized', async t => {
  const env = setup(); t.after(env.cleanup);
  const order = [];
  await Promise.all([1, 2, 3].map(n => env.runner.turn(env.ids.blackout, { prompt: `n${n}` }).then(() => order.push(n))));
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(env.calls('blackout').map(c => c.prompt), ['n1', 'n2', 'n3']);
});

test('missing provider binary is reported', async t => {
  const env = setup(); t.after(env.cleanup);
  env.runner.binaries = { claude: join(env.dir, 'does-not-exist') };
  await assert.rejects(env.runner.turn(env.ids.blackout, { prompt: 'hi' }), e => e.code === 'PROVIDER_MISSING');
  assert.equal((await env.runner.status(env.ids.blackout)).state, 'provider-missing');
});

test('codex owner: exec with CODEX_HOME, resume and agent_message reply', async t => {
  const env = setup({ providers: { blackout: 'claude', screamer: 'codex' } }); t.after(env.cleanup);
  assert.equal((await env.runner.status(env.ids.screamer)).state, 'ready');
  const first = await env.runner.turn(env.ids.screamer, { prompt: 'hi', systemPrompt: 'Persona.' });
  assert.deepEqual([first.text, first.sessionId], ['Codex reply', 'thread-1']);
  const second = await env.runner.turn(env.ids.screamer, { prompt: 'again', resume: first.sessionId });
  assert.equal(second.sessionId, 'thread-1');
  const calls = env.calls('screamer');
  assert.equal(calls[0].prompt, 'Persona.\n\nhi');
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', 'thread-1']);
});

test('runtime config validation', () => {
  assert.throws(() => parseRuntimeConfig('{"owners":[]}'));
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ subject: 'a', label: 'Bad Label', provider: 'claude' }] })));
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ subject: 'a', label: 'a', provider: 'gpt' }] })));
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ subject: 'a', label: 'a', provider: 'claude' }, { subject: 'b', label: 'a', provider: 'codex' }] })));
  assert.equal(parseRuntimeConfig(JSON.stringify({ owners: [{ subject: 'a', label: 'a', provider: 'codex', model: 'gpt-5' }] }))[0].model, 'gpt-5');
});

test('claude parser matches recorded CLI output', () => {
  assert.deepEqual(claude.parseLine('{"type":"system","subtype":"init","session_id":"s1"}'), [{ type: 'session', id: 's1' }]);
  assert.deepEqual(claude.parseLine('{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}')[0].code, 'NOT_SIGNED_IN');
  assert.deepEqual(claude.parseLine('not json'), []);
  assert.deepEqual(codex.parseLine('{"type":"turn.failed","error":{"message":"usage limit reached"}}')[0].code, 'USAGE_LIMIT');
});
