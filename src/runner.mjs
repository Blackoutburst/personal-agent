import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';
import { companionIdFor } from './runtime-config.mjs';

const ADAPTERS = { claude, codex };
const MESSAGES = {
  NO_RUNTIME: 'No agent is configured for this companion yet.',
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
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.on('error', error => resolve({ code: null, stdout, error }));
    child.on('close', code => resolve({ code, stdout, error: null }));
  });
}

// Runs each owner's own agent (Claude Code or Codex) under that owner's provider home.
// One turn at a time per owner; turns of different owners run concurrently.
export class CompanionRunner {
  constructor({ store, owners, runtimeDir, binaries = {}, timeoutMs = 10 * 60_000, spawnImpl = spawn, statusTtlMs = 30_000 }) {
    this.store = store; this.owners = owners; this.runtimeDir = runtimeDir; this.binaries = binaries;
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
    if (!owner) return { state: 'unconfigured' };
    const cached = this.statusCache.get(owner.label);
    if (cached && Date.now() - cached.at < this.statusTtlMs) return cached.value;
    const adapter = ADAPTERS[owner.provider], { home, workspace } = this.paths(owner);
    const child = this.#run(adapter.statusCommand({ binary: this.binaries[owner.provider], home }), workspace);
    child.stdin.end();
    const result = await collect(child);
    let value;
    if (result.error?.code === 'ENOENT') value = { state: 'provider-missing', provider: owner.provider };
    else {
      let parsed = { signedIn: false, plan: null };
      try { parsed = adapter.parseStatus(result.stdout); } catch { /* treated as signed out */ }
      value = { state: parsed.signedIn ? 'ready' : 'signed-out', provider: owner.provider, plan: parsed.plan };
    }
    this.statusCache.set(owner.label, { at: Date.now(), value });
    return value;
  }

  // prompt: user text. resume: provider session id from a previous turn of the same thread.
  // onEvent receives {type:'session'|'delta'|'rate'} events while the reply streams.
  turn(companionId, { prompt, resume = null, systemPrompt = null, allowedTools = [], onEvent = () => {}, signal } = {}) {
    return this.#enqueue(this.ownerFor(companionId), { prompt, resume, systemPrompt, allowedTools, onEvent, signal });
  }

  // Server-side admin tooling only (manage.mjs smoke test): select the owner by config label.
  turnForLabel(label, options = {}) {
    return this.#enqueue(this.owners.find(owner => owner.label === label) ?? null, options);
  }

  #enqueue(owner, { prompt, resume = null, systemPrompt = null, allowedTools = [], onEvent = () => {}, signal } = {}) {
    if (!owner) return Promise.reject(new RunnerError('NO_RUNTIME'));
    const previous = this.queues.get(owner.label) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#turn(owner, { prompt, resume, systemPrompt, allowedTools, onEvent, signal }));
    this.queues.set(owner.label, current);
    current.finally(() => { if (this.queues.get(owner.label) === current) this.queues.delete(owner.label); }).catch(() => {});
    return current;
  }

  async #turn(owner, { prompt, resume, systemPrompt, allowedTools, onEvent, signal }) {
    if (signal?.aborted) throw new RunnerError('CANCELLED');
    const adapter = ADAPTERS[owner.provider], { home, workspace } = this.paths(owner);
    const spec = adapter.command({ binary: this.binaries[owner.provider], home, resume, model: owner.model, systemPrompt, allowedTools });
    const child = this.#run(spec, workspace);
    child.stdin.on('error', () => {});
    child.stdin.end((spec.promptPrefix ?? '') + prompt);

    let sessionId = resume, text = '', streamed = '', usage = null, rate = null, failure = null, done = false, buffer = '';
    const handle = event => {
      if (event.type === 'session') { sessionId = event.id; onEvent(event); }
      else if (event.type === 'delta') { streamed += event.text; onEvent(event); }
      else if (event.type === 'message') text = event.text;
      else if (event.type === 'rate') { rate = event; onEvent(event); }
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
