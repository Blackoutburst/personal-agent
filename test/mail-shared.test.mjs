// #64: two companions on one mailbox share one state (limits, contacted companies, opt-outs, handled mail, one reply per email).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Mail, MailError, mailOperation, parseMailConfig } from '../src/mail.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';
import { Studio } from '../src/studio.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { startServer } from '../server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const issuer = 'https://synthetic.invalid';
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof MailError && error.code === code);

function mailBlock(dir, extra = {}) {
  return { address: 'studio@synthetic.invalid', displayName: 'Studio', maildir: join(dir, 'Maildir'), signature: 'Studio',
    smtp: { port: 588, user: 'studio', passwordFile: join(dir, 'not-read'), servername: 'synthetic.invalid' },
    limits: { companies: 3, followUps: 1, perDay: 3 }, ...extra };
}

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mail-shared-')));
  for (const folder of ['new', 'cur', 'tmp']) mkdirSync(join(dir, 'Maildir', folder), { recursive: true });
  const config = parseMailConfig(mailBlock(dir));
  const store = new BootstrapStore(join(dir, 'data'), ROOT), sent = [];
  const mail = new Mail({ store, configFor: id => [A, B].includes(id) ? config : null, mailboxFor: () => A,
    now: () => Date.UTC(2026, 10, 5, 12), readPassword: () => 'synthetic', transport: async message => { sent.push(message); } });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const deliver = raw => writeFileSync(join(dir, 'Maildir', 'new', `${1793900000 + n++}.V1I1M1.test`), raw);
  const send = (who, input) => mail.send(who, { requestId: `r-${n++}`, subject: 'Question', text: 'Bonjour.', ...input });
  return { dir, store, mail, sent, deliver, send, config };
}

test('both companions share the daily cap and the contacted companies', async t => {
  const f = fixture(t);
  await f.send(A, { kind: 'first', to: 'ceo@alpha.example' });
  await rejects(f.send(B, { kind: 'first', to: 'sales@alpha.example' }), 'MAIL_ALREADY_CONTACTED');
  await f.send(B, { kind: 'first', to: 'ceo@beta.example' });
  const status = f.mail.status(B);
  assert.equal(status.companies, 2); assert.equal(status.sentLast24h, 2);
  assert.deepEqual(status.contacted.map(row => row.company).sort(), ['alpha.example', 'beta.example']);
  assert.deepEqual(f.mail.status(A).contacted, status.contacted);
  await f.send(A, { kind: 'first', to: 'ceo@gamma.example' });
  await rejects(f.send(B, { kind: 'first', to: 'ceo@delta.example' }), 'MAIL_DAILY_LIMIT');
  // Everything is kept under the canonical companion id; the other companion's requestIds are prefixed.
  const rows = f.store.db.prepare('SELECT companion_id, request_id FROM mail_sent ORDER BY created_at, request_id').all();
  assert.ok(rows.every(row => row.companion_id === A));
  assert.ok(rows.some(row => row.request_id.startsWith(B + ':')));
});

test('the same requestId chosen by both companions does not collide', async t => {
  const f = fixture(t);
  await f.mail.send(A, { requestId: 'same', kind: 'first', to: 'ceo@alpha.example', subject: 'Q', text: 'A' });
  const other = await f.mail.send(B, { requestId: 'same', kind: 'first', to: 'ceo@beta.example', subject: 'Q', text: 'B' });
  assert.equal(other.sent, true); assert.equal(other.replayed, undefined); assert.equal(f.sent.length, 2);
});

test('an opt-out recorded by one companion blocks the other', async t => {
  const f = fixture(t);
  f.mail.optOut(B, { address: 'boss@alpha.example' });
  await rejects(f.send(A, { kind: 'first', to: 'other@alpha.example' }), 'MAIL_OPTED_OUT');
  f.deliver('From: x@beta.example\r\nSubject: STOP\r\n\r\nstop\r\n');
  f.mail.inbox(A);
  await rejects(f.send(B, { kind: 'first', to: 'y@beta.example' }), 'MAIL_OPTED_OUT');
  assert.equal(f.mail.status(B).optedOut, 4);
});

test('mail handled by one companion leaves the other\'s unhandled inbox, ids are the same for both', async t => {
  const f = fixture(t);
  f.deliver('From: Client <client@acme.example>\r\nSubject: Question\r\n\r\nUne question.\r\n');
  const [fromA] = f.mail.inbox(A).messages, [fromB] = f.mail.inbox(B).messages;
  assert.equal(fromA.id, fromB.id);
  assert.equal(f.mail.read(B, { id: fromA.id }).text, 'Une question.');
  f.mail.markHandled(B, { id: fromA.id });
  assert.deepEqual(f.mail.inbox(A).messages, []);
  assert.equal(f.mail.inbox(A, { all: true }).messages[0].handled, true);
  assert.equal(f.mail.status(A).unhandled, 0);
});

test('each companion gets one notice per new mail, and none once it was handled', async t => {
  const f = fixture(t);
  f.deliver('From: one@acme.example\r\nSubject: One\r\n\r\nUn.\r\n');
  for (const who of [A, B]) {
    const notice = f.mail.newMailNotice(who);
    assert.equal(notice.ids.length, 1, who);
    f.mail.notified(who, notice.ids);
    assert.equal(f.mail.newMailNotice(who), null, who);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mail_notices WHERE companion_id=? AND mailbox=?').get(B, A).n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM mail_notices WHERE companion_id=?').get(A).n, 0, 'the canonical one uses the notified column');
  f.deliver('From: two@beta.example\r\nSubject: Two\r\n\r\nDeux.\r\n');
  const fresh = f.mail.newMailNotice(A); f.mail.notified(A, fresh.ids);
  f.mail.markHandled(A, { id: fresh.ids[0] });
  assert.equal(f.mail.newMailNotice(B), null, 'already handled by the other companion');
  f.deliver('From: three@gamma.example\r\nSubject: Three\r\n\r\nTrois.\r\n');
  const third = f.mail.newMailNotice(B); f.mail.markHandled(B, { id: third.ids[0] });
  assert.equal(f.mail.newMailNotice(A), null);
});

test('one reply per received email; replaying the same requestId still works', async t => {
  const f = fixture(t);
  f.deliver('From: Client <client@acme.example>\r\nSubject: Question\r\nMessage-ID: <q@acme.example>\r\n\r\nQuel délai ?\r\n');
  const [message] = f.mail.inbox(A).messages;
  const reply = { requestId: 'answer-1', kind: 'reply', replyTo: message.id, subject: 'Question', text: 'Deux semaines.' };
  assert.equal((await f.mail.send(A, reply)).sent, true);
  assert.equal((await f.mail.send(A, reply)).replayed, true);
  await rejects(f.mail.send(B, { ...reply, text: 'Trois semaines.' }), 'MAIL_ALREADY_REPLIED');
  await rejects(f.mail.send(A, { ...reply, requestId: 'answer-2' }), 'MAIL_ALREADY_REPLIED');
  assert.equal(f.sent.length, 1);
  const refused = await mailOperation(f.mail, B, { op: 'send', ...reply, requestId: 'answer-3' });
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'MAIL_ALREADY_REPLIED');
  assert.match(refused.body.error.message, /already answered/);
  assert.equal(f.store.db.prepare('SELECT reply_to FROM mail_sent').get().reply_to, message.id);
});

test('a reply refused before sending does not block another try', async t => {
  const f = fixture(t);
  let refuse = true;
  const mail = new Mail({ store: f.store, configFor: () => f.config, mailboxFor: () => A, readPassword: () => 'synthetic',
    transport: async () => { if (refuse) throw new MailError('MAIL_REJECTED', 422); } });
  f.deliver('From: client@acme.example\r\nSubject: Q\r\n\r\nQ\r\n');
  const [message] = mail.inbox(B).messages;
  await rejects(mail.send(B, { requestId: 'x', kind: 'reply', replyTo: message.id, subject: 'Q', text: 'R' }), 'MAIL_REJECTED');
  refuse = false;
  assert.equal((await mail.send(A, { requestId: 'y', kind: 'reply', replyTo: message.id, subject: 'Q', text: 'R' })).sent, true);
});

test('owners may share an address only with the same maildir and smtp', () => {
  const dir = '/synthetic';
  const owners = mail => ({ owners: [{ subject: 'a', label: 'blackout', provider: 'claude', mail: mailBlock(dir, { studioViewers: ['blackout'] }) },
    { subject: 'b', label: 'screamer', provider: 'codex', mail }] });
  assert.equal(parseRuntimeConfig(JSON.stringify(owners(mailBlock(dir))), {}).length, 2);
  assert.throws(() => parseRuntimeConfig(JSON.stringify(owners(mailBlock(dir, { maildir: '/other/Maildir' }))), {}), /share the mail address/);
  assert.throws(() => parseRuntimeConfig(JSON.stringify(owners(mailBlock(dir, { smtp: { ...mailBlock(dir).smtp, user: 'other' } }))), {}), /share the mail address/);
  assert.throws(() => parseRuntimeConfig(JSON.stringify(owners(mailBlock(dir, { smtp: { ...mailBlock(dir).smtp, port: 589 } }))), {}), /share the mail address/);
  // A different address with its own maildir is fine.
  assert.equal(parseRuntimeConfig(JSON.stringify(owners(mailBlock(dir, { address: 'other@synthetic.invalid', maildir: '/other/Maildir' }))), {}).length, 2);
});

test('the Studio view of a shared mailbox reads the canonical state', async t => {
  const f = fixture(t);
  await f.send(B, { kind: 'first', to: 'ceo@alpha.example' });
  const owners = [{ issuer, subject: 'a', label: 'blackout', provider: 'claude', mail: parseMailConfig(mailBlock(f.dir, { studioViewers: ['blackout'] })) },
    { issuer, subject: 'b', label: 'screamer', provider: 'codex', mail: f.config }];
  for (const [i, owner] of owners.entries()) f.store.getOrInsert('companion-identity-v1', principalKey({ issuer, subject: owner.subject }), { companionId: [A, B][i] });
  assert.deepEqual(new Studio({ store: f.store, owners }).list(A).contacts.map(row => row.company), ['alpha.example']);
});

test('the server maps the second owner on the same address to the first owner\'s companion', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mail-shared-server-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['new', 'cur', 'tmp']) mkdirSync(join(dir, 'Maildir', folder), { recursive: true });
  const owners = [{ issuer, subject: 'a', label: 'blackout', provider: 'claude', mail: mailBlock(dir) },
    { issuer, subject: 'b', label: 'screamer', provider: 'codex', mail: mailBlock(dir) }];
  const runtimeFile = join(dir, 'owners.json'), dataDir = join(dir, 'data');
  writeFileSync(runtimeFile, JSON.stringify({ owners }));
  const seed = new BootstrapStore(dataDir, ROOT);
  for (const [i, owner] of owners.entries()) seed.getOrInsert('companion-identity-v1', principalKey({ issuer, subject: owner.subject }), { companionId: [A, B][i] });
  seed.close();
  const sent = [];
  const app = await startServer({ dataDir, port: 0, mode: 'account', pilotSubjects: owners.map(({ issuer, subject }) => ({ issuer, subject })),
    runtimeFile, runtimeDir: join(dir, 'runtime'), binaries: { claude: '/nonexistent/synthetic', codex: '/nonexistent/synthetic' },
    validateAccount: async () => null, discordOptions: { connect: false }, boardOptions: { poll: false },
    mailOptions: { readPassword: () => 'synthetic', transport: async message => { sent.push(message); } } });
  t.after(() => app.close());
  await app.mail.send(B, { requestId: 'cirno-1', kind: 'first', to: 'ceo@alpha.example', subject: 'Q', text: 'Bonjour.' });
  await rejects(app.mail.send(A, { requestId: 'cchan-1', kind: 'first', to: 'cto@alpha.example', subject: 'Q', text: 'Bonjour.' }), 'MAIL_ALREADY_CONTACTED');
  assert.equal(sent.length, 1);
  assert.deepEqual(app.store.db.prepare('SELECT companion_id, request_id FROM mail_sent').all().map(row => ({ ...row })),
    [{ companion_id: A, request_id: B + ':cirno-1' }]);
});
