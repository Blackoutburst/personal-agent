// Claude Code adapter. Runs the unmodified `claude` CLI headless with the owner's own
// CLAUDE_CONFIG_DIR. Sign-in happens only through Anthropic's own flow (`claude auth login`),
// run by the owner; this module never reads or stores credentials.

import { mcpServersFor } from '../tool-policy.mjs';

export const name = 'claude';

export function command({ binary = 'claude', home, resume, model, systemPrompt, toolPolicy, allowedTools = [] }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  const policy = toolPolicy ?? { tools: allowedTools, board: null };
  const servers = policy.mcpServers ?? mcpServersFor(policy);
  const mcpServers = Object.fromEntries(servers.map(server => [server.name, {
    command: server.command, args: server.args, ...(Object.keys(server.env).length ? { env: server.env } : {})
  }]));
  const approved = [...policy.tools, ...servers.flatMap(server => server.allowedTools.map(tool => `mcp__${server.name}__${tool}`))];
  // allowedTools auto-approves; tools bounds built-ins and strict MCP selects only app transports.
  args.push('--tools', policy.tools.join(','), '--setting-sources=', '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers }));
  if (approved.length) args.push('--allowedTools', ...approved);
  // File edits are accepted without a prompt, but only inside the working directory (the companion's workspace).
  if (policy.tools.some(tool => ['Edit', 'Write'].includes(tool))) args.push('--permission-mode', 'acceptEdits');
  return { binary, args, env: { CLAUDE_CONFIG_DIR: home } };
}

export function statusCommand({ binary = 'claude', home }) {
  return { binary, args: ['auth', 'status', '--json'], env: { CLAUDE_CONFIG_DIR: home } };
}

export function parseStatus(stdout) {
  const value = JSON.parse(stdout);
  return { signedIn: value.loggedIn === true, plan: typeof value.subscriptionType === 'string' ? value.subscriptionType : null };
}

export function loginCommand({ binary = 'claude', home }) {
  return { binary, args: ['auth', 'login'], env: { CLAUDE_CONFIG_DIR: home } };
}

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|oauth token (has )?expired/i;
const USAGE_LIMIT = /usage limit|limit reached|rate limit/i;

// Translate one stream-json line into zero or more normalized events.
export function parseLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return []; }
  switch (value?.type) {
    case 'system':
      return value.subtype === 'init' && typeof value.session_id === 'string' ? [{ type: 'session', id: value.session_id }] : [];
    case 'stream_event': {
      const delta = value.event?.type === 'content_block_delta' ? value.event.delta : null;
      return delta?.type === 'text_delta' && typeof delta.text === 'string' ? [{ type: 'delta', text: delta.text }] : [];
    }
    case 'rate_limit_event': {
      const info = value.rate_limit_info ?? {};
      return [{ type: 'rate', status: info.status ?? null, resetsAt: info.resetsAt ?? null, windows: info.unifiedWindows ?? null }];
    }
    case 'result': {
      const text = typeof value.result === 'string' ? value.result : '';
      if (value.is_error) {
        const code = NOT_SIGNED_IN.test(text) ? 'NOT_SIGNED_IN' : USAGE_LIMIT.test(text) ? 'USAGE_LIMIT' : 'PROVIDER_ERROR';
        return [{ type: 'error', code, detail: text.slice(0, 300) }];
      }
      return [{ type: 'done', text, sessionId: value.session_id ?? null, usage: value.usage ?? null }];
    }
    default:
      return [];
  }
}
