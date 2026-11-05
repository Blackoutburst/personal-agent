import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioUI } from '../public/studio-ui.mjs';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = ''; this._text = ''; this.style = { setProperty() {} }; this.classList = { add() {} }; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, run) { this.listeners[type] = run; }
  dispatch(type, event = {}) { return this.listeners[type]?.({ preventDefault() {}, stopPropagation() {}, ...event }); }
  querySelector(tag) { return this.children.find(node => node.tag === tag); }
  focus() {}
  click() { if (!this.disabled) this.listeners.click?.(); }
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const contact = company => ({ company, addresses: [{ address: 'one@' + company, optedOut: false }], followUp: 'replied', optedOut: false, lastAt: '2026-11-04T12:00:00Z' });
const list = { contacts: [contact('acme.example'), contact('other.example')], provenance: { text: 'Actual connector history', missingSent: 1, missingReceived: 0 } };
const detail = company => ({ company, nextOffset: null, messages: [{ id: 'one', direction: 'received', state: 'received', at: '2026-11-04T12:00:00Z', address: '<iframe>@' + company,
  subject: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>\nhttps://external.invalid/tracker', handled: true }] });
function fixture(handler) {
  const home = new Element('section'), nav = new Element('a'); nav.hidden = true; let denied = 0;
  const document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
    getElementById: id => id === 'studio-home' ? home : id === 'nav-studio' ? nav : null };
  const calls = [], fetchImpl = async (url, options) => {
    assert.equal(url, 'api/studio'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    const input = JSON.parse(options.body); calls.push(input); const result = await handler(input);
    return { ok: !result.status || result.status < 400, status: result.status ?? 200, json: async () => result.body ?? result };
  };
  const ui = createStudioUI({ document, fetchImpl, onDenied: () => denied++ });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; visit(home); return nodes; };
  return { ui, home, nav, calls, all, denied: () => denied, contacts: () => all().filter(node => node.className === 'studio-contact') };
}
test('contact book renders external bodies only as text, discloses missing history and offers no mail writes', async () => {
  const f = fixture(input => input.action === 'access' ? { allowed: true } : input.action === 'list' ? list : detail(input.company));
  await f.ui.probe(); assert.equal(f.nav.hidden, false); await f.ui.show('mail'); f.contacts()[0].click(); await flush();
  assert.match(f.home.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(f.home.textContent, /ancien\(s\) envoi/);
  assert.equal(f.all().some(node => ['script', 'iframe', 'img', 'a', 'textarea'].includes(node.tag)), false);
  assert.deepEqual(f.calls.map(call => call.action), ['access', 'list', 'detail']);
  assert.ok(f.calls.every(call => !Object.hasOwn(call, 'companionId')));
});
test('old owner reads, probes and detached contact buttons cannot repopulate or act after clear', async () => {
  const pending = deferred(); let delayed = false;
  const f = fixture(input => delayed ? pending.promise : input.action === 'list' ? list : { allowed: true });
  await f.ui.show('mail'); const detached = f.contacts()[0]; f.ui.clear(); const before = f.calls.length; detached.click(); await flush(); assert.equal(f.calls.length, before);
  delayed = true; const load = f.ui.show('mail'), probe = f.ui.probe(); f.ui.clear(); pending.resolve(list); await Promise.all([load, probe]);
  assert.equal(f.nav.hidden, true); assert.equal(f.home.textContent.includes('acme.example'), false);
});
test('late detail cannot overwrite a newer contact, and authentication denial clears all retained correspondence', async () => {
  const old = deferred(); let deny = false;
  const f = fixture(input => deny ? { status: 401, body: { error: { code: 'AUTHENTICATION_REQUIRED' } } }
    : input.action === 'list' ? list : input.company === 'acme.example' ? old.promise : detail(input.company));
  await f.ui.show('mail'); f.contacts()[0].click(); f.contacts()[1].click(); await flush(); old.resolve(detail('acme.example')); await flush();
  const heading = f.all().find(node => node.tag === 'h2' && node.className !== 'studio-app-title'); assert.equal(heading.textContent, 'other.example');
  deny = true; await f.ui.show('mail'); assert.equal(f.denied(), 1); assert.equal(f.nav.hidden, true); assert.equal(f.home.textContent.includes('<script>'), false);
});
// #65: the Studio tab opens on an app grid; the Calendar app is the shared Studio calendar on the same endpoint.
const studioEvent = { id: 'e1', version: 1, title: '<b>Call with Acme</b>', allDay: false, start: '2026-11-12T14:00', end: '2026-11-12T15:00',
  location: 'Visio', notes: null, company: 'acme.example', contact: null, repeat: 'none', reminderMinutes: null,
  createdBy: { kind: 'companion', name: 'C-chan' }, updatedBy: { kind: 'human', name: 'Bob' } };
const studioView = { today: '2026-11-05', from: '2026-10-26', days: 42, holidaysFr: false, events: [studioEvent], upcoming: [studioEvent],
  occurrences: [{ eventId: 'e1', title: studioEvent.title, date: '2026-11-12', allDay: false, start: studioEvent.start, end: studioEvent.end, location: 'Visio', company: 'acme.example' }] };
test('app grid shows only the apps this member may open, and the calendar shows who added each event', async () => {
  const f = fixture(input => input.action === 'access' ? { allowed: true, apps: { mail: false, calendar: true } } : input.action === 'calendar' ? studioView : { status: 400, body: {} });
  await f.ui.show();
  const tiles = () => f.all().filter(node => node.className === 'studio-app-tile');
  assert.deepEqual(tiles().map(tile => tile.dataset.app), ['calendar']);
  assert.equal(f.nav.hidden, false);
  tiles()[0].click(); await flush(); await flush();
  assert.deepEqual(f.calls.map(call => call.action), ['access', 'calendar', 'calendar']);
  assert.match(f.home.textContent, /Ajouté par C-chan \(compagnon\) · modifié par Bob/);
  assert.match(f.home.textContent, /acme\.example/); assert.match(f.home.textContent, /À venir/);
  assert.match(f.home.textContent, /<b>Call with Acme<\/b>/, 'Event text stays text');
  assert.equal(f.all().some(node => node.tag === 'b'), false);
  // An app this member may not open falls back to the grid with a note; the back control returns to the grid.
  await f.ui.show('mail'); assert.match(f.home.textContent, /pas disponible pour vous/);
  assert.equal(f.calls.some(call => call.action === 'list'), false);
  await f.ui.show('calendar'); const back = f.all().find(node => node.className === 'button studio-apps-back'); back.click(); await flush();
  assert.equal(f.all().find(node => node.className === 'studio-apps').hidden, false);
});
test('tiles navigate through the host app when it routes Studio apps by hash', async () => {
  const home = new Element('section'), seen = [];
  const document = { createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
    getElementById: id => id === 'studio-home' ? home : null };
  const ui = createStudioUI({ document, navigate: app => seen.push(app),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ allowed: true, apps: { mail: true, calendar: true } }) }) });
  await ui.show();
  const all = []; const visit = node => { all.push(node); node.children.forEach(visit); }; visit(home);
  const tiles = all.filter(node => node.className === 'studio-app-tile');
  assert.deepEqual(tiles.map(tile => tile.dataset.app), ['mail', 'calendar']);
  tiles[1].click(); all.find(node => node.className === 'button studio-apps-back').click();
  assert.deepEqual(seen, ['calendar', null]);
});
