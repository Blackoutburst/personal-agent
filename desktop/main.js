'use strict';
const path = require('node:path');
const { app, BrowserWindow, shell, screen, session } = require('electron');
const { COMPANION_URL, isInternal, isExternalOpenable } = require('./src/urls');
const windowState = require('./src/window-state');
const { persistentVersion } = require('./src/cookies');
const { SITE } = require('./src/urls');
const update = require('./src/update');

app.setName('Companion');
// Persistent default session: cookies from the platform login survive restarts.
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
let win = null;
let pendingUpdate = null; // set by the daily check; the banner is (re)added after each page load

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
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  if (st.maximized) win.maximize();

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
    if (!isInternal(url)) { e.preventDefault(); openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (isMain && code !== -3) setTimeout(() => win && !win.isDestroyed() && win.loadURL(COMPANION_URL), 5000);
  });
  win.webContents.on('did-finish-load', () => {
    if (pendingUpdate) win.webContents.executeJavaScript(update.bannerScript(pendingUpdate)).catch(() => {});
  });
  win.loadURL(COMPANION_URL);
}

// At start and once a day: ask the server for the offered version (needs the login cookie; signed out = no banner).
async function checkUpdate() {
  pendingUpdate = await update.checkForUpdate((url, init) => session.defaultSession.fetch(url, init), app.getVersion());
  if (pendingUpdate && win && !win.isDestroyed()) win.webContents.executeJavaScript(update.bannerScript(pendingUpdate)).catch(() => {});
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['notifications', 'media', 'clipboard-sanitized-write'].includes(perm)));
    session.defaultSession.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (removed) return;
      const next = persistentVersion(cookie, SITE);
      if (next) session.defaultSession.cookies.set(next).catch(() => {});
    });
    createWindow();
    setTimeout(checkUpdate, 15000); setInterval(checkUpdate, update.DAY_MS);
  });
  app.on('window-all-closed', () => app.quit());
}
