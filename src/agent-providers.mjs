// Agent providers for C-chan's runner (#72, docs/AGENT-RUNNER.md). A provider turns a launch into one headless
// command that runs inside the sandbox (#71), and turns that command's output lines into normalized events. The runner
// never knows which CLI it is driving: adding Codex means adding one object here, nothing else.
//
// Provider interface:
//   name                      'claude' | 'codex'
//   available                 false while the backend is only a reserved slot
//   models                    { alias: provider model id }; the runner accepts only these aliases
//   command({ model, maxTurns, systemPrompt })  -> { binary, args, env }   prompt goes on stdin
//   parseLine(line)           -> [{ type: 'session'|'turn'|'tool'|'rate'|'done'|'error', ... }]
import { parseLine as parseClaudeLine } from './providers/claude.mjs';

const TRANSIENT = /\b(429|529)\b|overloaded|too many requests|rate.?limit/i;

export const SANDBOX_BIN = '/var/lib/cchan-agents/bin';

export const claude = Object.freeze({
  name: 'claude',
  available: true,
  models: Object.freeze({
    haiku: 'claude-haiku-5-5',
    sonnet: 'claude-sonnet-5-5',
    opus: 'claude-opus-5-5',
    fable: 'claude-fable-5-1'
  }),
  // The sandbox is the boundary (no credentials, no other users' files, its own unit), so the agent may edit, run
  // tests and commit in its worktree without prompts. No MCP servers: the agent has no Board or app access; the runner
  // reports for it.
  command({ model, maxTurns, systemPrompt = null }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
      '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    return { binary: `${SANDBOX_BIN}/claude`, args, env: {} };
  },
  parseLine(line) {
    const events = [];
    let value = null;
    try { value = JSON.parse(line); } catch { return events; }
    // One assistant message is one model turn; count them for the Board progress line.
    if (value?.type === 'assistant') events.push({ type: 'turn' });
    if (value?.type === 'result' && value.subtype === 'error_max_turns') {
      events.push({ type: 'error', code: 'MAX_TURNS', detail: 'The run used all its turns.' });
      return events;
    }
    for (const event of parseClaudeLine(line)) {
      if (event.type === 'delta' || event.type === 'acting') continue;
      // A transient API rate limit or overload is its own failure reason, so C-chan retries later (#72).
      if (event.type === 'error' && event.code === 'PROVIDER_ERROR' && TRANSIENT.test(event.detail ?? '')) event.code = 'RATE_LIMITED';
      events.push(event);
    }
    return events;
  }
});

// Reserved slot (#77): `codex exec --json` in the same sandbox, with its own CODEX_HOME login. Not enabled until
// Blackout says go; launching with it is refused as PROVIDER_UNAVAILABLE.
export const codex = Object.freeze({
  name: 'codex',
  available: false,
  models: Object.freeze({}),
  command() { throw new Error('The Codex backend is not enabled yet (#77).'); },
  parseLine() { return []; }
});

export const PROVIDERS = Object.freeze({ claude, codex });

// Resolve a launch's provider and model alias. Returns { provider, model } or throws with a code.
export function resolveModel(providerName = 'claude', alias) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw Object.assign(new Error('Unknown provider.'), { code: 'INVALID' });
  if (!provider.available) throw Object.assign(new Error(`The ${provider.name} backend is not enabled yet.`), { code: 'PROVIDER_UNAVAILABLE' });
  const model = Object.hasOwn(provider.models, alias) ? provider.models[alias] : null;
  if (!model) throw Object.assign(new Error(`Unknown model. Use one of: ${Object.keys(provider.models).join(', ')}.`), { code: 'INVALID' });
  return { provider, model };
}
