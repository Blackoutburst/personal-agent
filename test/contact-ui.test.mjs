import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createContactUI, renderPeerCard } from '../public/contact-ui.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, run) { this.listeners[type] = run; }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}
const document = { createElement: tag => new Element(tag) };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ID = '1e80ef85-15aa-4afb-99cf-e415fa3e4971';
const contact = (patch = {}) => ({ id: ID, name: 'Pip', ownerLabel: 'Screamer', enabled: false, peerEnabled: false, revision: 0, ...patch });
const response = (patch = {}) => ({ contacts: [contact(patch)] });
function fixture(api) {
  const ids = Object.fromEntries(['contacts-list', 'contacts-actions', 'contacts-note'].map(id => [id, new Element('div')])); let denied = 0;
  const ui = createContactUI({ document: { ...document, getElementById: id => ids[id] }, api, onDenied: () => denied++ });
  const all = () => { const result = []; const visit = node => { result.push(node); node.children.forEach(visit); }; Object.values(ids).forEach(visit); return result; };
  const input = () => all().find(node => node.tag === 'input');
  const toggle = enabled => { input().checked = enabled; return input().listeners.change(); };
  return { ui, ids, all, input, toggle, denied: () => denied };
}

test('contacts start off, explain both opt-ins, and render labels as text without a send action', async () => {
  const calls = [], f = fixture(async body => { calls.push(body); return response({ name: '<img onerror=bad()>' }); });
  await f.ui.load(); assert.deepEqual(calls, [{ action: 'contacts' }]); assert.equal(f.input().checked, false);
  assert.ok(f.ids['contacts-list'].textContent.includes('<img onerror=bad()>'));
  assert.ok(f.ids['contacts-list'].textContent.includes('Other side: off'));
  assert.ok(f.ids['contacts-list'].textContent.includes('unless both sides allow'));
  assert.equal(f.all().some(node => ['img', 'a', 'textarea'].includes(node.tag)), false);
  assert.deepEqual(f.all().filter(node => node.tag === 'button').map(node => node.textContent), ['Reload contacts']);
});

test('pending opt-in is nonoptimistic and disabled; acknowledged state supplies the next CAS', async () => {
  const pending = deferred(), calls = []; let changes = 0;
  const f = fixture(async body => { calls.push(body); if (body.action === 'contacts') return response({ peerEnabled: true });
    return ++changes === 1 ? pending.promise : response({ enabled: false, peerEnabled: true, revision: 2 }); });
  await f.ui.load(); const saving = f.toggle(true);
  assert.equal(f.input().checked, false); assert.equal(f.input().disabled, true);
  assert.deepEqual(calls[1], { action: 'setContact', id: ID, enabled: true, expectedRevision: 0 });
  pending.resolve(response({ enabled: true, peerEnabled: true, revision: 1 })); await saving;
  assert.equal(f.input().checked, true); assert.equal(f.input().disabled, false); assert.ok(f.ids['contacts-list'].textContent.includes('Both sides allow'));
  await f.toggle(false); assert.equal(calls.at(-1).expectedRevision, 1); assert.equal(f.input().checked, false);
});

test('conflict reloads canonical settings once, never retries a write and next explicit toggle uses fresh CAS', async () => {
  const calls = []; let reads = 0, writes = 0;
  const f = fixture(async body => { calls.push(body); if (body.action === 'contacts') return response({ revision: ++reads === 1 ? 0 : 7, peerEnabled: true });
    if (++writes === 1) throw Object.assign(new Error('CONTACT_CONFLICT'), { status: 409 });
    return response({ enabled: true, revision: 8, peerEnabled: true }); });
  await f.ui.load(); await f.toggle(true);
  assert.equal(f.input().checked, false); assert.equal(writes, 1); assert.equal(reads, 2);
  assert.ok(f.ids['contacts-note'].textContent.includes('Review the latest'));
  await f.toggle(true); assert.equal(writes, 2); assert.equal(calls.at(-1).expectedRevision, 7);
});

test('lost acknowledgement keeps confirmed state and requires a new read rather than automatic retry', async () => {
  const calls = []; let committed = false;
  const f = fixture(async body => { calls.push(body); if (body.action === 'contacts') return response({ enabled: committed, revision: committed ? 1 : 0 });
    committed = true; throw new Error('PRIVATE TRANSPORT DETAIL'); });
  await f.ui.load(); await f.toggle(true);
  assert.equal(f.input().checked, false); assert.equal(calls.filter(body => body.action === 'setContact').length, 1);
  assert.ok(!f.ids['contacts-note'].textContent.includes('PRIVATE')); assert.ok(f.ids['contacts-note'].textContent.includes('could not be confirmed'));
  await f.ui.load(); assert.equal(f.input().checked, true); assert.equal(calls.filter(body => body.action === 'setContact').length, 1);
});

test('newest loads win, owner reset fences pending reads/writes and stale detached toggles cannot act for another owner', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture(async () => ++count === 1 ? first.promise : second.promise);
  const a = f.ui.load(), b = f.ui.load(); second.resolve(response({ name: 'Newest' })); await b;
  first.resolve(response({ name: 'Stale' })); await a; assert.ok(f.ids['contacts-list'].textContent.includes('Newest')); assert.ok(!f.ids['contacts-list'].textContent.includes('Stale'));
  for (const write of [true, false]) {
    const pending = deferred(), calls = []; let initial = true;
    const owner = fixture(async body => { calls.push(body); if (initial) { initial = false; return response(); } return pending.promise; });
    await owner.ui.load(); const detached = owner.input();
    const operation = write ? owner.toggle(true) : owner.ui.load(); owner.ui.clear();
    detached.checked = true; await detached.listeners.change(); assert.equal(calls.length, 2);
    pending.resolve(response({ enabled: true, revision: 1, name: 'OLD OWNER' })); await operation;
    assert.equal(owner.ids['contacts-list'].textContent, ''); assert.equal(owner.ids['contacts-actions'].textContent, '');
  }
});

test('auth denial clears contacts and settings without admitting a late old-owner reply', async () => {
  for (const status of [401, 403]) {
    let first = true;
    const f = fixture(async () => { if (first) { first = false; return response(); } throw Object.assign(new Error('AUTHENTICATION_REQUIRED'), { status }); });
    await f.ui.load(); await f.toggle(true);
    assert.equal(f.denied(), 1); assert.equal(f.ids['contacts-list'].textContent, ''); assert.equal(f.ids['contacts-note'].textContent, '');
  }
});

test('missing contact or an acknowledgement without the changed row never reports a saved setting', async () => {
  for (const missing of [true, false]) {
    const calls = [], f = fixture(async body => {
      calls.push(body); if (body.action === 'contacts') return response();
      if (missing) throw Object.assign(new Error('CONTACT_NOT_FOUND'), { status: 404 });
      return { contacts: [] };
    });
    await f.ui.load(); await f.toggle(true);
    assert.equal(f.input(), undefined); assert.ok(!f.ids['contacts-note'].textContent.includes('saved'));
    assert.equal(calls.filter(body => body.action === 'setContact').length, 1);
  }
});

test('a same-contact desired-value acknowledgement cannot roll the reviewed revision backwards', async () => {
  const calls = [], f = fixture(async body => {
    calls.push(body);
    return body.action === 'contacts' ? response({ revision: 9 }) : response({ enabled: true, revision: 8 });
  });
  await f.ui.load(); await f.toggle(true);
  assert.deepEqual(calls[1], { action: 'setContact', id: ID, enabled: true, expectedRevision: 9 });
  assert.equal(f.input(), undefined);
  assert.ok(f.ids['contacts-note'].textContent.includes('could not be confirmed'));
  assert.ok(!f.ids['contacts-note'].textContent.includes('saved'));
  assert.equal(calls.filter(body => body.action === 'setContact').length, 1);
});

test('foreign fields, duplicate contacts, invalid labels/revisions and unbounded lists fail closed', async () => {
  const bad = [response({ id: ID + '\n' }), response({ id: 'bad' }), response({ name: ' ' }), response({ ownerLabel: ' padded' }),
    response({ name: 'x'.repeat(81) }), response({ name: '\ud800' }), response({ name: 'bad\nlabel' }), response({ enabled: 1 }),
    response({ peerEnabled: null }), response({ revision: -1 }), response({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    { contacts: [contact(), contact()] }, { contacts: Array.from({ length: 33 }, () => contact({ id: randomUUID() })) },
    { contacts: [], owner: 'foreign' }, response({ ownerId: 'foreign' })];
  let accessed = 0; const getter = Object.defineProperty(contact(), 'name', { enumerable: true, get() { accessed++; return 'unsafe'; } }); bad.push({ contacts: [getter] });
  for (const value of bad) {
    const f = fixture(async () => value); await f.ui.load(); assert.equal(f.input(), undefined); assert.ok(f.ids['contacts-note'].textContent.includes('could not be loaded'));
  }
  assert.equal(accessed, 0);
});

test('peer cards keep exact body as safe plain text with sender/recipient attribution and accessible timestamp', () => {
  const text = 'Exact <img onerror=bad()>\nhttps://private.invalid/path\n<script>do not run</script>';
  for (const direction of ['sent', 'received']) {
    const card = renderPeerCard(document, { text, peer: { direction, companionId: ID, name: '<Pip>', ownerLabel: 'Screamer', sentAtISO: '2026-11-03T04:13:00.000Z' } });
    assert.ok(card.textContent.includes(text)); assert.ok(card.textContent.includes(direction === 'sent' ? 'Sent to <Pip>' : 'From <Pip> (Screamer’s companion)'));
    assert.equal(card.children.some(child => ['a', 'img', 'script', 'button'].includes(child.tag)), false);
    const time = card.children.find(child => child.tag === 'time'); assert.equal(time.dateTime, '2026-11-03T04:13:00.000Z'); assert.ok(time.ariaLabel.includes(time.dateTime));
  }
});
