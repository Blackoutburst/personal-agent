import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUnreadMark, markTitle, dotGeometry, TITLE_MARK } from '../public/unread-mark.mjs';

const ICON = 'icons/icon-192.png', DOT = 'data:image/png;base64,DOT';

function page({ draw } = {}) {
  const listeners = new Map(), on = (name, run) => listeners.set(name, [...(listeners.get(name) ?? []), run]);
  const attributes = { href: ICON };
  const link = { getAttribute: name => attributes[name] ?? null, setAttribute: (name, value) => { attributes[name] = value; } };
  const p = { onScreen: new Set(), draws: 0, badges: [], attributes };
  p.doc = { title: 'Mika', querySelector: selector => selector === 'link[rel="icon"]' ? link : null, addEventListener: on };
  p.win = { addEventListener: on };
  p.nav = { setAppBadge: async () => { p.badges.push('set'); }, clearAppBadge: async () => { p.badges.push('clear'); } };
  p.fire = name => { for (const run of listeners.get(name) ?? []) run({}); };
  p.mark = createUnreadMark({ doc: p.doc, win: p.win, nav: p.nav, baseTitle: () => 'Mika',
    seeing: (source, detail) => p.onScreen.has(source + ':' + detail),
    draw: draw ?? (async href => { p.draws++; assert.equal(href, ICON); return DOT; }) });
  p.flush = () => new Promise(resolve => setImmediate(resolve));
  p.listeners = listeners;
  return p;
}

test('unread mark: the title gets one "(•) " prefix and loses it again', () => {
  assert.equal(markTitle('Mika', true), TITLE_MARK + 'Mika');
  assert.equal(markTitle(TITLE_MARK + 'Mika', true), TITLE_MARK + 'Mika');
  assert.equal(markTitle(TITLE_MARK + 'Mika', false), 'Mika');
  assert.equal(markTitle('Mika', false), 'Mika');
  const { x, y, radius } = dotGeometry(64);
  assert.ok(x + radius <= 64 && y - radius >= 0 && radius >= 10, 'The dot fits in the top right corner');
});

test('unread mark: a message for a conversation not being looked at dots the favicon; looking at it clears it', async () => {
  const p = page();
  p.mark.arrived({ source: 'chat', detail: 'thread-1', hidden: true });
  await p.flush();
  assert.equal(p.attributes.href, DOT, 'Red dot on the favicon');
  assert.equal(p.doc.title, TITLE_MARK + 'Mika');
  assert.deepEqual(p.badges, ['set'], 'The installed app badge too, where supported');
  p.mark.arrived({ source: 'group', detail: 'group-1' });
  await p.flush();
  assert.equal(p.draws, 1, 'Drawn once, reused');
  assert.deepEqual(p.badges, ['set']);
  // Back to the tab on the chat: the chat mark clears, the group one stays.
  p.onScreen.add('chat:thread-1'); p.fire('visibilitychange'); await p.flush();
  assert.equal(p.mark.count, 1);
  assert.equal(p.attributes.href, DOT);
  p.onScreen.add('group:group-1'); p.mark.check(); await p.flush();
  assert.equal(p.mark.marked, false);
  assert.equal(p.attributes.href, ICON, 'The original icon is back');
  assert.equal(p.doc.title, 'Mika');
  assert.deepEqual(p.badges, ['set', 'clear']);
  // A message in the conversation on screen in a visible, focused tab is seen already.
  p.mark.arrived({ source: 'chat', detail: 'thread-1' });
  await p.flush();
  assert.equal(p.mark.marked, false);
  assert.equal(p.attributes.href, ICON);
  assert.equal(p.mark.title('Mika'), 'Mika');
});

test('unread mark: focus clears, sign-out clears, and a mark cleared while drawing never shows the dot', async () => {
  let release;
  const p = page({ draw: () => new Promise(resolve => { release = resolve; }) });
  p.mark.arrived({ source: 'chat', detail: 't' });
  await p.flush();
  p.onScreen.add('chat:t'); p.fire('focus');
  release(DOT); await p.flush(); await p.flush();
  assert.equal(p.attributes.href, ICON);
  assert.equal(p.doc.title, 'Mika');
  p.onScreen.clear();
  p.mark.arrived({ source: 'chat', detail: 't' }); await p.flush();
  assert.equal(p.attributes.href, DOT);
  p.mark.clear(); await p.flush();
  assert.equal(p.attributes.href, ICON);
  assert.equal(p.mark.marked, false);
});

test('unread mark: no drawing possible still marks the title; no timers or animation in the module', async () => {
  const p = page({ draw: async () => null });
  p.mark.arrived({ source: 'chat', detail: 't' }); await p.flush();
  assert.equal(p.attributes.href, ICON);
  assert.equal(p.doc.title, TITLE_MARK + 'Mika');
  const source = readFileSync(new URL('../public/unread-mark.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setTimeout|setInterval|requestAnimationFrame|animate\(/);
  assert.deepEqual([...p.listeners.keys()].sort(), ['focus', 'visibilitychange'], 'Only event listeners');
});

test('the app wires the mark to the arrival hook and checks it on view changes', () => {
  const app = readFileSync(new URL('../public/companion-app.mjs', import.meta.url), 'utf8');
  assert.match(app, /onDataArrived\(event => unreadMark\.arrived\(event\)\)/);
  assert.match(app, /activeClient\.update\(\); unreadMark\.check\(\);\n  renderAll\(\);/, 'show() rechecks');
  assert.match(app, /unreadMark\.title\(/, 'renderAll keeps the mark in the title');
});
