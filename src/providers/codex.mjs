// Codex adapter. Runs `codex exec --json` with the owner's own CODEX_HOME. Sign-in happens
// only through OpenAI's own flow (`codex login --device-auth`), run by the owner.
// Event names differ slightly between Codex releases; both known spellings are accepted.
// Verified against codex-cli 0.166.0 (signed-out paths; signed-in turn pending owner sign-in).

import { mcpServersFor } from '../tool-policy.mjs';

export const name = 'codex';

// Group chat turns (#53, docs/GROUP-CHAT.md) run isolated: the read-only sandbox limits writes, not reads, so every
// built-in that could read a file, open a browser, recall Codex memories or start a subagent is switched off. Images
// still arrive through --image. Verified with codex-cli 0.166.0: with these off, a canary file outside the folder
// cannot be read; without them it can.
export const ISOLATED_OFF = Object.freeze(['shell_tool', 'unified_exec', 'view_image', 'browser_use', 'browser_use_external',
  'in_app_browser', 'computer_use', 'apps', 'memories', 'goals', 'multi_agent', 'multi_agent_v2']);
export function command({ binary = 'codex', home, resume, model, systemPrompt, images = [], toolPolicy = { tools: [], board: null }, readOnly = false, isolated = false }) {
  if (toolPolicy.tools.length === 1) throw new Error('Codex web search and fetch must be configured together');
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  // `exec resume` has no --sandbox flag; the config override works for both forms.
  // Ordinary turns keep the companion's workspace writes; release web checks use
  // read-only sandboxing. Intrinsic tools and inherited CLI config remain provider-owned.
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${JSON.stringify(readOnly ? 'read-only' : 'workspace-write')}`);
  args.push('-c', `web_search=${JSON.stringify(toolPolicy.tools.length ? 'live' : 'disabled')}`);
  for (const server of toolPolicy.mcpServers ?? mcpServersFor(toolPolicy)) {
    const prefix = `mcp_servers.${server.name}`;
    args.push('-c', `${prefix}.command=${JSON.stringify(server.command)}`,
      '-c', `${prefix}.args=${JSON.stringify(server.args)}`,
      '-c', `${prefix}.enabled_tools=${JSON.stringify(server.allowedTools)}`,
      '-c', `${prefix}.required=true`, '-c', `${prefix}.default_tools_approval_mode="approve"`);
    for (const [key, value] of Object.entries(server.env)) args.push('-c', `${prefix}.env.${key}=${JSON.stringify(value)}`);
  }
  // MCP tables deep-merge in 0.166; these overrides do not clear other config layers.
  if (isolated) for (const feature of ISOLATED_OFF) args.push('-c', `features.${feature}=false`);
  if (model) args.push('--model', model);
  // Both exec and exec resume accept repeated --image paths (qualified CLI help, no shell interpolation).
  for (const image of images) args.push('--image', image);
  // Codex has no append-system-prompt flag; the caller's persona is prepended to the prompt.
  args.push('-');
  return { binary, args, env: { CODEX_HOME: home }, promptPrefix: systemPrompt ? systemPrompt + '\n\n' : '' };
}

export function statusCommand({ binary = 'codex', home }) {
  return { binary, args: ['login', 'status'], env: { CODEX_HOME: home } };
}

// `codex login status` prints e.g. "Logged in using ChatGPT" / "Not logged in" on stderr.
export function parseStatus(stdout, stderr = '') {
  const text = `${stdout}\n${stderr}`;
  const signedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  return { signedIn, plan: /chatgpt/i.test(text) ? 'chatgpt' : null };
}

export function loginCommand({ binary = 'codex', home }) {
  return { binary, args: ['login', '--device-auth'], env: { CODEX_HOME: home } };
}

const NOT_SIGNED_IN = /not logged in|login required|unauthorized|401/i;
const USAGE_LIMIT = /usage limit|rate limit|429/i;

export function parseLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return []; }
  const type = value?.type;
  if (type === 'thread.started' || type === 'thread.resumed') {
    return typeof value.thread_id === 'string' ? [{ type: 'session', id: value.thread_id }] : [];
  }
  if (type === 'item.completed' && ['agent_message', 'assistant_message'].includes(value.item?.type)) {
    const text = value.item.text ?? '';
    return [{ type: 'delta', text }, { type: 'message', text }];
  }
  // Any other item starting (a command, a tool or file change, a search): the companion is acting.
  if (type === 'item.started' && value.item && !['agent_message', 'assistant_message', 'reasoning'].includes(value.item.type)) return [{ type: 'acting' }];
  // Codex's native web search, counted like Claude's WebSearch (#42).
  if (type === 'item.completed' && value.item?.type === 'web_search') return [{ type: 'tool', name: 'WebSearch' }];
  if (type === 'turn.completed') return [{ type: 'done', text: null, sessionId: null, usage: value.usage ?? null }];
  if (type === 'turn.failed' || type === 'error') {
    const text = String(value.error?.message ?? value.message ?? '');
    // Transient transport retries ("Reconnecting... 2/5 (...)") are not failures.
    if (type === 'error' && /^Reconnecting\b/.test(text)) return [];
    const code = NOT_SIGNED_IN.test(text) ? 'NOT_SIGNED_IN' : USAGE_LIMIT.test(text) ? 'USAGE_LIMIT' : 'PROVIDER_ERROR';
    return [{ type: 'error', code, detail: text.slice(0, 300) }];
  }
  return [];
}
