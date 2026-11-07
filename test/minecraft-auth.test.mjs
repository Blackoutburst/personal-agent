import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, symlinkSync, mkdirSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BootstrapStore } from '../src/store.mjs';
import { parseMinecraftConfig, reconnectDelay, MinecraftAgent, MinecraftConnector, workerConnect } from '../src/minecraft.mjs';
import { profilesFolderFor, createAuthCache, wipeProfilesFolder, hasSavedAccount, signInView, checkedSignIn, safeReason, signInFailure } from '../src/minecraft-auth.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import { Connectors } from '../src/connectors.mjs';

// Minecraft online mode (#68): Microsoft sign-in through prismarine-auth's device code. Everything here uses fakes: no
// network, no Microsoft, no Minecraft server. The fake "tokens" below are placeholders that must never show up anywhere.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_TOKEN = 'FAKE-ACCESS-TOKEN-never-shown', FAKE_REFRESH = 'FAKE-REFRESH-TOKEN-never-shown', FAKE_DEVICE = 'FAKE-DEVICE-CODE-never-shown';
const TOKENISH = /token|refresh|xbl|device_?code|FAKE-/i;
const clock = (start = 1_000_000) => { const c = { t: start, now: () => c.t, advance: ms => { c.t += ms; } }; return c; };
const mode = path => statSync(path).mode & 0o777;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeConnection() {
  const conn = { configs: [], quits: 0, handlers: null, opened: 0,
    connect(cfg, handlers) { conn.config = cfg; conn.configs.push(cfg); conn.handlers = handlers; conn.opened++;
      return { perceive: async () => ({ spawned: true }), act: async action => ({ type: action.type, ok: true, detail: 'done' }), quit: async () => { conn.quits++; } }; } };
  return conn;
}
// What the worker would post after prismarine-auth's onMsaCode: the view only (signInView drops everything else).
const deviceResponse = (now, extra = {}) => ({ user_code: 'ABCD-1234', device_code: FAKE_DEVICE, verification_uri: 'https://www.microsoft.com/link',
  expires_in: 900, interval: 5, message: `use the code ABCD-1234 ${FAKE_DEVICE}`, access_token: FAKE_TOKEN, ...extra });

// ---------- Configuration ----------

test('auth is "offline" by default or "microsoft"; the username is optional only with microsoft', () => {
  assert.equal(parseMinecraftConfig({ username: 'SentientToaster' }).auth, 'offline');
  const online = parseMinecraftConfig({ auth: 'microsoft' });
  assert.equal(online.auth, 'microsoft'); assert.equal(online.username, null);
  assert.equal(parseMinecraftConfig({ auth: 'microsoft', username: 'SentientToaster' }).username, 'SentientToaster', 'a label and cache key');
  for (const bad of [{ auth: 'offline' }, {}, { auth: 'mojang', username: 'SentientToaster' }, { auth: true, username: 'SentientToaster' },
    { auth: 'microsoft', username: 'bad name' }, { auth: 'microsoft', username: '' }, { auth: 'Microsoft' }]) assert.throws(() => parseMinecraftConfig(bad), /Invalid minecraft/, JSON.stringify(bad));
  const owners = parseRuntimeConfig(JSON.stringify({ owners: [
    { subject: 'a', label: 'blackout', provider: 'claude', minecraft: { auth: 'microsoft' } },
    { subject: 'b', label: 'screamer', provider: 'codex', minecraft: { auth: 'microsoft' } }] }), {});
  assert.deepEqual(owners.map(owner => [owner.minecraft.auth, owner.minecraft.username]), [['microsoft', null], ['microsoft', null]], 'two nameless accounts are fine');
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ subject: 'a', label: 'a', provider: 'claude', minecraft: { auth: 'offline' } }] }), {}), /Invalid minecraft/);
});

// ---------- Reconnect policy ----------

test('online-mode kicks keep the 30-minute wait; sign-in problems back off from a minute to 30 minutes', () => {
  const none = () => 0;
  for (const reason of ['kicked: You are not whitelisted on this server!', 'kicked: Failed to verify username!', 'kicked: You logged in from another location'])
    assert.equal(reconnectDelay(0, reason, none), 30 * 60_000, reason);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(attempt => reconnectDelay(attempt, 'sign-in code expired', none)),
    [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000], 'never a tight loop of new codes');
  assert.equal(reconnectDelay(0, 'sign-in failed', none), 60_000);
  assert.ok(reconnectDelay(0, 'sign-in failed', () => 0.999) <= 75_000);
  assert.equal(reconnectDelay(0, 'socket closed', none), 5000, 'other reasons keep the short backoff');
});

// ---------- The profiles folder ----------

test('the profiles folder is 0700, cache files are 0600, written atomically and never through a link', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-auth-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'minecraft-auth'), id = randomUUID();
  mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755);
  const folder = profilesFolderFor(root, id);
  assert.equal(folder, join(root, id)); assert.equal(mode(root), 0o700, 'a looser root is tightened'); assert.equal(mode(folder), 0o700);
  assert.throws(() => profilesFolderFor(root, '../escape')); assert.throws(() => profilesFolderFor(root, ''));
  symlinkSync(dir, join(root, 'linked')); assert.throws(() => profilesFolderFor(root, 'linked'), /not a directory/);
  assert.equal(hasSavedAccount(folder), false);
  const factory = createAuthCache(folder);
  const live = factory({ cacheName: 'live', username: 'SentientToaster' }), mca = factory({ cacheName: 'mca', username: 'SentientToaster' });
  assert.throws(() => factory({ cacheName: '../x', username: 'a' }), /Unknown/);
  assert.deepEqual(await live.getCached(), {}, 'nothing cached yet');
  assert.deepEqual(readdirSync(folder), [], 'reading writes nothing');
  await live.setCachedPartial({ token: { access_token: FAKE_TOKEN, refresh_token: FAKE_REFRESH } });
  await mca.setCached({ mca: { access_token: FAKE_TOKEN } });
  const files = readdirSync(folder).sort();
  assert.equal(files.length, 2); assert.ok(files.every(name => /^[0-9a-f]{12}_(live|mca)-cache\.json$/.test(name)), 'no temp files left');
  for (const name of files) assert.equal(mode(join(folder, name)), 0o600, name);
  assert.equal(hasSavedAccount(folder), true);
  assert.deepEqual((await createAuthCache(folder)({ cacheName: 'live', username: 'SentientToaster' }).getCached()).token.refresh_token, FAKE_REFRESH, 'read back by a new worker');
  // After a refused session the derived tokens go; the Microsoft refresh token stays.
  const again = createAuthCache(folder, { dropDerived: true });
  assert.deepEqual(await again({ cacheName: 'mca', username: 'SentientToaster' }).getCached(), {});
  assert.ok((await again({ cacheName: 'live', username: 'SentientToaster' }).getCached()).token);
  // A link planted at a cache path is not followed when read.
  const outside = join(dir, 'outside.json'); writeFileSync(outside, JSON.stringify({ planted: true }));
  const xbl = files[0].replace(/_(live|mca)-/, '_xbl-'); symlinkSync(outside, join(folder, xbl));
  assert.deepEqual(await createAuthCache(folder)({ cacheName: 'xbl', username: 'SentientToaster' }).getCached(), {});
});

test('sign-out wipes the folder contents and keeps the private folder', t => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-wipe-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = profilesFolderFor(join(dir, 'auth'), 'c1');
  writeFileSync(join(folder, '000000000000_live-cache.json'), '{}', { mode: 0o600 }); mkdirSync(join(folder, 'nested')); writeFileSync(join(folder, 'nested', 'x'), 'x');
  assert.equal(wipeProfilesFolder(folder), 2);
  assert.deepEqual(readdirSync(folder), []); assert.equal(mode(folder), 0o700);
  assert.equal(wipeProfilesFolder(join(dir, 'missing')), 0);
});

// ---------- What the owner sees ----------

test('the device code view carries only the user code, the URL and the expiry', () => {
  const view = signInView(deviceResponse(0), 1000);
  assert.deepEqual(view, { code: 'ABCD-1234', url: 'https://www.microsoft.com/link', expiresAt: 901_000 });
  assert.equal(signInView(deviceResponse(0, { verification_uri: 'https://evil.example/link' }), 0).url, 'https://www.microsoft.com/link', 'only Microsoft links');
  assert.equal(signInView(deviceResponse(0, { verification_uri: 'http://www.microsoft.com/link' }), 0).url, 'https://www.microsoft.com/link');
  assert.equal(signInView({ user_code: '<script>' }), null); assert.equal(signInView(null), null);
  assert.equal(signInView(deviceResponse(0, { expires_in: 99_999 }), 0).expiresAt, 3600_000, 'expiry bounded');
  assert.deepEqual(checkedSignIn({ ...view, accessToken: FAKE_TOKEN }, 1000), view, 'the receiving side drops extra fields');
  assert.equal(checkedSignIn({ ...view, expiresAt: 500 }, 1000), null, 'an expired code is not shown');
  assert.doesNotMatch(safeReason(`kicked: bad ${'a'.repeat(40)} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc`), /aaaaaaaa|eyJ/);
  assert.equal(signInFailure(new Error('Authentication failed, timed out')), 'sign-in code expired');
  assert.equal(signInFailure(new Error(`Failed to acquire authorization code (${FAKE_TOKEN})`)), 'sign-in failed', 'library messages never pass');
});

test('the worker connection forwards a sign-in as code, URL and expiry only', async () => {
  const states = [];
  class SignInWorker extends EventEmitter {
    constructor(url, options) { super(); SignInWorker.data = options.workerData;
      queueMicrotask(() => {
        this.emit('message', { op: 'state', state: 'signin', signIn: { code: 'ABCD-1234', url: 'https://www.microsoft.com/link', expiresAt: Date.now() + 900_000, device_code: FAKE_DEVICE, access_token: FAKE_TOKEN } });
        this.emit('message', { op: 'state', state: 'signin', signIn: { code: 'x', url: 'javascript:alert(1)', expiresAt: 1 } });
        this.emit('message', { op: 'state', state: 'signedin', username: 'RealToaster' });
      }); }
    postMessage() {} async terminate() {}
  }
  workerConnect({ auth: 'microsoft', host: '127.0.0.1', port: 1, username: null, profilesFolder: '/data/minecraft-auth/c1', cacheKey: 'blackout' },
    { onEvent: () => {}, onState: (...state) => states.push(state) }, { WorkerImpl: SignInWorker });
  await tick();
  assert.equal(states.length, 2, 'the malformed sign-in is dropped');
  assert.deepEqual(Object.keys(states[0][1]).sort(), ['code', 'expiresAt', 'url']);
  assert.deepEqual(states[1], ['signedin', 'RealToaster'], 'the account name, nothing of the session');
  assert.deepEqual([SignInWorker.data.auth, SignInWorker.data.profilesFolder, SignInWorker.data.cacheKey, SignInWorker.data.refreshTokens], ['microsoft', '/data/minecraft-auth/c1', 'blackout', false]);
});

test('an agent shows the code only while the sign-in is pending, logs no code and backs off between codes', async t => {
  const c = clock(), conn = fakeConnection(), logs = [], timers = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { if (ms >= 5000) { timers.push({ fn, ms }); return { unref() {} }; } return realSetTimeout(fn, ms); });
  const names = [];
  const agent = new MinecraftAgent({ config: parseMinecraftConfig({ auth: 'microsoft' }), connect: conn.connect, now: c.now, tickMs: 60_000, random: () => 0,
    turn: async () => '{}', log: line => logs.push(line), label: "blackout's companion", onName: name => names.push(name) });
  agent.start();
  assert.equal(agent.status().signIn, undefined); assert.equal(agent.status().username, null);
  conn.handlers.onState('signin', signInView(deviceResponse(0), c.now()));
  assert.equal(agent.status().state, 'signin');
  assert.deepEqual(agent.status().signIn, { code: 'ABCD-1234', url: 'https://www.microsoft.com/link', expiresAt: c.now() + 900_000 });
  assert.doesNotMatch(JSON.stringify(agent.status()), TOKENISH);
  c.advance(901_000); assert.equal(agent.status().signIn, undefined, 'an expired code is no longer shown');
  // The code expired: a new connection (and code) after a minute, then two, never at once.
  conn.handlers.onState('ended', 'sign-in code expired');
  assert.equal(agent.status().signIn, undefined); assert.equal(agent.status().problem, 'sign-in code expired');
  assert.equal(timers.at(-1).ms, 60_000); timers.at(-1).fn(); assert.equal(conn.opened, 2);
  conn.handlers.onState('signin', signInView(deviceResponse(0), c.now()));
  conn.handlers.onState('ended', 'sign-in failed'); assert.equal(timers.at(-1).ms, 120_000, 'backs off');
  timers.at(-1).fn();
  conn.handlers.onState('signin', signInView(deviceResponse(0), c.now()));
  conn.handlers.onState('signedin', 'RealAccountName'); assert.equal(agent.status().signIn, undefined); assert.equal(agent.status().state, 'connecting');
  assert.equal(agent.status().username, 'RealAccountName', 'the in-game name comes from the account, even before the server lets it in');
  conn.handlers.onState('online', 'RealAccountName'); assert.deepEqual(names, ['RealAccountName', 'RealAccountName']);
  // Mojang refused the session: the next connection fetches the derived tokens again, once.
  conn.handlers.onState('ended', 'session rejected'); timers.at(-1).fn();
  assert.equal(conn.config.refreshTokens, true);
  conn.handlers.onState('ended', 'kicked: Failed to verify username!'); assert.equal(timers.at(-1).ms, 30 * 60_000);
  timers.at(-1).fn(); assert.equal(conn.config.refreshTokens, true);
  conn.handlers.onState('ended', 'socket closed'); timers.at(-1).fn(); assert.equal(conn.config.refreshTokens, undefined);
  assert.ok(logs.some(line => /needs a Microsoft sign-in/.test(line)));
  assert.ok(logs.every(line => !line.includes('ABCD-1234') && !TOKENISH.test(line)), 'the journal never gets the code or a token');
  await agent.stop();
});

test('the connector keeps one sign-in folder per companion, shows the code to its owner only, and signs out', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-msa-')), store = new BootstrapStore(join(dir, 'data'), ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const A = randomUUID(), B = randomUUID(), C = randomUUID(), c = clock(), conns = new Map(), logs = [];
  const owners = parseRuntimeConfig(JSON.stringify({ owners: [
    { subject: 'a', label: 'blackout', provider: 'claude', minecraft: { auth: 'microsoft' } },
    { subject: 'b', label: 'screamer', provider: 'codex', minecraft: { auth: 'microsoft', username: 'CirnoLabel' } },
    { subject: 'c', label: 'old', provider: 'claude', minecraft: { username: 'OfflineBot' } }] }), {});
  const ids = { blackout: A, screamer: B, old: C }, authDir = join(dir, 'data', 'minecraft-auth');
  let connectors;
  const minecraft = new MinecraftConnector({ store, owners, companionIdFor: owner => ids[owner.label], now: c.now, tickMs: 60_000, authDir, log: line => logs.push(line),
    active: id => connectors.minecraftOn(id),
    connect: (cfg, handlers) => { const fake = conns.get(cfg.cacheKey ?? cfg.username) ?? fakeConnection(); conns.set(cfg.cacheKey ?? cfg.username, fake); return fake.connect(cfg, handlers); },
    runTurn: async () => ({ text: '{}' }) });
  connectors = new Connectors({ store, minecraft: () => minecraft });
  minecraft.start(); t.after(() => minecraft.stop());
  const a = conns.get('blackout'), b = conns.get('CirnoLabel'), offline = conns.get('OfflineBot');
  assert.deepEqual([a.config.auth, a.config.profilesFolder, a.config.cacheKey], ['microsoft', join(authDir, A), 'blackout'], 'no name: the owner label is the cache key');
  assert.deepEqual([b.config.profilesFolder, b.config.cacheKey], [join(authDir, B), 'CirnoLabel']);
  assert.equal(offline.config.profilesFolder, undefined, 'offline mode has no sign-in folder');
  assert.equal(mode(authDir), 0o700); assert.equal(mode(join(authDir, A)), 0o700); assert.equal(existsSync(join(authDir, C)), false);
  const card = id => connectors.list(id).connectors.find(item => item.id === 'minecraft');
  a.handlers.onState('signin', signInView(deviceResponse(0), c.now()));
  const pending = card(A);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.detail, 'Sign in to Minecraft: open https://www.microsoft.com/link and enter ABCD-1234');
  assert.deepEqual(pending.signIn, { code: 'ABCD-1234', url: 'https://www.microsoft.com/link', expiresAt: c.now() + 900_000 });
  assert.match(pending.purpose, /as my own Minecraft account/);
  assert.deepEqual(pending.actions, ['disconnect'], 'nothing to sign out of yet');
  for (const other of [B, C]) assert.doesNotMatch(JSON.stringify(connectors.list(other)), /ABCD-1234|microsoft\.com\/link/, 'other owners never see the code');
  assert.doesNotMatch(JSON.stringify([connectors.list(A), minecraft.status(A)]), TOKENISH, 'no token fields in the card or the status');
  // Switched off: the code is not shown.
  connectors.set(A, 'minecraft', false); assert.equal(card(A).signIn, undefined); assert.doesNotMatch(card(A).detail, /ABCD/);
  connectors.set(A, 'minecraft', true); await minecraft.tick();
  // The owner signs in: the worker writes the tokens (fakes here), the bot joins under the account's name.
  const folder = join(authDir, A), cache = createAuthCache(folder)({ cacheName: 'live', username: 'blackout' });
  await cache.setCached({ token: { access_token: FAKE_TOKEN, refresh_token: FAKE_REFRESH } });
  a.handlers.onState('signedin', null); a.handlers.onState('online', 'RealToaster');
  const online = card(A);
  assert.equal(online.state, 'connected'); assert.equal(online.signIn, undefined); assert.match(online.purpose, /as RealToaster/);
  assert.deepEqual(online.actions, ['disconnect', 'signout']);
  assert.doesNotMatch(JSON.stringify([connectors.list(A), minecraft.status(A)]), TOKENISH);
  assert.ok(readdirSync(folder).every(name => mode(join(folder, name)) === 0o600));
  // The learnt name counts as a companion for the others (not as a person to play with).
  b.handlers.onState('online', 'RealCirno'); b.handlers.onEvent({ type: 'players', names: ['RealToaster'] });
  assert.equal(minecraft.status(B).people, 0);
  assert.ok(b.configs.at(-1).companions.includes('OfflineBot'));
  // Sign out: the bot quits, the folder is emptied (and stays 0700), a fresh agent asks for a new code.
  const opened = a.opened, quits = a.quits;
  const after = await connectors.minecraftSignOut(A);
  assert.equal(a.quits, quits + 1); assert.deepEqual(readdirSync(folder), []); assert.equal(mode(folder), 0o700);
  assert.equal(a.opened, opened + 1, 'a new connection starts the sign-in again');
  const signedOut = after.connectors.find(item => item.id === 'minecraft');
  assert.deepEqual(signedOut.actions, ['disconnect']); assert.match(signedOut.purpose, /my own Minecraft account/, 'the account name is forgotten');
  await assert.rejects(connectors.minecraftSignOut(C), /CONNECTOR_UNAVAILABLE/, 'offline mode has no sign-in');
  await assert.rejects(connectors.minecraftSignOut(randomUUID()), /CONNECTOR_UNAVAILABLE/);
  assert.ok(logs.every(line => !line.includes('ABCD-1234') && !TOKENISH.test(line)));
});

test('the cache factory fits prismarine-auth without any network (skipped without packages)', async t => {
  let Authflow;
  try { ({ Authflow } = (await import('../src/deps.mjs')).loadPackage('prismarine-auth')); }
  catch (error) { if (error.code === 'DEPENDENCY_MISSING' || error.code === 'MODULE_NOT_FOUND') return t.skip('npm packages are not installed'); throw error; }
  const dir = mkdtempSync(join(tmpdir(), 'mc-prismarine-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = profilesFolderFor(dir, 'c1');
  const flow = new Authflow('blackout', createAuthCache(folder), { flow: 'live', authTitle: '00000000441cc96b', deviceType: 'Nintendo' }, () => {});
  assert.equal(await flow.msa.verifyTokens(), false, 'no cached sign-in: a device code would be asked for');
  assert.deepEqual(readdirSync(folder), [], 'nothing written without a sign-in');
  assert.equal(lstatSync(folder).isDirectory(), true);
});
