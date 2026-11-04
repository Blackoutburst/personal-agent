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
    if (path.endsWith('/messages') && spec.body instanceof FormData) {
      const file = spec.body.get('files[0]');
      sent.push({ channel: path.split('/')[2], ...JSON.parse(spec.body.get('payload_json')), file: { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) } });
      return Response.json({ id: '1' });
    }
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

function fixture(t, { handler, me, withFiles = false, gatherMs = 0, texting = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-')), store = new BootstrapStore(dir, ROOT);
  const discord = fakeDiscord({ me }), companionId = randomUUID();
  const files = withFiles ? new FileStore({ store, dataDir: dir, workspaceFor: () => ({ dir }), limits: { normal: 1024 } }) : null;
  let bridge;
  const conversations = new Conversations({ store, flushMs: 1, systemPrompt: () => 'persona', files, gatherMs, texting,
    runner: { turn: async (id, turn) => (handler ?? (() => ({ text: 'Hello from Pip!' })))(id, turn) },
    onSettled: event => bridge.settled(event), turnNote: (id, requestId) => bridge.turnNote(id, requestId) });
  const links = new DiscordLinks({ store });
  bridge = new DiscordBridge({ links, conversations, files, fetchImpl: discord.fetchImpl, WebSocketImpl: discord.WebSocketImpl, pause: async () => {} });
  t.after(async () => { bridge.stop(); await conversations.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, discord, companionId, conversations, links, bridge, dir };
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
  assert.equal(identify.d.intents, 4096 | 16384, 'DMs and DM typing');
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

test('a reply with several paragraphs arrives as several short Discord messages, lists and code kept whole', async t => {
  const f = await linked(t, { handler: () => ({ text: 'oh no\n\nwait is koko cheating\n\n- one\n\n- two\n\n```\na\n\nb\n```' }) });
  f.socket.dm(OWNER, 'koko is cheating ?');
  await f.conversations.idle(); await sleep(10);
  assert.deepEqual(f.discord.sent.slice(1).map(reply => reply.content), ['oh no', 'wait is koko cheating', '- one\n\n- two', '```\na\n\nb\n```']);
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
  // #48: each one says why, and the companion's turn is told which files it can't see.
  assert.ok(f.discord.sent.some(item => item.content.includes('couldn’t receive “evil.png” (not a Discord file), “gone.png” (Discord’s download failed); answering the rest')),
    f.discord.sent.map(item => item.content).join(' | '));
  assert.equal(turns.length, 2);
  assert.equal(turns[1].images.length, 0);
  assert.match(turns[1].prompt, /^And these\?\n\n\(Note from the app, not from the owner: in Discord they also sent “evil\.png” \(image\/png, 0 MB\), which could not be received: not a Discord file; “gone\.png”/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files').get().n, 1);
  // Discord's declared size can be smaller than what its CDN serves (the IMG_3396 case): the real bytes are stored.
  f.socket.dm(OWNER, '', '888888888888888889', [{ ...shot, id: '666666666666666669', filename: 'IMG_3396.png', size: png.length - 20 }]);
  await f.conversations.idle(); await sleep(10);
  assert.equal(turns.length, 3); assert.equal(turns[2].images.length, 1);
  assert.doesNotMatch(turns[2].prompt, /Note from the app/, 'The note was for one turn only');
  assert.equal(f.store.db.prepare("SELECT size FROM conv_files WHERE name='IMG_3396.png'").get().size, png.length);
  // Over the limit: refused before downloading, with the limit in the notice; no turn without text.
  const before = turns.length;
  f.socket.dm(OWNER, '', '888888888888888890', [{ ...shot, id: '666666666666666670', filename: 'huge.png', size: 5000 }]);
  await f.conversations.idle(); await sleep(10);
  assert.equal(f.discord.sent.at(-1).content, '*I couldn’t receive “huge.png” (too large, max 0 MB).*');
  assert.equal(turns.length, before);
  // That file-only failure starts no turn, so its note goes with the owner's next turn, once.
  f.socket.dm(OWNER, 'Did you get it?', '888888888888888891');
  await f.conversations.idle(); await sleep(10);
  assert.match(turns.at(-1).prompt, /^Did you get it\?\n\n\(Note from the app, not from the owner: in Discord they also sent “huge\.png” \(image\/png, 0 MB\), which could not be received: too large, max 0 MB\./);
  f.socket.dm(OWNER, 'Ok', '888888888888888892');
  await f.conversations.idle(); await sleep(10);
  assert.doesNotMatch(turns.at(-1).prompt, /Note from the app/);
});

test('files the companion attaches go to the DM after the text; app-only turns never reach Discord', async t => {
  const f = await linked(t, { withFiles: true });
  const thread = f.conversations.ongoingThread(f.companionId), png = f.discord.PNG;
  const store = new FileStore({ store: f.store, dataDir: f.dir, workspaceFor: () => ({ dir: f.dir }) });
  const message = () => {
    const id = randomUUID();
    f.store.db.prepare('INSERT INTO conv_messages(id,thread_id,role,text,created_at) VALUES(?,?,?,?,?)').run(id, thread, 'assistant', '', Date.now());
    return id;
  };
  const withFile = async (name, bytes, caption) => {
    const id = message();
    const file = await store.upload(f.companionId, { threadId: thread, requestId: 'out-' + randomUUID(), name, size: bytes.length,
      direction: 'companion', ...(caption ? { caption } : {}) }, [bytes]);
    store.tx(() => store.bindInTransaction(f.companionId, thread, id, [file.id], 'companion'));
    return id;
  };
  const before = f.discord.sent.length;
  f.bridge.settled({ companionId: f.companionId, requestId: 'app-turn', state: 'complete', text: 'App reply', messageId: await withFile('app.png', png), proactive: false });
  await sleep(20);
  assert.equal(f.discord.sent.length, before, 'A turn started in the app is not mirrored to Discord');
  f.bridge.settled({ companionId: f.companionId, requestId: 'wake-1', state: 'complete', text: 'Here is the chart',
    messageId: await withFile('chart.png', png, 'Weekly chart'), proactive: true });
  await sleep(20);
  const [text, upload] = f.discord.sent.slice(before);
  assert.equal(text.content, 'Here is the chart');
  assert.equal(upload.file.name, 'chart.png');
  assert.ok(upload.file.bytes.equals(png));
  assert.equal(upload.content, 'Weekly chart');
  assert.deepEqual(upload.allowed_mentions, { parse: [] });
});

test('without a file store, attachments get a short refusal and no turn', async t => {
  const f = await linked(t);
  f.socket.dm(OWNER, '', '999999999999999990', [{ id: '666666666666666666', filename: 'a.png', size: 10, url: 'https://cdn.discordapp.com/a.png' }]);
  await sleep(20);
  assert.match(f.discord.sent.at(-1).content, /can’t receive files here yet/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages').get().n, 0);
});

test('a message sent while the companion is replying gets its own reply right after', async t => {
  const prompts = [], releases = [];
  const f = await linked(t, { handler: (_id, turn) => { prompts.push(turn.prompt); return new Promise(resolve => releases.push(() => resolve({ text: 'reply ' + releases.length }))); } });
  f.socket.dm(OWNER, 'first');
  await sleep(10);
  f.socket.dm(OWNER, 'second');
  await sleep(10);
  assert.ok(!f.discord.sent.some(message => /still answering/.test(message.content)));
  releases[0](); await sleep(20); releases[1](); await f.conversations.idle(); await sleep(10);
  assert.deepEqual(f.discord.sent.slice(-2).map(message => message.content), ['reply 1', 'reply 2']);
  assert.match(prompts[1], /^second/);
});

test('several short DMs sent close together get one reply that sees them all', async t => {
  const prompts = [];
  const f = await linked(t, { gatherMs: 80, handler: (_id, turn) => { prompts.push(turn.prompt); return { text: 'unlucky' }; } });
  const before = f.discord.sent.length;
  f.socket.dm(OWNER, 'koko is cheating ?'); await sleep(20);
  f.socket.dm(OWNER, 'need to check 2s'); await sleep(20);
  f.socket.dm(OWNER, 'yes he is');
  await sleep(250); await f.conversations.idle(); await sleep(10);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^koko is cheating \?\nneed to check 2s\nyes he is/);
  assert.deepEqual(f.discord.sent.slice(before).map(message => message.content), ['unlucky']);
  const thread = f.conversations.ongoingThread(f.companionId);
  const turns = f.store.db.prepare('SELECT state FROM conv_turns WHERE thread_id=? ORDER BY rowid').all(thread).map(row => row.state);
  assert.deepEqual(turns, ['merged', 'merged', 'complete']);
});

test('the owner typing in the DM keeps a waiting reply waiting; a stranger typing does not', async t => {
  const prompts = [];
  const f = await linked(t, { gatherMs: 40, texting: true, handler: (_id, turn) => { prompts.push(turn.prompt); return { text: 'yeah' }; } });
  const typing = user_id => f.socket.emit({ op: 0, t: 'TYPING_START', s: 9, d: { channel_id: '444444444444444444', user_id, timestamp: 1 } });
  f.socket.dm(OWNER, 'so');
  await sleep(15);
  typing(OWNER.id); // they start typing the next text
  await sleep(250);
  assert.equal(prompts.length, 0, 'waits while Discord says they are typing');
  f.socket.dm(OWNER, 'did you see the patch notes');
  await sleep(250); await f.conversations.idle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^so\ndid you see the patch notes/);
  f.socket.dm(OWNER, 'ok');
  await sleep(15);
  typing('999999999999999999');
  await sleep(250); await f.conversations.idle();
  assert.equal(prompts.length, 2, 'only the paired owner typing holds a reply');
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
