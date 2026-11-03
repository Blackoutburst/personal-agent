import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryUI } from '../public/memory-ui.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; this.value = ''; }
  set textContent(text) { this._text = text; this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  get lastChild() { return this.children.at(-1); }
  addEventListener(type, run) { this.listeners[type] = run; }
  click() { if (!this.disabled) return this.listeners.click?.({ preventDefault() {} }); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixture = (api, downloads) => {
  const ids = Object.fromEntries(['memories-title', 'memories-intro', 'memory-notice', 'memory-actions', 'memory-groups', 'announce'].map(id => [id, new Element('div')]));
  let denied = 0;
  const ui = createMemoryUI({ document: { getElementById: id => ids[id], createElement: tag => new Element(tag) }, api, onDenied: () => denied++, downloads });
  const all = () => { const nodes = []; const visit = node => { nodes.push(node); node.children.forEach(visit); }; Object.values(ids).forEach(visit); return nodes; };
  return { ui, ids, all, denied: () => denied, button: text => all().find(node => node.tag === 'button' && node.textContent === text) };
};
const snapshot = (text = 'old note', revision = 'a'.repeat(64)) => ({ revision: 'b'.repeat(64), files: [{ file: 'USER.md', revision,
  modifiedAtISO: '2026-11-03T00:00:00.000Z', readOnly: false, content: `# About\nplain prose\n- ${text}\n`,
  sections: [{ title: 'About', items: [{ id: '1'.repeat(16), text, line: 2 }] }] }] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('complete prose and read-only diary remain visible as text, without invented fact origins', async () => {
  const value = snapshot('<img onerror=alert(1)>'); value.files.push({ ...value.files[0], file: 'memory/2026-11-02.md', readOnly: true, content: 'A diary paragraph\nwith prose.' });
  const f = fixture(async () => value); await f.ui.load('Nova');
  assert.ok(f.ids['memory-groups'].textContent.includes('plain prose'));
  assert.ok(f.ids['memory-groups'].textContent.includes('<img onerror=alert(1)>'));
  assert.ok(f.ids['memory-groups'].textContent.includes('A diary paragraph'));
  assert.ok(f.ids['memory-groups'].textContent.includes('file updated'));
  assert.equal(f.all().filter(node => node.tag === 'button' && node.textContent === 'Edit').length, 1);
  assert.equal(f.all().filter(node => node.tag === 'img').length, 0);
});

test('a late load cannot restore notes after a newer forget acknowledgement', async () => {
  const stale = deferred(); let loads = 0, mutation;
  const f = fixture(async body => { if (body.action === 'memory') return ++loads === 1 ? snapshot() : stale.promise; mutation = body; return { ...snapshot(''), removed: true }; });
  await f.ui.load(); const pending = f.ui.load();
  f.button('Forget').click(); await f.button('Confirm forget').click();
  stale.resolve(snapshot('old private text')); await pending;
  assert.equal(mutation.expectedRevision, 'a'.repeat(64));
  assert.ok(!f.ids['memory-groups'].textContent.includes('old private text'));
  assert.equal(f.ids['memory-notice'].textContent, "Removed from memory. Past chats aren't changed.");
});

test('409 reloads canonical notes, keeps the draft and does not silently adopt a new revision', async () => {
  const calls = []; let reads = 0;
  const f = fixture(async body => { calls.push(body); if (body.action === 'memory') return snapshot(++reads === 1 ? 'old note' : 'other device edit', reads === 1 ? 'a'.repeat(64) : 'c'.repeat(64)); throw Object.assign(new Error('MEMORY_CONFLICT'), { status: 409 }); });
  await f.ui.load(); f.button('Edit').click();
  const input = f.all().find(node => node.tag === 'textarea'); input.value = 'my correction'; input.listeners.input();
  f.all().find(node => node.tag === 'form').listeners.submit({ preventDefault() {} }); await tick();
  assert.ok(f.ids['memory-groups'].textContent.includes('other device edit'));
  assert.equal(f.all().find(node => node.tag === 'textarea').value, 'my correction');
  assert.equal(f.button('Save correction').disabled, true);
  assert.equal(calls.filter(body => body.action === 'editMemory').length, 1);
  assert.equal(calls.find(body => body.action === 'editMemory').expectedRevision, 'a'.repeat(64));
});

test('clearing owner context purges drafts and ignores late owner data', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture(async () => ++count === 1 ? snapshot('private draft source') : pending.promise);
  await f.ui.load(); f.button('Edit').click(); const load = f.ui.load('Another name', { preserveDraft: true });
  f.ui.clear(); pending.resolve(snapshot('OLD OWNER PRIVATE')); await load;
  assert.equal(f.ids['memory-groups'].textContent, '');
  assert.equal(f.all().filter(node => node.tag === 'textarea').length, 0);
});

test('auth denial clears saved notes; a late export after owner reset never creates a download', async () => {
  const exportReply = deferred(); let revoked = 0, created = 0;
  const downloads = { Blob, URL: { createObjectURL() { created++; return 'blob:synthetic'; }, revokeObjectURL() { revoked++; } }, setTimeout(fn) { fn(); } };
  const f = fixture(async body => body.action === 'memory' ? snapshot() : exportReply.promise, downloads);
  await f.ui.load(); const exporting = f.button('Export saved notes and diary').click(); f.ui.clear();
  exportReply.resolve({ export: { files: snapshot('PRIVATE').files } }); await exporting;
  assert.equal(created, 0); assert.equal(revoked, 0);
  const denied = fixture(async () => { throw Object.assign(new Error('AUTHENTICATION_REQUIRED'), { status: 401 }); });
  await denied.ui.load(); assert.equal(denied.denied(), 1); assert.equal(denied.ids['memory-groups'].textContent, '');
});

test('forget everything is a separate confirmation using the current whole-memory revision', async () => {
  let change;
  const f = fixture(async body => { if (body.action === 'memory') return snapshot(); change = body; return { ...snapshot(''), cleared: true }; });
  await f.ui.load(); f.button('Forget everything the companion remembers').click(); assert.equal(change, undefined);
  await f.button('Confirm forget everything').click();
  assert.deepEqual(change, { action: 'forgetAll', expectedRevision: 'b'.repeat(64), confirm: true });
  assert.ok(f.ids['memory-notice'].textContent.includes('Personality and past chats are unchanged'));
});

test('a late reload cannot repin an already opened destructive confirmation', async () => {
  for (const all of [true, false]) {
    const pending = deferred(); let reads = 0, change;
    const f = fixture(async body => { if (body.action === 'memory') return ++reads === 1 ? snapshot() : pending.promise; change = body; return { ...snapshot(), cleared: true, removed: true }; });
    await f.ui.load(); const reloading = f.ui.load();
    f.button(all ? 'Forget everything the companion remembers' : 'Forget').click();
    pending.resolve({ ...snapshot('old note', 'c'.repeat(64)), revision: 'd'.repeat(64) }); await reloading;
    await f.button(all ? 'Confirm forget everything' : 'Confirm forget').click();
    assert.equal(change.expectedRevision, (all ? 'b' : 'a').repeat(64));
  }
});
