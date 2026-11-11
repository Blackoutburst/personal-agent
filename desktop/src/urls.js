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

// Where the window should go after landing on `raw` (#87), or null to leave it alone.
// - the companion itself: stay
// - the sign-in page without a return target: same page with next=<companion>
// - account pages (sign-in in progress): stay
// - any other blackoutburst.com page (platform home, Board): back to the companion
// - everything else (other sites): stay; will-navigate sends those to the system browser
function afterLogin(raw, site = SITE) {
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
  return companion.href;
}

module.exports = { SITE, COMPANION_URL, INTERNAL_PATHS, isInternal, isExternalOpenable, afterLogin };
