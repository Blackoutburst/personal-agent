'use strict';
// In-app update (#89): state machine + electron-updater wiring + the banner the window shows.
// The server feed (generic provider) sits behind the owner login, so the caller supplies the session cookie header.
//   idle -> available(version) -> downloading(percent) -> ready(version) -> restart (quitAndInstall)
//   a failed download (offline, bad file) -> error(message); the running version is never touched. Retry goes back to a download.
// A failed *background check* stays silent (idle): being offline at startup is not worth a message.
const FEED_URL = 'https://blackoutburst.com/personal-agent-preview/api/desktop/update/';
const ACTION_PREFIX = 'companion-update://';
const ACTIONS = ['restart', 'retry'];

const IDLE = Object.freeze({ phase: 'idle' });

function reduce(state, event) {
  switch (event?.type) {
    case 'available':
      if (state.phase === 'downloading' || state.phase === 'ready') return state;
      return { phase: 'available', version: event.version };
    case 'progress': {
      if (state.phase !== 'available' && state.phase !== 'downloading') return state;
      const n = Number(event.percent);
      const percent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : 0;
      return { phase: 'downloading', version: state.version, percent: Math.max(percent, state.percent ?? 0) };
    }
    case 'downloaded':
      return { phase: 'ready', version: event.version ?? state.version };
    case 'error':
      if (state.phase === 'idle' || state.phase === 'ready') return state;   // silent check failure; never lose a finished download
      return { phase: 'error', version: state.version, message: String(event.message || 'The update failed.') };
    case 'retry':
      return state.phase === 'error' ? { phase: 'available', version: state.version } : state;
    case 'dismiss':
      return state.phase === 'ready' ? state : IDLE;
    default:
      return state;
  }
}

// A short, plain message for the person; the raw error stays in the log.
function friendlyError(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? err ?? ''}`;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_CONNECTION|ERR_TIMED_OUT/i.test(text)) return 'Could not reach the server. Check your connection and try again. The current version keeps working.';
  if (/sha512|checksum|signature|corrupt|ERR_UPDATER_INVALID/i.test(text)) return 'The downloaded update is damaged, so it was not installed. Try again. The current version keeps working.';
  if (/\b(401|403)\b/.test(text)) return 'The server asked for a sign-in. Sign in to the app and try again. The current version keeps working.';
  if (/\b404\b|ENOENT/.test(text)) return 'The update file is not on the server any more. The current version keeps working.';
  return 'The update could not be downloaded. Try again later. The current version keeps working.';
}

// Cookie header for the feed from the window session's cookies ({name,value}[]).
function cookieHeader(cookies) {
  return (cookies || []).filter((c) => c && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) && !/[;\r\n]/.test(c.value)).map((c) => `${c.name}=${c.value}`).join('; ');
}

function parseAction(url) {
  if (typeof url !== 'string' || !url.startsWith(ACTION_PREFIX)) return null;
  const action = url.slice(ACTION_PREFIX.length);
  return ACTIONS.includes(action) ? action : null;
}

// What the bar shows for a state; null = nothing. `action` is the companion-update:// link, if any.
function view(state) {
  switch (state.phase) {
    case 'available': return { text: `Update ${state.version} found, starting download…`, percent: null, action: null, dismissible: true };
    case 'downloading': return { text: `Downloading update ${state.version}: ${state.percent}%`, percent: state.percent, action: null, dismissible: false };
    case 'ready': return { text: `Update ${state.version} is ready.`, percent: 100, action: { label: 'Restart to update', url: ACTION_PREFIX + 'restart' }, dismissible: true };
    case 'error': return { text: state.message, percent: null, action: { label: 'Try again', url: ACTION_PREFIX + 'retry' }, dismissible: true, error: true };
    default: return null;
  }
}

// Script run in the page. Re-rendering replaces the bar; a null view removes it.
function bannerScript(v) {
  return `(() => {
    const v = ${JSON.stringify(v)};
    let bar = document.getElementById('desktop-update-banner');
    if (!v) { if (bar) bar.remove(); return; }
    if (bar) bar.remove();
    bar = document.createElement('div');
    bar.id = 'desktop-update-banner'; bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;background:' + (v.error ? '#ffe3e0' : '#fff1e8') + ';color:#3b2a20;border:1px solid #e8b99c;border-radius:10px;padding:8px 12px;font:14px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2);display:flex;gap:12px;align-items:center;max-width:90vw';
    const text = document.createElement('span'); text.textContent = v.text;
    bar.append(text);
    if (v.percent !== null) {
      const p = document.createElement('progress'); p.max = 100; p.value = v.percent; p.style.cssText = 'width:120px'; p.setAttribute('aria-label', 'Download progress'); bar.append(p);
    }
    if (v.action) {
      const a = document.createElement('a'); a.href = v.action.url; a.textContent = v.action.label; a.style.cssText = 'color:#a2461f;font-weight:600;cursor:pointer'; bar.append(a);
    }
    if (v.dismissible) {
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
      x.style.cssText = 'background:none;border:0;font-size:18px;cursor:pointer;color:inherit'; x.onclick = () => bar.remove(); bar.append(x);
    }
    document.body.append(bar);
  })()`;
}

// Wires an electron-updater-like autoUpdater (EventEmitter + checkForUpdates/quitAndInstall) to the state machine.
// getHeaders() resolves to the request headers (login cookie). onState(state) is called after every change.
function createUpdater({ autoUpdater, getHeaders, onState = () => {}, onRestart = () => {}, log = () => {} }) {
  let state = IDLE;
  const apply = (event) => {
    const next = reduce(state, event);
    if (next !== state) { state = next; onState(state); }
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;   // the server serves whole files only (no Range)
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('update-available', (info) => apply({ type: 'available', version: info?.version }));
  autoUpdater.on('download-progress', (p) => apply({ type: 'progress', percent: p?.percent }));
  autoUpdater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: info?.version }));
  autoUpdater.on('error', (err) => { log('updater error', err); apply({ type: 'error', message: friendlyError(err) }); });
  async function check() {
    if (state.phase === 'downloading' || state.phase === 'ready') return;
    try {
      autoUpdater.requestHeaders = await getHeaders();
      await autoUpdater.checkForUpdates();
    } catch (err) { log('update check failed', err); apply({ type: 'error', message: friendlyError(err) }); }
  }
  return {
    get state() { return state; },
    check,
    handleAction(action) {
      if (action === 'restart' && state.phase === 'ready') { onRestart(); autoUpdater.quitAndInstall(false, true); return true; }
      if (action === 'retry' && state.phase === 'error') { apply({ type: 'retry' }); return check().then(() => true); }
      return false;
    },
    dismiss() { apply({ type: 'dismiss' }); },
  };
}

module.exports = { FEED_URL, ACTION_PREFIX, IDLE, reduce, friendlyError, cookieHeader, parseAction, view, bannerScript, createUpdater };
