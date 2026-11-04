import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Mail, MailError, mailOperation, parseMail, composeMail, parseMailConfig, companyOf, decodeWords } from '../src/mail.mjs';
import { Connectors } from '../src/connectors.mjs';
import { parseRuntimeConfig } from '../src/runtime-config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAY = 86_400_000;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

function fixture(t, { limits = { companies: 3, followUps: 1, perDay: 5 }, transport } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-'));
  const maildir = join(dir, 'Maildir');
  for (const folder of ['new', 'cur', 'tmp']) mkdirSync(join(maildir, folder), { recursive: true });
  const config = parseMailConfig({ address: 'studio@blackoutburst.com', displayName: 'Thomas — Swarm Dev Studio', maildir,
    smtp: { port: 588, user: 'studio', passwordFile: join(dir, 'password'), servername: 'mail.blackoutburst.com' },
    signature: 'Thomas\nSwarm Dev Studio', purpose: 'Discovery for Swarm Dev Studio', limits });
  const store = new BootstrapStore(join(dir, 'data'), ROOT);
  const sent = [];
  const clock = { now: Date.UTC(2026, 10, 4, 12) };
  const mail = new Mail({ store, configFor: id => id === A ? config : null, now: () => clock.now, readPassword: () => 'secret-password',
    transport: transport ?? (async message => { sent.push(message); return { accepted: true }; }) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const deliver = (raw, name = `${1793800000 + n++}.V1I1M1.test`) => { writeFileSync(join(maildir, 'new', name), raw); return name; };
  const send = input => mail.send(A, { requestId: `r-${n++}`, subject: 'Automatisation', text: 'Bonjour,\nune question.', ...input });
  return { mail, store, sent, clock, deliver, send, config, maildir };
}
const rejects = (promise, code) => assert.rejects(promise, error => error instanceof MailError && error.code === code);

test('received mail is decoded: encoded words, quoted-printable, base64, multipart and HTML', () => {
  assert.equal(decodeWords('=?UTF-8?B?w6l0w6k=?= =?ISO-8859-1?Q?caf=E9?='), 'étécafé');
  const qp = parseMail(Buffer.from('From: =?UTF-8?Q?Ren=C3=A9e?= <Renee@Example.FR>\r\nSubject: =?UTF-8?Q?R=C3=A9ponse?=\r\n'
    + 'Date: Wed, 04 Nov 2026 10:00:00 +0100\r\nMessage-ID: <abc@example.fr>\r\nContent-Type: text/plain; charset=utf-8\r\n'
    + 'Content-Transfer-Encoding: quoted-printable\r\n\r\nBonjour, c=C3=A9tait tr=C3=A8s =\r\nclair.\r\n'));
  assert.equal(qp.from, 'renee@example.fr'); assert.equal(qp.fromName, 'Renée'); assert.equal(qp.subject, 'Réponse');
  assert.equal(qp.text, 'Bonjour, cétait très clair.'); assert.equal(qp.messageId, '<abc@example.fr>'); assert.equal(qp.autoReply, false);
  const multi = parseMail(Buffer.from('From: a@b.example\r\nContent-Type: multipart/alternative; boundary="xx"\r\n\r\n--xx\r\n'
    + 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>HTML <b>only</b></p>\r\n--xx\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
    + Buffer.from('Texte brut é').toString('base64') + '\r\n--xx--\r\n'));
  assert.equal(multi.text, 'Texte brut é');
  const html = parseMail(Buffer.from('From: a@b.example\r\nContent-Type: text/html\r\n\r\n<div>Hello<br>there &amp; you</div><script>x()</script>'));
  assert.equal(html.text, 'Hello\nthere & you');
  assert.equal(parseMail(Buffer.from('From: MAILER-DAEMON@mx.example\r\nSubject: Undelivered\r\n\r\nx')).autoReply, true);
  assert.equal(parseMail(Buffer.from('From: a@b.example\r\nAuto-Submitted: auto-replied\r\n\r\nAbsent')).autoReply, true);
});

test('outgoing mail has the identity, signature, opt-out line and threading headers, and reads back the same', async t => {
  const f = fixture(t);
  const id = f.deliver('From: Client <client@acme.example>\r\nSubject: Question\r\nMessage-ID: <q1@acme.example>\r\n\r\nQuel délai ?\r\n');
  const inbox = f.mail.inbox(A);
  assert.equal(inbox.messages.length, 1); assert.ok(id);
  const result = await f.mail.send(A, { requestId: 'answer-1', kind: 'reply', replyTo: inbox.messages[0].id, subject: 'Question', text: 'Deux semaines.' });
  assert.equal(result.to, 'client@acme.example'); assert.equal(result.subject, 'Re: Question');
  const [message] = f.sent;
  assert.equal(message.from, 'studio@blackoutburst.com'); assert.equal(message.port, 588); assert.equal(message.password, 'secret-password');
  assert.match(message.data, /^From: =\?UTF-8\?B\?[^?]+\?= <studio@blackoutburst\.com>\r\n/);
  assert.match(message.data, /\r\nIn-Reply-To: <q1@acme\.example>\r\nReferences: <q1@acme\.example>\r\n/);
  assert.match(message.data, /\r\nList-Unsubscribe: <mailto:studio@blackoutburst\.com\?subject=STOP>\r\n/);
  const back = parseMail(Buffer.from(message.data));
  assert.equal(back.fromName, 'Thomas — Swarm Dev Studio');
  assert.equal(back.text, `Deux semaines.\n\n-- \nThomas\nSwarm Dev Studio\n\n${f.config.optOutLine}`);
  assert.equal(f.mail.inbox(A).messages.length, 0, 'answering marks the email handled');
  assert.equal(f.mail.inbox(A, { all: true }).messages[0].handled, true);
  const long = composeMail({ from: 'a@b.example', displayName: 'A', to: 'c@d.example', subject: 'x', messageId: '<m@b.example>', text: 'é'.repeat(200) });
  assert.ok(long.split('\r\n').every(line => line.length <= 78), 'quoted-printable lines stay short');
  assert.equal(parseMail(Buffer.from(long)).text, 'é'.repeat(200));
});

test('discovery limits: companies, one first mail and one later follow-up per company, a daily cap', async t => {
  const f = fixture(t);
  await f.send({ kind: 'first', to: 'ceo@alpha.example' });
  await rejects(f.send({ kind: 'first', to: 'sales@alpha.example' }), 'MAIL_ALREADY_CONTACTED');
  await rejects(f.send({ kind: 'follow_up', to: 'ceo@beta.example' }), 'MAIL_NOT_CONTACTED');
  await rejects(f.send({ kind: 'follow_up', to: 'ceo@alpha.example' }), 'MAIL_TOO_SOON');
  // Personal providers count per address: two Gmail users are two contacts.
  await f.send({ kind: 'first', to: 'one@gmail.com' });
  assert.equal(companyOf('One@Gmail.com'), 'one@gmail.com'); assert.equal(companyOf('x@Shop.Example'), 'shop.example');
  const third = await f.send({ kind: 'first', to: 'two@gmail.com' });
  assert.equal(third.companies, 3); assert.equal(third.companiesLimit, 3);
  await rejects(f.send({ kind: 'first', to: 'ceo@gamma.example' }), 'MAIL_COMPANY_LIMIT');
  f.clock.now += 3 * DAY;
  await f.send({ kind: 'follow_up', to: 'ceo@alpha.example' });
  await rejects(f.send({ kind: 'follow_up', to: 'ceo@alpha.example' }), 'MAIL_FOLLOW_UP_LIMIT');
  await f.send({ kind: 'follow_up', to: 'one@gmail.com' });
  assert.equal(f.sent.length, 5);
  const capped = fixture(t, { limits: { companies: 30, followUps: 1, perDay: 2 } });
  await capped.send({ kind: 'first', to: 'a@a.example' }); await capped.send({ kind: 'first', to: 'b@b.example' });
  await rejects(capped.send({ kind: 'first', to: 'c@c.example' }), 'MAIL_DAILY_LIMIT');
  capped.clock.now += DAY + 1;
  await capped.send({ kind: 'first', to: 'c@c.example' });
  const status = f.mail.status(A);
  assert.equal(status.address, 'studio@blackoutburst.com'); assert.equal(status.purpose, 'Discovery for Swarm Dev Studio');
  assert.deepEqual(status.contacted.find(item => item.company === 'alpha.example'), { company: 'alpha.example', firstAt: new Date(Date.UTC(2026, 10, 4, 12)).toISOString(),
    followUps: 1, replies: 0, repliedToUs: false, optedOut: false });
});

test('a company that answers gets replies, not follow-ups; automatic mail is never answered', async t => {
  const f = fixture(t);
  await f.send({ kind: 'first', to: 'ceo@alpha.example' });
  f.clock.now += 3 * DAY;
  f.deliver('From: Assistant <office@alpha.example>\r\nSubject: Re: Automatisation\r\nDate: ' + new Date(f.clock.now).toUTCString() + '\r\n\r\nIntéressés.\r\n');
  await rejects(f.send({ kind: 'follow_up', to: 'ceo@alpha.example' }), 'MAIL_USE_REPLY');
  await rejects(f.send({ kind: 'first', to: 'new@alpha.example' }), 'MAIL_ALREADY_CONTACTED');
  const [answer] = f.mail.inbox(A).messages;
  await rejects(f.mail.send(A, { requestId: 'x', kind: 'reply', replyTo: answer.id, to: 'someone@else.example', subject: 's', text: 't' }), 'MAIL_REPLY_MISMATCH');
  await f.mail.send(A, { requestId: 'y', kind: 'reply', replyTo: answer.id, subject: 'Automatisation', text: 'Merci !' });
  f.deliver('From: MAILER-DAEMON@mx.example\r\nSubject: Undelivered Mail\r\n\r\nbounce');
  const bounce = f.mail.inbox(A).messages.find(item => item.automatic);
  await rejects(f.mail.send(A, { requestId: 'z', kind: 'reply', replyTo: bounce.id, subject: 's', text: 't' }), 'MAIL_AUTOMATIC');
  // A company that wrote first is answered with a reply, never cold-mailed.
  f.deliver('From: lead@delta.example\r\nSubject: Votre offre\r\n\r\nBonjour');
  await rejects(f.send({ kind: 'first', to: 'boss@delta.example' }), 'MAIL_USE_REPLY');
});

test('opt-out: a STOP reply blocks the sender and the company at once, and manual opt-outs work too', async t => {
  const f = fixture(t);
  await f.send({ kind: 'first', to: 'ceo@alpha.example' });
  f.deliver('From: ceo@alpha.example\r\nSubject: Re: Automatisation\r\n\r\nSTOP merci\r\n');
  f.deliver('From: x@beta.example\r\nSubject: Re\r\n\r\nNous ne souhaitons plus recevoir de messages.\r\n');
  f.deliver('From: y@gamma.example\r\nSubject: Re\r\n\r\nNous allons stopper notre outil actuel, parlons-en.\r\n');
  const inbox = f.mail.inbox(A).messages;
  assert.equal(inbox.filter(item => item.askedToStop).length, 2, '"stopper" in a normal sentence is not an opt-out');
  f.clock.now += 3 * DAY;
  await rejects(f.send({ kind: 'follow_up', to: 'ceo@alpha.example' }), 'MAIL_OPTED_OUT');
  await rejects(f.send({ kind: 'first', to: 'other@beta.example' }), 'MAIL_OPTED_OUT');
  const stop = inbox.find(item => item.from === 'ceo@alpha.example');
  await rejects(f.mail.send(A, { requestId: 'r', kind: 'reply', replyTo: stop.id, subject: 's', text: 't' }), 'MAIL_OPTED_OUT');
  assert.deepEqual(f.mail.optOut(A, { address: 'Only@Epsilon.example', wholeCompany: false }), { optedOut: 'only@epsilon.example', company: null });
  await rejects(f.send({ kind: 'first', to: 'only@epsilon.example' }), 'MAIL_OPTED_OUT');
  await f.send({ kind: 'first', to: 'team@epsilon.example' });
  assert.equal(f.mail.status(A).optedOut, 5);
});

test('sends are idempotent; refused sends may be retried; an unknown outcome is never resent', async t => {
  const f = fixture(t);
  const input = { requestId: 'same', kind: 'first', to: 'ceo@alpha.example', subject: 'Hello', text: 'Body' };
  await f.mail.send(A, input);
  const again = await f.mail.send(A, input);
  assert.equal(again.replayed, true); assert.equal(f.sent.length, 1);
  await rejects(f.mail.send(A, { ...input, text: 'Other' }), 'CONFLICT');
  let mode = 'refuse';
  const g = fixture(t, { transport: async () => { if (mode === 'refuse') throw new MailError('MAIL_REJECTED', 422); if (mode === 'lost') throw new Error('socket closed'); } });
  const one = { requestId: 'k1', kind: 'first', to: 'ceo@beta.example', subject: 'Hi', text: 'Body' };
  await rejects(g.mail.send(A, one), 'MAIL_REJECTED');
  assert.equal(g.mail.status(A).companies, 0, 'a refused mail does not use a company');
  mode = 'lost';
  await rejects(g.mail.send(A, one), 'MAIL_UNCERTAIN');
  mode = 'ok';
  await rejects(g.mail.send(A, one), 'MAIL_UNCERTAIN');
  assert.equal(g.mail.status(A).companies, 1, 'an uncertain mail counts against the limits');
  for (const bad of [{ ...one, requestId: 'bad key!' }, { ...one, kind: 'blast' }, { ...one, to: 'not-an-address' }, { ...one, subject: 'a\nBcc: x@y.example' },
    { ...one, to: 'studio@blackoutburst.com' }, { ...one, extra: 1 }, { ...one, kind: 'reply' }]) await rejects(g.mail.send(A, { ...bad, requestId: bad.requestId === one.requestId ? 'n' + Math.random().toString(36).slice(2, 8) : bad.requestId }), 'INVALID_REQUEST');
});

test('new mail wakes the companion once; owners without a mailbox have no mail', async t => {
  const f = fixture(t);
  assert.equal(f.mail.newMailNotice(A), null);
  f.deliver('From: a@alpha.example\r\nSubject: Hi\r\n\r\nHello');
  f.deliver('From: b@beta.example\r\nSubject: Re\r\n\r\nstop');
  const notice = f.mail.newMailNotice(A);
  assert.match(notice.prompt, /2 new emails arrived at studio@blackoutburst\.com \(1 asking to stop/);
  assert.match(notice.requestId, /^mail-[a-f0-9]{24}$/);
  assert.equal(f.mail.newMailNotice(A).requestId, notice.requestId, 'the same wake until it is queued');
  f.mail.notified(A, notice.ids);
  assert.equal(f.mail.newMailNotice(A), null);
  const read = f.mail.read(A, { id: notice.ids[0] });
  assert.equal(read.text, 'Hello'); assert.match(read.note, /untrusted/);
  f.mail.markHandled(A, { id: notice.ids[0] });
  assert.equal(f.mail.inbox(A).messages.length, 1);
  assert.equal(f.mail.configured(B), false); assert.equal(f.mail.newMailNotice(B), null);
  assert.deepEqual((await mailOperation(f.mail, B, { op: 'inbox' })).body.error.code, 'MAIL_NOT_CONFIGURED');
  assert.equal((await mailOperation(f.mail, A, { op: 'delete' })).status, 400);
  assert.equal((await mailOperation(f.mail, A, { op: 'status' })).status, 200);
});

test('the Mail connector shows for owners with a mailbox, switches off, and its tools follow the switch', t => {
  const f = fixture(t);
  const connectors = new Connectors({ store: f.store, mail: () => f.mail });
  const item = connectors.list(A).connectors.find(entry => entry.id === 'mail');
  assert.equal(item.state, 'connected'); assert.match(item.detail, /studio@blackoutburst\.com · 0\/3 companies contacted · 0 to handle/);
  assert.equal(connectors.list(B).connectors.find(entry => entry.id === 'mail'), undefined);
  assert.equal(connectors.toolFilter(A)('mcp__scheduler__mail_send'), true);
  assert.equal(connectors.toolFilter(B)('mcp__scheduler__mail_send'), false, 'no mailbox, no mail tools');
  assert.equal(connectors.set(A, 'mail', false).connectors.find(entry => entry.id === 'mail').state, 'paused');
  assert.equal(connectors.toolFilter(A)('mcp__scheduler__mail_inbox'), false);
  assert.equal(connectors.toolFilter(A)('mcp__scheduler__list_schedules'), true);
  assert.throws(() => connectors.set(B, 'mail', true), error => error.code === 'CONNECTOR_UNAVAILABLE');
  connectors.set(A, 'mail', true); assert.equal(connectors.mailOn(A), true);
});

test('owners.json accepts a mail block with a password file path only, and refuses bad ones', () => {
  const owner = { subject: 's1', label: 'blackout', provider: 'claude' };
  const mail = { address: 'Studio@Blackoutburst.com', displayName: 'Swarm Dev Studio', maildir: '/var/mail/studio',
    smtp: { port: 588, user: 'studio', passwordFile: '/etc/secret', servername: 'mail.blackoutburst.com' }, signature: 'Thomas' };
  const [parsed] = parseRuntimeConfig(JSON.stringify({ owners: [{ ...owner, mail }] }));
  assert.equal(parsed.mail.address, 'studio@blackoutburst.com');
  assert.deepEqual(parsed.mail.limits, { companies: 30, followUps: 1, perDay: 15 });
  assert.equal(parseRuntimeConfig(JSON.stringify({ owners: [owner] }))[0].mail, undefined);
  for (const bad of [{ ...mail, password: 'x' }, { ...mail, displayName: 'A <evil@x.example>' }, { ...mail, maildir: 'relative' },
    { ...mail, smtp: { ...mail.smtp, password: 'x' } }, { ...mail, limits: { companies: 1000 } }, { ...mail, address: 'nope' }]) {
    assert.throws(() => parseRuntimeConfig(JSON.stringify({ owners: [{ ...owner, mail: bad }] })), /Invalid mail settings/);
  }
});
