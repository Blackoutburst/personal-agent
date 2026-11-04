import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupUI, renderMarkdown, mentionQuery, GroupError } from '../public/group-ui.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; this.attributes = {}; this.hidden = false; this.value = ''; this.dataset = {}; this.className = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set innerHTML(value) { this._html = value; }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, run) { this.listeners[type] = run; }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() {}
}
const G = '1e80ef85-15aa-4afb-99cf-e415fa3e4971';
const members = [
  { id: 'owner:blackout', kind: 'owner', label: 'blackout', name: 'Blackout', photoVersion: null, you: true },
  { id: 'companion:blackout', kind: 'companion', label: 'blackout', owner: 'owner:blackout', name: 'C-chan', look: { character: 'claude', color: 'peach', outfit: 'base' }, yours: true },
  { id: 'owner:screamer', kind: 'owner', label: 'screamer', name: 'TheScreamer', photoVersion: 'abc' },
  { id: 'companion:screamer', kind: 'companion', label: 'screamer', owner: 'owner:screamer', name: 'Cirno', look: { character: 'astra', color: 'sky', outfit: 'base' } }];
const message = (seq, patch = {}) => ({ id: 'm' + seq, seq, groupId: G, author: { kind: 'owner', ownerLabel: 'screamer' }, authorId: 'owner:screamer', name: 'TheScreamer',
  text: 'hello ' + seq, mentions: [], createdAt: Date.UTC(2026, 10, 4, 12), ...patch });
const IDS = ['group-list', 'group-note', 'group-new', 'group-create', 'group-create-owners', 'group-create-name', 'group-create-save', 'group-create-cancel',
  'group-messages', 'group-members', 'group-title', 'group-typing', 'group-chat-note', 'group-replying', 'group-uploads', 'group-suggest', 'group-input',
  'group-send', 'group-composer', 'group-history', 'group-notify', 'group-menu', 'group-menu-button', 'group-rename', 'group-leave', 'group-attach',
  'group-file-picker', 'nav-group', 'nav-group-badge'];

function fixture(handler) {
  const ids = Object.fromEntries(IDS.map(id => [id, new Element(id)]));
  const calls = [], navigated = [];
  let denied = 0;
  const call = async body => { calls.push(body); return handler(body); };
  const ui = createGroupUI({ document: { createElement: tag => new Element(tag), getElementById: id => ids[id], createTextNode: text => text, visibilityState: 'visible' },
    call, renderCharacter: look => `<svg data-character="${look.character}"></svg>`, onDenied: () => denied++, now: () => Date.UTC(2026, 10, 4, 13),
    requestId: () => 'req-' + calls.length, navigate: hash => navigated.push(hash) });
  const all = () => { const out = []; const visit = node => { if (typeof node === 'string') return; out.push(node); node.children.forEach(visit); }; Object.values(ids).forEach(visit); return out; };
  return { ui, ids, calls, all, navigated, denied: () => denied };
}

test('the Group tab lists groups with unread badges and appears only on servers that have groups', async () => {
  const f = fixture(body => body.action === 'list' ? { groups: [{ id: G, name: '<b>Gang</b>', members, unread: 3, notify: 'all', lastSeq: 9, updatedAt: Date.UTC(2026, 10, 4, 12),
    preview: 'see you', previewName: 'Cirno' }], unread: 3, owners: [{ id: 'owner:blackout', label: 'blackout', name: 'Blackout', you: true },
    { id: 'owner:screamer', label: 'screamer', name: 'TheScreamer', companionName: 'Cirno' }] } : {});
  f.ids['nav-group'].hidden = true;
  await f.ui.refresh();
  assert.equal(f.ids['nav-group'].hidden, false);
  assert.equal(f.ids['nav-group-badge'].textContent, '3');
  const text = f.ids['group-list'].textContent;
  assert.ok(text.includes('<b>Gang</b>'), 'Names are text, never markup');
  assert.ok(text.includes('Cirno: see you'));
  assert.equal(f.ids['group-new'].hidden, false);
  // An older server without /api/groups: the tab stays hidden.
  const old = fixture(() => { throw new GroupError('NOT_FOUND', 404); });
  old.ids['nav-group'].hidden = true;
  await old.ui.refresh();
  assert.equal(old.ids['nav-group'].hidden, true);
});

test('a conversation shows names, avatars, replies, typing and marks itself read; sending posts with the reply', async () => {
  const f = fixture(body => {
    if (body.action === 'snapshot') return { group: { id: G, name: 'Gang', members, notify: 'mentions' }, messages: [message(1),
      message(2, { author: { kind: 'companion', ownerLabel: 'screamer' }, authorId: 'companion:screamer', name: 'Cirno', text: '**hey** @Blackout', mentions: ['owner:blackout'] }),
      message(3, { author: { kind: 'system' }, authorId: null, name: 'App', text: 'Blackout renamed the group.' })], cursor: '3', typing: ['companion:blackout', 'owner:screamer'], paused: false };
    if (body.action === 'read') return { groupId: G, unread: 0 };
    if (body.action === 'post') return { message: message(4, { author: { kind: 'owner', ownerLabel: 'blackout' }, authorId: 'owner:blackout', name: 'Blackout', text: body.text, replyTo: { id: 'm2', seq: 2, name: 'Cirno', preview: 'hey' } }), cursor: '4' };
    if (body.action === 'photo') return { member: body.member, photo: null };
    return {};
  });
  await f.ui.open(G);
  f.ui.close();
  assert.equal(f.ids['group-title'].textContent, 'Gang');
  assert.equal(f.ids['group-notify'].value, 'mentions');
  const rows = f.ids['group-messages'].children;
  assert.equal(rows.length, 3);
  assert.ok(rows[1].className.includes('companion'));
  assert.equal(rows[1].children[0]._html, '<svg data-character="astra"></svg>', 'A companion shows its own look');
  assert.ok(rows[1].textContent.includes('Cirno'));
  assert.equal(rows[2].className, 'group-system');
  assert.equal(f.ids['group-typing'].textContent, 'C-chan, TheScreamer are typing…');
  assert.deepEqual(f.calls.find(body => body.action === 'read'), { action: 'read', groupId: G, seq: 3 });
  // Reply to Cirno's message and send.
  const reply = f.all().find(node => node.className?.includes?.('group-reply') && node.attributes['aria-label'] === 'Reply to Cirno');
  reply.listeners.click();
  assert.equal(f.ids['group-replying'].hidden, false);
  f.ids['group-input'].value = 'yes @Cirno';
  await f.ui.send();
  assert.deepEqual(f.calls.find(body => body.action === 'post'), { action: 'post', groupId: G, requestId: f.calls.find(body => body.action === 'post').requestId, text: 'yes @Cirno', replyTo: 'm2' });
  assert.equal(f.ids['group-input'].value, '');
  assert.equal(f.ids['group-replying'].hidden, true);
  assert.equal(f.ids['group-messages'].children.length, 4);
});

test('access loss clears the group view', async () => {
  const f = fixture(() => { throw new GroupError('ACCESS_DENIED', 401); });
  await f.ui.refresh();
  assert.equal(f.denied(), 1);
  assert.equal(f.ids['nav-group'].hidden, true);
});

test('markdown renders as nodes with mentions, links and code, never HTML', () => {
  const document = { createElement: tag => new Element(tag), createTextNode: text => text };
  const blocks = renderMarkdown(document, 'hi **@Cirno** <img src=x>\n- one\n- [two](https://example.com)\n```\ncode <b>\n```', { mentionNames: ['Cirno'] });
  assert.deepEqual(blocks.map(block => block.tag), ['p', 'ul', 'pre']);
  assert.ok(blocks[0].textContent.includes('<img src=x>'));
  const strong = blocks[0].children.find(child => child.tag === 'strong');
  assert.equal(strong.children[0].className, 'group-mention');
  assert.equal(blocks[1].children[1].children[0].href, 'https://example.com/');
  assert.equal(blocks[2].textContent, 'code <b>');
});

test('mention suggestions follow the @ being typed', () => {
  assert.deepEqual(mentionQuery('hey @Ci', 7), { start: 4, query: 'Ci' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('mail me@x', 9), null);
  assert.equal(mentionQuery('hey @Cirno done', 15), null);
});
