import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { CompanionRunner, RunnerError } from '../src/runner.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import { narrowToolPolicy } from '../src/tool-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = ['WebSearch', 'WebFetch'];
const FILES = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

function setup(t, provider, { board = true, apps = true, tools, factory, boardTools } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-tool-runner-'));
  const store = new BootstrapStore(join(dir, 'data'), ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const binaries = {};
  for (const name of ['claude', 'codex']) {
    binaries[name] = join(dir, `fake-${name}.cjs`);
    // Keep the upstream fixtures unchanged. The spawn wrapper records launch
    // options; only these local fake programs can be executed by this harness.
    writeFileSync(binaries[name], readFileSync(join(ROOT, `test/fixtures/fake-${name}.cjs.txt`)));
  }
  const owners = parseRuntimeConfig(JSON.stringify({ owners: ['alice', 'bob'].map(label => ({
    subject: `tool-owner-${label}`, label, provider,
    tools: tools ?? (provider === 'claude' ? [...FILES, ...WEB] : WEB),
    ...(board ? { board: { configDir: join(dir, label, 'board-config'),
      pythonPath: join(dir, 'board-python'), connectPath: join(dir, 'connect.py'),
      allowedTools: boardTools?.[label] ?? ['get_work', 'list_projects'] } } : {})
  })) }));
  const descriptors = Object.fromEntries(owners.map(owner => [owner.label, [{
    name: 'app', command: join(dir, 'app-command'), args: ['--owner', owner.label],
    env: { APP_OWNER: owner.label, APP_LITERAL: 'spaces "quotes" $literal' },
    allowedTools: ['read', 'search']
  }]]));
  const invocations = [], factoryCalls = [];
  const runner = new CompanionRunner({ store, owners, runtimeDir: join(dir, 'runtimes'), binaries,
    mcpServersFor(owner) {
      factoryCalls.push(owner);
      return factory ? factory(owner, descriptors) : apps ? descriptors[owner.label] : [];
    },
    spawnImpl(binary, args, options) {
      assert.ok(Object.values(binaries).includes(binary), 'Only a copied fake CLI may run');
      invocations.push({ binary, args: [...args], cwd: options.cwd, env: { ...options.env } });
      return spawn(process.execPath, [binary, ...args], options);
    }
  });
  const ids = {};
  for (const owner of owners) {
    ids[owner.label] = store.getOrInsert('companion-identity-v1',
      principalKey({ issuer: owner.issuer, subject: owner.subject }), { companionId: randomUUID() }).companionId;
    writeFileSync(join(runner.paths(owner).home, 'signed-in'), '');
  }
  const calls = label => {
    const file = join(runner.paths(owners.find(owner => owner.label === label)).home, 'calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  return { dir, store, runner, owners, ids, descriptors, invocations, factoryCalls, calls };
}

function flagValues(args, flag) {
  const start = args.indexOf(flag);
  assert.notEqual(start, -1, `${flag} must be explicit`);
  const values = [];
  for (let i = start + 1; i < args.length && !args[i].startsWith('-'); i++) {
    values.push(...args[i].split(',').filter(Boolean));
  }
  return values;
}

function configOverrides(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const assignment = args[++i], equals = assignment.indexOf('=');
    assert.ok(equals > 0, 'Each Codex override is a key/value assignment');
    values.set(assignment.slice(0, equals), JSON.parse(assignment.slice(equals + 1)));
  }
  return values;
}

// Decode only the app-supplied command arguments. These fake CLIs do not test
// either provider's MCP implementation or reset inherited Codex configuration.
function configuredServers(provider, invocation) {
  if (provider === 'claude') {
    assert.ok(invocation.args.includes('--strict-mcp-config'));
    const index = invocation.args.indexOf('--mcp-config');
    assert.notEqual(index, -1);
    const config = JSON.parse(invocation.args[index + 1]);
    assert.deepEqual(Object.keys(config), ['mcpServers']);
    return Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => [name,
      { command: server.command, args: server.args, env: server.env ?? {},
        allowedTools: flagValues(invocation.args, '--allowedTools')
          .filter(tool => tool.startsWith(`mcp__${name}__`)).map(tool => tool.slice(`mcp__${name}__`.length)) }
    ]));
  }
  const servers = {};
  for (const [key, value] of configOverrides(invocation.args)) {
    const match = /^mcp_servers\.([a-z][a-z0-9_-]*)\.(.+)$/.exec(key);
    if (!match) continue;
    const [, name, field] = match;
    const server = servers[name] ??= { env: {} };
    if (field.startsWith('env.')) server.env[field.slice(4)] = value;
    else if (field === 'enabled_tools') server.allowedTools = value;
    else if (['command', 'args'].includes(field)) server[field] = value;
  }
  return servers;
}

function expectedServers(env, label, { boardTools = ['get_work', 'list_projects'], appTools = ['read', 'search'] } = {}) {
  const owner = env.owners.find(value => value.label === label), servers = {};
  if (owner.board && boardTools.length) servers.board = {
    command: owner.board.pythonPath,
    args: [owner.board.connectPath, '--stdio', '--client', 'other', '--config-dir', owner.board.configDir],
    env: {}, allowedTools: boardTools
  };
  if (appTools.length) {
    const descriptor = env.descriptors[label][0];
    servers.app = { ...descriptor, args: [...descriptor.args], env: { ...descriptor.env }, allowedTools: [...appTools] };
  }
  if (servers.app) delete servers.app.name;
  return servers;
}

function assertNativePermissions(provider, invocation, tools) {
  if (provider === 'claude') {
    assert.deepEqual(flagValues(invocation.args, '--tools'), tools);
    const approved = invocation.args.includes('--allowedTools') ? flagValues(invocation.args, '--allowedTools') : [];
    assert.deepEqual(approved.filter(tool => !tool.startsWith('mcp__')), tools);
    assert.equal(invocation.args.includes('--permission-mode'), tools.some(tool => ['Edit', 'Write'].includes(tool)));
    if (invocation.args.includes('--permission-mode')) {
      assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], 'acceptEdits');
    }
    assert.ok(!invocation.args.includes('--dangerously-skip-permissions'));
  } else {
    assert.equal(configOverrides(invocation.args).get('sandbox_mode'), 'workspace-write');
    assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: fresh and resumed turns keep each owner's home, workspace and exact MCP configuration`, async t => {
    const env = setup(t, provider);
    const sessions = {};
    for (const label of ['alice', 'bob']) {
      sessions[label] = (await env.runner.turn(env.ids[label], { prompt: `fresh-${label}` })).sessionId;
    }
    for (const label of ['bob', 'alice']) {
      const reply = await env.runner.turn(env.ids[label], { prompt: `resume-${label}`, resume: sessions[label] });
      assert.equal(reply.sessionId, sessions[label]);
    }
    assert.equal(env.invocations.length, 4);
    for (const [index, label] of ['alice', 'bob', 'bob', 'alice'].entries()) {
      const owner = env.owners.find(value => value.label === label), paths = env.runner.paths(owner);
      const other = env.owners.find(value => value.label !== label), otherPaths = env.runner.paths(other);
      const invocation = env.invocations[index];
      assert.equal(invocation.cwd, paths.workspace);
      assert.equal(invocation.env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], paths.home);
      assert.notEqual(paths.home, otherPaths.home);
      assert.notEqual(paths.workspace, otherPaths.workspace);
      assert.deepEqual(configuredServers(provider, invocation), expectedServers(env, label));
      assert.ok(!JSON.stringify(invocation.args).includes(other.board.configDir));
      assertNativePermissions(provider, invocation, owner.tools);
      if (index >= 2) {
        if (provider === 'claude') assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], sessions[label]);
        else assert.deepEqual(invocation.args.slice(0, 3), ['exec', 'resume', sessions[label]]);
      }
    }
    assert.deepEqual(env.calls('alice').map(call => call.prompt), ['fresh-alice', 'resume-alice']);
    assert.deepEqual(env.calls('bob').map(call => call.prompt), ['fresh-bob', 'resume-bob']);
  });

  test(`${provider}: configured Board writes reach fresh and resumed owner bridges and cannot expand`, async t => {
    const configured = { alice: ['get_work', 'create_ticket', 'post_message'], bob: ['get_work', 'post_message'] };
    const writes = { alice: ['create_ticket', 'post_message'], bob: ['post_message'] };
    const env = setup(t, provider, { apps: false, boardTools: configured }), sessions = {};
    for (const label of ['alice', 'bob']) {
      sessions[label] = (await env.runner.turn(env.ids[label], { prompt: `write-fresh-${label}` })).sessionId;
    }
    for (const label of ['bob', 'alice']) {
      const reply = await env.runner.turn(env.ids[label], { prompt: `write-resume-${label}`, resume: sessions[label],
        allowedTools: writes[label].map(name => `mcp__board__${name}`) });
      assert.equal(reply.sessionId, sessions[label]);
    }
    assert.equal(env.invocations.length, 4);
    for (const [index, label] of ['alice', 'bob', 'bob', 'alice'].entries()) {
      const owner = env.owners.find(value => value.label === label), paths = env.runner.paths(owner), invocation = env.invocations[index];
      const other = env.owners.find(value => value.label !== label);
      assert.deepEqual(configuredServers(provider, invocation), expectedServers(env, label, {
        boardTools: index < 2 ? configured[label] : writes[label], appTools: []
      }));
      assert.equal(invocation.cwd, paths.workspace);
      assert.equal(invocation.env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'], paths.home);
      assert.ok(!JSON.stringify(invocation.args).includes(other.board.configDir));
      assertNativePermissions(provider, invocation, index < 2 ? owner.tools : []);
      if (index >= 2) {
        if (provider === 'claude') assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], sessions[label]);
        else assert.deepEqual(invocation.args.slice(0, 3), ['exec', 'resume', sessions[label]]);
      }
    }
    await assert.rejects(env.runner.turn(env.ids.bob, { prompt: 'cannot borrow another owner write', resume: sessions.bob,
      allowedTools: ['mcp__board__post_message', 'mcp__board__create_ticket'] }),
    error => error instanceof RunnerError && error.code === 'TOOL_POLICY_REFUSED');
    assert.equal(env.invocations.length, 4); assert.equal(env.runner.queues.size, 0);
    assert.deepEqual(env.calls('alice').map(call => call.prompt), ['write-fresh-alice', 'write-resume-alice']);
    assert.deepEqual(env.calls('bob').map(call => call.prompt), ['write-fresh-bob', 'write-resume-bob']);
  });

  test(`${provider}: omission inherits policy while empty and exact subsets remove tool selections`, async t => {
    const env = setup(t, provider);
    await env.runner.turn(env.ids.alice, { prompt: 'inherited' });
    await env.runner.turn(env.ids.alice, { prompt: 'empty', allowedTools: [] });
    await env.runner.turn(env.ids.alice, { prompt: 'subset',
      allowedTools: ['mcp__board__get_work', 'mcp__app__search'] });
    const [inherited, empty, subset] = env.invocations;
    assert.deepEqual(configuredServers(provider, inherited), expectedServers(env, 'alice'));
    assert.deepEqual(configuredServers(provider, empty), {});
    assert.deepEqual(configuredServers(provider, subset), expectedServers(env, 'alice', {
      boardTools: ['get_work'], appTools: ['search']
    }));
    assertNativePermissions(provider, empty, []);
    assertNativePermissions(provider, subset, []);
    if (provider === 'codex') {
      assert.equal(configOverrides(inherited.args).get('web_search'), 'live');
      assert.equal(configOverrides(empty.args).get('web_search'), 'disabled');
      assert.equal(configOverrides(subset.args).get('web_search'), 'disabled');
    }
    assert.deepEqual(env.calls('alice').map(call => call.prompt), ['inherited', 'empty', 'subset']);
    assert.equal(env.calls('bob').length, 0);
  });

  test(`${provider}: Board is absent without configuration, with or without an app MCP server`, async t => {
    const env = setup(t, provider, { board: false });
    await env.runner.turn(env.ids.alice, { prompt: 'app only' });
    assert.deepEqual(configuredServers(provider, env.invocations[0]), expectedServers(env, 'alice'));
    assert.ok(!JSON.stringify(env.invocations[0].args).includes('mcp_servers.board'));
    assert.ok(!JSON.stringify(env.invocations[0].args).includes('mcp__board__'));
    env.descriptors.alice.length = 0;
    await env.runner.turn(env.ids.alice, { prompt: 'no MCP configuration' });
    assert.deepEqual(configuredServers(provider, env.invocations[1]), {});
    assertNativePermissions(provider, env.invocations[1], env.owners[0].tools);
  });

  test(`${provider}: tool expansions and per-turn MCP injection are refused before queueing or spawning`, async t => {
    const env = setup(t, provider);
    for (const allowedTools of [
      ['Bash'], ['mcp__board__delete_ticket'], ['mcp__foreign__read'],
      ['mcp__app__read', 'mcp__app__read'],
      ...(provider === 'codex' ? [['WebSearch'], ['WebFetch']] : [])
    ]) {
      await assert.rejects(env.runner.turn(env.ids.alice, { prompt: 'must not run', allowedTools }),
        error => error instanceof RunnerError && error.code === 'TOOL_POLICY_REFUSED');
      assert.equal(env.runner.queues.size, 0);
      assert.equal(env.invocations.length, 0);
    }
    let untrustedFactoryCalls = 0;
    await assert.rejects(env.runner.turn(env.ids.alice, { prompt: 'must not run', allowedTools: ['mcp__injected__read'],
      mcpServersFor() { untrustedFactoryCalls++; return [{ name: 'injected', command: join(env.dir, 'untrusted'), allowedTools: ['read'] }]; }
    }), error => error.code === 'TOOL_POLICY_REFUSED');
    assert.equal(untrustedFactoryCalls, 0);
    assert.equal(env.runner.queues.size, 0);
    assert.equal(env.invocations.length, 0);
    assert.equal(env.calls('alice').length + env.calls('bob').length, 0);
  });

  test(`${provider}: synchronous app configuration and requested tools are copied before deferred spawn`, async t => {
    const env = setup(t, provider);
    const allowedTools = ['mcp__board__get_work', 'mcp__app__read'];
    const expected = expectedServers(env, 'alice', { boardTools: ['get_work'], appTools: ['read'] });
    const pending = env.runner.turn(env.ids.alice, { prompt: 'snapshot', allowedTools });
    assert.deepEqual(env.factoryCalls, [env.owners[0]], 'The server callback resolves synchronously');
    assert.equal(env.invocations.length, 0, 'Provider launch remains deferred by the owner queue');
    allowedTools.push('Bash');
    env.descriptors.alice[0].args.push('--late-change');
    env.descriptors.alice[0].env.APP_OWNER = 'bob';
    env.descriptors.alice[0].allowedTools.push('delete');
    await pending;
    assert.deepEqual(configuredServers(provider, env.invocations[0]), expected);
    assert.equal(env.calls('alice')[0].prompt, 'snapshot');
  });
}

test('invalid or asynchronous app factories cannot queue or launch a provider', async t => {
  for (const factory of [
    () => Promise.resolve([]),
    async () => { throw new Error('private async callback error'); },
    () => { throw new Error('private callback error'); },
    (_owner, descriptors) => [{ ...descriptors.alice[0], name: 'board' }],
    (_owner, descriptors) => [{ ...descriptors.alice[0], allowedTools: undefined }]
  ]) {
    const env = setup(t, 'claude', { factory });
    await assert.rejects(env.runner.turn(env.ids.alice, { prompt: 'must not run' }),
      error => error instanceof RunnerError && error.code === 'TOOL_POLICY_REFUSED' && !error.message.includes('private callback error'));
    assert.equal(env.runner.queues.size, 0);
    assert.equal(env.invocations.length, 0);
  }
});

test('the application server callback must be a function provided to the constructor', () => {
  for (const mcpServersFor of [null, [], {}, 'caller-owned', 7]) {
    assert.throws(() => new CompanionRunner({ mcpServersFor }), TypeError);
  }
});

test('effective tool policy is deeply frozen without freezing the application-owned descriptors', () => {
  const descriptor = { name: 'app', command: join(tmpdir(), 'fake-command'),
    args: ['one'], env: { APP_OWNER: 'alice' }, allowedTools: ['read'] };
  const policy = narrowToolPolicy({ tools: WEB }, undefined, [descriptor]);
  for (const value of [policy, policy.tools, policy.mcpServers, policy.mcpServers[0],
    policy.mcpServers[0].args, policy.mcpServers[0].env, policy.mcpServers[0].allowedTools]) {
    assert.ok(Object.isFrozen(value));
  }
  descriptor.args.push('two'); descriptor.env.APP_OWNER = 'bob'; descriptor.allowedTools.push('write');
  assert.deepEqual(policy.mcpServers[0], { name: 'app', command: descriptor.command,
    args: ['one'], env: { APP_OWNER: 'alice' }, allowedTools: ['read'] });
  assert.throws(() => policy.mcpServers[0].allowedTools.push('write'), TypeError);
});
