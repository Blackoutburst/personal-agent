import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { principalKey } from './provisioning.mjs';

const MAX_BYTES = 16 * 1024;
const ISSUER = 'https://blackoutburst.com';

function invalidConfig() {
  const error = new Error('Private pilot configuration is unavailable or invalid.');
  error.code = 'PILOT_CONFIG_UNAVAILABLE';
  return error;
}

// Parsing checks shape only; it is not a trusted account validator or file loader.
export function parsePilotSubjects(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw invalidConfig();
    const config = JSON.parse(text);
    if (config === null || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).length !== 1 || !Object.hasOwn(config, 'principals') ||
        !Array.isArray(config.principals) || config.principals.length < 1 || config.principals.length > 2) throw invalidConfig();
    const seen = new Set();
    return config.principals.map(principal => {
      const key = principalKey(principal);
      if (principal.issuer !== ISSUER || seen.has(key)) throw invalidConfig();
      seen.add(key);
      return { issuer: principal.issuer, subject: principal.subject };
    });
  } catch {
    throw invalidConfig();
  }
}

function inside(candidate, root) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

function checkFile(info, uid) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid ||
      (info.mode & 0o7777) !== 0o600 || info.size > MAX_BYTES) throw invalidConfig();
}

function checkParents(filename, uid) {
  let parent = dirname(filename);
  let immediate = true;
  while (true) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid)) throw invalidConfig();
    if (immediate) {
      if (info.uid !== uid || (info.mode & 0o7777) !== 0o700) throw invalidConfig();
    } else if ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000))) {
      // A root-owned sticky ancestor such as /tmp protects the private child.
      throw invalidConfig();
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
    immediate = false;
  }
}

export function loadPilotSubjects(configPath, sourceRoot) {
  let fd;
  try {
    // Windows mode bits do not attest a private ACL. No file is read there.
    if (process.platform === 'win32' || typeof process.getuid !== 'function' ||
        typeof constants.O_NOFOLLOW !== 'number' ||
        typeof configPath !== 'string' || !isAbsolute(configPath) ||
        typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)) throw invalidConfig();
    const source = realpathSync(sourceRoot);
    if (!lstatSync(source).isDirectory()) throw invalidConfig();
    const filename = resolve(configPath);
    if (inside(filename, source)) throw invalidConfig();
    const uid = process.getuid();
    checkParents(filename, uid);
    const original = lstatSync(filename);
    checkFile(original, uid);
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    checkFile(opened, uid);
    if (opened.dev !== original.dev || opened.ino !== original.ino) throw invalidConfig();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    checkFile(after, uid);
    if (length > MAX_BYTES || after.size !== length || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw invalidConfig();
    checkParents(filename, uid);
    const retained = lstatSync(filename);
    checkFile(retained, uid);
    if (retained.dev !== opened.dev || retained.ino !== opened.ino) throw invalidConfig();
    const content = bytes.subarray(0, length);
    const text = content.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(content)) throw invalidConfig();
    return parsePilotSubjects(text);
  } catch {
    throw invalidConfig();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch { throw invalidConfig(); }
    }
  }
}
