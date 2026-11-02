// Codex adapter. Runs `codex exec --json` with the owner's own CODEX_HOME. Sign-in happens
// only through OpenAI's own flow (`codex login --device-auth`), run by the owner.
// Event names differ slightly between Codex releases; both known spellings are accepted.
// Verified against codex-cli 0.166.0 (signed-out paths; signed-in turn pending owner sign-in).

export const name = 'codex';

export function command({ binary = 'codex', home, resume, model, systemPrompt }) {
  const args = ['exec'];
  if (resume) args.push('resume', resume);
  // `exec resume` has no --sandbox flag; the config override works for both forms.
  // The companion keeps its own files (soul, memory, diary) in its workspace: writes are allowed there only.
  args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"');
  if (model) args.push('--model', model);
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
