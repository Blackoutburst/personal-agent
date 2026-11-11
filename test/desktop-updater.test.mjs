import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const u = require('../desktop/src/updater.js');

const run = (events, start = u.IDLE) => events.reduce(u.reduce, start);

test('update state: available -> downloading n% -> ready (#89)', () => {
  let s = run([{ type: 'available', version: '0.5.0' }]);
  assert.deepEqual(s, { phase: 'available', version: '0.5.0' });
  s = u.reduce(s, { type: 'progress', percent: 12.7 });
  assert.deepEqual(s, { phase: 'downloading', version: '0.5.0', percent: 12 });
  s = u.reduce(s, { type: 'progress', percent: 5 });          // never goes backwards
  assert.equal(s.percent, 12);
  s = u.reduce(s, { type: 'progress', percent: 250 });
  assert.equal(s.percent, 100);
  s = u.reduce(s, { type: 'downloaded', version: '0.5.0' });
  assert.deepEqual(s, { phase: 'ready', version: '0.5.0' });
  assert.equal(u.view(s).action.label, 'Restart to update');
  assert.equal(u.parseAction(u.view(s).action.url), 'restart');
  const d = u.reduce(s, { type: 'dismiss' });
  assert.equal(d.phase, 'ready', 'a finished download stays ready after the bar is dismissed');
  assert.equal(u.view(d), null, 'bar hidden for that version');
  assert.equal(u.view(u.reduce(d, { type: 'available', version: '0.5.0' })), null, 'a re-check of the same version keeps it hidden');
  assert.equal(u.reduce(d, { type: 'dismiss' }), d);
  assert.equal(u.view(u.reduce(u.reduce(u.IDLE, { type: 'available', version: '0.5.1' }), { type: 'available', version: '0.5.1' })).text.includes('0.5.1'), true, 'a newer version shows again');
  assert.equal(u.parseAction(u.bannerScript(u.view(s)).match(/companion-update:\/\/dismiss/)?.[0]), 'dismiss', 'the x goes through the dismiss action');
  const e = u.reduce(d, { type: 'error', message: 'x' });
  assert.equal(e, d, 'error after ready is ignored');
  const hiddenDl = u.reduce(u.reduce(run([{ type: 'available', version: '0.6.0' }]), { type: 'dismiss' }), { type: 'progress', percent: 3 });
  assert.equal(u.view(hiddenDl), null);
  assert.equal(u.view(u.reduce(hiddenDl, { type: 'error', message: 'Could not reach the server.' })).error, true, 'errors still show');
  assert.equal(u.reduce(s, { type: 'error', message: 'x' }), s, 'a late error does not lose a finished download');
  assert.equal(u.reduce(s, { type: 'available', version: '0.5.0' }), s);
});

test('update state: download errors show a message, retry restarts, check errors stay silent', () => {
  assert.equal(u.reduce(u.IDLE, { type: 'error', message: 'offline' }), u.IDLE);
  let s = run([{ type: 'available', version: '0.5.0' }, { type: 'progress', percent: 40 }, { type: 'error', message: 'Could not reach the server.' }]);
  assert.deepEqual(s, { phase: 'error', version: '0.5.0', message: 'Could not reach the server.' });
  const v = u.view(s);
  assert.equal(v.text, 'Could not reach the server.'); assert.equal(v.action.label, 'Try again'); assert.equal(u.parseAction(v.action.url), 'retry');
  s = u.reduce(s, { type: 'retry' });
  assert.equal(s.phase, 'available');
  assert.equal(u.view(u.IDLE), null);
  assert.equal(u.view({ phase: 'downloading', version: '1.0.0', percent: 33 }).percent, 33);
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
  a.checks = 0; a.installs = [];
  a.checkForUpdates = async function () { a.checks++; if (a.fail) throw a.fail; };
  a.quitAndInstall = (...args) => a.installs.push(args);
  return a;
}

test('updater wiring: events drive states, headers are set, restart installs only when ready', async () => {
  const a = fake(), seen = []; let restarted = 0;
  const up = u.createUpdater({ autoUpdater: a, getHeaders: async () => ({ Cookie: 'c=1' }), onState: s => seen.push(s.phase + (s.percent ?? '')), onRestart: () => restarted++ });
  assert.equal(a.autoDownload, true); assert.equal(a.autoInstallOnAppQuit, false);
  await up.check();
  assert.equal(a.checks, 1); assert.deepEqual(a.requestHeaders, { Cookie: 'c=1' });
  assert.equal(up.handleAction('restart'), false, 'nothing to restart into yet');
  a.emit('update-available', { version: '0.5.0' });
  a.emit('download-progress', { percent: 50 });
  a.emit('download-progress', { percent: 99.6 });
  await up.check(); assert.equal(a.checks, 1, 'no new check while downloading');
  a.emit('update-downloaded', { version: '0.5.0' });
  assert.deepEqual(seen, ['available', 'downloading50', 'downloading99', 'ready']);
  assert.equal(up.handleAction('restart'), true);
  assert.equal(restarted, 1); assert.deepEqual(a.installs, [[false, true]]);
});

test('updater wiring: offline during download shows a message, retry checks again and the app stays usable', async () => {
  const a = fake();
  const up = u.createUpdater({ autoUpdater: a, getHeaders: async () => ({}) });
  a.fail = new Error('net::ERR_INTERNET_DISCONNECTED');
  await up.check();
  assert.equal(up.state.phase, 'idle', 'offline check is silent');
  a.fail = null;
  a.emit('update-available', { version: '0.5.0' });
  a.emit('download-progress', { percent: 30 });
  a.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.equal(up.state.phase, 'error'); assert.match(up.state.message, /Could not reach the server/);
  assert.equal(up.handleAction('restart'), false);
  await up.handleAction('retry');
  assert.equal(a.checks, 2); assert.equal(up.state.phase, 'available');
  a.emit('error', new Error('sha512 checksum mismatch'));
  assert.match(up.state.message, /damaged/); assert.deepEqual(a.installs, []);
});
