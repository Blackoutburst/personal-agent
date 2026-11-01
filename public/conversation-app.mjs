import { createConversationClient } from './conversation-client.mjs';

const element = id => document.getElementById(id);
const client = createConversationClient();
const activeRequests = new Set();
const messageNodes = new Map();
const threadNodes = new Map();
const errors = {
  INVALID_REQUEST: 'Use a message of 1–1,000 characters.',
  BUSY: 'Wait for the current action to finish.', NOT_READY: 'Open the demo connection first.',
  ACCESS_DENIED: 'Access ended. Open a fresh connection to continue.',
  UNAVAILABLE: 'The demo is unavailable. Open it again to recheck.',
  NETWORK_ERROR: 'The connection was interrupted. Your pending action may need a retry.',
  INVALID_RESPONSE: 'The demo response could not be verified. Open a fresh connection.',
  RESYNC_REQUIRED: 'The conversation needs a fresh connection. Open the demo again.',
  CONFLICT: 'The pending action conflicts with committed state. Open a fresh connection.'
};
let mode = null, opened = false, opening = false, epoch = 0, pollTimer, pollDelay, polling = false, pollCount = 0;
let notice = '', checkingAccount = false, previousThread = null, previousAnnouncement = '';
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
    entry.heading.textContent = message.role === 'user' ? 'You · demo' : 'Demo reply · no AI';
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
  if (!threads.length) select.firstElementChild.textContent = usable ? 'Create a demo thread' : 'Open the demo first';
  if (select.value !== (state.threadId ?? '') && document.activeElement !== select) select.value = state.threadId ?? '';
  select.disabled = !usable || !threads.length;
}

function render() {
  const demo = mode === 'demo', connected = demo && opened && state.synthetic === true;
  const visible = connected && ['ready', 'reconnecting'].includes(state.connection);
  const busy = Boolean(state.pending) || state.turn?.state === 'streaming';
  const ready = connected && state.connection === 'ready';
  const usable = ready && !busy;
  const connectionLabels = { disconnected: 'Demo closed', loading: 'Opening demo', ready: 'Demo connected',
    reconnecting: 'Demo connection interrupted', unavailable: 'Demo unavailable', denied: 'Access ended' };
  element('demo-notice').hidden = !demo;
  element('connection-label').textContent = demo ? connectionLabels[state.connection] ?? 'Demo closed'
    : mode === 'account' ? 'Personal Codex not connected' : mode === 'unavailable' ? 'Conversation unavailable' : 'Checking service';
  element('connection-dot').dataset.ready = String(ready);
  element('connection-heading').textContent = demo ? 'Try the conversation flow with synthetic replies.'
    : mode === 'account' ? 'Platform sign-in and personal Codex are separate.' : 'A conversation starts with a connection.';
  element('connection-description').textContent = notice || (demo
    ? opened ? 'This is a synthetic demo. Closing or hiding the page clears this tab’s messages and draft.' : 'Open the demo explicitly. Do not enter private details.'
    : mode === 'account' ? 'You can check your platform sign-in. Personal Codex is not connected, so messaging is disabled.'
    : mode === 'unavailable' ? 'No conversation connection is configured. Return to the foundation for service status.' : 'Checking which mode this service supports…');
  element('open-button').hidden = !demo || (ready && pollCount < 60);
  element('open-button').disabled = !demo || opening || state.connection === 'loading';
  element('open-button').textContent = opened ? 'Reopen demo' : 'Open demo';
  element('close-button').hidden = !demo || !opened;
  element('account-button').hidden = mode !== 'account';
  element('account-button').disabled = checkingAccount;
  element('account-login').hidden = mode !== 'account';
  element('new-thread-button').disabled = !usable;
  const threads = visible ? state.threads : [];
  element('thread-count').textContent = String(threads.length);
  element('thread-empty').hidden = threads.length > 0;
  renderThreads(threads, usable);
  element('thread-heading').textContent = threads.find(thread => thread.id === state.threadId)?.title ?? 'Your conversation space';
  element('history-pane').setAttribute('aria-busy', String(state.connection === 'loading'));
  renderMessages(state.messages, visible);
  element('empty-heading').textContent = connected ? 'What would you like to try?' : 'A little room to think.';
  element('empty-description').textContent = connected ? state.threadId
    ? 'Write a sample message or paste a public link. Replies are synthetic; no AI is involved.'
    : 'Create a new demo thread to begin. Use sample text only.'
    : mode === 'account' ? 'Your platform account does not connect a personal Codex runtime. Messaging remains disabled.'
    : 'Open the synthetic demo to try threads, messages and links. Personal Codex is not connected.';
  const composer = element('composer');
  if (composer.value !== state.draft) composer.value = state.draft;
  composer.disabled = !usable || !state.threadId;
  composer.placeholder = composer.disabled ? 'Open a demo thread to write a synthetic message…' : 'Write sample text or a public link…';
  const bytes = new TextEncoder().encode(composer.value).length;
  const invalid = composer.value.length > 1000 || bytes > 4096;
  element('character-count').textContent = `${composer.value.length.toLocaleString()} / 1,000`;
  element('character-count').dataset.invalid = String(invalid);
  element('send-button').disabled = composer.disabled || invalid || !composer.value.trim();
  element('retry-button').hidden = !demo || !opened || state.pending?.status !== 'uncertain';
  element('retry-button').textContent = state.pending?.action === 'createThread' ? 'Retry creating thread' : 'Retry same message';
  const turnText = state.pending?.status === 'uncertain' ? 'Result uncertain. Retry safely checks the same action.'
    : state.connection === 'reconnecting' && state.error ? 'Connection interrupted. Reopen the demo to catch up.'
    : state.pending?.status === 'submitting' ? 'Sending demo action…'
    : state.turn?.state === 'streaming' || state.pending?.status === 'accepted' ? 'Synthetic reply is arriving…'
    : state.turn?.state === 'complete' ? 'Synthetic reply complete. No AI was called.'
    : state.turn?.state === 'error' ? 'The synthetic turn ended with an error.'
    : state.error ? errors[state.error] ?? 'The demo action could not complete.' : 'No active turn.';
  element('turn-status').textContent = turnText;
  announce(notice || (state.pending || state.turn || state.error ? turnText : element('connection-label').textContent));
}

function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; pollDelay = undefined; }
function closeConversation(message = '') {
  epoch++; opening = false; checkingAccount = false;
  activeRequests.forEach(controller => controller.abort()); activeRequests.clear();
  opened = false; stopPolling(); pollCount = 0; notice = message; client.disconnect();
}
function clearPage() {
  mode = null; closeConversation();
}
function schedulePoll() {
  if (!opened || mode !== 'demo' || !state.threadId || state.connection !== 'ready' || document.visibilityState === 'hidden'
      || polling || state.pending?.status === 'uncertain') { stopPolling(); return; }
  const active = state.hasMore || state.turn?.state === 'streaming' || Boolean(state.pending);
  if (!active) pollCount = 0;
  if (active && pollCount >= 60) { stopPolling(); notice = 'The demo reply is taking longer than expected. Reopen the demo to reconcile its state.'; render(); return; }
  const delay = active ? 500 : 2500;
  if (pollTimer !== undefined && pollDelay === delay) return;
  stopPolling(); pollDelay = delay;
  pollTimer = setTimeout(async () => {
    pollTimer = undefined; pollDelay = undefined;
    if (!opened || document.visibilityState === 'hidden') return;
    polling = true; if (active) pollCount++;
    try { await client.poll(); } catch { /* Fixed client state supplies the visible error. */ }
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
    mode = body.service.mode;
    if (mode !== 'demo') closeConversation(); else render();
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
  catch (error) { if (current === epoch) { notice = errors[error?.code] ?? 'The demo action could not complete.'; render(); } }
  if (current !== epoch) return;
  if (focusComposer && opened && !element('composer').disabled && document.visibilityState !== 'hidden') element('composer').focus();
  schedulePoll();
}
async function selectThread(id) { if (opened) await act(() => client.select(id), true); }

client.subscribe(next => {
  if (opened && (next.connection === 'denied' || (next.connection === 'unavailable' && next.pending?.status !== 'uncertain'))) {
    closeConversation(next.connection === 'denied' ? 'Access ended. Open a fresh connection to continue.' : 'The demo is unavailable. Open it again to recheck.');
    return;
  }
  state = next; render(); schedulePoll();
});
element('open-button').addEventListener('click', async () => {
  if (opening || document.visibilityState === 'hidden') return;
  const current = epoch; opening = true; notice = ''; render();
  try {
    if (!await loadMode() || mode !== 'demo') return;
    opened = true; await act(() => client.open(), true);
  } finally { if (current === epoch) { opening = false; render(); } }
});
element('close-button').addEventListener('click', () => closeConversation('This tab is clear. Open the demo again when you are ready.'));
element('new-thread-button').addEventListener('click', () => act(() => client.create(`Demo conversation ${state.threads.length + 1}`), true));
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
element('account-button').addEventListener('click', async () => {
  const current = epoch; checkingAccount = true; notice = 'Checking your current platform sign-in…'; client.clear(); render();
  try {
    const { response, body } = await requestJson('api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (current !== epoch || document.visibilityState === 'hidden') return;
    if (response.ok && typeof body.companionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.companionId)
        && body.provider?.state === 'unavailable' && body.runtime?.state === 'unavailable') {
      notice = 'Your invited platform sign-in is verified. Personal Codex is not connected; messaging remains disabled.';
    } else {
      client.clear(); notice = [401, 403].includes(response.status) ? 'Platform access was denied. Check your sign-in and invitation.' : 'Platform sign-in could not be verified. Please try again.';
    }
  } catch { if (current === epoch) notice = 'Platform sign-in could not be checked. Please try again.'; }
  finally { if (current === epoch) { checkingAccount = false; render(); } }
});
document.addEventListener('visibilitychange', () => {
  clearPage(); if (document.visibilityState !== 'hidden') loadMode();
});
window.addEventListener('pagehide', clearPage);
window.addEventListener('pageshow', event => { if (event.persisted) { clearPage(); loadMode(); } });
loadMode();
