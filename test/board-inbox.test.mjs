import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { principalKey } from '../src/provisioning.mjs';
import { Conversations, ConversationError } from '../src/conversations.mjs';
import { SchedulerStore, SchedulerService } from '../src/scheduler.mjs';
import { BoardCompanion } from '../src/board-companion.mjs';
import { BoardInbox, topicLabel } from '../src/board-inbox.mjs';
import { PushNotifier } from '../src/push.mjs';
import { WebPushNotifier } from '../src/web-push.mjs';
import { DiscordLinks, DiscordBridge } from '../src/discord.mjs';
import { startServer } from '../server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const owner = { label: 'blackout', name: 'Blackout', board: { configDir: '/tmp/board', pythonPath: '/usr/bin/python3', connectPath: '/tmp/connect.py', allowedTools: [] } };
const wakeReply = text => ({ text: JSON.stringify({ action: 'message', text }), sessionId: 'native' });
const tableShape = (db, name) => db.prepare(`PRAGMA table_info(${name})`).all().map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));

// The Board as the companion's paired bridge sees it: ticket #15's thread th1, a plain discussion thread th2.
function fakeBoard() {
  let inbox = [], requests = [];
  const calls = [];
  const client = { close() {}, async call(name, args) {
    calls.push([name, args]);
    if (name === 'read_inbox') { const page = inbox; inbox = []; return { session: { owner_id: 'blackoutburst', agent_id: 'me' }, messages: page, cursor: 'c' + calls.length }; }
    if (name === 'list_human_requests') return requests;
    if (name === 'update_companion_profile') return {};
    if (name === 'get_thread' && args.thread_id === 'th1') return { thread: { id: 'th1', title: '[Agent #15] Fix login', ticket: { id: 'tk15', number: 15, title: 'Fix login' } } };
    if (name === 'get_thread' && args.thread_id === 'th2') return { thread: { id: 'th2', title: 'Design chat', ticket: null } };
    if (name === 'get_ticket' && args.ticket_id === 'tk15') return { ticket: { id: 'tk15', number: 15, title: 'Fix login', thread_id: 'th1' } };
    throw Object.assign(new Error('unavailable'), { code: 'BOARD_ERROR' });
  } };
  return { client, calls, setInbox(value) { inbox = value; }, setRequests(value) { requests = value; } };
}

function fixture(t, { handler } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-inbox-')), store = new BootstrapStore(dir, ROOT);
  const f = { clock: Date.UTC(2026, 10, 4, 12), turns: [], settled: [], board: fakeBoard() };
  f.now = () => f.clock;
  for (const label of ['A', 'B']) f[label] = store.getOrInsert('companion-identity-v1', principalKey({ issuer: 'https://synthetic.invalid', subject: 'board-inbox-' + label }), { companionId: randomUUID() }).companionId;
  f.store = store; f.db = store.db;
  f.scheduler = new SchedulerStore({ store, now: f.now, minSpacingMs: 0, boardSpacingMs: 0, proactiveByDefault: false });
  f.inbox = new BoardInbox({ store, now: f.now });
  f.handler = handler ?? ((companionId, turn) => turn.prompt.startsWith('This is a private background')
    ? wakeReply('Board news: ' + (turn.prompt.match(/thread (th\d)/)?.[1] ?? turn.prompt.match(/request (\S+)/)?.[1])) : { text: 'On it.' });
  f.conv = new Conversations({ store, now: f.now, flushMs: 1, boardInbox: f.inbox, systemPrompt: () => 'persona',
    runner: { turn: async (companionId, turn) => { f.turns.push({ companionId, ...turn }); return f.handler(companionId, turn); } },
    wakePolicy: { beforeStart: (companionId, id) => f.scheduler.startInTransaction(companionId, id), canDeliver: (companionId, id) => f.scheduler.canDeliver(companionId, id) },
    onSettled: event => f.settled.push(event) });
  f.service = new SchedulerService({ scheduler: f.scheduler, conversations: f.conv, companions: () => [f.A], ready: () => true, pollMs: 60000 });
  f.companion = new BoardCompanion({ store, owners: [owner], profiles: { get: id => id === f.A ? { name: 'Claude', character: 'claude' } : null },
    scheduler: f.service, companionIdFor: () => f.A, clientFor: () => f.board.client, inbox: f.inbox });
  f.drain = async () => { for (let i = 0; i < 4; i++) { await f.service.tick(); await f.conv.idle(); f.clock += 1000; } };
  f.list = (archived = false) => f.conv.handle(f.A, { action: 'boardInbox', archived });
  f.messages = async threadId => (await f.conv.handle(f.A, { action: 'snapshot', ...(threadId ? { threadId } : {}) })).messages;
  t.after(async () => { f.companion.stop(); await f.service.stop(); await f.conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}
const mention = (id, thread, mentions = ['agent:me']) => ({ id, thread_id: thread, author: { agent_id: 'codex' }, mentions });

test('Board wakes land in one sub-conversation per Board thread, grouped with the ticket\'s Needs-you, never in the main chat', async t => {
  const f = fixture(t);
  const ongoing = f.conv.ongoingThread(f.A);
  await f.companion.tick(); // baseline
  f.board.setInbox([mention('m1', 'th1'), mention('m2', 'th2'), mention('o1', 'th1', ['blackoutburst'])]);
  f.board.setRequests([{ id: 'req1', status: 'open', owner_id: 'blackoutburst', ticket_id: 'tk15', number: 15, title: 'Fix login' }]);
  await f.companion.tick();
  await f.drain();
  assert.deepEqual(await f.messages(), [], 'The main chat holds no Board message');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE thread_id=?").get(ongoing).n, 0, 'No Board wake ever used the ongoing thread');
  const listed = await f.list();
  assert.equal(listed.threads.length, 2);
  const ticket = listed.threads.find(item => item.label === '#15 · Fix login'), design = listed.threads.find(item => item.label === 'Design chat');
  assert.ok(ticket && design, JSON.stringify(listed.threads));
  assert.equal(ticket.ticketNumber, 15);
  assert.equal(ticket.unread, 3, 'The mention, the owner ping and the Needs-you request of ticket #15 share one sub-conversation');
  assert.equal(design.unread, 1);
  assert.equal(listed.unread, 4, 'The tab badge counts every unread Board message');
  assert.match(ticket.preview, /^Board news:/);
  assert.equal((await f.messages(ticket.threadId)).length, 3);
  // Only one lookup per new topic: the Needs-you request joined the known ticket thread without asking again.
  assert.equal(f.board.calls.filter(([name]) => name === 'get_thread').length, 2);
  assert.equal(f.board.calls.filter(([name]) => name === 'get_ticket').length, 0);
  // The main chat's thread list and Past chats never show Board sub-conversations.
  const main = await f.conv.handle(f.A, { action: 'snapshot' });
  assert.equal(main.threadId, ongoing);
  assert.ok(!main.threads.some(item => [ticket.threadId, design.threadId].includes(item.id)));
  assert.deepEqual((await f.conv.handle(f.A, { action: 'archivedThreads' })).threads, []);
  // Opened directly, a sub-conversation is writable (not an archived past chat).
  const opened = await f.conv.handle(f.A, { action: 'snapshot', threadId: ticket.threadId });
  assert.equal(opened.archivedAt, undefined);
  assert.equal(opened.threads[0].id, ticket.threadId);
  assert.equal(opened.threads[0].title, '#15 · Fix login');
  // The other owner sees nothing and cannot act on it.
  assert.deepEqual((await f.conv.handle(f.B, { action: 'boardInbox' })).threads, []);
  await assert.rejects(f.conv.handle(f.B, { action: 'boardRead', threadId: ticket.threadId }), error => error instanceof ConversationError && error.code === 'NOT_FOUND');
  await assert.rejects(f.conv.handle(f.B, { action: 'boardArchive', threadId: ticket.threadId, archived: true }), error => error.code === 'NOT_FOUND');
});

test('a Needs-you request on a new ticket looks up its thread once; a wake with no Board topic goes to the general Board conversation', async t => {
  const f = fixture(t);
  await f.companion.tick();
  f.board.setRequests([{ id: 'req9', status: 'open', owner_id: 'blackoutburst', ticket_id: 'tk15', number: 15, title: 'Fix login' }]);
  await f.companion.tick();
  await f.drain();
  assert.equal(f.board.calls.filter(([name]) => name === 'get_ticket').length, 1);
  let listed = await f.list();
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].label, '#15 · Fix login');
  assert.equal(f.inbox.topic(listed.threads[0].threadId).boardThreadId, 'th1', 'The request\'s ticket thread is recorded');
  // A later mention in th1 joins the same sub-conversation.
  f.board.setInbox([mention('m5', 'th1')]); await f.companion.tick(); await f.drain();
  listed = await f.list();
  assert.equal(listed.threads.length, 1); assert.equal(listed.threads[0].unread, 2);
  // A Board wake without a recorded topic: the general "Board" sub-conversation, never the main chat.
  const ongoing = f.conv.ongoingThread(f.A);
  const result = f.conv.enqueueProactive(f.A, { id: randomUUID(), kind: 'board', prompt: 'A Board event without a known thread.' });
  assert.notEqual(result.threadId, ongoing);
  assert.equal(f.inbox.topic(result.threadId).general, true);
  assert.equal(f.inbox.topic(result.threadId).label, 'Board');
  const again = f.conv.enqueueProactive(f.A, { id: randomUUID(), kind: 'board', prompt: 'Another one.' });
  assert.equal(again.threadId, result.threadId, 'There is one general Board conversation');
  // Non-Board wakes keep going to the main chat.
  assert.equal(f.conv.enqueueProactive(f.A, { id: randomUUID(), kind: 'reminder', prompt: 'Water the plants.' }).threadId, ongoing);
  await f.conv.idle();
});

test('a failed Board lookup still routes by what the wake carries, and an interrupted record is found through the scheduler key', async t => {
  const f = fixture(t);
  await f.companion.tick();
  f.board.setInbox([mention('x1', 'th7')]); // the fake Board refuses get_thread for th7
  await f.companion.tick(); await f.drain();
  const listed = await f.list();
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].label, 'Board thread');
  assert.equal(f.inbox.topic(listed.threads[0].threadId).boardThreadId, 'th7');
  // The process stopped after queueing but before recording the wake id: the scheduler's request key still matches.
  f.inbox.route(f.A, 'board-mention-crash', { boardThreadId: 'th7' });
  f.scheduler.enqueueEvent(f.A, { requestId: 'board-mention-crash', kind: 'board', prompt: 'Mentioned in Board thread th7.' });
  await f.drain();
  const after = await f.list();
  assert.equal(after.threads.length, 1); assert.equal(after.threads[0].unread, 2);
});

test('unread counts, mark read, archive and reopen on a new Board message', async t => {
  const f = fixture(t);
  await f.companion.tick();
  f.board.setInbox([mention('m1', 'th1'), mention('m2', 'th2')]); await f.companion.tick(); await f.drain();
  let listed = await f.list();
  const ticket = listed.threads.find(item => item.ticketNumber === 15);
  const read = await f.conv.handle(f.A, { action: 'boardRead', threadId: ticket.threadId });
  assert.equal(read.unread, 1, 'Marking read returns the new badge total');
  listed = await f.list();
  assert.equal(listed.threads.find(item => item.threadId === ticket.threadId).unread, 0);
  const archived = await f.conv.handle(f.A, { action: 'boardArchive', threadId: ticket.threadId, archived: true });
  assert.equal(archived.archived, true);
  assert.ok(!(await f.list()).threads.some(item => item.threadId === ticket.threadId), 'Archived topics leave the open list');
  const done = await f.list(true);
  assert.equal(done.threads.length, 1); assert.equal(done.threads[0].archived, true);
  // A new Board wake on that thread reopens it, unread.
  f.board.setInbox([mention('m3', 'th1')]); await f.companion.tick(); await f.drain();
  listed = await f.list();
  const reopened = listed.threads.find(item => item.threadId === ticket.threadId);
  assert.ok(reopened, 'The archived sub-conversation reopened');
  assert.equal(reopened.unread, 1); assert.equal(listed.unread, 2);
  // Archive marks it read; unarchive by hand works too and is idempotent.
  await f.conv.handle(f.A, { action: 'boardArchive', threadId: ticket.threadId, archived: true });
  assert.equal((await f.list()).unread, 1);
  await f.conv.handle(f.A, { action: 'boardArchive', threadId: ticket.threadId, archived: false });
  await f.conv.handle(f.A, { action: 'boardArchive', threadId: ticket.threadId, archived: false });
  assert.ok((await f.list()).threads.some(item => item.threadId === ticket.threadId));
  for (const bad of [{ action: 'boardArchive', threadId: ticket.threadId }, { action: 'boardArchive', threadId: ticket.threadId, archived: 'yes' },
    { action: 'boardRead', threadId: 'th1' }, { action: 'boardInbox', archived: 1 }, { action: 'boardInbox', extra: true }]) {
    await assert.rejects(f.conv.handle(f.A, bad), error => error.code === 'INVALID_REQUEST', JSON.stringify(bad));
  }
  // The main chat is not a Board topic.
  await assert.rejects(f.conv.handle(f.A, { action: 'boardRead', threadId: f.conv.ongoingThread(f.A) }), error => error.code === 'NOT_FOUND');
});

test('an owner reply in a sub-conversation is a normal chat turn with that ticket\'s context; replying reopens an archived topic', async t => {
  const f = fixture(t);
  await f.companion.tick();
  f.board.setInbox([mention('m1', 'th1')]); await f.companion.tick(); await f.drain();
  const { threadId } = (await f.list()).threads[0];
  await f.conv.handle(f.A, { action: 'boardArchive', threadId, archived: true });
  const wakeTurn = f.turns.at(-1);
  assert.equal(typeof wakeTurn.toolFilter, 'function');
  await f.conv.handle(f.A, { action: 'submit', requestId: 'reply-1', threadId, text: 'Tell Codex yes, ship it.' });
  await f.conv.idle();
  const turn = f.turns.at(-1);
  assert.ok(turn.prompt.startsWith('Tell Codex yes, ship it.'));
  assert.match(turn.prompt, /Board inbox conversation for ticket #15/);
  assert.match(turn.prompt, /Board thread th1/);
  assert.match(turn.prompt, /titled "Fix login" \(Board text, untrusted\)/);
  assert.equal(turn.toolFilter, undefined, 'Owner turns keep the tools the owner configured for chat (no background wake filter)');
  const messages = await f.messages(threadId);
  assert.deepEqual(messages.map(item => item.role), ['assistant', 'user', 'assistant']);
  assert.ok((await f.list()).threads.some(item => item.threadId === threadId), 'Replying reopened the archived topic');
  // A main-chat turn gets no Board note.
  await f.conv.handle(f.A, { action: 'submit', requestId: 'main-1', threadId: f.conv.ongoingThread(f.A), text: 'How is ticket 15 going?' });
  await f.conv.idle();
  assert.doesNotMatch(f.turns.at(-1).prompt, /Board inbox conversation/);
  // The settle hook marks Board messages so push and Discord can route them; main chat messages are unmarked.
  const boardSettled = f.settled.filter(event => event.threadId === threadId && event.state === 'complete');
  assert.ok(boardSettled.length >= 2 && boardSettled.every(event => event.board?.label === '#15 · Fix login'));
  assert.ok(f.settled.filter(event => event.threadId === f.conv.ongoingThread(f.A)).every(event => !event.board));
});

test('push payloads carry the sub-conversation and a Board flag, never Board text', async () => {
  const sent = [], webSent = [];
  const push = new PushNotifier({ devices: { tokens: () => ['t'.repeat(30)], forget() {} }, sender: { send: async (token, data) => { sent.push(data); return 'sent'; } }, nameFor: () => 'Claude' });
  const threadId = randomUUID(), messageId = randomUUID();
  push.settled({ companionId: randomUUID(), threadId, requestId: 'wake-x', state: 'complete', text: 'secret body', messageId, board: { label: '#15 · Private title' } });
  push.settled({ companionId: randomUUID(), threadId, requestId: 'wake-y', state: 'complete', text: 'main', messageId: randomUUID() });
  await sleep(5);
  assert.deepEqual(sent[0], { type: 'message', threadId, messageId, name: 'Claude', board: '1' });
  assert.equal(sent[1].board, undefined);
  assert.ok(!JSON.stringify(sent).includes('Private title') && !JSON.stringify(sent).includes('secret body'));
  const web = new WebPushNotifier({ subscriptions: { list: () => [{ endpoint: 'https://push.example/x', preview: false }], isPresent: () => false, forget() {} },
    sender: { send: async (subscription, payload) => { webSent.push(payload); return 'sent'; } }, nameFor: () => 'Claude' });
  web.settled({ companionId: randomUUID(), threadId, requestId: 'wake-x', state: 'complete', text: 'secret body', messageId, board: { label: '#15 · Private title' } });
  await sleep(5);
  assert.deepEqual(webSent[0], { type: 'message', threadId, messageId, title: 'Claude', board: true, body: 'New message' });
});

test('rollback: legacy tables keep their shape and an older release sees Board topics only as read-only past chats', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-inbox-rollback-')), store = new BootstrapStore(dir, ROOT);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const legacy = new Conversations({ store, flushMs: 1, runner: { turn: async () => wakeReply('hi') }, systemPrompt: () => 'persona' });
  new SchedulerStore({ store });
  const tables = ['conv_threads', 'conv_messages', 'conv_wakes', 'conv_ongoing', 'conv_events', 'conv_turns', 'scheduler_occurrences'];
  const before = Object.fromEntries(tables.map(name => [name, tableShape(store.db, name)]));
  const A = randomUUID();
  const ongoing = legacy.ongoingThread(A);
  const inbox = new BoardInbox({ store });
  const current = new Conversations({ store, flushMs: 1, boardInbox: inbox, runner: { turn: async () => wakeReply('Codex asks about #15.') }, systemPrompt: () => 'persona' });
  const wakeId = randomUUID();
  inbox.route(A, 'board-mention-r', { boardThreadId: 'th1', ticketNumber: 15, title: 'Fix login' }); inbox.routed(A, 'board-mention-r', wakeId);
  const { threadId } = current.enqueueProactive(A, { id: wakeId, kind: 'board', prompt: 'Mentioned in th1.' });
  await current.idle();
  assert.deepEqual(Object.fromEntries(tables.map(name => [name, tableShape(store.db, name)])), before, 'No legacy table changed shape');
  assert.notEqual(store.db.prepare('SELECT archived_at FROM conv_threads WHERE id=?').get(threadId).archived_at, null,
    'The sub-conversation row is stamped archived for older releases');
  // What an older release (no Board inbox) shows: the main chat stays the ongoing chat, the Board topic is a past chat.
  const old = await legacy.handle(A, { action: 'snapshot' });
  assert.equal(old.threadId, ongoing);
  assert.ok(!old.threads.some(item => item.id === threadId));
  const past = await legacy.handle(A, { action: 'archivedThreads' });
  assert.deepEqual(past.threads.map(item => [item.id, item.title]), [[threadId, '#15 · Fix login']]);
  await assert.rejects(legacy.handle(A, { action: 'submit', requestId: 'old-reply', threadId, text: 'hi' }), error => error.code === 'ARCHIVED');
  // Even if the old release lost its ongoing mapping, it never picks a Board topic as the main chat.
  store.db.prepare('DELETE FROM conv_ongoing').run();
  store.db.prepare('DELETE FROM conv_threads WHERE id=?').run(ongoing);
  assert.notEqual(legacy.ongoingThread(A), threadId);
  await legacy.shutdown(); await current.shutdown();
  assert.equal(topicLabel({ ticket_number: 3 }), '#3');
});

// Discord: the DM carries Board messages under their topic header; a reply-to on one goes to that sub-conversation.
const TOKEN = 'MTA' + 'x'.repeat(56) + '.Gabcde.' + 'y'.repeat(30);
const BOT = { id: '111111111111111111', username: 'pip-bot', bot: true };
const OWNER = { id: '222222222222222222', username: 'blackout' };
function fakeDiscord() {
  const sent = [], sockets = []; let next = 500000000000000000n;
  const fetchImpl = async (url, spec) => {
    const path = new URL(url).pathname.replace('/api/v10', '');
    if (path === '/users/@me') return Response.json(BOT);
    if (path === '/oauth2/applications/@me') return Response.json({ id: '999999999999999999' });
    if (path.endsWith('/typing')) return new Response(null, { status: 204 });
    if (path.endsWith('/messages')) { const id = String(next++); sent.push({ id, ...JSON.parse(spec.body) }); return Response.json({ id }); }
    return new Response('{}', { status: 404 });
  };
  class Socket extends EventTarget {
    constructor() { super(); this.out = []; sockets.push(this); queueMicrotask(() => this.emit({ op: 10, d: { heartbeat_interval: 60000 } })); }
    send(text) { if (JSON.parse(text).op === 2) queueMicrotask(() => this.emit({ op: 0, t: 'READY', s: 1, d: { user: BOT } })); }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code }))); }
    emit(packet) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(packet) })); }
    dm(content, id, reference) {
      this.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id, channel_id: '444444444444444444', author: OWNER, content,
        ...(reference ? { message_reference: { message_id: reference } } : {}) } });
    }
  }
  return { sent, sockets, fetchImpl, WebSocketImpl: Socket };
}

test('Discord: Board messages arrive under a topic header and a reply to one answers that sub-conversation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'board-inbox-discord-')), store = new BootstrapStore(dir, ROOT);
  const discord = fakeDiscord(), A = randomUUID(), inbox = new BoardInbox({ store }), turns = [];
  let bridge;
  const conv = new Conversations({ store, flushMs: 1, boardInbox: inbox, systemPrompt: () => 'persona',
    runner: { turn: async (id, turn) => { turns.push(turn); return turn.prompt.startsWith('This is a private background') ? wakeReply('Codex asks: ship #15?') : { text: 'Passing it on.' }; } },
    onSettled: event => bridge.settled(event) });
  bridge = new DiscordBridge({ links: new DiscordLinks({ store }), conversations: conv, boardInbox: inbox, fetchImpl: discord.fetchImpl, WebSocketImpl: discord.WebSocketImpl, pause: async () => {} });
  t.after(async () => { bridge.stop(); await conv.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const status = await bridge.link(A, TOKEN); await sleep(5);
  const socket = discord.sockets.at(-1);
  socket.dm(status.pairing.code, '700000000000000001'); await sleep(10);
  const wakeId = randomUUID();
  inbox.route(A, 'board-mention-d', { boardThreadId: 'th1', ticketNumber: 15, title: 'Fix *login*' }); inbox.routed(A, 'board-mention-d', wakeId);
  const { threadId } = conv.enqueueProactive(A, { id: wakeId, kind: 'board', prompt: 'Mentioned in th1.' });
  await conv.idle(); await sleep(10);
  const boardMessage = discord.sent.find(item => item.content.includes('Codex asks'));
  assert.ok(boardMessage.content.startsWith('**📋 #15 · Fix login**\n'), boardMessage.content);
  // A reply-to on that DM message goes to the sub-conversation, with the ticket note.
  socket.dm('Yes, ship it.', '700000000000000002', boardMessage.id); await sleep(10); await conv.idle(); await sleep(10);
  const board = await conv.handle(A, { action: 'snapshot', threadId });
  assert.deepEqual(board.messages.map(item => item.role), ['assistant', 'user', 'assistant']);
  assert.match(turns.at(-1).prompt, /Board inbox conversation for ticket #15/);
  assert.ok(discord.sent.at(-1).content.startsWith('**📋 #15 · Fix login**\nPassing it on.'), 'The answer in the DM keeps the topic header');
  // Any other DM is the main chat, as before.
  socket.dm('Unrelated: what is for dinner?', '700000000000000003'); await sleep(10); await conv.idle(); await sleep(10);
  const main = await conv.handle(A, { action: 'snapshot' });
  assert.notEqual(main.threadId, threadId);
  assert.deepEqual(main.messages.map(item => item.text), ['Unrelated: what is for dinner?', 'Passing it on.']);
  assert.equal(discord.sent.at(-1).content, 'Passing it on.');
  assert.doesNotMatch(turns.at(-1).prompt, /Board inbox conversation/);
});

test('the Board inbox actions need the signed-in owner and the same origin rules as the conversation API', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-inbox-http-'));
  const ISSUER = 'https://synthetic.invalid', PA = { issuer: ISSUER, subject: 'board-inbox-http-a' }, PROOF = 'A'.repeat(43);
  const app = await startServer({ dataDir, port: 0, mode: 'account', pilotSubjects: [PA], validateAccount: async proof => proof === PROOF ? PA : null,
    boardOptions: { poll: false }, discordOptions: { connect: false } });
  t.after(async () => { if (app.server.listening) await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const post = async (body, { proof = PROOF, origin = app.url } = {}) => {
    const response = await fetch(app.url + '/api/conversation', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
      ...(proof ? { Cookie: `__Secure-blackout_session=${proof}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await fetch(app.url + '/api/session', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: `__Secure-blackout_session=${PROOF}` }, body: '{}' });
  assert.equal((await post({ action: 'boardInbox' }, { proof: null })).status, 401);
  assert.equal((await post({ action: 'boardArchive', threadId: randomUUID(), archived: true }, { origin: 'https://evil.example' })).status, 403);
  const listed = await post({ action: 'boardInbox' });
  assert.equal(listed.status, 200); assert.deepEqual(listed.body, { version: 1, synthetic: false, threads: [], unread: 0, any: false });
  assert.equal((await post({ action: 'boardArchive', threadId: randomUUID(), archived: true })).status, 404);
  assert.equal((await post({ action: 'boardRead', threadId: 'not-a-uuid' })).status, 400);
});
