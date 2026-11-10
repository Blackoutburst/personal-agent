import { spawn } from 'node:child_process';
import { bindBoardSession } from './board-session-bridge.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';
import { companionIdFor } from './runtime-config.mjs';
import { WEB_TOOLS, narrowToolPolicy } from './tool-policy.mjs';

const ADAPTERS = { claude, codex };
const MESSAGES = {
  NO_RUNTIME: 'No agent is configured for this companion yet.',
  TOOL_POLICY_REFUSED: 'The requested tools are not enabled for this companion.',
  NOT_SIGNED_IN: 'Your agent is not signed in. Run the sign-in step for your account on the server.',
  USAGE_LIMIT: 'Your subscription usage limit is reached. Your agent will be available again after it resets.',
  PROVIDER_MISSING: 'The agent program is not installed on the server.',
  PROVIDER_ERROR: 'Your agent could not complete this reply.',
  TIMEOUT: 'Your agent took too long to reply.',
  CANCELLED: 'The reply was cancelled.'
};

export class RunnerError extends Error {
  constructor(code, { detail = null, resetsAt = null } = {}) {
    super(MESSAGES[code] ?? MESSAGES.PROVIDER_ERROR);
    this.name = 'RunnerError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'PROVIDER_ERROR';
    this.detail = detail; this.resetsAt = resetsAt;
  }
}

function collect(child) {
  return new Promise(resolve => {
    const out = { stdout: '', stderr: '' };
    for (const name of ['stdout', 'stderr']) {
      child[name]?.setEncoding('utf8').on('data', chunk => { if (out[name].length < 65536) out[name] += chunk; });
    }
    child.on('error', error => resolve({ code: null, ...out, error }));
    child.on('close', code => resolve({ code, ...out, error: null }));
  });
}

// Runs each owner's own agent (Claude Code or Codex) under that owner's provider home.
// One turn at a time per owner; turns of different owners run concurrently.
export class CompanionRunner {
  constructor({ store, owners, runtimeDir, binaries = {}, timeoutMs = 10 * 60_000, spawnImpl = spawn, statusTtlMs = 30_000,
    mcpServersFor = () => [] }) {
    if (typeof mcpServersFor !== 'function') throw new TypeError('mcpServersFor must be a synchronous function');
    this.store = store; this.owners = owners; this.runtimeDir = runtimeDir; this.binaries = binaries;
    this.mcpServersFor = mcpServersFor;
    this.timeoutMs = timeoutMs; this.spawn = spawnImpl; this.statusTtlMs = statusTtlMs;
    this.queues = new Map(); this.statusCache = new Map();
  }

  // Resolve strictly by the server-side companion ID; callers never pass a label or path.
  ownerFor(companionId) {
    if (typeof companionId !== 'string') return null;
    return this.owners.find(owner => companionIdFor(this.store, owner) === companionId) ?? null;
  }

  paths(owner) {
    const base = join(this.runtimeDir, owner.label);
    const home = join(base, `${owner.provider}-home`), workspace = join(base, 'workspace');
    for (const dir of [this.runtimeDir, base, home, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { home, workspace };
  }

  #run(spec, cwd) {
    return this.spawn(spec.binary, spec.args, { cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  }

  async status(companionId) {
    const owner = this.ownerFor(companionId);
    return owner ? this.ownerStatus(owner) : { state: 'unconfigured' };
  }

  // Also used by manage.mjs for owners who have not opened the web app yet.
  async ownerStatus(owner) {
    const cached = this.statusCache.get(owner.label);
    if (cached && Date.now() - cached.at < this.statusTtlMs) return cached.value;
    const adapter = ADAPTERS[owner.provider], { home, workspace } = this.paths(owner);
    const spec = adapter.statusCommand({ binary: this.binaries[owner.provider], home });
    // Codex prints its login status on stderr, Claude on stdout: read both.
    const child = this.spawn(spec.binary, spec.args, { cwd: workspace, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await collect(child);
    let value;
    if (result.error?.code === 'ENOENT') value = { state: 'provider-missing', provider: owner.provider };
    else {
      let parsed = { signedIn: false, plan: null };
      try { parsed = adapter.parseStatus(result.stdout, result.stderr); } catch { /* treated as signed out */ }
      value = { state: parsed.signedIn ? 'ready' : 'signed-out', provider: owner.provider, plan: parsed.plan };
    }
    this.statusCache.set(owner.label, { at: Date.now(), value });
    return value;
  }

  // prompt: user text. resume: provider session id from a previous turn of the same thread.
  // onEvent receives {type:'session'|'delta'|'rate'|'tool'|'acting'} events while the reply streams ('acting': a tool call started).
  // group (#53, docs/GROUP-CHAT.md): a group chat turn runs in its own empty folder (runtimeDir/<label>/groups/<id>),
  // never in the private workspace, so the provider loads no workspace files and keeps a separate session per group.
  // Codex runs it read-only there.
  turn(companionId, { prompt, resume = null, systemPrompt = null, allowedTools, toolFilter, images = [], appServers = [], onEvent = () => {}, signal, group = null, boardConversationKey } = {}) {
    return this.#enqueue(this.ownerFor(companionId), { prompt, resume, systemPrompt, allowedTools, toolFilter, images, appServers, onEvent, signal, group, boardConversationKey });
  }

  // Whether this owner's agent is running or has a queued turn (the Minecraft connector, #68, lets chat go first).
  busy(companionId) {
    const owner = this.ownerFor(companionId);
    return Boolean(owner && this.queues.has(owner.label));
  }

  groupDir(owner, groupId) {
    if (typeof groupId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(groupId)) throw new TypeError('Invalid group');
    const base = join(this.runtimeDir, owner.label), groups = join(base, 'groups'), dir = join(groups, groupId);
    for (const path of [this.runtimeDir, base, groups, dir]) mkdirSync(path, { recursive: true, mode: 0o700 });
    return dir;
  }

  // Application-owned release wakes alone may use native web tools regardless of
  // ordinary owner tool omission. They never forward Board or app MCP transports.
  releaseCheck(companionId, { prompt, systemPrompt = null, onEvent = () => {}, signal } = {}) {
    return this.#enqueue(this.ownerFor(companionId), { prompt, systemPrompt, onEvent, signal }, true);
  }

  // Server-side admin tooling only (manage.mjs smoke test): select the owner by config label.
  turnForLabel(label, options = {}) {
    return this.#enqueue(this.owners.find(owner => owner.label === label) ?? null, options);
  }

  #enqueue(owner, { prompt, resume = null, systemPrompt = null, allowedTools, toolFilter, images = [], appServers = [], onEvent = () => {}, signal, group = null, boardConversationKey } = {}, releaseCheck = false) {
    if (!owner) return Promise.reject(new RunnerError('NO_RUNTIME'));
    let toolPolicy, cwd = null;
    try {
      const configured = releaseCheck ? [] : this.mcpServersFor(owner);
      if (configured && typeof configured.then === 'function') {
        Promise.resolve(configured).catch(() => {});
        throw new TypeError('mcpServersFor must return synchronously');
      }
      if (!Array.isArray(configured) || !Array.isArray(appServers) || !Array.isArray(images) || images.length > 8
          || images.some(path => typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f]/.test(path))) throw new TypeError('Invalid turn input');
      toolPolicy = releaseCheck ? narrowToolPolicy({ tools: WEB_TOOLS, board: null })
        : narrowToolPolicy({ tools: owner.tools, board: owner.board }, allowedTools, [...configured, ...appServers], toolFilter);
      toolPolicy = bindBoardSession(toolPolicy, owner.label, boardConversationKey);
      if (owner.provider === 'codex' && toolPolicy.tools.length
          && (toolPolicy.tools.length !== WEB_TOOLS.length || !WEB_TOOLS.every(tool => toolPolicy.tools.includes(tool)))) {
        throw new TypeError('Codex web tools must be selected together');
      }
      if (group !== null) cwd = this.groupDir(owner, group);
    } catch {
      return Promise.reject(new RunnerError('TOOL_POLICY_REFUSED'));
    }
    const previous = this.queues.get(owner.label) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#turn(owner, { prompt, resume, systemPrompt, toolPolicy, images: [...images], onEvent, signal, releaseCheck, cwd }));
    this.queues.set(owner.label, current);
    current.finally(() => { if (this.queues.get(owner.label) === current) this.queues.delete(owner.label); }).catch(() => {});
    return current;
  }

  async #turn(owner, { prompt, resume, systemPrompt, toolPolicy, images, onEvent, signal, releaseCheck, cwd = null }) {
    if (signal?.aborted) throw new RunnerError('CANCELLED');
    const adapter = ADAPTERS[owner.provider], { home, workspace } = this.paths(owner);
    const spec = adapter.command({ binary: this.binaries[owner.provider], home, resume, model: owner.model, systemPrompt, toolPolicy, images, readOnly: releaseCheck || cwd !== null, isolated: cwd !== null });
    const child = this.#run(spec, cwd ?? workspace);
    child.stdin.on('error', () => {});
    const input = (spec.promptPrefix ?? '') + prompt;
    child.stdin.end(spec.input ? spec.input(input) : input);

    let sessionId = resume, text = '', streamed = '', usage = null, rate = null, failure = null, done = false, buffer = '';
    const handle = event => {
      if (event.type === 'session') { sessionId = event.id; onEvent(event); }
      else if (event.type === 'delta') { streamed += event.text; onEvent(event); }
      else if (event.type === 'message') text = event.text;
      else if (event.type === 'rate') { rate = event; onEvent(event); }
      else if (event.type === 'tool' || event.type === 'acting') onEvent(event);
      else if (event.type === 'done') { done = true; if (event.text !== null) text = event.text; if (event.sessionId) sessionId = event.sessionId; usage = event.usage; }
      else if (event.type === 'error') failure ??= event;
    };
    child.stdout.setEncoding('utf8').on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim()) adapter.parseLine(line).forEach(handle);
      }
    });

    let reason = null;
    const stop = why => { reason ??= why; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); };
    const timer = setTimeout(() => stop('TIMEOUT'), this.timeoutMs);
    const onAbort = () => stop('CANCELLED');
    signal?.addEventListener('abort', onAbort, { once: true });
    const exit = await new Promise(resolve => {
      child.on('error', error => resolve({ error }));
      child.on('close', code => resolve({ code }));
    }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
    if (buffer.trim()) adapter.parseLine(buffer).forEach(handle);

    if (exit.error?.code === 'ENOENT') throw new RunnerError('PROVIDER_MISSING');
    if (reason) throw new RunnerError(reason);
    if (rate?.status === 'rejected') throw new RunnerError('USAGE_LIMIT', { resetsAt: rate.resetsAt });
    if (failure) {
      if (failure.code !== 'PROVIDER_ERROR') this.statusCache.delete(owner.label);
      throw new RunnerError(failure.code, { detail: failure.detail, resetsAt: rate?.resetsAt ?? null });
    }
    if (!done || exit.code !== 0) throw new RunnerError('PROVIDER_ERROR', { detail: `exit ${exit.code}` });
    return { sessionId, text: text || streamed, usage, rate };
  }
}
