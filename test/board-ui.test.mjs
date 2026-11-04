import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardUI } from '../public/board-ui.mjs';
import { createConversationClient, parseBoardInbox, ConversationError } from '../public/conversation-client.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; this.attributes = {}; this.hidden = false; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, run) { this.listeners[type] = run; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}
const T1 = '1e80ef85-15aa-4afb-99cf-e415fa3e4971', T2 = '2b7c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const topic = (patch = {}) => ({ threadId: T1, label: '#15 · Fix login', ticketNumber: 15, general: false, archived: false, unread: 2,
  updatedAt: Date.UTC(2026, 10, 4, 12), preview: 'Codex asks whether to ship.', previewRole: 'assistant', ...patch });
function fixture(inbox) {
  const ids = Object.fromEntries(['board-list', 'board-note', 'board-filter-open', 'board-filter-archived', 'nav-board', 'nav-board-badge'].map(id => [id, new Element(id === 'board-list' ? 'ul' : 'div')]));
  ids['nav-board'].hidden = true; const opened = []; let denied = 0;
  const ui = createBoardUI({ document: { createElement: tag => new Element(tag), getElementById: id => ids[id] }, inbox,
    onOpen: id => opened.push(id), onDenied: () => denied++, now: () => Date.UTC(2026, 10, 4, 13) });
  const all = () => { const out = []; const visit = node => { out.push(node); node.children.forEach(visit); }; Object.values(ids).forEach(visit); return out; };
  const buttons = () => all().filter(node => node.tag === 'button');
  return { ui, ids, opened, buttons, denied: () => denied };
}

test('the Board tab lists one row per topic with label, preview and unread count, and the nav badge totals them', async () => {
  const calls = [];
  const f = fixture({ boardInbox: async archived => { calls.push(['list', archived]); return { threads: [topic({ label: '<img onerror=x>' }), topic({ threadId: T2, label: 'Design chat', unread: 0, previewRole: 'user', preview: 'Thanks' })], unread: 2, any: true }; } });
  await f.ui.refresh();
  assert.equal(f.ids['nav-board'].hidden, false, 'The tab appears once there is a Board conversation');
  assert.equal(f.ids['nav-board-badge'].hidden, false); assert.equal(f.ids['nav-board-badge'].textContent, '2');
  await f.ui.show();
  const text = f.ids['board-list'].textContent;
  assert.ok(text.includes('<img onerror=x>'), 'Labels are text, never markup');
  assert.ok(text.includes('Codex asks whether to ship.')); assert.ok(text.includes('You: Thanks'));
  assert.equal(f.ids['board-list'].children.length, 2);
  f.buttons().find(node => node.className.includes('board-topic')).click();
  assert.deepEqual(f.opened, [T1]);
  assert.deepEqual(f.ui.topic(T1).ticketNumber, 15);
  assert.ok(calls.every(([, archived]) => archived === false));
});

test('marking read and archiving update the badge; the Archived filter lists done topics with Reopen', async () => {
  let open = [topic()], done = [], unread = 2;
  const calls = [];
  const f = fixture({
    boardInbox: async archived => ({ threads: archived ? done : open, unread, any: true }),
    boardRead: async threadId => { calls.push(['read', threadId]); unread = 0; return { threadId, unread }; },
    boardArchive: async (threadId, archived) => { calls.push(['archive', threadId, archived]);
      if (archived) { done = open.map(item => ({ ...item, archived: true, unread: 0 })); open = []; } else { open = done.map(item => ({ ...item, archived: false })); done = []; }
      unread = 0; return { threadId, archived, unread }; } });
  await f.ui.show();
  await f.ui.markRead(T1);
  assert.equal(f.ids['nav-board-badge'].hidden, true);
  assert.equal(f.ui.topic(T1).unread, 0);
  await f.buttons().find(node => node.textContent.endsWith('Done')).click();
  assert.deepEqual(calls.at(-1), ['archive', T1, true]);
  assert.equal(f.ids['board-list'].children.length, 0);
  assert.match(f.ids['board-note'].textContent, /No Board messages/);
  await f.ids['board-filter-archived'].click();
  assert.equal(f.ids['board-filter-archived'].attributes['aria-pressed'], 'true');
  assert.equal(f.ids['board-list'].children.length, 1);
  await f.buttons().find(node => node.textContent.endsWith('Reopen')).click();
  assert.deepEqual(calls.at(-1), ['archive', T1, false]);
  assert.equal(f.ids['board-list'].children.length, 0);
  assert.match(f.ids['board-note'].textContent, /Nothing archived/);
});

test('#61: the tab badge reads 1-9 then 9+, unread rows carry a dot and a count, and the row button has an icon, a label and a tooltip', async () => {
  const many = Array.from({ length: 12 }, (_, i) => topic({ threadId: `1e80ef85-15aa-4afb-99cf-${String(i).padStart(12, '0')}`, unread: i === 0 ? 14 : i % 2 }));
  let unread = 9;
  const f = fixture({ boardInbox: async () => ({ threads: many, unread, any: true }),
    boardRead: async threadId => { const item = many.find(row => row.threadId === threadId); item.unread = 0; unread -= 1; return { threadId, unread }; } });
  await f.ui.show();
  assert.equal(f.ids['nav-board-badge'].textContent, '9');
  assert.equal(f.ids['nav-board'].attributes['aria-label'], 'Board, 9 unread conversations');
  unread = 12; await f.ui.refresh();
  assert.equal(f.ids['nav-board-badge'].textContent, '9+');
  const rows = f.ids['board-list'].children, find = (node, name) => node.className === name ? node : node.children.map(child => find(child, name)).find(Boolean);
  assert.ok(rows[0].className.includes('unread') && find(rows[0], 'board-dot'), 'An unread conversation is marked');
  assert.equal(find(rows[0], 'board-unread').textContent, '9+');
  assert.ok(!rows[2].className.includes('unread') && !find(rows[2], 'board-dot'), 'A read conversation has no marker');
  const toggle = rows[0].children[1];
  assert.equal(toggle.textContent, '✓Done'); assert.match(toggle.title, /move this conversation to Archived/); assert.match(toggle.ariaLabel, /^Done: #15/);
  assert.equal(find(toggle, 'board-toggle-icon').ariaHidden, 'true');
  // Opening a conversation marks it read: its marker goes and the badge drops.
  await f.ui.markRead(many[0].threadId);
  assert.equal(f.ids['nav-board-badge'].textContent, '9+'); assert.equal(f.ui.unread, 11);
  assert.ok(!f.ids['board-list'].children[0].className.includes('unread'));
  unread = 1; await f.ui.refresh(); assert.equal(f.ids['nav-board-badge'].textContent, '1');
  await f.ui.markRead(many[1].threadId); assert.equal(f.ids['nav-board-badge'].hidden, true);
});

test('failures say so without detail, access denial clears the tab, and an owner reset fences late answers', async () => {
  let fail = 'NETWORK_ERROR';
  const f = fixture({ boardInbox: async () => { if (fail) throw new ConversationError(fail); return { threads: [topic()], unread: 2, any: true }; } });
  await f.ui.show();
  assert.match(f.ids['board-note'].textContent, /could not be loaded/);
  fail = 'ACCESS_DENIED'; await f.ui.refresh();
  assert.equal(f.denied(), 1); assert.equal(f.ids['nav-board'].hidden, true);
  let release; fail = null;
  const slow = fixture({ boardInbox: () => new Promise(resolve => { release = () => resolve({ threads: [topic()], unread: 5, any: true }); }) });
  const pending = slow.ui.refresh(); slow.ui.clear(); release(); await pending;
  assert.equal(slow.ids['nav-board-badge'].hidden, true, 'A late answer for a cleared owner shows nothing');
});

test('the conversation client sends the Board actions and validates their answers', async () => {
  const sent = [];
  const transport = async (action, payload) => { sent.push([action, payload]);
    if (action === 'boardInbox') return { version: 1, synthetic: false, threads: [topic()], unread: 2, any: true };
    if (action === 'boardRead') return { version: 1, synthetic: false, threadId: payload.threadId, unread: 0 };
    return { version: 1, synthetic: false, threadId: payload.threadId, archived: payload.archived, unread: 0 }; };
  const client = createConversationClient({ transport });
  assert.equal((await client.boardInbox()).threads[0].label, '#15 · Fix login');
  await client.boardInbox(true);
  assert.deepEqual(await client.boardRead(T1), { threadId: T1, unread: 0 });
  assert.deepEqual(await client.boardArchive(T1, true), { threadId: T1, archived: true, unread: 0 });
  assert.deepEqual(sent.map(([action, payload]) => [action, payload]), [['boardInbox', {}], ['boardInbox', { archived: true }],
    ['boardRead', { threadId: T1 }], ['boardArchive', { threadId: T1, archived: true }]]);
  await assert.rejects(client.boardRead('bad id!'), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(client.boardArchive(T1, 'yes'), error => error.code === 'INVALID_REQUEST');
  const bad = [{ version: 1, synthetic: false, threads: [topic({ unread: -1 })], unread: 0, any: true },
    { version: 1, synthetic: false, threads: [topic({ extra: 1 })], unread: 0, any: true },
    { version: 1, synthetic: false, threads: [topic(), topic()], unread: 0, any: true },
    { version: 1, synthetic: false, threads: [], unread: 0 }];
  for (const value of bad) assert.throws(() => parseBoardInbox(value), error => error.code === 'INVALID_RESPONSE');
  const wrong = createConversationClient({ transport: async () => ({ version: 1, synthetic: false, threadId: T2, unread: 0 }) });
  await assert.rejects(wrong.boardRead(T1), error => error.code === 'INVALID_RESPONSE', 'An answer for another thread is refused');
});
