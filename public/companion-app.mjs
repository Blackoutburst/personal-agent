// The companion web app: one ongoing chat with your companion, what it remembers, and how it looks.
import { createConversationClient, createFileTransport, AttachmentError, USER_CHARS } from './conversation-client.mjs';
import { renderCharacter, CHARACTERS, COLORS, OUTFITS, HAS_OUTFITS } from './companion-character.mjs';
import { createRemindersUI } from './reminders-ui.mjs';
import { createCalendarUI } from './calendar-ui.mjs';
import { createMemoryUI } from './memory-ui.mjs';
import { createPersonalityUI } from './personality-ui.mjs';
import { createContactUI, renderPeerCard } from './contact-ui.mjs';
import { createWeatherUI } from './weather-ui.mjs';

const $ = id => document.getElementById(id);
const client = createConversationClient();
const fileTransport = createFileTransport();
const calendarUI = createCalendarUI({ document, visible: () => view === 'watches' });
const remindersUI = createRemindersUI({ document, visible: () => view === 'watches' || (view === 'me' && meSection === 'settings') });
const memoryUI = createMemoryUI({ document, api, onDenied: fileAccessDenied });
const personalityUI = createPersonalityUI({ document, api, onDenied: fileAccessDenied });
const contactUI = createContactUI({ document, api, onDenied: fileAccessDenied });
const weatherUI = createWeatherUI({ document, api, onDenied: fileAccessDenied, onWearing: next => { wearing = next; renderAll(); } });
const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

let profile = null, runtime = null, view = 'loading', chatOpened = false, state = client.getState();
let wearing = 'base', draftLook = null, pollTimer = null, polling = false, happyUntil = 0, lastTurnKey = null;
const messageNodes = new Map();
let uploads = [], uploadEpoch = 0, fileNotice = '', uploadsKey = '';
let ownerEpoch = 0, startRequest = 0, lookRequest = 0, wearingRequest = 0, composerEpoch = 0, sessionDenied = false;
let readTicket = null, readSequence = 0, readFailures = 0, initialThreadAttempted = false, heldDraft = null;
const READ_BACKOFF = [1000, 2000, 5000, 10000, 30000];
const reconnect = el('button', { id: 'reconnect-chat', type: 'button', className: 'text-button', textContent: 'Reconnect chat', hidden: true });
const kept = el('div', { className: 'held-draft', hidden: true }), keptText = el('pre'), restoreDraft = el('button', { type: 'button', className: 'text-button', textContent: 'Restore unsent message' });
const dismissDraft = el('button', { type: 'button', className: 'text-button', textContent: 'Dismiss kept message' });
kept.append(el('p', { textContent: 'This message was not sent. Your newer draft is unchanged. Copy it below, or clear the composer to restore it.' }), keptText, restoreDraft, dismissDraft);
document.querySelector('.conversation-actions').append(reconnect);
$('composer').before(kept);

// ---------- Small helpers ----------

async function api(body) {
  const response = await fetch('api/companion', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) { const error = new Error(data?.error?.code ?? 'UNAVAILABLE'); error.status = response.status; throw error; }
  return data;
}
const companionName = () => profile?.name ?? 'Your companion';
const providerName = () => ({ claude: 'Claude', codex: 'ChatGPT' })[runtime?.provider] ?? 'AI';
function applyColors(look) {
  const colors = COLORS[look?.color] ?? COLORS.peach, root = document.documentElement.style;
  root.setProperty('--body', colors.body); root.setProperty('--shade', colors.shade); root.setProperty('--light', colors.light);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.light);
}
// The outfit shown: a pinned one, else what the server says she wears now.
function outfitOf(look) { return look?.outfit && look.outfit !== 'auto' ? look.outfit : wearing; }
function draw(element, look, mood, feeling = null) {
  const markup = renderCharacter({ character: look?.character ?? 'pip', color: look?.color ?? 'peach', mood, title: look?.name ?? '',
    outfit: outfitOf(look), feeling });
  if (element.dataset.markup !== markup) { element.innerHTML = markup; element.dataset.markup = markup; }
}
// Text with clickable links and simple **bold** / *italic*, built from text nodes only.
function textWithLinks(container, text) {
  container.replaceChildren();
  for (const part of text.split(/(\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\n]+\*(?![\w*]))/)) {
    if (/^\*\*[^*\n]+\*\*$/.test(part)) { const strong = document.createElement('strong'); linkify(strong, part.slice(2, -2)); container.append(strong); }
    else if (/^\*[^*\n]+\*$/.test(part)) { const em = document.createElement('em'); linkify(em, part.slice(1, -1)); container.append(em); }
    else linkify(container, part);
  }
}
// [label](https://…) shows the label; bare http(s) URLs show themselves. Anything else stays text.
function linkify(container, text) {
  let offset = 0;
  for (const match of text.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"']+)\)|https?:\/\/[^\s<>"']+/gi)) {
    const labelled = match[1] !== undefined;
    const candidate = labelled ? match[2] : match[0].replace(/[.,;!?)]+$/, '');
    container.append(document.createTextNode(text.slice(offset, match.index)));
    let url = null;
    try { url = new URL(candidate); } catch { /* stays text */ }
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      const link = document.createElement('a');
      link.href = url.href; link.textContent = labelled ? match[1] : candidate; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
      container.append(link, document.createTextNode(labelled ? '' : match[0].slice(candidate.length)));
    } else container.append(document.createTextNode(match[0]));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

// ---------- Views ----------

// Views: chat, watches, me (memories, the companion's look and settings), plus first-run setup ('look' alone).
// The Me tab has sub-pages like the Android app: #me (memories), #me/companion and #me/settings.
let meSection = 'memories';
const lookShown = () => view === 'look' || (view === 'me' && meSection === 'companion');
const connectorsShown = () => view === 'me' && meSection === 'connectors';
function show(next) {
  view = next;
  if (!connectorsShown()) { clearTimeout(discordTimer); discordTimer = null; }
  $('app').dataset.view = next;
  for (const name of ['loading', 'gate', 'chat', 'watches']) $(`view-${name}`).hidden = name !== next;
  $('view-me').hidden = next !== 'me' && next !== 'look';
  $('me-tabs').hidden = next !== 'me';
  $('view-look').hidden = !lookShown();
  $('view-memories').hidden = !(next === 'me' && meSection === 'memories');
  $('view-settings').hidden = !(next === 'me' && meSection === 'settings');
  $('view-connectors').hidden = !connectorsShown();
  for (const link of document.querySelectorAll('#me-tabs a')) {
    if (next === 'me' && link.dataset.section === meSection) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('nav').hidden = !profile || next === 'gate' || next === 'loading';
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (next === 'chat') openChat();
  if (next === 'me' && meSection === 'memories') loadMemories();
  if (connectorsShown()) { $('discord-pick').hidden = false; void loadConnectors(); void loadDiscord(); }
  if (lookShown()) startLook();
  if (next === 'watches' || (next === 'me' && meSection === 'settings')) void remindersUI.show();
  if (next === 'watches') void calendarUI.show();
  if (next === 'me' && meSection === 'settings') { $('theme-pick').hidden = false; renderThemePick(); }
  renderAll();
}

function gate(title, text, { signIn = false, retry = false } = {}) {
  $('gate-title').textContent = title; $('gate-text').textContent = text;
  $('gate-signin').hidden = !signIn; $('gate-retry').hidden = !retry;
  draw($('gate-character'), profile ?? { character: 'pip', color: 'peach' }, signIn ? 'sleepy' : 'thinking');
  show('gate');
}

function route() {
  if (!profile) return show('look');
  const hash = location.hash.replace('#', '');
  // #memories and #look are older links into what is now the Me tab.
  const me = { me: 'memories', memories: 'memories', 'me/companion': 'companion', look: 'companion', 'me/connectors': 'connectors', 'me/settings': 'settings' }[hash];
  if (me) meSection = me;
  show(hash === 'watches' ? 'watches' : me ? 'me' : 'chat');
}

async function start() {
  resetShell(false);
  const owner = ownerEpoch, token = ++startRequest;
  try {
    const data = await api({ action: 'get' });
    if (owner !== ownerEpoch || token !== startRequest) return;
    profile = data.profile; runtime = data.runtime; wearing = data.wearing ?? 'base';
    applyColors(profile);
    route();
  } catch (error) {
    if (owner !== ownerEpoch || token !== startRequest) return;
    if (error.status === 401 || error.status === 403) fileAccessDenied(error.message);
    else gate('Hmm, I can’t reach your companion', 'The server didn’t answer. Check your connection and try again.', { retry: true });
  }
}

// ---------- Mood ----------

function lastAssistantFor(requestId) { return [...state.messages].reverse().find(m => m.role === 'assistant' && m.requestId === requestId); }
function mood() {
  if (lookShown()) return 'happy';
  const turn = state.turn;
  if (turn?.state === 'streaming' || state.pending) return turn && lastAssistantFor(turn.requestId)?.text ? 'talking' : 'thinking';
  if (Date.now() < happyUntil) return 'happy';
  if (document.activeElement === $('input') && $('input').value.trim()) return 'listening';
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return 'sleepy';
  return 'idle';
}
// The face the companion chose for the reply it is writing, or has just written.
function feeling() {
  const turn = state.turn;
  if (!turn) return null;
  if (turn.state === 'streaming' || (turn.state === 'complete' && Date.now() < happyUntil)) return lastAssistantFor(turn.requestId)?.feeling ?? null;
  return null;
}
const MOOD_TEXT = { idle: 'Here with you', listening: 'Listening…', thinking: 'Thinking…', talking: 'Writing to you…', happy: 'Happy to see you', sleepy: 'A bit sleepy' };

// ---------- Chat ----------

async function openChat() {
  if (chatOpened) return;
  chatOpened = true;
  return readChat();
}

const canRead = () => !sessionDenied && profile && chatOpened && document.visibilityState !== 'hidden' && navigator.onLine !== false;
async function readChat() {
  if (!canRead() || readTicket) return;
  clearTimeout(pollTimer); pollTimer = null;
  const ticket = { owner: ownerEpoch, sequence: ++readSequence }; readTicket = ticket; polling = true; renderAll();
  const before = state.turn;
  try {
    if (state.pending && !state.opened) return;
    if (!state.opened) await client.open();
    else if (state.connection !== 'ready' || !state.threadId) await client.refresh();
    else await client.poll();
    if (ticket.owner !== ownerEpoch || readTicket !== ticket) return;
    // Initial creation is attempted once. Reads never replay it or any other write.
    if (state.connection === 'ready' && state.threadId === null && !state.pending && !initialThreadAttempted && canRead()) {
      initialThreadAttempted = true; await client.create('Companion');
    }
    if (ticket.owner !== ownerEpoch || readTicket !== ticket) return;
    if (state.connection === 'ready') { readFailures = 0; await remindersUI.refreshIfOpen(); await calendarUI.refreshIfOpen(); }
    else readFailures++;
    if (before?.state === 'streaming' && state.turn?.requestId === before.requestId && state.turn.state === 'complete') happyUntil = Date.now() + 5000;
  } catch { if (ticket.owner === ownerEpoch && readTicket === ticket) readFailures++; }
  finally {
    if (ticket.owner === ownerEpoch && readTicket === ticket) { readTicket = null; polling = false; renderAll(); schedulePoll(); }
  }
}
function schedulePoll() {
  clearTimeout(pollTimer); pollTimer = null;
  if (!canRead() || readTicket || state.connection === 'loading' || state.pending && !state.opened) return;
  const recovering = state.connection !== 'ready';
  if (recovering && readFailures > READ_BACKOFF.length) return;
  if (!recovering && !state.threadId) return;
  const active = state.turn?.state === 'streaming' || Boolean(state.pending) || state.hasMore;
  const owner = ownerEpoch, sequence = ++readSequence;
  pollTimer = setTimeout(() => { pollTimer = null; if (owner === ownerEpoch && sequence === readSequence) void readChat(); },
    recovering ? READ_BACKOFF[Math.max(0, readFailures - 1)] : active ? 500 : 3000);
}

function dayLabel(date) {
  const today = new Date(), yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderMessages() {
  const list = $('messages'), history = $('history');
  const follow = history.scrollHeight - history.scrollTop - history.clientHeight < 120;
  const keep = new Set();
  let index = 0;
  for (const message of state.messages) {
    if (!message.text && !message.attachments?.length) continue;
    keep.add(message.id);
    let node = messageNodes.get(message.id);
    if (!node) {
      node = document.createElement('li');
      node.className = message.role === 'peer' ? `bubble peer-card ${message.peer.direction}` : `bubble ${message.role === 'user' ? 'user' : 'companion'}`;
      if (message.role === 'peer') node.append(renderPeerCard(document, message));
      else node.append(el('div', { className: 'message-text' }), el('div', { className: 'message-files' }));
      messageNodes.set(message.id, node);
    }
    if (message.role !== 'peer') {
      if (node.dataset.text !== message.text) { textWithLinks(node.querySelector('.message-text'), message.text); node.dataset.text = message.text; }
      const filesKey = JSON.stringify(message.attachments ?? []);
      if (node.dataset.files !== filesKey) {
        node.querySelector('.message-files').replaceChildren(...(message.attachments ?? []).map(fileView)); node.dataset.files = filesKey;
      }
    }
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    index++;
  }
  for (const [id, node] of messageNodes) if (!keep.has(id)) { node.remove(); messageNodes.delete(id); }
  const busy = state.turn?.state === 'streaming' || Boolean(state.pending);
  $('typing').hidden = !(busy && !(state.turn && lastAssistantFor(state.turn.requestId)?.text));
  $('welcome').hidden = index > 0 || state.connection === 'loading';
  $('welcome-text').textContent = `Say hi to ${companionName()} 👋 ${companionName()} remembers what matters to you, so tell them about your day.`;
  if (follow) history.scrollTop = history.scrollHeight;
}

function turnNote() {
  const turn = state.turn;
  if (turn?.state === 'error') {
    const error = turn.error ?? {}, name = companionName();
    if (error.code === 'USAGE_LIMIT') {
      const reset = error.resetsAt ? new Date(error.resetsAt) : null;
      const when = reset && !Number.isNaN(reset.getTime()) ? reset.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : 'soon';
      return `${name} needs a little rest: your ${providerName()} plan's limit is reached. Back ${when}.`;
    }
    if (error.code === 'NOT_SIGNED_IN') return runtime?.state === 'ready'
      ? `${name}'s earlier reply could not start because the ${providerName()} account needed sign-in. It is connected now; send again when you’re ready.`
      : `${name} can't think right now: the ${providerName()} account on the server needs to be signed in again.`;
    if (error.code === 'NO_RUNTIME' || error.code === 'PROVIDER_MISSING') return runtime?.state === 'ready'
      ? `${name}'s earlier reply could not start because the provider was not set up. It is connected now; send again when you’re ready.`
      : `${name} isn't set up yet. Ask the server admin to finish the setup.`;
    if (error.code === 'INTERRUPTED') return `${name} got interrupted. Could you say that again?`;
    return `${name} couldn't answer that time. Try again in a moment.`;
  }
  if (state.error === 'ACCESS_DENIED') return 'You were signed out. Reload the page to sign in again.';
  if (navigator.onLine === false) return 'You’re offline. Reconnect to load your chat; no message will be sent automatically.';
  if (state.error === 'BUSY' || state.error === 'CONFLICT') return 'This message was not sent because the conversation changed or another reply is running. Your unsent text is kept; review the current chat before sending again.';
  if (state.connection === 'reconnecting' || state.connection === 'unavailable') return readTicket ? 'Reconnecting to your chat…'
    : state.pending && !state.opened ? 'The conversation request could not be confirmed. Use Retry pending request to retry its exact key.'
      : readFailures > READ_BACKOFF.length ? 'Connection lost. Select Reconnect chat to try again.' : 'Connection lost. A read-only reconnect is scheduled.';
  if (turn?.state === 'cancelled') return 'This reply was stopped. Any partial answer above may be incomplete.';
  if (runtime && runtime.state !== 'ready' && runtime.state !== undefined) {
    if (runtime.state === 'signed-out') return `${companionName()} is asleep: the ${providerName()} account on the server needs to be signed in.`;
    return `${companionName()} isn't set up yet. Ask the server admin to finish the setup.`;
  }
  return null;
}

function renderChat() {
  renderMessages();
  const note = turnNote();
  $('note').hidden = !note; $('note').textContent = note ?? '';
  const streaming = state.turn?.state === 'streaming';
  const ready = state.connection === 'ready' && state.threadId !== null;
  $('stop').hidden = !streaming;
  $('stop').disabled = Boolean(state.turn?.stopping);
  $('send').hidden = streaming;
  const input = $('input');
  if (input.value !== state.draft && document.activeElement !== input) input.value = state.draft;
  const completed = uploads.filter(item => item.status === 'ready');
  const waiting = uploads.some(item => item.status !== 'ready' || item.removing);
  $('send').disabled = !ready || Boolean(state.pending) || Boolean(heldDraft) || streaming || waiting || (!input.value.trim() && !completed.length) || input.value.length > USER_CHARS;
  $('attach').disabled = !ready || Boolean(state.pending) || streaming || uploads.length >= 8;
  $('file-picker').disabled = $('attach').disabled;
  $('retry-send').hidden = state.pending?.status !== 'uncertain';
  const archived = state.archivedAt !== null;
  $('new-chat').disabled = !ready || archived || state.synthetic || Boolean(state.pending) || streaming || state.messages.length === 0;
  $('past-chats').disabled = state.synthetic || sessionDenied;
  $('archived-banner').hidden = !archived;
  if (archived) $('archived-text').textContent = `Archived chat · ended ${new Date(state.archivedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · read-only`;
  $('composer').hidden = archived;
  reconnect.hidden = sessionDenied || Boolean(state.pending && !state.opened) || (!readFailures && state.connection === 'ready'); reconnect.disabled = Boolean(readTicket) || navigator.onLine === false;
  kept.hidden = !heldDraft; keptText.textContent = heldDraft?.text ?? ''; restoreDraft.disabled = Boolean(input.value) || Boolean(state.pending);
  input.placeholder = `Write to ${companionName()}…`;
  renderUploads();
}

function grow() { const input = $('input'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }

// ---------- Conversation files ----------

function fileSize(size) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`; }
function clearFullImage() {
  const dialog = $('full-image-dialog'); if (dialog.open) dialog.close();
  $('full-image').removeAttribute('src'); $('full-image').alt = '';
  $('full-image-title').textContent = ''; $('full-image-caption').textContent = '';
}
function showFullImage(file) {
  $('full-image-title').textContent = file.name; $('full-image').alt = file.name;
  $('full-image').src = file.url.slice(1);
  $('full-image-caption').textContent = file.caption ?? ''; $('full-image-caption').hidden = !file.caption;
  $('full-image-dialog').showModal();
}
function fileView(file) {
  const box = el('div', { className: 'shared-file' });
  // DTO paths are validated /api/files/<id>; strip the leading slash to preserve the app's proxy mount.
  const url = file.url.slice(1);
  let media;
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime)) {
    const image = el('img', { src: url, alt: file.name, loading: 'lazy', decoding: 'async' });
    media = el('button', { type: 'button', className: 'file-image', ariaLabel: `Open image ${file.name}` }, image);
    media.addEventListener('click', () => showFullImage(file));
  } else if (['video/mp4', 'video/webm'].includes(file.mime)) {
    media = el('video', { src: url, controls: true, preload: 'metadata', playsInline: true });
    media.setAttribute('aria-label', file.name);
  } else if (['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'].includes(file.mime)) {
    media = el('audio', { src: url, controls: true, preload: 'metadata' }); media.setAttribute('aria-label', file.name);
  }
  if (media) box.append(media);
  box.append(el('a', { href: url, download: file.name, className: 'file-download', textContent: `${file.name} · ${fileSize(file.size)}` }));
  if (file.caption) box.append(el('p', { className: 'file-caption', textContent: file.caption }));
  return box;
}
function syncFiles() {
  if (state.opened && state.threadId && state.connection === 'ready') client.setFiles(uploads.filter(item => item.status === 'ready').map(item => item.dto));
}
function fileAccessDenied(code = 'AUTHENTICATION_REQUIRED') {
  if (sessionDenied) return;
  resetShell(true);
  // Each refusal says what actually happened, so a wrong account or a blocked browser request isn't mistaken for signing out.
  if (code === 'INVITATION_REQUIRED') gate('This account has no companion', 'You are signed in with a Blackoutburst account that isn’t invited. Sign in with your invited account.', { signIn: true });
  else if (code === 'ORIGIN_REJECTED') gate('Your browser blocked the request', 'Open the companion directly at blackoutburst.com/personal-agent-preview/ and try again.', { retry: true });
  else gate('Your session ended', 'Sign in with your Blackoutburst account to see your companion.', { signIn: true });
}
function resetShell(denied) {
  ownerEpoch++; startRequest++; lookRequest++; wearingRequest++; discordRequest++; composerEpoch++; readSequence++;
  sessionDenied = denied; profile = null; runtime = null; draftLook = null; heldDraft = null; chatOpened = false;
  initialThreadAttempted = false; readFailures = 0; readTicket = null; polling = false;
  clearTimeout(pollTimer); pollTimer = null; clearTimeout(discordTimer); discordTimer = null;
  discord = null; discordBusy = false; discordLoading = false; discordError = '';
  const tokenInput = $('discord-token'); if (tokenInput) tokenInput.value = '';
  $('discord-body').replaceChildren(); $('name').value = ''; $('input').value = ''; $('look-error').textContent = ''; $('look-error').hidden = true;
  for (const id of ['look-preview', 'stage-character']) { $(id).replaceChildren(); $(id).dataset.markup = ''; }
  $('stage-name').textContent = ''; $('stage-mood').textContent = '';
  for (const id of ['pick-character', 'pick-color', 'pick-outfit']) $(id).replaceChildren();
  for (const id of ['discord-pick', 'android-pick']) $(id).hidden = true;
  connectors = null; connectorsBusy = false; connectorsRequest++; connectorsError = ''; $('connector-list').replaceChildren(); $('connectors-note').textContent = '';
  kept.hidden = true; keptText.textContent = ''; reconnect.hidden = true;
  memoryUI.clear(); personalityUI.clear(); contactUI.clear(); weatherUI.clear(); remindersUI.clear(); calendarUI.clear(); client.clear(); clearUploads(); clearFullImage();
}
function clearUploads() {
  uploadEpoch++;
  for (const item of uploads) item.controller?.abort();
  uploads = []; fileNotice = ''; renderUploads();
}
function renderUploads() {
  const root = $('uploads'); root.hidden = !uploads.length;
  $('file-note').hidden = !fileNotice; $('file-note').textContent = fileNotice;
  const key = JSON.stringify([Boolean(state.pending), uploads.map(item => [item.requestId, item.status, item.progress, item.error, item.dto?.id, item.removing]), fileNotice]);
  if (key === uploadsKey) return;
  uploadsKey = key;
  root.replaceChildren(...uploads.map(item => {
    const row = el('li', { className: 'upload' }), info = el('div', { className: 'upload-info' });
    info.append(el('strong', { textContent: item.file.name }));
    if (item.status === 'ready') info.append(fileView(item.dto));
    else if (item.status === 'uploading') info.append(el('span', { textContent: `Uploading ${item.progress}% · ${fileSize(item.file.size)}` }),
      el('progress', { max: 100, value: item.progress, ariaLabel: `Uploading ${item.file.name}` }));
    else info.append(el('span', { className: 'upload-error', textContent: item.error ?? 'Upload cancelled.' }));
    row.append(info);
    if (['error', 'cancelled'].includes(item.status)) {
      const retry = el('button', { type: 'button', className: 'text-button', textContent: 'Retry', disabled: Boolean(state.pending) });
      retry.addEventListener('click', () => uploadFile(item)); row.append(retry);
    }
    const remove = el('button', { type: 'button', className: 'text-button', textContent: item.removing ? 'Removing…' : item.status === 'uploading' ? 'Cancel' : 'Remove', disabled: Boolean(state.pending) || Boolean(item.removing) });
    remove.addEventListener('click', async () => {
      if (item.status === 'uploading') { item.controller.abort(); return; }
      const version = uploadEpoch; item.removing = true; renderChat();
      try {
        if (item.dto) await fileTransport.remove(item.dto.id, { knownPending: true });
        if (version !== uploadEpoch) return;
        uploads = uploads.filter(value => value !== item); fileNotice = ''; syncFiles(); renderChat();
      } catch (error) {
        if (version !== uploadEpoch) return;
        if (error?.code === 'ACCESS_DENIED') { fileAccessDenied(); return; }
        fileNotice = 'That file could not be removed. Try Remove again.'; renderChat();
      } finally { if (version === uploadEpoch) { item.removing = false; renderChat(); } }
    });
    row.append(remove); return row;
  }));
}
async function uploadFile(item) {
  if (!uploads.includes(item) || state.connection !== 'ready' || state.pending || state.threadId !== item.threadId) return;
  const version = uploadEpoch; item.controller = new AbortController(); item.status = 'uploading'; item.progress = 0; item.error = null; renderChat();
  try {
    const dto = await fileTransport.upload(item.file, { threadId: item.threadId, requestId: item.requestId, signal: item.controller.signal,
      onProgress: value => { if (version === uploadEpoch && uploads.includes(item)) { item.progress = value; renderUploads(); } } });
    if (version !== uploadEpoch || state.threadId !== item.threadId || !uploads.includes(item)) return;
    item.dto = dto; item.status = 'ready'; item.progress = 100; syncFiles();
  } catch (error) {
    if (version !== uploadEpoch || !uploads.includes(item)) return;
    if (error?.code === 'ACCESS_DENIED') { fileAccessDenied(); return; }
    item.status = error?.code === 'CANCELLED' ? 'cancelled' : 'error';
    item.error = error instanceof AttachmentError ? error.message : 'The upload could not be confirmed. Retry the same file.';
  }
  renderChat();
}
function addFiles(files) {
  if ($('attach').disabled) { fileNotice = 'Wait for the current request before attaching files.'; renderUploads(); return; }
  const selected = [...files];
  if (selected.length + uploads.length > 8) { fileNotice = 'You can send up to 8 files per message.'; renderUploads(); return; }
  fileNotice = '';
  for (const file of selected) {
    const item = { file, requestId: crypto.randomUUID(), threadId: state.threadId, status: 'uploading', progress: 0 };
    uploads.push(item); uploadFile(item);
  }
}

// ---------- Memories ----------

function loadMemories() { return memoryUI.load(companionName()); }

// ---------- Look ----------

function startLook() {
  lookRequest++;
  const owner = ownerEpoch;
  $('contacts-panel').hidden = !profile;
  if (profile) contactUI.load(); else contactUI.clear(); weatherUI.clear();
  $('weather-panel').hidden = !profile;
  if (profile) weatherUI.load(); else weatherUI.clear();
  $('personality-panel').hidden = !profile;
  if (profile) personalityUI.load(companionName()); else personalityUI.clear();
  draftLook = { ...(profile ?? { character: 'pip', color: 'peach', name: '' }) };
  $('name').value = draftLook.name ?? '';
  $('look-error').hidden = true;
  const first = !profile;
  $('look-title').textContent = first ? 'Meet your companion' : `${companionName()}’s look`;
  $('look-intro').textContent = first ? 'Choose how they look and give them a name. You can change it any time.' : 'Change how they look or their name.';
  $('save-look').textContent = first ? 'Say hello 👋' : 'Save';
  const characters = $('pick-character');
  characters.replaceChildren(...CHARACTERS.map(item => {
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.dataset.character = item.id;
    const pic = document.createElement('span'); pic.className = 'pic'; pic.setAttribute('aria-hidden', 'true');
    button.append(pic, Object.assign(document.createElement('span'), { textContent: item.label }), Object.assign(document.createElement('small'), { textContent: item.hint }));
    button.addEventListener('click', () => {
      if (owner !== ownerEpoch || sessionDenied) return;
      const suggested = CHARACTERS.some(c => c.label === $('name').value) || !$('name').value.trim();
      draftLook.character = item.id; if (suggested) $('name').value = item.label;
      renderLook();
    });
    return button;
  }));
  $('pick-color').replaceChildren(...Object.entries(COLORS).map(([id, colors]) => {
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.dataset.color = id; button.style.background = colors.body; button.setAttribute('aria-label', id);
    button.addEventListener('click', () => { if (owner === ownerEpoch && !sessionDenied) { draftLook.color = id; renderLook(); } });
    return button;
  }));
  if (first && !$('name').value) $('name').value = 'Pip';
  $('pick-outfit').replaceChildren(...[['auto', 'Automatic']].concat(OUTFITS).map(([id, label]) => {
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.dataset.outfit = id;
    const pic = document.createElement('span'); pic.className = 'pic'; pic.setAttribute('aria-hidden', 'true');
    button.append(pic, Object.assign(document.createElement('span'), { textContent: label }));
    button.addEventListener('click', () => { if (owner === ownerEpoch && !sessionDenied) { draftLook.outfit = id; renderLook(); } });
    return button;
  }));
  $('theme-pick').hidden = first;
  renderThemePick();
  if (!first) loadAndroid();
}

// The Android app card shows only when a release is published on the server.
async function loadAndroid() {
  const owner = ownerEpoch, token = lookRequest;
  try {
    const response = await fetch('android.json', { cache: 'no-store' });
    const release = response.ok ? await response.json() : null;
    if (owner !== ownerEpoch || token !== lookRequest || sessionDenied) return;
    if (!release?.version) { $('android-pick').hidden = true; return; }
    const megabytes = release.size ? ` · ${(release.size / 1048576).toFixed(1)} MB` : '';
    $('android-download').textContent = `Download for Android (${release.version}${megabytes})`;
    $('android-pick').hidden = false;
  } catch { if (owner === ownerEpoch && token === lookRequest) $('android-pick').hidden = true; }
}

// App theme: System (default), Light or Dark. companion-theme.js applies and stores it.
function renderThemePick() {
  const current = window.companionTheme?.get() ?? 'system';
  for (const button of document.querySelectorAll('button[data-theme-choice]')) {
    const on = button.dataset.themeChoice === current;
    button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
  }
}
function pickTheme(choice) {
  window.companionTheme?.set(choice); renderThemePick();
  document.querySelector(`button[data-theme-choice="${choice}"]`)?.focus();
}
const THEME_ORDER = ['system', 'light', 'dark'];
for (const button of document.querySelectorAll('button[data-theme-choice]')) {
  button.addEventListener('click', () => pickTheme(button.dataset.themeChoice));
  button.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    pickTheme(THEME_ORDER[(THEME_ORDER.indexOf(button.dataset.themeChoice) + step + 3) % 3]);
  });
}
function renderLook() {
  if (!draftLook) return;
  draw($('look-preview'), draftLook, 'happy');
  for (const button of $('pick-character').children) {
    button.setAttribute('aria-pressed', String(button.dataset.character === draftLook.character));
    draw(button.querySelector('.pic'), { character: button.dataset.character, color: draftLook.color }, 'idle');
  }
  for (const button of $('pick-color').children) button.setAttribute('aria-pressed', String(button.dataset.color === draftLook.color));
  $('outfit-field').hidden = !HAS_OUTFITS(draftLook.character);
  if (!$('outfit-field').hidden) {
    const chosen = draftLook.outfit ?? 'auto';
    for (const button of $('pick-outfit').children) {
      button.setAttribute('aria-pressed', String(button.dataset.outfit === chosen));
      const outfit = button.dataset.outfit === 'auto' ? wearing : button.dataset.outfit;
      draw(button.querySelector('.pic'), { character: draftLook.character, color: draftLook.color, outfit }, 'idle');
    }
  }
  applyColors(draftLook);
}

// ---------- Rendering ----------

function renderAll() {
  const look = lookShown() && draftLook ? draftLook : profile;
  const current = mood();
  $('top-name').textContent = companionName();
  $('top-mood').textContent = view === 'chat' ? MOOD_TEXT[current] : '';
  draw($('mini-avatar'), look ?? { character: 'pip', color: 'peach' }, current === 'talking' ? 'talking' : current === 'thinking' ? 'thinking' : 'idle');
  document.title = profile ? companionName() : 'Your companion';
  if (view === 'chat') {
    draw($('stage-character'), profile, current, feeling());
    $('stage-name').textContent = companionName();
    $('stage-mood').textContent = MOOD_TEXT[current];
    renderChat();
  }
  if (lookShown()) renderLook();
}

// ---------- Events ----------

client.subscribe(next => {
  const key = next.turn ? `${next.turn.requestId}:${next.turn.state}` : null;
  if (key && key !== lastTurnKey && next.turn.state === 'complete' && lastTurnKey?.startsWith(next.turn.requestId)) happyUntil = Date.now() + 5000;
  lastTurnKey = key;
  const previousThread = state.threadId; state = next;
  if (next.runtime) runtime = next.runtime;
  if (previousThread !== next.threadId || !next.opened) clearFullImage();
  if (previousThread !== next.threadId || next.connection === 'denied' || (!next.opened && next.connection !== 'loading')) clearUploads();
  if (!next.opened) { messageNodes.clear(); $('messages').replaceChildren(); }
  if (uploads.length && uploads.every(item => item.dto) &&
      ((next.pending?.action === 'submit' && next.pending.status === 'accepted' && uploads.every(item => next.pending.attachments?.includes(item.dto.id))) ||
       next.messages.some(message => message.role === 'user' && uploads.every(item => message.attachments?.some(file => file.id === item.dto.id))))) clearUploads();
  if (next.connection === 'denied' || next.error === 'ACCESS_DENIED') { fileAccessDenied(); return; }
  if (previousThread !== next.threadId) { heldDraft = null; composerEpoch++; }
  renderAll();
  if (!polling) schedulePoll();
});
setInterval(() => { if (view === 'chat') renderAll(); }, 1000);

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('input').value;
  if ($('send').disabled) return;
  const files = uploads.filter(item => item.status === 'ready').map(item => item.dto.id);
  const owner = ownerEpoch, threadId = state.threadId, edited = ++composerEpoch;
  $('input').value = ''; grow();
  try {
    syncFiles(); client.setDraft(''); const result = await client.send(text, files);
    if (result?.status === 'rejected' && result.text === text && ['BUSY', 'CONFLICT', 'INVALID_REQUEST'].includes(result.error)) keepRejected(text, owner, threadId, edited);
  } catch (error) { if (['BUSY', 'CONFLICT', 'INVALID_REQUEST'].includes(error?.code)) keepRejected(text, owner, threadId, edited); }
  schedulePoll();
});
function keepRejected(text, owner, threadId, edited) {
  if (owner !== ownerEpoch || sessionDenied || state.threadId !== threadId || typeof text !== 'string') return;
  if (composerEpoch === edited && !$('input').value) { $('input').value = text; client.setDraft(text); grow(); }
  else if (!heldDraft) heldDraft = { owner, threadId, text };
  renderAll();
}
reconnect.addEventListener('click', () => { if (!sessionDenied && !readTicket) { readFailures = 0; return readChat(); } });
restoreDraft.addEventListener('click', () => {
  if (!heldDraft || heldDraft.owner !== ownerEpoch || heldDraft.threadId !== state.threadId || $('input').value || state.pending) return;
  const text = heldDraft.text; heldDraft = null; composerEpoch++; $('input').value = text; client.setDraft(text); grow(); $('input').focus(); renderAll();
});
dismissDraft.addEventListener('click', () => { if (heldDraft?.owner === ownerEpoch) { heldDraft = null; renderAll(); } });
$('attach').addEventListener('click', () => $('file-picker').click());
$('full-image-close').addEventListener('click', clearFullImage);
$('full-image-dialog').addEventListener('close', clearFullImage);
$('file-picker').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
const chatArea = document.querySelector('.chat');
chatArea.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); chatArea.classList.add('file-drag'); } });
chatArea.addEventListener('dragleave', event => { if (!chatArea.contains(event.relatedTarget)) chatArea.classList.remove('file-drag'); });
chatArea.addEventListener('drop', event => { event.preventDefault(); chatArea.classList.remove('file-drag'); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files); });
$('input').addEventListener('paste', event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } });
$('retry-send').addEventListener('click', async () => {
  await client.retry();
  if (state.connection === 'ready' && state.threadId === null) await client.create('Companion');
  schedulePoll();
});
// New chat: the current chat is archived (kept, read-only, in Past chats) and a fresh one starts.
$('new-chat').addEventListener('click', async () => {
  if ($('new-chat').disabled || !confirm(`Start a new chat with ${companionName()}? This one moves to Past chats, where you can still read it.`)) return;
  clearUploads(); await client.archiveThread();
  schedulePoll();
});
const pastDialog = $('past-chats-dialog');
function chatDate(value) { return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
$('past-chats').addEventListener('click', async () => {
  if ($('past-chats').disabled) return;
  const list = $('past-chats-list'), note = $('past-chats-note');
  list.replaceChildren(); note.textContent = 'Loading…'; pastDialog.showModal();
  try {
    const threads = await client.archivedThreads();
    note.textContent = threads.length ? 'Archived chats are kept read-only.' : 'No past chats yet. “New chat” moves the current chat here.';
    for (const item of threads) {
      const button = document.createElement('button'); button.type = 'button';
      const title = document.createElement('strong'); title.textContent = item.title === 'Companion' ? 'Chat' : item.title;
      const detail = document.createElement('small');
      detail.textContent = `${chatDate(item.startedAt)} – ${chatDate(item.archivedAt)} · ${item.messages} message${item.messages === 1 ? '' : 's'}`;
      button.append(title, detail);
      button.addEventListener('click', async () => { pastDialog.close(); clearUploads(); await client.select(item.id); schedulePoll(); });
      const row = document.createElement('li'); row.append(button); list.append(row);
    }
  } catch (error) {
    if (error?.code === 'ACCESS_DENIED') { pastDialog.close(); fileAccessDenied(); return; }
    note.textContent = 'Past chats could not be loaded. Try again in a moment.';
  }
});
$('past-chats-close').addEventListener('click', () => pastDialog.close());
$('back-to-chat').addEventListener('click', async () => { clearUploads(); await client.open(); schedulePoll(); });
$('input').addEventListener('input', () => { composerEpoch++; grow(); try { client.setDraft($('input').value); } catch { /* too long: send stays disabled */ } renderAll(); });
$('input').addEventListener('keydown', event => {
  // Enter sends on computers; on phones the keyboard's Enter adds a line (send with the button).
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) {
    event.preventDefault(); $('composer').requestSubmit();
  }
});
$('input').addEventListener('focus', renderAll);
$('input').addEventListener('blur', renderAll);
$('stop').addEventListener('click', async () => { try { await client.cancel(); } catch { /* shown by state */ } schedulePoll(); });
$('home-link').addEventListener('click', () => { if (profile) location.hash = '#chat'; });
$('gate-retry').addEventListener('click', () => { show('loading'); start(); });

$('look-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (!name) { $('look-error').textContent = 'Give them a name.'; $('look-error').hidden = false; return; }
  $('save-look').disabled = true;
  const owner = ownerEpoch, token = ++lookRequest;
  try {
    const saved = await api({ action: 'setProfile', profile: { name, character: draftLook.character, color: draftLook.color, timezone,
      outfit: draftLook.outfit ?? 'auto' } });
    if (owner !== ownerEpoch || token !== lookRequest) return;
    profile = saved.profile; wearing = saved.wearing ?? wearing;
    applyColors(profile);
    if (location.hash !== '#chat') location.hash = '#chat'; else route();
  } catch (error) {
    if (owner !== ownerEpoch || token !== lookRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    $('look-error').textContent = error.status === 400 ? 'Check the name and appearance. Names can be up to 24 characters.' : 'That change could not be confirmed. Reload before trying again.'; $('look-error').hidden = false;
  } finally { if (owner === ownerEpoch && token === lookRequest) $('save-look').disabled = false; }
});
$('name').addEventListener('input', () => { if (draftLook) draftLook.name = $('name').value; $('look-error').hidden = true; });

// ---------- Connectors (#43): every link the companion has, with its state and a switch ----------

let connectors = null, connectorsBusy = false, connectorsRequest = 0, connectorsError = '';
const CONNECTOR_STATES = { connected: 'Connected', pending: 'Waiting for pairing', error: 'Needs attention', not_connected: 'Not connected', paused: 'Switched off', unavailable: 'Not available' };
async function loadConnectors() {
  if (connectorsBusy || sessionDenied) return;
  const owner = ownerEpoch, token = ++connectorsRequest;
  try { const result = await api({ action: 'connectors' }); if (owner !== ownerEpoch || token !== connectorsRequest) return; connectors = result.connectors; connectorsError = ''; }
  catch (error) {
    if (owner !== ownerEpoch || token !== connectorsRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    connectorsError = 'Connectors could not be loaded. Try again in a moment.';
  }
  renderConnectors();
}
async function setConnector(id, enabled) {
  if (connectorsBusy || sessionDenied) return;
  const owner = ownerEpoch, token = ++connectorsRequest; connectorsBusy = true; connectorsError = ''; renderConnectors();
  try { const result = await api({ action: 'setConnector', id, enabled }); if (owner !== ownerEpoch || token !== connectorsRequest) return; connectors = result.connectors; $('announce').textContent = enabled ? 'Connected.' : 'Switched off.'; }
  catch (error) {
    if (owner !== ownerEpoch || token !== connectorsRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    connectorsError = 'That change could not be saved. Reload and try again.';
  } finally { if (owner === ownerEpoch && token === connectorsRequest) { connectorsBusy = false; renderConnectors(); } }
}
function renderConnectors() {
  const list = $('connector-list'), owner = ownerEpoch;
  $('connectors-note').textContent = connectorsError;
  list.replaceChildren(...(connectors ?? []).map(item => {
    const badge = el('span', { className: 'status', textContent: CONNECTOR_STATES[item.state] ?? item.state }); badge.dataset.state = item.state;
    const card = el('li', { className: 'connector' }, el('div', { className: 'connector-head' }, el('strong', { textContent: item.name }), badge),
      el('p', { className: 'connector-purpose', textContent: item.purpose }));
    if (item.detail) card.append(el('p', { className: 'connector-detail', textContent: item.detail }));
    if (item.id === 'discord') {
      // Discord's own link, pairing and unlink controls live just below the list.
      const go = el('button', { type: 'button', className: 'button', textContent: item.state === 'not_connected' ? 'Connect' : 'Manage' });
      go.addEventListener('click', () => $('discord-pick').scrollIntoView({ behavior: 'smooth', block: 'start' }));
      card.append(el('div', { className: 'actions' }, go));
    } else if (item.actions.length) {
      const on = item.actions.includes('connect');
      const button = el('button', { type: 'button', className: on ? 'button primary' : 'button', disabled: connectorsBusy, textContent: on ? 'Connect' : 'Disconnect' });
      button.addEventListener('click', () => {
        if (owner !== ownerEpoch) return;
        if (!on && !confirm(`Disconnect ${item.name}? ${companionName()} stops using it until you connect it again.`)) return;
        return setConnector(item.id, on);
      });
      card.append(el('div', { className: 'actions' }, button));
    }
    return card;
  }));
}

// ---------- Discord (docs/DISCORD.md): the owner's own bot, for chatting in Discord DMs ----------

let discord = null, discordBusy = false, discordLoading = false, discordError = '', discordTimer = null, discordRequest = 0;
const DISCORD_ERRORS = { INVALID_TOKEN: 'That token didn’t work. Copy it again from your bot’s page (Bot → Reset Token).',
  BOT_IN_USE: 'This bot is already linked to another companion. Create a new bot for this one.' };
async function loadDiscord() {
  if (discordBusy || sessionDenied) return;
  clearTimeout(discordTimer);
  const owner = ownerEpoch, token = ++discordRequest; discordLoading = true; discordError = ''; renderDiscord();
  try {
    const result = await api({ action: 'discord' }); if (owner !== ownerEpoch || token !== discordRequest) return; discord = result.discord;
  } catch (error) {
    if (owner !== ownerEpoch || token !== discordRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    discord = null; discordError = 'Discord settings could not be loaded. Retry when the connection is available.';
  } finally { if (owner === ownerEpoch && token === discordRequest) { discordLoading = false; renderDiscord(); } }
  // While waiting for the pairing message, check again every few seconds.
  if (owner === ownerEpoch && token === discordRequest && connectorsShown() && discord?.linked && !discord.user && document.visibilityState !== 'hidden' && navigator.onLine !== false) discordTimer = setTimeout(() => { if (owner === ownerEpoch && token === discordRequest) void loadDiscord(); }, 4000);
}
async function discordAction(body) {
  if (discordBusy || sessionDenied) return;
  const owner = ownerEpoch, token = ++discordRequest; clearTimeout(discordTimer); discordTimer = null;
  discordBusy = true; discordError = ''; renderDiscord();
  try { const result = await api(body); if (owner !== ownerEpoch || token !== discordRequest) return; discord = result.discord; }
  catch (error) {
    if (owner !== ownerEpoch || token !== discordRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    discordError = DISCORD_ERRORS[error.message] ?? 'Discord change could not be confirmed. Reload its settings before trying again.';
  } finally { if (owner === ownerEpoch && token === discordRequest) { discordBusy = false; renderDiscord(); void loadConnectors(); } }
  if (owner === ownerEpoch && token === discordRequest && connectorsShown() && discord?.linked && !discord.user && document.visibilityState !== 'hidden' && navigator.onLine !== false) discordTimer = setTimeout(() => { if (owner === ownerEpoch && token === discordRequest) void loadDiscord(); }, 4000);
}
function el(tag, props = {}, ...children) { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; }
function renderDiscord() {
  const body = $('discord-body'), name = companionName();
  const owner = ownerEpoch;
  if (!discord) {
    body.replaceChildren(el('p', { textContent: discordLoading ? 'Loading…' : discordError || 'Discord settings are unavailable.' }));
    if (!discordLoading) { const retry = el('button', { type: 'button', className: 'button', textContent: 'Retry Discord settings' }); retry.addEventListener('click', () => { if (owner === ownerEpoch) return loadDiscord(); }); body.append(retry); }
    return;
  }
  const nodes = [];
  if (!discord.linked) {
    const link = el('a', { href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener', textContent: 'Discord Developer Portal' });
    nodes.push(el('p', {}, `Talk to ${name} in Discord direct messages. Reminders arrive there too.`),
      el('ol', {}, el('li', {}, 'Open the ', link, ' and create a New Application.'),
        el('li', {}, 'In ', el('strong', { textContent: 'Bot' }), ', press ', el('strong', { textContent: 'Reset Token' }), ' and copy the token.'),
        el('li', {}, 'Paste it here. It stays on the server and is never shown again.')));
    // A masked text field, not type=password: password managers would otherwise pair it with the Name field as a login.
    const input = el('input', { id: 'discord-token', type: 'text', className: 'secret', autocomplete: 'off', spellcheck: false, placeholder: 'Bot token', required: true });
    input.setAttribute('aria-label', 'Discord bot token');
    for (const flag of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) input.setAttribute(flag, flag === 'data-form-type' ? 'other' : 'true');
    const form = el('form', {}, input, el('button', { className: 'button primary', type: 'submit', disabled: discordBusy, textContent: discordBusy ? 'Connecting…' : 'Connect' }));
    form.addEventListener('submit', event => { event.preventDefault(); if (owner === ownerEpoch && input.value.trim()) return discordAction({ action: 'discordLink', token: input.value.trim() }); });
    nodes.push(form);
  } else {
    const state = discord.state === 'online' ? 'Online' : discord.state === 'error' ? 'Not connected' : 'Connecting…';
    const badge = el('span', { className: 'status', textContent: state }); badge.dataset.state = discord.state;
    nodes.push(el('p', {}, 'Bot ', el('strong', { textContent: discord.bot.name }), ' · ', badge));
    if (discord.problem) {
      nodes.push(el('p', { className: 'error', textContent: discord.problem === 'DISALLOWED_INTENTS'
        ? 'Discord refused the connection settings for this bot.' : 'Discord no longer accepts this bot’s token. Disconnect, then connect again with a new token.' }));
    } else if (discord.user) {
      nodes.push(el('p', {}, 'Linked to ', el('strong', { textContent: discord.user.name }), `. Send ${name} a direct message in Discord to chat; reminders arrive there too.`));
    } else if (discord.pairing) {
      nodes.push(el('ol', {},
        el('li', {}, el('a', { href: discord.bot.inviteUrl, target: '_blank', rel: 'noopener', textContent: 'Add the bot to a server' }), ' you’re in (your own server is fine).'),
        el('li', {}, 'Send the bot this code in a direct message:')),
      el('p', {}, el('span', { className: 'code', textContent: discord.pairing.code })),
      el('p', { textContent: 'Waiting for your message… The code works for an hour.' }));
    }
    const off = el('button', { className: 'button', type: 'button', disabled: discordBusy, textContent: 'Disconnect' });
    off.addEventListener('click', () => { if (owner === ownerEpoch && confirm(`Disconnect ${discord.bot.name} from ${name}?`)) return discordAction({ action: 'discordUnlink' }); });
    nodes.push(el('div', { className: 'actions' }, off));
  }
  if (discordError) nodes.push(el('p', { className: 'error', role: 'alert', textContent: discordError }));
  const reload = el('button', { type: 'button', className: 'button', textContent: 'Reload Discord settings', disabled: discordBusy });
  reload.addEventListener('click', () => { if (owner === ownerEpoch) return loadDiscord(); }); nodes.push(reload);
  body.replaceChildren(...nodes);
}

window.addEventListener('hashchange', () => { if (view !== 'loading' && view !== 'gate') route(); });
// Her outfit follows the time of day: check again every 10 minutes and when the page comes back.
async function refreshWearing() {
  if (!profile || document.visibilityState === 'hidden') return;
  const owner = ownerEpoch, token = ++wearingRequest;
  try { const data = await api({ action: 'get' }); if (owner !== ownerEpoch || token !== wearingRequest) return; wearing = data.wearing ?? wearing; runtime = data.runtime ?? runtime; renderAll(); }
  catch (error) { if (owner === ownerEpoch && token === wearingRequest && (error.status === 401 || error.status === 403)) fileAccessDenied(); }
}
setInterval(refreshWearing, 10 * 60 * 1000);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; clearTimeout(discordTimer); discordTimer = null; return; }
  refreshWearing();
  if (chatOpened && state.connection !== 'loading' && !polling) { readFailures = 0; await readChat(); }
  schedulePoll();
});
window.addEventListener('offline', () => { clearTimeout(pollTimer); pollTimer = null; clearTimeout(discordTimer); discordTimer = null; renderAll(); });
window.addEventListener('online', () => { if (canRead()) { readFailures = 0; void readChat(); } });

start();
