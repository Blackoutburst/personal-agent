import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual application body, replacing only imported dependencies.
// Native DOM/fetch/clock boundaries are controlled; no browser/provider/network is launched.
const source = readFileSync(new URL('../public/companion-app.mjs', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const THREAD = '1e80ef85-15aa-4afb-99cf-e415fa3e4971';
const initial = () => ({ messages: [], turn: null, pending: null, draft: '', threadId: null, opened: false, connection: 'disconnected', error: null, synthetic: false });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ hash = '#chat', failures = 0, firstUse = false, runtime: profileRuntime = { state: 'ready', provider: 'claude' } } = {}) {
  let active, clientState = initial(), listener, clientEpoch = 0, clock = 0, timerId = 0, locationHash = hash;
  const all = [], nodes = new Map(), windowListeners = new Map(), documentListeners = new Map(), timers = new Map(), reads = [], writes = [], requests = [], queues = new Map(), denials = [], uploads = [], sends = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this.text = ''; this.scrollHeight = 100; this.clientHeight = 100; this.scrollTop = 0; this.className = ''; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; all.push(this); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
    set innerHTML(value) { this.markup = value; }
    append(...children) { for (const value of children) { const child = typeof value === 'string' ? Object.assign(new Element('#text'), { text: value }) : value; child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
    before(node) { this.parent.insertBefore(node, this); }
    insertBefore(node, before) { node.parent = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(name, run) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(run); }
    async emit(name, extra = {}) { await Promise.all((this.listeners.get(name) ?? []).map(run => run({ preventDefault() {}, ...extra }))); }
    querySelector(selector) { return descendants(this).find(node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : false) ?? null; }
    focus() { active = this; }
    contains(node) { return descendants(this).includes(node); }
    close() { this.open = false; }
    showModal() { this.open = true; }
  }
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g)) { const node = new Element(match[1]); node.id = match[2]; nodes.set(node.id, node); }
  const body = new Element('body'); for (const node of nodes.values()) body.append(node);
  const actions = new Element(), chat = new Element(); actions.className = 'conversation-actions'; body.append(actions, chat);
  const nav = ['chat', 'calendar', 'me'].map(view => Object.assign(new Element('a'), { dataset: { view } }));
  const theme = ['system', 'light', 'dark'].map(themeChoice => Object.assign(new Element('button'), { dataset: { themeChoice } }));
  const document = { body, title: '', visibilityState: 'visible', documentElement: new Element('html'), get activeElement() { return active; },
    getElementById: id => nodes.get(id) ?? all.find(node => node.id === id), createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { text }),
    querySelector(selector) { if (selector === '.conversation-actions') return actions; if (selector === '.chat') return chat; if (selector.startsWith('meta')) return null; const choice = /data-theme-choice="([^"]+)"/.exec(selector); return choice ? theme.find(node => node.dataset.themeChoice === choice[1]) : null; },
    querySelectorAll: selector => selector === '#nav a' ? nav : selector === '#me-tabs a' ? [] : selector === 'button[data-theme-choice]' ? theme : [],
    addEventListener(name, run) { documentListeners.set(name, run); } };
  const emit = patch => { clientState = { ...clientState, ...patch }; listener?.(structuredClone(clientState)); return structuredClone(clientState); };
  let nextSend = null, readFailures = failures, setupSaved = !firstUse;
  async function read(kind) { reads.push(kind); if (readFailures-- > 0) return emit({ connection: 'reconnecting', opened: kind !== 'open', error: 'NETWORK_ERROR' }); return emit({ connection: 'ready', opened: true, threadId: THREAD, error: null }); }
  const client = { getState: () => structuredClone(clientState), subscribe: run => { listener = run; run(structuredClone(clientState)); },
    clear() { clientEpoch++; clientState = initial(); return emit({}); }, open: () => read('open'), refresh: () => read('refresh'), poll: () => read('poll'),
    create() { writes.push('create'); return emit({ connection: 'ready', opened: true, threadId: THREAD }); }, setFiles() {},
    setDraft(value) { return emit({ draft: value }); },
    async send(text, attachments) { const epoch = clientEpoch, pending = { text, requestId: 'stable-send-1', status: 'submitting', action: 'submit' }; writes.push('send'); sends.push({ text, attachments: [...attachments] }); emit({ pending }); const outcome = await nextSend.promise;
      if (epoch === clientEpoch) emit({ pending: outcome.status === 'uncertain' ? { ...pending, status: 'uncertain' } : null,
        connection: outcome.error === 'ACCESS_DENIED' ? 'denied' : outcome.status === 'uncertain' ? 'reconnecting' : 'ready', error: outcome.error ?? null }); return { requestId: pending.requestId, text, ...outcome }; },
    retry() { writes.push('retry'); return Promise.resolve(); }, cancel() { writes.push('cancel'); return Promise.resolve(); }, deleteThread() { writes.push('delete'); return Promise.resolve(); }
  };
  const feature = opts => { if (opts?.onDenied) denials.push(opts.onDenied); return { clear() {}, load() {}, show: async () => {}, refreshIfOpen: async () => {} }; };
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const profile = { name: 'Pip', character: 'pip', color: 'peach', outfit: 'auto' };
  const sandbox = { console, structuredClone, URL, AbortController, TextEncoder, TextDecoder, Intl, Date, Promise, Set, Map, Object, JSON, String, Number,
    document, navigator: { onLine: true }, crypto: { randomUUID: () => '9d23bd88-cc69-4067-b375-e32bf5d7b338' }, location: { get hash() { return locationHash; }, set hash(value) { const changed = value !== locationHash; locationHash = value; if (changed) queueMicrotask(() => windowListeners.get('hashchange')?.()); } }, matchMedia: () => ({ matches: false }), confirm: () => true,
    createConversationClient: () => client, createFileTransport: () => ({ async upload(file, options) { uploads.push({ file, options }); return { id: '4d317b44-1f1a-46f1-b515-822d93c8246c', name: file.name, size: file.size, mime: 'application/octet-stream', url: '/api/files/4d317b44-1f1a-46f1-b515-822d93c8246c' }; } }), USER_CHARS: 8000, AttachmentError: class extends Error {},
    renderCharacter: () => '<svg></svg>', CHARACTERS: [{ id: 'pip', label: 'Pip', hint: 'Synthetic' }], COLORS: { peach: { body: '#a', shade: '#b', light: '#c' } }, OUTFITS: [], HAS_OUTFITS: () => false,
    createRemindersUI: feature, createCalendarUI: feature, createMemoryUI: feature, createPersonalityUI: feature, createContactUI: feature, createWeatherUI: feature, createWebPushUI: feature, registerServiceWorker: () => {}, renderPeerCard: () => new Element(),
    fetch: async (url, options = {}) => { if (url === 'android.json') return response({}, 404); const input = JSON.parse(options.body); requests.push(input); const queue = queues.get(input.action), next = queue?.shift();
      if (next) return await next;
      if (input.action === 'setProfile') setupSaved = true;
      return response(input.action === 'get' || input.action === 'setProfile' ? { profile: setupSaved ? profile : null, wearing: 'base', runtime: profileRuntime } : { discord: { linked: false } }); },
    setTimeout(run, delay) { const id = ++timerId; timers.set(id, { run, due: clock + delay, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval(run, delay) { const id = ++timerId; timers.set(id, { run, due: clock + delay, delay, interval: true }); return id; }, clearInterval: id => timers.delete(id)
  };
  sandbox.window = { companionTheme: { get: () => 'system', set() {} }, addEventListener(name, run) { windowListeners.set(name, run); } };
  const context = vm.createContext(sandbox); new vm.Script(source, { filename: 'public/companion-app.mjs' }).runInContext(context);
  const $ = id => document.getElementById(id), button = text => all.filter(node => node.tagName === 'BUTTON' && node.textContent === text && node.parent).at(-1);
  return { $, document, reads, writes, requests, uploads, sends, client, emit, timers, context, response, profile, button, sandbox,
    queue(action, value) { if (!queues.has(action)) queues.set(action, []); queues.get(action).push(value); },
    send(outcome) { nextSend = deferred(); return { finish: () => nextSend.resolve(outcome) }; },
    failReads(count) { readFailures = count; }, deny: () => denials[0](),
    async type(text) { $('input').value = text; $('input').focus(); await $('input').emit('input'); },
    async tick() { const selected = [...timers].filter(([, timer]) => !timer.interval).sort((a, b) => a[1].due - b[1].due)[0]; if (!selected) return false; const [id, timer] = selected; timers.delete(id); clock = timer.due; await timer.run(); await flush(); return timer.delay; },
    async windowEvent(name) { await windowListeners.get(name)?.(); await flush(); }, async visibility(value) { document.visibilityState = value; await documentListeners.get('visibilitychange')?.(); await flush(); }
  };
}

test('initial read failure retries with bounded backoff, exposes manual reconnect and never retries a write', async () => {
  const f = fixture({ failures: 99 }); await flush(); assert.equal(f.reads.length, 1); assert.equal(f.$('reconnect-chat').hidden, false);
  const delays = []; for (let i = 0; i < 5; i++) delays.push(await f.tick()); assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000]);
  assert.equal(await f.tick(), false); assert.equal(f.reads.length, 6); assert.deepEqual(f.writes, []); assert.match(f.$('note').textContent, /Select Reconnect/);
  f.failReads(0); await f.$('reconnect-chat').emit('click'); await flush(); assert.equal(f.client.getState().connection, 'ready'); assert.equal(f.$('reconnect-chat').hidden, true); assert.deepEqual(f.writes, []);
});

test('read retries pause while offline/hidden and resume read-only when current owner comes back', async () => {
  const f = fixture({ failures: 2 }); await flush(); f.sandbox.navigator.onLine = false; await f.windowEvent('offline'); assert.equal(await f.tick(), false);
  f.sandbox.navigator.onLine = true; await f.visibility('hidden'); await f.windowEvent('online'); assert.equal(f.reads.length, 1);
  await f.visibility('visible'); assert.equal(f.reads.length, 2); await f.tick(); assert.equal(f.client.getState().connection, 'ready'); assert.deepEqual(f.writes, []);
});

test('definite rejected text is restored, while a newer draft holds the original separately without overwriting or autosending', async () => {
  const f = fixture(); await flush(); await f.type('Original rejected text'); let pending = f.send({ status: 'rejected', error: 'BUSY' }); const sending = f.$('composer').emit('submit'); pending.finish(); await sending;
  assert.equal(f.$('input').value, 'Original rejected text'); assert.match(f.$('note').textContent, /not sent/);
  await f.type('Older original'); pending = f.send({ status: 'rejected', error: 'CONFLICT' }); const second = f.$('composer').emit('submit'); await f.type('Newer text stays'); pending.finish(); await second;
  assert.equal(f.$('input').value, 'Newer text stays'); const kept = f.button('Restore unsent message').parent; assert.ok(kept.textContent.includes('Older original')); assert.equal(f.$('send').disabled, true);
  await f.button('Restore unsent message').emit('click'); assert.equal(f.$('input').value, 'Newer text stays'); await f.type(''); await f.button('Restore unsent message').emit('click'); assert.equal(f.$('input').value, 'Older original'); assert.deepEqual(f.writes, ['send', 'send']);
});

test('uncertain/late-context sends never restore text or mint another logical write, and auth clears held text', async () => {
  const f = fixture(); await flush(); await f.type('Uncertain exact body'); let pending = f.send({ status: 'uncertain', error: 'NETWORK_ERROR' }); const sending = f.$('composer').emit('submit'); pending.finish(); await sending;
  assert.equal(f.$('input').value, ''); assert.equal(f.$('retry-send').hidden, false); assert.deepEqual(f.writes, ['send']);
  f.emit({ pending: null, connection: 'ready' }); await f.type('Old owner body'); pending = f.send({ status: 'rejected', error: 'BUSY' }); const late = f.$('composer').emit('submit'); f.deny(); pending.finish(); await late;
  assert.equal(f.$('input').value, ''); assert.equal(f.$('app').dataset.view, 'gate'); assert.equal(f.button('Restore unsent message').parent.hidden, true); const count = f.reads.length; await f.tick(); assert.equal(f.reads.length, count);
});

test('current Discord read failure ends loading with explicit retry, and stale private replies cannot repopulate after denial', async () => {
  const f = fixture({ hash: '#me/connectors' }); f.queue('discord', Promise.reject(new Error('PRIVATE-NETWORK'))); await flush();
  assert.match(f.$('discord-body').textContent, /could not be loaded/); assert.ok(!f.$('discord-body').textContent.includes('PRIVATE-NETWORK'));
  await f.button('Retry Discord settings').emit('click'); await flush(); assert.match(f.$('discord-body').textContent, /Connect/);
  const delayed = deferred(); f.queue('discord', delayed.promise); const loading = f.button('Reload Discord settings').emit('click'); f.deny(); delayed.resolve(f.response({ discord: { linked: true, bot: { name: 'PRIVATE-BOT' }, pairing: { code: 'PRIVATE-CODE' } } })); await loading;
  assert.equal(f.$('discord-body').textContent, ''); assert.equal(f.$('app').dataset.view, 'gate'); assert.equal(f.$('name').value, '');
});

test('old Look mutation denial cannot clear or unlock a restarted newer shell', async () => {
  const f = fixture({ hash: '#look' }); await flush(); const oldSave = deferred(); f.queue('setProfile', oldSave.promise); const saving = f.$('look-form').emit('submit');
  f.deny(); await vm.runInContext('start()', f.context); await flush(); const newer = deferred(); f.queue('setProfile', newer.promise); const savingNew = f.$('look-form').emit('submit');
  oldSave.resolve(f.response({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401)); await saving; assert.equal(f.$('save-look').disabled, true); assert.notEqual(f.$('app').dataset.view, 'gate');
  newer.resolve(f.response({ profile: { ...f.profile, name: 'New owner' } })); await savingNew; assert.equal(f.$('save-look').disabled, false); assert.equal(f.$('top-name').textContent, 'New owner');
});

test('an uncertain initial create remains exact pending work, never erased by automatic or manual read reconnect', async () => {
  const f = fixture(); await flush(); const pending = { action: 'createThread', requestId: 'original-create-key', title: 'Companion', status: 'uncertain' };
  f.emit({ opened: false, threadId: null, connection: 'reconnecting', pending }); const reads = f.reads.length;
  await f.$('reconnect-chat').emit('click'); await f.windowEvent('online'); await flush(); assert.equal(f.reads.length, reads);
  assert.equal(f.client.getState().pending.requestId, pending.requestId); assert.equal(f.$('retry-send').hidden, false); assert.equal(f.$('reconnect-chat').hidden, true); assert.deepEqual(f.writes, []);
});

test('old Discord read denial cannot wipe a newer settings mutation; current Look auth failure clears instead of blaming a name', async () => {
  const f = fixture({ hash: '#me/connectors' }); await flush(); const old = deferred(); f.queue('discord', old.promise); const oldLoad = f.button('Reload Discord settings').emit('click');
  const newer = deferred(); f.queue('discordLink', newer.promise); const input = f.$('discord-token'); input.value = 'SYNTHETIC TOKEN'; const mutation = input.parent.emit('submit');
  old.resolve(f.response({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401)); await oldLoad; assert.equal(f.button('Connecting…').disabled, true); assert.notEqual(f.$('app').dataset.view, 'gate');
  newer.resolve(f.response({ discord: { linked: true, bot: { name: 'Synthetic bot' }, user: { name: 'Synthetic owner' }, state: 'online' } })); await mutation;
  assert.match(f.$('discord-body').textContent, /Synthetic bot/); f.sandbox.location.hash = '#me/companion'; await flush(); f.queue('setProfile', f.response({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401)); await f.$('look-form').emit('submit');
  assert.equal(f.$('app').dataset.view, 'gate'); assert.equal(f.$('discord-body').textContent, ''); assert.equal(f.$('look-error').textContent, '');
});

test('a rejected old-thread result cannot restore text into a different selected thread', async () => {
  const f = fixture(); await flush(); await f.type('Only the original thread'); const pending = f.send({ status: 'rejected', error: 'BUSY' }); const sending = f.$('composer').emit('submit');
  f.emit({ threadId: '4d317b44-1f1a-46f1-b515-822d93c8246c', pending: null }); pending.finish(); await sending;
  assert.equal(f.$('input').value, ''); assert.equal(f.button('Restore unsent message').parent.hidden, true);
});

test('text+ready-file and files-only BUSY rejection retain the uploaded file without uploading or sending again', async () => {
  for (const text of ['Owner text with an already uploaded file', '']) {
    const f = fixture(); await flush(); await vm.runInContext("addFiles([{name:'synthetic-ready.txt',size:1,type:'application/octet-stream'}])", f.context); await flush();
    assert.equal(f.uploads.length, 1); assert.match(f.$('uploads').textContent, /synthetic-ready.txt/); await f.type(text);
    const pending = f.send({ status: 'rejected', error: 'BUSY' }), sending = f.$('composer').emit('submit'); pending.finish(); await sending;
    assert.equal(f.$('input').value, text); assert.equal(f.$('uploads').hidden, false); assert.match(f.$('uploads').textContent, /synthetic-ready.txt/);
    assert.deepEqual(f.sends, [{ text, attachments: ['4d317b44-1f1a-46f1-b515-822d93c8246c'] }]); assert.equal(f.uploads.length, 1); assert.deepEqual(f.writes, ['send']);
  }
});

test('detached appearance and Discord form handlers cannot modify or send for a newer owner shell', async () => {
  const f = fixture({ hash: '#look' }); await flush(); const oldCharacter = f.$('pick-character').children[0];
  f.sandbox.location.hash = '#me/connectors'; await flush(); const oldForm = f.$('discord-token').parent;
  f.$('discord-token').value = 'SYNTHETIC OLD TOKEN'; f.deny(); f.profile.character = 'claude'; await vm.runInContext('start()', f.context); await flush();
  f.sandbox.location.hash = '#me/companion'; await flush();
  const count = f.requests.length; await oldCharacter.emit('click'); await oldForm.emit('submit');
  assert.equal(vm.runInContext('draftLook.character', f.context), 'claude'); assert.equal(f.requests.length, count); assert.equal(oldForm.children[0].value, '');
});

test('validated conversation runtime replaces stale profile guidance, while initial null cannot restore old owner status', async () => {
  for (const state of ['signed-out', 'unconfigured']) {
    const runtime = { state, provider: 'claude' }, f = fixture({ runtime }); await flush();
    assert.equal(f.$('note').hidden, false); assert.match(f.$('note').textContent, state === 'signed-out' ? /needs to be signed in/ : /isn't set up/);
    f.emit({ runtime: { state: 'ready', provider: 'codex' } }); assert.equal(f.$('note').hidden, true);
    f.emit({ runtime: null }); assert.equal(f.$('note').hidden, true);
    for (const code of ['NOT_SIGNED_IN', 'NO_RUNTIME', 'PROVIDER_MISSING']) {
      f.emit({ turn: { requestId: 'earlier-failure', state: 'error', error: { code } } });
      assert.match(f.$('note').textContent, /earlier reply.*connected now; send again/); assert.deepEqual(f.writes, []);
    }
    f.deny(); runtime.state = 'unconfigured'; await vm.runInContext('start()', f.context); await flush();
    assert.equal(f.$('note').hidden, false); assert.match(f.$('note').textContent, /isn't set up/);
    f.emit({ runtime: { state: 'ready', provider: 'claude' } }); assert.equal(f.$('note').hidden, true);
  }
});

test('restored cancelled context explains partial text without hiding current offline or reconnect guidance', async () => {
  const f = fixture(); await flush(); f.emit({ turn: { requestId: 'stopped-owner-turn', state: 'cancelled' } });
  assert.match(f.$('note').textContent, /reply was stopped.*partial answer/);
  f.sandbox.navigator.onLine = false; await f.windowEvent('offline'); assert.match(f.$('note').textContent, /offline/); assert.ok(!f.$('note').textContent.includes('reply was stopped'));
  f.sandbox.navigator.onLine = true; f.emit({ connection: 'reconnecting', error: 'NETWORK_ERROR' }); assert.match(f.$('note').textContent, /reconnect/);
  f.emit({ connection: 'ready', error: null }); assert.match(f.$('note').textContent, /reply was stopped/);
});

test('first setup succeeds while hash already says chat and opens the conversation exactly once', async () => {
  const f = fixture({ firstUse: true, hash: '#chat' }); await flush();
  assert.equal(f.$('app').dataset.view, 'look'); assert.deepEqual(f.reads, []);
  await f.$('look-form').emit('submit'); await flush();
  assert.equal(f.sandbox.location.hash, '#chat'); assert.equal(f.$('app').dataset.view, 'chat'); assert.deepEqual(f.reads, ['open']);
  assert.equal(f.requests.filter(request => request.action === 'setProfile').length, 1); assert.deepEqual(f.writes, []);
});

test('the Me tab shows one sub-page at a time: memories, companion or settings; old links still land there', async () => {
  for (const [hash, shown] of [['#me', 'view-memories'], ['#memories', 'view-memories'], ['#me/companion', 'view-look'], ['#look', 'view-look'], ['#me/settings', 'view-settings']]) {
    const f = fixture({ hash }); await flush();
    assert.equal(f.$('app').dataset.view, 'me', hash); assert.equal(f.$('me-tabs').hidden, false);
    for (const id of ['view-memories', 'view-look', 'view-settings']) assert.equal(f.$(id).hidden, id !== shown, `${hash} ${id}`);
  }
});
