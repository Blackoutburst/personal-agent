import { createHash, randomBytes } from 'node:crypto';
import { projectInspectionDigest } from './board-boundary.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/, NONCE = /^[A-Za-z0-9_-]{16,128}$/, SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATIONS = new Set(['ticket', 'reply', 'comment', 'attachment']), TTL = 10000;
const MAX_BYTES = 65536, MAX_EXPANDED = 524288;

export class BoardPrivateInspectionError extends Error {
  constructor() { super('Private boundary inspection is unavailable.'); this.name = 'BoardPrivateInspectionError'; this.code = 'PRIVATE_INSPECTION_UNAVAILABLE'; }
}
function requirePrivate(condition) { if (!condition) throw new BoardPrivateInspectionError(); }
function shape(value, fields) {
  requirePrivate(value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requirePrivate(keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')));
  return value;
}
function text(value, maximum = MAX_BYTES) {
  requirePrivate(typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum); return value;
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function jsonStrings(value) {
  const strings = [], ancestors = new Set(); let nodes = 0, bytes = 0;
  function visit(item, depth) {
    requirePrivate(++nodes <= 4096 && depth <= 32);
    if (typeof item === 'string') { text(item); bytes += Buffer.byteLength(item); requirePrivate(bytes <= MAX_BYTES); strings.push(item); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    requirePrivate(item !== null && typeof item === 'object' && !ancestors.has(item));
    const array = Array.isArray(item), descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    requirePrivate(array ? Object.getPrototypeOf(item) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(item)));
    requirePrivate(array ? keys.length === item.length + 1 : keys.every(key => typeof key === 'string'));
    ancestors.add(item);
    const selected = array ? Array.from({ length: item.length }, (_, index) => String(index)) : keys;
    for (const key of selected) {
      requirePrivate(descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'));
      if (!array) { text(key); strings.push(key); bytes += Buffer.byteLength(key); requirePrivate(bytes <= MAX_BYTES); }
      visit(descriptors[key].value, depth + 1);
    }
    ancestors.delete(item);
  }
  visit(value, 0); requirePrivate(Buffer.byteLength(JSON.stringify(value)) <= MAX_BYTES); return strings;
}
const encodingForm = value => value.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
const normalize = value => encodingForm(value).toLowerCase();
const compact = value => value.replace(/[\s\p{P}\p{Z}]/gu, '');
function utf8(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } }
function base64(value, required = false) {
  const valid = value.length > 0 && value.length <= MAX_BYTES && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && value.length % 4 !== 1;
  if (!valid) { requirePrivate(!required); return null; }
  const selected = value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, ''), bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== selected) { requirePrivate(!required); return null; }
  if (required) requirePrivate(bytes.toString('base64') === value);
  const decoded = utf8(bytes); if (decoded === null) { requirePrivate(!required); return null; }
  return decoded;
}
function decodedEscapes(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', colon: ':', period: '.', lowbar: '_', hyphen: '-' };
  return value.replace(/(?:%[a-f0-9]{2})+/gi, part => { try { return decodeURIComponent(part); } catch { return part; } })
    .replace(/&#(x[a-f0-9]+|[0-9]+);|&([a-z]+);/gi, (whole, number, name) => {
      if (!number) return entities[name.toLowerCase()] ?? whole;
      const point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
    }).replace(/\\u(d[89ab][a-f0-9]{2})\\u(d[c-f][a-f0-9]{2})/gi, (whole, high, low) => String.fromCharCode(parseInt(high, 16), parseInt(low, 16)))
    .replace(/\\u\{([a-f0-9]{1,6})\}|\\u([a-f0-9]{4})|\\x([a-f0-9]{2})|\\([\\/"bfnrt])/gi, (whole, extended, unit, byte, escape) => {
      if (escape) return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[escape] ?? escape;
      const point = parseInt(extended ?? unit ?? byte, 16);
      return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
    });
}
function expandedText(strings) {
  const values = new Set(), queue = strings.map(value => ({ value, depth: 0 })); let bytes = 0;
  const add = (value, depth) => { if (values.has(value)) return; requirePrivate(depth <= 3 && queue.length < 16384); queue.push({ value, depth }); };
  for (let index = 0; index < queue.length; index++) {
    const { value, depth } = queue[index]; if (values.has(value)) continue;
    bytes += Buffer.byteLength(value); requirePrivate(bytes <= MAX_EXPANDED && values.size < 4096); values.add(value);
    const compatible = encodingForm(value); if (compatible !== value) add(compatible, depth);
    const decoded = decodedEscapes(value); if (decoded !== value) add(decoded, depth + 1);
    const binary = value.length >= 8 ? base64(value) : null;
    if (binary !== null && binary !== value) add(binary, depth + 1);
    for (const token of value.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
      const decodedToken = base64(token[0]); if (decodedToken !== null && decodedToken !== value) add(decodedToken, depth + 1);
    }
    const hex = /^(?:hex:)?([a-f0-9]{16,})$/i.exec(value);
    if (hex && hex[1].length % 2 === 0) { const decodedHex = utf8(Buffer.from(hex[1], 'hex')); if (decodedHex !== null) add(decodedHex, depth + 1); }
    for (const token of value.matchAll(/(?:hex:)?([a-f0-9]{16,})/gi)) {
      if (token[1].length % 2 !== 0) continue;
      const decodedToken = utf8(Buffer.from(token[1], 'hex')); if (decodedToken !== null && decodedToken !== value) add(decodedToken, depth + 1);
    }
    if (/^\s*[\[{]/.test(value)) {
      let parsed; try { parsed = JSON.parse(value); } catch { continue; }
      for (const child of jsonStrings(parsed)) if (child !== value) add(child, depth + 1);
    }
  }
  return [...values].map(normalize);
}
function privateAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/.test(host) || host === '::' || host === '::1'
    || /^(?:fc|fd|fe[89ab])/.test(host) && host.includes(':') || host.startsWith('::ffff:')) return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254
      || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168);
}
function sensitive(value) {
  if (/\b(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{16,}|(?:gh[pousr]|github_pat)_[a-z0-9_]{16,}|akia[a-z0-9]{16}|xox[baprs]-[a-z0-9-]{16,})\b/i.test(value)
    || /-----begin (?:rsa |ec |openssh )?private key-----/i.test(value)
    || /\beyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/-]{8,}=?/i.test(value)
    || /__secure-blackout_session\s*=\s*[a-z0-9_-]{43}/i.test(value)
    || /\b(?:password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?[^\s"'&,;}{]{4,}/i.test(value)
    || /[?&](?:token|key|secret|session|password|signature|sig|auth|authorization|access_token|refresh_token|api_key)=[^&#\s]+/i.test(value)
    || /\b(?:file|ssh|smb|vscode|plugin):|[a-z]:[\\/]users[\\/]|\/(?:home|root|users)\/|(?:^|[\\/])\.(?:ssh|codex|env)(?:[\\/.]|$)/i.test(value)) return true;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let url; try { url = new URL(match[0]); } catch { return true; }
    if (url.username || url.password || privateAddress(url.hostname)) return true;
  }
  return false;
}
function rendered(request) {
  const envelope = shape(request.payload, ['version', 'operation', 'projectId', 'publicRequestKey', 'call']);
  requirePrivate(envelope.version === 1 && envelope.operation === request.operation && envelope.projectId === request.projectId);
  requirePrivate(typeof envelope.publicRequestKey === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(envelope.publicRequestKey));
  const call = shape(envelope.call, ['tool', 'args']);
  const fields = request.operation === 'ticket' ? ['project_id', 'title', 'description', 'acceptance_criteria', 'idempotency_key']
    : request.operation === 'attachment' ? ['thread_id', 'filename', 'content_base64', 'idempotency_key', 'content_type'] : ['thread_id', 'body', 'idempotency_key'];
  shape(call.args, fields);
  requirePrivate(call.tool === (request.operation === 'ticket' ? 'create_ticket' : request.operation === 'attachment' ? 'upload_attachment' : 'post_message'));
  requirePrivate(fields.every(field => typeof call.args[field] === 'string') && call.args.idempotency_key === envelope.publicRequestKey);
  if (request.operation === 'ticket') requirePrivate(call.args.project_id === request.projectId);
  const strings = jsonStrings(envelope); strings.push(JSON.stringify(envelope));
  if (request.operation === 'attachment') {
    requirePrivate(call.args.filename === 'project-work.json' && call.args.content_type === 'application/json');
    const decoded = base64(call.args.content_base64, true); let attachment;
    try { attachment = JSON.parse(decoded); } catch { throw new BoardPrivateInspectionError(); }
    shape(attachment, ['version', 'projectId', 'template']); shape(attachment.template, ['title', 'instructions', 'acceptanceCriteria']);
    requirePrivate(attachment.version === 1 && attachment.projectId === request.projectId
      && Object.values(attachment.template).every(value => typeof value === 'string'));
    strings.push(decoded, ...jsonStrings(attachment));
  }
  return expandedText(strings);
}

// This supplementary deterministic guard has no store, filesystem, provider or transport access.
// The trusted loader must cover every private source AND identity/goal-control revision.
// Qualified project-only provenance remains primary; unknown secrets and semantic paraphrases are not classified here.
export function createBoardPrivateInspector({ loadPrivateContext = null, now = Date.now } = {}) {
  const receipts = new Map();
  function time() { const value = now(); requirePrivate(integer(value)); return value; }
  function context(companionId, clock) {
    requirePrivate(typeof companionId === 'string' && UUID.test(companionId) && typeof loadPrivateContext === 'function');
    const value = shape(loadPrivateContext(companionId), ['version', 'companionId', 'complete', 'freshUntil', 'markers']);
    text(value.version, 128); requirePrivate(value.version.length > 0 && value.companionId === companionId && value.complete === true
      && integer(value.freshUntil) && value.freshUntil > clock && Array.isArray(value.markers) && value.markers.length <= 1024);
    const markers = jsonStrings(value.markers); let bytes = 0;
    for (const marker of markers) { text(marker, 4096); requirePrivate(marker.length > 0); bytes += Buffer.byteLength(marker); }
    requirePrivate(markers.length === value.markers.length && bytes <= MAX_BYTES);
    const fingerprint = createHash('sha256').update(JSON.stringify({ version: value.version, markers: [...markers].sort() })).digest('hex');
    return { version: value.version, freshUntil: value.freshUntil, markers: [companionId, ...markers].map(normalize), fingerprint };
  }
  function prune(clock) { for (const [key, value] of receipts) if (value.expiresAt <= clock) receipts.delete(key); }
  return Object.freeze({
    async inspect(companionId, input) {
      try {
        const clock = time(), request = shape(input, ['version', 'operation', 'projectId', 'payloadDigest', 'payload', 'nonce', 'issuedAt', 'expiresAt']);
        requirePrivate(request.version === 1 && OPERATIONS.has(request.operation) && typeof request.projectId === 'string' && SELECTOR.test(request.projectId)
          && typeof request.payloadDigest === 'string' && HASH.test(request.payloadDigest) && typeof request.nonce === 'string' && NONCE.test(request.nonce) && integer(request.issuedAt) && integer(request.expiresAt)
          && request.issuedAt <= clock && clock < request.expiresAt && request.expiresAt <= request.issuedAt + TTL);
        const strings = rendered(request); requirePrivate(projectInspectionDigest(request.payload) === request.payloadDigest);
        const privateContext = context(companionId, clock); prune(clock);
        requirePrivate(receipts.size < 256 && ![...receipts.values()].some(receipt => receipt.companionId === companionId && receipt.nonce === request.nonce));
        const joined = strings.join(''), compacted = compact(joined);
        const denied = strings.some(sensitive) || privateContext.markers.some(marker => strings.some(value => value.includes(marker))
          || marker.length >= 8 && compacted.includes(compact(marker)));
        const privateVersion = randomBytes(32).toString('base64url'), expiresAt = Math.min(request.expiresAt, privateContext.freshUntil);
        receipts.set(privateVersion, { companionId, payloadDigest: request.payloadDigest, nonce: request.nonce, expiresAt,
          fingerprint: privateContext.fingerprint, version: privateContext.version, allowed: !denied, used: false });
        return { verdict: denied ? 'deny' : 'allow', payloadDigest: request.payloadDigest, nonce: request.nonce, privateVersion, expiresAt };
      } catch { throw new BoardPrivateInspectionError(); }
    },
    assertCurrent(companionId, input) {
      try {
        const clock = time(), binding = shape(input, ['privateVersion', 'payloadDigest', 'nonce', 'expiresAt']), receipt = receipts.get(binding.privateVersion);
        requirePrivate(receipt && !receipt.used && receipt.allowed && receipt.companionId === companionId && receipt.payloadDigest === binding.payloadDigest
          && receipt.nonce === binding.nonce && receipt.expiresAt === binding.expiresAt && clock < receipt.expiresAt);
        receipt.used = true;
        const current = context(companionId, clock);
        requirePrivate(current.version === receipt.version && current.fingerprint === receipt.fingerprint && current.freshUntil >= receipt.expiresAt);
        return true;
      } catch { throw new BoardPrivateInspectionError(); }
    }
  });
}
