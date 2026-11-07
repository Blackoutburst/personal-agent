// Microsoft sign-in for the Minecraft connector (#68 online mode, docs/MINECRAFT.md).
//
// With "auth": "microsoft" each companion signs in with its own Minecraft (Microsoft) account through prismarine-auth
// (a dependency of mineflayer) and its device-code flow. The tokens live in a per-companion profiles folder under the
// data dir: the folder is 0700, every cache file 0600, written atomically and never through a link. Nothing here, nor
// in its callers, logs, returns or shows a token: only the device code's user code, its verification URL and its expiry
// reach the owner's Connectors card while a sign-in is pending.
import { constants, mkdirSync, lstatSync, chmodSync, readdirSync, rmSync, openSync, readSync, writeSync, fstatSync,
  fchmodSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

// prismarine-auth's cache ids (MicrosoftAuthFlow CACHE_IDS); "xbl" and "mca" are derived from the Microsoft token.
const CACHE_IDS = ['msal', 'live', 'sisu', 'xbl', 'bed', 'mca', 'mcs', 'pfb'], DERIVED = ['xbl', 'mca'];
const COMPANION_ID = /^[A-Za-z0-9-]{1,64}$/, CACHE_FILE = /^[0-9a-f]{12}_[a-z]+-cache\.json$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0, MAX_CACHE_BYTES = 256 * 1024;

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Minecraft profiles folder is not a directory');
  if ((info.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

// <root>/<companionId>, created 0700 (the root too). root is under the data dir, e.g. <dataDir>/minecraft-auth.
export function profilesFolderFor(root, companionId) {
  if (typeof root !== 'string' || !root || typeof companionId !== 'string' || !COMPANION_ID.test(companionId)) throw new TypeError('Invalid Minecraft profiles folder');
  privateDir(root);
  const folder = join(root, companionId);
  privateDir(folder);
  return folder;
}

// Whether a sign-in left tokens behind (file names only; contents are never read here).
export function hasSavedAccount(folder) {
  try { return readdirSync(folder).some(name => CACHE_FILE.test(name)); } catch { return false; }
}

// Sign out: deletes everything inside the companion's profiles folder (the folder itself stays, 0700).
export function wipeProfilesFolder(folder) {
  let info;
  try { info = lstatSync(folder); } catch { return 0; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Minecraft profiles folder is not a directory');
  const names = readdirSync(folder);
  for (const name of names) rmSync(join(folder, name), { recursive: true, force: true });
  return names.length;
}

function readJson(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW); } catch { return {}; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) return {};
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) { const n = readSync(fd, buffer, read, info.size - read, read); if (!n) break; read += n; }
    const value = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; } finally { closeSync(fd); }
}

function writeJson(path, value) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, JSON.stringify(value)); }
  catch (error) { closeSync(fd); try { unlinkSync(temp); } catch { /* gone */ } throw error; }
  closeSync(fd);
  renameSync(temp, path);
}

// prismarine-auth's cache factory (passed as profilesFolder): ({ cacheName, username }) -> a cache with FileCache's
// interface. dropDerived (after the server or Mojang refused the session) forgets the Xbox and Minecraft tokens, so they
// are fetched again from the Microsoft sign-in; if that is refused too, prismarine-auth asks for a new device code.
export function createAuthCache(folder, { dropDerived = false } = {}) {
  privateDir(folder);
  return ({ cacheName, username = '' }) => {
    if (!CACHE_IDS.includes(cacheName)) throw new Error('Unknown Minecraft auth cache');
    const path = join(folder, `${createHash('sha1').update(String(username), 'utf8').digest('hex').slice(0, 12)}_${cacheName}-cache.json`);
    if (dropDerived && DERIVED.includes(cacheName)) { try { unlinkSync(path); } catch { /* none yet */ } }
    let cache;
    const cached = {
      async reset() { cache = {}; writeJson(path, cache); return cache; },
      async loadInitialValue() { return readJson(path); },
      async getCached() { if (cache === undefined) cache = readJson(path); return cache; },
      async setCached(value) { cache = value; writeJson(path, cache); },
      async setCachedPartial(value) { await cached.setCached({ ...(cache ?? readJson(path)), ...value }); }
    };
    return cached;
  };
}

// The device code as shown to the owner: { code, url, expiresAt } only (never the device_code or any token), or null.
export function signInView(response, now = Date.now()) {
  if (!response || typeof response !== 'object') return null;
  const code = typeof (response.user_code ?? response.userCode) === 'string' ? (response.user_code ?? response.userCode).trim() : '';
  if (!/^[A-Za-z0-9-]{4,24}$/.test(code)) return null;
  let url = 'https://www.microsoft.com/link';
  try {
    const given = new URL(response.verification_uri ?? response.verificationUri ?? '');
    if (given.protocol === 'https:' && /(^|\.)(microsoft\.com|live\.com|microsoftonline\.com)$/i.test(given.hostname) && given.href.length <= 200) url = given.href;
  } catch { /* the default link */ }
  const seconds = Number(response.expires_in ?? response.expiresIn);
  const expiresAt = now + Math.round(Math.min(3600, Math.max(60, Number.isFinite(seconds) ? seconds : 900)) * 1000);
  return { code, url, expiresAt };
}

// The same shape check on the receiving side (worker messages are data).
export function checkedSignIn(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  const { code, url, expiresAt } = value;
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{4,24}$/.test(code) || typeof url !== 'string' || !/^https:\/\/[^\s]{1,190}$/.test(url)
      || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 3600_000 + 60_000) return null;
  return { code, url, expiresAt };
}

// A disconnect reason that may come from a library error: anything token-shaped (long base64url runs, JWTs) is cut.
export function safeReason(text) {
  return String(text ?? '').replace(/eyJ[A-Za-z0-9_-]*\.?[A-Za-z0-9_.-]*/g, '[redacted]').replace(/[A-Za-z0-9_\-+/=.]{32,}/g, '[redacted]');
}

// Sign-in errors (before the session exists), as fixed texts: no library message reaches the status or the log.
export function signInFailure(error) {
  const message = String(error?.message ?? error ?? '');
  if (/timed out/i.test(message)) return 'sign-in code expired';
  if (/own minecraft|does the account own|Not Found|profile/i.test(message)) return 'sign-in failed: this account has no Minecraft Java profile';
  return 'sign-in failed';
}
