import { createHash, createHmac, randomBytes } from 'node:crypto';

export const RUNTIME_BINDING_AUDIENCE = 'blackoutburst-personal-agent-runtime-binding-v1';
export const RUNTIME_AUTHORITY_MAX_TTL_MS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/, OPAQUE = /^[A-Za-z0-9._:-]{1,128}$/, REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const INVALID = 'RUNTIME_BINDING_INVALID_REQUEST', MISSING = 'RUNTIME_BINDING_NOT_FOUND';
const CONFLICT = 'RUNTIME_BINDING_CONFLICT', UNAVAILABLE = 'RUNTIME_BINDING_UNAVAILABLE';
const AUTH_UNAVAILABLE = 'RUNTIME_AUTHORITY_UNAVAILABLE', REJECTED = 'RUNTIME_AUTHORITY_REJECTED';
const MESSAGES = {
  [INVALID]: 'The runtime-binding request is invalid.', [MISSING]: 'The runtime binding was not found.',
  [CONFLICT]: 'The runtime binding or generation conflicts.', [UNAVAILABLE]: 'The runtime-binding store is unavailable.',
  [AUTH_UNAVAILABLE]: 'Independent runtime authority is unavailable.', [REJECTED]: 'Independent runtime authority rejected the request.'
};
const MARKER_NAMESPACE = 'runtime-binding-ledger-v1', MARKER_VALUE = '{"schemaVersion":1}';
const TABLES = new Map([
  ['runtime_binding_schema', 'CREATE TABLE runtime_binding_schema(version INTEGER NOT NULL CHECK(version=1))'],
  ['runtime_binding_owner', `CREATE TABLE runtime_binding_owner(companion_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL,
    receipt_key TEXT NOT NULL, generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=1),
    state TEXT NOT NULL CHECK(state IN ('registered','disconnected')), runtime_id TEXT, runtime_instance TEXT)`],
  ['runtime_binding_incarnation', `CREATE TABLE runtime_binding_incarnation(runtime_id TEXT NOT NULL, runtime_instance TEXT NOT NULL,
    companion_id TEXT NOT NULL, identity_key TEXT NOT NULL, first_generation INTEGER NOT NULL, PRIMARY KEY(runtime_id,runtime_instance))`],
  ['runtime_binding_request', `CREATE TABLE runtime_binding_request(companion_id TEXT NOT NULL, request_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=1), action TEXT NOT NULL,
    operation_digest TEXT NOT NULL, result_json TEXT NOT NULL, result_mac TEXT NOT NULL,
    PRIMARY KEY(companion_id,request_id), UNIQUE(companion_id,generation))`]
]);
const INDEXES = new Map([
  ['sqlite_autoindex_runtime_binding_owner_1', 'runtime_binding_owner'],
  ['sqlite_autoindex_runtime_binding_incarnation_1', 'runtime_binding_incarnation'],
  ['sqlite_autoindex_runtime_binding_request_1', 'runtime_binding_request'],
  ['sqlite_autoindex_runtime_binding_request_2', 'runtime_binding_request']
]);

export class RuntimeBindingError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) code = UNAVAILABLE;
    super(MESSAGES[code]); this.name = 'RuntimeBindingError'; this.code = code;
  }
}
function requireBinding(condition, code = UNAVAILABLE) { if (!condition) throw new RuntimeBindingError(code); }
function integer(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function shape(value, keys, code = INVALID) {
  try {
    requireBinding(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
    const descriptors = Object.getOwnPropertyDescriptors(value), present = Reflect.ownKeys(descriptors);
    requireBinding(present.length === keys.length && present.every(key => typeof key === 'string' && keys.includes(key) &&
      descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { throw new RuntimeBindingError(code); }
}
function operation(action, input) {
  const selected = shape(input, ['requestId', 'expectedGeneration', ...(action === 'disconnect' ? [] : ['runtimeId', 'runtimeInstance'])]);
  requireBinding(matches(selected.requestId, REQUEST) && integer(selected.expectedGeneration), INVALID);
  requireBinding(action === 'register' ? selected.expectedGeneration === 0 : action === 'disconnect' || selected.expectedGeneration >= 1, INVALID);
  if (action !== 'disconnect') requireBinding(matches(selected.runtimeId, OPAQUE) && matches(selected.runtimeInstance, OPAQUE), INVALID);
  return { action, ...selected };
}
function digest(value, domain) { return createHash('sha256').update(domain + '\0' + JSON.stringify(value)).digest('hex'); }
function operationDigest(op) { return digest(op, 'personal-agent-runtime-operation-v1'); }

// This backend-only seam accepts an independently enrolled, trusted verifier, never a browser trust anchor.
// The verifier must validate runtime-side owner/action/generation, enrollment, expiry and atomic nonce replay protection.
// Echoing this challenge is NOT that proof. No verifier/transport/enrollment is supplied by default.
export class RuntimeBindingStore {
  #db; #verifyAuthority;
  constructor(bootstrapStore, { verifyAuthority = null } = {}) {
    this.#db = bootstrapStore?.db; this.#verifyAuthority = verifyAuthority;
    this.#transaction(() => {
      requireBinding(this.#db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB 'runtime_binding_*' OR tbl_name GLOB 'runtime_binding_*'").all().length === 0);
      const existing = this.#db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'runtime_binding_*'").all();
      const markers = this.#db.prepare('SELECT key,value_json FROM bootstrap_record WHERE namespace=?').all(MARKER_NAMESPACE);
      if (!existing.length) {
        requireBinding(markers.length === 0);
        for (const sql of TABLES.values()) this.#db.exec(sql);
        this.#db.prepare('INSERT INTO runtime_binding_schema VALUES (1)').run();
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(MARKER_NAMESPACE, 'schema', MARKER_VALUE);
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(MARKER_NAMESPACE, 'reservation-key', JSON.stringify({ key: randomBytes(32).toString('base64url') }));
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(MARKER_NAMESPACE, 'reservation-commitment', JSON.stringify(this.#sealedReservations()));
      }
      this.#schema();
    });
  }
  #transaction(run) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try { const result = run(); this.#db.exec('COMMIT'); return result; }
      catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Preserve fixed errors only. */ } throw error; }
    } catch (error) { throw error instanceof RuntimeBindingError ? error : new RuntimeBindingError(UNAVAILABLE); }
  }
  #schema() {
    const names = [...TABLES.keys()], suffix = " WHERE name GLOB 'runtime_binding_*' OR tbl_name IN (" + names.map(() => '?').join(',') + ')';
    const objects = this.#db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master' + suffix).all(...names);
    const normalized = text => text.replace(/\s+/g, ' ').trim();
    requireBinding(objects.length === TABLES.size + INDEXES.size && objects.every(row => row.type === 'table' ?
      TABLES.has(row.name) && normalized(row.sql) === normalized(TABLES.get(row.name)) :
      row.type === 'index' && row.sql === null && INDEXES.get(row.name) === row.tbl_name));
    requireBinding(this.#db.prepare('SELECT name FROM sqlite_temp_master' + suffix).all(...names).length === 0);
    const markers = this.#db.prepare('SELECT key,value_json FROM bootstrap_record WHERE namespace=?').all(MARKER_NAMESPACE);
    const versions = this.#db.prepare('SELECT version FROM runtime_binding_schema').all();
    requireBinding(markers.length === 3 && markers.every(row => ['schema', 'reservation-key', 'reservation-commitment'].includes(row.key)) &&
      markers.find(row => row.key === 'schema')?.value_json === MARKER_VALUE && versions.length === 1 && versions[0].version === 1);
    const sealed = shape(JSON.parse(markers.find(row => row.key === 'reservation-commitment').value_json), ['count', 'digest', 'mac'], UNAVAILABLE);
    const actual = this.#sealedReservations();
    requireBinding(sealed.count === actual.count && sealed.digest === actual.digest && sealed.mac === actual.mac);
  }
  #sealedReservations() {
    // Storage integrity metadata only. This key/commitment never proves runtime ownership, entitlement or execution.
    const encoded = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(MARKER_NAMESPACE, 'reservation-key');
    requireBinding(encoded);
    const { key } = shape(JSON.parse(encoded.value_json), ['key'], UNAVAILABLE);
    requireBinding(matches(key, /^[A-Za-z0-9_-]{43}$/) && Buffer.from(key, 'base64url').toString('base64url') === key);
    const rows = this.#db.prepare(`SELECT runtime_id,runtime_instance,companion_id,identity_key,first_generation
      FROM runtime_binding_incarnation ORDER BY runtime_id,runtime_instance`).all();
    requireBinding(rows.every(row => matches(row.runtime_id, OPAQUE) && matches(row.runtime_instance, OPAQUE) &&
      matches(row.companion_id, UUID) && matches(row.identity_key, HASH) && integer(row.first_generation, 1)));
    const commitment = { count: rows.length, digest: digest(rows, 'personal-agent-runtime-reservations-v1') };
    return { ...commitment, mac: createHmac('sha256', Buffer.from(key, 'base64url'))
      .update('personal-agent-runtime-reservation-commitment-v1\0' + JSON.stringify(commitment)).digest('hex') };
  }
  #receipt(owner, row) {
    requireBinding(matches(row.operation_digest, HASH) && matches(row.result_mac, HASH) &&
      typeof row.result_json === 'string' && Buffer.byteLength(row.result_json) <= 2048);
    const result = shape(JSON.parse(row.result_json), ['requestId', 'action', 'generation', 'state', 'challengeDigest', 'authorityReceiptDigest'], UNAVAILABLE);
    requireBinding(matches(result.requestId, REQUEST) && result.requestId === row.request_id && result.action === row.action &&
      ['register', 'rebind', 'disconnect'].includes(result.action) && integer(result.generation, 1) && result.generation === row.generation &&
      result.state === (result.action === 'disconnect' ? 'disconnected' : 'registered'));
    requireBinding(result.action === 'disconnect' ? result.challengeDigest === null && result.authorityReceiptDigest === null :
      matches(result.challengeDigest, HASH) && matches(result.authorityReceiptDigest, HASH));
    requireBinding(row.result_mac === this.#receiptMac(owner, row.operation_digest, result));
    return result;
  }
  #receiptMac(owner, fingerprint, result) {
    return createHmac('sha256', Buffer.from(owner.receipt_key, 'base64url'))
      .update('personal-agent-runtime-result-v1\0' + JSON.stringify({ companionId: owner.companion_id, fingerprint, result })).digest('hex');
  }
  #identity(companionId) {
    this.#schema(); requireBinding(matches(companionId, UUID));
    let identityKey; const seen = new Set();
    for (const row of this.#db.prepare("SELECT key,value_json FROM bootstrap_record WHERE namespace='companion-identity-v1'").all()) {
      const value = shape(JSON.parse(row.value_json), ['companionId'], UNAVAILABLE);
      requireBinding(matches(row.key, HASH) && matches(value.companionId, UUID) && !seen.has(value.companionId));
      seen.add(value.companionId); if (value.companionId === companionId) identityKey = row.key;
    }
    requireBinding(identityKey);
    const owner = this.#db.prepare('SELECT * FROM runtime_binding_owner WHERE companion_id=?').get(companionId);
    if (!owner) {
      for (const table of ['runtime_binding_incarnation', 'runtime_binding_request']) {
        requireBinding(!this.#db.prepare('SELECT 1 FROM ' + table + ' WHERE companion_id=? LIMIT 1').get(companionId));
      }
      return { companionId, identityKey, owner: null };
    }
    requireBinding(owner.identity_key === identityKey && integer(owner.generation, 1) &&
      matches(owner.receipt_key, /^[A-Za-z0-9_-]{43}$/) && Buffer.from(owner.receipt_key, 'base64url').toString('base64url') === owner.receipt_key &&
      ['registered', 'disconnected'].includes(owner.state));
    requireBinding(owner.state === 'registered' ? matches(owner.runtime_id, OPAQUE) && matches(owner.runtime_instance, OPAQUE) :
      owner.runtime_id === null && owner.runtime_instance === null);
    const head = this.#db.prepare('SELECT count(*) count,min(generation) first,max(generation) last FROM runtime_binding_request WHERE companion_id=?').get(companionId);
    requireBinding(head.count === owner.generation && head.first === 1 && head.last === owner.generation);
    const last = this.#db.prepare('SELECT * FROM runtime_binding_request WHERE companion_id=? AND generation=?').get(companionId, owner.generation);
    requireBinding(last);
    const receipt = this.#receipt(owner, last);
    requireBinding(receipt.state === owner.state && (receipt.action !== 'register' || owner.generation === 1));
    requireBinding(last.operation_digest === operationDigest({ action: receipt.action, requestId: receipt.requestId,
      expectedGeneration: owner.generation - 1, ...(owner.state === 'registered' ? { runtimeId: owner.runtime_id, runtimeInstance: owner.runtime_instance } : {}) }));
    if (owner.state === 'registered') this.#incarnation({ companionId, identityKey }, owner.runtime_id, owner.runtime_instance, true, owner.generation);
    return { companionId, identityKey, owner };
  }
  #incarnation(context, runtimeId, runtimeInstance, required = false, maximumGeneration = Number.MAX_SAFE_INTEGER) {
    const row = this.#db.prepare('SELECT * FROM runtime_binding_incarnation WHERE runtime_id=? AND runtime_instance=?').get(runtimeId, runtimeInstance);
    if (row) {
      requireBinding(matches(row.companion_id, UUID) && matches(row.identity_key, HASH) && integer(row.first_generation, 1));
      requireBinding(row.companion_id === context.companionId && row.identity_key === context.identityKey, required ? UNAVAILABLE : CONFLICT);
      requireBinding(row.first_generation <= maximumGeneration);
    } else requireBinding(!required);
    return row;
  }
  #cached(context, op) {
    if (!context.owner) return null;
    const row = this.#db.prepare('SELECT * FROM runtime_binding_request WHERE companion_id=? AND request_id=?').get(context.companionId, op.requestId);
    if (!row) return null;
    const receipt = this.#receipt(context.owner, row);
    requireBinding(row.operation_digest === operationDigest(op), CONFLICT);
    // A historical replay returns only its original receipt; it cannot refresh proof, route, or resurrect a binding.
    return receipt;
  }
  #check(context, op) {
    const owner = context.owner;
    requireBinding((owner?.generation ?? 0) === op.expectedGeneration, CONFLICT);
    if (op.action === 'register') requireBinding(!owner, CONFLICT);
    if (op.action === 'rebind') requireBinding(owner, MISSING);
    if (op.action === 'route') {
      requireBinding(owner?.state === 'registered', MISSING);
      requireBinding(owner.runtime_id === op.runtimeId && owner.runtime_instance === op.runtimeInstance, CONFLICT);
    }
    if (op.action !== 'disconnect') this.#incarnation(context, op.runtimeId, op.runtimeInstance);
  }
  #fresh(proof) {
    const now = Date.now();
    requireBinding(integer(now) && now >= proof.issuedAt && now < proof.expiresAt && proof.expiresAt <= proof.deadline, AUTH_UNAVAILABLE);
  }
  async #verified(context, op) {
    requireBinding(typeof this.#verifyAuthority === 'function', AUTH_UNAVAILABLE);
    const issuedAt = Date.now(); requireBinding(integer(issuedAt) && issuedAt <= Number.MAX_SAFE_INTEGER - RUNTIME_AUTHORITY_MAX_TTL_MS, AUTH_UNAVAILABLE);
    const deadline = issuedAt + RUNTIME_AUTHORITY_MAX_TTL_MS;
    const challenge = Object.freeze({ version: 1, audience: RUNTIME_BINDING_AUDIENCE, action: op.action,
      identityKey: context.identityKey, companionId: context.companionId, runtimeId: op.runtimeId, runtimeInstance: op.runtimeInstance,
      requestId: op.requestId, expectedGeneration: op.expectedGeneration, nonce: randomBytes(32).toString('base64url'), issuedAt, expiresAt: deadline });
    const challengeDigest = digest(challenge, 'personal-agent-runtime-challenge-v1'), controller = new AbortController();
    let timer;
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => this.#verifyAuthority(challenge, Object.freeze({ challengeDigest, signal: controller.signal })))
          .catch(() => { throw new RuntimeBindingError(AUTH_UNAVAILABLE); }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RuntimeBindingError(AUTH_UNAVAILABLE)); }, RUNTIME_AUTHORITY_MAX_TTL_MS); })
      ]);
      if (answer === null) throw new RuntimeBindingError(REJECTED);
      const result = shape(answer, ['challengeDigest', 'receiptDigest', 'expiresAt'], AUTH_UNAVAILABLE);
      requireBinding(result.challengeDigest === challengeDigest && matches(result.receiptDigest, HASH) && integer(result.expiresAt), AUTH_UNAVAILABLE);
      const proof = { challengeDigest, receiptDigest: result.receiptDigest, issuedAt, expiresAt: result.expiresAt, deadline };
      this.#fresh(proof); return proof;
    } catch (error) { throw new RuntimeBindingError(error instanceof RuntimeBindingError && error.code === REJECTED ? REJECTED : AUTH_UNAVAILABLE); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  #write(context, op, proof = null) {
    const generation = op.expectedGeneration + 1; requireBinding(integer(generation, 1));
    const disconnected = op.action === 'disconnect';
    const owner = context.owner ?? { companion_id: context.companionId, receipt_key: randomBytes(32).toString('base64url') };
    if (!disconnected && !this.#incarnation(context, op.runtimeId, op.runtimeInstance)) {
      this.#db.prepare('INSERT INTO runtime_binding_incarnation VALUES (?,?,?,?,?)')
        .run(op.runtimeId, op.runtimeInstance, context.companionId, context.identityKey, generation);
      this.#db.prepare('UPDATE bootstrap_record SET value_json=? WHERE namespace=? AND key=?')
        .run(JSON.stringify(this.#sealedReservations()), MARKER_NAMESPACE, 'reservation-commitment');
    }
    const values = [context.identityKey, owner.receipt_key, generation, disconnected ? 'disconnected' : 'registered',
      disconnected ? null : op.runtimeId, disconnected ? null : op.runtimeInstance, context.companionId];
    if (context.owner) this.#db.prepare('UPDATE runtime_binding_owner SET identity_key=?,receipt_key=?,generation=?,state=?,runtime_id=?,runtime_instance=? WHERE companion_id=?').run(...values);
    else this.#db.prepare('INSERT INTO runtime_binding_owner(identity_key,receipt_key,generation,state,runtime_id,runtime_instance,companion_id) VALUES (?,?,?,?,?,?,?)').run(...values);
    const result = { requestId: op.requestId, action: op.action, generation, state: disconnected ? 'disconnected' : 'registered',
      challengeDigest: proof?.challengeDigest ?? null, authorityReceiptDigest: proof?.receiptDigest ?? null };
    const fingerprint = operationDigest(op);
    this.#db.prepare('INSERT INTO runtime_binding_request VALUES (?,?,?,?,?,?,?)').run(context.companionId, op.requestId, generation,
      op.action, fingerprint, JSON.stringify(result), this.#receiptMac(owner, fingerprint, result));
    return result;
  }
  async #bind(companionId, action, input) {
    const op = operation(action, input);
    const start = this.#transaction(() => {
      const context = this.#identity(companionId), cached = this.#cached(context, op);
      if (!cached) this.#check(context, op);
      return { context, cached };
    });
    if (start.cached) return start.cached;
    const proof = await this.#verified(start.context, op);
    return this.#transaction(() => {
      const current = this.#identity(companionId); requireBinding(current.identityKey === start.context.identityKey);
      const cached = this.#cached(current, op); if (cached) return cached;
      this.#check(current, op); this.#fresh(proof);
      return this.#write(current, op, proof);
    });
  }
  register(companionId, input) { return this.#bind(companionId, 'register', input); }
  rebind(companionId, input) { return this.#bind(companionId, 'rebind', input); }
  async resolve(companionId, input) {
    const op = operation('route', input);
    const start = this.#transaction(() => { const context = this.#identity(companionId); this.#check(context, op); return context; });
    const proof = await this.#verified(start, op);
    return this.#transaction(() => {
      const current = this.#identity(companionId); requireBinding(current.identityKey === start.identityKey);
      this.#check(current, op); this.#fresh(proof);
      return { companionId, runtimeId: current.owner.runtime_id, runtimeInstance: current.owner.runtime_instance,
        generation: current.owner.generation, verifiedUntil: proof.expiresAt, challengeDigest: proof.challengeDigest, authorityReceiptDigest: proof.receiptDigest };
    });
  }
  // Local routing fence only: never remote logout, process control, credential cleanup or enrollment.
  disconnect(companionId, input) {
    const op = operation('disconnect', input);
    return this.#transaction(() => {
      const context = this.#identity(companionId), cached = this.#cached(context, op); if (cached) return cached;
      this.#check(context, op); return this.#write(context, op);
    });
  }
}
