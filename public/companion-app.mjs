// The companion web app: one ongoing chat with your companion, what it remembers, and how it looks.
import { createConversationClient, createFileTransport, AttachmentError, USER_CHARS, boardLink } from './conversation-client.mjs';
import { renderCharacter, CHARACTERS, COLORS, OUTFITS, HAS_OUTFITS } from './companion-character.mjs';
import { createRemindersUI } from './reminders-ui.mjs';
import { createCalendarUI } from './calendar-ui.mjs';
import { createStudioUI } from './studio-ui.mjs';
import { createMemoryUI } from './memory-ui.mjs';
import { createPersonalityUI } from './personality-ui.mjs';
import { createContactUI, renderPeerCard } from './contact-ui.mjs';
import { createOwnerProfileUI } from './owner-profile-ui.mjs';
import { createWeatherUI } from './weather-ui.mjs';
import { createWebPushUI, createPushPresence, registerServiceWorker } from './web-push-ui.mjs';
import { createActiveClient } from './active-client.mjs';
import { splitBubbles } from './bubbles.mjs';
import { createVoiceRecorder, voiceView } from './voice-ui.mjs';
import { createBoardUI } from './board-ui.mjs';
import { createGroupUI, renderMarkdown } from './group-ui.mjs';
import { idleDelay, createActivity, createMotion } from './idle.mjs';
import { createUnreadMark } from './unread-mark.mjs';
import { showDesktopCard } from './desktop-card.mjs';

const $ = id => document.getElementById(id);
// Idle performance (#60): when the owner last used the page; reads back off while nothing happens.
const activity = createActivity({ doc: document, win: window });
// Change-only DOM writes: an unchanged render touches nothing, so it costs no style, layout or paint.
const setText = (node, value) => { value = String(value ?? ''); if (node.textContent !== value) node.textContent = value; };
const setProp = (node, key, value) => { if (node[key] !== value) node[key] = value; };
const client = createConversationClient();
const fileTransport = createFileTransport();
const calendarUI = createCalendarUI({ document, visible: () => view === 'calendar' });
// #65: the Studio tab is an app grid; #studio/mail and #studio/calendar open its apps (the back button works).
const studioUI = createStudioUI({ document, onDenied: fileAccessDenied, navigate: app => { location.hash = app ? 'studio/' + app : 'studio'; } });
const remindersUI = createRemindersUI({ document, visible: () => view === 'me' && (meSection === 'watches' || meSection === 'settings') });
const memoryUI = createMemoryUI({ document, api, onDenied: fileAccessDenied });
const personalityUI = createPersonalityUI({ document, api, onDenied: fileAccessDenied });
const contactUI = createContactUI({ document, api, onDenied: fileAccessDenied });
const ownerProfileUI = createOwnerProfileUI({ document, onDenied: fileAccessDenied });
const weatherUI = createWeatherUI({ document, api, onDenied: fileAccessDenied, onWearing: next => { wearing = next; renderAll(); } });
// Board tab (#55): one sub-conversation per Board ticket; opening one shows it in the chat view (#board/<thread>).
const boardUI = createBoardUI({ document, inbox: client, onOpen: threadId => { location.hash = '#board/' + threadId; },
  onDenied: fileAccessDenied, onChange: () => { if (view === 'chat') renderAll(); } });
// Group tab (#53): owners and their companions together; #group lists them, #group/<id> opens one.
const groupUI = createGroupUI({ document, renderCharacter, activity, onDenied: fileAccessDenied, onNewData: groupId => dataArrived('group', groupId), visible: () => view === 'group' && Boolean(groupThread) });
let groupThread = null;
const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

let profile = null, runtime = null, view = 'loading', chatOpened = false, state = client.getState();
let wearing = 'base', draftLook = null, pollTimer = null, polling = false, happyUntil = 0, lastTurnKey = null;
const messageNodes = new Map();
let uploads = [], uploadEpoch = 0, fileNotice = '', uploadsKey = '';
// Voice messages (set up with the composer below): the recorder, a send in progress, the typing ping while recording.
let voiceRecorder = null, voiceSending = false, recordingPing = null;
let ownerEpoch = 0, startRequest = 0, lookRequest = 0, wearingRequest = 0, composerEpoch = 0, sessionDenied = false;
// boardThread: the Board sub-conversation the address asks for; selectedBoard: the one the chat view has open.
let boardThread = null, selectedBoard = null, boardReadMarked = null;
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
// Installed web app (docs/PUSH.md): offline shell and notifications.
registerServiceWorker();
const webPushUI = createWebPushUI({ document, api });
const pushPresence = createPushPresence({ api, onChat: () => view === 'chat' });
// #59: this tab, open, holds pushes to the owner's other devices for a while; in active use, the conversation on
// screen counts as read.
const activeClient = createActiveClient({ api, signedIn: () => Boolean(profile) && !sessionDenied,
  threadOnScreen: () => profile && view === 'chat' && state.opened && state.connection === 'ready' ? state.threadId : null });
// The companion moves for a while after something happens, then rests (#60). busy: a reply is running.
const chatBusy = () => view === 'chat' && (state.turn?.state === 'streaming' || Boolean(state.pending));
const motion = createMotion({ root: document.documentElement, win: window, activity, busy: chatBusy });
// #60: the one place new data from the server is announced (a new companion message in the open chat, a new group
// message). Views that react to arrivals (an unread dot in a hidden tab, for example) subscribe here.
const arrivalListeners = new Set();
function onDataArrived(listener) { arrivalListeners.add(listener); return () => arrivalListeners.delete(listener); }
function dataArrived(source, detail = null) {
  motion.wake();
  // Desktop shell hook (docs/DESKTOP.md): the Electron app's preload reads this to show a native toast. Ids only, no text.
  try { document.documentElement.dataset.companionArrival = JSON.stringify({ source, detail }); document.documentElement.dispatchEvent(new Event('companion-arrival')); } catch { /* optional */ }
  for (const listener of arrivalListeners) { try { listener({ source, detail, hidden: document.visibilityState === 'hidden' }); } catch { /* one listener cannot stop the others */ } }
}
// #59 follow-up: a red dot on the favicon and "(•) " in the title for a message that arrived while the owner was not
// looking at its conversation; cleared when they look (visible, focused, that conversation on screen).
const unreadMark = createUnreadMark({ document, window, baseTitle: () => profile ? companionName() : 'Your companion',
  seeing: (source, detail) => document.visibilityState === 'visible' && document.hasFocus() && (source === 'group'
    ? view === 'group' && groupThread === detail
    : view === 'chat' && state.opened && state.threadId === detail) });
onDataArrived(event => unreadMark.arrived(event));
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
// Chat text as markdown (inline code, code blocks, **bold**, *italic*, quotes, lists, links), built from text nodes only (#95:
// 1:1 chat used a reduced bold/italic/links-only copy, so `code` showed its backticks everywhere, not only on the desktop).
function textWithLinks(container, text) { container.replaceChildren(...renderMarkdown(document, text)); }

// ---------- Views ----------

// Views: chat, calendar, me (memories, the companion's look, watches, connectors and settings), plus first-run setup ('look' alone).
// The Me tab has sub-pages like the Android app: #me (memories), #me/companion, #me/watches, #me/connectors and #me/settings.
let meSection = 'memories', studioApp = null;
const lookShown = () => view === 'look' || (view === 'me' && meSection === 'companion');
const connectorsShown = () => view === 'me' && meSection === 'connectors';
function show(next) {
  view = next;
  if (!connectorsShown()) { clearTimeout(discordTimer); discordTimer = null; clearTimeout(minecraftTimer); minecraftTimer = null; }
  $('app').dataset.view = next;
  for (const name of ['loading', 'gate', 'chat', 'calendar', 'studio', 'board', 'group']) $(`view-${name}`).hidden = name !== next;
  $('group-list-panel').hidden = Boolean(groupThread); $('group-chat-panel').hidden = !groupThread;
  $('view-me').hidden = next !== 'me' && next !== 'look';
  $('me-tabs').hidden = next !== 'me';
  $('view-look').hidden = !lookShown();
  $('view-memories').hidden = !(next === 'me' && meSection === 'memories');
  $('view-settings').hidden = !(next === 'me' && meSection === 'settings');
  $('view-connectors').hidden = !connectorsShown();
  $('view-owner-profile').hidden = !(next === 'me' && meSection === 'profile');
  $('view-watches').hidden = !(next === 'me' && meSection === 'watches');
  for (const link of document.querySelectorAll('#me-tabs a')) {
    if (next === 'me' && link.dataset.section === meSection) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  $('nav').hidden = !profile || next === 'gate' || next === 'loading';
  const tab = next === 'chat' && boardThread ? 'board' : next;
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === tab) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (next === 'chat') openChat();
  if (next === 'board') void boardUI.show(); else boardUI.hide();
  if (next === 'group' && groupThread) void groupUI.open(groupThread); else groupUI.close();
  if (next === 'group' && !groupThread) void groupUI.refresh();
  if (next === 'me' && meSection === 'memories') loadMemories();
  if (next === 'me' && meSection === 'profile') void ownerProfileUI.show();
  if (connectorsShown()) { $('discord-pick').hidden = false; void loadConnectors(); void loadDiscord(); }
  if (lookShown()) startLook();
  if (next === 'me' && (meSection === 'watches' || meSection === 'settings')) void remindersUI.show();
  if (next === 'calendar') void calendarUI.show();
  if (next === 'studio') void studioUI.show(studioApp); else studioUI.hide();
  if (next === 'me' && meSection === 'settings') { $('theme-pick').hidden = false; renderThemePick(); void webPushUI.show();
    const epoch = ownerEpoch; void showDesktopCard({ card: $('desktop-pick'), button: $('desktop-download'), isCurrent: () => epoch === ownerEpoch && !sessionDenied }); }
  pushPresence.update(); activeClient.update(); unreadMark.check();
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
  // #memories, #look and #watches are older links into what is now the Me tab.
  const me = { me: 'memories', memories: 'memories', 'me/companion': 'companion', look: 'companion', 'me/watches': 'watches', watches: 'watches',
    'me/connectors': 'connectors', 'me/settings': 'settings', 'me/profile': 'profile' }[hash];
  if (me) meSection = me;
  // #75: the Board tab is gone (Board messages come to the main chat, history is in Studio > Ops); #board/<thread> opens that Board sub-conversation in the chat view (also from a push).
  const board = /^board\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(hash);
  boardThread = board ? board[1] : null;
  const group = /^group\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(hash);
  groupThread = group ? group[1] : null;
  const studio = /^studio(?:\/([a-z]+))?$/.exec(hash);
  studioApp = studio?.[1] ?? null;
  show(hash === 'group' || group ? 'group' : board ? 'chat' : studio ? 'studio' : hash === 'calendar' ? 'calendar' : me ? 'me' : 'chat');
}

async function start() {
  resetShell(false);
  const owner = ownerEpoch, token = ++startRequest;
  try {
    const data = await api({ action: 'get' });
    if (owner !== ownerEpoch || token !== startRequest) return;
    profile = data.profile; runtime = data.runtime; wearing = data.wearing ?? 'base';
    applyColors(profile);
    if (profile) { void studioUI.probe(); void boardUI.refresh(); void groupUI.refresh(); }
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
  if (!chatOpened) {
    chatOpened = true;
    if (!boardThread) return readChat();
    selectedBoard = boardThread; await client.select(boardThread); schedulePoll(); return;
  }
  // Moving between the main chat and a Board sub-conversation selects that thread; anything else stays as it is.
  if (boardThread && state.threadId !== boardThread) { selectedBoard = boardThread; clearUploads(); await client.select(boardThread); schedulePoll(); }
  else if (!boardThread && selectedBoard && state.threadId === selectedBoard) { selectedBoard = null; clearUploads(); await client.open(); schedulePoll(); }
}
const onBoardThread = () => Boolean(selectedBoard) && state.threadId === selectedBoard;

// Hidden tabs keep reading, slowly (HIDDEN_READ_MS), so a new message is still noticed within about a minute.
const canRead = () => !sessionDenied && profile && chatOpened && navigator.onLine !== false;
const HIDDEN_READ_MS = 60_000, ACTIVE_READ_MS = 500, FAST_READ_MS = 2000;
// Time since the owner used the page or the conversation changed: the poll backs off from 2 s to 30 s (#60).
let lastChatChange = Date.now(), chatKey = '', pollDue = 0, lastRead = 0, arrivalThread = null, arrivalLast = null;
const chatQuiet = () => Math.min(Date.now() - lastChatChange, activity.quietMs());
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
    lastRead = Date.now();
    if (state.connection === 'ready') { readFailures = 0; if (document.visibilityState !== 'hidden') { await remindersUI.refreshIfOpen(); await calendarUI.refreshIfOpen(); } }
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
  const hidden = document.visibilityState === 'hidden';
  const delay = recovering ? Math.max(READ_BACKOFF[Math.max(0, readFailures - 1)], hidden ? HIDDEN_READ_MS : 0)
    : hidden ? HIDDEN_READ_MS : active ? ACTIVE_READ_MS : idleDelay(chatQuiet(), FAST_READ_MS);
  pollDue = Date.now() + delay;
  pollTimer = setTimeout(() => { pollTimer = null; if (owner === ownerEpoch && sequence === readSequence) void readChat(); }, delay);
}

function dayLabel(date) {
  const today = new Date(), yesterday = new Date(Date.now() - 86400000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

// #61b: an app activity line (a silent Board wake): app text, the companion's Board post quoted as plain text, a link.
function appNote(message) {
  const parts = [el('span', { className: 'app-note-text', textContent: message.text })];
  if (message.preview) parts.push(el('q', { className: 'app-note-quote', textContent: message.preview }));
  const href = boardLink(message.url);
  if (href) parts.push(el('a', { className: 'app-note-link', href, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open on the Board' }));
  return parts;
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
      node.className = message.role === 'peer' ? `bubble peer-card ${message.peer.direction}` : message.role === 'user' ? 'bubble user'
        : message.role === 'app' ? 'app-note' : 'companion bubble-group';
      if (message.role === 'peer') node.append(renderPeerCard(document, message));
      else if (message.role === 'user') node.append(el('div', { className: 'message-text' }), el('div', { className: 'message-files' }));
      messageNodes.set(message.id, node);
    }
    if (message.role === 'user') {
      if (node.dataset.text !== message.text) { textWithLinks(node.querySelector('.message-text'), message.text); node.dataset.text = message.text; }
      const filesKey = JSON.stringify(message.attachments ?? []);
      if (node.dataset.files !== filesKey) {
        node.querySelector('.message-files').replaceChildren(...(message.attachments ?? []).map(fileView)); node.dataset.files = filesKey;
      }
    } else if (message.role === 'app') {
      const noteKey = JSON.stringify([message.text, message.preview ?? '', message.url ?? '']);
      if (node.dataset.note !== noteKey) { node.replaceChildren(...appNote(message)); node.dataset.note = noteKey; }
    } else if (message.role !== 'peer') renderCompanionBubbles(node, message);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
    index++;
  }
  for (const [id, node] of messageNodes) if (!keep.has(id)) { node.remove(); messageNodes.delete(id); }
  const busy = state.turn?.state === 'streaming' || Boolean(state.pending);
  // The companion's reply arrives bubble by bubble: it keeps "typing" under them until the reply is done.
  setProp($('typing'), 'hidden', !busy);
  setProp($('welcome'), 'hidden', index > 0 || state.connection === 'loading');
  setText($('welcome-text'), `Say hi to ${companionName()} 👋 ${companionName()} remembers what matters to you, so tell them about your day.`);
  if (follow) history.scrollTop = history.scrollHeight;
}

// A companion reply shows as several short bubbles, one per paragraph, like separate chat messages.
// While it streams, earlier bubbles stay in place and only the growing last one is redrawn.
function renderCompanionBubbles(node, message) {
  const texts = splitBubbles(message.text ?? ''), files = message.attachments ?? [];
  if (!texts.length && files.length) texts.push('');
  const filesKey = JSON.stringify(files);
  [...node.children].slice(texts.length).forEach(child => child.remove());
  texts.forEach((text, index) => {
    let bubble = node.children[index];
    if (!bubble) {
      bubble = el('div', { className: 'bubble companion' });
      bubble.append(el('div', { className: 'message-text' }), el('div', { className: 'message-files' }));
      node.append(bubble);
    }
    if (bubble.dataset.text !== text) { textWithLinks(bubble.querySelector('.message-text'), text); bubble.dataset.text = text; }
    const key = index === texts.length - 1 ? filesKey : '[]';
    if (bubble.dataset.files !== key) { bubble.querySelector('.message-files').replaceChildren(...JSON.parse(key).map(fileView)); bubble.dataset.files = key; }
  });
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

// A message still on its way to the server. Once accepted, the owner can keep texting while the companion
// waits or replies: messages sent close together get one reply.
const submitting = () => Boolean(state.pending) && state.pending.status !== 'accepted';

function renderChat() {
  renderMessages();
  const note = turnNote();
  setProp($('note'), 'hidden', !note); setText($('note'), note ?? '');
  const streaming = state.turn?.state === 'streaming';
  const ready = state.connection === 'ready' && state.threadId !== null;
  const input = $('input');
  if (input.value !== state.draft && document.activeElement !== input) input.value = state.draft;
  const completed = uploads.filter(item => item.status === 'ready');
  // While a reply runs, Stop shows until the owner starts typing another message.
  const typing = Boolean(input.value.trim()) || uploads.length > 0;
  setProp($('stop'), 'hidden', !streaming || typing);
  setProp($('stop'), 'disabled', Boolean(state.turn?.stopping));
  // Like Discord: the mic sits where Send is until there is something to send.
  const mic = !typing && Boolean(voiceRecorder?.supported());
  setProp($('mic'), 'hidden', !mic);
  setProp($('mic'), 'disabled', !ready || submitting() || voiceSending || state.archivedAt !== null || state.synthetic);
  setProp($('send'), 'hidden', mic);
  const waiting = uploads.some(item => item.status !== 'ready' || item.removing);
  setProp($('send'), 'disabled', !ready || submitting() || Boolean(heldDraft) || waiting || (!input.value.trim() && !completed.length) || input.value.length > USER_CHARS);
  setProp($('attach'), 'disabled', !ready || submitting() || uploads.length >= 8);
  setProp($('file-picker'), 'disabled', $('attach').disabled);
  setProp($('retry-send'), 'hidden', state.pending?.status !== 'uncertain');
  const archived = state.archivedAt !== null;
  setProp($('new-chat'), 'disabled', !ready || archived || state.synthetic || Boolean(state.pending) || streaming || state.messages.length === 0);
  setProp($('past-chats'), 'disabled', state.synthetic || sessionDenied);
  setProp($('archived-banner'), 'hidden', !archived);
  if (archived) setText($('archived-text'), `Archived chat · ended ${new Date(state.archivedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} · read-only`);
  setProp($('composer'), 'hidden', archived);
  // In a Board sub-conversation: its topic, a way back to the Board tab and Done; Past chats and New chat are main-chat only.
  const board = onBoardThread(), topic = board ? boardUI.topic(selectedBoard) : null;
  setProp($('board-banner'), 'hidden', !board);
  if (board) {
    setText($('board-topic'), topic?.label ?? state.threads.find(item => item.id === state.threadId)?.title ?? 'Board');
    setText($('board-done'), topic?.archived ? 'Reopen' : 'Done');
  }
  setProp($('past-chats'), 'hidden', board); setProp($('new-chat'), 'hidden', board);
  setProp(reconnect, 'hidden', sessionDenied || Boolean(state.pending && !state.opened) || (!readFailures && state.connection === 'ready')); if (!reconnect.hidden) setProp(reconnect, 'disabled', Boolean(readTicket) || navigator.onLine === false);
  setProp(kept, 'hidden', !heldDraft); setText(keptText, heldDraft?.text ?? ''); setProp(restoreDraft, 'disabled', Boolean(input.value) || Boolean(state.pending));
  setProp(input, 'placeholder', `Write to ${companionName()}…`);
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
  if (file.voice) { box.append(voiceView(document, file, url + '/voice')); return box; }
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
  for (const id of ['discord-pick', 'android-pick', 'desktop-pick']) $(id).hidden = true;
  connectors = null; connectorsBusy = false; githubForm = false; xForm = false; connectorsRequest++; connectorsError = ''; $('connector-list').replaceChildren(); $('connectors-note').textContent = '';
  kept.hidden = true; keptText.textContent = ''; reconnect.hidden = true;
  selectedBoard = null; boardReadMarked = null; boardUI.clear(); groupUI.clear(); unreadMark.clear();
  memoryUI.clear(); personalityUI.clear(); contactUI.clear(); ownerProfileUI.clear(); weatherUI.clear(); remindersUI.clear(); calendarUI.clear(); studioUI.clear(); client.clear(); clearUploads(); clearFullImage();
}
function clearUploads() {
  uploadEpoch++;
  for (const item of uploads) item.controller?.abort();
  uploads = []; fileNotice = ''; renderUploads();
}
function renderUploads() {
  const root = $('uploads'); setProp(root, 'hidden', !uploads.length);
  setProp($('file-note'), 'hidden', !fileNotice); setText($('file-note'), fileNotice);
  const key = JSON.stringify([submitting(), uploads.map(item => [item.requestId, item.status, item.progress, item.error, item.dto?.id, item.removing]), fileNotice]);
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
      const retry = el('button', { type: 'button', className: 'text-button', textContent: 'Retry', disabled: submitting() });
      retry.addEventListener('click', () => uploadFile(item)); row.append(retry);
    }
    const remove = el('button', { type: 'button', className: 'text-button', textContent: item.removing ? 'Removing…' : item.status === 'uploading' ? 'Cancel' : 'Remove', disabled: submitting() || Boolean(item.removing) });
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
  if (!uploads.includes(item) || state.connection !== 'ready' || submitting() || state.threadId !== item.threadId) return;
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
  $('character-kit').hidden = !profile;
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

// The face shown depends on the clock (happy for a few seconds, sleepy at night): checked every second, drawn on change.
let renderedMood = '';
const moodKey = () => `${mood()}|${feeling() ?? ''}`;
function renderAll() {
  const look = lookShown() && draftLook ? draftLook : profile;
  const current = mood();
  renderedMood = moodKey();
  setText($('top-name'), companionName());
  setText($('top-mood'), view === 'chat' ? MOOD_TEXT[current] : '');
  draw($('mini-avatar'), look ?? { character: 'pip', color: 'peach' }, current === 'talking' ? 'talking' : current === 'thinking' ? 'thinking' : 'idle');
  const title = unreadMark.title(profile ? companionName() : 'Your companion');
  if (document.title !== title) document.title = title;
  if (view === 'chat') {
    draw($('stage-character'), profile, current, feeling());
    setText($('stage-name'), companionName());
    setText($('stage-mood'), MOOD_TEXT[current]);
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
  // A Board sub-conversation on screen is read: mark it when it opens and whenever a new companion message arrives.
  if (selectedBoard && next.threadId === selectedBoard && next.opened && view === 'chat' && document.visibilityState !== 'hidden') {
    const key = selectedBoard + ':' + ([...next.messages].reverse().find(item => ['assistant', 'app'].includes(item.role) && item.text)?.id ?? '');
    if (key !== boardReadMarked) { boardReadMarked = key; void boardUI.markRead(selectedBoard); }
  }
  // #60: something changed in the conversation (a message, a reply starting or ending): reads stay fast for a while.
  const last = next.messages.at(-1);
  const changeKey = [next.threadId, next.messages.length, last?.id, last?.text?.length, key ?? '', next.pending?.status ?? ''].join('|');
  if (changeKey !== chatKey) {
    // A companion message that was not there before, in the same open thread (not the first load of a chat).
    const arrived = next.opened && next.threadId === arrivalThread && last?.role !== 'user' && Boolean(last?.text) && last.id !== arrivalLast;
    chatKey = changeKey; lastChatChange = Date.now();
    if (arrived) dataArrived('chat', next.threadId); else motion.update();
  }
  if (next.opened) { arrivalThread = next.threadId; arrivalLast = last?.id ?? null; }
  activeClient.update(); unreadMark.check();
  renderAll();
  if (!polling) schedulePoll();
});
setInterval(() => { if (view === 'chat' && document.visibilityState !== 'hidden' && moodKey() !== renderedMood) renderAll(); }, 1000);

// ---------- Voice messages ----------
// Recording counts as typing, so a reply still waiting for more texts keeps waiting.
voiceRecorder = createVoiceRecorder({ bar: $('voice-bar'),
  onStart: () => { $('composer').classList.add('recording'); signal(true); recordingPing = setInterval(() => signal(true), 3000); renderChat(); },
  onStop: () => { $('composer').classList.remove('recording'); clearInterval(recordingPing); renderChat(); },
  onRecorded: file => { void sendVoice(file); },
  onProblem: text => { fileNotice = text; signal(false); renderUploads(); } });
$('mic').addEventListener('click', () => { if (!$('mic').disabled) { fileNotice = ''; renderUploads(); void voiceRecorder.start(); } });
async function sendVoice(file) {
  const threadId = state.threadId, owner = ownerEpoch;
  if (!threadId || submitting() || state.connection !== 'ready') { fileNotice = 'The voice message was not sent: wait for the chat to be ready and record it again.'; renderUploads(); return; }
  voiceSending = true; fileNotice = 'Sending voice message…'; renderUploads(); renderChat();
  try {
    const dto = await fileTransport.upload(file, { threadId, requestId: crypto.randomUUID(), voice: true });
    if (owner !== ownerEpoch || state.threadId !== threadId) return;
    client.setFiles([...uploads.filter(item => item.status === 'ready').map(item => item.dto), dto]);
    const result = await client.send('', [dto.id]);
    fileNotice = result?.status === 'accepted' ? '' : 'The voice message was not sent. Record it again.';
  } catch (error) {
    fileNotice = error?.code === 'TOO_LARGE' ? 'That voice message is too long.' : 'The voice message could not be sent. Check your connection and record it again.';
  } finally { voiceSending = false; renderUploads(); renderChat(); schedulePoll(); }
}

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('input').value;
  if ($('send').disabled) return;
  const files = uploads.filter(item => item.status === 'ready').map(item => item.dto.id);
  const owner = ownerEpoch, threadId = state.threadId, edited = ++composerEpoch;
  $('input').value = ''; grow(); typingSentAt = 0; typingOn = false;
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
// Done: the Board topic is handled and moves to Archived (a new Board message or a reply reopens it).
$('board-done').addEventListener('click', async () => {
  if (!onBoardThread()) return;
  const done = !boardUI.topic(selectedBoard)?.archived;
  if (await boardUI.archive(selectedBoard, done) && done) location.hash = '#chat'; else renderAll();
});
// The Board badge follows new Board messages while the app is open.
// #60: every 30 s while the owner is around, every minute in a hidden tab, every 2 minutes after 5 idle minutes.
let listTicks = 0, listRefreshedAt = 0;
function refreshLists() {
  if (!profile || sessionDenied) return;
  listTicks = 0; listRefreshedAt = Date.now();
  void boardUI.refresh(); if (!(view === 'group' && groupThread)) void groupUI.refresh();
}
setInterval(() => {
  const every = document.visibilityState === 'hidden' ? 2 : activity.quietMs() > 5 * 60_000 ? 4 : 1;
  if (++listTicks >= every) refreshLists();
}, 30000);
// Coming back to the window: read now instead of waiting for the backed-off poll. Input: the next read comes soon.
activity.onWake(reason => {
  if (reason === 'focus' && document.visibilityState !== 'hidden') {
    if (Date.now() - listRefreshedAt > 30_000) refreshLists();
    if (chatOpened && state.connection === 'ready' && !readTicket && !polling && Date.now() - lastRead > FAST_READ_MS) void readChat();
  } else if (reason === 'input' && pollTimer && pollDue - Date.now() > FAST_READ_MS) schedulePoll();
});
$('input').addEventListener('input', () => { composerEpoch++; grow(); try { client.setDraft($('input').value); } catch { /* too long: send stays disabled */ } noteTyping(); renderAll(); });
// Tells the server the owner is typing (at most every 3 s while they type), like the "typing…" a person sees,
// so a reply still waiting for more texts keeps waiting. Clearing the box says they stopped.
let typingSentAt = 0, typingOn = false;
const signal = active => { try { Promise.resolve(client.typing?.(active)).catch(() => {}); } catch { /* only a hint */ } };
function noteTyping() {
  const writing = Boolean($('input').value.trim());
  if (writing && Date.now() - typingSentAt > 3000) { typingSentAt = Date.now(); typingOn = true; signal(true); }
  else if (!writing && typingOn) { typingSentAt = 0; typingOn = false; signal(false); }
}
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
const CONNECTOR_STATES = { connected: 'Connected', pending: 'Waiting for pairing', error: 'Needs attention', not_connected: 'Not connected', paused: 'Switched off', unavailable: 'Not available', expiring: 'Expires soon' };
const GITHUB_ERRORS = { INVALID_TOKEN: 'GitHub didn’t accept that token. Check it starts with github_pat_ and hasn’t expired.',
  X_INVALID_KEY: 'That doesn’t look like an X API bearer token.', X_KEY_REJECTED: 'X didn’t accept that key. Check it is the app’s bearer token and the app has credits.' };
let githubForm = false, xForm = false, minecraftTimer = null;
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
  // Minecraft (#68): while the bot connects or waits for a Microsoft sign-in, refresh so the code and the result show up.
  clearTimeout(minecraftTimer); minecraftTimer = null;
  if (owner === ownerEpoch && connectorsShown() && connectors?.some(item => item.id === 'minecraft' && item.state === 'pending') && document.visibilityState !== 'hidden')
    minecraftTimer = setTimeout(() => { if (owner === ownerEpoch) void loadConnectors(); }, 5000);
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
    } else if (item.id === 'github') {
      card.append(githubControls(item, owner));
    } else if (item.id === 'x') {
      card.append(xControls(item, owner));
    } else if (item.id === 'minecraft') {
      card.append(minecraftControls(item, owner));
    } else if (item.id === 'board' && item.state === 'unavailable') {
      card.append(boardSetupSteps());
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

// Minecraft (#68): the on/off switch, and in online mode the Microsoft sign-in code (this owner only) and sign-out.
function minecraftControls(item, owner) {
  const box = el('div', { className: 'github-link' });
  if (item.signIn) {
    const minutes = Math.max(1, Math.round((item.signIn.expiresAt - Date.now()) / 60_000));
    box.append(el('ol', {},
      el('li', {}, 'Open ', el('a', { href: item.signIn.url, target: '_blank', rel: 'noopener noreferrer', textContent: item.signIn.url }), ' and sign in with ', companionName(), '’s Minecraft (Microsoft) account.'),
      el('li', {}, 'Enter the code ', el('strong', { textContent: item.signIn.code }), ` (it expires in about ${minutes} minute${minutes === 1 ? '' : 's'}).`)));
  }
  const on = item.actions.includes('connect');
  const toggle = el('button', { type: 'button', className: on ? 'button primary' : 'button', disabled: connectorsBusy, textContent: on ? 'Connect' : 'Disconnect' });
  toggle.addEventListener('click', () => {
    if (owner !== ownerEpoch) return;
    if (!on && !confirm(`Disconnect Minecraft? ${companionName()} stops using it until you connect it again.`)) return;
    return setConnector(item.id, on);
  });
  const row = el('div', { className: 'actions' }, toggle);
  if (item.actions.includes('signout')) {
    const out = el('button', { type: 'button', className: 'button', disabled: connectorsBusy, textContent: 'Sign out of Minecraft' });
    out.addEventListener('click', () => {
      if (owner !== ownerEpoch || !confirm(`Sign ${companionName()} out of its Minecraft account? The saved sign-in is deleted; a new sign-in code follows.`)) return;
      void githubAction({ action: 'minecraftSignOut' }, 'Signed out of Minecraft.');
    });
    row.append(out);
  }
  box.append(row);
  return box;
}

// Agent Board: not set up for this owner yet. Pairing needs their Board account and the server admin (docs/BOARD-COMPANION.md).
function boardSetupSteps() {
  const board = (text, path = '') => el('a', { href: 'https://board.blackoutburst.com/' + path, target: '_blank', rel: 'noopener', textContent: text });
  return el('div', { className: 'github-link' }, el('ol', {},
    el('li', {}, 'On the ', board('Board'), ', open Agents › Profiles › Create companion. Name it after ', companionName(), ', and pick its projects and permissions. It works the same for a Claude or a ChatGPT (Codex) companion.'),
    el('li', {}, 'When the server admin is ready, open ', board('Connect agent', '?page=setup'), ', name the computer "Companion server" and generate a pairing code. Send the code to the admin privately, not on the Board: it works once and expires after 10 minutes.'),
    el('li', {}, 'After the admin has paired it, open your companion profile › Connections › Link executor. Pick the device "Companion server" and the client "Other MCP client", keep the installation key, and send that key to the admin.'),
    el('li', {}, 'The admin links it on the server. This card then shows Connected, and ', companionName(), ' can follow your projects, answer Board requests and pass on pings for you.')));
}

// GitHub (#45): each owner pastes their own fine-grained token. It stays on the server and is never shown again.
function githubControls(item, owner) {
  const box = el('div', { className: 'github-link' });
  if (item.state === 'not_connected' || githubForm) {
    const link = el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', textContent: 'Create a fine-grained token' });
    box.append(el('ol', {},
      el('li', {}, link, ' on GitHub (pick an expiry date and the repositories to share).'),
      el('li', {}, 'Permissions: Administration (read and write) to create repos, Contents, Metadata and Pull requests (read). Add Checks (read) to see CI results.'),
      el('li', {}, 'Paste it here. It is stored encrypted, only for you, and never shown again.')));
    const input = el('input', { type: 'text', className: 'secret', autocomplete: 'off', spellcheck: false, placeholder: 'github_pat_…', required: true });
    input.setAttribute('aria-label', 'GitHub fine-grained token');
    for (const flag of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) input.setAttribute(flag, flag === 'data-form-type' ? 'other' : 'true');
    const form = el('form', { className: 'actions' }, input, el('button', { className: 'button primary', type: 'submit', disabled: connectorsBusy, textContent: connectorsBusy ? 'Checking…' : 'Connect' }));
    if (githubForm) { const cancel = el('button', { type: 'button', className: 'button', textContent: 'Cancel' }); cancel.addEventListener('click', () => { githubForm = false; renderConnectors(); }); form.append(cancel); }
    form.addEventListener('submit', event => { event.preventDefault(); if (owner === ownerEpoch && input.value.trim()) void githubAction({ action: 'githubLink', token: input.value.trim() }, 'GitHub connected.'); });
    box.append(form);
  } else {
    const replace = el('button', { type: 'button', className: 'button' + (item.state === 'connected' ? '' : ' primary'), disabled: connectorsBusy, textContent: 'Paste a new token' });
    replace.addEventListener('click', () => { githubForm = true; renderConnectors(); });
    const remove = el('button', { type: 'button', className: 'button', disabled: connectorsBusy, textContent: 'Disconnect' });
    remove.addEventListener('click', () => {
      if (owner !== ownerEpoch || !confirm(`Disconnect GitHub? ${companionName()} forgets the token. Nothing on GitHub changes; you can also revoke the token there.`)) return;
      void githubAction({ action: 'githubUnlink' }, 'GitHub disconnected.');
    });
    box.append(el('div', { className: 'actions' }, replace, remove));
  }
  return box;
}
// X / Twitter (#46): works without a key through FxTwitter; an owner may add their own X API bearer token as a backup.
function xControls(item, owner) {
  const box = el('div', { className: 'github-link' });
  if (xForm) {
    const link = el('a', { href: 'https://developer.x.com/en/portal/dashboard', target: '_blank', rel: 'noopener', textContent: 'X developer console' });
    box.append(el('ol', {},
      el('li', {}, 'In the ', link, ', open your app (pay-per-use credits) and copy its Bearer Token.'),
      el('li', {}, 'Paste it here. It is stored encrypted, only for you, never shown again, and used only when FxTwitter cannot read a post.')));
    const input = el('input', { type: 'text', className: 'secret', autocomplete: 'off', spellcheck: false, placeholder: 'AAAAAAAAAAAAAAAAAAAAA…', required: true });
    input.setAttribute('aria-label', 'X API bearer token');
    for (const flag of ['data-1p-ignore', 'data-lpignore', 'data-bwignore', 'data-form-type']) input.setAttribute(flag, flag === 'data-form-type' ? 'other' : 'true');
    const cancel = el('button', { type: 'button', className: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => { xForm = false; renderConnectors(); });
    const form = el('form', { className: 'actions' }, input, el('button', { className: 'button primary', type: 'submit', disabled: connectorsBusy, textContent: connectorsBusy ? 'Checking…' : 'Save key' }), cancel);
    form.addEventListener('submit', event => { event.preventDefault(); if (owner === ownerEpoch && input.value.trim()) void githubAction({ action: 'xKeyLink', token: input.value.trim() }, 'X API key saved.'); });
    box.append(form);
  } else {
    const add = el('button', { type: 'button', className: 'button' + (item.state === 'error' ? ' primary' : ''), disabled: connectorsBusy,
      textContent: item.actions.includes('add') ? 'Add an X API key (optional)' : 'Paste a new key' });
    add.addEventListener('click', () => { xForm = true; renderConnectors(); });
    const row = el('div', { className: 'actions' }, add);
    if (item.actions.includes('remove')) {
      const remove = el('button', { type: 'button', className: 'button', disabled: connectorsBusy, textContent: 'Remove key' });
      remove.addEventListener('click', () => {
        if (owner !== ownerEpoch || !confirm(`Remove your X API key? ${companionName()} keeps reading posts through FxTwitter.`)) return;
        void githubAction({ action: 'xKeyUnlink' }, 'X API key removed.');
      });
      row.append(remove);
    }
    box.append(row);
  }
  return box;
}
// Saves or removes a connector secret (GitHub token, X key); the reply is the Connectors list.
async function githubAction(body, done) {
  if (connectorsBusy || sessionDenied) return;
  const owner = ownerEpoch, token = ++connectorsRequest; connectorsBusy = true; connectorsError = ''; renderConnectors();
  try { const result = await api(body); if (owner !== ownerEpoch || token !== connectorsRequest) return; connectors = result.connectors; githubForm = false; xForm = false; $('announce').textContent = done; }
  catch (error) {
    if (owner !== ownerEpoch || token !== connectorsRequest) return;
    if (error.status === 401 || error.status === 403) { fileAccessDenied(); return; }
    connectorsError = GITHUB_ERRORS[error.message] ?? (body.action.startsWith('minecraft') ? 'The sign-out could not be finished. Try again in a moment.' : body.action.startsWith('x') ? 'X could not be reached. Try again in a moment.' : 'GitHub could not be reached. Try again in a moment.');
  } finally { if (owner === ownerEpoch && token === connectorsRequest) { connectorsBusy = false; renderConnectors(); } }
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
  // Hidden: the read continues once a minute (schedulePoll), so a new message is still noticed (#60).
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; clearTimeout(discordTimer); discordTimer = null; if (!polling) schedulePoll(); return; }
  refreshWearing();
  if (profile) { listRefreshedAt = Date.now(); void boardUI.refresh(); void groupUI.refresh(); }
  if (chatOpened && state.connection !== 'loading' && !polling) { readFailures = 0; await readChat(); }
  schedulePoll();
});
window.addEventListener('offline', () => { clearTimeout(pollTimer); pollTimer = null; clearTimeout(discordTimer); discordTimer = null; renderAll(); });
window.addEventListener('online', () => { if (!canRead()) return; readFailures = 0; if (document.visibilityState === 'hidden') schedulePoll(); else void readChat(); });

start();
