import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Mail, parseMailConfig, MailError } from '../src/mail.mjs';
import { Studio, StudioError, createStudioHttp } from '../src/studio.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { startServer } from '../server.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), DAY = 86400000;
const issuer = 'https://synthetic.invalid';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
function fixture(t, transport = async () => {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'studio-'))), maildir = join(dir, 'mail');
  for (const name of ['new', 'cur', 'tmp']) mkdirSync(join(maildir, name), { recursive: true });
  const config = parseMailConfig({ address: 'studio@synthetic.invalid', displayName: 'Thomas Studio', maildir,
    signature: 'Thomas\nStudio', smtp: { port: 588, user: 'studio', passwordFile: join(dir, 'not-read'), servername: 'synthetic.invalid' },
    limits: { companies: 30, followUps: 1, perDay: 10 }, studioViewers: ['alice', 'bob'] });
  const owners = [{ issuer, subject: 'a', label: 'alice', provider: 'claude', mail: config },
    { issuer, subject: 'b', label: 'bob', provider: 'claude' }, { issuer, subject: 'c', label: 'charlie', provider: 'claude' }];
  const dataDir = join(dir, 'data'); let store = new BootstrapStore(dataDir, ROOT), now = Date.UTC(2026, 10, 4, 12);
  for (const [i, owner] of owners.entries()) store.getOrInsert('companion-identity-v1', principalKey({ issuer, subject: owner.subject }), { companionId: [A, B, C][i] });
  const makeMail = () => new Mail({ store, configFor: id => id === A ? config : null, now: () => now, readPassword: () => 'synthetic', transport });
  let mail = makeMail(), studio = new Studio({ store, owners, now: () => now }), n = 0;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, owners, get store() { return store; }, get mail() { return mail; }, get studio() { return studio; },
    advance: days => { now += days * DAY; },
    deliver(raw) { const path = join(maildir, 'new', 'synthetic-' + n++); writeFileSync(path, raw); return path; },
    send: input => mail.send(A, { requestId: 'send-' + n++, kind: 'first', to: 'client@acme.example', subject: 'Question', text: '<script>untrusted outgoing</script>', ...input }),
    restart() { store.close(); store = new BootstrapStore(dataDir, ROOT); mail = makeMail(); studio = new Studio({ store, owners, now: () => now }); } };
}

test('actual sent and received bodies survive handled state, deleted Maildir file and restart; view is read-only', async t => {
  const f = fixture(t); await f.send({});
  const path = f.deliver('From: Client <client@acme.example>\r\nSubject: Re: Question\r\n\r\n<img src=x onerror=alert(1)>\r\n');
  const inbound = f.mail.inbox(A).messages[0]; f.mail.markHandled(A, { id: inbound.id }); unlinkSync(path); f.restart();
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  for (const viewer of [A, B]) {
    const list = f.studio.list(viewer); assert.equal(list.contacts.length, 1); assert.equal(list.contacts[0].replied, true);
    assert.equal(list.contacts[0].followUp, 'replied'); assert.equal(list.provenance.missingSent, 0);
    const detail = f.studio.detail(viewer, 'acme.example'); assert.equal(detail.messages.length, 2);
    assert.match(detail.messages.find(m => m.direction === 'sent').text, /-- \nThomas\nStudio/);
    assert.equal(detail.messages.find(m => m.direction === 'received').text, '<img src=x onerror=alert(1)>');
    assert.equal(detail.messages.find(m => m.direction === 'received').handled, true);
    assert.ok(!JSON.stringify(list).includes('synthetic.invalid:588')); assert.ok(!JSON.stringify(detail).includes('not-read'));
  }
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.throws(() => f.studio.list(C), error => error instanceof StudioError && error.status === 403);
  assert.throws(() => f.studio.detail(B, 'other.example'), error => error.status === 404);
});

test('follow-up, refusal, uncertainty, opt-out and legacy metadata are represented without changing send limits', async t => {
  const f = fixture(t); await f.send({}); assert.equal(f.studio.list(B).contacts[0].followUp, 'waiting');
  f.advance(3); assert.equal(f.studio.list(B).contacts[0].followUp, 'eligible');
  await f.send({ kind: 'follow_up' }); assert.equal(f.studio.list(B).contacts[0].followUp, 'used');
  f.mail.optOut(A, { address: 'client@acme.example' }); assert.equal(f.studio.list(B).contacts[0].followUp, 'opted_out');
  f.store.db.prepare("DELETE FROM mail_archive WHERE direction='sent'").run();
  assert.equal(f.studio.list(B).provenance.missingSent, 2); assert.ok(f.studio.detail(B, 'acme.example').messages.every(m => m.text === null));
  const uncertain = fixture(t, async () => { throw Error('synthetic disconnect'); });
  await assert.rejects(uncertain.send({}), error => error instanceof MailError && error.code === 'MAIL_UNCERTAIN');
  assert.equal(uncertain.studio.list(B).contacts[0].followUp, 'uncertain');
  const refused = fixture(t, async () => { throw new MailError('MAIL_REJECTED'); });
  await assert.rejects(refused.send({}), /MAIL_REJECTED/); assert.equal(refused.studio.list(B).contacts[0].sent, 0);
  assert.equal(refused.studio.detail(B, 'acme.example').messages[0].state, 'failed');
});

test('legacy incoming backfill preserves handled/notified flags and never recreates cleared suppression', t => {
  const f = fixture(t); f.deliver('From: a@legacy.example\r\nSubject: STOP\r\n\r\nSTOP');
  const message = f.mail.inbox(A).messages[0]; f.mail.markHandled(A, { id: message.id });
  f.store.db.prepare('DELETE FROM mail_archive').run(); f.store.db.prepare('DELETE FROM mail_suppressed').run();
  const before = f.store.db.prepare('SELECT handled_at,notified,opt_out FROM mail_messages').get();
  f.mail.inbox(A); assert.deepEqual(f.store.db.prepare('SELECT handled_at,notified,opt_out FROM mail_messages').get(), before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mail_suppressed').get().n, 0);
  assert.equal(f.studio.detail(B, 'legacy.example').messages[0].text, 'STOP');
});

test('history pagination is bounded and complete; invalid client-selected scope is refused', async t => {
  const f = fixture(t);
  for (let i = 0; i < 56; i++) f.deliver('From: a@many.example\r\nSubject: Message ' + i + '\r\n\r\nbody ' + i);
  f.mail.inbox(A); const page = f.studio.detail(B, 'many.example'); assert.equal(page.messages.length, 50); assert.equal(page.nextOffset, 50);
  assert.equal(f.studio.list(B).contacts[0].followUps, 0);
  const older = f.studio.detail(B, 'many.example', 50); assert.equal(older.messages.length, 6); assert.equal(older.nextOffset, null);
  assert.equal(new Set([...page.messages, ...older.messages].map(m => m.id)).size, 56);
  for (const value of [-1, 1.5, '1', 1_000_001]) assert.throws(() => f.studio.detail(B, 'many.example', value), /INVALID_REQUEST/);
  const http = createStudioHttp({ access: { read: async () => ({ value: { action: 'list', companionId: A } }), authorize: async () => ({ companionId: B }) }, studio: f.studio });
  assert.equal((await http({})).status, 400);
});

test('viewer configuration is explicit, validates owner labels, and cannot select two mailboxes', t => {
  const f = fixture(t), raw = { ...f.config, studioViewers: ['alice', 'missing'] };
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ ...f.owners[0], mail: raw }] })), /Studio viewers/);
  assert.throws(() => parseMailConfig({ ...f.config, studioViewers: ['alice', 'alice'] }));
  assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ ...f.owners[0], mail: { ...f.config, studioViewers: ['bob'] } },
    { ...f.owners[1], mail: { ...f.config, studioViewers: ['bob'] } }] })), /Studio viewers/);
  const privateOwner = { ...f.owners[0], mail: parseMailConfig({ ...f.config, studioViewers: [] }) };
  assert.throws(() => new Studio({ store: f.store, owners: [privateOwner] }).list(A), /STUDIO_FORBIDDEN/);
});

test('real HTTP transport revalidates platform sessions and denies anonymous, foreign, cross-origin and write requests', async t => {
  const f = fixture(t), runtimeFile = join(f.dir, 'owners.json'); writeFileSync(runtimeFile, JSON.stringify({ owners: f.owners }));
  // Existing synthetic store is reused; no model binary or real SMTP is invoked.
  let valid = true;
  const tokens = ['A', 'B', 'C'].map(c => c.repeat(43));
  const app = await startServer({ dataDir: join(f.dir, 'http-data'), port: 0, mode: 'account',
    pilotSubjects: f.owners.map(({ issuer, subject }) => ({ issuer, subject })), runtimeFile, runtimeDir: join(f.dir, 'runtime'),
    binaries: { claude: '/nonexistent/synthetic', codex: '/nonexistent/synthetic' },
    validateAccount: async token => valid && tokens.includes(token) ? { issuer, subject: ['a', 'b', 'c'][tokens.indexOf(token)] } : null,
    discordOptions: { connect: false }, boardOptions: { poll: false }, mailOptions: { transport: async () => { throw Error('No sends allowed'); } } });
  t.after(() => app.close());
  const call = async (action, token, extra = {}, origin = app.url) => {
    const r = await fetch(app.url + '/api/studio', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}) }, body: JSON.stringify({ action, ...extra }) });
    return { status: r.status, body: await r.json() };
  };
  // Provision source identity via access first; then both explicitly allowed owners can read.
  assert.equal((await call('access', tokens[0])).status, 200);
  assert.equal((await call('list', tokens[1])).status, 200);
  assert.equal((await call('list', tokens[2])).status, 403);
  assert.equal((await call('list', null)).status, 401);
  assert.equal((await call('list', tokens[1], {}, 'https://foreign.invalid')).status, 403);
  assert.equal((await call('list', tokens[1], { companionId: A })).status, 400);
  for (const action of ['send', 'optOut', 'handled']) assert.equal((await call(action, tokens[1])).status, 400);
  valid = false; assert.equal((await call('list', tokens[1])).status, 401);
  assert.equal((await fetch(app.url + '/studio-ui.mjs')).status, 200);
});
