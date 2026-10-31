import { mkdirSync, realpathSync, chmodSync, existsSync, statSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APPLICATION_ID = 0x50414331;
const SCHEMA_VERSION = 1;

function inside(candidate, root) {
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
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
    mkdirSync(selected, { recursive: true, mode: 0o700 });
    const directory = realpathSync(selected);
    if (inside(directory, source)) throw new Error('Private data resolves inside the checkout');
    if (process.platform !== 'win32' && (statSync(directory).mode & 0o077)) {
      throw new Error('Private data directory requires owner-only permissions');
    }
    const filename = join(directory, 'bootstrap.sqlite');
    if (existsSync(filename)) {
      const info = lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Private database must be a regular unshared file');
    }
    const db = new DatabaseSync(filename);
    try {
      const appId = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (appId === 0 && version === 0 && tables.length === 0) {
        db.exec(`BEGIN; CREATE TABLE bootstrap_record(namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(namespace,key)); PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      } else if (appId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error('Unsupported private-store application/schema version');
      }
      db.prepare('SELECT namespace,key,value_json FROM bootstrap_record LIMIT 0').all();
      if (process.platform !== 'win32') chmodSync(filename, 0o600);
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  put(namespace, key, value) {
    if (![namespace, key].every(part => typeof part === 'string' && /^[\w.-]{1,80}$/.test(part))) {
      throw new Error('Invalid bootstrap namespace/key');
    }
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 16384) throw new Error('Bootstrap value exceeds contract');
    this.db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json').run(namespace, key, json);
  }

  get(namespace, key) {
    const row = this.db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(namespace, key);
    return row ? JSON.parse(row.value_json) : null;
  }

  count() { return this.db.prepare('SELECT COUNT(*) AS total FROM bootstrap_record').get().total; }
  close() { this.db.close(); }
}
