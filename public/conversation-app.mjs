import { createConversationClient, USER_CHARS, USER_BYTES } from './conversation-client.mjs';

const element = id => document.getElementById(id);
const client = createConversationClient();
const activeRequests = new Set();
const messageNodes = new Map();
const threadNodes = new Map();
const errors = {
  INVALID_REQUEST: `Use a message of 1–${USER_CHARS.toLocaleString('en')} characters.`,
  BUSY: 'Wait for the current reply to finish.', NOT_READY: 'Open the conversation first.',
  ACCESS_DENIED: 'Access ended. Open a fresh connection to continue.',
  UNAVAILABLE: 'The demo is unavailable. Open it again to recheck.',
  NETWORK_ERROR: 'The connection was interrupted. Your pending action may need a retry.',
  INVALID_RESPONSE: 'The demo response could not be verified. Open a fresh connection.',
  RESYNC_REQUIRED: 'The conversation needs a fresh connection. Open the demo again.',
  CONFLICT: 'The pending action conflicts with committed state. Open a fresh connection.'
};
let mode = null, opened = false, opening = false, epoch = 0, pollTimer, pollDelay, polling = false, pollCount = 0;
let notice = '', previousThread = null, previousAnnouncement = '', previousTurn = null;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };
const RUNTIME_TEXT = {
  ready: name => `Your own ${name} answers here. Replies use your ${name} plan.`,
  'signed-out': name => `Your ${name} account is not signed in on the server yet. Ask the admin to sign it in.`,
  unconfigured: () => 'No agent is configured for your account yet. Ask the admin to add you.',
  'provider-missing': name => `The ${name} program is not installed on the server. Ask the admin.`
};
const live = () => mode === 'account' && opened && state.opened && !state.synthetic;
const providerName = () => PROVIDER_NAMES[state.runtime?.provider] ?? 'agent';
function turnErrorText(error) {
  if (!error) return 'The reply ended with an error.';
  let text = error.message;
  if (error.resetsAt) {
    const reset = new Date(error.resetsAt);
    if (!Number.isNaN(reset.getTime())) text += ` Resets ${reset.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`;
  }
  return text;
}
let state = client.getState();

function announce(text) {
  if (text !== previousAnnouncement) { element('announcement').textContent = text; previousAnnouncement = text; }
}

function textWithLinks(container, text) {
  container.replaceChildren();
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const candidate = match[0].replace(/[.,;!?]+$/, '');
    container.append(document.createTextNode(text.slice(offset, match.index)));
    let url;
    try { url = new URL(candidate); } catch { /* Invalid URLs remain plain text. */ }
    if (url && ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) {
      const link = document.createElement('a');
      link.href = url.href; link.textContent = candidate;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
      container.append(link, document.createTextNode(match[0].slice(candidate.length)));
    } else container.append(document.createTextNode(match[0]));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

function renderMessages(messages, visible) {
  const pane = element('history-pane'), list = element('message-list');
  const follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80 || previousThread !== state.threadId;
  const retained = new Set();
  for (const [index, message] of (visible ? messages : []).entries()) {
    retained.add(message.id);
    let entry = messageNodes.get(message.id);
    if (!entry) {
      const node = document.createElement('li'), heading = document.createElement('h3'), body = document.createElement('p');
      node.className = 'message'; heading.className = 'message-heading'; body.className = 'message-body';
      node.append(heading, body); entry = { node, heading, body, text: null }; messageNodes.set(message.id, entry);
    }
    entry.node.dataset.role = message.role;
    entry.heading.textContent = state.synthetic ? (message.role === 'user' ? 'You · demo' : 'Demo reply · no AI')
      : message.role === 'user' ? 'You' : `Companion · ${providerName()}`;
    if (entry.text !== message.text) { textWithLinks(entry.body, message.text); entry.text = message.text; }
    if (list.children[index] !== entry.node) list.insertBefore(entry.node, list.children[index] ?? null);
  }
  for (const [id, entry] of messageNodes) if (!retained.has(id)) { entry.node.remove(); messageNodes.delete(id); }
  element('empty-state').hidden = visible && messages.length > 0;
  previousThread = visible ? state.threadId : null;
  if (follow && visible) pane.scrollTop = pane.scrollHeight;
}

function renderThreads(threads, usable) {
  const list = element('thread-list'), select = element('thread-select'), retained = new Set();
  if (threads.length && select.firstElementChild?.value === '') select.firstElementChild.remove();
  for (const [index, thread] of threads.entries()) {
    retained.add(thread.id);
    let entry = threadNodes.get(thread.id);
    if (!entry) {
      const item = document.createElement('li'), button = document.createElement('button'), option = document.createElement('option');
      button.type = 'button'; button.addEventListener('click', () => selectThread(thread.id));
      option.value = thread.id; item.append(button); entry = { item, button, option }; threadNodes.set(thread.id, entry);
    }
    if (entry.button.textContent !== thread.title) entry.button.textContent = thread.title;
    if (entry.option.textContent !== thread.title) entry.option.textContent = thread.title;
    entry.button.disabled = !usable;
    if (thread.id === state.threadId) entry.button.setAttribute('aria-current', 'true');
    else entry.button.removeAttribute('aria-current');
    if (list.children[index] !== entry.item) list.insertBefore(entry.item, list.children[index] ?? null);
    if (select.children[index] !== entry.option) select.insertBefore(entry.option, select.children[index] ?? null);
  }
  for (const [id, entry] of threadNodes) if (!retained.has(id)) {
    entry.item.remove(); entry.option.remove(); threadNodes.delete(id);
  }
  if (!threads.length && !select.firstElementChild) {
    const option = document.createElement('option'); option.value = ''; select.append(option);
  }
  if (!threads.length) select.firstElementChild.textContent = usable ? 'Start a conversation' : 'Not open yet';
  if (select.value !== (state.threadId ?? '') && document.activeElement !== select) select.value = state.threadId ?? '';
  select.disabled = !usable || !threads.length;
}

function render() {
  const demo = mode === 'demo', account = mode === 'account';
  const connected = (demo || account) && opened && state.opened === true && state.synthetic === demo;
  const visible = connected && ['ready', 'reconnecting'].includes(state.connection);
  const streaming = state.turn?.state === 'streaming';
  const busy = Boolean(state.pending) || streaming;
  const ready = connected && state.connection === 'ready';
  const usable = ready && !busy;
  const canWrite = demo || state.runtime?.state === 'ready';
  const name = providerName();
  const connectionLabels = demo
    ? { disconnected: 'Demo closed', loading: 'Opening demo', ready: 'Demo connected', reconnecting: 'Demo connection interrupted', unavailable: 'Demo unavailable', denied: 'Access ended' }
    : { disconnected: 'Not connected', loading: 'Connecting', ready: canWrite ? `${name} connected` : `${name} not ready`, reconnecting: 'Connection interrupted', unavailable: 'Conversation unavailable', denied: 'Signed out' };
  element('demo-notice').hidden = !demo;
  element('connection-label').textContent = demo || account ? connectionLabels[state.connection] ?? 'Not connected'
    : mode === 'unavailable' ? 'Conversation unavailable' : 'Checking service';
  element('connection-dot').dataset.ready = String(ready && canWrite);
  element('connection-heading').textContent = demo ? 'Try the conversation flow with synthetic replies.'
    : account ? (connected ? `Talking with your companion · ${name}` : 'Your personal companion.') : 'A conversation starts with a connection.';
  element('connection-description').textContent = notice || (demo
    ? opened ? 'This is a synthetic demo. Closing or hiding the page clears this tab’s messages and draft.' : 'Open the demo explicitly. Do not enter private details.'
    : account ? (connected ? (RUNTIME_TEXT[state.runtime?.state] ?? RUNTIME_TEXT.unconfigured)(name) + ' Conversations are kept on the server, for you only.'
      : state.connection === 'denied' ? 'Sign in on the platform, then open your conversations again.' : 'Open your conversations to continue.')
    : mode === 'unavailable' ? 'No conversation connection is configured. Return to the foundation for service status.' : 'Checking which mode this service supports…');
  element('open-button').hidden = !(demo || account) || (ready && pollCount < pollLimit());
  element('open-button').disabled = !(demo || account) || opening || state.connection === 'loading';
  element('open-button').textContent = demo ? (opened ? 'Reopen demo' : 'Open demo') : (opened ? 'Reconnect' : 'Open conversations');
  element('close-button').hidden = !demo || !opened;
  element('account-login').hidden = !account || state.connection !== 'denied';
  element('new-thread-button').disabled = !usable || !canWrite;
  const threads = visible ? state.threads : [];
  element('thread-count').textContent = String(threads.length);
  element('thread-empty').hidden = threads.length > 0;
  element('thread-empty').textContent = account ? 'No conversations yet.' : 'Open the demo to see synthetic threads.';
  element('sidebar-status').textContent = account ? (connected ? `Your companion uses your own ${name}.` : 'Your companion is not connected.') : 'Personal agent is not connected.';
  element('sidebar-detail').textContent = account ? 'Only you can see these conversations.' : 'This page currently offers a synthetic demo only.';
  element('thread-list').setAttribute('aria-label', account ? 'Conversations' : 'Demo threads');
  renderThreads(threads, usable);
  element('thread-heading').textContent = threads.find(thread => thread.id === state.threadId)?.title ?? 'Your conversation space';
  element('history-pane').setAttribute('aria-busy', String(state.connection === 'loading'));
  renderMessages(state.messages, visible);
  element('empty-heading').textContent = connected ? (demo ? 'What would you like to try?' : 'What’s on your mind?') : 'A little room to think.';
  element('empty-description').textContent = connected ? state.threadId
    ? (demo ? 'Write a sample message or paste a public link. Replies are synthetic; no AI is involved.' : `Write a message. Your companion answers with your own ${name}.`)
    : (demo ? 'Create a new demo thread to begin. Use sample text only.' : 'Start a new conversation to begin.')
    : account ? 'Open your conversations to continue.'
    : 'Open the synthetic demo to try threads, messages and links.';
  const composer = element('composer');
  if (composer.value !== state.draft) composer.value = state.draft;
  composer.disabled = !usable || !state.threadId || !canWrite;
  composer.placeholder = composer.disabled ? (account ? 'Open a conversation to write…' : 'Open a demo thread to write a synthetic message…')
    : demo ? 'Write sample text or a public link…' : 'Write a message…';
  const bytes = new TextEncoder().encode(composer.value).length;
  const invalid = composer.value.length > USER_CHARS || bytes > USER_BYTES;
  element('character-count').textContent = `${composer.value.length.toLocaleString('en')} / ${USER_CHARS.toLocaleString('en')}`;
  element('character-count').dataset.invalid = String(invalid);
  element('send-button').disabled = composer.disabled || invalid || !composer.value.trim();
  element('stop-button').hidden = !account || !connected || !streaming;
  element('stop-button').disabled = !ready || Boolean(state.turn?.stopping);
  element('retry-button').hidden = !(demo || account) || !opened || state.pending?.status !== 'uncertain';
  element('retry-button').textContent = state.pending?.action === 'createThread' ? 'Retry creating conversation' : 'Retry same message';
  const replyName = demo ? 'Synthetic reply' : 'Reply';
  const turnText = state.pending?.status === 'uncertain' ? 'Result uncertain. Retry safely checks the same action.'
    : state.connection === 'reconnecting' && state.error ? 'Connection interrupted. Reconnect to catch up.'
    : state.pending?.status === 'submitting' ? 'Sending…'
    : state.turn?.stopping && streaming ? 'Stopping…'
    : streaming || state.pending?.status === 'accepted' ? (demo ? 'Synthetic reply is arriving…' : `Your companion is writing…`)
    : state.turn?.state === 'complete' ? (demo ? 'Synthetic reply complete. No AI was called.' : 'Reply complete.')
    : state.turn?.state === 'cancelled' ? 'Stopped. What was written so far is kept.'
    : state.turn?.state === 'error' ? (demo ? 'The synthetic turn ended with an error.' : turnErrorText(state.turn.error))
    : state.error ? errors[state.error] ?? `${replyName} could not complete.` : 'No active reply.';
  const status = element('turn-status');
  status.textContent = turnText;
  status.dataset.error = String(state.turn?.state === 'error' || Boolean(state.error));
  announce(notice || (state.pending || state.turn || state.error ? turnText : element('connection-label').textContent));
}

function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; pollDelay = undefined; }
const pollLimit = () => mode === 'account' ? 1440 : 60;
function closeConversation(message = '') {
  epoch++; opening = false;
  activeRequests.forEach(controller => controller.abort()); activeRequests.clear();
  opened = false; stopPolling(); pollCount = 0; notice = message; client.disconnect();
}
function clearPage() {
  mode = null; closeConversation();
}
function schedulePoll() {
  if (!opened || !['demo', 'account'].includes(mode) || !state.threadId || state.connection !== 'ready' || document.visibilityState === 'hidden'
      || polling || state.pending?.status === 'uncertain') { stopPolling(); return; }
  const active = state.hasMore || state.turn?.state === 'streaming' || Boolean(state.pending);
  if (!active) pollCount = 0;
  if (active && pollCount >= pollLimit()) { stopPolling(); notice = 'The reply is taking longer than expected. Reconnect to catch up.'; render(); return; }
  const delay = active ? 500 : 2500;
  if (pollTimer !== undefined && pollDelay === delay) return;
  stopPolling(); pollDelay = delay;
  pollTimer = setTimeout(async () => {
    pollTimer = undefined; pollDelay = undefined;
    if (!opened || document.visibilityState === 'hidden') return;
    polling = true; if (active) pollCount++;
    try {
      await client.poll();
      // A finished reply may have renamed the conversation: reload the snapshot once.
      const finished = previousTurn?.state === 'streaming' && state.turn?.requestId === previousTurn.requestId && state.turn.state !== 'streaming';
      previousTurn = state.turn;
      if (finished && live()) await client.refresh();
    } catch { /* Fixed client state supplies the visible error. */ }
    finally { polling = false; schedulePoll(); }
  }, delay);
}
async function requestJson(path, options = {}) {
  const controller = new AbortController(); activeRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
      signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
    return { response, body: await response.json() };
  } finally { clearTimeout(timeout); activeRequests.delete(controller); }
}
async function loadMode() {
  const current = epoch;
  try {
    const { response, body } = await requestJson('api/status');
    if (current !== epoch || document.visibilityState === 'hidden') return false;
    if (!response.ok || !['demo', 'account', 'unavailable'].includes(body.service?.mode)) throw new Error();
    const previous = mode; mode = body.service.mode;
    if (mode === 'unavailable' || (previous && previous !== mode)) closeConversation(); else render();
    return true;
  } catch {
    if (current !== epoch || document.visibilityState === 'hidden') return false;
    mode = 'unavailable'; closeConversation('Service status could not be checked. Reload this page to try again.'); return false;
  }
}
async function act(action, focusComposer = false) {
  const current = epoch;
  notice = ''; pollCount = 0;
  try { await action(); }
  catch (error) { if (current === epoch) { notice = errors[error?.code] ?? 'The action could not complete.'; render(); } }
  previousTurn = state.turn;
  if (current !== epoch) return;
  if (focusComposer && opened && !element('composer').disabled && document.visibilityState !== 'hidden') element('composer').focus();
  schedulePoll();
}
async function selectThread(id) { if (opened) await act(() => client.select(id), true); }

client.subscribe(next => {
  if (opened && (next.connection === 'denied' || (next.connection === 'unavailable' && next.pending?.status !== 'uncertain'))) {
    const denied = next.connection === 'denied';
    closeConversation(denied ? (mode === 'account' ? 'Your platform session ended. Sign in again, then reopen.' : 'Access ended. Open a fresh connection to continue.')
      : 'The conversation is unavailable. Open it again to recheck.');
    if (denied) { state = { ...client.getState(), connection: 'denied' }; render(); }
    return;
  }
  state = next; render(); schedulePoll();
});
async function openConversation() {
  if (opening || document.visibilityState === 'hidden') return;
  const current = epoch; opening = true; notice = ''; render();
  try {
    if (!await loadMode() || !['demo', 'account'].includes(mode)) return;
    opened = true; await act(() => client.open(), true);
  } finally { if (current === epoch) { opening = false; render(); } }
}
element('open-button').addEventListener('click', openConversation);
element('stop-button').addEventListener('click', () => act(() => client.cancel()));
element('close-button').addEventListener('click', () => closeConversation('This tab is clear. Open the demo again when you are ready.'));
element('new-thread-button').addEventListener('click', () => act(() => client.create(mode === 'account' ? 'New conversation' : `Demo conversation ${state.threads.length + 1}`), true));
element('thread-select').addEventListener('change', event => selectThread(event.target.value));
element('composer').addEventListener('input', event => {
  try { client.setDraft(event.target.value); }
  catch { notice = errors.INVALID_REQUEST; render(); }
});
element('composer-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!element('send-button').disabled) act(() => client.send(element('composer').value));
});
element('composer').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault(); if (!element('send-button').disabled) element('composer-form').requestSubmit();
  }
});
element('retry-button').addEventListener('click', () => act(() => client.retry()));
// The demo keeps nothing once the page is hidden. Account conversations live on the server:
// hiding the page only pauses polling, and showing it again reloads the snapshot.
function resumeAccount() {
  if (mode !== 'account') return false;
  if (opened && state.opened && !polling && state.connection !== 'loading') act(() => client.refresh());
  else schedulePoll();
  return true;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { if (mode === 'account') stopPolling(); else clearPage(); return; }
  if (!resumeAccount()) loadMode();
});
window.addEventListener('pagehide', () => { if (mode === 'account') stopPolling(); else clearPage(); });
window.addEventListener('pageshow', event => { if (event.persisted && !resumeAccount()) { clearPage(); loadMode(); } });
loadMode().then(ok => { if (ok && mode === 'account') openConversation(); });
