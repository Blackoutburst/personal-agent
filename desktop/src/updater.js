'use strict';
// In-app update (#89): state machine + electron-updater wiring + the banner the window shows.
// The server feed (generic provider) sits behind the owner login, so the caller supplies the session cookie header.
//   idle -> available(version) -[user clicks Download]-> downloading(percent) -> ready(version) -> restart (quitAndInstall)
// Nothing downloads on its own (#97): autoDownload is off and only the 'download' action starts it.
//   a failed download (offline, bad file) -> error(message); the running version is never touched. Retry goes back to a download.
// A failed *background check* stays silent (idle): being offline at startup is not worth a message.
const FEED_URL = 'https://blackoutburst.com/personal-agent-preview/api/desktop/update/';
const ACTION_PREFIX = 'companion-update://';
const ACTIONS = ['download', 'restart', 'retry', 'dismiss'];

const IDLE = Object.freeze({ phase: 'idle' });

// A dismissal sticks to the version it was made for.
const keep = (state, version) => (state.dismissed && state.dismissed === version ? { dismissed: version } : {});

function reduce(state, event) {
  switch (event?.type) {
    case 'available':
      if (state.phase === 'downloading' || state.phase === 'ready') return state;
      return { phase: 'available', version: event.version, ...keep(state, event.version) };
    case 'progress': {
      if (state.phase !== 'downloading') return state;   // progress only counts after the user clicked Download
      const n = Number(event.percent);
      const percent = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : 0;
      return { phase: 'downloading', version: state.version, percent: Math.max(percent, state.percent ?? 0), ...keep(state, state.version) };
    }
    case 'downloaded':
      return { phase: 'ready', version: event.version ?? state.version, ...keep(state, event.version ?? state.version) };
    case 'error':
      if (state.phase === 'idle' || state.phase === 'ready') return state;   // silent check failure; never lose a finished download
      return { phase: 'error', version: state.version, message: String(event.message || 'The update failed.') };
    case 'download':
      return state.phase === 'available' ? { phase: 'downloading', version: state.version, percent: 0, ...keep(state, state.version) } : state;
    case 'retry':   // a failed download is retried straight away
      return state.phase === 'error' ? { phase: 'downloading', version: state.version, percent: 0 } : state;
    case 'dismiss':
      // Hide the bar for this version only: a finished download stays ready (tray offers Restart); a newer version shows again.
      if (state.phase === 'idle') return state;
      if (state.phase === 'error') return IDLE;
      return state.dismissed === state.version ? state : { ...state, dismissed: state.version };
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

// What the card shows for a state; null = nothing. `action` is the companion-update:// link, if any.
function view(state) {
  if (state.phase !== 'error' && state.dismissed && state.dismissed === state.version) return null;   // dismissed for this version; errors always show
  switch (state.phase) {
    case 'available': return { phase: 'available', text: `Update ${state.version} is available.`, percent: null, action: { label: 'Download', url: ACTION_PREFIX + 'download' }, dismissible: true };
    case 'downloading': return { phase: 'downloading', text: `Downloading update ${state.version}: ${state.percent}%`, percent: state.percent, action: null, dismissible: false };
    case 'ready': return { phase: 'ready', text: `Update ${state.version} is ready.`, percent: 100, action: { label: 'Restart to update', url: ACTION_PREFIX + 'restart' }, dismissible: true };
    case 'error': return { phase: 'error', text: state.message, percent: null, action: { label: 'Try again', url: ACTION_PREFIX + 'retry' }, dismissible: true, error: true };
    default: return null;
  }
}

// The card's look: only the app's own theme variables (public/companion.css), so the light/dark theme and the
// user's accent colour (--body / --on-body, the same pair .button.primary uses) apply. Fallbacks are the stock light values.
const CARD_CSS = `
#desktop-update-banner{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:12px 14px;background:var(--card,#fff);color:var(--ink,#3A2E39);border:1px solid var(--line,#F1E4E0);border-radius:var(--radius,22px);box-shadow:0 6px 24px var(--glow,rgba(0,0,0,.15));font:14px/1.35 inherit;font-family:inherit}
#desktop-update-banner.error{background:var(--danger-bg,#FFF1F1);color:var(--danger,#B44D5B);border-color:var(--danger,#B44D5B)}
#desktop-update-banner .row{display:flex;align-items:center;gap:10px}
#desktop-update-banner .txt{flex:1}
#desktop-update-banner progress{width:100%;height:8px;accent-color:var(--body,#FFB38A)}
#desktop-update-banner .act{align-self:flex-start;border:0;border-radius:999px;padding:7px 16px;font:inherit;font-weight:600;cursor:pointer;background:var(--body,#FFB38A);color:var(--on-body,#3A2E39)}
#desktop-update-banner .act:hover{background:var(--shade,#EE8F64)}
#desktop-update-banner .x{background:none;border:0;font-size:18px;line-height:1;cursor:pointer;color:var(--soft,#8A7A86)}
`;

// Script run in the page. Re-rendering replaces the card; a null view removes it. Built with textContent only.
function bannerScript(v) {
  return `(() => {
    const v = ${JSON.stringify(v)};
    let bar = document.getElementById('desktop-update-banner');
    if (bar) bar.remove();
    let css = document.getElementById('desktop-update-style');
    if (!v) { if (css) css.remove(); return; }
    if (!css) { css = document.createElement('style'); css.id = 'desktop-update-style'; document.head.append(css); }
    css.textContent = ${JSON.stringify(CARD_CSS)};
    bar = document.createElement('div');
    bar.id = 'desktop-update-banner'; bar.setAttribute('role', 'status'); bar.dataset.phase = v.phase || '';
    if (v.error) bar.classList.add('error');
    const row = document.createElement('div'); row.className = 'row';
    const text = document.createElement('span'); text.className = 'txt'; text.textContent = v.text; row.append(text);
    if (v.dismissible) {
      const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
      x.onclick = () => { location.href = ${JSON.stringify(ACTION_PREFIX + 'dismiss')}; }; row.append(x);
    }
    bar.append(row);
    if (v.percent !== null && v.phase === 'downloading') {
      const p = document.createElement('progress'); p.max = 100; p.value = v.percent; p.setAttribute('aria-label', 'Download progress'); bar.append(p);
    }
    if (v.action) {
      const a = document.createElement('button'); a.type = 'button'; a.className = 'act'; a.textContent = v.action.label;
      a.onclick = () => { location.href = v.action.url; }; bar.append(a);
    }
    document.body.append(bar);
  })()`;
}

// Wires an electron-updater-like autoUpdater (EventEmitter + checkForUpdates/quitAndInstall) to the state machine.
// getHeaders() resolves to the request headers (login cookie). onState(state) is called after every change.
function createUpdater({ autoUpdater, getHeaders, onState = () => {}, onRestart = () => {}, log = () => {}, dismissed = null, onDismiss = () => {} }) {
  let state = dismissed ? { phase: 'idle', dismissed } : IDLE;   // a saved dismissal survives a restart; it only matches that version
  const apply = (event) => {
    const next = reduce(state, event);
    if (next !== state) { state = next; onState(state); }
  };
  autoUpdater.autoDownload = false;   // #97: the person clicks Download
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
  // Only ever called from a user click (Download / Try again).
  async function download() {
    try { await autoUpdater.downloadUpdate(); }
    catch (err) { log('update download failed', err); apply({ type: 'error', message: friendlyError(err) }); }
  }
  return {
    get state() { return state; },
    check,
    handleAction(action) {
      if (action === 'restart' && state.phase === 'ready') { onRestart(); autoUpdater.quitAndInstall(false, true); return true; }
      if ((action === 'download' && state.phase === 'available') || (action === 'retry' && state.phase === 'error')) {
        apply({ type: action });
        return download().then(() => true);
      }
      if (action === 'dismiss') { apply({ type: 'dismiss' }); if (state.dismissed) onDismiss(state.dismissed); return true; }
      return false;
    },
    dismiss() { apply({ type: 'dismiss' }); },
  };
}

module.exports = { CARD_CSS, FEED_URL, ACTION_PREFIX, IDLE, reduce, friendlyError, cookieHeader, parseAction, view, bannerScript, createUpdater };
