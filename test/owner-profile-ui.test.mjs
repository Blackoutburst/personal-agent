import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerProfileUI, prepareOwnerPhoto } from '../public/owner-profile-ui.mjs';
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this[name]; delete this.attributes[name]; }
  addEventListener(type, run) { this.listeners[type] = run; }
}
const A = '11111111-1111-4111-8111-111111111111', snap = (revision = 0, displayName = 'Alice') => ({ profile: { id: A, displayName, revision, photoVersion: null }, photo: null });
const flush = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(handler, preparePhoto) {
  const home = new Element('section'), document = { getElementById: () => home, createElement: tag => new Element(tag) }; let denied = 0;
  const calls = [], ui = createOwnerProfileUI({ document, preparePhoto, onDenied: () => denied++, fetchImpl: async (url, options) => {
    assert.equal(url, 'api/owner-profile'); assert.equal(options.credentials, 'same-origin');
    const input = JSON.parse(options.body); calls.push(input); const value = await handler(input);
    return { ok: !value.status || value.status < 400, status: value.status ?? 200, json: async () => value.body ?? value };
  } });
  const all = () => { const result = []; const visit = node => { result.push(node); node.children.forEach(visit); }; visit(home); return result; };
  const form = () => all().find(node => node.tag === 'form'), input = () => all().find(node => node.type === 'text'), picker = () => all().find(node => node.type === 'file');
  return { ui, calls, home, all, form, input, picker, denied: () => denied, submit: async () => { form().listeners.submit({ preventDefault() {} }); await flush(); } };
}
test('display names stay plain text and saves use only the confirmed own revision', async () => {
  const f = fixture(input => input.action === 'get' ? snap(2, 'Alice & Bob') : snap(3, input.displayName));
  await f.ui.show(); f.input().value = 'Alice publique'; await f.submit();
  assert.deepEqual(f.calls, [{ action: 'get' }, { action: 'set', displayName: 'Alice publique', expectedRevision: 2 }]);
  assert.match(f.home.textContent, /Profile saved/); assert.equal(f.all().some(node => node.tag === 'script'), false);
});
test('conflict and unconfirmed save retain the draft, never retry automatically and require a canonical reload', async () => {
  const f = fixture(input => input.action === 'get' ? snap(1) : { status: 409, body: { error: { code: 'PROFILE_CONFLICT' } } });
  await f.ui.show(); f.input().value = 'Unsaved draft'; await f.submit();
  assert.equal(f.input().value, 'Unsaved draft'); assert.equal(f.calls.filter(c => c.action === 'set').length, 1);
  assert.equal(f.all().find(node => node.type === 'submit').disabled, true); assert.match(f.home.textContent, /draft is still here/);
  await f.submit(); assert.equal(f.calls.filter(c => c.action === 'set').length, 1);
});
test('owner reset fences pending reads, saves and image conversion and clears every retained photo/name', async () => {
  const read = defer(), f = fixture(() => read.promise); const load = f.ui.show(); f.ui.clear(); read.resolve(snap(0, 'OLD_OWNER_PRIVATE_NAME')); await load;
  assert.equal(f.input().value, ''); assert.equal(f.all().find(node => node.tag === 'img').src, undefined);
  const image = defer(), g = fixture(() => snap(), () => image.promise); await g.ui.show();
  g.picker().files = [{ type: 'image/png', size: 10 }]; g.picker().listeners.change(); g.ui.clear();
  image.resolve({ mime: 'image/jpeg', base64: '/9j/AA==' }); await flush();
  assert.equal(g.all().find(node => node.tag === 'img').src, undefined); assert.equal(g.input().value, '');
});
test('current authorization failure clears the editor and invokes the shell boundary', async () => {
  let deny = false; const f = fixture(() => deny ? { status: 401, body: { error: { code: 'AUTHENTICATION_REQUIRED' } } } : snap());
  await f.ui.show(); deny = true; await f.submit(); assert.equal(f.denied(), 1); assert.equal(f.input().value, '');
});
test('picture preparation is bounded, flattens to JPEG and releases the decoded bitmap', async () => {
  let closed = 0, canvas;
  const picture = await prepareOwnerPhoto({ type: 'image/png', size: 100 }, { createBitmap: async () => ({ width: 2000, height: 1000, close: () => closed++ }),
    document: { createElement: () => canvas = { getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,/9j/AA==' } } });
  assert.equal(canvas.width, 512); assert.equal(canvas.height, 256); assert.equal(picture.mime, 'image/jpeg'); assert.equal(closed, 1);
  await assert.rejects(prepareOwnerPhoto({ type: 'image/svg+xml', size: 20 }), /JPEG, PNG or WebP/);
});
