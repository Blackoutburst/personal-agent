// One Minecraft connection in its own worker thread (#68, docs/MINECRAFT.md). Mineflayer runs here, never in the web
// service's thread: an exception in a packet handler ends this worker only, and the supervisor in src/minecraft.mjs
// reconnects with backoff. A worker lives for one connection; a new connection is a new worker.
import { parentPort, workerData } from 'node:worker_threads';
import { loadPackage } from './deps.mjs';
import { BotBody, disconnectReason, watchSecureChat, isSecureChatError, SECURE_CHAT_REASON } from './minecraft-body.mjs';
import { createAuthCache, signInView, signInFailure, safeReason } from './minecraft-auth.mjs';

const LOGIN_MS = 60_000;

let ended = false, body = null, bot = null;
const post = message => { try { parentPort.postMessage(message); } catch { /* the supervisor is gone */ } };
function end(reason) {
  if (ended) return;
  ended = true;
  post({ op: 'state', state: 'ended', reason: safeReason(reason ?? 'disconnected').replace(/[\x00-\x1f\x7f§]/g, ' ').slice(0, 300) });
  try { body?.detach(); } catch { /* closing */ }
  setTimeout(() => process.exit(0), 200);
}
// minecraft-protocol throws from its packet handler when a server enforces secure chat and signing is off.
const crashed = error => end(isSecureChatError(error) ? SECURE_CHAT_REASON : 'crashed: ' + (error?.message ?? 'error'));
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

try {
  const { host, port, username, version, companions, auth = 'offline', profilesFolder = null, cacheKey = null, refreshTokens = false } = workerData;
  const mineflayer = loadPackage('mineflayer');
  let pathfinder = null;
  try { pathfinder = loadPackage('mineflayer-pathfinder'); } catch { /* walking skills report unavailable */ }
  const microsoft = auth === 'microsoft';
  let kicked = null, login = null, signInTimer = null, session = !microsoft, signingIn = false;
  const startLogin = () => { clearTimeout(login); login = setTimeout(() => { end(session ? 'login timed out' : 'sign-in failed'); try { bot.quit(); } catch { /* gone */ } }, LOGIN_MS); };
  // Online mode: prismarine-auth signs in with the companion's Microsoft account. Its tokens stay in the 0600 cache
  // files; only the device code's user code, URL and expiry leave this thread, and only while a sign-in is pending.
  const authOptions = microsoft ? { auth: 'microsoft', username: cacheKey, profilesFolder: createAuthCache(profilesFolder, { dropDerived: refreshTokens }),
    onMsaCode: response => {
      const view = signInView(response);
      clearTimeout(login);
      if (!view) { end('sign-in failed'); return; }
      signingIn = true;
      post({ op: 'state', state: 'signin', signIn: view });
      // prismarine-auth gives up when the code expires; this is a backstop.
      clearTimeout(signInTimer);
      signInTimer = setTimeout(() => end('sign-in code expired'), Math.max(0, view.expiresAt - Date.now()) + 30_000);
    } } : { username, auth: 'offline' };
  startLogin();
  // t70: chat goes out unsigned (no chat certificates are fetched): minecraft-protocol's signed chat broke on 26.1 and
  // got her kicked for "Chat message validation failure" (docs/MINECRAFT.md, "Chat on 26.1"). The server must not
  // enforce secure profiles (enforce-secure-profile=false); one that does ends the connection with a clear reason.
  bot = mineflayer.createBot({ host, port, ...authOptions, version: version || false, hideErrors: true, disableChatSigning: true,
    viewDistance: 'short', respawn: true, checkTimeoutInterval: 60_000, logErrors: false });
  watchSecureChat(bot._client, reason => { kicked = reason; clearTimeout(login); try { bot.quit(); } catch { end(reason); } });
  // The session exists (cached or fresh sign-in): report the account's in-game name (never the session itself).
  bot._client?.on?.('session', () => {
    session = true; clearTimeout(signInTimer); signingIn = false;
    post({ op: 'state', state: 'signedin', username: typeof bot._client.username === 'string' ? bot._client.username : null });
    startLogin();
  });
  body = new BotBody({ bot, pathfinder, companions, onEvent: event => post({ op: 'event', event }) });
  body.attach();
  bot.once('spawn', () => { clearTimeout(login); post({ op: 'state', state: 'online', username: bot.username }); });
  // 26.1 sends the reason as an NBT text component (often only a translation key): name what happened.
  bot.on('kicked', reason => {
    const why = disconnectReason(reason);
    if (kicked !== SECURE_CHAT_REASON) kicked = why === SECURE_CHAT_REASON ? why : 'kicked: ' + (why || 'no reason');
  });
  bot.on('error', error => {
    // Before a session exists there is no socket (no 'end' follows): a sign-in error ends this connection.
    if (!session) { clearTimeout(login); end(signInFailure(error)); return; }
    if (isSecureChatError(error)) kicked = SECURE_CHAT_REASON;
    kicked ??= error?.code === 'ECONNREFUSED' ? 'server not reachable' : safeReason(error?.message ?? 'connection error');
  });
  // encryptionLoginError: Mojang's session server refused our join (the token is stale or revoked).
  bot.on('end', reason => { clearTimeout(login); end(reason === 'encryptionLoginError' ? 'session rejected' : kicked ?? (reason || 'disconnected')); });
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
