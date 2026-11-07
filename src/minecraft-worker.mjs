// One Minecraft connection in its own worker thread (#68, docs/MINECRAFT.md). Mineflayer runs here, never in the web
// service's thread: an exception in a packet handler ends this worker only, and the supervisor in src/minecraft.mjs
// reconnects with backoff. A worker lives for one connection; a new connection is a new worker.
import { parentPort, workerData } from 'node:worker_threads';
import { loadPackage } from './deps.mjs';
import { BotBody } from './minecraft-body.mjs';

const LOGIN_MS = 60_000;
const text = value => {
  if (typeof value === 'string') { try { return text(JSON.parse(value)); } catch { return value; } }
  if (value && typeof value === 'object') return [value.text, value.translate, ...(Array.isArray(value.extra) ? value.extra.map(text) : []), ...(Array.isArray(value.with) ? value.with.map(text) : [])].filter(Boolean).join(' ');
  return String(value ?? '');
};

let ended = false, body = null, bot = null;
const post = message => { try { parentPort.postMessage(message); } catch { /* the supervisor is gone */ } };
function end(reason) {
  if (ended) return;
  ended = true;
  post({ op: 'state', state: 'ended', reason: String(reason ?? 'disconnected').replace(/[\x00-\x1f\x7f§]/g, ' ').slice(0, 300) });
  try { body?.detach(); } catch { /* closing */ }
  setTimeout(() => process.exit(0), 200);
}
process.on('uncaughtException', error => end('crashed: ' + (error?.message ?? 'error')));
process.on('unhandledRejection', error => end('crashed: ' + (error?.message ?? 'error')));

try {
  const { host, port, username, version, companions } = workerData;
  const mineflayer = loadPackage('mineflayer');
  let pathfinder = null;
  try { pathfinder = loadPackage('mineflayer-pathfinder'); } catch { /* walking skills report unavailable */ }
  bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: version || false, hideErrors: true,
    viewDistance: 'short', respawn: true, checkTimeoutInterval: 60_000, logErrors: false });
  body = new BotBody({ bot, pathfinder, companions, onEvent: event => post({ op: 'event', event }) });
  body.attach();
  let kicked = null;
  const login = setTimeout(() => { end('login timed out'); try { bot.quit(); } catch { /* gone */ } }, LOGIN_MS);
  bot.once('spawn', () => { clearTimeout(login); post({ op: 'state', state: 'online', username: bot.username }); });
  bot.on('kicked', reason => { kicked = 'kicked: ' + (text(reason) || 'no reason'); });
  bot.on('error', error => { kicked ??= error?.code === 'ECONNREFUSED' ? 'server not reachable' : (error?.message ?? 'connection error'); });
  bot.on('end', reason => { clearTimeout(login); end(kicked ?? (reason || 'disconnected')); });
} catch (error) {
  end(error?.code === 'DEPENDENCY_MISSING' ? 'DEPENDENCY_MISSING' : 'start failed: ' + (error?.message ?? 'error'));
}

parentPort.on('message', async message => {
  if (ended || !message || typeof message !== 'object') return;
  try {
    if (message.op === 'perceive') post({ op: 'reply', id: message.id, value: body.perceive() });
    else if (message.op === 'act') post({ op: 'reply', id: message.id, value: await body.act(message.action) });
    else if (message.op === 'quit') { body?.quit('bye'); setTimeout(() => end('quit'), 500); }
  } catch (error) {
    if (message.id !== undefined) post({ op: 'reply', id: message.id, error: String(error?.message ?? 'failed').slice(0, 200) });
  }
});
