import { request as httpRequest } from 'node:http';
import { CompanionAccessError, principalKey } from './provisioning.mjs';

const unavailable = () => new CompanionAccessError('ACCOUNT_VALIDATION_UNAVAILABLE');
const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT_PATH = '/internal/account/session';

// Configuration belongs to the server operator, never to a browser/session proof.
export function createAccountValidator({
  endpoint = 'http://127.0.0.1:9011/internal/account/session',
  issuer = 'https://blackoutburst.com',
  timeoutMs = 2000,
  maxBodyBytes = 4096,
} = {}) {
  let target;
  try {
    const literal = typeof endpoint === 'string' && /^http:\/\/(127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/internal\/account\/session$/.exec(endpoint);
    if (!literal || (literal[2] && Number(literal[2]) > 65535)) throw unavailable();
    target = new URL(endpoint);
    principalKey({ issuer, subject: 'configuration-check' });
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 ||
        !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65_536) throw unavailable();
  } catch { throw unavailable(); }

  return async function validateAccount(sessionValue) {
    if (typeof sessionValue !== 'string' || !SESSION_VALUE.test(sessionValue)) return null;
    return new Promise((resolve, reject) => {
      let request;
      let deadline;
      let settled = false;
      function finish(value, failed = false) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        request?.destroy();
        if (failed) reject(unavailable());
        else resolve(value);
      }
      try {
        request = httpRequest(target, {
          method: 'GET', path: ACCOUNT_PATH, agent: false,
          headers: { Accept: 'application/json', Cookie: `__Secure-blackout_session=${sessionValue}` },
        }, response => {
          response.on('error', () => finish(null, true));
          response.on('aborted', () => finish(null, true));
          if (response.statusCode === 401) return finish(null);
          if (response.statusCode !== 200) return finish(null, true);
          let bytes = 0;
          const chunks = [];
          response.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxBodyBytes) return finish(null, true);
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            try {
              const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
              if (!body || typeof body !== 'object' || Array.isArray(body) ||
                  !body.user || typeof body.user !== 'object' || Array.isArray(body.user)) throw unavailable();
              const principal = { issuer, subject: body.user.id };
              principalKey(principal);
              finish(principal);
            } catch { finish(null, true); }
          });
        });
        request.on('error', () => finish(null, true));
        deadline = setTimeout(() => finish(null, true), timeoutMs);
        request.end();
      } catch { finish(null, true); }
    });
  };
}
