'use strict';
// Which URLs may load inside the app window. Everything else goes to the system browser.
const SITE = 'https://blackoutburst.com';
const COMPANION_URL = SITE + '/personal-agent-preview/';
const SESSION_URL = SITE + '/api/account/session';
// The platform login and account pages live on the same origin as the companion.
const INTERNAL_PATHS = ['/personal-agent-preview/', '/account/', '/api/account/'];

function parse(raw) {
  try { return new URL(String(raw)); } catch { return null; }
}

function isInternal(raw, site = SITE) {
  const u = parse(raw);
  if (!u || u.origin !== new URL(site).origin || u.username || u.password) return false;
  return INTERNAL_PATHS.some((p) => u.pathname === p.replace(/\/$/, '') || u.pathname.startsWith(p));
}

// Only plain web links may be handed to the OS; never file:, javascript:, custom schemes.
function isExternalOpenable(raw) {
  const u = parse(raw);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
}

// Where the window should go after landing on `raw` (#87), or null to leave it alone.
// - the companion itself: stay
// - the sign-in page without a return target: same page with next=<companion>
// - account pages (sign-in in progress): stay
// - any other blackoutburst.com page (platform home, Board): back to the companion, ONLY when signedIn is true
//   (the window session is signed in per /api/account/session); signed out = null, so SSO hops are not cut
// - everything else (other sites): stay; will-navigate sends those to the system browser
function afterLogin(raw, signedIn = false, site = SITE) {
  const u = parse(raw);
  const base = new URL(site);
  if (!u || u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.hostname !== base.hostname && !u.hostname.endsWith('.' + base.hostname)) return null;
  const companion = new URL(COMPANION_URL.replace(SITE, base.origin));
  if (u.origin === base.origin) {
    if (u.pathname.startsWith('/personal-agent-preview')) return null;
    if (u.pathname === '/account' || u.pathname === '/account/') {
      if (u.searchParams.has('next')) return null;
      const login = new URL(u.href); login.searchParams.set('next', companion.href);
      return login.href;
    }
    if (u.pathname.startsWith('/account/') || u.pathname.startsWith('/api/account/')) return null;
  }
  // Signed out (or not known yet): do not bounce; an SSO hop must be able to finish.
  return signedIn === true ? companion.href : null;
}

// Signed in = a user object with an id, the shape the companion server itself relies on for the same platform session
// (src/account-validator.mjs:46-48 reads body.user.id from the platform's /internal/account/session; 401 when signed out).
// The public /api/account/session is the platform's own endpoint (not in this repo): signed out was observed as
// {"user":null,...}; the signed-in body is assumed to carry the same user.id. Tolerant: any other fields are ignored.
function isSignedIn(body) {
  const u = body && typeof body === 'object' ? body.user : null;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  return (typeof u.id === 'string' && u.id.length > 0) || Number.isInteger(u.id);
}

module.exports = { SESSION_URL, isSignedIn, SITE, COMPANION_URL, INTERNAL_PATHS, isInternal, isExternalOpenable, afterLogin };
