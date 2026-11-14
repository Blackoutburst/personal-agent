# Desktop app (Windows)

`desktop/` is a thin Electron shell around the live companion web client, like the Android app:
the server holds all state; the app loads `https://blackoutburst.com/personal-agent-preview/`
(same `SITE` + `COMPANION_PATH` as `android/app/build.gradle.kts`).

## Stack choice: Electron, not Tauri

Checked on the build host (Linux, no root, no wine): `rustup`, `cargo`, `cargo-xwin`, `makensis`
and `wine` are all absent, and the Windows MSVC SDK that cargo-xwin needs is a separate large
download. Network access works (npm registry, GitHub, static.rust-lang.org reachable). Tauri v2
would need a Rust toolchain, the MSVC SDK and NSIS installed first; I did not try to install them.
Electron + electron-builder needs only npm and downloads prebuilt Windows binaries, so it was
chosen because it actually produces a Windows x64 `.exe` here.

What was tried:
- NSIS installer target (#89): electron-builder's stock Linux path fails (`spawn wine ENOENT`): it builds the uninstaller by
  running the installer stub under wine. electron-builder has a pure-JS alternative (it reads the uninstaller out of the
  stub's bytes, used for macOS Catalina). `desktop/scripts/build-nsis.js` selects that branch by making
  `isMacOsCatalina()` return true before running electron-builder, wine installed or not. electron-builder is pinned to an exact
  version (26.18.0); the script refuses any other version, refuses if `NsisTarget.js` no longer has that branch, and fails the
  build if the pure-JS uninstaller extraction was not actually used (it never falls back to wine). Result: a real NSIS per-user installer built on Linux with no wine. Not run on Windows (see below).
- Portable target (#84-#88) worked too, and is retired by #89.
- `scripts/build-desktop.sh` installs with `npm ci` (not `npm install`, which can rewrite `desktop/package-lock.json` and dirty the checkout); a build leaves `git status` clean.
- The system `npm` on the host is broken (missing `semver`). `scripts/build-desktop.sh` therefore
  checks `npm -v`; if it fails (and `NPM_CLI` is not set) it downloads the pinned `npm-10.9.2.tgz`
  from the registry into a temp dir, verifies its sha512 integrity against the value pinned in the
  script (aborts on mismatch), and puts an `npm` shim on PATH (electron-builder calls `npm` itself).

## Rebuild

    scripts/build-desktop.sh                      # picks system npm, or fetches pinned npm 10.9.2 if it is broken
    NPM_CLI=/path/to/npm-cli.js scripts/build-desktop.sh   # force a specific npm

Output in `desktop/dist/` (git-ignored): `Companion-Setup-<version>-x64.exe` (NSIS, per-user, no admin),
`Companion-Setup-<version>-x64.exe.blockmap` and `latest.yml` (electron-updater feed with the installer's sha512).

## Behaviour

- Login: the platform sign-in (`/account/`) happens inside the window; `src/urls.js` keeps
  `/personal-agent-preview/`, `/account/` and `/api/account/` on `blackoutburst.com` internal.
- Session: Electron's default session is persistent; `src/cookies.js` also gives session cookies
  (no expiry) on the site a 90-day expiry so the login survives a restart. Logout still works
  (cookie removal is not re-added).
- External links (Board, GitHub, web results; any other origin) open in the default browser,
  only for plain http(s) without credentials. `window.open` and navigation are both intercepted.
- Window: size/position/maximized saved to `window-state.json` in the user data dir; a saved
  position that is off every display is dropped; min size 420x560. Single instance: a second
  launch restores and focuses the first window.
- Name/icon: "Companion", icon from `public/icons/icon-512.png` (peach companion).

## Release flow, download and in-app update (#84, #89)

Why the NSIS installer + electron-updater (chosen over keeping the portable exe and swapping it with a helper): the
updater verifies the download against the sha512 in `latest.yml`, reports `download-progress`, and `quitAndInstall`
replaces the app and relaunches it, all maintained code. A portable exe cannot replace itself while running, so it would
need our own helper process, our own checksum and relaunch logic, all untestable here. Per-user NSIS needs no admin.

1. Bump `version` in `desktop/package.json` (`x.y.z` only).
2. `scripts/build-desktop.sh` builds the three files above.
3. `scripts/publish-desktop.sh` (Blackout's step) copies the installer, blockmap and `latest.yml` into
   `<COMPANION_DATA_DIR>/downloads/` (default `~/personal-agent-data`) and writes `desktop.json` last:
   `{"version":"0.4.1","file":"Companion-Setup-0.4.1-x64.exe"}`. It refuses to publish if `latest.yml` is for another
   version. That folder lives outside the checkout, so `ops/release.mjs` leaves it alone and the service serves the new
   build at once. Nothing is committed to git.

Server, owner only (404 when no valid `desktop.json` + installer exist, 401 when signed out):
- `GET /api/desktop` returns `{version, size, sha256}`; `GET /api/desktop/download` serves the installer as
  `Companion-<version>.exe` with the hash in `X-Content-Sha256`. A query string on these paths (and the feed) is ignored. Unchanged shape (the 0.3.0 banner and the Settings card use them).
- `GET /api/desktop/update/latest.yml`, `/api/desktop/update/<installer>` and `.../<installer>.blockmap`: the electron-updater
  generic feed. Same owner check, no other file names are served. Whole files only (no Range), so the app sets
  `disableDifferentialDownload`; the blockmap is published for a later upgrade.

Clients:
- Web: Me › Settings shows a "Windows app" card with the version and a Download button (now the installer), only in a desktop
  browser (not phones, tablets or the app itself) and only when a build is published (`public/desktop-card.mjs`).
- App (`desktop/src/updater.js`, wired in `main.js`): 15 s after start and every 24 h it checks the feed. The feed needs the
  login, and electron-updater does not use the window's session, so the window session's cookies for the site are sent as
  a `Cookie` header. Nothing downloads by itself (#97, `autoDownload = false`): a found version shows a card in the
  window's bottom-right corner, "Update x.y.z is available" with a **Download** button. A click starts the download
  (progress bar and "n%"), then "Update x.y.z is ready" with **Restart to update**, which calls
  `quitAndInstall(false, true)`: the app quits, the installer runs with its window visible (`isSilent=false`, a short progress window
  of the per-user installer, no admin prompt) and starts the new version when it finishes. Until you click it, nothing is replaced; the old version keeps running.
  The card is injected into the page and styled only with the app's theme variables (`--card --ink --line --radius --glow`,
  errors `--danger/--danger-bg`) and the accent pair `--body`/`--on-body` (same as `.button.primary`), so light/dark and a
  changed accent colour apply; no native dialog. Its × (`companion-update://dismiss`) hides the card for that version; the
  version is saved in `settings.json` (`updateDismissed`), so it stays hidden across restarts until a newer version or an error.
  A dismissed ready update stays ready: the tray menu then offers "Restart to update (x.y.z)".
  Actions are `companion-update://download|restart|retry|dismiss`, intercepted in `will-navigate` (nothing is exposed to the page).
  (Not a preload `contextBridge`: the existing link interception from #89 was kept, so the page gets no new API.)
- Errors: a failed download (offline, 401/403, 404, checksum mismatch) shows a plain message and "Try again" (downloads again) on the card; the
  installed version is untouched. A failed *background check* (offline at startup) is silent; the next check is in 24 h.
- Only installed builds update themselves (`app.isPackaged`, not `PORTABLE_EXECUTABLE_FILE`).

### Migration from 0.3.0 (portable)

0.3.0 cannot update itself. Its banner ("Update available" -> Download) and the Settings card both fetch
`/api/desktop/download`, which now serves the 0.4.0 installer. Steps for a 0.3.0 user:

1. **Quit 0.3.0 from its tray icon** (right click > Quit; closing the window only hides it). Both builds use the same app
   name and share one single-instance lock, so a running 0.3.0 would swallow the launch of 0.4.0 and just show its own window.
2. Download from the banner or Me > Settings > Windows app, and run the installer once. It is per-user (no admin prompt),
   installs to `%LOCALAPPDATA%\Programs\Companion`, adds a Start menu entry and starts the app. SmartScreen warns (unsigned):
   More info > Run anyway.
3. Delete the old portable exe (e.g. `Companion 0.3.0.exe` wherever it was saved) and any desktop/taskbar shortcut you made to it:
   the installer does not touch them, and a shortcut to the old exe would start 0.3.0 again. Pin the new Start menu entry instead.

What carries over (from the config; **not verified on Windows**):
- **Login and data: yes.** Both builds run the same `main.js` with `productName: "Companion"` and `app.setName('Companion')`, and
  nothing sets `userData`, so both use `%APPDATA%\Companion` (session cookies, `window-state.json`, `settings.json`). The portable
  wrapper only changes where the program is unpacked, not userData. You stay signed in.
- **Start with Windows: rewritten automatically.** The setting lives in `settings.json` (shared) and `applyAutostart()` runs at
  every start. On the first 0.4.0 start it calls `setLoginItemSettings` with the installed exe's path; Electron's registry value
  name defaults to the app name (`Companion`, the same for both builds), so the old entry pointing at the portable exe is
  overwritten, not duplicated. If the setting was off, the entry is removed. If you ever see two "Companion" entries in
  Task Manager > Startup, disable the one whose path is the old exe.
- **Old exe and shortcuts: left alone** (step 3). The old exe also leaves a temp extraction folder in `%TEMP%` that Windows can clean.
- From 0.4.0 on, updates happen in the app.

## Login return (#87)

Redirect chain, traced with `curl -sI` on 2026-11-11 (signed out) and from the Android code:

1. `GET /personal-agent-preview/` -> 200 (the companion page itself; it shows the sign-in when there is no session).
2. `GET /account/` -> 200, the platform account SPA (`/platform/community.js`); sign-in happens there.
3. `GET /` (platform home) -> 200, no redirect. The page the user reported landing on.
4. `GET board.blackoutburst.com/` -> **302 to `https://blackoutburst.com/account/`** when signed out. So the Board is an
   SSO hop: it bounces through the account page and only comes back signed in.
5. `GET /api/account/session` -> 200 JSON `{"user":null,...}` signed out (observed). The signed-in body is NOT verified: that endpoint is platform code outside this repo. `isSignedIn` accepts a `user` object with an `id`, the shape `src/account-validator.mjs:46-48` reads from the platform's `/internal/account/session` (200 `{user:{id}}` signed in, 401 signed out; loopback only, not reachable from the app).
   (`/api/account/me` and `/api/desktop` are 404/denied without a login.)

Android does not use a return URL: it starts `/account/?app=companion&challenge=..&state=..` (PKCE) and the platform hands
the result back through the `blackoutburst-companion://auth` deep link. That does not exist for a window, so the window
decides itself. Whether the platform honours `?next=` on `/account/` could not be tested without signing in; the redirect
back below does not depend on it.

`afterLogin(url, signedIn)` in `src/urls.js` (pure, tested), run after every main-frame navigation:
- bare `/account/` -> reloaded once with `?next=<companion url>` (needs no session);
- companion and other account/api-account pages -> stay;
- any other blackoutburst.com page (platform home, Board) -> back to the companion **only if** `signedIn === true`.
  `main.js` computes that by fetching `/api/account/session` with the window's own session (`isSignedIn`, `user.id` present).
  Signed out, unknown, or a failed fetch = no redirect, so the Board -> account SSO hop and the login itself are never cut.
  The check is repeated against the current URL after the fetch so a stale answer cannot redirect a page the user left.
- at most 3 redirects per 10 s as a loop guard. Board links clicked in the chat are not internal, so they still open in
  the system browser.

Not verified in a live Electron window on Windows (no signing-in possible here); the decision logic is covered by
`test/desktop.test.mjs`.

## Tray, toasts, badge, autostart, shortcut (#83)

- **Tray**: closing the window hides it; the app keeps running in the tray. Left click toggles the window; menu:
  Open, Start with Windows (checkbox), Quit (the only way to exit). A second launch shows the window.
  Shortcut/tray/autostart logic is in `desktop/main.js`; the testable parts are in `desktop/src/`.
- **Toasts**: the web client announces each new companion message (chat or group) by setting
  `<html data-companion-arrival>` and firing `companion-arrival` (`dataArrived` in `public/companion-app.mjs`; the
  conversation id only, no text). `desktop/preload.js` forwards it to the main process, which shows one native
  Windows toast "<companion name> / New message" via Electron `Notification` (no text leaves the page). This covers
  her own first messages, reminders and replies, since all go through the same poll. Toasts appear only when the
  window is not visible and focused. Clicking one shows the window and opens `#chat` (or the group).
- **No duplicates**: the shell denies the page's own `notifications` permission, so web push / the service worker
  in the embedded page can never raise a second toast. Arrivals are also de-duplicated (same conversation within 4 s,
  repeated message id) in `src/unread.js`. Consequence: the web "notifications" switch shows as blocked in the app.
- **Unread**: counted per arrival while the window is hidden/unfocused; shown as a red overlay badge on the taskbar
  icon (`setOverlayIcon`, 16x16 bitmap drawn in `src/badge.js`, "9+" above 9) and in the tray tooltip. Cleared when
  the window is shown and focused. The count lives in memory only. It is an arrival counter, not the server's unread totals.
- **Start with Windows**: tray menu checkbox, off by default, stored in `settings.json` in the user data dir. Uses
  `app.setLoginItemSettings` with the installed exe path and `--hidden`, so it starts in
  the tray. Only applies to the packaged app.
- **Global shortcut**: **Ctrl+Alt+C** shows/hides the window (hides only if it is already focused). If another app
  owns it the registration fails silently (logged); the tray still works.

## Not verified / limitations

- #84 pieces were tested only by `node --test` (endpoint, card logic, update comparison/banner script). The banner
  injection, the daily timer and `session.fetch` with the login cookie were not run in a live Electron window, and
  `publish-desktop.sh` was not run against the real data folder.

- **Never run on real Windows** (nor under wine). Only the build and the JS logic tests
  (`test/desktop.test.mjs`) ran. Login, cookie persistence, single instance and window state are
  implemented but untested in a live window; live-site cookie attributes were not inspected.
- #88: the exe carries the companion icon without wine: `build/icon.ico` (16-256 px) is set on the app exe by
  `scripts/after-pack.js` (resedit, pure JS) and on the portable wrapper via `win.icon`; read back from the built
  exes it matches the .ico image hashes (`src/exe-icon.js`). On a new message the window and tray icon switch
  to the favicon's unread look (red dot, white ring, `src/dot.js`, same geometry as `public/unread-mark.mjs`) and
  back when read; the #83 overlay count badge stays (same red). **Not seen on real Windows**: that the taskbar
  actually repaints with the dotted icon.
- #83 features (tray, toast, overlay badge, autostart, shortcut) are **built, not run on Windows**. Unverified:
  toast activation after a click on a closed-to-tray app, overlay rendering, that the page's `dataset` event
  reaches the preload in a real window, autostart from the portable exe's path. The live site must be deployed with
  the `dataArrived` hook before toasts fire; until then the app just shows no toasts.
- Unsigned: Windows SmartScreen will warn on first run.
- #89 in-app update: **not run on real Windows, not run in a live Electron window, and not run against the real server.**
  What ran: the state logic and the electron-updater wiring against a fake autoUpdater, the feed endpoints (`node --test`),
  and the Linux build of the installer (no wine). Unverified: that the installer installs and runs on Windows, that
  electron-updater really sends the Cookie header and reads the feed behind the login, the progress/restart bar in the window,
  that `quitAndInstall` relaunches 0.5.0, and the wine-free uninstaller extraction (the installer was not executed, so its
  uninstaller is untested). The first real test is: install 0.4.0, publish a higher version, wait for the check.
  The 0.4.0 installer is unsigned: SmartScreen warns on first run.

- #97 update flow: **not run on real Windows and not in a live Electron window.** Ran: the reducer and electron-updater wiring
  against a fake autoUpdater (no download without a click, progress, restart, error/retry, saved dismissal), the card's script in a
  DOM stand-in, and headless-Chromium screenshots (the #78 browser, not the verify steps, which have no script step) of the card in each
  state, light/dark and with a changed accent, on `public/companion.css`. Unverified: the card inside the real app page and
  that electron-updater's `downloadUpdate()` after a user-click behaves as in its docs. Version 0.5.0.
