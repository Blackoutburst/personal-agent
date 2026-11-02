// The companion web app: one ongoing chat with your companion, what it remembers, and how it looks.
import { createConversationClient, USER_CHARS } from './conversation-client.mjs';
import { renderCharacter, CHARACTERS, COLORS, OUTFITS, HAS_OUTFITS } from './companion-character.mjs';
import { createRemindersUI } from './reminders-ui.mjs';

const $ = id => document.getElementById(id);
const client = createConversationClient();
const remindersUI = createRemindersUI({ document });
const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

let profile = null, runtime = null, view = 'loading', chatOpened = false, state = client.getState();
let wearing = 'base', draftLook = null, pollTimer = null, polling = false, happyUntil = 0, lastTurnKey = null, memory = null, confirming = null;
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
    profile = data.profile; runtime = data.runtime; wearing = data.wearing ?? 'base';
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
      await remindersUI.refreshIfOpen();
      if (before?.state === 'streaming' && state.turn?.requestId === before.requestId && state.turn.state !== 'streaming') {
        if (state.turn.state === 'complete') happyUntil = Date.now() + 5000;
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
  $('pick-outfit').replaceChildren(...[['auto', 'Automatic']].concat(OUTFITS).map(([id, label]) => {
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.dataset.outfit = id;
    const pic = document.createElement('span'); pic.className = 'pic'; pic.setAttribute('aria-hidden', 'true');
    button.append(pic, Object.assign(document.createElement('span'), { textContent: label }));
    button.addEventListener('click', () => { draftLook.outfit = id; renderLook(); });
    return button;
  }));
  $('theme-pick').hidden = first;
  renderThemePick();
  $('discord-pick').hidden = first;
  if (!first) loadDiscord();
}

// App theme: System (default), Light or Dark. companion-theme.js applies and stores it.
function renderThemePick() {
  const current = window.companionTheme?.get() ?? 'system';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    const on = button.dataset.themeChoice === current;
    button.setAttribute('aria-checked', String(on)); button.tabIndex = on ? 0 : -1;
  }
}
function pickTheme(choice) {
  window.companionTheme?.set(choice); renderThemePick();
  document.querySelector(`[data-theme-choice="${choice}"]`)?.focus();
}
const THEME_ORDER = ['system', 'light', 'dark'];
for (const button of document.querySelectorAll('[data-theme-choice]')) {
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
  const look = view === 'look' && draftLook ? draftLook : profile;
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
  if (view === 'look') renderLook();
}

// ---------- Events ----------

client.subscribe(next => {
  const key = next.turn ? `${next.turn.requestId}:${next.turn.state}` : null;
  if (key && key !== lastTurnKey && next.turn.state === 'complete' && lastTurnKey?.startsWith(next.turn.requestId)) happyUntil = Date.now() + 5000;
  lastTurnKey = key;
  state = next;
  if (next.connection === 'denied' || next.error === 'ACCESS_DENIED') remindersUI.clear();
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
    const saved = await api({ action: 'setProfile', profile: { name, character: draftLook.character, color: draftLook.color, timezone,
      outfit: draftLook.outfit ?? 'auto' } });
    profile = saved.profile; wearing = saved.wearing ?? wearing;
    applyColors(profile);
    if (first || location.hash !== '#chat') location.hash = '#chat'; else route();
  } catch {
    $('look-error').textContent = 'That didn’t save. Names can be up to 24 letters.'; $('look-error').hidden = false;
  } finally { $('save-look').disabled = false; }
});
$('name').addEventListener('input', () => { if (draftLook) draftLook.name = $('name').value; $('look-error').hidden = true; });

// ---------- Discord (docs/DISCORD.md): the owner's own bot, for chatting in Discord DMs ----------

let discord = null, discordBusy = false, discordError = '', discordTimer = null;
const DISCORD_ERRORS = { INVALID_TOKEN: 'That token didn’t work. Copy it again from your bot’s page (Bot → Reset Token).',
  BOT_IN_USE: 'This bot is already linked to another companion. Create a new bot for this one.' };
async function loadDiscord() {
  clearTimeout(discordTimer);
  try { discord = (await api({ action: 'discord' })).discord; } catch { discord = discord ?? null; }
  renderDiscord();
  // While waiting for the pairing message, check again every few seconds.
  if (view === 'look' && discord?.linked && !discord.user && document.visibilityState !== 'hidden') discordTimer = setTimeout(loadDiscord, 4000);
}
async function discordAction(body) {
  discordBusy = true; discordError = ''; renderDiscord();
  try { discord = (await api(body)).discord; }
  catch (error) { discordError = DISCORD_ERRORS[error.message] ?? 'Discord couldn’t be reached. Try again in a moment.'; }
  discordBusy = false; renderDiscord();
  if (discord?.linked && !discord.user) { clearTimeout(discordTimer); discordTimer = setTimeout(loadDiscord, 4000); }
}
function el(tag, props = {}, ...children) { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; }
function renderDiscord() {
  const body = $('discord-body'), name = companionName();
  if (!discord) { body.replaceChildren(el('p', { textContent: 'Loading…' })); return; }
  const nodes = [];
  if (!discord.linked) {
    const link = el('a', { href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener', textContent: 'Discord Developer Portal' });
    nodes.push(el('p', {}, `Talk to ${name} in Discord direct messages. Reminders arrive there too.`),
      el('ol', {}, el('li', {}, 'Open the ', link, ' and create a New Application.'),
        el('li', {}, 'In ', el('strong', { textContent: 'Bot' }), ', press ', el('strong', { textContent: 'Reset Token' }), ' and copy the token.'),
        el('li', {}, 'Paste it here. It stays on the server and is never shown again.')));
    const input = el('input', { id: 'discord-token', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Bot token', required: true });
    input.setAttribute('aria-label', 'Discord bot token');
    const form = el('form', {}, input, el('button', { className: 'button primary', type: 'submit', disabled: discordBusy, textContent: discordBusy ? 'Connecting…' : 'Connect' }));
    form.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) discordAction({ action: 'discordLink', token: input.value.trim() }); });
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
    off.addEventListener('click', () => { if (confirm(`Disconnect ${discord.bot.name} from ${name}?`)) discordAction({ action: 'discordUnlink' }); });
    nodes.push(el('div', { className: 'actions' }, off));
  }
  if (discordError) nodes.push(el('p', { className: 'error', role: 'alert', textContent: discordError }));
  body.replaceChildren(...nodes);
}

window.addEventListener('hashchange', () => { if (view !== 'loading' && view !== 'gate') route(); });
// Her outfit follows the time of day: check again every 10 minutes and when the page comes back.
async function refreshWearing() {
  if (!profile || document.visibilityState === 'hidden') return;
  try { const data = await api({ action: 'get' }); wearing = data.wearing ?? wearing; runtime = data.runtime ?? runtime; renderAll(); }
  catch { /* the chat shows connection problems */ }
}
setInterval(refreshWearing, 10 * 60 * 1000);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; return; }
  refreshWearing();
  if (chatOpened && state.opened && state.connection !== 'loading' && !polling) { try { await client.refresh(); } catch { /* state */ } }
  schedulePoll();
});

start();
