const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WRITES = new Set(['saveGoal', 'reviewGoal', 'saveCard', 'revokeCard']);
const CODES = new Set(['INVALID_REQUEST', 'NOT_READY', 'BUSY', 'ACCESS_DENIED', 'UNAVAILABLE', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'CONFLICT', 'NOT_FOUND']);
const encoder = new TextEncoder();

export class GoalsClientError extends Error {
  constructor(code) { super('The goals action could not complete.'); this.name = 'GoalsClientError'; this.code = CODES.has(code) ? code : 'INVALID_RESPONSE'; }
}
function check(condition, code = 'INVALID_RESPONSE') { if (!condition) throw new GoalsClientError(code); }
function object(value, required, optional = [], code = 'INVALID_RESPONSE') {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(required.every(key => Object.hasOwn(descriptors, key)) && keys.every(key => typeof key === 'string'
    && [...required, ...optional].includes(key) && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
  return value;
}
function string(value, maximum, empty = false) {
  check(typeof value === 'string' && encoder.encode(value).length <= maximum && (empty || value.trim().length));
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++index); check(next >= 0xdc00 && next <= 0xdfff); }
    else check(unit < 0xdc00 || unit > 0xdfff);
  }
  return value;
}
function id(value) { check(typeof value === 'string' && UUID.test(value)); return value; }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) { check(Number.isSafeInteger(value) && value >= minimum && value <= maximum); return value; }
function date(value, nullable = false) {
  if (nullable && value === null) return null;
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value); return value;
}
function selectors(value, empty = false) {
  check(Array.isArray(value) && value.length <= 20 && (empty || value.length > 0) && new Set(value).size === value.length);
  for (const item of value) check(typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item));
}
function resources(value) {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 20 && new Set(value).size === value.length);
  for (const item of value) { string(item, 512); check(item === item.trim() && !/[*\u0000-\u001f\u007f]/.test(item)); }
}
function template(value) {
  object(value, ['title', 'instructions', 'acceptanceCriteria']);
  string(value.title, 160); string(value.instructions, 4000); string(value.acceptanceCriteria, 2000);
}
function goal(value) {
  object(value, ['title', 'desiredOutcome', 'notes', 'plan', 'nextStep', 'reviewAt', 'milestones', 'status']);
  string(value.title, 160); string(value.desiredOutcome, 2000); string(value.notes, 4096, true);
  string(value.plan, 4096, true); string(value.nextStep, 1000, true); date(value.reviewAt, true);
  check(['active', 'paused'].includes(value.status) && Array.isArray(value.milestones) && value.milestones.length <= 20);
  const ids = new Set();
  for (const item of value.milestones) { object(item, ['id', 'title', 'done']); id(item.id); string(item.title, 160); check(typeof item.done === 'boolean' && !ids.has(item.id)); ids.add(item.id); }
}
function card(value) {
  object(value, ['title', 'projectIds', 'actions', 'taskTypes', 'resources', 'maxTasks', 'maxTokens', 'maxCostMinor', 'currency',
    'notBefore', 'expiresAt', 'reviewEveryDays', 'requireDecision', 'template']);
  string(value.title, 160);
  for (const key of ['projectIds', 'actions', 'taskTypes']) selectors(value[key]);
  resources(value.resources);
  selectors(value.requireDecision, true); check(value.requireDecision.every(action => value.actions.includes(action)));
  for (const key of ['maxTasks', 'maxTokens', 'maxCostMinor']) integer(value[key], 0, 1e9);
  check(value.maxCostMinor === 0 ? value.currency === null : typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency));
  date(value.notBefore); date(value.expiresAt); check(value.notBefore < value.expiresAt);
  integer(value.reviewEveryDays, 1, 365); template(value.template);
}
function snapshot(value) {
  object(value, ['goals', 'cards']); check(Array.isArray(value.goals) && value.goals.length <= 20 && Array.isArray(value.cards) && value.cards.length <= 20);
  const goalIds = new Set(), cardIds = new Set(), cardGoals = new Set();
  for (const entry of value.goals) {
    object(entry, ['id', 'version', 'authorizationGeneration', 'goal', 'reviewedAt', 'progress']);
    id(entry.id); check(!goalIds.has(entry.id)); goalIds.add(entry.id); integer(entry.version, 1); integer(entry.authorizationGeneration);
    goal(entry.goal); date(entry.reviewedAt, true); object(entry.progress, ['done', 'total']);
    check(entry.progress.total === entry.goal.milestones.length && entry.progress.done === entry.goal.milestones.filter(item => item.done).length);
  }
  for (const entry of value.cards) {
    object(entry, ['id', 'goalId', 'version', 'state', 'card', 'previewDigest', 'preview', 'authorizationGeneration',
      'confirmedAuthorizationGeneration', 'confirmedAt', 'reviewDueAt', 'usage', 'remaining', 'blockedReason']);
    id(entry.id); id(entry.goalId); check(goalIds.has(entry.goalId) && !cardIds.has(entry.id) && !cardGoals.has(entry.goalId));
    cardIds.add(entry.id); cardGoals.add(entry.goalId); integer(entry.version, 1); integer(entry.authorizationGeneration);
    check(['draft', 'confirmed', 'revoked'].includes(entry.state)); card(entry.card);
    check(typeof entry.previewDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.previewDigest));
    object(entry.preview, ['projectIds', 'actions', 'taskTypes', 'resources', 'template']);
    for (const key of ['projectIds', 'actions', 'taskTypes', 'resources']) check(JSON.stringify(entry.preview[key]) === JSON.stringify(entry.card[key]));
    template(entry.preview.template);
    for (const key of ['title', 'instructions', 'acceptanceCriteria']) check(entry.preview.template[key] === entry.card.template[key]);
    if (entry.confirmedAuthorizationGeneration !== null) integer(entry.confirmedAuthorizationGeneration);
    date(entry.confirmedAt, true); date(entry.reviewDueAt, true);
    object(entry.usage, ['tasks', 'tokens', 'costMinor', 'currency']); object(entry.remaining, ['tasks', 'tokens', 'costMinor']);
    for (const field of ['tasks', 'tokens', 'costMinor']) { integer(entry.usage[field]); integer(entry.remaining[field]); }
    check(entry.usage.currency === null || /^[A-Z]{3}$/.test(entry.usage.currency));
    check(entry.blockedReason === null || typeof entry.blockedReason === 'string' && /^GOALS_[A-Z_]+$/.test(entry.blockedReason));
  }
  return structuredClone(value);
}
function payloadFor(action, value) {
  const required = action === 'saveGoal' ? ['goalId', 'expectedVersion', 'goal'] : action === 'saveCard'
    ? ['goalId', 'cardId', 'expectedVersion', 'card'] : action === 'reviewGoal' ? ['goalId', 'expectedVersion'] : ['cardId', 'expectedVersion'];
  object(value, required, [], 'INVALID_REQUEST');
  check(Number.isSafeInteger(value.expectedVersion) && value.expectedVersion >= 0, 'INVALID_REQUEST');
  for (const key of ['goalId', 'cardId']) if (Object.hasOwn(value, key)) check(value[key] === null || typeof value[key] === 'string' && UUID.test(value[key]), 'INVALID_REQUEST');
  // Field semantics are checked again by the authoritative server. The UI never selects owner/runtime scope.
  return structuredClone(value);
}

export function createGoalsTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async (action, payload, { signal, expectedCompanionId = null } = {}) => {
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15000); let response;
    try {
      check(expectedCompanionId === null || typeof expectedCompanionId === 'string' && UUID.test(expectedCompanionId), 'INVALID_REQUEST');
      response = await fetchImpl('api/goals', { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...payload, action, ...(expectedCompanionId === null ? {} : { expectedCompanionId }) }) });
      if ([401, 403].includes(response.status)) throw new GoalsClientError('ACCESS_DENIED');
      if (!response.ok) throw new GoalsClientError(response.status === 409 ? 'CONFLICT' : response.status === 404 ? 'NOT_FOUND' : response.status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST');
      check(!response.redirected && /^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''));
      const maximum = 4 * 1024 * 1024, reader = response.body?.getReader();
      let text;
      if (reader) {
        const parts = []; let size = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; check(size <= maximum); parts.push(part.value); }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new GoalsClientError('INVALID_RESPONSE'); }
        } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
      } else { text = await response.text(); check(encoder.encode(text).length <= maximum); }
      try { return JSON.parse(text); } catch { throw new GoalsClientError('INVALID_RESPONSE'); }
    } catch (error) { throw error instanceof GoalsClientError ? error : new GoalsClientError('NETWORK_ERROR'); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}

const initial = () => ({ connection: 'disconnected', mode: null, synthetic: null, companionId: null, goals: [], cards: [], pending: null, reviewed: null, lastReceipt: null, error: null });
export function createGoalsClient({ transport = createGoalsTransport(), requestId = () => globalThis.crypto.randomUUID() } = {}) {
  let state = initial(), epoch = 0, readGeneration = 0;
  const listeners = new Set(), requests = new Set(), copy = () => structuredClone(state);
  const emit = () => { for (const listener of listeners) { try { listener(copy()); } catch { /* View errors cannot retain model authority. */ } } };
  function clear(connection = 'disconnected', error = null) {
    epoch++; for (const controller of requests) controller.abort(); requests.clear(); state = { ...initial(), connection, error }; emit(); return copy();
  }
  async function call(action, payload, version) {
    const controller = new AbortController(); requests.add(controller);
    const expectedCompanionId = state.companionId;
    try {
      const body = await transport(action, payload, { signal: controller.signal, expectedCompanionId });
      if (version !== epoch) return null;
      object(body, ['version', 'synthetic', 'data'], ['companionId']); check(body.version === 1 && body.synthetic === (state.mode === 'demo'));
      if (expectedCompanionId !== null) check(body.companionId === expectedCompanionId, 'ACCESS_DENIED');
      else { id(body.companionId); check(action === 'snapshot'); state = { ...state, companionId: body.companionId }; }
      return body.data;
    } finally { requests.delete(controller); }
  }
  function failure(error, version, pending = null) {
    if (version !== epoch) return;
    const code = error instanceof GoalsClientError ? error.code : 'NETWORK_ERROR';
    if (['ACCESS_DENIED', 'INVALID_RESPONSE'].includes(code)) { clear(code === 'ACCESS_DENIED' ? 'denied' : 'unavailable', code); return; }
    const uncertain = ['NETWORK_ERROR', 'UNAVAILABLE'].includes(code);
    state = { ...state, connection: uncertain ? 'reconnecting' : 'ready', reviewed: null, error: code,
      pending: uncertain && pending ? { ...pending, status: pending.status === 'acknowledged' ? 'acknowledged' : 'uncertain' } : null }; emit();
  }
  async function load(version, pending = null) {
    const generation = ++readGeneration;
    try {
      const data = await call('snapshot', {}, version); if (version !== epoch || generation !== readGeneration) return;
      const values = snapshot(data); state = { ...state, ...values, connection: 'ready', synthetic: state.mode === 'demo', pending: null, reviewed: null, error: null }; emit();
    } catch (error) {
      // A stale read cannot replace a newer workspace. A same-session denial still clears private state.
      if (generation === readGeneration || error instanceof GoalsClientError && error.code === 'ACCESS_DENIED') failure(error, version, pending);
    }
  }
  async function perform(pending, version) {
    try {
      const receipt = await call(pending.action, { requestId: pending.requestId, ...pending.payload }, version); if (version !== epoch) return;
      object(receipt, ['action', 'requestId', 'goalId', 'cardId', 'version', 'authorizationGeneration']);
      check(receipt.action === pending.action && receipt.requestId === pending.requestId); id(receipt.goalId);
      if (receipt.cardId !== null) id(receipt.cardId); integer(receipt.version, 1); integer(receipt.authorizationGeneration);
      for (const key of ['goalId', 'cardId']) if (pending.payload[key]) check(receipt[key] === pending.payload[key]);
      const acknowledged = { ...pending, status: 'acknowledged' };
      state = { ...state, pending: acknowledged, reviewed: null, lastReceipt: structuredClone(receipt) }; emit(); await load(version, acknowledged);
    } catch (error) { failure(error, version, pending); }
    return copy();
  }
  function beginWrite(action, payload) {
    check(state.connection === 'ready' && state.companionId !== null, 'NOT_READY'); check(!state.pending, 'BUSY');
    const key = requestId(); check(typeof key === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(key), 'INVALID_REQUEST');
    const pending = { action, requestId: key, payload: structuredClone(payload), status: 'submitting' };
    state = { ...state, pending, reviewed: null, error: null }; emit(); return perform(pending, epoch);
  }
  return Object.freeze({ getState: copy,
    subscribe(listener) { check(typeof listener === 'function', 'INVALID_REQUEST'); listeners.add(listener); listener(copy()); return () => listeners.delete(listener); },
    async open(mode) { check(['demo', 'account'].includes(mode), 'INVALID_REQUEST'); clear(); const version = epoch; state = { ...state, mode, connection: 'loading' }; emit(); await load(version); return copy(); },
    async refresh() { check(state.mode !== null && ['ready', 'reconnecting'].includes(state.connection)
      && (!state.pending || state.pending.status === 'acknowledged'), 'BUSY'); const version = epoch;
      state = { ...state, connection: 'loading', reviewed: null }; emit(); await load(version, state.pending); return copy(); },
    write(action, payload) { check(WRITES.has(action), 'INVALID_REQUEST'); return beginWrite(action, payloadFor(action, payload)); },
    markPreviewReviewed(cardId) {
      check(state.connection === 'ready' && !state.pending, 'NOT_READY');
      const selected = state.cards.find(item => item.id === cardId), ownerGoal = selected && state.goals.find(item => item.id === selected.goalId);
      check(selected && selected.state !== 'revoked' && ownerGoal?.goal.status === 'active', 'NOT_READY');
      state = { ...state, reviewed: { cardId, version: selected.version, previewDigest: selected.previewDigest } }; emit(); return copy();
    },
    invalidateReview() { state = { ...state, reviewed: null }; emit(); return copy(); },
    confirm(cardId) {
      const selected = state.cards.find(item => item.id === cardId), reviewed = state.reviewed;
      check(selected && reviewed?.cardId === cardId && reviewed.version === selected.version && reviewed.previewDigest === selected.previewDigest, 'NOT_READY');
      return beginWrite('confirmCard', { cardId, expectedVersion: selected.version, previewDigest: selected.previewDigest, confirm: true });
    },
    retry() { check(state.pending?.status === 'uncertain', 'NOT_READY'); const pending = { ...state.pending, status: 'submitting' }; state = { ...state, pending, error: null }; emit(); return perform(pending, epoch); },
    disconnect: () => clear()
  });
}
