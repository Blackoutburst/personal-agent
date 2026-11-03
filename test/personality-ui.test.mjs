import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalityUI } from '../public/personality-ui.mjs';

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this._text = ''; this.value = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, run) { this.listeners[type] = run; }
  click() { if (!this.disabled) return this.listeners.click?.({ preventDefault() {} }); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const stamp = '2026-11-03T02:00:00.000Z', revision = letter => letter.repeat(64);
const observed = (letter = 'b', content = '# Earlier\nWarm and curious.\n') => ({ revision: revision(letter), content,
  observedAtISO: stamp, modifiedAtISO: stamp, source: 'settled_turn' });
const snapshot = (content = '# Soul\nProse stays.\n- Playful\n', letter = 'a', history = [observed()]) => ({ file: 'SOUL.md', content,
  revision: revision(letter), modifiedAtISO: stamp, history: history.map(({ content, ...metadata }) => metadata), historyLimit: 20 });
function fixture(api) {
  const ids = Object.fromEntries(['personality-title', 'personality-intro', 'personality-actions', 'personality-notice', 'personality-body', 'announce'].map(id => [id, new Element('div')]));
  let denied = 0;
  const ui = createPersonalityUI({ document: { getElementById: id => ids[id], createElement: tag => new Element(tag) }, api, onDenied: () => denied++ });
  const all = () => { const result = []; const visit = node => { result.push(node); node.children.forEach(visit); }; Object.values(ids).forEach(visit); return result; };
  const button = text => all().find(node => node.tag === 'button' && node.textContent === text);
  const input = () => all().find(node => node.tag === 'textarea');
  const type = text => { input().value = text; input().listeners.input(); };
  const submit = () => all().find(node => node.tag === 'form').listeners.submit({ preventDefault() {} });
  return { ui, ids, all, button, input, type, submit, denied: () => denied };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('full prose, BOM and truthful file/observation metadata remain safe text; history can legitimately be empty', async () => {
  const content = '\uFEFF# Soul\r\nProse <img onerror="bad()"> stays.\r\n', f = fixture(async () => snapshot(content, 'a', []));
  await f.ui.load('Nova');
  assert.ok(f.ids['personality-body'].textContent.includes(content));
  assert.ok(f.ids['personality-body'].textContent.includes('SOUL.md · file updated'));
  assert.ok(f.ids['personality-body'].textContent.includes('versions the app saw'));
  assert.ok(f.ids['personality-body'].textContent.includes('No versions have been observed yet.'));
  assert.equal(f.all().filter(node => node.tag === 'img').length, 0);
  assert.equal(f.button('Edit personality').disabled, false);
});

test('full editor preserves BOM, CRLF and mixed separators, and sends exact draft bytes with original CAS only on submit', async () => {
  for (const [original, entered, expected] of [
    ['\uFEFF# Soul\r\nWarm.\r\n', '\uFEFF# Soul\nWarm.\n', '\uFEFF# Soul\r\nWarm.\r\n'],
    ['\uFEFF# Soul\r\nWarm.\r\n', '\uFEFF# Soul\nKind 🙂.\n', '\uFEFF# Soul\r\nKind 🙂.\r\n'],
    ['First\r\nSecond\nThird\rLast', 'First\nChanged\nThird\nLast', 'First\r\nChanged\nThird\rLast']
  ]) {
    const calls = [], f = fixture(async body => { calls.push(body); return body.action === 'personality' ? snapshot(original) : { ...snapshot(body.content, 'c'), changed: true }; });
    await f.ui.load(); f.button('Edit personality').click(); f.type(entered);
    assert.equal(calls.length, 1); f.submit(); await tick();
    assert.deepEqual(calls[1], { action: 'editPersonality', content: expected, expectedRevision: revision('a') });
    assert.equal(f.input(), undefined); assert.ok(f.ids['personality-notice'].textContent.includes('Personality saved'));
  }
});

test('409 reload keeps the exact draft, blocks auto-adopting a revision, and reviewed new edit uses current CAS', async () => {
  const calls = []; let reads = 0, conflict = true;
  const f = fixture(async body => {
    calls.push(body);
    if (body.action === 'personality') return ++reads === 1 ? snapshot() : snapshot('Other device personality.\n', 'c');
    if (conflict) throw Object.assign(new Error('PERSONALITY_CONFLICT'), { status: 409 });
    return { ...snapshot(body.content, 'd'), changed: true };
  });
  await f.ui.load(); f.button('Edit personality').click(); f.type('My draft 🙂\n'); f.submit(); await tick();
  assert.equal(f.input().value, 'My draft 🙂\n'); assert.equal(f.button('Save personality').disabled, true);
  assert.ok(f.ids['personality-body'].textContent.includes('Other device personality.'));
  assert.equal(calls.filter(body => body.action === 'editPersonality').length, 1);
  assert.equal(f.button('Edit personality').disabled,true); f.button('Edit personality').click();
  assert.equal(f.input().value,'My draft 🙂\n'); assert.equal(f.button('Save personality').disabled,true);
  f.submit(); await tick(); assert.equal(calls.filter(body => body.action === 'editPersonality').length, 1);
  f.button('Close personality editor').click(); f.button('Edit personality').click(); f.type('Reviewed draft'); conflict = false; f.submit(); await tick();
  assert.equal(calls.at(-1).expectedRevision, revision('c'));
});

test('a second Edit action cannot discard an existing dirty draft after a reload', async () => {
  let reads=0; const f=fixture(async()=>++reads===1?snapshot():snapshot('Current after reload','c'));
  await f.ui.load(); f.button('Edit personality').click(); f.type('Unsubmitted private draft\n');
  await f.ui.load(); assert.equal(f.button('Edit personality').disabled,true);
  f.button('Edit personality').click(); assert.equal(f.input().value,'Unsubmitted private draft\n');
  assert.equal(f.button('Save personality').disabled,true);
  f.button('Close personality editor').click(); f.button('Edit personality').click();
  assert.equal(f.input().value,'Current after reload'); assert.equal(f.button('Save personality').disabled,false);
});

test('busy keeps a draft retryable, while invalid/oversized raw text never reaches mutation transport', async () => {
  const calls = [], f = fixture(async body => { calls.push(body); if (body.action === 'personality') return snapshot(); throw Object.assign(new Error('PERSONALITY_BUSY'), { status: 409 }); });
  await f.ui.load(); f.button('Edit personality').click(); f.type('Draft stays'); f.submit(); await tick();
  assert.equal(f.input().value, 'Draft stays'); assert.equal(f.button('Save personality').disabled, false);
  assert.ok(f.ids['personality-notice'].textContent.includes('Finish or stop'));
  const count = calls.length;
  for (const text of ['x'.repeat(256 * 1024 + 1), '\ud800', 'bad\u0000text']) { f.type(text); f.submit(); await tick(); assert.equal(calls.length, count); assert.equal(f.input().value, text); }
});

test('observed version is fetched by exact revision, shown completely and compared as text with bounded preview', async () => {
  const full = '<script>bad()</script>\n' + 'Version line\n'.repeat(500), version = observed('b', full), calls = [];
  const f = fixture(async body => { calls.push(body); return body.action === 'personality' ? snapshot('Current\n', 'a', [version]) : { version }; });
  await f.ui.load(); await f.button('View observed version').click();
  assert.deepEqual(calls[1], { action: 'personalityVersion', revision: revision('b') });
  assert.ok(f.all().some(node => node.tag === 'pre' && node.textContent === full));
  assert.ok(f.ids['personality-body'].textContent.includes('comparison preview is limited'));
  assert.equal(f.all().filter(node => node.tag === 'script').length, 0);
  assert.equal(f.button('Confirm restore'), undefined); assert.equal(f.button('Restore this version').disabled, false);
});

test('restore confirmation pins both target and reviewed current revision against a late reload', async () => {
  const pending = deferred(), version = observed(); let reads = 0; const calls = [];
  const f = fixture(async body => {
    calls.push(body);
    if (body.action === 'personality') return ++reads === 1 ? snapshot() : pending.promise;
    if (body.action === 'personalityVersion') return { version };
    return { ...snapshot(version.content, 'b'), changed: true };
  });
  await f.ui.load(); await f.button('View observed version').click(); const reloading = f.ui.load();
  f.button('Restore this version').click(); assert.equal(calls.filter(body => body.action === 'restorePersonality').length, 0);
  pending.resolve(snapshot('New current bytes', 'c')); await reloading;
  await f.button('Confirm restore').click();
  assert.deepEqual(calls.at(-1), { action: 'restorePersonality', revision: revision('b'), expectedRevision: revision('a'), confirm: true });
});

test('stale read cannot replace an acknowledged edit; late load/version/mutation cannot restore cleared owner context', async () => {
  const stale = deferred(); let reads = 0;
  const f = fixture(async body => body.action === 'personality' ? ++reads === 1 ? snapshot() : stale.promise : { ...snapshot('New owner edit', 'c'), changed: true });
  await f.ui.load(); const reading = f.ui.load(); f.button('Edit personality').click(); f.type('New owner edit'); f.submit(); await tick();
  stale.resolve(snapshot('STALE PRIVATE CONTENT', 'd')); await reading;
  assert.ok(f.ids['personality-body'].textContent.includes('New owner edit')); assert.ok(!f.ids['personality-body'].textContent.includes('STALE PRIVATE CONTENT'));
  for (const operation of ['load', 'version', 'mutation']) {
    const held = deferred(); let initial = true;
    const owner = fixture(async body => { if (initial) { initial = false; return snapshot(); } return held.promise; });
    await owner.ui.load(); let pending;
    if (operation === 'load') pending = owner.ui.load();
    else if (operation === 'version') pending = owner.button('View observed version').click();
    else { owner.button('Edit personality').click(); owner.type('OLD OWNER DRAFT'); owner.submit(); }
    owner.ui.clear(); held.resolve(operation === 'version' ? { version: observed('b', 'OLD OWNER PRIVATE') } : { ...snapshot('OLD OWNER PRIVATE'), changed: true });
    await pending; await tick();
    assert.equal(owner.ids['personality-body'].textContent, ''); assert.equal(owner.ids['personality-actions'].textContent, ''); assert.equal(owner.input(), undefined);
  }
});

test('auth denial clears private view/draft and wrong or evicted version replies never enable restoration', async () => {
  let mode = 'initial';
  const f = fixture(async body => {
    if (mode === 'initial') return snapshot();
    if (mode === 'wrong') return { version: observed('c', 'Wrong target') };
    throw Object.assign(new Error(mode === 'missing' ? 'PERSONALITY_NOT_FOUND' : 'AUTHENTICATION_REQUIRED'), { status: mode === 'missing' ? 404 : 401 });
  });
  await f.ui.load(); mode = 'wrong'; await f.button('View observed version').click(); assert.equal(f.button('Restore this version'), undefined);
  mode = 'missing'; await f.button('View observed version').click(); assert.equal(f.denied(), 0); assert.equal(f.button('Restore this version'), undefined);
  f.button('Edit personality').click(); f.type('PRIVATE DRAFT'); mode = 'denied'; f.submit(); await tick();
  assert.equal(f.denied(), 1); assert.equal(f.ids['personality-body'].textContent, ''); assert.equal(f.input(), undefined);
});
