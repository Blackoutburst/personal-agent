// The Board tab (#55): the companion's Board messages, one sub-conversation per Board thread or ticket, out of the main
// chat. This module draws the list (open or archived), the tab badge and the per-topic actions; opening a topic shows
// it in the chat view (companion-app.mjs). inbox: { boardInbox(archived), boardRead(threadId), boardArchive(threadId, archived) }
// from the conversation client, which validates every response.
export function createBoardUI({ document, inbox, onOpen = () => {}, onDenied = () => {}, onChange = () => {}, now = () => Date.now() }) {
  const $ = id => document.getElementById(id), node = (tag, props = {}, ...children) => { const item = Object.assign(document.createElement(tag), props); item.append(...children); return item; };
  let ownerEpoch = 0, request = 0, archived = false, current = null, unread = 0, any = false, busy = false, notice = '', visible = false;
  const topics = new Map();
  const active = (owner, token) => owner === ownerEpoch && token === request;
  function denied(error) {
    if (error?.code !== 'ACCESS_DENIED') return false;
    clear(); onDenied(); return true;
  }
  function clear() {
    ownerEpoch++; request++; archived = false; current = null; unread = 0; any = false; busy = false; notice = ''; visible = false; topics.clear();
    $('board-list')?.replaceChildren(); if ($('board-note')) $('board-note').textContent = '';
    badge();
  }
  function when(value) {
    const date = new Date(value), today = new Date(now());
    return date.toDateString() === today.toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function badge() {
    const count = $('nav-board-badge'), link = $('nav-board');
    if (count) { count.hidden = unread === 0; count.textContent = unread > 99 ? '99+' : String(unread); }
    if (link) { link.hidden = !any; link.setAttribute?.('aria-label', unread ? `Board, ${unread} unread` : 'Board'); }
  }
  function render() {
    badge();
    const list = $('board-list'), note = $('board-note');
    if (!list) return;
    for (const [id, pressed] of [['board-filter-open', !archived], ['board-filter-archived', archived]]) {
      const button = $(id); if (button) { button.setAttribute?.('aria-pressed', String(pressed)); button.disabled = busy; }
    }
    if (note) note.textContent = notice || (current && !current.length ? (archived ? 'Nothing archived yet. Mark a topic done to keep it here.'
      : 'No Board messages. When your companion has something about a ticket, it shows up here, one conversation per ticket.') : '');
    list.replaceChildren(...(current ?? []).map(item => {
      const open = node('button', { type: 'button', className: 'board-topic' + (item.unread ? ' unread' : '') });
      const head = node('span', { className: 'board-topic-head' }, node('strong', { textContent: item.label }), node('small', { textContent: when(item.updatedAt) }));
      open.append(head);
      if (item.preview) open.append(node('span', { className: 'board-topic-preview', textContent: (item.previewRole === 'user' ? 'You: ' : '') + item.preview }));
      if (item.unread) open.append(node('span', { className: 'board-unread', textContent: item.unread > 99 ? '99+' : String(item.unread), ariaLabel: `${item.unread} unread` }));
      open.addEventListener('click', () => onOpen(item.threadId));
      const toggle = node('button', { type: 'button', className: 'text-button', textContent: item.archived ? 'Reopen' : 'Done', disabled: busy });
      toggle.addEventListener('click', () => archive(item.threadId, !item.archived));
      return node('li', { className: 'board-row' }, open, toggle);
    }));
  }
  function remember(threads) { for (const item of threads) topics.set(item.threadId, item); }
  // Reloads the badge and, when the tab is open, the list.
  async function refresh() {
    const owner = ownerEpoch, token = ++request;
    try {
      const open = await inbox.boardInbox(false);
      if (!active(owner, token)) return;
      remember(open.threads); unread = open.unread; any = open.any;
      if (visible && archived) {
        const done = await inbox.boardInbox(true);
        if (!active(owner, token)) return;
        remember(done.threads); current = done.threads;
      } else current = open.threads;
      notice = '';
    } catch (error) {
      if (!active(owner, token) || denied(error)) return;
      if (visible) notice = 'The Board inbox could not be loaded. It retries in a moment.';
    }
    if (active(owner, token)) { render(); onChange(); }
  }
  async function show() { visible = true; render(); await refresh(); }
  function hide() { visible = false; }
  async function filter(next) {
    if (busy || typeof next !== 'boolean') return;
    archived = next; current = null; render(); await refresh();
  }
  async function markRead(threadId) {
    const owner = ownerEpoch;
    try {
      const result = await inbox.boardRead(threadId);
      if (owner !== ownerEpoch) return;
      unread = result.unread;
      const item = topics.get(threadId); if (item) item.unread = 0;
      render(); onChange();
    } catch (error) { if (owner === ownerEpoch) denied(error); }
  }
  async function archive(threadId, next) {
    if (busy) return false;
    const owner = ownerEpoch; busy = true; notice = ''; render();
    try {
      const result = await inbox.boardArchive(threadId, next);
      if (owner !== ownerEpoch) return false;
      unread = result.unread;
      const item = topics.get(threadId); if (item) { item.archived = next; if (next) item.unread = 0; }
      return true;
    } catch (error) {
      if (owner !== ownerEpoch || denied(error)) return false;
      notice = 'That change could not be confirmed. Reload the list and try again.';
      return false;
    } finally {
      if (owner === ownerEpoch) { busy = false; await refresh(); }
    }
  }
  $('board-filter-open')?.addEventListener('click', () => filter(false));
  $('board-filter-archived')?.addEventListener('click', () => filter(true));
  return { clear, refresh, show, hide, markRead, archive, topic: threadId => topics.get(threadId) ?? null,
    get unread() { return unread; }, get any() { return any; } };
}
