import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const u = require('../desktop/src/updater.js');

const run = (events, start = u.IDLE) => events.reduce(u.reduce, start);

test('update state: available -> (click) downloading n% -> ready (#97)', () => {
  let s = run([{ type: 'available', version: '0.5.0' }]);
  assert.deepEqual(s, { phase: 'available', version: '0.5.0' });
  assert.equal(u.view(s).action.label, 'Download'); assert.equal(u.parseAction(u.view(s).action.url), 'download');
  assert.equal(u.reduce(s, { type: 'progress', percent: 50 }), s, 'no progress without a click');
  assert.equal(u.reduce(s, { type: 'downloaded', version: '0.5.0' }).phase, 'ready' && 'ready');
  s = u.reduce(s, { type: 'download' });
  assert.deepEqual(s, { phase: 'downloading', version: '0.5.0', percent: 0 });
  assert.equal(u.view(s).dismissible, false);
  s = u.reduce(s, { type: 'progress', percent: 12.7 });
  assert.equal(s.percent, 12);
  s = u.reduce(s, { type: 'progress', percent: 5 });          // never goes backwards
  assert.equal(s.percent, 12);
  s = u.reduce(s, { type: 'progress', percent: 250 });
  assert.equal(s.percent, 100);
  s = u.reduce(s, { type: 'downloaded', version: '0.5.0' });
  assert.deepEqual(s, { phase: 'ready', version: '0.5.0' });
  assert.equal(u.view(s).action.label, 'Restart to update');
  assert.equal(u.parseAction(u.view(s).action.url), 'restart');
  const d = u.reduce(s, { type: 'dismiss' });
  assert.equal(d.phase, 'ready', 'a finished download stays ready after the card is dismissed');
  assert.equal(u.view(d), null);
  assert.equal(u.view(u.reduce(d, { type: 'available', version: '0.5.0' })), null, 'same version stays dismissed');
  assert.equal(u.view(u.reduce(u.reduce(u.IDLE, { type: 'available', version: '0.5.1' }), { type: 'available', version: '0.5.1' })).text.includes('0.5.1'), true);
  assert.equal(u.reduce(s, { type: 'error', message: 'x' }), s, 'a late error does not lose a finished download');
  assert.equal(u.reduce(s, { type: 'download' }), s);
  // dismissed while available: hidden, and a re-check of that version keeps it hidden; a newer version shows again
  const hid = u.reduce(run([{ type: 'available', version: '0.6.0' }]), { type: 'dismiss' });
  assert.equal(u.view(hid), null);
  assert.equal(u.view(u.reduce(hid, { type: 'available', version: '0.6.0' })), null);
  assert.notEqual(u.view(u.reduce(hid, { type: 'available', version: '0.6.1' })), null);
});

test('update state: errors show a message, retry downloads again, check errors stay silent', () => {
  assert.equal(u.reduce(u.IDLE, { type: 'error', message: 'offline' }), u.IDLE);
  let s = run([{ type: 'available', version: '0.5.0' }, { type: 'download' }, { type: 'progress', percent: 40 }, { type: 'error', message: 'Could not reach the server.' }]);
  assert.deepEqual(s, { phase: 'error', version: '0.5.0', message: 'Could not reach the server.' });
  const v = u.view(s);
  assert.equal(v.text, 'Could not reach the server.'); assert.equal(v.error, true); assert.equal(v.action.label, 'Try again'); assert.equal(u.parseAction(v.action.url), 'retry');
  s = u.reduce(s, { type: 'retry' });
  assert.deepEqual(s, { phase: 'downloading', version: '0.5.0', percent: 0 });
  assert.equal(u.view(u.IDLE), null);
  assert.equal(u.view({ phase: 'downloading', version: '1.0.0', percent: 33 }).percent, 33);
  assert.equal(u.reduce(u.reduce(s, { type: 'error', message: 'e' }), { type: 'dismiss' }).phase, 'idle');
});

test('friendly errors, cookie header, action parsing, banner script', () => {
  assert.match(u.friendlyError(Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {})), /Could not reach the server/);
  assert.match(u.friendlyError(new Error('sha512 checksum mismatch')), /damaged/);
  assert.match(u.friendlyError(new Error('Cannot download "x", status 403')), /sign-in/);
  assert.match(u.friendlyError(new Error('weird')), /current version keeps working/);
  assert.equal(u.cookieHeader([{ name: 'a', value: '1' }, { name: 'b c', value: '2' }, { name: 'd', value: 'x;y' }, { name: 'e', value: '3' }]), 'a=1; e=3');
  assert.equal(u.parseAction('companion-update://restart'), 'restart');
  for (const bad of ['companion-update://rm', 'https://blackoutburst.com/', 'companion-update://restart/x', null]) assert.equal(u.parseAction(bad), null);
  const view = { text: '"});alert(1)//', percent: 5, action: null, dismissible: true };
  const script = u.bannerScript(view);
  assert.ok(script.includes(JSON.stringify(view)));
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotThrow(() => new Function(u.bannerScript(null)));
});

function fake() {
  const a = new EventEmitter();
  a.checks = 0; a.downloads = 0; a.installs = [];
  a.checkForUpdates = async function () { a.checks++; if (a.fail) throw a.fail; };
  a.downloadUpdate = async function () { a.downloads++; if (a.dlFail) throw a.dlFail; };
  a.quitAndInstall = (...args) => a.installs.push(args);
  return a;
}

test('updater wiring: no download without a click, then progress, then restart (#97)', async () => {
  const a = fake(), seen = []; let restarted = 0;
  const up = u.createUpdater({ autoUpdater: a, getHeaders: async () => ({ Cookie: 'c=1' }), onState: s => seen.push(s.phase + (s.percent ?? '')), onRestart: () => restarted++ });
  assert.equal(a.autoDownload, false); assert.equal(a.autoInstallOnAppQuit, false);
  await up.check();
  assert.equal(a.checks, 1); assert.deepEqual(a.requestHeaders, { Cookie: 'c=1' });
  assert.equal(up.handleAction('restart'), false, 'nothing to restart into yet');
  assert.equal(up.handleAction('download'), false, 'nothing to download yet');
  a.emit('update-available', { version: '0.5.0' });
  await up.check(); await up.check();
  assert.equal(a.downloads, 0, 'finding an update never downloads by itself');
  assert.equal(up.state.phase, 'available');
  await up.handleAction('download');
  assert.equal(a.downloads, 1);
  await up.handleAction('download'); assert.equal(a.downloads, 1, 'a second click while downloading does nothing');
  a.emit('download-progress', { percent: 50 });
  a.emit('download-progress', { percent: 99.6 });
  await up.check(); assert.equal(a.checks, 3, 'no new check while downloading');
  a.emit('update-downloaded', { version: '0.5.0' });
  assert.deepEqual(seen, ['available', 'downloading0', 'downloading50', 'downloading99', 'ready']);
  assert.equal(up.handleAction('restart'), true);
  assert.equal(restarted, 1); assert.deepEqual(a.installs, [[false, true]]);
});

test('updater wiring: failed download shows a message, retry downloads again, check errors stay silent', async () => {
  const a = fake();
  const up = u.createUpdater({ autoUpdater: a, getHeaders: async () => ({}) });
  a.fail = new Error('net::ERR_INTERNET_DISCONNECTED');
  await up.check();
  assert.equal(up.state.phase, 'idle', 'offline check is silent');
  a.fail = null;
  a.emit('update-available', { version: '0.5.0' });
  a.dlFail = new Error('net::ERR_INTERNET_DISCONNECTED');
  await up.handleAction('download');
  assert.equal(up.state.phase, 'error'); assert.match(up.state.message, /Could not reach the server/);
  assert.equal(up.handleAction('restart'), false);
  a.dlFail = null;
  await up.handleAction('retry');
  assert.equal(a.downloads, 2); assert.equal(up.state.phase, 'downloading');
  a.emit('error', new Error('sha512 checksum mismatch'));
  assert.match(up.state.message, /damaged/); assert.deepEqual(a.installs, []);
});

test('updater wiring: dismissal is saved per version and survives a restart', async () => {
  const a = fake(); const saved = [];
  const up = u.createUpdater({ autoUpdater: a, getHeaders: async () => ({}), onDismiss: v => saved.push(v) });
  a.emit('update-available', { version: '0.5.0' });
  up.handleAction('dismiss');
  assert.deepEqual(saved, ['0.5.0']); assert.equal(u.view(up.state), null);
  const b = fake();
  const again = u.createUpdater({ autoUpdater: b, getHeaders: async () => ({}), dismissed: '0.5.0' });
  b.emit('update-available', { version: '0.5.0' });
  assert.equal(u.view(again.state), null, 'same version stays hidden after a restart');
  b.emit('update-available', { version: '0.5.1' });
  assert.notEqual(u.view(again.state), null, 'the next version shows');
});

test('update card renders with the app theme + accent variables, not fixed colours (#97)', () => {
  const css = u.CARD_CSS;
  for (const v of ['--card', '--ink', '--line', '--body', '--on-body', '--shade', '--danger', '--danger-bg', '--radius']) assert.ok(css.includes(`var(${v}`), v);
  const bodyOf = (sel) => css.split('\n').find(l => l.startsWith(sel));
  assert.match(bodyOf('#desktop-update-banner .act'), /background:var\(--body,/, 'button follows the accent');
  assert.match(bodyOf('#desktop-update-banner .act'), /color:var\(--on-body,/);
  // every colour literal sits inside a var() fallback
  assert.equal(css.replace(/var\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b/g), null, 'no hard-coded colours outside var() fallbacks');
  assert.doesNotThrow(() => new Function(u.bannerScript(u.view({ phase: 'available', version: '1.0.0' }))));
  assert.match(u.bannerScript(u.view({ phase: 'available', version: '1.0.0' })), /companion-update:\/\/dismiss/);
});

test('update card runs in a DOM stand-in: Download button for available, progress for downloading', () => {
  const mk = (tag) => ({ tag, children: [], dataset: {}, classList: { add(c) { this.l = (this.l || []).concat(c); } }, setAttribute() {}, append(...c) { this.children.push(...c); }, remove() { dom.removed.push(this); } });
  const dom = { removed: [], all: [] };
  const doc = { getElementById: () => null, createElement: (t) => { const e = mk(t); dom.all.push(e); return e; }, head: mk('head'), body: mk('body') };
  const render = (v) => new Function('document', 'location', u.bannerScript(v))(doc, {});
  render(u.view({ phase: 'available', version: '0.5.0' }));
  assert.ok(dom.all.some(e => e.tag === 'button' && e.textContent === 'Download' && e.className === 'act'));
  assert.equal(dom.all.some(e => e.tag === 'progress'), false);
  dom.all.length = 0;
  render(u.view({ phase: 'downloading', version: '0.5.0', percent: 42 }));
  assert.ok(dom.all.some(e => e.tag === 'progress' && e.value === 42));
  assert.equal(dom.all.some(e => e.tag === 'button' && e.className === 'act'), false, 'no action while downloading');
});
