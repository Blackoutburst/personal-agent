// Group chat (#53, docs/GROUP-CHAT.md): owners and their companions in one conversation. The Group tab lists the
// groups (unread badges), starts a new one with the other owner(s), and opens one conversation (#group/<id>) with each
// author's name and picture (owners: their profile photo; companions: their current look), markdown, files and
// pictures, reply-to, typing, @mention suggestions and the per-group notification setting. Everything is built from
// DOM nodes and text, never from message HTML. The server decides who may see what; this module only shows it.
import { idleDelay } from './idle.mjs';

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// POLL_MS: the open group's read while things happen; it backs off to 30 s while idle and 60 s in a hidden tab (#60).
const POLL_MS = 1500, HIDDEN_POLL_MS = 60_000, TYPING_PING_MS = 4000, MAX_FILES = 8, MAX_FILE_BYTES = 25 * 1024 * 1024;

export class GroupError extends Error {
  constructor(code, status = 0) { super(code); this.name = 'GroupError'; this.code = code; this.status = status; }
}

// The JSON transport for /api/groups. Errors carry the server's code; 401/403 become ACCESS_DENIED.
export function createGroupTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async function call(body) {
    let response;
    try {
      response = await fetchImpl('api/groups', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw new GroupError('NETWORK_ERROR'); }
    let data = null;
    try { data = await response.json(); } catch { /* handled below */ }
    if (response.status === 401 || response.status === 403) throw new GroupError('ACCESS_DENIED', response.status);
    if (!response.ok || !data || typeof data !== 'object') throw new GroupError(data?.error?.code ?? 'UNAVAILABLE', response.status);
    return data;
  };
}

// Minimal markdown for chat text: fenced code, quotes, lists, inline code, **bold**, *italic*, ~~strike~~, links and
// @mentions. Returns DOM nodes; only text nodes carry message content.
export function renderMarkdown(document, text, { mentionNames = [] } = {}) {
  const node = (tag, props = {}, ...children) => { const item = Object.assign(document.createElement(tag), props); item.append(...children); return item; };
  const names = [...mentionNames].filter(Boolean).sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mention = names.length ? new RegExp(`@(?:${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;
  function plain(container, value) {
    if (!value) return;
    if (!mention) { container.append(document.createTextNode(value)); return; }
    let offset = 0;
    for (const match of value.matchAll(mention)) {
      if (match.index > offset) container.append(document.createTextNode(value.slice(offset, match.index)));
      container.append(node('span', { className: 'group-mention', textContent: match[0] }));
      offset = match.index + match[0].length;
    }
    if (offset < value.length) container.append(document.createTextNode(value.slice(offset)));
  }
  function links(container, value) {
    let offset = 0;
    for (const match of value.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)<>"']+)\)|https?:\/\/[^\s<>"']+/gi)) {
      const labelled = match[1] !== undefined, candidate = labelled ? match[2] : match[0].replace(/[.,;!?)]+$/, '');
      plain(container, value.slice(offset, match.index));
      let url = null;
      try { url = new URL(candidate); } catch { /* stays text */ }
      if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        container.append(node('a', { href: url.href, textContent: labelled ? match[1] : candidate, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }));
        if (!labelled) plain(container, match[0].slice(candidate.length));
      } else plain(container, match[0]);
      offset = match.index + match[0].length;
    }
    plain(container, value.slice(offset));
  }
  function inline(container, value) {
    for (const part of value.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w_])_[^_\n]+_(?![\w_]))/)) {
      if (!part) continue;
      if (/^`[^`\n]+`$/.test(part)) container.append(node('code', { textContent: part.slice(1, -1) }));
      else if (/^\*\*[^*\n]+\*\*$/.test(part)) { const strong = node('strong'); links(strong, part.slice(2, -2)); container.append(strong); }
      else if (/^~~[^~\n]+~~$/.test(part)) { const del = node('del'); links(del, part.slice(2, -2)); container.append(del); }
      else if (/^\*[^*\n]+\*$/.test(part) || /^_[^_\n]+_$/.test(part)) { const em = node('em'); links(em, part.slice(1, -1)); container.append(em); }
      else links(container, part);
    }
  }
  const BLOCK = /^```|^\s*>\s?|^\s*(?:[-*+]|\d+[.)])\s+|^#{1,6}\s+/;
  const blocks = [], lines = String(text ?? '').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const code = [];
      index++;
      while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
      index++;
      blocks.push(node('pre', {}, node('code', { textContent: code.join('\n') })));
    } else if (/^\s*>\s?/.test(line)) {
      const quote = node('blockquote');
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { const p = node('p'); inline(p, lines[index++].replace(/^\s*>\s?/, '')); quote.append(p); }
      blocks.push(quote);
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const list = node(/^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul');
      while (index < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[index])) { const li = node('li'); inline(li, lines[index++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')); list.append(li); }
      blocks.push(list);
    } else if (/^#{1,6}\s+/.test(line)) {
      const strong = node('strong'); inline(strong, line.replace(/^#{1,6}\s+/, '')); blocks.push(node('p', {}, strong)); index++;
    } else if (!line.trim()) index++;
    else {
      const p = node('p'), paragraph = [];
      while (index < lines.length && lines[index].trim() && !BLOCK.test(lines[index])) paragraph.push(lines[index++]);
      paragraph.forEach((value, at) => { if (at) p.append(node('br')); inline(p, value); });
      blocks.push(p);
    }
  }
  return blocks;
}

// The @mention being typed at the caret, or null: { start, query }.
export function mentionQuery(value, caret) {
  const before = String(value ?? '').slice(0, caret);
  const match = /(^|[\s(])@([^\s@]{0,30})$/u.exec(before);
  return match ? { start: before.length - match[2].length - 1, query: match[2] } : null;
}

export function createGroupUI({ document, call = createGroupTransport(), fetchImpl = globalThis.fetch, renderCharacter = null,
  requestId = () => globalThis.crypto.randomUUID(), onDenied = () => {}, onChange = () => {}, now = () => Date.now(), visible = () => true,
  navigate = hash => { globalThis.location.hash = hash; }, activity = null, onNewData = () => {},
  setTimer = (run, ms) => setTimeout(run, ms), clearTimer = id => clearTimeout(id) }) {
  const $ = id => document.getElementById(id);
  const node = (tag, props = {}, ...children) => { const item = Object.assign(document.createElement(tag), props); item.append(...children); return item; };
  let epoch = 0, list = null, unread = 0, available = false, current = null, openId = null, notice = '', creating = false, busy = false;
  // #60: only redraw what changed (a redraw rebuilds every avatar, and their pictures are fetched again).
  let listKey = '', conversationKey = '', lastChange = now(), pollDue = 0, seenSeq = 0;
  let pollTimer = null, polling = false, lastTyping = 0, replyTo = null, uploads = [], suggestions = [], suggestionIndex = 0, menuOpen = false;
  const photos = new Map(), photoRequests = new Map();

  function denied(error) {
    if (error?.code !== 'ACCESS_DENIED') return false;
    clear(); onDenied(); return true;
  }
  function clear() {
    epoch++; list = null; unread = 0; available = false; current = null; openId = null; notice = ''; creating = false; busy = false;
    clearTimer(pollTimer); pollTimer = null; polling = false; replyTo = null; listKey = ''; conversationKey = ''; uploads = []; suggestions = []; menuOpen = false;
    photos.clear(); photoRequests.clear();
    for (const id of ['group-list', 'group-messages', 'group-members', 'group-create-owners', 'group-uploads', 'group-suggest']) $(id)?.replaceChildren();
    for (const id of ['group-note', 'group-chat-note', 'group-title', 'group-typing']) if ($(id)) $(id).textContent = '';
    if ($('group-input')) $('group-input').value = '';
    badge();
  }
  function when(value) {
    const date = new Date(value), today = new Date(now());
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function badge() {
    const count = $('nav-group-badge'), link = $('nav-group');
    if (count) { count.hidden = unread === 0; count.textContent = unread > 99 ? '99+' : String(unread); }
    if (link) { link.hidden = !available; link.setAttribute?.('aria-label', unread ? `Group, ${unread} unread` : 'Group'); }
  }

  // ---------- Avatars ----------

  function photoFor(member) {
    if (!member?.photoVersion) return null;
    const key = member.id + ':' + member.photoVersion;
    if (photos.has(key)) return photos.get(key);
    if (!photoRequests.has(key)) {
      const owner = epoch;
      photoRequests.set(key, call({ action: 'photo', member: member.id }).then(result => {
        if (owner !== epoch) return;
        const photo = result?.photo;
        photos.set(key, photo && /^image\/(png|jpeg|webp)$/.test(photo.mime) && /^[A-Za-z0-9+/=]+$/.test(photo.base64) ? `data:${photo.mime};base64,${photo.base64}` : null);
        renderConversation(); renderList();
      }).catch(() => { photos.set(key, null); }));
    }
    return null;
  }
  function avatar(member, size = 'small') {
    const box = node('span', { className: `group-avatar ${size} ${member?.kind ?? 'system'}` });
    box.setAttribute?.('aria-hidden', 'true');
    if (member?.kind === 'companion' && member.look && renderCharacter) {
      // Trusted markup from the app's own character renderer, never from a message.
      box.innerHTML = renderCharacter({ character: member.look.character, color: member.look.color, outfit: member.look.outfit ?? 'base', mood: 'idle', title: '' });
    } else {
      const photo = member?.kind === 'owner' ? photoFor(member) : null;
      if (photo) box.append(node('img', { src: photo, alt: '' }));
      else box.textContent = (member?.name ?? '·').trim().slice(0, 1).toUpperCase() || '·';
    }
    return box;
  }

  // ---------- The list ----------

  function renderList() {
    badge();
    const target = $('group-list'), note = $('group-note');
    if (!target) return;
    if (note) note.textContent = notice || (list && !list.groups.length && !creating
      ? 'No group yet. Start one with the other owner: you, them and both companions in one chat.' : '');
    const create = $('group-create');
    if (create) {
      create.hidden = !creating;
      const owners = (list?.owners ?? []).filter(owner => !owner.you);
      const picker = $('group-create-owners');
      if (picker && picker.childElementCount !== owners.length) picker.replaceChildren(...owners.map(owner => node('label', { className: 'group-pick' },
        node('input', { type: 'checkbox', value: owner.label, checked: owners.length === 1 }), ' ' + owner.name, node('small', { textContent: ` and ${owner.companionName}` }))));
      if ($('group-create-save')) $('group-create-save').disabled = busy;
    }
    if ($('group-new')) $('group-new').hidden = creating || !(list?.owners ?? []).some(owner => !owner.you);
    target.replaceChildren(...(list?.groups ?? []).map(group => {
      const open = node('a', { href: '#group/' + group.id, className: 'board-topic group-topic' + (group.unread ? ' unread' : '') });
      const faces = node('span', { className: 'group-faces' }, ...group.members.slice(0, 4).map(member => avatar(member, 'tiny')));
      open.append(node('span', { className: 'board-topic-head' }, node('strong', { textContent: group.name }), node('small', { textContent: when(group.updatedAt) })), faces);
      if (group.preview) open.append(node('span', { className: 'board-topic-preview', textContent: `${group.previewName ? group.previewName + ': ' : ''}${group.preview}` }));
      if (group.unread) open.append(node('span', { className: 'board-unread', textContent: group.unread > 99 ? '99+' : String(group.unread), ariaLabel: `${group.unread} unread` }));
      return node('li', { className: 'board-row' }, open);
    }));
  }
  async function refresh() {
    const owner = epoch;
    try {
      const result = await call({ action: 'list' });
      if (owner !== epoch) return;
      const key = JSON.stringify(result), same = key === listKey && !notice && available;
      list = result; unread = result.unread ?? 0; available = true; notice = ''; listKey = key;
      if (same) return;
    } catch (error) {
      if (owner !== epoch || denied(error)) return;
      // An older server has no groups: the tab stays hidden.
      if (error.status === 404 || error.status === 405) { available = false; badge(); return; }
      notice = 'Your groups could not be loaded. It retries in a moment.';
    }
    if (owner === epoch) { renderList(); onChange(); }
  }
  async function createGroup(event) {
    event?.preventDefault?.();
    if (busy) return;
    const members = [...(document.querySelectorAll?.('#group-create-owners input:checked') ?? [])].map(input => input.value);
    if (!members.length) { notice = 'Pick who joins the group.'; renderList(); return; }
    const name = $('group-create-name')?.value.trim();
    const owner = epoch; busy = true; renderList();
    try {
      const result = await call({ action: 'create', requestId: requestId(), members, ...(name ? { name } : {}) });
      if (owner !== epoch) return;
      creating = false; if ($('group-create-name')) $('group-create-name').value = '';
      await refresh();
      navigate('#group/' + result.group.id);
    } catch (error) {
      if (owner !== epoch || denied(error)) return;
      notice = 'The group could not be created. Try again.';
    } finally { if (owner === epoch) { busy = false; renderList(); } }
  }

  // ---------- One conversation ----------

  const member = id => current?.members.find(item => item.id === id) ?? null;
  const self = () => current?.members.find(item => item.you) ?? null;
  function renderMessage(message) {
    if (message.author?.kind === 'system') return node('li', { className: 'group-system' }, node('span', { textContent: message.text }));
    const author = member(message.authorId) ?? { id: message.authorId, kind: message.author?.kind, name: message.name };
    const body = node('div', { className: 'group-body' });
    body.append(node('div', { className: 'group-head' }, node('strong', { textContent: message.name ?? author.name ?? '' }),
      node('small', { textContent: (author.kind === 'companion' ? ' · companion' : '') + ' · ' + when(message.createdAt) + (message.proactive ? ' · on their own' : '') })));
    if (message.replyTo) {
      const quote = node('button', { type: 'button', className: 'group-quote', textContent: `${message.replyTo.name}: ${message.replyTo.preview || '…'}` });
      quote.addEventListener('click', () => $(`group-message-${message.replyTo.id}`)?.scrollIntoView?.({ block: 'center' }));
      body.append(quote);
    }
    if (message.text) body.append(node('div', { className: 'group-text' }, ...renderMarkdown(document, message.text, { mentionNames: current.members.map(item => item.name) })));
    for (const file of message.attachments ?? []) {
      const url = 'api/groups/files/' + encodeURIComponent(file.id);
      if (/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) body.append(node('a', { href: url, target: '_blank', rel: 'noopener', className: 'group-image' }, node('img', { src: url, alt: file.name, loading: 'lazy' })));
      else body.append(node('a', { href: url, target: '_blank', rel: 'noopener', className: 'group-file', textContent: `📎 ${file.name}` }));
    }
    const reply = node('button', { type: 'button', className: 'text-button group-reply', textContent: 'Reply' });
    reply.setAttribute?.('aria-label', `Reply to ${message.name}`);
    reply.addEventListener('click', () => { replyTo = message; renderComposer(); $('group-input')?.focus?.(); });
    body.append(reply);
    return node('li', { id: `group-message-${message.id}`, className: 'group-message' + (author.you ? ' mine' : '') + (author.kind === 'companion' ? ' companion' : '') },
      avatar(author), body);
  }
  const keyOf = () => JSON.stringify([current.name, current.members, current.messages.map(item => [item.id, item.seq, item.text, item.attachments?.length ?? 0]),
    current.typing, current.paused, current.notify, notice, menuOpen]);
  function renderConversation() {
    if (!current) return;
    conversationKey = keyOf();
    if ($('group-title')) $('group-title').textContent = current.name;
    $('group-members')?.replaceChildren(...current.members.map(item => node('span', { className: 'group-member', title: item.kind === 'companion' ? `${item.name} (companion)` : item.name },
      avatar(item, 'tiny'), node('span', { textContent: item.name }))));
    const history = $('group-history'), stick = history ? history.scrollHeight - history.scrollTop - history.clientHeight < 80 : true;
    $('group-messages')?.replaceChildren(...current.messages.map(renderMessage));
    const typing = (current.typing ?? []).filter(id => id !== self()?.id).map(id => member(id)?.name).filter(Boolean);
    if ($('group-typing')) $('group-typing').textContent = typing.length ? `${typing.join(', ')} ${typing.length > 1 ? 'are' : 'is'} typing…` : '';
    const note = $('group-chat-note');
    if (note) { note.textContent = notice || (current.paused ? 'The companions are taking a break until someone writes.' : ''); note.hidden = !note.textContent; }
    if ($('group-notify')) $('group-notify').value = current.notify ?? 'all';
    if ($('group-menu')) $('group-menu').hidden = !menuOpen;
    if (history && stick) history.scrollTop = history.scrollHeight;
    renderComposer();
  }
  function renderComposer() {
    const quote = $('group-replying');
    if (quote) {
      quote.hidden = !replyTo;
      const cancel = node('button', { type: 'button', className: 'text-button', textContent: 'Cancel' });
      cancel.addEventListener('click', () => { replyTo = null; renderComposer(); });
      quote.replaceChildren(...(replyTo ? [node('span', { textContent: `Replying to ${replyTo.name}: ${(replyTo.text || '').slice(0, 80)}` }), cancel] : []));
    }
    $('group-uploads')?.replaceChildren(...uploads.map(item => {
      const remove = node('button', { type: 'button', className: 'text-button', textContent: '✕' });
      remove.setAttribute?.('aria-label', `Remove ${item.file.name}`);
      remove.addEventListener('click', () => { uploads = uploads.filter(other => other !== item); renderComposer(); });
      return node('li', {}, node('span', { textContent: `${item.file.name}${item.state === 'uploading' ? ' (uploading…)' : item.state === 'failed' ? ' (could not upload)' : ''}` }), remove);
    }));
    if ($('group-uploads')) $('group-uploads').hidden = !uploads.length;
    const box = $('group-suggest');
    if (box) {
      box.hidden = !suggestions.length;
      box.replaceChildren(...suggestions.map((item, index) => {
        const option = node('li', { className: index === suggestionIndex ? 'active' : '' }, avatar(item, 'tiny'), node('span', { textContent: item.name }),
          node('small', { textContent: item.kind === 'companion' ? ' companion' : '' }));
        option.setAttribute?.('role', 'option');
        option.addEventListener('mousedown', event => { event.preventDefault(); pick(item); });
        return option;
      }));
    }
    if ($('group-send')) $('group-send').disabled = busy || (!$('group-input')?.value.trim() && !uploads.some(item => item.state === 'ready')) || uploads.some(item => item.state === 'uploading');
  }
  function merge(messages) {
    const seen = new Map(current.messages.map(message => [message.id, message]));
    for (const message of messages) seen.set(message.id, message);
    current.messages = [...seen.values()].sort((a, b) => a.seq - b.seq).slice(-300);
  }
  function markRead() {
    if (!current || document.visibilityState === 'hidden' || !visible()) return;
    const last = current.messages.at(-1)?.seq ?? 0;
    if (last <= (current.readSeq ?? 0)) return;
    current.readSeq = last;
    const owner = epoch, groupId = current.id;
    call({ action: 'read', groupId, seq: last }).then(result => {
      if (owner !== epoch) return;
      unread = result.unread ?? unread;
      const entry = list?.groups.find(group => group.id === groupId); if (entry) entry.unread = 0;
      badge(); onChange();
    }).catch(error => { if (owner === epoch) denied(error); });
  }
  async function open(groupId) {
    if (!GROUP_ID.test(groupId)) return;
    const owner = epoch;
    if (current?.id !== groupId) { current = null; replyTo = null; uploads = []; menuOpen = false; $('group-messages')?.replaceChildren(); if ($('group-title')) $('group-title').textContent = ''; }
    openId = groupId; notice = '';
    try {
      const result = await call({ action: 'snapshot', groupId });
      if (owner !== epoch || openId !== groupId) return;
      current = { id: groupId, name: result.group.name, members: result.group.members, notify: result.group.notify, messages: result.messages,
        cursor: result.cursor, typing: result.typing ?? [], paused: result.paused === true, readSeq: 0 };
      seenSeq = current.messages.at(-1)?.seq ?? 0; lastChange = now();
      renderConversation(); markRead(); schedule();
    } catch (error) {
      if (owner !== epoch || denied(error)) return;
      notice = error.code === 'NOT_FOUND' ? 'This group was not found. You may have left it.' : 'The group could not be loaded. It retries in a moment.';
      if ($('group-chat-note')) { $('group-chat-note').textContent = notice; $('group-chat-note').hidden = false; }
      if (error.code !== 'NOT_FOUND') schedule();
    }
  }
  function close() { if (current) sendTyping(false); openId = null; clearTimer(pollTimer); pollTimer = null; }
  // Fast while the group is lively or the owner uses the page, then 5 s → 15 s → 30 s; once a minute in a hidden tab.
  function delay() {
    if (document.visibilityState === 'hidden') return HIDDEN_POLL_MS;
    if (current?.typing?.length) return POLL_MS;
    return idleDelay(Math.min(now() - lastChange, activity?.quietMs() ?? Infinity), POLL_MS);
  }
  function schedule() {
    clearTimer(pollTimer); pollTimer = null;
    if (!openId) return;
    const ms = delay(); pollDue = now() + ms;
    pollTimer = setTimer(poll, ms);
  }
  activity?.onWake(reason => {
    if (!openId || polling) return;
    if (reason === 'focus' || reason === 'visible') { if (pollTimer && pollDue - now() > POLL_MS) { clearTimer(pollTimer); pollTimer = null; void poll(); } }
    else if (pollTimer && pollDue - now() > POLL_MS) schedule();
  });
  async function poll() {
    pollTimer = null;
    if (!openId) return;
    if (polling) return schedule();
    if (!current) return open(openId);
    const owner = epoch, groupId = current.id;
    polling = true;
    try {
      for (let page = 0; page < 5; page++) {
        const result = await call({ action: 'events', groupId, cursor: current.cursor });
        if (owner !== epoch || current?.id !== groupId) return;
        merge(result.messages); current.cursor = result.cursor; current.name = result.name ?? current.name;
        if (Array.isArray(result.members)) current.members = result.members;
        current.typing = result.typing ?? []; current.paused = result.paused === true;
        if (!result.hasMore) break;
      }
      const lastSeq = current.messages.at(-1)?.seq ?? 0;
      if (keyOf() !== conversationKey) {
        lastChange = now();
        if (lastSeq > seenSeq) onNewData(groupId);
        renderConversation();
      }
      seenSeq = Math.max(seenSeq, lastSeq);
      markRead();
    } catch (error) {
      if (owner !== epoch || denied(error)) return;
      if (error.code === 'NOT_FOUND') { notice = 'You are no longer in this group.'; renderConversation(); openId = null; }
    } finally { polling = false; if (owner === epoch) schedule(); }
  }
  function sendTyping(active) {
    if (!current) return;
    const at = now();
    if (active && at - lastTyping < TYPING_PING_MS) return;
    if (!active && !lastTyping) return;
    lastTyping = active ? at : 0;
    call({ action: 'typing', groupId: current.id, active }).catch(() => {});
  }
  async function send(event) {
    event?.preventDefault?.();
    if (!current || busy) return;
    const input = $('group-input'), text = input?.value ?? '';
    if (uploads.some(item => item.state === 'uploading')) return;
    const files = uploads.filter(item => item.state === 'ready').map(item => item.id);
    if (!text.trim() && !files.length) return;
    const owner = epoch, groupId = current.id, key = requestId();
    busy = true; renderComposer();
    try {
      const result = await call({ action: 'post', groupId, requestId: key, text, ...(replyTo ? { replyTo: replyTo.id } : {}), ...(files.length ? { attachments: files } : {}) });
      if (owner !== epoch || current?.id !== groupId) return;
      input.value = ''; replyTo = null; uploads = []; suggestions = []; lastTyping = 0; notice = '';
      merge([result.message]); lastChange = now();
      renderConversation(); markRead();
    } catch (error) {
      if (owner !== epoch || denied(error)) return;
      notice = 'Your message was not sent. Try again.';
      renderConversation();
    } finally { if (owner === epoch) { busy = false; renderComposer(); } }
  }
  async function attach(fileList) {
    if (!current) return;
    const groupId = current.id, owner = epoch;
    for (const file of [...fileList].slice(0, Math.max(0, MAX_FILES - uploads.length))) {
      const item = { file, state: 'uploading', id: null };
      uploads.push(item);
      if (file.size > MAX_FILE_BYTES || !file.size) { item.state = 'failed'; renderComposer(); continue; }
      renderComposer();
      try {
        const response = await fetchImpl('api/groups/files', { method: 'POST', credentials: 'same-origin', cache: 'no-store', body: file,
          headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-Group-Id': groupId, 'X-Request-Id': requestId(),
            'X-File-Name': encodeURIComponent(file.name || 'file') } });
        const data = await response.json().catch(() => null);
        if (owner !== epoch) return;
        if (response.status === 401 || response.status === 403) { denied(new GroupError('ACCESS_DENIED')); return; }
        if (!response.ok || typeof data?.file?.id !== 'string') throw new GroupError('UPLOAD_FAILED');
        item.id = data.file.id; item.state = 'ready';
      } catch { item.state = 'failed'; }
      if (owner === epoch) renderComposer();
    }
  }
  function suggest() {
    const input = $('group-input');
    const query = input && current ? mentionQuery(input.value, input.selectionStart ?? input.value.length) : null;
    suggestions = query ? current.members.filter(item => !item.you && item.name.toLowerCase().startsWith(query.query.toLowerCase())).slice(0, 6) : [];
    suggestionIndex = 0;
    renderComposer();
  }
  function pick(item) {
    const input = $('group-input');
    const caret = input.selectionStart ?? input.value.length, query = mentionQuery(input.value, caret);
    if (!query) return;
    input.value = input.value.slice(0, query.start) + '@' + item.name + ' ' + input.value.slice(caret);
    const at = query.start + item.name.length + 2;
    input.setSelectionRange?.(at, at);
    suggestions = []; renderComposer(); input.focus?.();
  }
  async function change(body, failure) {
    if (!current || busy) return null;
    const owner = epoch, groupId = current.id;
    busy = true;
    try {
      const result = await call({ ...body, groupId });
      return owner === epoch ? result : null;
    } catch (error) {
      if (owner !== epoch || denied(error)) return null;
      notice = failure; renderConversation(); return null;
    } finally { if (owner === epoch) busy = false; }
  }

  // ---------- Wiring ----------

  $('group-new')?.addEventListener('click', () => { creating = true; notice = ''; renderList(); });
  $('group-create-cancel')?.addEventListener('click', () => { creating = false; notice = ''; renderList(); });
  $('group-create')?.addEventListener('submit', createGroup);
  $('group-composer')?.addEventListener('submit', send);
  $('group-input')?.addEventListener('input', () => { sendTyping(Boolean($('group-input').value.trim())); suggest(); });
  $('group-input')?.addEventListener('keydown', event => {
    if (suggestions.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length; renderComposer(); return;
    }
    if (suggestions.length && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); pick(suggestions[suggestionIndex]); return; }
    if (event.key === 'Escape' && suggestions.length) { suggestions = []; renderComposer(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && globalThis.matchMedia?.('(pointer: fine)')?.matches) { event.preventDefault(); void send(); }
  });
  $('group-input')?.addEventListener('blur', () => { setTimeout(() => { suggestions = []; renderComposer(); }, 150); });
  $('group-attach')?.addEventListener('click', () => $('group-file-picker')?.click());
  $('group-file-picker')?.addEventListener('change', event => { void attach(event.target.files ?? []); event.target.value = ''; });
  $('group-menu-button')?.addEventListener('click', () => { menuOpen = !menuOpen; renderConversation(); });
  $('group-notify')?.addEventListener('change', async event => {
    const result = await change({ action: 'settings', notify: event.target.value }, 'The notification setting was not saved.');
    if (result && current) { current.notify = result.notify; renderConversation(); }
  });
  $('group-rename')?.addEventListener('click', async () => {
    const name = globalThis.prompt?.('Group name', current?.name ?? '')?.trim();
    if (!name || name === current?.name) return;
    const result = await change({ action: 'rename', name }, 'The group could not be renamed.');
    if (result && current) { current.name = result.group.name; menuOpen = false; renderConversation(); void refresh(); }
  });
  $('group-leave')?.addEventListener('click', async () => {
    if (!current || !globalThis.confirm?.(`Leave ${current.name}? Your companion leaves with you.`)) return;
    const result = await change({ action: 'leave' }, 'You could not leave the group. Try again.');
    if (result) { close(); current = null; await refresh(); navigate('#group'); }
  });

  return {
    clear, refresh, open, close, send, attach,
    get unread() { return unread; }, get available() { return available; }, get openGroup() { return openId; },
    // For tests.
    get state() { return { list, current, notice, suggestions, uploads, replyTo }; }
  };
}
