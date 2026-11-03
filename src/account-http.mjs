import { CompanionAccessError, createCompanionProvisioner } from './provisioning.mjs';

const ERRORS = {
  ORIGIN_REJECTED: [403, 'Same-origin access required.'],
  METHOD_NOT_ALLOWED: [405, 'POST is required.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Use application/json.'],
  BAD_REQUEST: [400, 'An empty JSON object is required.'],
  BODY_TOO_LARGE: [413, 'The request body exceeds the limit.'],
  REQUEST_TIMEOUT: [408, 'The request body did not complete in time.'],
  AUTHENTICATION_REQUIRED: [401, 'A valid platform session is required.'],
  INVITATION_REQUIRED: [403, 'This account is not invited to the pilot.'],
  ACCOUNT_VALIDATION_UNAVAILABLE: [503, 'The platform account validation contract is unavailable.'],
  COMPANION_STORE_UNAVAILABLE: [503, 'The companion identity store is unavailable.'],
  COMPANION_STATE_INVALID: [503, 'The retained companion identity requires review.'],
};

function fail(code, closeConnection = false) {
  const [status, message] = ERRORS[code];
  return { status, body: { error: { code, message } }, ...(closeConnection ? { closeConnection: true } : {}) };
}

function rawValues(request, name) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

// Every well-formed platform session cookie the browser sent, in order. Browsers can hold a stale duplicate
// (for example an old host-only cookie next to the current Domain=.blackoutburst.com one); the platform itself uses
// the first, so a duplicate must not lock the owner out. Each candidate is validated separately (see authorize).
function sessionCandidates(request) {
  const selected = [];
  for (const header of rawValues(request, 'cookie')) {
    for (const part of header.split(';')) {
      const pair = part.trim();
      const equals = pair.indexOf('=');
      if (equals >= 0 && pair.slice(0, equals).trim() === '__Secure-blackout_session') selected.push(pair.slice(equals + 1));
    }
  }
  const unique = [...new Set(selected)];
  return unique.length <= MAX_SESSION_CANDIDATES && unique.every(value => /^[A-Za-z0-9_-]{43}$/.test(value)) ? unique : [];
}
const MAX_SESSION_CANDIDATES = 3;

// Temporary sign-in diagnostics (iPhone loop, Nov 2026): shapes only. Never cookie values, names of other cookies'
// values, account ids or addresses. Remove once the loop is understood.
function refusalDiagnostic(request, reason) {
  try {
    const sessions = [];
    let cookieHeaders = 0, cookies = 0;
    for (const header of rawValues(request, 'cookie')) {
      cookieHeaders++;
      for (const part of header.split(';')) {
        const pair = part.trim(); if (!pair) continue; cookies++;
        const equals = pair.indexOf('='), name = equals >= 0 ? pair.slice(0, equals).trim() : pair;
        if (/blackout_session/i.test(name)) {
          const value = equals >= 0 ? pair.slice(equals + 1) : '';
          sessions.push(`${name}(len ${value.length}, ${/^[A-Za-z0-9_-]{43}$/.test(value) ? 'well-formed' : 'malformed'})`);
        }
      }
    }
    const agent = String(request.headers['user-agent'] ?? '');
    const browser = /CriOS/.test(agent) ? 'chrome-ios' : /iPhone|iPad/.test(agent) ? 'ios-other' : /Android/.test(agent) ? 'android'
      : /Chrome/.test(agent) ? 'chrome' : /Firefox/.test(agent) ? 'firefox' : /Safari/.test(agent) ? 'safari' : 'other';
    console.error(`Companion sign-in refused: ${reason}; browser ${browser}; cookie headers ${cookieHeaders}; cookies ${cookies}; `
      + `session cookies [${sessions.join(' ')}]; fetch-site ${request.headers['sec-fetch-site'] ?? '-'}`);
  } catch { /* diagnostics never affect access */ }
}

export function readJsonBody(request, maximum) {
  if (Number(request.headers['content-length']) > maximum) return Promise.resolve({ failure: fail('BODY_TOO_LARGE', true) });
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const deadline = setTimeout(() => finish({ failure: fail('REQUEST_TIMEOUT', true) }), 3000);
    function finish(result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onError);
      if (result?.failure?.closeConnection) {
        request.pause();
        request.once('error', () => {});
      }
      resolve(result);
    }
    function onError() { finish({ failure: fail('BAD_REQUEST', true) }); }
    function onData(chunk) {
      bytes += chunk.length;
      if (bytes > maximum) return finish({ failure: fail('BODY_TOO_LARGE', true) });
      chunks.push(chunk);
    }
    function onEnd() {
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        finish({ value });
      } catch { finish({ failure: fail('BAD_REQUEST') }); }
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onError);
  });
}

// Local candidate boundary; its caller owns routing, host checks and response headers.
export function createAccountAccess({ store, validateAccount, pilotSubjects, allowedOrigins }) {
  function admit(request, binary = false) {
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', true);
    let allowed;
    try { allowed = allowedOrigins(); if (!(allowed instanceof Set)) throw new Error(); }
    catch { return fail('ACCOUNT_VALIDATION_UNAVAILABLE', true); }
    const origins = rawValues(request, 'origin');
    let valid = false;
    try { const parsed = new URL(origins[0]); valid = origins.length === 1 && ['http:', 'https:'].includes(parsed.protocol)
      && parsed.origin === origins[0] && allowed.has(origins[0]); } catch { /* rejected */ }
    if (!valid || rawValues(request, 'sec-fetch-site').some(value => value.split(',').some(part => part.trim().toLowerCase() === 'cross-site'))) {
      let shown = 'none';
      try { shown = origins.length ? origins.map(value => value === 'null' ? 'null' : new URL(value).origin).join(',') : 'none'; } catch { shown = 'unparsable'; }
      refusalDiagnostic(request, `origin-rejected (origin ${shown}; ${origins.length} header(s))`);
      return fail('ORIGIN_REJECTED', true);
    }
    const types = rawValues(request, 'content-type');
    const accepted = binary ? /^application\/octet-stream$/i : /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
    if (types.length !== 1 || !accepted.test(types[0])) { refusalDiagnostic(request, 'content-type ' + JSON.stringify(types).slice(0, 80)); return fail('UNSUPPORTED_MEDIA_TYPE', true); }
    return null;
  }
  return {
    admit,
    async read(request, maximum = 1024) {
      const failure = admit(request);
      if (failure) return { failure };
      return readJsonBody(request, maximum);
    },
    async authorize(request) {
      const candidates = sessionCandidates(request);
      if (!candidates.length) { refusalDiagnostic(request, 'no-usable-session-cookie'); return { failure: fail('AUTHENTICATION_REQUIRED') }; }
      const provision = createCompanionProvisioner({ store, validateAccount, pilotSubjects });
      const admitted = new Set(), errors = [];
      for (const session of candidates) {
        try { admitted.add((await provision(session)).companionId); }
        catch (error) { errors.push(error); }
      }
      // Exactly one account: a stale extra cookie is ignored, but two live sessions for different accounts are refused.
      if (admitted.size === 1) {
        if (/CriOS/.test(String(request.headers['user-agent'] ?? ''))) console.error('Companion sign-in accepted: browser chrome-ios');
        return { companionId: [...admitted][0] };
      }
      if (admitted.size > 1) { refusalDiagnostic(request, 'two-live-accounts'); return { failure: fail('AUTHENTICATION_REQUIRED') }; }
      const codes = errors.map(error => error instanceof CompanionAccessError ? error.code : null);
      const code = ['COMPANION_STATE_INVALID', 'COMPANION_STORE_UNAVAILABLE', 'ACCOUNT_VALIDATION_UNAVAILABLE', 'INVITATION_REQUIRED', 'AUTHENTICATION_REQUIRED']
        .find(known => codes.includes(known));
      refusalDiagnostic(request, 'platform-said:' + codes.map(value => value ?? 'error').join(','));
      return { failure: fail(codes.includes(null) ? 'ACCOUNT_VALIDATION_UNAVAILABLE' : code) };
    }
  };
}

// Both account and private-state requests use this same transport and admission boundary.
export function createAccountHttp(options) {
  const access = options.access ?? createAccountAccess(options);
  return async function accountSession(request) {
    const parsed = await access.read(request);
    if (parsed.failure) return parsed.failure;
    const value = parsed.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) return fail('BAD_REQUEST');
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    // runtime: this companion's own agent (ready / signed-out / provider-missing / unconfigured).
    const runtime = options.runtimeStatus ? await options.runtimeStatus(admitted.companionId) : { state: 'unavailable' };
    return { status: 200, body: { companionId: admitted.companionId,
      provider: { state: runtime.provider ?? 'unavailable' }, runtime: { state: runtime.state } } };
  };
}
