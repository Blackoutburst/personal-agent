'use strict';
// Update check (#84): the server's /api/desktop says which build it offers. The app only tells the owner; it never
// installs anything itself. The download link is the same authenticated URL the web client uses.
const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_URL = 'https://blackoutburst.com/personal-agent-preview/api/desktop';
const DOWNLOAD_URL = VERSION_URL + '/download';

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(offered, current) {
  const a = parseVersion(offered), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
// fetchImpl returns a fetch Response (session.defaultSession.fetch, which carries the login cookies). null: nothing to show.
async function checkForUpdate(fetchImpl, current) {
  try {
    const response = await fetchImpl(VERSION_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const info = await response.json();
    return isNewer(info?.version, current) ? { version: info.version } : null;
  } catch { return null; }
}
// Script run in the page: a small dismissible bar at the bottom with a download link (same window, so the login applies).
function bannerScript(update, downloadUrl = DOWNLOAD_URL) {
  return `(() => {
    if (document.getElementById('desktop-update-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'desktop-update-banner'; bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;background:#fff1e8;color:#3b2a20;border:1px solid #e8b99c;border-radius:10px;padding:8px 12px;font:14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2);display:flex;gap:12px;align-items:center';
    const text = document.createElement('span'); text.textContent = 'Update available: ' + ${JSON.stringify(update.version)};
    const link = document.createElement('a'); link.href = ${JSON.stringify(downloadUrl)}; link.textContent = 'Download'; link.style.cssText = 'color:#a2461f;font-weight:600';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'background:none;border:0;font-size:18px;cursor:pointer;color:inherit'; close.onclick = () => bar.remove();
    bar.append(text, link, close); document.body.append(bar);
  })()`;
}
module.exports = { DAY_MS, VERSION_URL, DOWNLOAD_URL, isNewer, checkForUpdate, bannerScript };
