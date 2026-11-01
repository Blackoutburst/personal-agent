import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export const GOAL_AUTHORITY_AUDIENCE = 'blackoutburst-goal-project-authority-v1';
export const GOAL_AUTHORITY_MAX_TTL_MS = 10000;
const PREFIX = 'GOALS_', UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const NAMESPACE = 'goals-authority-v1', DOCUMENT_LIMIT = 2 * 1024 * 1024;
const CONTROL_MARGIN = 64 * 1024;
const CODES = new Set(['INVALID_REQUEST', 'NOT_FOUND', 'CONFLICT', 'UNAVAILABLE', 'PAUSED', 'NOT_CONFIRMED', 'REVOKED',
  'CONFIRMATION_REQUIRED', 'NOT_YET_VALID', 'EXPIRED', 'REVIEW_REQUIRED', 'BUDGET_EXCEEDED', 'SCOPE_DENIED', 'DECISION_REQUIRED',
  'PROJECT_AUTHORITY_UNAVAILABLE', 'PROJECT_AUTHORITY_DENIED', 'CONTROL_CAPACITY']);
const TABLES = new Map([
  ['goals_schema', 'CREATE TABLE goals_schema(version INTEGER NOT NULL CHECK(version=1))'],
  ['goals_owner', 'CREATE TABLE goals_owner(companion_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, document_json TEXT NOT NULL, document_mac TEXT NOT NULL)']
]);
export class GoalError extends Error {
  constructor(code) {
    const selected = typeof code === 'string' && code.startsWith(PREFIX) ? code.slice(PREFIX.length) : code;
    const safe = CODES.has(selected) ? selected : 'UNAVAILABLE';
    super('The goal permission request could not proceed: ' + safe.toLowerCase().replaceAll('_', ' ') + '.');
    this.name = 'GoalError'; this.code = PREFIX + safe;
  }
}
function requireGoal(condition, code = 'UNAVAILABLE') { if (!condition) throw new GoalError(code); }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function shape(value, required, code = 'INVALID_REQUEST') {
  try {
    requireGoal(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireGoal(keys.length === required.length && keys.every(key => typeof key === 'string' && required.includes(key) &&
      descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
    return Object.fromEntries(required.map(key => [key, descriptors[key].value]));
  } catch { throw new GoalError(code); }
}
function text(value, maximum, empty = false) {
  requireGoal(typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && (empty || value.trim().length > 0), 'INVALID_REQUEST'); return value;
}
function array(value, maximum) {
  try {
    requireGoal(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum, 'INVALID_REQUEST');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireGoal(Reflect.ownKeys(descriptors).length === value.length + 1, 'INVALID_REQUEST');
    return Array.from({ length: value.length }, (_, index) => { const item = descriptors[index];
      requireGoal(item?.enumerable && Object.hasOwn(item, 'value'), 'INVALID_REQUEST'); return item.value; });
  } catch { throw new GoalError('INVALID_REQUEST'); }
}
function utc(value, nullable = false) {
  if (nullable && value === null) return null;
  requireGoal(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'INVALID_REQUEST'); return value;
}
function literals(value, empty = false) {
  const result = array(value, 20);
  requireGoal((empty || result.length > 0) && result.every(item => matches(item, SELECTOR)) && new Set(result).size === result.length, 'INVALID_REQUEST');
  return [...result].sort();
}
function resource(value) {
  text(value, 512);
  requireGoal(value.trim() === value && !/[\u0000-\u001f\u007f*]/.test(value), 'INVALID_REQUEST'); return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function hash(value, domain) { return createHash('sha256').update(domain + '\0' + canonical(value)).digest('hex'); }
function normalizeGoal(value, previous = null, allocate = true) {
  const selected = shape(value, ['title', 'desiredOutcome', 'notes', 'plan', 'nextStep', 'reviewAt', 'milestones', 'status']);
  text(selected.title, 160); text(selected.desiredOutcome, 2000); text(selected.notes, 4096, true); text(selected.plan, 4096, true); text(selected.nextStep, 1000, true);
  utc(selected.reviewAt, true); requireGoal(['active', 'paused'].includes(selected.status), 'INVALID_REQUEST');
  const known = new Set(previous?.milestones.map(item => item.id) ?? []), seen = new Set();
  const milestones = array(selected.milestones, 20).map(item => {
    const milestone = shape(item, ['id', 'title', 'done']); text(milestone.title, 160);
    requireGoal(typeof milestone.done === 'boolean' && (milestone.id === null || matches(milestone.id, UUID) && (!allocate || known.has(milestone.id))), 'INVALID_REQUEST');
    const id = milestone.id ?? (allocate ? randomUUID() : null);
    if (id !== null) { requireGoal(!seen.has(id), 'INVALID_REQUEST'); seen.add(id); }
    return { id, title: milestone.title, done: milestone.done };
  });
  return { ...selected, milestones };
}
function normalizeCard(value) {
  const selected = shape(value, ['title', 'projectIds', 'actions', 'taskTypes', 'resources', 'maxTasks', 'maxTokens', 'maxCostMinor',
    'currency', 'notBefore', 'expiresAt', 'reviewEveryDays', 'requireDecision', 'template']);
  text(selected.title, 160);
  for (const name of ['projectIds', 'actions', 'taskTypes']) selected[name] = literals(selected[name]);
  selected.resources = array(selected.resources, 20).map(resource);
  requireGoal(selected.resources.length > 0 && new Set(selected.resources).size === selected.resources.length, 'INVALID_REQUEST');
  selected.resources.sort();
  selected.requireDecision = literals(selected.requireDecision, true);
  requireGoal(selected.requireDecision.every(action => selected.actions.includes(action)), 'INVALID_REQUEST');
  for (const name of ['maxTasks', 'maxTokens', 'maxCostMinor']) requireGoal(integer(selected[name], 0, 1e9), 'INVALID_REQUEST');
  requireGoal(selected.maxCostMinor === 0 ? selected.currency === null : matches(selected.currency, /^[A-Z]{3}$/), 'INVALID_REQUEST');
  utc(selected.notBefore); utc(selected.expiresAt);
  requireGoal(Date.parse(selected.notBefore) < Date.parse(selected.expiresAt) && integer(selected.reviewEveryDays, 1, 365), 'INVALID_REQUEST');
  selected.template = shape(selected.template, ['title', 'instructions', 'acceptanceCriteria']);
  text(selected.template.title, 160); text(selected.template.instructions, 4000); text(selected.template.acceptanceCriteria, 2000);
  return selected;
}
const blank = () => ({ version: 1, goals: [], cards: [], requests: [], reservations: [] });

// Dedicated owner-private authority. PrivateStateStore permission/goal JSON is never read or granted authority here.
// Reservations conservatively hold lifetime estimates; no dispatch, settlement, refund, scheduler or Board transport exists.
export class GoalStore {
  #db; #verify; #now;
  constructor(bootstrapStore, { verifyProjectAuthority = null, now = Date.now } = {}) {
    this.#db = bootstrapStore?.db; this.#verify = verifyProjectAuthority; this.#now = now;
    this.#transaction(() => {
      requireGoal(this.#db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB 'goals_*' OR tbl_name GLOB 'goals_*'").all().length === 0);
      const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'goals_*'").all();
      const markers = this.#db.prepare('SELECT key FROM bootstrap_record WHERE namespace=?').all(NAMESPACE);
      if (!tables.length) {
        requireGoal(markers.length === 0);
        for (const sql of TABLES.values()) this.#db.exec(sql);
        this.#db.prepare('INSERT INTO goals_schema VALUES (1)').run();
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(NAMESPACE, 'schema', '{"version":1}');
        this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)').run(NAMESPACE, 'integrity-key', JSON.stringify({ key: randomBytes(32).toString('base64url') }));
      }
      this.#schema();
    });
  }
  #transaction(run) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try { const result = run(); this.#db.exec('COMMIT'); return result; }
      catch (error) { try { this.#db.exec('ROLLBACK'); } catch { /* Preserve fixed errors. */ } throw error; }
    } catch (error) { throw error instanceof GoalError ? error : new GoalError('UNAVAILABLE'); }
  }
  #schema() {
    const objects = this.#db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'goals_*' OR tbl_name IN ('goals_schema','goals_owner')").all();
    const sql = value => value.replace(/\s+/g, ' ').trim();
    requireGoal(objects.length === 3 && objects.every(row => row.type === 'table' ? TABLES.has(row.name) && sql(row.sql) === sql(TABLES.get(row.name)) :
      row.type === 'index' && row.name === 'sqlite_autoindex_goals_owner_1' && row.tbl_name === 'goals_owner' && row.sql === null));
    requireGoal(this.#db.prepare("SELECT name FROM sqlite_temp_master WHERE name GLOB 'goals_*' OR tbl_name IN ('goals_schema','goals_owner')").all().length === 0);
    requireGoal(this.#db.prepare('SELECT version FROM goals_schema').all().length === 1 && this.#db.prepare('SELECT version FROM goals_schema').get().version === 1);
    const marker = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(NAMESPACE, 'schema');
    requireGoal(marker?.value_json === '{"version":1}');
    this.#key();
  }
  #key() {
    const row = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(NAMESPACE, 'integrity-key');
    requireGoal(row && typeof row.value_json === 'string' && row.value_json.length < 100);
    const { key } = shape(JSON.parse(row.value_json), ['key'], 'UNAVAILABLE');
    requireGoal(matches(key, /^[A-Za-z0-9_-]{43}$/) && Buffer.from(key, 'base64url').toString('base64url') === key);
    return Buffer.from(key, 'base64url');
  }
  #mac(value, purpose) { return createHmac('sha256', this.#key()).update('personal-agent-goals-' + purpose + '-v1\0' + canonical(value)).digest('hex'); }
  #time() { try { const now = this.#now(); requireGoal(integer(now) && now <= 8640000000000000); return now; } catch { throw new GoalError('UNAVAILABLE'); } }
  #load(companionId) {
    this.#schema(); requireGoal(matches(companionId, UUID));
    let identityKey; const seen = new Set();
    for (const row of this.#db.prepare("SELECT key,value_json FROM bootstrap_record WHERE namespace='companion-identity-v1'").all()) {
      const value = shape(JSON.parse(row.value_json), ['companionId'], 'UNAVAILABLE');
      requireGoal(matches(row.key, HASH) && matches(value.companionId, UUID) && !seen.has(value.companionId));
      seen.add(value.companionId); if (value.companionId === companionId) identityKey = row.key;
    }
    requireGoal(identityKey);
    const row = this.#db.prepare('SELECT * FROM goals_owner WHERE companion_id=?').get(companionId);
    const marker = this.#db.prepare('SELECT value_json FROM bootstrap_record WHERE namespace=? AND key=?').get(NAMESPACE, 'owner.' + companionId);
    if (!row) { requireGoal(!marker); return { companionId, identityKey, document: blank(), exists: false }; }
    requireGoal(marker?.value_json === JSON.stringify({ mac: this.#mac({ companionId, identityKey }, 'owner') }) && row.identity_key === identityKey &&
      typeof row.document_json === 'string' && Buffer.byteLength(row.document_json) <= DOCUMENT_LIMIT &&
      row.document_mac === this.#mac({ companionId, identityKey, json: row.document_json }, 'document'));
    const document = shape(JSON.parse(row.document_json), ['version', 'goals', 'cards', 'requests', 'reservations'], 'UNAVAILABLE');
    requireGoal(document.version === 1 && Array.isArray(document.goals) && document.goals.length <= 20 && Array.isArray(document.cards) && document.cards.length <= 20 &&
      Array.isArray(document.requests) && document.requests.length <= 4096 && Array.isArray(document.reservations) && document.reservations.length <= 4096);
    requireGoal(new Set(document.goals.map(item => item.id)).size === document.goals.length && new Set(document.cards.map(item => item.id)).size === document.cards.length &&
      new Set(document.cards.map(item => item.goalId)).size === document.cards.length && new Set(document.requests.map(item => item.requestId)).size === document.requests.length &&
      new Set(document.reservations.map(item => item.id)).size === document.reservations.length);
    for (const goal of document.goals) requireGoal(matches(goal.id, UUID) && integer(goal.version, 1) && integer(goal.authorizationGeneration, 1));
    for (const card of document.cards) {
      requireGoal(matches(card.id, UUID) && document.goals.some(goal => goal.id === card.goalId) && integer(card.version, 1) && ['draft', 'confirmed', 'revoked'].includes(card.state));
      const held = document.reservations.filter(item => item.cardId === card.id);
      requireGoal(card.usage.tasks === held.length && card.usage.tokens === held.reduce((sum, item) => sum + item.scope.tokens, 0) &&
        card.usage.costMinor === held.reduce((sum, item) => sum + item.scope.costMinor, 0));
    }
    return { companionId, identityKey, document, exists: true };
  }
  #save(context) {
    const json = JSON.stringify(context.document); requireGoal(Buffer.byteLength(json) <= DOCUMENT_LIMIT);
    const mac = this.#mac({ companionId: context.companionId, identityKey: context.identityKey, json }, 'document');
    if (!context.exists) this.#db.prepare('INSERT INTO bootstrap_record VALUES (?,?,?)')
      .run(NAMESPACE, 'owner.' + context.companionId, JSON.stringify({ mac: this.#mac({ companionId: context.companionId, identityKey: context.identityKey }, 'owner') }));
    this.#db.prepare('INSERT INTO goals_owner VALUES (?,?,?,?) ON CONFLICT(companion_id) DO UPDATE SET document_json=excluded.document_json,document_mac=excluded.document_mac')
      .run(context.companionId, context.identityKey, json, mac);
  }
  #goal(context, id) { const goal = context.document.goals.find(item => item.id === id); requireGoal(goal, 'NOT_FOUND'); return goal; }
  #card(context, id) { const card = context.document.cards.find(item => item.id === id); requireGoal(card, 'NOT_FOUND'); return card; }
  #preview(context, card) {
    const goal = this.#goal(context, card.goalId);
    return hash({ companionId: context.companionId, identityKey: context.identityKey, goalId: goal.id,
      authorizationGeneration: goal.authorizationGeneration, cardId: card.id, version: card.version, card: card.card }, 'personal-agent-goal-preview-v1');
  }
  #reason(goal, card, now, newTask = false) {
    if (goal.goal.status !== 'active') return 'PAUSED';
    if (card.state === 'revoked') return 'REVOKED';
    if (card.state !== 'confirmed') return 'NOT_CONFIRMED';
    if (card.confirmedAuthorizationGeneration !== goal.authorizationGeneration) return 'CONFIRMATION_REQUIRED';
    if (now < Date.parse(card.card.notBefore)) return 'NOT_YET_VALID';
    if (now >= Date.parse(card.card.expiresAt)) return 'EXPIRED';
    if (now >= Date.parse(card.confirmedAt) + card.card.reviewEveryDays * 86400000) return 'REVIEW_REQUIRED';
    if (card.usage.tasks + (newTask ? 1 : 0) > card.card.maxTasks || card.usage.tokens > card.card.maxTokens || card.usage.costMinor > card.card.maxCostMinor) return 'BUDGET_EXCEEDED';
    return null;
  }
  #controlCapacity(context) {
    // Do not authorize effects when new pause/revoke receipts cannot be retained. No compaction/refund is implicit.
    return context.document.requests.length < 4096 && Buffer.byteLength(JSON.stringify(context.document)) <= DOCUMENT_LIMIT - CONTROL_MARGIN;
  }
  #snapshot(context) {
    const now = this.#time(), controlCapacity = this.#controlCapacity(context);
    return { goals: context.document.goals.map(goal => ({ ...goal, progress: { done: goal.goal.milestones.filter(item => item.done).length, total: goal.goal.milestones.length } })),
      cards: context.document.cards.map(card => {
        const goal = this.#goal(context, card.goalId), reason = controlCapacity ? this.#reason(goal, card, now, true) : 'CONTROL_CAPACITY';
        return { ...card, previewDigest: this.#preview(context, card), preview: { projectIds: card.card.projectIds, actions: card.card.actions,
          taskTypes: card.card.taskTypes, resources: card.card.resources, template: card.card.template }, authorizationGeneration: goal.authorizationGeneration,
          reviewDueAt: card.confirmedAt === null ? null : new Date(Date.parse(card.confirmedAt) + card.card.reviewEveryDays * 86400000).toISOString(),
          remaining: { tasks: Math.max(0, card.card.maxTasks - card.usage.tasks), tokens: Math.max(0, card.card.maxTokens - card.usage.tokens),
            costMinor: Math.max(0, card.card.maxCostMinor - card.usage.costMinor) }, blockedReason: reason === null ? null : PREFIX + reason };
      }) };
  }
  #request(context, requestId, normalized, mutate) {
    requireGoal(matches(requestId, REQUEST), 'INVALID_REQUEST');
    const fingerprint = this.#mac(normalized, 'request'), prior = context.document.requests.find(item => item.requestId === requestId);
    if (prior) { requireGoal(prior.fingerprint === fingerprint, 'CONFLICT'); return { result: structuredClone(prior.result), replayed: true }; }
    requireGoal(context.document.requests.length < 4096);
    const result = mutate(); context.document.requests.push({ requestId, fingerprint, result }); return { result, replayed: false };
  }
  handle(companionId, payload) {
    return this.#transaction(() => {
      const context = this.#load(companionId);
      const action = shape(payload, ['action', ...Object.keys(payload ?? {}).filter(key => key !== 'action')]).action;
      if (action === 'snapshot') { shape(payload, ['action']); return structuredClone(this.#snapshot(context)); }
      const fields = action === 'saveGoal' ? ['goalId', 'expectedVersion', 'goal'] : action === 'saveCard' ? ['goalId', 'cardId', 'expectedVersion', 'card'] :
        action === 'confirmCard' ? ['cardId', 'expectedVersion', 'previewDigest', 'confirm'] : action === 'revokeCard' ? ['cardId', 'expectedVersion'] :
        action === 'reviewGoal' ? ['goalId', 'expectedVersion'] : null;
      requireGoal(fields, 'INVALID_REQUEST');
      const selected = shape(payload, ['action', 'requestId', ...fields]);
      requireGoal(integer(selected.expectedVersion), 'INVALID_REQUEST');
      let normalized;
      if (action === 'saveGoal') {
        requireGoal(selected.goalId === null || matches(selected.goalId, UUID), 'INVALID_REQUEST');
        const before = selected.goalId === null ? null : this.#goal(context, selected.goalId);
        // Validate without allocating new milestone IDs until the request is known not to be a replay.
        const raw = normalizeGoal(selected.goal, before?.goal, false);
        normalized = { ...selected, goal: raw };
        const outcome = this.#request(context, selected.requestId, normalized, () => {
          requireGoal(selected.expectedVersion === (before?.version ?? 0), 'CONFLICT');
          requireGoal(before || context.document.goals.length < 20);
          const goalValue = normalizeGoal(raw, before?.goal), generation = before ? before.authorizationGeneration + (before.goal.status !== goalValue.status ? 1 : 0) : 1;
          requireGoal(integer(generation, 1) && (!before || before.version < Number.MAX_SAFE_INTEGER));
          const goal = { id: before?.id ?? randomUUID(), version: (before?.version ?? 0) + 1, authorizationGeneration: generation,
            goal: goalValue, reviewedAt: before?.reviewedAt ?? null };
          if (before) context.document.goals[context.document.goals.indexOf(before)] = goal; else context.document.goals.push(goal);
          return { action, requestId: selected.requestId, goalId: goal.id, cardId: null, version: goal.version, authorizationGeneration: generation };
        });
        if (!outcome.replayed) this.#save(context); return outcome.result;
      }
      if (action === 'saveCard') requireGoal(matches(selected.goalId, UUID) && (selected.cardId === null || matches(selected.cardId, UUID)), 'INVALID_REQUEST');
      else if (action === 'reviewGoal') requireGoal(matches(selected.goalId, UUID), 'INVALID_REQUEST');
      else requireGoal(matches(selected.cardId, UUID), 'INVALID_REQUEST');
      if (action === 'confirmCard') requireGoal(selected.confirm === true && matches(selected.previewDigest, HASH), 'INVALID_REQUEST');
      if (action === 'saveCard') normalized = { ...selected, card: normalizeCard(selected.card) };
      else normalized = selected;
      const outcome = this.#request(context, selected.requestId, normalized, () => {
        if (action === 'reviewGoal') {
          requireGoal(matches(selected.goalId, UUID), 'INVALID_REQUEST'); const goal = this.#goal(context, selected.goalId);
          requireGoal(goal.version === selected.expectedVersion, 'CONFLICT'); requireGoal(goal.version < Number.MAX_SAFE_INTEGER);
          goal.version++; goal.reviewedAt = new Date(this.#time()).toISOString();
          return { action, requestId: selected.requestId, goalId: goal.id, cardId: null, version: goal.version, authorizationGeneration: goal.authorizationGeneration };
        }
        if (action === 'saveCard') {
          requireGoal(matches(selected.goalId, UUID) && (selected.cardId === null || matches(selected.cardId, UUID)), 'INVALID_REQUEST');
          const goal = this.#goal(context, selected.goalId), before = selected.cardId === null ? null : this.#card(context, selected.cardId);
          requireGoal(!before || before.goalId === goal.id, 'NOT_FOUND');
          requireGoal(selected.expectedVersion === (before?.version ?? 0) && (before || !context.document.cards.some(item => item.goalId === goal.id)), 'CONFLICT');
          requireGoal(before || context.document.cards.length < 20);
          const usage = before?.usage ?? { tasks: 0, tokens: 0, costMinor: 0, currency: normalized.card.currency };
          requireGoal(normalized.card.maxTasks >= usage.tasks && normalized.card.maxTokens >= usage.tokens && normalized.card.maxCostMinor >= usage.costMinor &&
            (usage.costMinor === 0 || normalized.card.currency === usage.currency), 'CONFLICT');
          requireGoal(!before || before.version < Number.MAX_SAFE_INTEGER);
          const card = { id: before?.id ?? randomUUID(), goalId: goal.id, version: (before?.version ?? 0) + 1, state: 'draft', card: normalized.card,
            confirmedAuthorizationGeneration: null, confirmedAt: null, usage: { ...usage, currency: normalized.card.currency } };
          if (before) context.document.cards[context.document.cards.indexOf(before)] = card; else context.document.cards.push(card);
          return { action, requestId: selected.requestId, goalId: goal.id, cardId: card.id, version: card.version, authorizationGeneration: goal.authorizationGeneration };
        }
        requireGoal(matches(selected.cardId, UUID), 'INVALID_REQUEST');
        const card = this.#card(context, selected.cardId), goal = this.#goal(context, card.goalId);
        requireGoal(card.version === selected.expectedVersion, 'CONFLICT'); requireGoal(card.version < Number.MAX_SAFE_INTEGER);
        if (action === 'confirmCard') {
          requireGoal(selected.confirm === true && matches(selected.previewDigest, HASH), 'INVALID_REQUEST');
          requireGoal(selected.previewDigest === this.#preview(context, card), 'CONFLICT');
          requireGoal(goal.goal.status === 'active', 'PAUSED'); requireGoal(card.state !== 'revoked', 'REVOKED');
          requireGoal(this.#time() < Date.parse(card.card.expiresAt), 'EXPIRED');
          card.state = 'confirmed'; card.confirmedAt = new Date(this.#time()).toISOString(); card.confirmedAuthorizationGeneration = goal.authorizationGeneration;
        } else { card.state = 'revoked'; card.confirmedAt = null; card.confirmedAuthorizationGeneration = null; }
        card.version++;
        return { action, requestId: selected.requestId, goalId: goal.id, cardId: card.id, version: card.version, authorizationGeneration: goal.authorizationGeneration };
      });
      if (!outcome.replayed) this.#save(context); return outcome.result;
    });
  }
  #candidate(input) {
    const value = shape(input, ['cardId', 'expectedVersion', 'authorizationGeneration', 'requestId', 'projectId', 'action', 'taskType', 'resource', 'tokens', 'costMinor', 'currency']);
    requireGoal(matches(value.cardId, UUID) && integer(value.expectedVersion, 1) && integer(value.authorizationGeneration, 1) && matches(value.requestId, REQUEST), 'INVALID_REQUEST');
    for (const name of ['projectId', 'action', 'taskType']) requireGoal(matches(value[name], SELECTOR), 'INVALID_REQUEST');
    resource(value.resource);
    requireGoal(integer(value.tokens, 0, 1e9) && integer(value.costMinor, 0, 1e9) && (value.currency === null || matches(value.currency, /^[A-Z]{3}$/)), 'INVALID_REQUEST');
    return value;
  }
  #allowed(context, candidate, newTask = true) {
    requireGoal(this.#controlCapacity(context), 'CONTROL_CAPACITY');
    const card = this.#card(context, candidate.cardId), goal = this.#goal(context, card.goalId);
    requireGoal(card.version === candidate.expectedVersion && goal.authorizationGeneration === candidate.authorizationGeneration, 'CONFLICT');
    const reason = this.#reason(goal, card, this.#time(), newTask); requireGoal(reason === null, reason ?? 'UNAVAILABLE');
    const policy = card.card;
    requireGoal(policy.projectIds.includes(candidate.projectId) && policy.actions.includes(candidate.action) && policy.taskTypes.includes(candidate.taskType) && policy.resources.includes(candidate.resource), 'SCOPE_DENIED');
    requireGoal(!policy.requireDecision.includes(candidate.action), 'DECISION_REQUIRED');
    requireGoal(candidate.currency === policy.currency, 'SCOPE_DENIED');
    requireGoal(card.usage.tokens + (newTask ? candidate.tokens : 0) <= policy.maxTokens && card.usage.costMinor + (newTask ? candidate.costMinor : 0) <= policy.maxCostMinor, 'BUDGET_EXCEEDED');
    return { card, goal };
  }
  #fresh(proof) { const now = this.#time(); requireGoal(now >= proof.issuedAt && now < proof.expiresAt && proof.expiresAt <= proof.deadline, 'PROJECT_AUTHORITY_UNAVAILABLE'); }
  // The trusted server adapter must independently verify enrolled owner/profile/project scope and nonce replay protection.
  // An echoed digest/browser key is not authority. No live adapter or Board permission is supplied by this module.
  async #verified(context, candidate, purpose) {
    requireGoal(typeof this.#verify === 'function', 'PROJECT_AUTHORITY_UNAVAILABLE');
    const issuedAt = this.#time(), deadline = issuedAt + GOAL_AUTHORITY_MAX_TTL_MS;
    const challenge = Object.freeze({ version: 1, audience: GOAL_AUTHORITY_AUDIENCE, purpose, identityKey: context.identityKey, companionId: context.companionId,
      projectId: candidate.projectId, action: candidate.action, taskType: candidate.taskType, resource: candidate.resource,
      tokens: candidate.tokens, costMinor: candidate.costMinor, currency: candidate.currency, requestId: candidate.requestId,
      nonce: randomBytes(32).toString('base64url'), issuedAt, expiresAt: deadline });
    const challengeDigest = hash(challenge, 'personal-agent-goal-authority-v1'), controller = new AbortController(); let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.#verify(challenge, Object.freeze({ challengeDigest, signal: controller.signal })))
          .catch(() => { throw new GoalError('PROJECT_AUTHORITY_UNAVAILABLE'); }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GoalError('PROJECT_AUTHORITY_UNAVAILABLE')); }, GOAL_AUTHORITY_MAX_TTL_MS); })
      ]);
      if (result === null) throw new GoalError('PROJECT_AUTHORITY_DENIED');
      const response = shape(result, ['challengeDigest', 'receiptDigest', 'expiresAt'], 'PROJECT_AUTHORITY_UNAVAILABLE');
      requireGoal(response.challengeDigest === challengeDigest && matches(response.receiptDigest, HASH) && integer(response.expiresAt), 'PROJECT_AUTHORITY_UNAVAILABLE');
      const proof = { issuedAt, deadline, expiresAt: response.expiresAt, receiptDigest: response.receiptDigest };
      this.#fresh(proof); return proof;
    } catch (error) { throw new GoalError(error instanceof GoalError && error.code === PREFIX + 'PROJECT_AUTHORITY_DENIED' ? 'PROJECT_AUTHORITY_DENIED' : 'PROJECT_AUTHORITY_UNAVAILABLE'); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  #projection(context, candidate, proof, reservationId = null) {
    const { card, goal } = this.#allowed(context, candidate, reservationId === null);
    return { eligible: true, work: { projectId: candidate.projectId, action: candidate.action, taskType: candidate.taskType, resource: candidate.resource,
      template: structuredClone(card.card.template) }, grant: { cardId: card.id, cardVersion: card.version, authorizationGeneration: goal.authorizationGeneration,
      ...(reservationId === null ? {} : { reservationId }), authorityReceiptDigest: proof.receiptDigest, verifiedUntil: proof.expiresAt } };
  }
  async evaluate(companionId, input) {
    const candidate = this.#candidate(input);
    const start = this.#transaction(() => { const context = this.#load(companionId); this.#allowed(context, candidate); return context; });
    const proof = await this.#verified(start, candidate, 'evaluate');
    return this.#transaction(() => { const current = this.#load(companionId); requireGoal(current.identityKey === start.identityKey); this.#fresh(proof); return this.#projection(current, candidate, proof); });
  }
  async reserve(companionId, input) {
    const candidate = this.#candidate(input), normalized = { action: 'reserve', candidate };
    const start = this.#transaction(() => {
      const context = this.#load(companionId), prior = context.document.requests.find(item => item.requestId === candidate.requestId);
      if (prior) { requireGoal(prior.fingerprint === this.#mac(normalized, 'request'), 'CONFLICT'); return { context, cached: structuredClone(prior.result) }; }
      this.#allowed(context, candidate); return { context, cached: null };
    });
    if (start.cached) return start.cached;
    const proof = await this.#verified(start.context, candidate, 'reserve');
    return this.#transaction(() => {
      const current = this.#load(companionId); requireGoal(current.identityKey === start.context.identityKey);
      if (!current.document.requests.some(item => item.requestId === candidate.requestId)) requireGoal(this.#controlCapacity(current), 'CONTROL_CAPACITY');
      const outcome = this.#request(current, candidate.requestId, normalized, () => {
        this.#fresh(proof); const { card, goal } = this.#allowed(current, candidate); requireGoal(current.document.reservations.length < 4096);
        const id = randomUUID(); card.usage.tasks++; card.usage.tokens += candidate.tokens; card.usage.costMinor += candidate.costMinor;
        const { projectId, action, taskType, resource, tokens, costMinor, currency } = candidate;
        current.document.reservations.push({ id, cardId: card.id, cardVersion: card.version, authorizationGeneration: goal.authorizationGeneration,
          requestId: candidate.requestId, scope: { projectId, action, taskType, resource, tokens, costMinor, currency } });
        return { reservationId: id, cardId: card.id, cardVersion: card.version, authorizationGeneration: goal.authorizationGeneration };
      });
      if (!outcome.replayed) this.#save(current); return outcome.result;
    });
  }
  async checkReservation(companionId, input) {
    const { reservationId } = shape(input, ['reservationId']); requireGoal(matches(reservationId, UUID), 'INVALID_REQUEST');
    const get = context => { const reservation = context.document.reservations.find(item => item.id === reservationId); requireGoal(reservation, 'NOT_FOUND');
      const candidate = this.#candidate({ cardId: reservation.cardId, expectedVersion: reservation.cardVersion,
        authorizationGeneration: reservation.authorizationGeneration, requestId: reservation.requestId, ...reservation.scope });
      this.#allowed(context, candidate, false); return candidate; };
    const start = this.#transaction(() => { const context = this.#load(companionId); return { context, candidate: get(context) }; });
    const proof = await this.#verified(start.context, start.candidate, 'checkReservation');
    return this.#transaction(() => { const current = this.#load(companionId); requireGoal(current.identityKey === start.context.identityKey);
      const candidate = get(current); this.#fresh(proof); return this.#projection(current, candidate, proof, reservationId); });
  }
}
