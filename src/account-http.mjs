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

function selectedSession(request) {
  const selected = [];
  for (const header of rawValues(request, 'cookie')) {
    for (const part of header.split(';')) {
      const pair = part.trim();
      const equals = pair.indexOf('=');
      if (equals >= 0 && pair.slice(0, equals).trim() === '__Secure-blackout_session') selected.push(pair.slice(equals + 1));
    }
  }
  return selected.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(selected[0]) ? selected[0] : null;
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
    if (!valid || rawValues(request, 'sec-fetch-site').some(value => value.split(',').some(part => part.trim().toLowerCase() === 'cross-site'))) return fail('ORIGIN_REJECTED', true);
    const types = rawValues(request, 'content-type');
    const accepted = binary ? /^application\/octet-stream$/i : /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
    if (types.length !== 1 || !accepted.test(types[0])) return fail('UNSUPPORTED_MEDIA_TYPE', true);
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
      const session = selectedSession(request);
      if (session === null) return { failure: fail('AUTHENTICATION_REQUIRED') };
      try {
        const provision = createCompanionProvisioner({ store, validateAccount, pilotSubjects });
        const { companionId } = await provision(session);
        return { companionId };
      } catch (error) {
        const known = error instanceof CompanionAccessError && ['AUTHENTICATION_REQUIRED', 'INVITATION_REQUIRED',
          'ACCOUNT_VALIDATION_UNAVAILABLE', 'COMPANION_STORE_UNAVAILABLE', 'COMPANION_STATE_INVALID'].includes(error.code);
        return { failure: fail(known ? error.code : 'ACCOUNT_VALIDATION_UNAVAILABLE') };
      }
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
