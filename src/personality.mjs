import { createHash } from 'node:crypto';
import { readSoul, replaceSoul, MemoryError } from './memory.mjs';

export const PERSONALITY_LIMITS = Object.freeze({ fileBytes: 256 * 1024, history: 20, requestBytes: 2 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/, SOURCES = new Set(['settled_turn', 'owner_edit', 'owner_restore', 'before_owner_change']);
const ERRORS = {
  INVALID_REQUEST: [400, 'Check the personality request.'],
  PERSONALITY_CONFLICT: [409, 'Personality changed. Reload before trying again.'],
  PERSONALITY_BUSY: [409, 'Finish or stop the current reply and wait for it to end.'],
  PERSONALITY_NOT_FOUND: [404, 'That personality version is unavailable.'],
  PERSONALITY_TOO_LARGE: [413, 'Personality exceeds the supported size limit.'],
  PERSONALITY_UNSAFE: [503, 'Personality files could not be accessed safely.'],
  PERSONALITY_UNAVAILABLE: [503, 'Personality is unavailable. Reload before trying again.']
};
export class PersonalityError extends Error {
  constructor(code = 'PERSONALITY_UNAVAILABLE') {
    const key = Object.hasOwn(ERRORS, code) ? code : 'PERSONALITY_UNAVAILABLE';
    super(ERRORS[key][1]); this.code = key; this.status = ERRORS[key][0];
  }
}
const fail = code => { throw new PersonalityError(code); };
function fixed(error) {
  if (error instanceof PersonalityError) return error;
  if (error instanceof MemoryError || error?.code === 'MEMORY_BUSY') {
    return new PersonalityError(error.code === 'INVALID_REQUEST' ? error.code : error.code.replace(/^MEMORY_/, 'PERSONALITY_'));
  }
  return new PersonalityError();
}
function revision(value) { if (typeof value !== 'string' || value.length !== 64 || !SHA.test(value)) fail('INVALID_REQUEST'); }
function identity(value) { if (typeof value !== 'string' || value.length !== 36 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) fail('INVALID_REQUEST'); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some(k => !keys.includes(k) || !descriptors[k].enumerable || !Object.hasOwn(descriptors[k], 'value'))) fail('INVALID_REQUEST');
}
const meta = row => ({ revision: row.revision, modifiedAtISO: row.modified_at, observedAtISO: row.observed_at, source: row.source });

// One additive, private SQLite table; SOUL.md stays the native source of truth.
// History records only bytes the app observed, never every intermediate native edit.
export class PersonalityStore {
  #db; #workspaceFor; #now;
  constructor({ store, workspaceFor, now = Date.now }) {
    this.#db = store.db; this.#workspaceFor = workspaceFor; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS personality_versions (
      companion_id TEXT NOT NULL, revision TEXT NOT NULL, content TEXT NOT NULL,
      modified_at TEXT NOT NULL, observed_at TEXT NOT NULL, source TEXT NOT NULL,
      sequence INTEGER NOT NULL, PRIMARY KEY(companion_id,revision));`);
  }
  #dir(companionId) {
    identity(companionId); const workspace = this.#workspaceFor(companionId);
    if (!workspace) fail('PERSONALITY_NOT_FOUND'); return workspace.dir;
  }
  #history(companionId) {
    return this.#db.prepare('SELECT revision,modified_at,observed_at,source FROM personality_versions WHERE companion_id=? ORDER BY sequence DESC LIMIT 20').all(companionId).map(meta);
  }
  #capture(companionId, current, source) {
    if (!SOURCES.has(source)) fail('INVALID_REQUEST');
    const time = this.#now(); if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) fail('PERSONALITY_UNAVAILABLE');
    const latest = this.#db.prepare('SELECT revision FROM personality_versions WHERE companion_id=? ORDER BY sequence DESC LIMIT 1').get(companionId);
    if (latest?.revision === current.revision) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const sequence = this.#db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM personality_versions WHERE companion_id=?').get(companionId).n;
      this.#db.prepare(`INSERT INTO personality_versions VALUES(?,?,?,?,?,?,?) ON CONFLICT(companion_id,revision)
        DO UPDATE SET content=excluded.content,modified_at=excluded.modified_at,observed_at=excluded.observed_at,source=excluded.source,sequence=excluded.sequence`)
        .run(companionId, current.revision, current.content, current.modifiedAtISO, new Date(time).toISOString(), source, sequence);
      this.#db.prepare(`DELETE FROM personality_versions WHERE companion_id=? AND revision NOT IN
        (SELECT revision FROM personality_versions WHERE companion_id=? ORDER BY sequence DESC LIMIT 20)`).run(companionId, companionId);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  observe(companionId, source = 'settled_turn') {
    try { const current = readSoul(this.#dir(companionId)); this.#capture(companionId, current, source); return current; }
    catch (error) { throw fixed(error); }
  }
  snapshot(companionId) {
    try { return { ...readSoul(this.#dir(companionId)), history: this.#history(companionId), historyLimit: PERSONALITY_LIMITS.history }; }
    catch (error) { throw fixed(error); }
  }
  version(companionId, selected) {
    try {
      this.#dir(companionId); revision(selected);
      const row = this.#db.prepare('SELECT * FROM personality_versions WHERE companion_id=? AND revision=?').get(companionId, selected);
      if (!row) fail('PERSONALITY_NOT_FOUND');
      if (Buffer.byteLength(row.content) > PERSONALITY_LIMITS.fileBytes || createHash('sha256').update(row.content).digest('hex') !== selected || !SOURCES.has(row.source)) fail('PERSONALITY_UNAVAILABLE');
      return { ...meta(row), content: row.content };
    } catch (error) { throw fixed(error); }
  }
  edit(companionId, input, beforeChange) { return this.#change(companionId, input, beforeChange, false); }
  restore(companionId, input, beforeChange) { return this.#change(companionId, input, beforeChange, true); }
  #change(companionId, input, beforeChange, restore) {
    try {
      fields(input, restore ? ['revision', 'expectedRevision', 'confirm'] : ['content', 'expectedRevision']);
      revision(input.expectedRevision); if (typeof beforeChange !== 'function') fail('INVALID_REQUEST');
      if (restore && input.confirm !== true) fail('INVALID_REQUEST');
      const dir = this.#dir(companionId), content = restore ? this.version(companionId, input.revision).content : input.content;
      const result = replaceSoul(dir, { content, expectedRevision: input.expectedRevision }, () => {
        // A history-write or reset failure cannot publish new file bytes.
        this.#capture(companionId, readSoul(dir), 'before_owner_change'); return beforeChange();
      });
      this.#capture(companionId, result, restore ? 'owner_restore' : 'owner_edit');
      return { changed: result.changed, ...this.snapshot(companionId) };
    } catch (error) { throw fixed(error); }
  }
}
