// t70: the connection-level fixes for 26.1: the "last seen" acknowledgements chat lines carry (checked against a port
// of the 26.1.2 server's LastSeenMessagesValidator), her own oxygen, kick reasons as NBT components, a server that
// enforces secure chat. Fakes only: no server, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { patchChatAcks, patchOxygen, ownOxygen, disconnectReason, watchSecureChat, isSecureChatError, SECURE_CHAT_REASON, LAST_SEEN } from '../src/minecraft-body.mjs';
import { reconnectDelay } from '../src/minecraft.mjs';

// The server side, as read from the Paper 26.1.2 jar (net.minecraft.network.chat.LastSeenMessagesValidator).
class Validator {
  constructor() { this.tracked = new Array(LAST_SEEN).fill(null); this.lastPending = null; }
  addPending(signature) { if (this.lastPending?.equals(signature)) return; this.tracked.push({ signature, pending: true }); this.lastPending = signature; }
  applyOffset(offset) {
    const max = this.tracked.length - LAST_SEEN;
    if (offset < 0 || offset > max) throw new Error(`Advanced last seen window by ${offset} messages, but expected at most ${max}`);
    this.tracked.splice(0, offset);
  }
  applyUpdate({ offset, acknowledged, checksum }) {
    this.applyOffset(offset);
    const seen = [];
    for (let j = 0; j < LAST_SEEN; j++) {
      const bit = (acknowledged[j >> 3] >> (j & 7)) & 1, entry = this.tracked[j];
      if (bit) { if (!entry) throw new Error(`acknowledged unknown message at index ${j}`); entry.pending = false; seen.push(entry.signature); }
      else if (entry && !entry.pending) throw new Error(`ignored previously acknowledged message at index ${j}`);
      else this.tracked[j] = null;
    }
    if (checksum !== 0) {
      let sum = 1;
      for (const signature of seen) { let h = 1; for (const byte of signature) h = (31 * h + ((byte << 24) >> 24)) | 0; sum = (31 * sum + h) | 0; }
      const expected = ((sum << 24) >> 24) || 1;
      if ((expected & 0xff) !== (checksum & 0xff)) throw new Error('Checksum mismatch on last seen update');
    }
  }
}

const PACKET = { timestamp: BigInt(Date.now()), previousMessages: [], senderUuid: 'u', index: 0, salt: 1n, type: {} };
function chatClient() {
  const client = new EventEmitter(), server = new Validator(), sent = [];
  client.write = (name, params) => {
    sent.push([name, params]);
    if (name === 'chat_message') server.applyUpdate(params);
    else if (name === 'chat_command_signed') server.applyUpdate({ offset: params.messageCount, acknowledged: params.acknowledged, checksum: params.checksum });
    else if (name === 'message_acknowledgement') server.applyOffset(params.count);
  };
  const incoming = (signature = randomBytes(256)) => { server.addPending(signature); client.emit('player_chat', { signature, plainMessage: 'hi', ...PACKET }); return signature; };
  const unsigned = () => client.emit('player_chat', { signature: undefined, plainMessage: 'unsigned', ...PACKET });
  return { client, server, sent, incoming, unsigned };
}

test('t70: chat lines and commands acknowledge what the server sent, in its order, past 20 messages and around unsigned commands', () => {
  const { client, sent, incoming, unsigned } = chatClient();
  assert.equal(patchChatAcks(client), true);
  assert.equal(patchChatAcks(client), true, 'idempotent');
  const say = message => client.write('chat_message', { message, timestamp: 1n, salt: 1n, offset: 0, acknowledged: Buffer.alloc(3), checksum: 1 });
  const command = command => client.write('chat_command', { command });
  // More than 20 signed messages since login (minecraft-protocol's checksum broke here) and a line after each.
  for (let i = 0; i < 30; i++) { incoming(); say('line ' + i); }
  // An unsigned /command carries no acknowledgements and must not reset the count (minecraft-protocol's second bug).
  incoming(); incoming(); command('help'); incoming(); unsigned(); say('after the command');
  // A message the server sent twice in a row counts once, like on the server.
  const twice = incoming(); client.emit('player_chat', { signature: twice, plainMessage: 'hi', ...PACKET }); say('after a repeat');
  // The window keeps acknowledging what it acknowledged before.
  say('again'); say('and again');
  client.write('chat_command_signed', { command: 'msg Cirno hi', timestamp: 1n, salt: 1n, argumentSignatures: [], messageCount: 0, acknowledged: Buffer.alloc(3), checksum: 1 });
  const lines = sent.filter(([name]) => name === 'chat_message');
  assert.equal(lines.length, 34);
  assert.ok(lines.every(([, params]) => params.checksum === 0), 'checksum 0: the server does not check it');
  assert.deepEqual(sent.find(([name]) => name === 'chat_command')[1], { command: 'help' }, 'unsigned commands go out as they are');
});

test('t70: more than 64 unacknowledged messages send one acknowledgement; minecraft-protocol\'s own ones are dropped', () => {
  const { client, sent, incoming } = chatClient();
  patchChatAcks(client);
  client.write('message_acknowledgement', { count: 99 });
  assert.equal(sent.length, 0, 'minecraft-protocol\'s own acknowledgement is dropped');
  for (let i = 0; i < 65; i++) incoming();
  assert.deepEqual(sent.map(([name, params]) => [name, params.count]), [['message_acknowledgement', 65]]);
  for (let i = 0; i < 3; i++) incoming();
  client.write('chat_message', { message: 'hi', offset: 0, acknowledged: Buffer.alloc(3), checksum: 1 });
  assert.equal(sent.at(-1)[1].offset, 3);
});

test('t70: minecraft-protocol\'s own tracker fails the server\'s checks that the patched one passes (skipped without the package)', t => {
  const require = createRequire(import.meta.url);
  let plugin;
  try { plugin = require('minecraft-protocol/src/client/chat.js'); } catch { t.skip('minecraft-protocol not installed'); return; }
  const run = patched => {
    const { client, incoming } = chatClient();
    client.version = '26.1.2';
    if (patched) patchChatAcks(client);
    plugin(client, {});
    try {
      for (let i = 0; i < 25; i++) { incoming(); client._signedChat('line ' + i); }
      incoming(); incoming(); client._signedChat('/help'); incoming(); client._signedChat('after');
      return 'ok';
    } catch (error) { return error.message; }
  };
  assert.match(run(false), /Checksum mismatch/);
  assert.equal(run(true), 'ok');
});

function oxygenBot() {
  const bot = new EventEmitter(), client = new EventEmitter();
  Object.assign(bot, { _client: client, entity: { id: 7 }, oxygenLevel: 20,
    registry: { entitiesByName: { player: { metadataKeys: ['shared_flags', 'air_supply', 'custom_name'] } } } });
  // Mineflayer 4.39.0's handler: air_supply of ANY entity becomes bot.oxygenLevel.
  client.on('entity_metadata', packet => { const air = packet.metadata.find(entry => entry.key === 1); if (air) bot.oxygenLevel = Math.round(air.value / 15); });
  return { bot, client };
}

test('t70: oxygen comes from her own entity only: a fish on land beside her does not make her drown', () => {
  const { bot, client } = oxygenBot();
  assert.equal(patchOxygen(bot), true); assert.equal(patchOxygen(bot), true, 'idempotent');
  client.emit('entity_metadata', { entityId: 12, metadata: [{ key: 1, type: 'int', value: 60 }] });
  assert.equal(ownOxygen(bot), 20); assert.equal(bot.oxygenLevel, 20, 'Mineflayer\'s value is corrected too');
  client.emit('entity_metadata', { entityId: 7, metadata: [{ key: 1, type: 'int', value: 150 }] });
  assert.equal(ownOxygen(bot), 10);
  client.emit('entity_metadata', { entityId: 7, metadata: [{ key: 0, type: 'byte', value: 0 }] });
  assert.equal(ownOxygen(bot), 10, 'other metadata keeps the last value');
  client.emit('entity_metadata', { entityId: 12, metadata: [{ key: 1, type: 'int', value: 0 }] });
  assert.equal(ownOxygen(bot), 10);
  bot.emit('spawn');
  assert.equal(ownOxygen(bot), 20, 'a respawn breathes again');
  assert.equal(ownOxygen({ oxygenLevel: 12 }), 12, 'a bot without a client keeps Mineflayer\'s value');
  assert.equal(ownOxygen({}), 20);
});

test('t70: kick reasons on 26.1 are NBT components with translation keys', () => {
  const nbt = key => ({ type: 'compound', value: { translate: { type: 'string', value: key } } });
  assert.equal(disconnectReason(nbt('multiplayer.disconnect.chat_validation_failed')), 'Chat message validation failure');
  assert.equal(disconnectReason(nbt('disconnect.spam')), 'Kicked for spamming');
  assert.equal(disconnectReason(nbt('multiplayer.disconnect.not_whitelisted')), 'You are not white-listed on this server');
  assert.equal(disconnectReason(nbt('chat.disabled.missingProfileKey')), SECURE_CHAT_REASON);
  assert.equal(disconnectReason(nbt('some.new.key')), 'some.new.key', 'an unknown key is still named');
  assert.equal(disconnectReason({ type: 'compound', value: { text: { type: 'string', value: 'Server restarting' },
    extra: { type: 'list', value: { type: 'string', value: [' soon'] } } } }), 'Server restarting soon');
  assert.equal(disconnectReason({ type: 'string', value: 'Kicked by an operator' }), 'Kicked by an operator');
  assert.equal(disconnectReason('{"translate":"multiplayer.disconnect.kicked"}'), 'Kicked by an operator', 'JSON text from older versions');
  assert.equal(disconnectReason('plain words'), 'plain words');
  assert.equal(disconnectReason(undefined), '');
  assert.equal(disconnectReason({ type: 'string', value: 'a§cb\nc' }), 'a cb c', 'control and colour characters are cleaned');
  assert.ok(disconnectReason({ type: 'string', value: 'x'.repeat(1000) }).length <= 300);
  for (const reason of [disconnectReason(nbt('multiplayer.disconnect.not_whitelisted')), disconnectReason(nbt('multiplayer.disconnect.banned')), disconnectReason(nbt('multiplayer.disconnect.duplicate_login'))])
    assert.equal(reconnectDelay(0, 'kicked: ' + reason, () => 0), 30 * 60_000, reason);
  assert.equal(reconnectDelay(0, 'kicked: Chat message validation failure', () => 0), 5000, 'a chat kick retries soon');
});

test('t70: a server that enforces secure chat ends the connection with one clear reason and waits 30 minutes', () => {
  const client = new EventEmitter(), reasons = [];
  assert.equal(watchSecureChat(client, reason => reasons.push(reason)), true);
  client.emit('login', { enforcesSecureChat: false });
  assert.deepEqual(reasons, []);
  client.emit('login', { enforcesSecureChat: true }); client.emit('server_data', { enforcesSecureChat: true });
  assert.deepEqual(reasons, [SECURE_CHAT_REASON], 'once');
  assert.equal(SECURE_CHAT_REASON, 'server enforces secure chat (set enforce-secure-profile=false)');
  assert.ok(isSecureChatError(new Error('"disableChatSigning" was enabled in client options, but server is enforcing secure chat')));
  assert.ok(!isSecureChatError(new Error('socket closed')));
  assert.equal(reconnectDelay(0, SECURE_CHAT_REASON, () => 0), 30 * 60_000);
  assert.equal(reconnectDelay(5, SECURE_CHAT_REASON, () => 0), 30 * 60_000, 'never a tight loop');
  assert.equal(watchSecureChat(null, () => {}), false);
});
