import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemindersUI } from '../public/reminders-ui.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.text = '';
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('Reminder UI must use text nodes.'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  async emit(type) {
    const event = { type, prevented: false, preventDefault() { this.prevented = true; } };
    await Promise.all((this.listeners.get(type) ?? []).map(callback => callback(event)));
    return event;
  }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const item = (id = 'one', text = 'A saved reminder') => ({ id, text, dueAt: '2026-11-03T12:00:00.000Z', state: 'active', canCancel: true });
const data = (extra = {}) => ({ timezone: 'UTC', settings: { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00' },
  items: [item()], ...extra });
function fixture() {
  const nodes = new Map(['upcoming', 'schedule-list', 'upcoming-count', 'schedule-note', 'schedule-checkins',
    'schedule-quiet-start', 'schedule-quiet-end', 'schedule-zone', 'schedule-save', 'schedule-settings', 'announce']
    .map(id => [id, new Element()]));
  nodes.get('schedule-save').disabled = true;
  const requests = [], created = [], document = { getElementById: id => nodes.get(id), createElement(tag) {
    const node = new Element(tag); created.push(node); return node;
  } };
  const ui = createRemindersUI({ document, fetchImpl(url, options) {
    const pending = deferred(), request = { url, options, body: JSON.parse(options.body), pending,
      reply(value = data(), status = 200) { pending.resolve({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(value) }); } };
    requests.push(request); return pending.promise;
  } });
  return { ui, requests, created, $: id => nodes.get(id) };
}
async function open(f, value = data()) {
  f.$('upcoming').open = true;
  const loading = f.$('upcoming').emit('toggle'); f.requests.at(-1).reply(value); await loading;
}
async function edit(f, id, value) {
  if (id === 'schedule-checkins') f.$(id).checked = value;
  else f.$(id).value = value;
  await f.$(id).emit('input');
}
function assertCleared(f) {
  assert.equal(f.$('schedule-list').children.length, 0); assert.equal(f.$('upcoming-count').textContent, '');
  assert.equal(f.$('schedule-checkins').checked, false); assert.equal(f.$('schedule-quiet-start').value, '');
  assert.equal(f.$('schedule-quiet-end').value, ''); assert.equal(f.$('schedule-zone').textContent, '');
  assert.equal(f.$('schedule-save').disabled, true); assert.equal(f.$('schedule-settings').hidden, true);
  assert.equal(f.$('upcoming').open, false); assert.match(f.$('schedule-note').textContent, /Sign in/);
}

test('mount and idle refresh do not mutate the default check-in opt-in', async () => {
  const f = fixture(); await f.ui.refreshIfOpen(); assert.equal(f.requests.length, 0);
  await open(f);
  assert.deepEqual(f.requests.map(request => request.body), [{ action: 'list' }]);
  assert.equal(f.$('schedule-checkins').checked, false);
  assert.equal(f.$('schedule-quiet-start').value, '22:00');
  assert.equal(f.$('schedule-settings').hidden, false);
  assert.equal(f.requests[0].url, 'api/schedules');
  assert.equal(f.requests[0].options.method, 'POST');
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.requests[0].options.cache, 'no-store');
});

test('unsaved quiet hours and check-in edits survive normal polling while the list updates', async () => {
  const f = fixture(); await open(f);
  await edit(f, 'schedule-quiet-start', '23:15'); await edit(f, 'schedule-quiet-end', '09:30');
  await edit(f, 'schedule-checkins', true);
  const polling = f.ui.refreshIfOpen(); f.requests.at(-1).reply(data({ items: [item('two', 'Updated reminder')] })); await polling;
  assert.equal(f.$('schedule-quiet-start').value, '23:15'); assert.equal(f.$('schedule-quiet-end').value, '09:30');
  assert.equal(f.$('schedule-checkins').checked, true);
  assert.match(f.$('schedule-list').textContent, /Updated reminder/);
  assert.deepEqual(f.requests.map(request => request.body.action), ['list', 'list']);
});

test('edits made during Save survive its response and later polls; a later confirmed save clears dirty state', async () => {
  const f = fixture(); await open(f);
  await edit(f, 'schedule-checkins', true); await edit(f, 'schedule-quiet-start', '21:00');
  const saving = f.$('schedule-settings').emit('submit'), request = f.requests.at(-1);
  assert.deepEqual(request.body, { action: 'configure', input: { heartbeatEnabled: true, quietStart: '21:00', quietEnd: '08:00' } });
  assert.equal(f.$('schedule-save').disabled, true);
  await edit(f, 'schedule-quiet-start', '19:00');
  await f.ui.refreshIfOpen(); await f.$('upcoming').emit('toggle'); assert.equal(f.requests.length, 2);
  request.reply(data({ settings: { heartbeatEnabled: true, quietStart: '21:00', quietEnd: '08:00' } })); await saving;
  assert.equal(f.$('schedule-quiet-start').value, '19:00'); assert.equal(f.$('schedule-save').disabled, false);
  const polling = f.ui.refresh(); f.requests.at(-1).reply(); await polling;
  assert.equal(f.$('schedule-quiet-start').value, '19:00'); assert.equal(f.$('schedule-checkins').checked, true);
  const confirm = f.$('schedule-settings').emit('submit');
  f.requests.at(-1).reply(data({ settings: { heartbeatEnabled: true, quietStart: '19:00', quietEnd: '08:00' } })); await confirm;
  const fresh = f.ui.refresh(); f.requests.at(-1).reply(data({ settings: { heartbeatEnabled: false, quietStart: '20:00', quietEnd: '07:00' } })); await fresh;
  assert.equal(f.$('schedule-quiet-start').value, '20:00'); assert.equal(f.$('schedule-checkins').checked, false);
});

test('cancel sends the selected reminder ID and untrusted reminder text stays text', async () => {
  const f = fixture(), malicious = '<img src=x onerror="privateCode()">';
  await open(f, data({ items: [item('one', malicious), item('two', 'Second reminder')] }));
  const rows = f.$('schedule-list').children;
  assert.equal(rows[0].children[0].children[0].textContent, malicious);
  assert.equal(f.created.some(node => node.tagName === 'img'), false);
  assert.equal(rows[0].children[1].attributes.get('aria-label'), `Cancel reminder: ${malicious}`);
  const cancelling = rows[1].children[1].emit('click');
  assert.deepEqual(f.requests.at(-1).body, { action: 'cancel', input: { id: 'two' } });
  f.requests.at(-1).reply(data({ items: [item('one', malicious)] })); await cancelling;
  assert.equal(f.$('schedule-list').children.length, 1);
  assert.equal(f.$('announce').textContent, 'Reminder cancelled.');
});

for (const status of [401, 403]) {
  test(`a mutation ${status} clears private DOM and prevents an older pending 200 from restoring it`, async () => {
    const f = fixture(); await open(f, data({ items: [item('private', 'PRIVATE-REMINDER-CANARY')] }));
    const pendingList = f.ui.refresh(), older = f.requests.at(-1);
    const mutation = f.$('schedule-list').children[0].children[1].emit('click');
    f.requests.at(-1).reply({ error: { code: 'AUTHENTICATION_REQUIRED' } }, status); await mutation;
    assertCleared(f);
    older.reply(data({ items: [item('private', 'PRIVATE-REMINDER-CANARY')] })); await pendingList;
    assertCleared(f); assert.ok(!f.$('schedule-list').textContent.includes('CANARY'));
  });
}

test('client clear fences late replies and a superseded mutation cannot unlock a newer save', async () => {
  const f = fixture(); await open(f, data({ items: [item('owner-a', 'PRIVATE-OWNER-A')] }));
  await edit(f, 'schedule-checkins', true);
  const oldMutation = f.$('schedule-settings').emit('submit'), old = f.requests.at(-1);
  f.ui.clear(); assertCleared(f);
  await open(f, data({ items: [item('owner-b', 'Owner B reminder')] }));
  await edit(f, 'schedule-quiet-start', '21:00');
  const currentMutation = f.$('schedule-settings').emit('submit'), current = f.requests.at(-1);
  old.reply(data({ items: [item('owner-a', 'PRIVATE-OWNER-A')] })); await oldMutation;
  assert.equal(f.$('schedule-save').disabled, true);
  assert.ok(!f.$('schedule-list').textContent.includes('PRIVATE-OWNER-A'));
  const count = f.requests.length; await f.ui.refreshIfOpen(); assert.equal(f.requests.length, count);
  current.reply(data({ items: [item('owner-b', 'Owner B reminder')], settings: { heartbeatEnabled: false, quietStart: '21:00', quietEnd: '08:00' } }));
  await currentMutation; assert.equal(f.$('schedule-save').disabled, false);
  assert.match(f.$('schedule-list').textContent, /Owner B reminder/);
});

test('an uncertain mutation note survives finally and later polls until an explicit reopen', async () => {
  const f = fixture(); await open(f);
  await edit(f, 'schedule-quiet-start', '20:00');
  const saving = f.$('schedule-settings').emit('submit'); f.requests.at(-1).pending.reject(new Error('PRIVATE-CANARY')); await saving;
  const note = f.$('schedule-note').textContent;
  assert.match(note, /couldn’t confirm/); assert.ok(!note.includes('PRIVATE-CANARY'));
  assert.equal(f.$('schedule-save').disabled, false); assert.equal(f.$('schedule-quiet-start').value, '20:00');
  const polling = f.ui.refreshIfOpen(); f.requests.at(-1).reply(); await polling;
  assert.equal(f.$('schedule-note').textContent, note);
  f.$('upcoming').open = false; await f.$('upcoming').emit('toggle');
  await open(f); assert.notEqual(f.$('schedule-note').textContent, note);
});
