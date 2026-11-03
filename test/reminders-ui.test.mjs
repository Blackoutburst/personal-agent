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
  insertBefore(child, before) { const index = this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); }
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
const routineData = (settings = {}, extra = {}) => data({ ...extra, settings: {
  heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00',
  dailyDigest: { enabled: false, localTime: '09:00' },
  weeklyCheckin: { enabled: false, localTime: '09:00', weekday: 1 }, ...settings
} });
const routineIds = ['schedule-daily', 'schedule-daily-enabled', 'schedule-daily-time', 'schedule-weekly',
  'schedule-weekly-enabled', 'schedule-weekly-time', 'schedule-weekly-day'];
function fixture({ routineNodes = true } = {}) {
  const nodes = new Map(['upcoming', 'schedule-list', 'upcoming-count', 'schedule-note', 'schedule-checkins',
    'schedule-quiet-start', 'schedule-quiet-end', 'schedule-zone', 'schedule-save', 'schedule-settings', 'announce',
    ...(routineNodes ? routineIds : [])]
    .map(id => [id, new Element()]));
  nodes.get('schedule-save').disabled = true;
  nodes.get('upcoming').append(nodes.get('schedule-list'), nodes.get('schedule-settings'));
  const requests = [], created = [], document = { getElementById: id => nodes.get(id), createElement(tag) {
    const node = new Element(tag); created.push(node); return node;
  } };
  let keys = 0;
  const ui = createRemindersUI({ document, requestId: () => 'watch-change-' + ++keys, fetchImpl(url, options) {
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
  if (id === 'schedule-checkins' || id.endsWith('-enabled')) f.$(id).checked = value;
  else f.$(id).value = value;
  await f.$(id).emit('input');
}
function assertCleared(f) {
  assert.equal(f.$('schedule-list').children.length, 0); assert.equal(f.$('upcoming-count').textContent, '');
  assert.equal(f.$('schedule-checkins').checked, false); assert.equal(f.$('schedule-quiet-start').value, '');
  assert.equal(f.$('schedule-quiet-end').value, ''); assert.equal(f.$('schedule-zone').textContent, '');
  assert.equal(f.$('schedule-save').disabled, true); assert.equal(f.$('schedule-settings').hidden, true);
  assert.equal(f.$('upcoming').open, false); assert.match(f.$('schedule-note').textContent, /Sign in/);
  for (const id of routineIds) {
    if (id === 'schedule-daily' || id === 'schedule-weekly') assert.equal(f.$(id).hidden, true);
    else {
      assert.equal(f.$(id).disabled, true);
      if (id.endsWith('-enabled')) assert.equal(f.$(id).checked, false); else assert.equal(f.$(id).value, '');
    }
  }
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
    const f = fixture(); await open(f, routineData({ dailyDigest: { enabled: true, localTime: '06:30' },
      weeklyCheckin: { enabled: true, localTime: '18:00', weekday: 4 } }, { items: [item('private', 'PRIVATE-REMINDER-CANARY')] }));
    const pendingList = f.ui.refresh(), older = f.requests.at(-1);
    const mutation = f.$('schedule-list').children[0].children[1].emit('click');
    f.requests.at(-1).reply({ error: { code: 'AUTHENTICATION_REQUIRED' } }, status); await mutation;
    assertCleared(f);
    older.reply(routineData({ dailyDigest: { enabled: true, localTime: '06:30' } }, { items: [item('private', 'PRIVATE-REMINDER-CANARY')] })); await pendingList;
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

test('routine capability shows disabled defaults without opting in or changing six-hour check-ins', async () => {
  const f = fixture(); await open(f, routineData());
  for (const prefix of ['daily', 'weekly']) {
    assert.equal(f.$(`schedule-${prefix}`).hidden, false);
    assert.equal(f.$(`schedule-${prefix}-enabled`).checked, false);
    assert.equal(f.$(`schedule-${prefix}-time`).value, '09:00');
    assert.equal(f.$(`schedule-${prefix}-time`).disabled, true);
  }
  assert.equal(f.$('schedule-weekly-day').value, '1'); assert.equal(f.$('schedule-weekly-day').disabled, true);
  assert.equal(f.$('schedule-checkins').checked, false);
  assert.deepEqual(f.requests.map(request => request.body), [{ action: 'list' }]);
});

test('enabling a routine patches only that member and an acknowledged edit later follows current server values', async () => {
  const f = fixture(); await open(f, routineData());
  await edit(f, 'schedule-daily-enabled', true);
  assert.equal(f.$('schedule-daily-time').disabled, false);
  const save = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input, { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00', dailyDigest: { enabled: true } });
  f.requests.at(-1).reply(routineData({ dailyDigest: { enabled: true, localTime: '09:00' } })); await save;
  const poll = f.ui.refresh(); f.requests.at(-1).reply(routineData({ dailyDigest: { enabled: true, localTime: '10:15' } })); await poll;
  assert.equal(f.$('schedule-daily-time').value, '10:15');
  assert.equal(f.$('schedule-weekly-enabled').checked, false);
});

test('a weekday draft survives polling while unedited routine members follow another device', async () => {
  const f = fixture(); await open(f, routineData({ weeklyCheckin: { enabled: true, localTime: '09:00', weekday: 1 } }));
  await edit(f, 'schedule-weekly-day', '5');
  const poll = f.ui.refresh(); f.requests.at(-1).reply(routineData({
    dailyDigest: { enabled: true, localTime: '08:45' }, weeklyCheckin: { enabled: true, localTime: '11:30', weekday: 2 }
  })); await poll;
  assert.equal(f.$('schedule-weekly-day').value, '5'); assert.equal(f.$('schedule-weekly-time').value, '11:30');
  assert.equal(f.$('schedule-daily-enabled').checked, true); assert.equal(f.$('schedule-daily-time').value, '08:45');
  const save = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input.weeklyCheckin, { weekday: 5 });
  assert.equal(Object.hasOwn(f.requests.at(-1).body.input, 'dailyDigest'), false);
  f.requests.at(-1).reply(routineData({ weeklyCheckin: { enabled: true, localTime: '11:30', weekday: 5 } })); await save;
});

test('a quiet-hours draft/save never overwrites unrelated routines changed by another device', async () => {
  const f = fixture(); await open(f, routineData()); await edit(f, 'schedule-quiet-start', '23:00');
  const poll = f.ui.refresh(); f.requests.at(-1).reply(routineData({
    dailyDigest: { enabled: true, localTime: '07:45' }, weeklyCheckin: { enabled: true, localTime: '15:00', weekday: 7 }
  })); await poll;
  assert.equal(f.$('schedule-quiet-start').value, '23:00'); assert.equal(f.$('schedule-weekly-day').value, '7');
  const save = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input, { heartbeatEnabled: false, quietStart: '23:00', quietEnd: '08:00' });
  f.requests.at(-1).reply(routineData({ quietStart: '23:00' })); await save;
});

test('routine edits during Save survive its ACK and polling; unchanged submitted members clear independently', async () => {
  const initial = { dailyDigest: { enabled: true, localTime: '09:00' }, weeklyCheckin: { enabled: true, localTime: '09:00', weekday: 1 } };
  const f = fixture(); await open(f, routineData(initial)); await edit(f, 'schedule-daily-time', '10:00');
  const save = f.$('schedule-settings').emit('submit'), request = f.requests.at(-1);
  await edit(f, 'schedule-weekly-day', '3');
  request.reply(routineData({ ...initial, dailyDigest: { enabled: true, localTime: '10:00' } })); await save;
  const poll = f.ui.refresh(); f.requests.at(-1).reply(routineData({ ...initial, dailyDigest: { enabled: true, localTime: '10:30' } })); await poll;
  assert.equal(f.$('schedule-daily-time').value, '10:30', 'An unchanged submitted field is no longer dirty');
  assert.equal(f.$('schedule-weekly-day').value, '3', 'A different field edited during Save is still a draft');
  const second = f.$('schedule-settings').emit('submit'), sent = f.requests.at(-1);
  assert.deepEqual(sent.body.input.weeklyCheckin, { weekday: 3 }); assert.equal(Object.hasOwn(sent.body.input, 'dailyDigest'), false);
  await edit(f, 'schedule-weekly-day', '4');
  sent.reply(routineData({ ...initial, weeklyCheckin: { enabled: true, localTime: '09:00', weekday: 3 } })); await second;
  assert.equal(f.$('schedule-weekly-day').value, '4', 'A newer edit of the same submitted member survives its ACK');
});

test('old-server rollback retires routine drafts even when legacy preferences remain dirty', async () => {
  const f = fixture(); await open(f, routineData());
  await edit(f, 'schedule-daily-enabled', true); await edit(f, 'schedule-daily-time', '07:30');
  await edit(f, 'schedule-quiet-start', '23:15');
  const poll = f.ui.refresh(); f.requests.at(-1).reply(data()); await poll;
  for (const prefix of ['daily', 'weekly']) {
    assert.equal(f.$(`schedule-${prefix}`).hidden, true); assert.equal(f.$(`schedule-${prefix}-enabled`).checked, false);
  }
  const save = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input, { heartbeatEnabled: false, quietStart: '23:15', quietEnd: '08:00' });
  f.requests.at(-1).reply(data()); await save;
  const upgraded = f.ui.refresh(); f.requests.at(-1).reply(routineData()); await upgraded;
  assert.equal(f.$('schedule-daily-enabled').checked, false); assert.equal(f.$('schedule-daily-time').value, '09:00');
});

test('absent or malformed routine groups are independently hidden and omitted from legacy saves', async () => {
  for (const invalid of [null, {}, { enabled: 'false', localTime: '09:00' }, { enabled: true, localTime: '25:00' }]) {
    const f = fixture(); await open(f, routineData({ dailyDigest: invalid }));
    assert.equal(f.$('schedule-daily').hidden, true); assert.equal(f.$('schedule-weekly').hidden, false);
    const save = f.$('schedule-settings').emit('submit');
    assert.equal(Object.hasOwn(f.requests.at(-1).body.input, 'dailyDigest'), false);
    assert.equal(Object.hasOwn(f.requests.at(-1).body.input, 'weeklyCheckin'), false);
    f.requests.at(-1).reply(data()); await save;
  }
  for (const weekday of [0, 8, '1', 1.5]) {
    const f = fixture(); await open(f, routineData({ weeklyCheckin: { enabled: true, localTime: '09:00', weekday } }));
    assert.equal(f.$('schedule-weekly').hidden, true); assert.equal(f.$('schedule-daily').hidden, false);
  }
});

test('owner clear fences a late routine ACK and cannot expose old drafts or unlock a new owner Save', async () => {
  const f = fixture(); await open(f, routineData()); await edit(f, 'schedule-daily-enabled', true);
  const oldSave = f.$('schedule-settings').emit('submit'), old = f.requests.at(-1); f.ui.clear(); assertCleared(f);
  await open(f, routineData()); await edit(f, 'schedule-weekly-enabled', true);
  const currentSave = f.$('schedule-settings').emit('submit'), current = f.requests.at(-1);
  old.reply(routineData({ dailyDigest: { enabled: true, localTime: '06:15' } })); await oldSave;
  assert.equal(f.$('schedule-daily-enabled').checked, false); assert.equal(f.$('schedule-save').disabled, true);
  current.reply(routineData({ weeklyCheckin: { enabled: true, localTime: '09:00', weekday: 1 } })); await currentSave;
  assert.equal(f.$('schedule-weekly-enabled').checked, true); assert.equal(f.$('schedule-save').disabled, false);
});

test('a cached old HTML page still sends only legacy preferences even with a capable response', async () => {
  const f = fixture({ routineNodes: false }); await open(f, routineData());
  const save = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input, { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00' });
  f.requests.at(-1).reply(data()); await save;
});

test('turning a routine off and on retains its saved time instead of sending a new default', async () => {
  const f = fixture(); await open(f, routineData({ dailyDigest: { enabled: true, localTime: '06:45' } }));
  await edit(f, 'schedule-daily-enabled', false);
  const off = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input.dailyDigest, { enabled: false });
  f.requests.at(-1).reply(routineData({ dailyDigest: { enabled: false, localTime: '06:45' } })); await off;
  assert.equal(f.$('schedule-daily-time').value, '06:45'); assert.equal(f.$('schedule-daily-time').disabled, true);
  await edit(f, 'schedule-daily-enabled', true);
  const on = f.$('schedule-settings').emit('submit');
  assert.deepEqual(f.requests.at(-1).body.input.dailyDigest, { enabled: true });
  f.requests.at(-1).reply(routineData({ dailyDigest: { enabled: true, localTime: '06:45' } })); await on;
  assert.equal(f.$('schedule-daily-time').value, '06:45');
});

test('an uncertain routine save retains its exact field draft without automatic mutation retries', async () => {
  const f = fixture(); await open(f, routineData({ dailyDigest: { enabled: true, localTime: '09:00' } }));
  await edit(f, 'schedule-daily-time', '11:20');
  const save = f.$('schedule-settings').emit('submit'); f.requests.at(-1).pending.reject(new Error('PRIVATE-FAILURE-CANARY')); await save;
  const poll = f.ui.refreshIfOpen(); f.requests.at(-1).reply(routineData({ dailyDigest: { enabled: true, localTime: '10:00' } })); await poll;
  assert.equal(f.$('schedule-daily-time').value, '11:20'); assert.match(f.$('schedule-note').textContent, /couldn’t confirm/);
  assert.equal(f.requests.filter(request => request.body.action === 'configure').length, 1);
  assert.ok(!f.$('schedule-note').textContent.includes('CANARY'));
});

const WATCH = '1e80ef85-15aa-4afb-99cf-e415fa3e4971', OTHER_WATCH = '4d317b44-1f1a-46f1-b515-822d93c8246c';
const watch = (extra = {}) => ({ id: WATCH, version: 1, kind: 'release_watch', condition: 'Qwen4 is officially released by Alibaba/Qwen', state: 'active',
  nextCheckAt: '2026-11-03T12:00:00.000Z', lastCheckAt: null, lastResult: null, urls: [], evidence: null, consecutiveStale: 0,
  deliveryPending: false, createdAt: '2026-11-03T06:00:00.000Z', ...extra });
const watches = (rows = [watch()]) => routineData({}, { releaseWatches: rows });
const walk = node => [node, ...node.children.flatMap(walk)];
const find = (f, predicate) => walk(f.$('upcoming')).filter(predicate);
const byClass = (f, name) => find(f, node => node.className?.split(' ').includes(name));
function watchButton(f, text, index = 0) { const value = find(f, node => node.tagName === 'button' && node.textContent === text)[index]; assert.ok(value, `Missing ${text}`); return value; }
const watchInput = f => find(f, node => node.tagName === 'textarea')[0];
async function draft(f, text) { const input = watchInput(f); assert.ok(input); input.value = text; await input.emit('input'); return input; }
const watchWrites = f => f.requests.filter(request => request.body.action === 'updateWatch');
async function replyConflict(f, promise, fresh) {
  f.requests.at(-1).reply({ error: { code: 'SCHEDULER_CONFLICT', message: 'PRIVATE-DIAGNOSTIC' } }, 409);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(f.requests.at(-1).body, { action: 'list' }); f.requests.at(-1).reply(fresh); await promise;
}

test('release watch inspection retains paused/complete history, exact evidence and safe source links without changing routine controls', async () => {
  const f = fixture(), malicious = '<img src=x onerror="bad()">', source = 'https://qwen.example/releases?q=Qwen4';
  await open(f, watches([watch({ state: 'paused', condition: malicious, lastCheckAt: '2026-11-03T07:00:00.000Z', lastResult: 'stale', consecutiveStale: 3, evidence: '<script>bad()</script>', urls: [source] }),
    watch({ id: OTHER_WATCH, state: 'complete', lastResult: 'found', lastCheckAt: '2026-11-03T08:00:00.000Z', evidence: 'Official model card published.', urls: [source] })]));
  assert.equal(byClass(f, 'watch-row').length, 2); await watchButton(f, 'Inspect watch').emit('click');
  const panel = byClass(f, 'release-watches')[0]; assert.ok(panel.textContent.includes(malicious)); assert.ok(panel.textContent.includes('Couldn’t check'));
  assert.ok(panel.textContent.includes('Consecutive checks unavailable: 3')); assert.ok(panel.textContent.includes('<script>bad()</script>'));
  const link = find(f, node => node.tagName === 'a')[0]; assert.equal(link.href, source); assert.equal(link.textContent, source);
  assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.target, '_blank'); assert.equal(link.referrerPolicy, 'no-referrer');
  assert.equal(f.created.some(node => node.tagName === 'img' || node.tagName === 'script'), false);
  assert.equal(f.$('schedule-daily-enabled').checked, false); assert.equal(f.$('schedule-checkins').checked, false); assert.equal(f.requests.length, 1);
  const pending = f.ui.refresh(); f.requests.at(-1).reply(watches([watch({ lastResult: 'found', deliveryPending: true, lastCheckAt: '2026-11-03T08:00:00.000Z', urls: [source] })])); await pending;
  assert.match(panel.textContent, /Found · waiting for delivery after quiet hours/);
});

test('pause/resume/cancel use fresh version and stable operation keys, stay nonoptimistic and require explicit cancel confirmation', async () => {
  const f = fixture(); await open(f, watches());
  const pause = watchButton(f, 'Pause watch').emit('click'); assert.equal(watchWrites(f).length, 1);
  assert.deepEqual(watchWrites(f)[0].body, { action: 'updateWatch', input: { requestId: 'watch-change-1', id: WATCH, expectedVersion: 1, operation: 'pause' } });
  assert.ok(byClass(f, 'watch-row')[0].textContent.includes('Active')); assert.equal(watchButton(f, 'Pause watch').disabled, true);
  f.requests.at(-1).reply(watches([watch({ version: 2, state: 'paused' })])); await pause;
  const resume = watchButton(f, 'Resume watch').emit('click'); assert.deepEqual(watchWrites(f)[1].body.input, { requestId: 'watch-change-2', id: WATCH, expectedVersion: 2, operation: 'resume' });
  f.requests.at(-1).reply(watches([watch({ version: 3 })])); await resume;
  await watchButton(f, 'Cancel watch').emit('click'); assert.equal(watchWrites(f).length, 2);
  assert.match(byClass(f, 'watch-confirmation')[0].textContent, /Qwen4 is officially released/);
  const cancel = watchButton(f, 'Confirm cancel watch').emit('click'); assert.deepEqual(watchWrites(f)[2].body.input, { requestId: 'watch-change-3', id: WATCH, expectedVersion: 3, operation: 'cancel' });
  f.requests.at(-1).reply(watches([watch({ version: 4, state: 'cancelled', nextCheckAt: null })])); await cancel;
  assert.equal(find(f, node => node.textContent === 'Edit condition').length, 0); assert.equal(byClass(f, 'watch-row').length, 1);
});

test('a deferred third-stale notice never presents an unavailable check as a found release', async () => {
  const f = fixture(); await open(f, watches([watch({ lastCheckAt: '2026-11-03T23:00:00.000Z', lastResult: 'stale', consecutiveStale: 3, deliveryPending: true })]));
  assert.match(byClass(f, 'watch-row')[0].textContent, /Check unavailable · notice waiting for delivery after quiet hours/);
  assert.ok(!byClass(f, 'watch-row')[0].textContent.includes('Found')); await watchButton(f, 'Inspect watch').emit('click');
  assert.match(byClass(f, 'watch-details')[0].textContent, /Couldn’t check/); assert.match(byClass(f, 'watch-details')[0].textContent, /Consecutive checks unavailable: 3/);
  assert.equal(find(f, node => node.tagName === 'a').length, 0); assert.equal(f.requests.length, 1);
});

test('condition draft retains its original CAS and DOM through polling; conflict never rebases or autosends, reviewed reopen uses current version', async () => {
  const f = fixture(); await open(f, watches()); await watchButton(f, 'Edit condition').emit('click');
  const editor = await draft(f, 'An explicit revised release condition');
  const poll = f.ui.refreshIfOpen(); f.requests.at(-1).reply(watches([watch({ version: 2, condition: 'Other device condition' })])); await poll;
  assert.equal(watchInput(f), editor); assert.equal(editor.value, 'An explicit revised release condition');
  const save = byClass(f, 'watch-editor')[0].emit('submit');
  assert.deepEqual(watchWrites(f)[0].body.input, { requestId: 'watch-change-1', id: WATCH, expectedVersion: 1, operation: 'edit', condition: 'An explicit revised release condition' });
  await replyConflict(f, save, watches([watch({ version: 3, condition: 'Current official condition' })]));
  assert.equal(watchInput(f).value, 'An explicit revised release condition'); assert.equal(watchButton(f, 'Save condition').disabled, true);
  const before = f.requests.length; await byClass(f, 'watch-editor')[0].emit('submit'); assert.equal(f.requests.length, before); assert.equal(watchWrites(f).length, 1);
  assert.ok(!byClass(f, 'release-watches')[0].textContent.includes('PRIVATE-DIAGNOSTIC'));
  await watchButton(f, 'Close condition editor').emit('click'); assert.equal(watchButton(f, 'Edit condition').disabled, true);
  const review = watchButton(f, 'Reload watches').emit('click'); f.requests.at(-1).reply(watches([watch({ version: 3, condition: 'Current official condition' })])); await review;
  await watchButton(f, 'Edit condition').emit('click'); assert.equal(watchInput(f).value, 'Current official condition');
  await draft(f, 'A newly reviewed condition'); const reviewed = byClass(f, 'watch-editor')[0].emit('submit'); assert.equal(watchWrites(f).at(-1).body.input.expectedVersion, 3);
  f.requests.at(-1).reply(watches([watch({ version: 4, condition: 'A newly reviewed condition' })])); await reviewed;
  assert.equal(watchInput(f), undefined); assert.match(byClass(f, 'release-watches')[0].textContent, /Watch saved/);
});

test('uncertain edit retains exact frozen retry body/key across polling and draft tampering; only explicit matched ACK clears it', async () => {
  const f = fixture(); await open(f, watches()); await watchButton(f, 'Edit condition').emit('click'); await draft(f, 'The exact requested condition');
  const save = byClass(f, 'watch-editor')[0].emit('submit'), original = f.requests.at(-1); original.pending.reject(new Error('PRIVATE-NETWORK')); await save;
  assert.match(byClass(f, 'release-watches')[0].textContent, /could not be confirmed/); assert.equal(watchInput(f).disabled, true);
  await draft(f, 'DOM tampering must not alter an uncertain request');
  const poll = f.ui.refreshIfOpen(); f.requests.at(-1).reply(watches([watch({ version: 2, condition: 'The exact requested condition' })])); await poll;
  assert.equal(watchWrites(f).length, 1); const retry = watchButton(f, 'Retry same watch change').emit('click');
  assert.equal(f.requests.at(-1).options.body, original.options.body); assert.deepEqual(f.requests.at(-1).body, original.body);
  f.requests.at(-1).reply(watches([watch({ version: 2, condition: 'The exact requested condition' })])); await retry;
  assert.equal(watchWrites(f).length, 2); assert.equal(watchInput(f), undefined); assert.equal(find(f, node => node.textContent === 'Retry same watch change').length, 0);
  assert.ok(!byClass(f, 'release-watches')[0].textContent.includes('PRIVATE-NETWORK'));
});

test('wrong or stale canonical mutation ACK never becomes a saved claim or a new logical request', async () => {
  for (const returned of [watch({ version: 0, state: 'paused' }), watch({ version: 1, state: 'paused' }), watch({ version: 2, state: 'active' })]) {
    const f = fixture(); await open(f, watches()); const pause = watchButton(f, 'Pause watch').emit('click'); f.requests.at(-1).reply(watches([returned])); await pause;
    assert.notEqual(f.$('announce').textContent, 'Watch saved.'); assert.equal(watchWrites(f).length, 1);
    assert.ok(find(f, node => node.textContent === 'Retry same watch change').length); assert.match(byClass(f, 'release-watches')[0].textContent, /could not be confirmed/);
  }
});

test('a non-edit conflict retires its retry key and cannot re-enable writes until explicit canonical review', async () => {
  const f = fixture(); await open(f, watches()); const pause = watchButton(f, 'Pause watch').emit('click');
  await replyConflict(f, pause, watches([watch({ version: 2 })]));
  assert.equal(watchButton(f, 'Pause watch').disabled, true); assert.equal(find(f, node => node.textContent === 'Retry same watch change').length, 0);
  const count = f.requests.length; await watchButton(f, 'Pause watch').emit('click'); assert.equal(f.requests.length, count);
  const poll = f.ui.refreshIfOpen(); f.requests.at(-1).reply(watches([watch({ version: 3 })])); await poll; assert.equal(watchButton(f, 'Pause watch').disabled, true);
  const review = watchButton(f, 'Reload watches').emit('click'); f.requests.at(-1).reply(watches([watch({ version: 3 })])); await review;
  const fresh = watchButton(f, 'Pause watch').emit('click'); assert.equal(watchWrites(f).length, 2); assert.equal(watchWrites(f)[1].body.input.expectedVersion, 3);
  assert.notEqual(watchWrites(f)[1].body.input.requestId, watchWrites(f)[0].body.input.requestId);
  f.requests.at(-1).reply(watches([watch({ version: 4, state: 'paused' })])); await fresh;
});

test('successful condition edit displays the reset canonical check generation and removes old pending evidence', async () => {
  const f = fixture(); await open(f, watches([watch({ lastCheckAt: '2026-11-03T09:00:00.000Z', lastResult: 'found', deliveryPending: true,
    evidence: 'OLD-GENERATION-EVIDENCE', urls: ['https://qwen.example/old-evidence'] })]));
  await watchButton(f, 'Inspect watch').emit('click'); assert.equal(find(f, node => node.tagName === 'a').length, 1);
  await watchButton(f, 'Edit condition').emit('click'); await draft(f, 'New official release condition'); const save = byClass(f, 'watch-editor')[0].emit('submit');
  f.requests.at(-1).reply(watches([watch({ version: 2, condition: 'New official release condition' })])); await save;
  assert.equal(find(f, node => node.tagName === 'a').length, 0); assert.ok(!byClass(f, 'release-watches')[0].textContent.includes('OLD-GENERATION-EVIDENCE'));
  assert.match(byClass(f, 'release-watches')[0].textContent, /Not checked yet/); assert.ok(!byClass(f, 'release-watches')[0].textContent.includes('waiting for delivery'));
});

test('cancel confirmation keeps its original version and becomes inert after a newer check or edit', async () => {
  const f = fixture(); await open(f, watches()); await watchButton(f, 'Cancel watch').emit('click'); const oldConfirm = watchButton(f, 'Confirm cancel watch');
  const poll = f.ui.refreshIfOpen(); f.requests.at(-1).reply(watches([watch({ version: 2, condition: 'Updated by another device' })])); await poll;
  assert.equal(watchButton(f, 'Confirm cancel watch').disabled, true); const count = f.requests.length; await oldConfirm.emit('click'); await watchButton(f, 'Confirm cancel watch').emit('click'); assert.equal(f.requests.length, count);
  await watchButton(f, 'Keep watch').emit('click'); await watchButton(f, 'Cancel watch').emit('click'); const cancel = watchButton(f, 'Confirm cancel watch').emit('click');
  assert.equal(watchWrites(f).at(-1).body.input.expectedVersion, 2); f.requests.at(-1).reply(watches([watch({ version: 3, condition: 'Updated by another device', state: 'cancelled' })])); await cancel;
});

test('external cancel closes watch authority while preserving a pinned draft; detached same-owner controls cannot mutate newer state', async () => {
  const f = fixture(); await open(f, watches()); const stalePause = watchButton(f, 'Pause watch'); await watchButton(f, 'Edit condition').emit('click');
  await draft(f, 'Keep this draft'); const poll = f.ui.refresh(); f.requests.at(-1).reply(watches([watch({ version: 2, state: 'cancelled' })])); await poll;
  assert.equal(watchInput(f).value, 'Keep this draft'); assert.equal(watchButton(f, 'Save condition').disabled, true);
  const count = f.requests.length; await stalePause.emit('click'); await byClass(f, 'watch-editor')[0].emit('submit'); assert.equal(f.requests.length, count);
});

for (const status of [401, 403]) test(`old-owner ${status} and stale handlers cannot clear/unlock a newer owner mutation`, async () => {
  const f = fixture(); await open(f, watches([watch({ condition: 'PRIVATE-OWNER-A' })])); const stalePause = watchButton(f, 'Pause watch');
  const oldLoad = f.ui.refresh(), old = f.requests.at(-1); f.ui.clear(); await open(f, watches([watch({ id: OTHER_WATCH, condition: 'Owner B watch' })]));
  const mutation = watchButton(f, 'Pause watch').emit('click'), current = f.requests.at(-1);
  old.reply({ error: { code: 'AUTHENTICATION_REQUIRED' } }, status); await oldLoad;
  assert.equal(watchButton(f, 'Pause watch').disabled, true); assert.ok(byClass(f, 'release-watches')[0].textContent.includes('Owner B watch'));
  assert.ok(!byClass(f, 'release-watches')[0].textContent.includes('PRIVATE-OWNER-A')); const count = f.requests.length; await stalePause.emit('click'); assert.equal(f.requests.length, count);
  current.reply(watches([watch({ id: OTHER_WATCH, version: 2, condition: 'Owner B watch', state: 'paused' })])); await mutation; assert.ok(watchButton(f, 'Resume watch'));
});

test('a superseded same-owner request is fenced before auth clearing while the current mutation remains busy', async () => {
  const f = fixture(); await open(f, watches()); const oldLoad = f.ui.refresh(), old = f.requests.at(-1);
  const mutation = watchButton(f, 'Pause watch').emit('click'), current = f.requests.at(-1);
  old.reply({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401); await oldLoad;
  assert.equal(byClass(f, 'release-watches')[0].hidden, false); assert.equal(watchButton(f, 'Pause watch').disabled, true);
  current.reply(watches([watch({ version: 2, state: 'paused' })])); await mutation; assert.ok(watchButton(f, 'Resume watch'));
});

test('current auth denial clears every private watch draft/retry and late success cannot restore them', async () => {
  const f = fixture(); await open(f, watches([watch({ condition: 'PRIVATE-CONDITION' })])); const oldLoad = f.ui.refresh(), old = f.requests.at(-1);
  await watchButton(f, 'Edit condition').emit('click'); const oldForm = byClass(f, 'watch-editor')[0]; await draft(f, 'PRIVATE-DRAFT');
  const mutation = oldForm.emit('submit'); f.requests.at(-1).reply({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401); await mutation;
  assertCleared(f); assert.equal(byClass(f, 'release-watches')[0].hidden, true); assert.equal(watchInput(f), undefined);
  old.reply(watches([watch({ condition: 'PRIVATE-CONDITION' })])); await oldLoad; const count = f.requests.length; await oldForm.emit('submit'); assert.equal(f.requests.length, count);
  assert.equal(byClass(f, 'watch-row').length, 0); assert.equal(find(f, node => node.textContent === 'Retry same watch change').length, 0);
});

test('absent rollback retires drafts and retries without changing legacy routine saves or allowing detached controls', async () => {
  const f = fixture(); await open(f, watches()); await watchButton(f, 'Edit condition').emit('click'); const oldForm = byClass(f, 'watch-editor')[0];
  await draft(f, 'A retiring draft'); const save = oldForm.emit('submit'); f.requests.at(-1).pending.reject(new Error('Lost ACK')); await save;
  const retry = watchButton(f, 'Retry same watch change'), poll = f.ui.refresh(); f.requests.at(-1).reply(routineData()); await poll;
  assert.equal(byClass(f, 'release-watches')[0].hidden, true); const count = f.requests.length; await retry.emit('click'); await oldForm.emit('submit'); assert.equal(f.requests.length, count);
  const legacy = f.$('schedule-settings').emit('submit'); assert.deepEqual(f.requests.at(-1).body, { action: 'configure', input: { heartbeatEnabled: false, quietStart: '22:00', quietEnd: '08:00' } });
  f.requests.at(-1).reply(routineData()); await legacy;
});

test('malformed/unsafe bounded watch DTOs never create active controls or fetch their evidence URLs', async () => {
  const bad = [null, Array(21).fill(watch()), [watch(), watch()], [watch({ extra: 'private' })], [watch({ id: WATCH + '\n' })],
    [watch({ version: Number.MAX_SAFE_INTEGER + 1 })], [watch({ condition: 'a'.repeat(1001) })], [watch({ condition: '\ud800' })],
    [watch({ evidence: 'two\nlines' })], [watch({ createdAt: 'not a date' })], [watch({ urls: ['javascript:bad()'] })],
    [watch({ urls: ['https://user:password@qwen.example/'] })], [watch({ urls: ['https://qwen.example/\ud800'] })],
    [watch({ urls: ['https://qwen.example/' + 'a'.repeat(2048)] })], [watch({ urls: Array(9).fill('https://qwen.example/') })]];
  for (const rows of bad) {
    const f = fixture(); await open(f, watches(rows)); assert.equal(byClass(f, 'watch-row').length, 0);
    assert.equal(find(f, node => node.textContent === 'Edit condition').length, 0); assert.equal(find(f, node => node.tagName === 'a').length, 0);
    assert.equal(f.requests.length, 1); assert.equal(f.$('schedule-settings').hidden, false); assert.equal(f.$('schedule-checkins').checked, false);
  }
});

test('topic watches show their interval, latest result with sources and digest history, and edit only what changed', async () => {
  const f = fixture(), source = 'https://news.example/nvda-q3', older = 'https://news.example/nvda-guidance';
  const topic = (extra = {}) => watch({ kind: 'topic_watch', condition: 'NVIDIA stock news', intervalHours: 24, lastCheckAt: '2026-11-03T08:00:00.000Z',
    lastResult: 'found', evidence: 'Q3 earnings beat estimates.', urls: [source],
    digests: [{ at: '2026-11-03T08:00:00.000Z', evidence: 'Q3 earnings beat estimates.', urls: [source] }, { at: '2026-11-02T08:00:00.000Z', evidence: 'Guidance raised.', urls: [older] }], ...extra });
  await open(f, watches([topic()]));
  const row = byClass(f, 'watch-row')[0];
  assert.match(row.textContent, /Topic · every 24 h/); assert.match(row.textContent, /Something new/);
  assert.equal(byClass(f, 'watch-result')[0].textContent.includes('Q3 earnings beat estimates.'), true, 'The latest result is visible without expanding');
  assert.deepEqual(find(f, node => node.tagName === 'a').map(link => link.href), [source]);
  await watchButton(f, 'Inspect watch').emit('click');
  assert.match(byClass(f, 'watch-details')[0].textContent, /Recent digests:.*Guidance raised\./s);
  assert.deepEqual(find(f, node => node.tagName === 'a').map(link => link.href), [source, source, older]);

  await watchButton(f, 'Edit watch').emit('click');
  const hours = find(f, node => node.tagName === 'input' && node.type === 'number')[0]; assert.equal(hours.value, '24');
  await byClass(f, 'watch-editor')[0].emit('submit'); assert.equal(watchWrites(f).length, 0, 'An unchanged watch is not sent');
  assert.match(byClass(f, 'release-watches')[0].textContent, /Nothing to save yet/);
  hours.value = '200'; await hours.emit('input'); await byClass(f, 'watch-editor')[0].emit('submit'); assert.equal(watchWrites(f).length, 0);
  hours.value = '12'; await hours.emit('input'); const save = byClass(f, 'watch-editor')[0].emit('submit');
  assert.deepEqual(watchWrites(f)[0].body.input, { requestId: 'watch-change-1', id: WATCH, expectedVersion: 1, operation: 'edit', intervalHours: 12 });
  f.requests.at(-1).reply(watches([topic({ version: 2, intervalHours: 12 })])); await save;
  assert.equal(f.$('announce').textContent, 'Watch saved.'); assert.match(byClass(f, 'watch-row')[0].textContent, /Topic · every 12 h/);
});
