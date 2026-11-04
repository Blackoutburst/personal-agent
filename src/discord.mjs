// Discord connection (docs/DISCORD.md): each owner links their own Discord bot. The owner talks to the
// companion in direct messages with the bot; replies and reminders arrive there too.
// The bot token is stored server-side and never returned to any client. Only the one Discord user who
// sent the pairing code can talk to the companion through the bot; everyone else is ignored.
import { randomInt } from 'node:crypto';
import { readFileSync, closeSync } from 'node:fs';
import { ConversationError } from './conversations.mjs';
import { splitBubbles } from '../public/bubbles.mjs';
import { stripFeelingTags } from './wardrobe.mjs';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
// DIRECT_MESSAGES and DIRECT_MESSAGE_TYPING. Message content is always delivered for DMs with the bot; typing
// events let a reply wait while the owner is still typing (neither intent is privileged).
const INTENTS = (1 << 12) | (1 << 14);
const TOKEN = /^[A-Za-z0-9._-]{50,100}$/;
const SNOWFLAKE = /^[0-9]{5,25}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 60 * 60_000;
const DISCORD_CHARS = 2000;
// Attachments the owner sends in the DM are fetched from Discord's CDN into the chat's file store, like app uploads.
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_ATTACHMENTS = 8;
const DOWNLOAD_MS = 60_000;
const CARRY_MS = 6 * 3600_000; // How long a failed file-only message's note waits for the owner's next turn.
const UPLOAD_BYTES = 10 * 1024 ** 2; // Discord's upload limit for a bot in a DM.
const MB = bytes => `${Math.round(bytes / 1024 ** 2 * 10) / 10} MB`;
// #48: why an attachment could not be taken, said briefly to the owner, the server log and the companion.
const REASONS = { FILE_NOT_VOICE: () => 'the recording could not be read', TOO_LARGE: limit => `too large, max ${MB(limit)}`, FILE_QUOTA: () => 'your file storage is full',
  TIMEOUT: () => 'the download from Discord timed out', DOWNLOAD_FAILED: () => 'Discord’s download failed',
  INVALID_ATTACHMENT: () => 'not a Discord file', EMPTY: () => 'the file is empty' };
// Close codes after which reconnecting with the same token can never work.
const FATAL = { 4004: 'INVALID_TOKEN', 4010: 'INVALID_TOKEN', 4011: 'INVALID_TOKEN', 4012: 'INVALID_TOKEN', 4013: 'INVALID_TOKEN', 4014: 'DISALLOWED_INTENTS' };

const SCHEMA = `CREATE TABLE IF NOT EXISTS companion_discord(companion_id TEXT PRIMARY KEY, token TEXT NOT NULL,
  bot_id TEXT NOT NULL UNIQUE, bot_name TEXT NOT NULL, application_id TEXT NOT NULL, code TEXT, code_expires INTEGER,
  user_id TEXT, user_name TEXT, channel_id TEXT, problem TEXT, updated_at INTEGER NOT NULL)`;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

export class DiscordError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'DiscordError'; this.code = code; this.status = status; }
}

export class DiscordLinks {
  #db; #now;
  constructor({ store, now = Date.now }) { this.#db = store.db; this.#now = now; this.#db.exec(SCHEMA); }
  get(companionId) { return this.#db.prepare('SELECT * FROM companion_discord WHERE companion_id=?').get(companionId) ?? null; }
  all() { return this.#db.prepare('SELECT * FROM companion_discord').all(); }
  byBot(botId) { return this.#db.prepare('SELECT companion_id FROM companion_discord WHERE bot_id=?').get(botId)?.companion_id ?? null; }
  save(companionId, { token, botId, botName, applicationId }) {
    this.#db.prepare(`INSERT INTO companion_discord(companion_id,token,bot_id,bot_name,application_id,code,code_expires,user_id,user_name,channel_id,problem,updated_at)
      VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?) ON CONFLICT(companion_id) DO UPDATE SET token=excluded.token, bot_id=excluded.bot_id,
      bot_name=excluded.bot_name, application_id=excluded.application_id, code=NULL, code_expires=NULL, user_id=NULL, user_name=NULL,
      channel_id=NULL, problem=NULL, updated_at=excluded.updated_at`).run(companionId, token, botId, botName, applicationId, this.#now());
  }
  // A fresh pairing code while no Discord user is paired (a code lasts an hour).
  code(companionId) {
    const link = this.get(companionId);
    if (!link || link.user_id) return null;
    if (link.code && link.code_expires > this.#now()) return { code: link.code, expiresAt: link.code_expires };
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = this.#now() + CODE_TTL_MS;
    this.#db.prepare('UPDATE companion_discord SET code=?, code_expires=?, updated_at=? WHERE companion_id=?').run(code, expiresAt, this.#now(), companionId);
    return { code, expiresAt };
  }
  pair(companionId, { userId, userName, channelId }) {
    this.#db.prepare('UPDATE companion_discord SET user_id=?, user_name=?, channel_id=?, code=NULL, code_expires=NULL, updated_at=? WHERE companion_id=?')
      .run(userId, userName, channelId, this.#now(), companionId);
  }
  channel(companionId, channelId) { this.#db.prepare('UPDATE companion_discord SET channel_id=? WHERE companion_id=?').run(channelId, companionId); }
  problem(companionId, problem) { this.#db.prepare('UPDATE companion_discord SET problem=?, updated_at=? WHERE companion_id=?').run(problem, this.#now(), companionId); }
  remove(companionId) { this.#db.prepare('DELETE FROM companion_discord WHERE companion_id=?').run(companionId); }
}

// Splits a reply into Discord-sized messages, preferring paragraph, line and word boundaries.
export function chunks(text, size = DISCORD_CHARS) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < size / 2) cut = window.lastIndexOf(' ');
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// One gateway connection for one bot: heartbeats, reconnects with backoff, stops for good on fatal close codes.
class Gateway {
  #token; #onMessage; #onTyping; #onState; #WebSocket; #socket = null; #beat = null; #acked = true; #seq = null;
  #stopped = false; #retry = 0; #timer = null; botId = null;
  constructor({ token, onMessage, onTyping = () => {}, onState, WebSocketImpl }) {
    this.#token = token; this.#onMessage = onMessage; this.#onTyping = onTyping; this.#onState = onState; this.#WebSocket = WebSocketImpl;
  }
  start() { this.#open(); }
  stop() {
    this.#stopped = true; clearTimeout(this.#timer); clearInterval(this.#beat);
    try { this.#socket?.close(1000); } catch { /* already closed */ }
  }
  #send(payload) { try { this.#socket?.send(JSON.stringify(payload)); } catch { /* reconnect handles it */ } }
  #open() {
    if (this.#stopped) return;
    this.#onState('connecting');
    let socket;
    try { socket = new this.#WebSocket(GATEWAY); } catch { this.#later(); return; }
    this.#socket = socket;
    socket.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); } catch { return; }
      this.#packet(packet);
    });
    socket.addEventListener('close', event => {
      clearInterval(this.#beat); this.#beat = null;
      if (this.#socket !== socket || this.#stopped) return;
      const fatal = FATAL[event.code];
      if (fatal) { this.#stopped = true; this.#onState('error', fatal); return; }
      this.#later();
    });
    socket.addEventListener('error', () => { /* a close event follows */ });
  }
  #later() {
    if (this.#stopped) return;
    this.#onState('connecting');
    const delay = Math.min(60_000, 1000 * 2 ** this.#retry++) + randomInt(1000);
    this.#timer = setTimeout(() => this.#open(), delay);
  }
  #packet({ op, d, s, t }) {
    if (s != null) this.#seq = s;
    if (op === 10) { // HELLO
      const interval = d?.heartbeat_interval ?? 41250;
      this.#acked = true;
      clearInterval(this.#beat);
      this.#beat = setInterval(() => {
        if (!this.#acked) { try { this.#socket?.close(4000); } catch { /* reconnects */ } return; }
        this.#acked = false; this.#send({ op: 1, d: this.#seq });
      }, interval);
      this.#send({ op: 2, d: { token: this.#token, intents: INTENTS, properties: { os: 'linux', browser: 'companion', device: 'companion' } } });
    } else if (op === 11) this.#acked = true;
    else if (op === 1) this.#send({ op: 1, d: this.#seq });
    else if (op === 7) { try { this.#socket?.close(4000); } catch { /* reconnects */ } }
    else if (op === 9) { this.#seq = null; try { this.#socket?.close(4000); } catch { /* reconnects */ } }
    else if (op === 0 && t === 'READY') { this.#retry = 0; this.botId = d?.user?.id ?? null; this.#onState('online'); }
    else if (op === 0 && t === 'MESSAGE_CREATE') this.#onMessage(d);
    else if (op === 0 && t === 'TYPING_START') this.#onTyping(d);
  }
}

export class DiscordBridge {
  #links; #conversations; #files; #fetch; #WebSocket; #gateways = new Map(); #states = new Map(); #pending = new Map(); #log; #notes = new Map(); #carried = new Map(); #pause;
  // files: the chat FileStore. Without it, attachments are refused with a short note.
  constructor({ links, conversations, files = null, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, log = () => {}, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    this.#pause = pause;
    this.#links = links; this.#conversations = conversations; this.#files = files; this.#fetch = fetchImpl; this.#WebSocket = WebSocketImpl; this.#log = log;
  }

  // #48: the failed-attachment note for an owner turn, read once by Conversations (turnNote hook). A message with only
  // failed files starts no turn, so its note waits (up to CARRY_MS) for the owner's next turn, in Discord or the app.
  turnNote(companionId, requestId) {
    const notes = [], carried = this.#carried.get(companionId);
    this.#carried.delete(companionId);
    if (carried && Date.now() - carried.at < CARRY_MS) notes.push(...carried.files);
    notes.push(...(this.#notes.get(requestId) ?? []));
    this.#notes.delete(requestId);
    if (!notes.length) return null;
    return '\n\n(Note from the app, not from the owner: in Discord they also sent '
      + notes.map(item => `“${item.name}” (${item.type}, ${MB(item.size)}), which could not be received: ${item.reason}`).join('; ')
      + '. You cannot see it. If it matters, say so briefly and suggest sending it again or through the app.)';
  }

  start() { for (const link of this.#links.all()) if (!link.problem) this.#connect(link.companion_id, link.token); }
  stop() { for (const gateway of this.#gateways.values()) gateway.stop(); this.#gateways.clear(); }

  // What the owner's settings show. Never includes the token.
  status(companionId) {
    const link = this.#links.get(companionId);
    if (!link) return { linked: false };
    const state = link.problem ? 'error' : this.#states.get(companionId) ?? 'connecting';
    const pairing = this.#links.code(companionId);
    return { linked: true, state, ...(link.problem ? { problem: link.problem } : {}),
      bot: { name: link.bot_name, inviteUrl: `https://discord.com/oauth2/authorize?client_id=${link.application_id}&scope=bot&permissions=0` },
      ...(link.user_id ? { user: { name: link.user_name } } : { pairing }) };
  }

  // Checks the token with Discord, stores it and connects. Replaces any previous bot of this owner.
  async link(companionId, token) {
    if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new DiscordError('INVALID_TOKEN');
    token = token.trim();
    const me = await this.#rest(token, 'GET', '/users/@me').catch(() => null);
    if (!me || !SNOWFLAKE.test(me.id ?? '') || !me.bot) throw new DiscordError('INVALID_TOKEN');
    const app = await this.#rest(token, 'GET', '/oauth2/applications/@me').catch(() => null);
    const owner = this.#links.byBot(me.id);
    if (owner && owner !== companionId) throw new DiscordError('BOT_IN_USE', 409);
    this.#disconnect(companionId);
    this.#links.save(companionId, { token, botId: me.id, botName: String(me.username ?? 'bot').slice(0, 64),
      applicationId: SNOWFLAKE.test(app?.id ?? '') ? app.id : me.id });
    this.#connect(companionId, token);
    return this.status(companionId);
  }

  unlink(companionId) {
    this.#disconnect(companionId);
    this.#links.remove(companionId);
    return { linked: false };
  }

  // Called by Conversations when a turn ends or a proactive message is delivered. Only replies to Discord messages and
  // proactive messages go to the DM; app conversations stay in the app. Files the companion attached follow the text.
  settled({ companionId, requestId, state, text, messageId, proactive }) {
    const channel = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    // Folded into the reply to the owner's next message: that reply answers both.
    if (state === 'merged') { clearInterval(channel?.typing); return; }
    const link = this.#links.get(companionId);
    if (!link || link.problem) return;
    let target = null, reply = '';
    if (channel) {
      clearInterval(channel.typing);
      target = channel.id;
      reply = state === 'complete' ? text : state === 'cancelled' ? (text ? text + '\n\n*(stopped)*' : '*(stopped)*')
        : (text ? text + '\n\n' : '') + '*Something went wrong with that reply. Try again in a moment.*';
    } else if (proactive && link.channel_id) { target = link.channel_id; reply = text; }
    if (!target) return;
    const files = messageId && this.#files ? this.#files.list(messageId).filter(file => file.direction === 'companion') : [];
    (async () => {
      if (reply) await this.#burst(link, target, reply);
      for (const file of files) await this.#sendFile(companionId, link, target, file);
    })().catch(error => this.#log(`Discord delivery failed: ${error.message}`));
  }

  async #sendFile(companionId, link, channelId, file) {
    if (file.size > UPLOAD_BYTES) {
      await this.#say(link, channelId, `*“${file.name}” is too big for Discord. It’s in the app.*`);
      return;
    }
    let bytes;
    try {
      const fd = this.#files.open(this.#files.get(companionId, file.id));
      try { bytes = readFileSync(fd); } finally { closeSync(fd); }
    } catch (error) { this.#log(`Discord file read failed: ${error.code ?? error.message}`); return; }
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ allowed_mentions: { parse: [] }, ...(file.caption ? { content: file.caption.slice(0, DISCORD_CHARS) } : {}),
      attachments: [{ id: 0, filename: file.name }] }));
    form.append('files[0]', new Blob([bytes], { type: file.mime || 'application/octet-stream' }), file.name);
    try { await this.#rest(link.token, 'POST', `/channels/${channelId}/messages`, form); }
    catch (error) {
      this.#log(`Discord file send failed: ${error.message}`);
      await this.#say(link, channelId, `*I couldn’t post “${file.name}” here. It’s in the app.*`);
    }
  }

  #connect(companionId, token) {
    const gateway = new Gateway({ token, WebSocketImpl: this.#WebSocket,
      onState: (state, problem) => {
        if (this.#gateways.get(companionId) !== gateway) return;
        this.#states.set(companionId, state);
        if (problem) { this.#links.problem(companionId, problem); this.#gateways.delete(companionId); }
      },
      onMessage: message => { if (this.#gateways.get(companionId) === gateway) this.#message(companionId, message).catch(() => {}); },
      onTyping: typing => { if (this.#gateways.get(companionId) === gateway) this.#typing(companionId, typing); } });
    this.#gateways.set(companionId, gateway);
    this.#states.set(companionId, 'connecting');
    gateway.start();
  }

  #disconnect(companionId) {
    this.#gateways.get(companionId)?.stop();
    this.#gateways.delete(companionId);
    this.#states.delete(companionId);
  }

  // The paired owner typing in the DM: a reply still waiting for them keeps waiting (texting, Conversations).
  #typing(companionId, typing) {
    const link = this.#links.get(companionId);
    if (!link?.user_id || typing?.guild_id || typing?.user_id !== link.user_id || typing?.channel_id !== link.channel_id) return;
    try { this.#conversations.discordTyping?.(companionId); } catch { /* typing is only a hint */ }
  }

  async #message(companionId, message) {
    const link = this.#links.get(companionId);
    if (!link || message?.guild_id || message?.author?.bot || !SNOWFLAKE.test(message?.channel_id ?? '')
        || !SNOWFLAKE.test(message?.author?.id ?? '') || !SNOWFLAKE.test(message?.id ?? '')) return;
    const text = typeof message.content === 'string' ? message.content.trim() : '';
    if (!link.user_id) {
      const pairing = this.#links.code(companionId);
      if (pairing && text.toUpperCase() === pairing.code) {
        this.#links.pair(companionId, { userId: message.author.id, userName: String(message.author.global_name ?? message.author.username ?? 'you').slice(0, 64),
          channelId: message.channel_id });
        await this.#say(link, message.channel_id, 'Linked! You can talk to me here now. 👋');
      }
      return;
    }
    if (message.author.id !== link.user_id) return; // Only the paired owner.
    if (message.channel_id !== link.channel_id) this.#links.channel(companionId, message.channel_id);
    const sent = Array.isArray(message.attachments) ? message.attachments : [];
    if (!text && !sent.length) { await this.#say(link, message.channel_id, '*I can only read text and files.*'); return; }
    if (text.length > 8000) { await this.#say(link, message.channel_id, '*That message is too long for me (8,000 characters at most).*'); return; }
    if (sent.length && !this.#files) { await this.#say(link, message.channel_id, '*I can’t receive files here yet. Send them in the app.*'); return; }
    if (sent.length > MAX_ATTACHMENTS) { await this.#say(link, message.channel_id, `*Send at most ${MAX_ATTACHMENTS} files per message.*`); return; }
    const requestId = 'discord-' + message.id;
    try {
      const threadId = this.#conversations.ongoingThread(companionId);
      const typing = setInterval(() => this.#rest(link.token, 'POST', `/channels/${message.channel_id}/typing`).catch(() => {}), 8000);
      this.#pending.set(requestId, { id: message.channel_id, typing });
      this.#rest(link.token, 'POST', `/channels/${message.channel_id}/typing`).catch(() => {});
      // Discord's own voice messages (flag IS_VOICE_MESSAGE) stay voice messages here too; the companion reads the transcript.
      const voice = Boolean(Number(message.flags ?? 0) & (1 << 13)) && Boolean(this.#files.asr);
      const { ids, skipped } = await this.#download(companionId, threadId, message.id, sent, voice);
      if (skipped.length) await this.#say(link, message.channel_id, `*I couldn’t receive ${skipped.map(item => `“${item.name}” (${item.reason})`).join(', ')}${
        ids.length || text ? '; answering the rest' : ''}.*`);
      if (!ids.length && !text) {
        clearInterval(typing); this.#pending.delete(requestId);
        const carried = this.#carried.get(companionId)?.files ?? [];
        this.#carried.set(companionId, { at: Date.now(), files: [...carried, ...skipped].slice(-MAX_ATTACHMENTS) });
        return;
      }
      if (skipped.length) this.#notes.set(requestId, skipped);
      await this.#conversations.handle(companionId, { action: 'submit', requestId, threadId, text,
        ...(ids.length ? { attachments: ids } : {}) });
    } catch (error) {
      clearInterval(this.#pending.get(requestId)?.typing);
      this.#pending.delete(requestId); this.#notes.delete(requestId);
      const busy = error instanceof ConversationError && error.code === 'BUSY';
      await this.#say(link, message.channel_id, busy ? '*I’m still answering something else. Send it again in a moment.*'
        : '*I couldn’t take that message right now. Try again in a moment.*');
    }
  }

  // Fetches each Discord attachment into the chat file store. Returns the stored ids and, for the others, why not.
  // The bytes actually received are stored: Discord's declared size can differ from what its CDN serves (#48).
  async #download(companionId, threadId, messageId, attachments, voice = false) {
    const ids = [], skipped = [];
    for (const attachment of attachments) {
      const name = safeName(attachment?.filename), declared = Number.isSafeInteger(attachment?.size) ? attachment.size : 0;
      const type = typeof attachment?.content_type === 'string' ? attachment.content_type.split(';')[0].slice(0, 60) : 'unknown type';
      const limit = type.startsWith('video/') ? this.#files.limits.video : this.#files.limits.normal;
      let received = 0, status = 0;
      try {
        const url = new URL(String(attachment?.url ?? ''));
        if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || !SNOWFLAKE.test(attachment?.id ?? '')) fail('INVALID_ATTACHMENT');
        if (declared > limit) fail('TOO_LARGE');
        const response = await this.#fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(DOWNLOAD_MS),
          headers: { 'User-Agent': 'DiscordBot (https://blackoutburst.com, 1.0)' } }).catch(error => fail(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'DOWNLOAD_FAILED'));
        status = response.status;
        if (!response.ok || !response.body) fail('DOWNLOAD_FAILED');
        if (Number(response.headers?.get?.('content-length')) > limit) fail('TOO_LARGE');
        const chunks = [];
        try {
          for await (const value of response.body) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            received += chunk.length;
            if (received > limit) fail('TOO_LARGE');
            chunks.push(chunk);
          }
        } catch (error) { if (typeof error.code === 'string') throw error; fail(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'DOWNLOAD_FAILED'); }
        if (!received) fail('EMPTY');
        if (received !== declared) this.#log(`Discord attachment size differs: declared ${declared} bytes, received ${received} (${type})`);
        const file = await this.#files.upload(companionId, { threadId, requestId: `dc-${messageId}-${attachment.id}`, name,
          size: received, ...(voice && /^audio\//.test(type) ? { voice: true } : {}) }, [Buffer.concat(chunks)]).catch(error => fail(error.code === 'FILE_TOO_LARGE' ? 'TOO_LARGE' : error.code === 'FILE_QUOTA' ? 'FILE_QUOTA' : error.code ?? 'SAVE_FAILED'));
        ids.push(file.id);
      } catch (error) {
        const code = typeof error.code === 'string' ? error.code : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'DOWNLOAD_FAILED';
        // Sizes, type and status only: no file names or links in the log.
        this.#log(`Discord attachment skipped: ${code} (${type}, declared ${declared} bytes, received ${received}${status ? `, HTTP ${status}` : ''}, limit ${limit})`);
        skipped.push({ name, type, size: declared || received, reason: (REASONS[code] ?? (() => 'it couldn’t be saved'))(limit) });
      }
    }
    return { ids, skipped };
  }

  // Like a person texting: each paragraph is its own Discord message, with a short typing pause in between.
  async #burst(link, channelId, text) {
    const bubbles = splitBubbles(stripFeelingTags(text).text);
    for (const [index, bubble] of bubbles.entries()) {
      if (index) {
        this.#rest(link.token, 'POST', `/channels/${channelId}/typing`).catch(() => {});
        await this.#pause(Math.min(1800, 500 + bubble.length * 12));
      }
      if (!await this.#say(link, channelId, bubble)) return;
    }
  }

  async #say(link, channelId, text) {
    for (const content of chunks(text)) {
      try { await this.#rest(link.token, 'POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [] } }); }
      catch (error) { this.#log(`Discord send failed: ${error.message}`); return false; }
    }
    return true;
  }

  async #rest(token, method, path, body, retried = false) {
    const response = await this.#fetch(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: 'Bot ' + token, 'User-Agent': 'DiscordBot (https://blackoutburst.com, 1.0)',
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    if (response.status === 429 && !retried) {
      const wait = Math.min(10, Number((await response.json().catch(() => ({}))).retry_after) || 1);
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      return this.#rest(token, method, path, body, true);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
}

function safeName(value) {
  const name = String(value ?? '').replace(/[\x00-\x1f\x7f/\\]/g, '_').trim().slice(0, 200);
  return name && name !== '.' && name !== '..' && name.isWellFormed() ? name : 'file';
}
