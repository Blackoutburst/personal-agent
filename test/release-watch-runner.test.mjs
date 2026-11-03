import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BootstrapStore } from '../src/store.mjs';
import { CompanionRunner } from '../src/runner.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import { principalKey } from '../src/provisioning.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function childFor(provider, invocation) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true; invocation.prompt = '';
  child.stdin.on('data', data => { invocation.prompt += data; });
  child.stdin.on('finish', () => queueMicrotask(() => {
    const lines = provider === 'claude'
      ? [{ type: 'system', subtype: 'init', session_id: 'private-release-session' },
        { type: 'result', is_error: false, result: '{"action":"not_yet"}', session_id: 'private-release-session' }]
      : [{ type: 'thread.started', thread_id: 'private-release-session' },
        { type: 'item.completed', item: { type: 'agent_message', text: '{"action":"not_yet"}' } }, { type: 'turn.completed' }];
    child.stdout.end(lines.map(line => JSON.stringify(line)).join('\n') + '\n'); child.emit('close', 0);
  }));
  return child;
}
function overrides(args) {
  const result = new Map();
  for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
    const value = args[++i], equals = value.indexOf('='); result.set(value.slice(0, equals), JSON.parse(value.slice(equals + 1)));
  }
  return result;
}
function fixture(t, provider, tools = []) {
  const dir = mkdtempSync(join(tmpdir(), 'release-watch-runner-')), store = new BootstrapStore(join(dir, 'data'), ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const owners = parseRuntimeConfig(JSON.stringify({ owners: ['alice', 'bob'].map(label => ({ subject: 'release-owner-' + label, label, provider, tools,
    board: { configDir: join(dir, label, 'board'), pythonPath: join(dir, 'python'), connectPath: join(dir, 'connect.py'),
      allowedTools: ['get_work', 'create_ticket', 'post_message'] } })) }));
  const ids = Object.fromEntries(owners.map(owner => [owner.label, store.getOrInsert('companion-identity-v1',
    principalKey({ issuer: owner.issuer, subject: owner.subject }), { companionId: randomUUID() }).companionId]));
  const invocations = [], factories = [];
  const runner = new CompanionRunner({ store, owners, runtimeDir: join(dir, 'runtimes'),
    mcpServersFor(owner) {
      factories.push(owner.label);
      return [{ name: 'scheduler', command: join(dir, 'scheduler'), allowedTools: ['create_schedule', 'cancel_schedule'] },
        { name: 'contacts', command: join(dir, 'contacts'), allowedTools: ['message_companion'] }];
    }, spawnImpl(binary, args, options) {
      const invocation = { binary, args: [...args], cwd: options.cwd, env: { ...options.env } }; invocations.push(invocation);
      return childFor(provider, invocation);
    }
  });
  return { runner, owners, ids, factories, invocations };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: release-only native web override is fresh and forwards no owner/app transports`, async t => {
    const f = fixture(t, provider), before = structuredClone(f.owners);
    await f.runner.turn(f.ids.alice, { prompt: 'normal before', resume: 'normal-owner-session' });
    await f.runner.releaseCheck(f.ids.alice, { prompt: 'release check', systemPrompt: 'Native companion instructions',
      resume: 'must-not-resume', allowedTools: ['Write', 'mcp__board__post_message'],
      appServers: [{ name: 'injected', command: join(tmpdir(), 'injected'), allowedTools: ['write'] }] });
    await f.runner.turn(f.ids.alice, { prompt: 'normal after', resume: 'normal-owner-session' });
    assert.deepEqual(f.factories, ['alice', 'alice']); assert.equal(f.invocations.length, 3);
    const release = f.invocations[1], normal = [f.invocations[0], f.invocations[2]];
    const paths = f.runner.paths(f.owners[0]);
    assert.equal(release.cwd, paths.workspace); assert.equal(release.env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], paths.home);
    assert.ok(!release.args.includes('must-not-resume'));
    assert.ok(!JSON.stringify(release.args).includes('injected')); assert.ok(!JSON.stringify(release.args).includes('mcp__board__'));
    assert.ok(!JSON.stringify(release.args).includes('mcp_servers.'));
    assert.deepEqual(f.owners, before, 'The release override never mutates ordinary owner configuration');
    if (provider === 'claude') {
      assert.equal(release.args[release.args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
      assert.deepEqual(release.args.slice(release.args.indexOf('--allowedTools') + 1), ['WebSearch', 'WebFetch']);
      assert.deepEqual(JSON.parse(release.args[release.args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
      assert.ok(release.args.includes('--strict-mcp-config')); assert.ok(!release.args.includes('--permission-mode'));
      assert.ok(!release.args.includes('--resume')); assert.equal(release.prompt, 'release check');
      for (const call of normal) {
        assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
        assert.ok(call.args.includes('mcp__board__post_message')); assert.ok(call.args.includes('mcp__scheduler__cancel_schedule'));
        assert.ok(call.args.includes('mcp__contacts__message_companion'));
      }
    } else {
      const config = overrides(release.args);
      assert.equal(config.get('web_search'), 'live'); assert.equal(config.get('sandbox_mode'), 'read-only');
      assert.deepEqual([...config.keys()], ['sandbox_mode', 'web_search']);
      assert.deepEqual(release.args.slice(0, 1), ['exec']); assert.ok(!release.args.includes('resume'));
      assert.equal(release.prompt, 'Native companion instructions\n\nrelease check');
      for (const call of normal) {
        const regular = overrides(call.args);
        assert.equal(regular.get('web_search'), 'disabled'); assert.equal(regular.get('sandbox_mode'), 'workspace-write');
        assert.deepEqual(regular.get('mcp_servers.board.enabled_tools'), ['get_work', 'create_ticket', 'post_message']);
        assert.deepEqual(regular.get('mcp_servers.scheduler.enabled_tools'), ['create_schedule', 'cancel_schedule']);
        assert.deepEqual(regular.get('mcp_servers.contacts.enabled_tools'), ['message_companion']);
      }
    }
    assert.ok(!release.args.includes('--dangerously-skip-permissions')); assert.ok(!release.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  test(`${provider}: release checks share the owner lane, select only that owner and do not add a generic turn escape`, async t => {
    const f = fixture(t, provider);
    const order = await Promise.all([
      f.runner.turn(f.ids.alice, { prompt: 'first normal' }),
      f.runner.releaseCheck(f.ids.alice, { prompt: 'middle check' }),
      f.runner.turn(f.ids.alice, { prompt: 'last normal' })
    ]);
    assert.equal(order.length, 3); assert.deepEqual(f.invocations.map(call => call.prompt), ['first normal', 'middle check', 'last normal']);
    await assert.rejects(f.runner.releaseCheck(randomUUID(), { prompt: 'foreign check' }), { code: 'NO_RUNTIME' });
    await assert.rejects(f.runner.turn(f.ids.alice, { prompt: 'ordinary cannot expand web', allowedTools: ['WebSearch', 'WebFetch'], releaseCheck: true }), { code: 'TOOL_POLICY_REFUSED' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.runner.releaseCheck(f.ids.bob, { prompt: 'cancelled check', signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(f.invocations.length, 3); assert.equal(f.runner.queues.size, 0);
  });
}
