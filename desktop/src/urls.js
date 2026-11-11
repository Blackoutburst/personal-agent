'use strict';
// Which URLs may load inside the app window. Everything else goes to the system browser.
const SITE = 'https://blackoutburst.com';
const COMPANION_URL = SITE + '/personal-agent-preview/';
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

module.exports = { SITE, COMPANION_URL, INTERNAL_PATHS, isInternal, isExternalOpenable };
