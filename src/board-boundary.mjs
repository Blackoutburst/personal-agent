import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const BOARD_BOUNDARY_MAX_TTL_MS = 10000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/, NONCE = /^[A-Za-z0-9_-]{43}$/;
const ACTIONS = { ticket: 'create-task', reply: 'reply', comment: 'comment', attachment: 'attach-project-json' };
const TOOL = { ticket: 'create_ticket', reply: 'post_message', comment: 'post_message', attachment: 'upload_attachment' };
const MESSAGES = {
  INVALID_REQUEST: 'This operation is outside the closed project-only interface.',
  UNAVAILABLE: 'Project publishing requires qualified project sources and privacy checks.',
  AUTHORITY_DENIED: 'Current project consent or authority does not permit this work.',
  SOURCE_UNAVAILABLE: 'The qualified project catalog is unavailable.',
  SOURCE_DENIED: 'Use an enrolled project-only template and a qualified project target.',
  PRIVACY_UNAVAILABLE: 'The current private-context boundary could not be verified.',
  PRIVATE_CONTEXT: 'Create a separate project-only proposal using approved project sources. Private companion context cannot be published.',
  STALE: 'Project-only checks changed or expired. Recheck the current sources and consent.',
  TRANSPORT_UNAVAILABLE: 'No qualified Board transport is configured.',
  TRANSPORT_UNCERTAIN: 'Publication was not confirmed. Reconcile this attempt before retrying.'
};
export class BoardBoundaryError extends Error {
  constructor(code) {
    if (!Object.hasOwn(MESSAGES, code)) code = 'UNAVAILABLE';
    super(MESSAGES[code]); this.name = 'BoardBoundaryError'; this.code = 'BOARD_BOUNDARY_' + code;
  }
}
function requireBoundary(condition, code = 'INVALID_REQUEST') { if (!condition) throw new BoardBoundaryError(code); }
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function shape(value, keys, code = 'INVALID_REQUEST') {
  try {
    requireBoundary(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
    const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
    requireBoundary(actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) &&
      descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), code);
    return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  } catch { throw new BoardBoundaryError(code); }
}
function text(value, maximum, empty = false, code = 'INVALID_REQUEST') {
  requireBoundary(typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && (empty || value.trim().length > 0), code);
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function template(value, code = 'INVALID_REQUEST') {
  const selected = shape(value, ['title', 'instructions', 'acceptanceCriteria'], code);
  text(selected.title, 160, false, code); text(selected.instructions, 4000, false, code); text(selected.acceptanceCriteria, 2000, false, code);
  return selected;
}
function reference(value, code = 'INVALID_REQUEST') {
  const selected = shape(value, ['id', 'revision', 'digest'], code);
  requireBoundary(matches(selected.id, OPAQUE) && matches(selected.revision, OPAQUE) && matches(selected.digest, HASH), code); return selected;
}
export function projectTemplateDigest(value) {
  return createHash('sha256').update('personal-agent-project-template-v1\0' + canonical(template(value))).digest('hex');
}
function inspectionEnvelope(value) {
  const envelope = shape(value, ['version', 'operation', 'projectId', 'publicRequestKey', 'call']);
  requireBoundary(envelope.version === 1 && Object.hasOwn(TOOL, envelope.operation) && matches(envelope.projectId, OPAQUE) && matches(envelope.publicRequestKey, UUID));
  const call = shape(envelope.call, ['tool', 'args']); requireBoundary(call.tool === TOOL[envelope.operation]);
  const fields = call.tool === 'create_ticket' ? ['project_id', 'title', 'description', 'acceptance_criteria', 'idempotency_key'] :
    call.tool === 'post_message' ? ['thread_id', 'body', 'idempotency_key'] : ['thread_id', 'filename', 'content_base64', 'idempotency_key', 'content_type'];
  const args = shape(call.args, fields);
  for (const name of fields) text(args[name], 20000);
  requireBoundary(args.idempotency_key === envelope.publicRequestKey);
  if (call.tool === 'create_ticket') requireBoundary(args.project_id === envelope.projectId);
  else requireBoundary(matches(args.thread_id, OPAQUE));
  if (call.tool === 'upload_attachment') requireBoundary(args.filename === 'project-work.json' && args.content_type === 'application/json');
  const result = { ...envelope, call: { tool: call.tool, args } };
  requireBoundary(Buffer.byteLength(canonical(result)) <= 65536); return result;
}
// Hashes the complete exact MCP call and public retry metadata, not a private context or rejected-content log.
export function projectInspectionDigest(value) {
  return createHash('sha256').update('personal-agent-board-inspection-v1\0' + canonical(inspectionEnvelope(value))).digest('hex');
}
function frozen(value) {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

// Privacy projection only. The injected transport adds qualified owner sessions outside this content boundary.
// No mode, browser input, local consent or provenance label installs an adapter or authorizes a Board effect.
export function createBoardBoundary({ goalStore = null, resolveProjectContent = null, inspectPrivateBoundary = null,
  transport = null, audit = null, now = Date.now } = {}) {
  function clock() { try { const time = now(); requireBoundary(integer(time), 'STALE'); return time; } catch { throw new BoardBoundaryError('STALE'); } }
  function log(event) {
    if (typeof audit !== 'function') return;
    try { const result = audit(Object.freeze(event)); if (result instanceof Promise) result.catch(() => {}); } catch { /* Never report a raw audit exception. */ }
  }
  function fresh(issuedAt, expiresAt) {
    const time = clock(); requireBoundary(integer(expiresAt) && time >= issuedAt && time < expiresAt &&
      expiresAt <= issuedAt + BOARD_BOUNDARY_MAX_TTL_MS, 'STALE');
  }
  async function bounded(run, code) {
    const controller = new AbortController(); let timeout;
    try {
      return await Promise.race([Promise.resolve().then(() => run(controller.signal)).catch(() => { throw new BoardBoundaryError(code); }),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new BoardBoundaryError(code)); }, BOARD_BOUNDARY_MAX_TTL_MS); })]);
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  async function authority(companionId, reservationId) {
    const started = clock();
    const result = await bounded(() => goalStore.checkReservation(companionId, { reservationId }), 'AUTHORITY_DENIED');
    const outer = shape(result, ['eligible', 'work', 'grant'], 'AUTHORITY_DENIED'); requireBoundary(outer.eligible === true, 'AUTHORITY_DENIED');
    const work = shape(outer.work, ['projectId', 'action', 'taskType', 'resource', 'template'], 'AUTHORITY_DENIED');
    requireBoundary(matches(work.projectId, OPAQUE) && matches(work.action, OPAQUE) && matches(work.taskType, OPAQUE), 'AUTHORITY_DENIED');
    text(work.resource, 512, false, 'AUTHORITY_DENIED'); work.template = template(work.template, 'AUTHORITY_DENIED');
    const grant = shape(outer.grant, ['cardId', 'cardVersion', 'authorizationGeneration', 'reservationId', 'authorityReceiptDigest', 'verifiedUntil'], 'AUTHORITY_DENIED');
    requireBoundary(matches(grant.cardId, UUID) && integer(grant.cardVersion) && grant.cardVersion >= 1 && integer(grant.authorizationGeneration) &&
      grant.authorizationGeneration >= 1 && grant.reservationId === reservationId && matches(grant.authorityReceiptDigest, HASH), 'AUTHORITY_DENIED');
    fresh(started, grant.verifiedUntil);
    return { work, grant, started };
  }
  function compile(operation, work, target, publicRequestKey) {
    const approved = work.template;
    let args;
    if (operation === 'ticket') args = { project_id: work.projectId, title: approved.title, description: approved.instructions,
      acceptance_criteria: approved.acceptanceCriteria, idempotency_key: publicRequestKey };
    else if (operation === 'attachment') {
      const content = JSON.stringify({ version: 1, projectId: work.projectId, template: approved });
      args = { thread_id: target.threadId, filename: 'project-work.json', content_base64: Buffer.from(content).toString('base64'),
        idempotency_key: publicRequestKey, content_type: 'application/json' };
    } else args = { thread_id: target.threadId, body: approved.title + '\n\n' + approved.instructions + '\n\nAcceptance criteria:\n' + approved.acceptanceCriteria,
      idempotency_key: publicRequestKey };
    return frozen(inspectionEnvelope({ version: 1, operation, projectId: work.projectId, publicRequestKey, call: { tool: TOOL[operation], args } }));
  }
  async function publish(companionId, input) {
    let operation;
    try {
      const selected = shape(input, ['operation', 'reservationId', 'requestId', 'templateRef', 'targetRef']);
      requireBoundary(matches(companionId, UUID) && Object.hasOwn(ACTIONS, selected.operation) && matches(selected.reservationId, UUID) && matches(selected.requestId, REQUEST));
      operation = selected.operation;
      selected.templateRef = reference(selected.templateRef);
      requireBoundary(operation === 'ticket' ? selected.targetRef === null : matches(selected.targetRef, OPAQUE));
      requireBoundary(goalStore && typeof goalStore.checkReservation === 'function' && typeof resolveProjectContent === 'function' &&
        inspectPrivateBoundary && typeof inspectPrivateBoundary.inspect === 'function' && typeof inspectPrivateBoundary.assertCurrent === 'function', 'UNAVAILABLE');
      requireBoundary(typeof transport === 'function', 'TRANSPORT_UNAVAILABLE');
      const first = await authority(companionId, selected.reservationId);
      requireBoundary(first.work.action === ACTIONS[operation], 'AUTHORITY_DENIED');
      const issuedAt = clock(), nonce = randomBytes(32).toString('base64url');
      const challenge = frozen({ version: 1, operation, projectId: first.work.projectId, templateRef: selected.templateRef,
        targetRef: selected.targetRef, nonce, issuedAt, expiresAt: issuedAt + BOARD_BOUNDARY_MAX_TTL_MS });
      const rawCatalog = await bounded(signal => resolveProjectContent(companionId, challenge, { signal }), 'SOURCE_UNAVAILABLE');
      requireBoundary(rawCatalog !== null, 'SOURCE_DENIED');
      const catalog = shape(rawCatalog, ['version', 'projectId', 'templateRef', 'template', 'target', 'nonce', 'expiresAt'], 'SOURCE_UNAVAILABLE');
      requireBoundary(catalog.version === 1 && catalog.projectId === first.work.projectId && catalog.nonce === nonce, 'SOURCE_DENIED');
      const pin = reference(catalog.templateRef, 'SOURCE_UNAVAILABLE'), projectTemplate = template(catalog.template, 'SOURCE_UNAVAILABLE');
      requireBoundary(canonical(pin) === canonical(selected.templateRef) && projectTemplateDigest(projectTemplate) === pin.digest &&
        canonical(projectTemplate) === canonical(first.work.template), 'SOURCE_DENIED');
      fresh(issuedAt, catalog.expiresAt);
      let target = null;
      if (selected.targetRef === null) requireBoundary(catalog.target === null, 'SOURCE_DENIED');
      else {
        target = shape(catalog.target, ['threadId', 'projectId'], 'SOURCE_DENIED');
        requireBoundary(target.threadId === selected.targetRef && target.projectId === first.work.projectId, 'SOURCE_DENIED');
      }
      // This UUID is deliberately independent of all private request, owner, goal, card and reservation data.
      // A future durable #12 adapter must journal it before effects; this facade does not retry an uncertain handoff.
      const publicRequestKey = randomUUID(), payload = compile(operation, first.work, target, publicRequestKey), payloadDigest = projectInspectionDigest(payload);
      const inspectionAt = clock(), inspectionNonce = randomBytes(32).toString('base64url');
      const inspection = frozen({ version: 1, operation, projectId: first.work.projectId, payloadDigest, payload,
        nonce: inspectionNonce, issuedAt: inspectionAt, expiresAt: inspectionAt + BOARD_BOUNDARY_MAX_TTL_MS });
      const rawVerdict = await bounded(() => inspectPrivateBoundary.inspect(companionId, inspection), 'PRIVACY_UNAVAILABLE');
      const verdict = shape(rawVerdict, ['verdict', 'payloadDigest', 'nonce', 'privateVersion', 'expiresAt'], 'PRIVACY_UNAVAILABLE');
      requireBoundary(verdict.payloadDigest === payloadDigest && verdict.nonce === inspectionNonce && matches(verdict.privateVersion, NONCE), 'PRIVACY_UNAVAILABLE');
      fresh(inspectionAt, verdict.expiresAt);
      requireBoundary(verdict.verdict === 'allow' || verdict.verdict === 'deny', 'PRIVACY_UNAVAILABLE');
      requireBoundary(verdict.verdict === 'allow', 'PRIVATE_CONTEXT');
      const last = await authority(companionId, selected.reservationId);
      requireBoundary(canonical(last.work) === canonical(first.work) && last.grant.cardId === first.grant.cardId &&
        last.grant.cardVersion === first.grant.cardVersion && last.grant.authorizationGeneration === first.grant.authorizationGeneration, 'STALE');
      let stillCurrent;
      try { stillCurrent = inspectPrivateBoundary.assertCurrent(companionId, frozen({ privateVersion: verdict.privateVersion, payloadDigest,
        nonce: inspectionNonce, expiresAt: verdict.expiresAt })); }
      catch { throw new BoardBoundaryError('PRIVACY_UNAVAILABLE'); }
      if (stillCurrent instanceof Promise) stillCurrent.catch(() => {});
      requireBoundary(stillCurrent === true, 'PRIVACY_UNAVAILABLE');
      fresh(issuedAt, catalog.expiresAt); fresh(inspectionAt, verdict.expiresAt); fresh(last.started, last.grant.verifiedUntil);
      // No await between the final synchronous private/control fence, deadline checks and transport invocation.
      // This is a handoff freshness check, not atomic external dispatch/revocation or execution qualification.
      let pending;
      try { pending = transport(payload.call); } catch { throw new BoardBoundaryError('TRANSPORT_UNCERTAIN'); }
      log({ event: 'board_payload_handoff', operation });
      let response;
      try { response = await pending; } catch { throw new BoardBoundaryError('TRANSPORT_UNCERTAIN'); }
      const receipt = shape(response, ['id'], 'TRANSPORT_UNCERTAIN'); requireBoundary(matches(receipt.id, /^[a-f0-9]{32}$/), 'TRANSPORT_UNCERTAIN');
      return { status: 'submitted', operation, publicRequestKey, receipt };
    } catch (error) {
      const code = error instanceof BoardBoundaryError ? error.code.slice('BOARD_BOUNDARY_'.length) : 'UNAVAILABLE';
      log({ event: 'board_payload_denied', code: 'BOARD_BOUNDARY_' + code });
      throw new BoardBoundaryError(code);
    }
  }
  return Object.freeze({ publish });
}
