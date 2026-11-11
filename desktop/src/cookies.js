'use strict';
// Chromium drops session cookies (no expiry) when the app quits. The platform login may issue
// one, so give it a long expiry to keep the sign-in across restarts. Logout still clears it
// server-side/with a delete, which is a "removed" change we ignore.
const KEEP_SECONDS = 60 * 60 * 24 * 90;

function persistentVersion(cookie, site, nowSec = Date.now() / 1000) {
  if (!cookie || cookie.session !== true || cookie.expirationDate) return null;
  const host = new URL(site).hostname;
  const domain = String(cookie.domain || '').replace(/^\./, '');
  if (domain !== host) return null;
  const url = site + (cookie.path || '/');
  return {
    url, name: cookie.name, value: cookie.value, path: cookie.path || '/',
    secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    expirationDate: Math.floor(nowSec) + KEEP_SECONDS,
  };
}

module.exports = { KEEP_SECONDS, persistentVersion };
