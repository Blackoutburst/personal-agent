import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations, ConversationError } from '../src/conversations.mjs';
import { DiscordLinks, DiscordBridge, chunks } from '../src/discord.mjs';
import { FileStore } from '../src/files.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'MTA' + 'x'.repeat(56) + '.Gabcde.' + 'y'.repeat(30);
const BOT = { id: '111111111111111111', username: 'pip-bot', bot: true };
const OWNER = { id: '222222222222222222', username: 'blackout', global_name: 'Blackout' };
const STRANGER = { id: '333333333333333333', username: 'someone' };

// A fake Discord: REST over fetch and a gateway socket the test drives.
function fakeDiscord({ me = BOT } = {}) {
  const sent = [], sockets = [];
  const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 7)]);
  const fetchImpl = async (url, spec) => {
    if (new URL(url).hostname === 'cdn.discordapp.com') {
      assert.equal(spec.headers.Authorization, undefined, 'The bot token never goes to the CDN');
      return url.includes('missing') ? new Response('', { status: 404 }) : new Response(PNG);
    }
    const path = new URL(url).pathname.replace('/api/v10', '');
    assert.equal(spec.headers.Authorization, 'Bot ' + TOKEN);
    if (path === '/users/@me') return me ? Response.json(me) : new Response('{}', { status: 401 });
    if (path === '/oauth2/applications/@me') return Response.json({ id: '999999999999999999' });
    if (path.endsWith('/typing')) return new Response(null, { status: 204 });
    if (path.endsWith('/messages')) { sent.push({ channel: path.split('/')[2], ...JSON.parse(spec.body) }); return Response.json({ id: '1' }); }
    return new Response('{}', { status: 404 });
  };
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.out = []; sockets.push(this); queueMicrotask(() => this.emit({ op: 10, d: { heartbeat_interval: 60000 } })); }
    send(text) { this.out.push(JSON.parse(text)); if (JSON.parse(text).op === 2) queueMicrotask(() => this.emit({ op: 0, t: 'READY', s: 1, d: { user: BOT } })); }
    close(code = 1000) { queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code }))); }
    emit(packet) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(packet) })); }
    dm(author, content, id = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0'), attachments) {
      this.emit({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id, channel_id: '444444444444444444', author, content,
        ...(attachments ? { attachments } : {}) } });
    }
  }
  return { sent, sockets, fetchImpl, WebSocketImpl: Socket, PNG };
}

function fixture(t, { handler, me, withFiles = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-')), store = new BootstrapStore(dir, ROOT);
  const discord = fakeDiscord({ me }), companionId = randomUUID();
  const files = withFiles ? new FileStore({ store, dataDir: dir, workspaceFor: () => ({ dir }) }) : null;
  let bridge;
  const conversations = new Conversations({ store, flushMs: 1, systemPrompt: () => 'persona', files,
    runner: { turn: async (id, turn) => (handler ?? (() => ({ text: 'Hello from Pip!' })))(id, turn) },
    onSettled: event => bridge.settled(event) });
  const links = new DiscordLinks({ store });
  bridge = new DiscordBridge({ links, conversations, files, fetchImpl: discord.fetchImpl, WebSocketImpl: discord.WebSocketImpl });
  t.after(async () => { bridge.stop(); await conversations.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, discord, companionId, conversations, links, bridge };
}

async function linked(t, options) {
  const f = fixture(t, options);
  const status = await f.bridge.link(f.companionId, TOKEN);
  await sleep(5);
  f.socket = f.discord.sockets.at(-1);
  f.socket.dm(OWNER, status.pairing.code.toLowerCase());
  await sleep(10);
  return f;
}

test('linking checks the token with Discord, never returns it, and gives an invite link and pairing code', async t => {
  const f = fixture(t);
  const status = await f.bridge.link(f.companionId, ' ' + TOKEN + ' ');
  assert.equal(status.linked, true);
  assert.equal(status.bot.name, 'pip-bot');
  assert.match(status.bot.inviteUrl, /client_id=999999999999999999&scope=bot&permissions=0$/);
  assert.match(status.pairing.code, /^[A-Z2-9]{8}$/);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  await sleep(5);
  assert.equal(f.bridge.status(f.companionId).state, 'online');
  const identify = f.discord.sockets[0].out.find(packet => packet.op === 2);
  assert.equal(identify.d.token, TOKEN);
  assert.equal(identify.d.intents, 4096);
  assert.equal(f.bridge.status(f.companionId).pairing.code, status.pairing.code, 'The code stays the same until it expires');
});

test('a bad token or a non-bot account is refused and nothing is stored', async t => {
  const f = fixture(t, { me: null });
  await assert.rejects(f.bridge.link(f.companionId, TOKEN), { code: 'INVALID_TOKEN' });
  await assert.rejects(f.bridge.link(f.companionId, 'short'), { code: 'INVALID_TOKEN' });
  assert.deepEqual(f.bridge.status(f.companionId), { linked: false });
  const g = fixture(t, { me: { ...BOT, bot: false } });
  await assert.rejects(g.bridge.link(g.companionId, TOKEN), { code: 'INVALID_TOKEN' });
});

test('one bot belongs to one companion', async t => {
  const f = fixture(t);
  await f.bridge.link(f.companionId, TOKEN);
  await assert.rejects(f.bridge.link(randomUUID(), TOKEN), { code: 'BOT_IN_USE' });
});

test('only the pairing code pairs; afterwards only the paired user is heard', async t => {
  const f = fixture(t);
  const { pairing } = await f.bridge.link(f.companionId, TOKEN);
  await sleep(5);
  const socket = f.discord.sockets[0];
  socket.dm(STRANGER, 'hello?');
  socket.dm(OWNER, 'WRONGCODE');
  await sleep(10);
  assert.equal(f.discord.sent.length, 0, 'Strangers and wrong codes get no answer');
  socket.dm(OWNER, pairing.code);
  await sleep(10);
  const status = f.bridge.status(f.companionId);
  assert.deepEqual(status.user, { name: 'Blackout' });
  assert.equal(status.pairing, undefined);
  assert.match(f.discord.sent[0].content, /^Linked!/);
  socket.dm(STRANGER, 'let me in');
  socket.dm({ ...OWNER, bot: true }, 'a bot echo');
  socket.emit({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: '555555555555555555', guild_id: '1234567', channel_id: '444444444444444444', author: OWNER, content: 'in a server' } });
  await sleep(20);
  assert.equal(f.discord.sent.length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 0);
});

test('a DM from the owner becomes a turn in the ongoing chat and the reply comes back in Discord', async t => {
  const f = await linked(t, { handler: () => ({ text: '[feeling:happy] Hi! ' + 'word '.repeat(500) }) });
  f.socket.dm(OWNER, 'Hi Pip');
  await f.conversations.idle(); await sleep(10);
  const thread = f.conversations.ongoingThread(f.companionId);
  const rows = f.store.db.prepare('SELECT role, text, feeling FROM conv_messages WHERE thread_id=? ORDER BY created_at, rowid').all(thread);
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant']);
  assert.equal(rows[0].text, 'Hi Pip');
  assert.equal(rows[1].feeling, 'happy');
  const replies = f.discord.sent.slice(1);
  assert.equal(replies.length, 2, 'A long reply is split into Discord-sized messages');
  assert.ok(replies.every(reply => reply.content.length <= 2000 && reply.channel === '444444444444444444'));
  assert.ok(!replies[0].content.includes('[feeling'), 'The feeling tag never shows');
  assert.deepEqual(replies[0].allowed_mentions, { parse: [] });
});

test('Discord turns carry a channel note; the stored message is only what the owner wrote', async t => {
  const turns = [];
  const f = await linked(t, { handler: (_id, turn) => { turns.push(turn); return { text: 'Hey!' }; } });
  f.socket.dm(OWNER, 'Are we on Discord?');
  await f.conversations.idle(); await sleep(10);
  assert.match(turns[0].prompt, /^Are we on Discord\?/);
  assert.match(turns[0].prompt, /Discord DM with you/);
  assert.match(turns[0].prompt, /not tables/);
  const stored = f.store.db.prepare("SELECT text FROM conv_messages WHERE role='user'").get().text;
  assert.equal(stored, 'Are we on Discord?');
});

test('attachments from the DM are fetched into the chat and shown to the companion like app uploads', async t => {
  const turns = [];
  const f = await linked(t, { withFiles: true, handler: (_id, turn) => { turns.push(turn); return { text: 'Nice screenshot.' }; } });
  const png = f.discord.PNG;
  const shot = { id: '666666666666666666', filename: 'Capture d’écran.png', size: png.length,
    url: 'https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1&hm=2', content_type: 'image/png' };
  f.socket.dm(OWNER, '', '777777777777777777', [shot]);
  await f.conversations.idle(); await sleep(10);
  assert.equal(turns.length, 1, 'An image-only message is a turn');
  assert.equal(turns[0].images.length, 1);
  assert.match(turns[0].prompt, /Capture d’écran\.png/);
  const file = f.store.db.prepare('SELECT name, mime, size, message_id FROM conv_files').get();
  assert.deepEqual({ ...file, message_id: Boolean(file.message_id) }, { name: 'Capture d’écran.png', mime: 'image/png', size: png.length, message_id: true });
  assert.equal(f.discord.sent.at(-1).content, 'Nice screenshot.');
  // Foreign hosts and failed downloads are skipped with a note; the text still gets an answer.
  f.socket.dm(OWNER, 'And these?', '888888888888888888', [
    { ...shot, id: '666666666666666667', filename: 'evil.png', url: 'https://example.com/evil.png' },
    { ...shot, id: '666666666666666668', filename: 'gone.png', url: 'https://cdn.discordapp.com/attachments/missing.png' }]);
  await f.conversations.idle(); await sleep(10);
  assert.ok(f.discord.sent.some(item => /couldn’t receive “evil\.png”, “gone\.png”; answering the rest/.test(item.content)));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].images.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files').get().n, 1);
});

test('without a file store, attachments get a short refusal and no turn', async t => {
  const f = await linked(t);
  f.socket.dm(OWNER, '', '999999999999999990', [{ id: '666666666666666666', filename: 'a.png', size: 10, url: 'https://cdn.discordapp.com/a.png' }]);
  await sleep(20);
  assert.match(f.discord.sent.at(-1).content, /can’t receive files here yet/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 0);
});

test('a busy chat answers politely instead of losing the message', async t => {
  let release;
  const f = await linked(t, { handler: () => new Promise(resolve => { release = () => resolve({ text: 'done' }); }) });
  f.socket.dm(OWNER, 'first');
  await sleep(10);
  f.socket.dm(OWNER, 'second');
  await sleep(10);
  assert.match(f.discord.sent.at(-1).content, /still answering/);
  release(); await f.conversations.idle(); await sleep(10);
  assert.equal(f.discord.sent.at(-1).content, 'done');
});

test('proactive messages (reminders) are sent to the paired DM', async t => {
  const f = await linked(t, { handler: () => ({ text: JSON.stringify({ action: 'message', text: 'Time to check the oven!' }) }) });
  f.conversations.enqueueProactive(f.companionId, { id: randomUUID(), kind: 'reminder', prompt: 'oven' });
  await f.conversations.idle(); await sleep(10);
  assert.equal(f.discord.sent.at(-1).content, 'Time to check the oven!');
});

test('a fatal close stops reconnecting and shows the problem; unlinking forgets everything', async t => {
  const f = fixture(t);
  await f.bridge.link(f.companionId, TOKEN);
  await sleep(5);
  f.discord.sockets[0].close(4004);
  await sleep(5);
  const status = f.bridge.status(f.companionId);
  assert.equal(status.state, 'error');
  assert.equal(status.problem, 'INVALID_TOKEN');
  assert.equal(f.discord.sockets.length, 1);
  assert.deepEqual(f.bridge.unlink(f.companionId), { linked: false });
  assert.equal(f.links.get(f.companionId), null);
});

test('chunks splits on paragraph, line or word boundaries', () => {
  assert.deepEqual(chunks('short'), ['short']);
  const parts = chunks('a'.repeat(1500) + '\n\n' + 'b'.repeat(1500));
  assert.deepEqual(parts.map(part => part.length), [1500, 1500]);
  assert.ok(chunks('x'.repeat(4500)).every(part => part.length <= 2000));
});

test('ConversationError is what the bridge treats as busy', () => assert.equal(new ConversationError('BUSY', 409).code, 'BUSY'));
