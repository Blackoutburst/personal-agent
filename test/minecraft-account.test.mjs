import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

// The Minecraft connector wired into account mode (#68) with a fake provider program and a fake game connection:
// no model, no Minecraft server.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER = 'https://synthetic.invalid', PA = { issuer: ISSUER, subject: 'synthetic-owner-a' }, PB = { issuer: ISSUER, subject: 'synthetic-owner-b' }, PC = { issuer: ISSUER, subject: 'synthetic-owner-c' };
const A = 'A'.repeat(43), B = 'B'.repeat(43), C = 'C'.repeat(43), COOKIE = value => `__Secure-blackout_session=${value}`;
const wait = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('a game turn runs in the companion workspace with file tools only, and its owner sees and switches the connector', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'minecraft-account-')));
  const file = join(dir, 'fake-claude.cjs');
  writeFileSync(file, readFileSync(join(ROOT, 'test/fixtures/fake-claude.cjs.txt'), 'utf8')); chmodSync(file, 0o755);
  const runtimeFile = join(dir, 'owners.json'), runtimeDir = join(dir, 'runtimes');
  writeFileSync(runtimeFile, JSON.stringify({ owners: [
    { subject: PA.subject, issuer: ISSUER, label: 'blackout', provider: 'claude', minecraft: { username: 'SentientToaster' } },
    { subject: PB.subject, issuer: ISSUER, label: 'screamer', provider: 'claude' },
    { subject: PC.subject, issuer: ISSUER, label: 'third', provider: 'claude', minecraft: { auth: 'microsoft' } }] }));
  const conns = []; let skew = 0;
  const connect = (config, handlers) => { const conn = { config, handlers, acts: [], quits: 0 }; conns.push(conn);
    return { perceive: async () => ({ spawned: true, position: { x: 1, y: 64, z: 2 } }), act: async action => { conn.acts.push(action); return { type: action.type, ok: true, detail: 'ok' }; },
      quit: async () => { conn.quits++; } }; };
  const app = await startServer({ dataDir: join(dir, 'data'), port: 0, mode: 'account', pilotSubjects: [PA, PB, PC],
    validateAccount: async proof => ({ [A]: PA, [B]: PB, [C]: PC })[proof] ?? null, runtimeFile, runtimeDir, binaries: { claude: file },
    runnerOptions: { statusTtlMs: 0 }, minecraftOptions: { connect, tickMs: 25, now: () => Date.now() + skew } });
  t.after(async () => { if (app.server.listening) await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const api = async (proof, body, path = '/api/companion') => (await fetch(app.url + path, { method: 'POST',
    headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(proof) }, body: JSON.stringify(body) })).json();
  for (const proof of [A, B, C]) await api(proof, {}, '/api/session');
  writeFileSync(join(runtimeDir, 'blackout', 'claude-home', 'signed-in'), '');
  app.minecraft.start(); // pick up the companion id provisioned by the sign-in (otherwise within a minute)
  assert.equal(conns.length, 2, 'only the configured companions play');
  assert.equal(conns[0].config.username, 'SentientToaster'); assert.equal(conns[0].config.auth, 'offline'); assert.equal(conns[0].config.port, 25566); assert.equal(conns[0].config.host, '127.0.0.1');
  const minecraftCard = async proof => (await api(proof, { action: 'connectors' })).connectors.find(item => item.id === 'minecraft');
  assert.equal(await minecraftCard(B), undefined);
  assert.equal((await minecraftCard(A)).state, 'pending');
  // Online mode (#68): the third owner's companion signs in with Microsoft; its folder lives under the data dir, 0700.
  const msa = conns[1], authDir = join(dir, 'data', 'minecraft-auth');
  assert.equal(msa.config.auth, 'microsoft'); assert.equal(msa.config.profilesFolder.startsWith(authDir + '/'), true);
  assert.equal(statSync(authDir).mode & 0o777, 0o700); assert.equal(statSync(msa.config.profilesFolder).mode & 0o777, 0o700);
  msa.handlers.onState('signin', { code: 'WXYZ-9876', url: 'https://www.microsoft.com/link', expiresAt: Date.now() + 600_000 });
  assert.equal((await minecraftCard(C)).detail, 'Sign in to Minecraft: open https://www.microsoft.com/link and enter WXYZ-9876');
  assert.doesNotMatch(JSON.stringify(await api(A, { action: 'connectors' })), /WXYZ-9876/, 'only its owner sees the code');
  const refused = await fetch(app.url + '/api/companion', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: COOKIE(A) },
    body: JSON.stringify({ action: 'minecraftSignOut' }) });
  assert.equal(refused.status, 409, 'offline mode has nothing to sign out of');
  writeFileSync(join(msa.config.profilesFolder, '0123456789ab_live-cache.json'), '{}', { mode: 0o600 });
  const out = await api(C, { action: 'minecraftSignOut' });
  assert.equal(out.connectors.find(item => item.id === 'minecraft').id, 'minecraft'); assert.deepEqual(readdirSync(msa.config.profilesFolder), []);
  conns[0].handlers.onState('online', 'SentientToaster');
  conns[0].handlers.onEvent({ type: 'players', names: ['Blackout'] });
  conns[0].handlers.onEvent({ type: 'join', name: 'Blackout' });
  assert.equal((await minecraftCard(A)).state, 'connected');
  // The first turn waits for the 25 s spacing from the agent's start: move the connector's clock on.
  const calls = () => existsSync(join(runtimeDir, 'blackout', 'claude-home', 'calls.jsonl'))
    ? readFileSync(join(runtimeDir, 'blackout', 'claude-home', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  skew = 60_000;
  await wait(() => calls().some(call => call.prompt.includes('Minecraft game turn')));
  const call = calls().find(value => value.prompt.includes('Minecraft game turn'));
  assert.equal(call.cwd, join(runtimeDir, 'blackout', 'workspace'), 'the turn runs in the companion\'s own workspace');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep', 'file tools only: no web');
  assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--mcp-config') + 1]), { mcpServers: {} }, 'no Board, scheduler, mail or file-send tools');
  assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /## Minecraft/);
  assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /<MEMORY\.md>/, 'its memory files, like a chat turn');
  assert.match(call.prompt, /Blackout joined/);
  // Owner switch: off stops the bot.
  const off = await api(A, { action: 'setConnector', id: 'minecraft', enabled: false });
  assert.equal(off.connectors.find(item => item.id === 'minecraft').state, 'paused');
  await wait(() => conns[0].quits === 1);
  await app.close();
});
