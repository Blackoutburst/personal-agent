'use strict';
const path = require('node:path');
const { app, BrowserWindow, shell, screen, session, Tray, Menu, Notification, nativeImage, globalShortcut, ipcMain } = require('electron');
const { COMPANION_URL, isInternal, isExternalOpenable, afterLogin, isSignedIn, SESSION_URL } = require('./src/urls');
const windowState = require('./src/window-state');
const { persistentVersion } = require('./src/cookies');
const { SITE } = require('./src/urls');
const updater = require('./src/updater');
const settingsStore = require('./src/settings');
const { parseArrival, createUnread, toastFor, tooltip } = require('./src/unread');
const { badgeBitmap } = require('./src/badge');
const { makeAppIcon } = require('./src/icon');

app.setName('Companion');
// Persistent default session: cookies from the platform login survive restarts.
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
let appUpdater = null; // in-app updater (src/updater.js); null when not an installed build
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const startHidden = process.argv.includes('--hidden');
let win = null, tray = null, quitting = false, settings = settingsStore.load(path.join(app.getPath('userData'), 'settings.json'));
const unread = createUnread({ onChange: (n) => renderUnread(n) });
const toasts = new Set(); // keep references so a toast stays clickable

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow();
}
function openChat(hash) {
  showWindow();
  if (win && /^#(chat|group\/[0-9a-f-]{36})$/.test(hash)) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}
function looking() { return !!win && win.isVisible() && !win.isMinimized() && win.isFocused(); }
// The companion icon, plain or with the web favicon's unread dot (src/dot.js); built once per size.
const appIcon = makeAppIcon({ nativeImage, iconPath: path.join(__dirname, 'build', 'icon.png') });
function renderUnread(n) {
  try {
    if (tray) { tray.setToolTip(tooltip(n)); tray.setImage(appIcon(n > 0, 32)); }
  } catch (e) { console.error('tray update failed:', e); }
  if (win && !win.isDestroyed()) {
    try { win.setIcon(appIcon(n > 0, 256)); } catch (e) { console.error('window icon failed:', e); }
    try {
      if (n > 0) { const b = badgeBitmap(n); win.setOverlayIcon(nativeImage.createFromBitmap(b.buffer, { width: b.width, height: b.height }), `${n} unread`); }
      else win.setOverlayIcon(null, '');
    } catch (e) { console.error('overlay badge failed:', e); }
  }
}
// Runs on every start, so the Run entry is rewritten with the path of the exe that is running now. A 0.3.0 portable user who
// had "Start with Windows" on (same app name -> same registry value name and same settings.json) gets the installed
// exe's path on the first 0.4.0 start; if it was off, the entry is removed. (#89; not run on Windows)
function applyAutostart() {
  if (!app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; // the portable exe, not its temp extraction
  try { app.setLoginItemSettings(settingsStore.loginItem(settings.autostart, exe)); } catch {}
}
function setAutostart(on) {
  settings = { ...settings, autostart: on === true };
  try { settingsStore.save(settingsFile(), settings); } catch {}
  applyAutostart(); buildTrayMenu();
}
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    ...(appUpdater && appUpdater.state.phase === 'ready' ? [{ label: `Restart to update (${appUpdater.state.version})`, click: () => appUpdater.handleAction('restart') }] : []),
    { label: 'Start with Windows', type: 'checkbox', checked: settings.autostart, click: (i) => setAutostart(i.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  tray = new Tray(appIcon(unread.count > 0, 32));
  tray.setToolTip(tooltip(unread.count));
  tray.on('click', toggleWindow);
  buildTrayMenu();
}
function onArrival(raw) {
  const a = parseArrival(raw);
  const r = unread.arrive(a, { looking: looking() });
  if (!r.toast || !Notification.isSupported()) return;
  const t = toastFor(a, win && !win.isDestroyed() ? win.getTitle() : '');
  const n = new Notification({ title: t.title, body: t.body, icon: path.join(__dirname, 'build', 'icon.png') });
  toasts.add(n);
  n.on('click', () => { toasts.delete(n); openChat(t.hash); });
  n.on('close', () => toasts.delete(n));
  n.show();
}

function openExternal(url) {
  if (isExternalOpenable(url)) shell.openExternal(url);
}

function createWindow() {
  const st = windowState.load(stateFile(), screen.getAllDisplays());
  win = new BrowserWindow({
    width: st.width, height: st.height, x: st.x, y: st.y,
    minWidth: windowState.MIN.width, minHeight: windowState.MIN.height,
    backgroundColor: '#fff1e8',
    title: 'Companion',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: !startHidden,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (st.maximized) win.maximize();
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('focus', () => unread.clear());
  win.on('show', () => { if (win.isFocused()) unread.clear(); });
  win.webContents.on('did-finish-load', () => renderUnread(unread.count));

  const persist = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b = maximized ? (windowState.last || win.getNormalBounds()) : win.getBounds();
    windowState.last = maximized ? b : null;
    try { windowState.save(stateFile(), { ...b, maximized }); } catch {}
  };
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(persist, 400); };
  win.on('resize', later); win.on('move', later); win.on('close', persist);
  win.on('closed', () => { clearTimeout(timer); win = null; });

  // Links that leave the companion/login pages open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) openExternal(url);
    else win.loadURL(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const action = updater.parseAction(url);
    if (action) { e.preventDefault(); if (appUpdater) appUpdater.handleAction(action); return; }
    if (!isInternal(url)) { e.preventDefault(); openExternal(url); }
  });
  // After the platform sign-in the site may land on its home or the Board: send the window back to the companion.
  // A short burst limit stops a loop if the server keeps bouncing us.
  let sent = [];
  const signedIn = async () => {
    try {
      const r = await session.defaultSession.fetch(SESSION_URL, { headers: { accept: 'application/json' } });
      return r.ok && isSignedIn(await r.json());
    } catch { return false; }   // unknown = treat as signed out: do nothing
  };
  const backToCompanion = async (_e, url) => {
    if (!win || win.isDestroyed()) return;
    let to = afterLogin(url, false);                 // sign-in page: add next=, no session needed
    if (!to && afterLogin(url, true)) {              // a would-be bounce: only when truly signed in
      if (!(await signedIn())) return;
      if (!win || win.isDestroyed() || win.webContents.getURL() !== url) return;   // moved on meanwhile
      to = afterLogin(url, true);
    }
    const now = Date.now();
    sent = sent.filter((t) => now - t < 10000);
    if (!to || sent.length >= 3) return;
    sent.push(now);
    win.loadURL(to);
  };
  win.webContents.on('did-navigate', backToCompanion);
  win.webContents.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) backToCompanion(e, url); });
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3) setTimeout(() => win && !win.isDestroyed() && win.loadURL(COMPANION_URL), 5000);
  });
  win.webContents.on('did-finish-load', () => {
    renderUpdate();
  });
  win.loadURL(COMPANION_URL);
}

// In-app update (#89): electron-updater against the server feed; the bar in the window shows progress and "Restart to update".
function renderUpdate() {
  buildTrayMenu();   // the tray offers Restart to update once a download is ready, even if the bar was dismissed
  if (!appUpdater || !win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(updater.bannerScript(updater.view(appUpdater.state))).catch(() => {});
}
function startUpdater() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return;   // dev run or an old portable exe: no self-update
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: updater.FEED_URL });
  appUpdater = updater.createUpdater({
    autoUpdater,
    // The feed is owner-only: send the window session's login cookies (electron-updater does not use the session itself).
    getHeaders: async () => ({ Cookie: updater.cookieHeader(await session.defaultSession.cookies.get({ url: SITE })) }),
    onState: renderUpdate,
    dismissed: settings.updateDismissed,
    onDismiss: (v) => { settings = { ...settings, updateDismissed: v }; try { settingsStore.save(settingsFile(), settings); } catch {} },
    onRestart: () => { quitting = true; },   // the close handler would otherwise hide the window instead of letting it quit
    log: (...a) => console.warn(...a),
  });
  setTimeout(() => appUpdater.check(), 15000); setInterval(() => appUpdater.check(), 24 * 60 * 60 * 1000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'clipboard-sanitized-write'].includes(perm)));
    session.defaultSession.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (removed) return;
      const next = persistentVersion(cookie, SITE);
      if (next) session.defaultSession.cookies.set(next).catch(() => {});
    });
    // Page notifications are denied on purpose: toasts come from the shell (one per arrival), so web push in the page cannot double them.
    app.setAppUserModelId('com.blackoutburst.companion');
    ipcMain.on('companion:arrival', (e, raw) => { if (win && e.sender === win.webContents && typeof raw === 'string' && raw.length < 500) onArrival(raw); });
    createTray();
    createWindow();
    startUpdater();
    applyAutostart();
    if (!globalShortcut.register(settingsStore.SHORTCUT, toggleWindow)) console.warn('global shortcut unavailable');
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Closing the window only hides it; the tray keeps the app running until Quit.
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
