import { createHash, randomUUID } from 'node:crypto';

const MESSAGES = {
  ACCOUNT_VALIDATION_UNAVAILABLE: 'The platform account validation contract is unavailable.',
  AUTHENTICATION_REQUIRED: 'A valid platform session is required.',
  INVITATION_REQUIRED: 'This account is not invited to the pilot.',
  COMPANION_STORE_UNAVAILABLE: 'The companion identity store is unavailable.',
  COMPANION_STATE_INVALID: 'The retained companion identity requires review.'
};

export class CompanionAccessError extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = 'CompanionAccessError'; this.code = code; }
}

// Internal, exact opaque principal tuple. No email/name fallback or normalization.
export function principalKey(principal) {
  if (principal === null || typeof principal !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(principal))) {
    throw new TypeError('A validated issuer/subject tuple is required');
  }
  const descriptors = Object.getOwnPropertyDescriptors(principal);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes('issuer') || !keys.includes('subject')) throw new TypeError('A validated issuer/subject tuple is required');
  const values = ['issuer', 'subject'].map(key => {
    const descriptor = descriptors[key];
    if (!('value' in descriptor)) throw new TypeError('A validated issuer/subject tuple is required');
    const value = descriptor.value;
    if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 2048) {
      throw new TypeError('A validated issuer/subject tuple is required');
    }
    return value;
  });
  return createHash('sha256').update(JSON.stringify(['personal-agent-subject-v1', ...values]), 'utf8').digest('hex');
}

// Not wired to HTTP. Only a qualified server-owned adapter may supply validation.
// A companion ID is an identifier, never a session or authorization credential.
export function createCompanionProvisioner({ store, validateAccount = null, pilotSubjects = [] }) {
  const invited = new Set(pilotSubjects.map(principalKey));
  return async function getOrCreate(sessionProof) {
    if (typeof validateAccount !== 'function') throw new CompanionAccessError('ACCOUNT_VALIDATION_UNAVAILABLE');
    let principal;
    try { principal = await validateAccount(sessionProof); }
    catch { throw new CompanionAccessError('ACCOUNT_VALIDATION_UNAVAILABLE'); }
    if (principal === null) throw new CompanionAccessError('AUTHENTICATION_REQUIRED');
    let key;
    try { key = principalKey(principal); }
    catch { throw new CompanionAccessError('ACCOUNT_VALIDATION_UNAVAILABLE'); }
    if (!invited.has(key)) throw new CompanionAccessError('INVITATION_REQUIRED');
    let record;
    try { record = store.getOrInsert('companion-identity-v1', key, { companionId: randomUUID() }); }
    catch { throw new CompanionAccessError('COMPANION_STORE_UNAVAILABLE'); }
    if (record === null || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 1 ||
        typeof record.companionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.companionId)) {
      throw new CompanionAccessError('COMPANION_STATE_INVALID');
    }
    return { companionId: record.companionId };
  };
}
