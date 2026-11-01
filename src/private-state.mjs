import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = new Set(['thread', 'message', 'goal', 'permission', 'decision', 'memory', 'preference', 'personality', 'work', 'watch']);
const MESSAGES = {
  PRIVATE_STATE_INVALID_REQUEST: 'The private-state request is invalid.',
  PRIVATE_STATE_INVALID_CURSOR: 'The private-state cursor is invalid.',
  PRIVATE_STATE_NOT_FOUND: 'The private-state record was not found.',
  PRIVATE_STATE_CONFLICT: 'The private-state version or request key conflicts.',
  PRIVATE_STATE_UNAVAILABLE: 'Private state is unavailable.'
};
const INVALID = 'PRIVATE_STATE_INVALID_REQUEST', CURSOR = 'PRIVATE_STATE_INVALID_CURSOR';
const MISSING = 'PRIVATE_STATE_NOT_FOUND', CONFLICT = 'PRIVATE_STATE_CONFLICT', UNAVAILABLE = 'PRIVATE_STATE_UNAVAILABLE';
const MARKER_NAMESPACE = 'private-state-ledger-v1', MARKER_KEY = 'schema', MARKER_VALUE = '{"schemaVersion":1}';
const TABLES = new Map([
  ['private_state_schema', 'CREATE TABLE private_state_schema(version INTEGER NOT NULL CHECK(version=1))'],
  ['private_state_owner', 'CREATE TABLE private_state_owner(companion_id TEXT PRIMARY KEY, cursor_key TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=0))'],
  ['private_state_record', `CREATE TABLE private_state_record(companion_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    thread_id TEXT, version INTEGER NOT NULL, created_sequence INTEGER NOT NULL, updated_sequence INTEGER NOT NULL,
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), value_json TEXT, PRIMARY KEY(companion_id,id), UNIQUE(companion_id,created_sequence))`],
  ['private_state_event', `CREATE TABLE private_state_event(companion_id TEXT NOT NULL, sequence INTEGER NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL, thread_id TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), PRIMARY KEY(companion_id,sequence))`],
  ['private_state_request', `CREATE TABLE private_state_request(companion_id TEXT NOT NULL, request_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL, result_json TEXT NOT NULL, result_digest TEXT NOT NULL, PRIMARY KEY(companion_id,request_id))`]
]);
const AUTO_INDEXES = new Map([
  ['sqlite_autoindex_private_state_owner_1', 'private_state_owner'],
  ['sqlite_autoindex_private_state_record_1', 'private_state_record'],
  ['sqlite_autoindex_private_state_record_2', 'private_state_record'],
  ['sqlite_autoindex_private_state_event_1', 'private_state_event'],
  ['sqlite_autoindex_private_state_request_1', 'private_state_request']
]);

export class PrivateStateError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) code = UNAVAILABLE;
    super(MESSAGES[code]); this.name = 'PrivateStateError'; this.code = code;
  }
}
function requireState(condition, code = UNAVAILABLE) { if (!condition) throw new PrivateStateError(code); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function shape(value, required, optional = [], code = INVALID) {
  requireState(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requireState(keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) &&
    descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')) && required.every(key => Object.hasOwn(descriptors, key)), code);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

// Private JSON has at most 64 nested containers so accepted values remain HTTP-serializable.
// Iterative validation never invokes getters/toJSON, including on over-depth input.
function canonicalJson(value, maximum = 16384, maximumDepth = 64) {
  const tasks = [{ type: 'value', value, depth: 0 }], ancestors = new Set(), parts = [];
  let bytes = 0;
  const emit = text => { bytes += Buffer.byteLength(text); requireState(bytes <= maximum, INVALID); parts.push(text); };
  while (tasks.length) {
    const task = tasks.pop();
    if (task.type === 'text') { emit(task.text); continue; }
    if (task.type === 'close') { ancestors.delete(task.value); emit(task.text); continue; }
    const item = task.value;
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      emit(JSON.stringify(item)); continue;
    }
    if (typeof item === 'string') {
      requireState(Buffer.byteLength(item) <= maximum, INVALID); emit(JSON.stringify(item)); continue;
    }
    requireState(item !== null && typeof item === 'object' && !ancestors.has(item), INVALID);
    requireState(task.depth < maximumDepth, INVALID);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    requireState(array ? prototype === Array.prototype : [Object.prototype, null].includes(prototype), INVALID);
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    let selected;
    if (array) {
      const length = descriptors.length.value;
      requireState(length <= maximum && keys.length === length + 1, INVALID);
      selected = Array.from({ length }, (_, index) => String(index));
    } else {
      requireState(keys.every(key => typeof key === 'string') && keys.length <= maximum, INVALID);
      selected = keys.sort();
    }
    requireState(selected.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')), INVALID);
    ancestors.add(item); emit(array ? '[' : '{');
    tasks.push({ type: 'close', value: item, text: array ? ']' : '}' });
    for (let index = selected.length - 1; index >= 0; index--) {
      const key = selected[index];
      tasks.push({ type: 'value', value: descriptors[key].value, depth: task.depth + 1 });
      if (!array) {
        requireState(Buffer.byteLength(key) <= maximum, INVALID);
        tasks.push({ type: 'text', text: JSON.stringify(key) + ':' });
      }
      if (index > 0) tasks.push({ type: 'text', text: ',' });
    }
  }
  return parts.join('');
}
function normalize(operation) {
  const head = shape(operation, ['requestId', 'op'], ['kind', 'expectedVersion', 'value', 'threadId', 'id']);
  requireState(typeof head.requestId === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(head.requestId), INVALID);
  let normalized, valueJson;
  if (head.op === 'create') {
    const selected = shape(operation, ['requestId', 'op', 'kind', 'expectedVersion', 'value'], ['threadId']);
    requireState(KINDS.has(selected.kind) && selected.expectedVersion === 0, INVALID);
    requireState(selected.kind === 'message' ? typeof selected.threadId === 'string' && UUID.test(selected.threadId) : !Object.hasOwn(selected, 'threadId'), INVALID);
    valueJson = canonicalJson(selected.value);
    normalized = { requestId: selected.requestId, op: 'create', kind: selected.kind, expectedVersion: 0,
      value: JSON.parse(valueJson), ...(selected.kind === 'message' ? { threadId: selected.threadId } : {}) };
  } else if (head.op === 'update') {
    const selected = shape(operation, ['requestId', 'op', 'id', 'expectedVersion', 'value']);
    requireState(typeof selected.id === 'string' && UUID.test(selected.id) && integer(selected.expectedVersion, 1), INVALID);
    valueJson = canonicalJson(selected.value);
    normalized = { requestId: selected.requestId, op: 'update', id: selected.id, expectedVersion: selected.expectedVersion, value: JSON.parse(valueJson) };
  } else if (head.op === 'remove') {
    const selected = shape(operation, ['requestId', 'op', 'id', 'expectedVersion']);
    requireState(typeof selected.id === 'string' && UUID.test(selected.id) && integer(selected.expectedVersion, 1), INVALID);
    normalized = selected;
  } else throw new PrivateStateError(INVALID);
  return { normalized, valueJson };
}

export class PrivateStateStore {
  #db;
  constructor(bootstrapStore) {
    this.#db = bootstrapStore?.db;
    this.#transaction(() => {
      requireState(this.#db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB 'private_state_*' OR tbl_name GLOB 'private_state_*'").all().length === 0);
      const rows = this.#db.prepare("SELECT name,sql FROM sqlite_master WHERE name GLOB 'private_state_*'").all();
      const marker = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(MARKER_NAMESPACE, MARKER_KEY);
      if (rows.length === 0) {
        requireState(!marker);
        for (const sql of TABLES.values()) this.#db.exec(sql);
        this.#db.prepare('INSERT INTO private_state_schema VALUES (1)').run();
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(MARKER_NAMESPACE, MARKER_KEY, MARKER_VALUE);
      }
      this.#validateSchema();
    });
  }
  #validateSchema() {
    const names = [...TABLES.keys()], placeholders = names.map(() => '?').join(',');
    const selected = " WHERE name GLOB 'private_state_*' OR tbl_name IN (" + placeholders + ')';
    const rows = this.#db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master' + selected).all(...names);
    const sqlForm = text => text.replace(/\s+/g, ' ').trim();
    requireState(rows.length === TABLES.size + AUTO_INDEXES.size && rows.every(row =>
      row.type === 'table' ? TABLES.has(row.name) && sqlForm(row.sql) === sqlForm(TABLES.get(row.name)) :
        row.type === 'index' && row.sql === null && AUTO_INDEXES.get(row.name) === row.tbl_name));
    requireState(this.#db.prepare('SELECT name FROM sqlite_temp_master' + selected).all(...names).length === 0);
    const marker = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(MARKER_NAMESPACE, MARKER_KEY);
    requireState(marker?.value_json === MARKER_VALUE);
    const versions = this.#db.prepare('SELECT version FROM private_state_schema').all();
    requireState(versions.length === 1 && versions[0].version === 1);
  }
  #transaction(run) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try { const result = run(); this.#db.exec('COMMIT'); return result; }
      catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Keep the fixed public error. */ } throw error; }
    } catch (error) { throw error instanceof PrivateStateError ? error : new PrivateStateError(UNAVAILABLE); }
  }
  #owner(companionId) {
    this.#validateSchema();
    requireState(typeof companionId === 'string' && UUID.test(companionId));
    const identities = this.#db.prepare("SELECT value_json FROM bootstrap_record WHERE namespace='companion-identity-v1'").all();
    const retained = new Set();
    for (const row of identities) {
      let value;
      try { value = shape(JSON.parse(row.value_json), ['companionId'], [], UNAVAILABLE); } catch { throw new PrivateStateError(UNAVAILABLE); }
      requireState(typeof value.companionId === 'string' && UUID.test(value.companionId) && !retained.has(value.companionId));
      retained.add(value.companionId);
    }
    requireState(retained.has(companionId));
    let owner = this.#db.prepare('SELECT * FROM private_state_owner WHERE companion_id=?').get(companionId);
    if (!owner) {
      for (const table of ['private_state_record', 'private_state_event', 'private_state_request']) {
        requireState(!this.#db.prepare('SELECT 1 FROM ' + table + ' WHERE companion_id=? LIMIT 1').get(companionId));
      }
      this.#db.prepare('INSERT INTO private_state_owner VALUES (?,?,0)').run(companionId, randomBytes(32).toString('base64url'));
      owner = this.#db.prepare('SELECT * FROM private_state_owner WHERE companion_id=?').get(companionId);
    }
    requireState(integer(owner.sequence) && typeof owner.cursor_key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(owner.cursor_key) &&
      Buffer.from(owner.cursor_key, 'base64url').toString('base64url') === owner.cursor_key);
    const head = this.#db.prepare(`SELECT count(*) count,min(sequence) first,max(sequence) last,
      sum(CASE WHEN typeof(sequence)='integer' AND sequence>=1 THEN 0 ELSE 1 END) invalid
      FROM private_state_event WHERE companion_id=?`).get(companionId);
    requireState(head.count === owner.sequence && (head.invalid === null || head.invalid === 0) &&
      (owner.sequence === 0 ? head.first === null && head.last === null : head.first === 1 && head.last === owner.sequence));
    return owner;
  }
  #resultDigest(owner, requestId, operationDigest, result) {
    return createHmac('sha256', Buffer.from(owner.cursor_key, 'base64url'))
      .update('private-state-result-v1\0' + canonicalJson({ requestId, operationDigest, result }, 32768)).digest('hex');
  }
  #cursor(owner, payload) {
    const encoded = Buffer.from(JSON.stringify({ v: 1, owner: owner.companion_id, ...payload })).toString('base64url');
    const signature = createHmac('sha256', Buffer.from(owner.cursor_key, 'base64url')).update('private-state-cursor-v1\0' + encoded).digest('base64url');
    return encoded + '.' + signature;
  }
  #checkpoint(owner, after = owner.sequence) { return this.#cursor(owner, { purpose: 'changes', after }); }
  #decode(owner, cursor, purpose) {
    try {
      requireState(typeof cursor === 'string' && cursor.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor), CURSOR);
      const [encoded, signature] = cursor.split('.'), data = Buffer.from(encoded, 'base64url'), provided = Buffer.from(signature, 'base64url');
      const expected = createHmac('sha256', Buffer.from(owner.cursor_key, 'base64url')).update('private-state-cursor-v1\0' + encoded).digest();
      requireState(data.toString('base64url') === encoded && provided.toString('base64url') === signature &&
        provided.length === expected.length && timingSafeEqual(provided, expected), CURSOR);
      const payload = shape(JSON.parse(data.toString('utf8')), ['v', 'owner', 'purpose', 'after'],
        purpose === 'list' ? ['kind', 'threadId', 'watermark'] : [], CURSOR);
      requireState(payload.v === 1 && payload.owner === owner.companion_id && payload.purpose === purpose &&
        integer(payload.after) && payload.after <= owner.sequence, CURSOR);
      return payload;
    } catch { throw new PrivateStateError(CURSOR); }
  }
  #metadata(row, sequence = row.sequence) {
    requireState(typeof row.id === 'string' && UUID.test(row.id) && KINDS.has(row.kind) &&
      (row.kind === 'message' ? typeof row.thread_id === 'string' && UUID.test(row.thread_id) : row.thread_id === null) &&
      integer(row.version, 1) && integer(sequence, 1) && (row.deleted === 0 || row.deleted === 1));
    return { sequence, id: row.id, kind: row.kind, threadId: row.thread_id, version: row.version, deleted: row.deleted === 1 };
  }
  #record(owner, row) {
    const metadata = this.#metadata(row, row.updated_sequence);
    requireState(integer(row.created_sequence, 1) && row.created_sequence <= row.updated_sequence && row.updated_sequence <= owner.sequence);
    let value = null;
    if (metadata.deleted) requireState(row.value_json === null);
    else {
      try { requireState(typeof row.value_json === 'string' && Buffer.byteLength(row.value_json) <= 16384); value = JSON.parse(row.value_json);
        requireState(canonicalJson(value) === row.value_json); }
      catch { throw new PrivateStateError(UNAVAILABLE); }
    }
    return { id: metadata.id, kind: metadata.kind, threadId: metadata.threadId, version: metadata.version,
      createdSequence: row.created_sequence, updatedSequence: row.updated_sequence, deleted: metadata.deleted, value };
  }
  #active(owner, id) {
    const row = this.#db.prepare('SELECT * FROM private_state_record WHERE companion_id=? AND id=?').get(owner.companion_id, id);
    requireState(row, MISSING);
    const record = this.#record(owner, row);
    requireState(!record.deleted, MISSING);
    return record;
  }
  #thread(owner, id) { requireState(this.#active(owner, id).kind === 'thread', MISSING); }
  read(companionId, id) {
    return this.#transaction(() => { const owner = this.#owner(companionId); requireState(typeof id === 'string' && UUID.test(id), INVALID);
      return { record: this.#active(owner, id), checkpoint: this.#checkpoint(owner) }; });
  }
  list(companionId, options) {
    return this.#transaction(() => {
      const owner = this.#owner(companionId), selected = shape(options, ['kind'], ['threadId', 'cursor', 'limit']);
      requireState(KINDS.has(selected.kind), INVALID);
      requireState(selected.kind === 'message' ? typeof selected.threadId === 'string' && UUID.test(selected.threadId) : !Object.hasOwn(selected, 'threadId'), INVALID);
      if (selected.kind === 'message') this.#thread(owner, selected.threadId);
      const limit = selected.limit === undefined ? 50 : selected.limit; requireState(integer(limit, 1) && limit <= 50, INVALID);
      let watermark = owner.sequence, after = 0;
      if (selected.cursor !== undefined) {
        const cursor = this.#decode(owner, selected.cursor, 'list');
        requireState(cursor.kind === selected.kind && cursor.threadId === (selected.threadId ?? null) &&
          integer(cursor.watermark) && cursor.watermark <= owner.sequence && cursor.after <= cursor.watermark, CURSOR);
        watermark = cursor.watermark; after = cursor.after;
      }
      const rows = this.#db.prepare(`SELECT * FROM private_state_record WHERE companion_id=? AND kind=? AND thread_id IS ? AND
        deleted=0 AND created_sequence>? AND created_sequence<=? ORDER BY created_sequence LIMIT ?`)
        .all(companionId, selected.kind, selected.threadId ?? null, after, watermark, limit + 1);
      const records = rows.slice(0, limit).map(row => this.#record(owner, row));
      return { records, nextCursor: rows.length > limit ? this.#cursor(owner, { purpose: 'list', kind: selected.kind,
        threadId: selected.threadId ?? null, watermark, after: records.at(-1).createdSequence }) : null,
        checkpoint: this.#checkpoint(owner, watermark) };
    });
  }
  changes(companionId, options = {}) {
    return this.#transaction(() => {
      const owner = this.#owner(companionId), selected = shape(options, [], ['cursor', 'limit']);
      const limit = selected.limit === undefined ? 50 : selected.limit; requireState(integer(limit, 1) && limit <= 50, INVALID);
      const after = selected.cursor === undefined ? 0 : this.#decode(owner, selected.cursor, 'changes').after;
      const rows = this.#db.prepare('SELECT * FROM private_state_event WHERE companion_id=? AND sequence>? ORDER BY sequence LIMIT ?')
        .all(companionId, after, limit + 1);
      requireState(rows.length === Math.min(owner.sequence - after, limit + 1));
      const events = rows.slice(0, limit).map((row, index) => {
        requireState(row.sequence === after + index + 1); return this.#metadata(row);
      });
      const checkpoint = this.#checkpoint(owner, events.at(-1)?.sequence ?? after);
      return { events, nextCursor: rows.length > limit ? checkpoint : null, checkpoint };
    });
  }
  mutate(companionId, operation) {
    return this.#transaction(() => {
      const owner = this.#owner(companionId), { normalized, valueJson } = normalize(operation);
      const fingerprint = createHmac('sha256', Buffer.from(owner.cursor_key, 'base64url'))
        .update('private-state-operation-v1\0' + canonicalJson(normalized, 32768, 65)).digest('hex');
      const previous = this.#db.prepare('SELECT * FROM private_state_request WHERE companion_id=? AND request_id=?').get(companionId, normalized.requestId);
      if (previous) {
        requireState(typeof previous.operation_digest === 'string' && /^[a-f0-9]{64}$/.test(previous.operation_digest));
        requireState(typeof previous.result_json === 'string' && Buffer.byteLength(previous.result_json) <= 4096);
        const result = shape(JSON.parse(previous.result_json), ['id', 'kind', 'threadId', 'version', 'sequence', 'deleted', 'checkpoint'], [], UNAVAILABLE);
        requireState(typeof result.deleted === 'boolean');
        const metadata = this.#metadata({ ...result, thread_id: result.threadId, deleted: result.deleted ? 1 : 0 });
        requireState(typeof previous.result_digest === 'string' && previous.result_digest === this.#resultDigest(owner, normalized.requestId, previous.operation_digest, result));
        const event = this.#db.prepare('SELECT * FROM private_state_event WHERE companion_id=? AND sequence=?').get(companionId, result.sequence);
        requireState(event && canonicalJson(this.#metadata(event)) === canonicalJson(metadata));
        try { requireState(this.#decode(owner, result.checkpoint, 'changes').after === result.sequence); }
        catch { throw new PrivateStateError(UNAVAILABLE); }
        requireState(previous.operation_digest === fingerprint, CONFLICT);
        return result;
      }
      let id, kind, threadId, version;
      if (normalized.op === 'create') {
        if (normalized.kind === 'message') this.#thread(owner, normalized.threadId);
        id = randomUUID(); kind = normalized.kind; threadId = normalized.threadId ?? null; version = 1;
      } else {
        const record = this.#active(owner, normalized.id);
        requireState(record.version === normalized.expectedVersion, CONFLICT);
        requireState(record.version < Number.MAX_SAFE_INTEGER);
        id = record.id; kind = record.kind; threadId = record.threadId; version = record.version + 1;
      }
      requireState(owner.sequence < Number.MAX_SAFE_INTEGER);
      const sequence = owner.sequence + 1, deleted = normalized.op === 'remove';
      if (normalized.op === 'create') this.#db.prepare('INSERT INTO private_state_record VALUES (?,?,?,?,?,?,?,?,?)')
        .run(companionId, id, kind, threadId, version, sequence, sequence, 0, valueJson);
      else {
        this.#db.prepare('UPDATE private_state_record SET version=?,updated_sequence=?,deleted=?,value_json=? WHERE companion_id=? AND id=?')
          .run(version, sequence, deleted ? 1 : 0, deleted ? null : valueJson, companionId, id);
        // One parent deletion event invalidates every message in this thread. Values are owner-submitted data, never runtime authority.
        if (deleted && kind === 'thread') {
          const children = this.#db.prepare("SELECT * FROM private_state_record WHERE companion_id=? AND kind='message' AND thread_id=? AND deleted=0").all(companionId, id);
          for (const child of children) { this.#record(owner, child); requireState(child.version < Number.MAX_SAFE_INTEGER); }
          this.#db.prepare("UPDATE private_state_record SET version=version+1,updated_sequence=?,deleted=1,value_json=NULL WHERE companion_id=? AND kind='message' AND thread_id=? AND deleted=0")
            .run(sequence, companionId, id);
        }
      }
      this.#db.prepare('UPDATE private_state_owner SET sequence=? WHERE companion_id=?').run(sequence, companionId);
      this.#db.prepare('INSERT INTO private_state_event VALUES (?,?,?,?,?,?,?)').run(companionId, sequence, id, kind, threadId, version, deleted ? 1 : 0);
      const result = { id, kind, threadId, version, sequence, deleted, checkpoint: this.#checkpoint(owner, sequence) };
      this.#db.prepare('INSERT INTO private_state_request VALUES (?,?,?,?,?)')
        .run(companionId, normalized.requestId, fingerprint, JSON.stringify(result), this.#resultDigest(owner, normalized.requestId, fingerprint, result));
      return result;
    });
  }
}
