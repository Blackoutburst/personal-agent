// The companion web app: one ongoing chat with your companion, what it remembers, and how it looks.
import { createConversationClient, USER_CHARS } from './conversation-client.mjs';
import { renderCharacter, CHARACTERS, COLORS } from './companion-character.mjs';

const $ = id => document.getElementById(id);
const client = createConversationClient();
const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

let profile = null, runtime = null, view = 'loading', chatOpened = false, state = client.getState();
let draftLook = null, pollTimer = null, polling = false, happyUntil = 0, lastTurnKey = null, memory = null, confirming = null;
const messageNodes = new Map();

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
function draw(element, look, mood) {
  const markup = renderCharacter({ character: look?.character ?? 'pip', color: look?.color ?? 'peach', mood, title: look?.name ?? '' });
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
function linkify(container, text) {
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[.,;!?)]+$/, '');
    container.append(document.createTextNode(text.slice(offset, match.index)));
    let url = null;
    try { url = new URL(candidate); } catch { /* stays text */ }
    if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      const link = document.createElement('a');
      link.href = url.href; link.textContent = candidate; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
      container.append(link, document.createTextNode(match[0].slice(candidate.length)));
    } else container.append(document.createTextNode(match[0]));
    offset = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(offset)));
}

// ---------- Views ----------

function show(next) {
  view = next;
  $('app').dataset.view = next;
  for (const name of ['loading', 'gate', 'chat', 'memories', 'look']) $(`view-${name}`).hidden = name !== next;
  $('nav').hidden = !profile || next === 'gate' || next === 'loading';
  for (const link of document.querySelectorAll('#nav a')) {
    if (link.dataset.view === next) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (next === 'chat') openChat();
  if (next === 'memories') loadMemories();
  if (next === 'look') startLook();
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
  show(['memories', 'look'].includes(hash) ? hash : 'chat');
}

async function start() {
  try {
    const data = await api({ action: 'get' });
    profile = data.profile; runtime = data.runtime;
    applyColors(profile);
    route();
  } catch (error) {
    if (error.status === 401 || error.status === 403) gate('Hi there!', 'Sign in with your Blackoutburst account to see your companion.', { signIn: true });
    else gate('Hmm, I can’t reach your companion', 'The server didn’t answer. Check your connection and try again.', { retry: true });
  }
}

// ---------- Mood ----------

function lastAssistantFor(requestId) { return [...state.messages].reverse().find(m => m.role === 'assistant' && m.requestId === requestId); }
function mood() {
  if (view === 'look') return 'happy';
  const turn = state.turn;
  if (turn?.state === 'streaming' || state.pending) return turn && lastAssistantFor(turn.requestId)?.text ? 'talking' : 'thinking';
  if (Date.now() < happyUntil) return 'happy';
  if (document.activeElement === $('input') && $('input').value.trim()) return 'listening';
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 7) return 'sleepy';
  return 'idle';
}
const MOOD_TEXT = { idle: 'Here with you', listening: 'Listening…', thinking: 'Thinking…', talking: 'Writing to you…', happy: 'Happy to see you', sleepy: 'A bit sleepy' };

// ---------- Chat ----------

async function openChat() {
  if (chatOpened) return;
  chatOpened = true;
  try {
    const opened = await client.open();
    if (opened.connection === 'ready' && opened.threadId === null) await client.create('Companion');
  } catch { /* the state carries the error */ }
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer); pollTimer = null;
  if (!chatOpened || document.visibilityState === 'hidden' || state.connection !== 'ready' || !state.threadId || polling) return;
  const active = state.turn?.state === 'streaming' || Boolean(state.pending) || state.hasMore;
  pollTimer = setTimeout(async () => {
    polling = true;
    const before = state.turn;
    try {
      await client.poll();
      if (before?.state === 'streaming' && state.turn?.requestId === before.requestId && state.turn.state !== 'streaming') {
        if (state.turn.state === 'complete') happyUntil = Date.now() + 3500;
      }
    } catch { /* state shows it */ }
    polling = false;
    schedulePoll();
  }, active ? 500 : 3000);
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
    if (!message.text) continue;
    keep.add(message.id);
    let node = messageNodes.get(message.id);
    if (!node) {
      node = document.createElement('li');
      node.className = `bubble ${message.role === 'user' ? 'user' : 'companion'}`;
      messageNodes.set(message.id, node);
    }
    if (node.dataset.text !== message.text) { textWithLinks(node, message.text); node.dataset.text = message.text; }
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
    if (error.code === 'NOT_SIGNED_IN') return `${name} can't think right now: the ${providerName()} account on the server needs to be signed in again.`;
    if (error.code === 'NO_RUNTIME' || error.code === 'PROVIDER_MISSING') return `${name} isn't set up yet. Ask the server admin to finish the setup.`;
    if (error.code === 'INTERRUPTED') return `${name} got interrupted. Could you say that again?`;
    return `${name} couldn't answer that time. Try again in a moment.`;
  }
  if (turn?.state === 'cancelled') return null;
  if (state.error === 'ACCESS_DENIED') return 'You were signed out. Reload the page to sign in again.';
  if (state.connection === 'reconnecting' || state.connection === 'unavailable') return 'Connection lost. Trying again…';
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
  $('send').disabled = !ready || Boolean(state.pending) || streaming || !input.value.trim() || input.value.length > USER_CHARS;
  input.placeholder = `Write to ${companionName()}…`;
}

function grow() { const input = $('input'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }

// ---------- Memories ----------

const FILE_TITLES = { 'USER.md': 'About you', 'MEMORY.md': 'Our memories' };
async function loadMemories() {
  confirming = null;
  try { memory = (await api({ action: 'memory' })).files; } catch { memory = null; }
  renderMemories();
}
function renderMemories() {
  const name = companionName();
  $('memories-title').textContent = `What ${name} remembers`;
  $('memories-intro').textContent = `${name} writes things down as you talk. If something is wrong or private, make ${name} forget it, or just tell ${name} in the chat.`;
  const root = $('memory-groups');
  root.replaceChildren();
  if (!memory) { root.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Memories couldn’t be loaded. Try again in a moment.' })); return; }
  const total = memory.reduce((sum, file) => sum + file.sections.reduce((n, s) => n + s.items.length, 0), 0);
  if (!total) { root.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: `Nothing yet. ${name} will remember things as you talk.` })); return; }
  for (const file of memory) {
    if (!file.sections.length) continue;
    const card = document.createElement('section'); card.className = 'memory-card';
    card.append(Object.assign(document.createElement('h2'), { textContent: FILE_TITLES[file.file] ?? file.file }));
    for (const section of file.sections) {
      if (section.title) card.append(Object.assign(document.createElement('h3'), { textContent: section.title }));
      const list = document.createElement('ul');
      for (const item of section.items) {
        const row = document.createElement('li'); row.className = 'memory-item';
        row.append(Object.assign(document.createElement('span'), { textContent: item.text }));
        if (confirming === item.id) {
          row.classList.add('confirming');
          const box = document.createElement('span'); box.className = 'confirm';
          const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'yes', textContent: 'Forget' });
          const no = Object.assign(document.createElement('button'), { type: 'button', className: 'no', textContent: 'Keep' });
          yes.addEventListener('click', () => forget(file.file, item.id));
          no.addEventListener('click', () => { confirming = null; renderMemories(); });
          box.append(yes, no); row.append(box);
        } else {
          const button = Object.assign(document.createElement('button'), { type: 'button', className: 'forget', textContent: 'Forget' });
          button.setAttribute('aria-label', `Forget: ${item.text}`);
          button.addEventListener('click', () => { confirming = item.id; renderMemories(); });
          row.append(button);
        }
        list.append(row);
      }
      card.append(list);
    }
    root.append(card);
  }
}
async function forget(file, id) {
  try { memory = (await api({ action: 'forget', file, id })).files; $('announce').textContent = 'Forgotten.'; }
  catch { $('announce').textContent = 'That couldn’t be forgotten. Try again.'; }
  confirming = null; renderMemories();
}

// ---------- Look ----------

function startLook() {
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
      const suggested = CHARACTERS.some(c => c.label === $('name').value) || !$('name').value.trim();
      draftLook.character = item.id; if (suggested) $('name').value = item.label;
      renderLook();
    });
    return button;
  }));
  $('pick-color').replaceChildren(...Object.entries(COLORS).map(([id, colors]) => {
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.dataset.color = id; button.style.background = colors.body; button.setAttribute('aria-label', id);
    button.addEventListener('click', () => { draftLook.color = id; renderLook(); });
    return button;
  }));
  if (first && !$('name').value) $('name').value = 'Pip';
}
function renderLook() {
  if (!draftLook) return;
  draw($('look-preview'), draftLook, 'happy');
  for (const button of $('pick-character').children) {
    button.setAttribute('aria-pressed', String(button.dataset.character === draftLook.character));
    draw(button.querySelector('.pic'), { character: button.dataset.character, color: draftLook.color }, 'idle');
  }
  for (const button of $('pick-color').children) button.setAttribute('aria-pressed', String(button.dataset.color === draftLook.color));
  applyColors(draftLook);
}

// ---------- Rendering ----------

function renderAll() {
  const look = view === 'look' && draftLook ? draftLook : profile;
  const current = mood();
  $('top-name').textContent = companionName();
  $('top-mood').textContent = view === 'chat' ? MOOD_TEXT[current] : '';
  draw($('mini-avatar'), look ?? { character: 'pip', color: 'peach' }, current === 'talking' ? 'talking' : current === 'thinking' ? 'thinking' : 'idle');
  document.title = profile ? companionName() : 'Your companion';
  if (view === 'chat') {
    draw($('stage-character'), profile, current);
    $('stage-name').textContent = companionName();
    $('stage-mood').textContent = MOOD_TEXT[current];
    renderChat();
  }
  if (view === 'look') renderLook();
}

// ---------- Events ----------

client.subscribe(next => {
  const key = next.turn ? `${next.turn.requestId}:${next.turn.state}` : null;
  if (key && key !== lastTurnKey && next.turn.state === 'complete' && lastTurnKey?.startsWith(next.turn.requestId)) happyUntil = Date.now() + 3500;
  lastTurnKey = key;
  state = next;
  renderAll();
  if (!polling) schedulePoll();
});
setInterval(() => { if (view === 'chat') renderAll(); }, 1000);

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('input').value;
  if ($('send').disabled || !text.trim()) return;
  $('input').value = ''; grow();
  try { client.setDraft(''); await client.send(text); }
  catch { $('input').value = text; grow(); }
  schedulePoll();
});
$('input').addEventListener('input', () => { grow(); try { client.setDraft($('input').value); } catch { /* too long: send stays disabled */ } renderAll(); });
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
  try {
    const first = !profile;
    profile = (await api({ action: 'setProfile', profile: { name, character: draftLook.character, color: draftLook.color, timezone } })).profile;
    applyColors(profile);
    if (first || location.hash !== '#chat') location.hash = '#chat'; else route();
  } catch {
    $('look-error').textContent = 'That didn’t save. Names can be up to 24 letters.'; $('look-error').hidden = false;
  } finally { $('save-look').disabled = false; }
});
$('name').addEventListener('input', () => { if (draftLook) draftLook.name = $('name').value; $('look-error').hidden = true; });

window.addEventListener('hashchange', () => { if (view !== 'loading' && view !== 'gate') route(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; return; }
  if (chatOpened && state.opened && state.connection !== 'loading' && !polling) { try { await client.refresh(); } catch { /* state */ } }
  schedulePoll();
});

start();
