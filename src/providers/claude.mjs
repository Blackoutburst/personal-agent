// Claude Code adapter. Runs the unmodified `claude` CLI headless with the owner's own
// CLAUDE_CONFIG_DIR. Sign-in happens only through Anthropic's own flow (`claude auth login`),
// run by the owner; this module never reads or stores credentials.

import { readFileSync, statSync } from 'node:fs';
import { mcpServersFor } from '../tool-policy.mjs';

export const name = 'claude';

// Image bytes Claude accepts inline, by magic number (never by file name).
const IMAGE_MAX = 3_750_000;
function imageType(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 6 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
// One stream-json user message: the text, then each readable image inline. Unreadable, unsupported or too-large
// images are skipped with a short note so the companion does not pretend to see them.
export function inlineMessage(text, images) {
  const content = [], skipped = [];
  for (const path of images) {
    try {
      if (statSync(path).size > IMAGE_MAX) { skipped.push(path); continue; }
      const bytes = readFileSync(path), mime = imageType(bytes);
      if (!mime) { skipped.push(path); continue; }
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } });
    } catch { skipped.push(path); }
  }
  const note = skipped.length ? `\n\n(App note: ${skipped.length} attached image(s) could not be shown to you: too large or unsupported.)` : '';
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: text + note }, ...content] } }) + '\n';
}

// isolated (#53 group turns): no file tools, so images go inline through --input-format stream-json.
export function command({ binary = 'claude', home, resume, model, systemPrompt, toolPolicy, allowedTools = [], images = [], isolated = false }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const inline = isolated && images.length > 0;
  if (inline) args.push('--input-format', 'stream-json');
  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  // Replace Claude Code's own (coding assistant) system prompt: appended, it made the companion sound like a bot.
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
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
  return { binary, args, env: { CLAUDE_CONFIG_DIR: home }, ...(inline ? { input: text => inlineMessage(text, images) } : {}) };
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
      // A tool call starting: the earliest sign the companion is acting, before the tool runs.
      if (value.event?.type === 'content_block_start' && ['tool_use', 'server_tool_use', 'mcp_tool_use'].includes(value.event.content_block?.type)) return [{ type: 'acting' }];
      const delta = value.event?.type === 'content_block_delta' ? value.event.delta : null;
      return delta?.type === 'text_delta' && typeof delta.text === 'string' ? [{ type: 'delta', text: delta.text }] : [];
    }
    case 'assistant': {
      // Tool calls, by name only, so the app can count native web use (#42).
      const content = Array.isArray(value.message?.content) ? value.message.content : [];
      return content.filter(block => block?.type === 'tool_use' && typeof block.name === 'string').map(block => ({ type: 'tool', name: block.name }));
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
