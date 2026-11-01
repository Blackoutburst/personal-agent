import { mkdirSync, realpathSync, existsSync, lstatSync, openSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x50414331;
const SCHEMA_VERSION = 1;

function encodeRecord(namespace, key, value) {
  if (![namespace, key].every(part => typeof part === 'string' && /^[\w.-]{1,80}$/.test(part))) {
    throw new Error('Invalid bootstrap namespace/key');
  }
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 16384) throw new Error('Bootstrap value exceeds contract');
  return json;
}

function inside(candidate, root) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
}

function present(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directoryChain(path) {
  for (let selected = path; ; selected = resolve(selected, '..')) {
    const info = present(selected);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private data directory cannot use links');
      if (process.platform !== 'win32') {
        const stickyRoot = info.uid === 0 && (info.mode & 0o1000);
        if (![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !stickyRoot)) {
          throw new Error('Private data ancestor requires trusted ownership and permissions');
        }
      }
    }
    if (resolve(selected, '..') === selected) break;
  }
}

function privateFile(path) {
  const info = present(path);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Private database/sidecar must be a regular unshared file');
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600)) {
    throw new Error('Private database/sidecar requires private ownership and permissions');
  }
}

export class BootstrapStore {
  constructor(dataDir, sourceRoot) {
    if (!dataDir || !isAbsolute(dataDir)) throw new Error('COMPANION_DATA_DIR must be an absolute external path');
    const source = realpathSync(sourceRoot);
    const selected = resolve(dataDir);
    if (inside(selected, source)) throw new Error('Private data must be outside the checkout');
    // Resolve the existing ancestor before creating anything, including junctions.
    let ancestor = selected;
    while (!existsSync(ancestor)) {
      const parent = resolve(ancestor, '..');
      if (parent === ancestor) throw new Error('Private data filesystem root is unavailable');
      ancestor = parent;
    }
    const projected = resolve(realpathSync(ancestor), relative(ancestor, selected));
    if (inside(projected, source)) throw new Error('Private data resolves inside the checkout');
    directoryChain(selected);
    mkdirSync(selected, { recursive: true, mode: 0o700 });
    directoryChain(selected);
    const directory = realpathSync(selected);
    if (inside(directory, source)) throw new Error('Private data resolves inside the checkout');
    const directoryInfo = lstatSync(directory);
    if (process.platform !== 'win32' && (directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o7777) !== 0o700)) {
      throw new Error('Private data directory requires owner-only permissions');
    }
    const filename = join(directory, 'bootstrap.sqlite');
    if (!present(filename)) {
      try { closeSync(openSync(filename, 'wx', 0o600)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    // Refuse unsafe retained bytes before SQLite can recover or modify them.
    privateFile(filename);
    for (const suffix of ['-journal', '-wal', '-shm']) privateFile(filename + suffix);
    const db = new DatabaseSync(filename);
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
      const appId = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (appId === 0 && version === 0 && tables.length === 0) {
        db.exec(`CREATE TABLE bootstrap_record(namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(namespace,key)); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      } else if (appId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error('Unsupported private-store application/schema version');
      }
      db.prepare('SELECT namespace,key,value_json FROM bootstrap_record LIMIT 0').all();
      db.exec('COMMIT;');
      this.db = db;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* The connection may not have entered a transaction. */ }
      db.close();
      throw error;
    }
  }

  put(namespace, key, value) {
    if (namespace === 'companion-identity-v1') throw new Error('Companion identities cannot be overwritten');
    const json = encodeRecord(namespace, key, value);
    this.db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json').run(namespace, key, json);
  }

  getOrInsert(namespace, key, value) {
    const json = encodeRecord(namespace, key, value);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?) ON CONFLICT(namespace,key) DO NOTHING').run(namespace, key, json);
      const row = this.db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(namespace, key);
      const result = JSON.parse(row.value_json);
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  get(namespace, key) {
    const row = this.db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(namespace, key);
    return row ? JSON.parse(row.value_json) : null;
  }

  count() { return this.db.prepare('SELECT COUNT(*) AS total FROM bootstrap_record').get().total; }
  close() { this.db.close(); }
}
