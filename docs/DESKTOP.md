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
- NSIS installer target: fails here (`spawn wine ENOENT`; electron-builder runs the installer
  stub under wine to produce the uninstaller). Needs wine, or a Windows/CI host.
- **Portable target: works.** Output `desktop/dist/Companion-Portable-<version>-x64.exe`
  (single self-extracting exe, no install, no uninstaller).
- The system `npm` on the host is broken (missing `semver`). `scripts/build-desktop.sh` therefore
  checks `npm -v`; if it fails (and `NPM_CLI` is not set) it downloads the pinned `npm-10.9.2.tgz`
  from the registry into a temp dir, verifies its sha512 integrity against the value pinned in the
  script (aborts on mismatch), and puts an `npm` shim on PATH (electron-builder calls `npm` itself).

## Rebuild

    scripts/build-desktop.sh                      # picks system npm, or fetches pinned npm 10.9.2 if it is broken
    NPM_CLI=/path/to/npm-cli.js scripts/build-desktop.sh   # force a specific npm

Output: `desktop/dist/Companion-Portable-0.1.0-x64.exe` (git-ignored). On Windows with a working
toolchain, change the target to `nsis` in `desktop/package.json` for a real installer.

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

## Release flow, download and update check (#84)

1. Bump `version` in `desktop/package.json` (the app compares it with the server's version; `x.y.z` only).
2. `scripts/build-desktop.sh` builds `desktop/dist/Companion-Portable-<version>-x64.exe`.
3. `scripts/publish-desktop.sh` copies that exe into `<COMPANION_DATA_DIR>/downloads/` (default `~/personal-agent-data`)
   and writes `desktop.json` there: `{"version":"0.1.0","file":"Companion-Portable-0.1.0-x64.exe"}`.
   That folder lives outside the checkout, so the normal release (`ops/release.mjs`) leaves it alone and the running
   service picks the new build up at once, no restart. The exe is never committed to git.

Server, owner only (the signed-in pilot account; 404 when no valid `desktop.json` + exe exist, 401 when signed out):
- `GET /api/desktop` returns `{version, size, sha256}` (the sha256 is computed once per file and cached).
- `GET /api/desktop/download` serves the exe as `Companion-<version>.exe` with the hash also in `X-Content-Sha256`.
  Unlike the Android APK (`/companion.apk`, public), these need the login cookie.

Clients:
- Web: Me › Settings shows a "Windows app" card with the version and a Download button, only in a desktop browser
  (not phones, tablets or the app itself) and only when a build is published (`public/desktop-card.mjs`).
- App: `src/update.js` asks `/api/desktop` with the app's login session 15 s after start and then every 24 h. If the
  server version is newer than `app.getVersion()`, a small dismissible "Update available" bar with a Download link
  appears in the window (re-added after each page load). The link downloads the exe; you run it yourself. Signed out
  or offline means no banner.
## Login return (#87)

Redirect chain, traced with `curl -sI` on 2026-11-11 (signed out) and from the Android code:

1. `GET /personal-agent-preview/` -> 200 (the companion page itself; it shows the sign-in when there is no session).
2. `GET /account/` -> 200, the platform account SPA (`/platform/community.js`); sign-in happens there.
3. `GET /` (platform home) -> 200, no redirect. The page the user reported landing on.
4. `GET board.blackoutburst.com/` -> **302 to `https://blackoutburst.com/account/`** when signed out. So the Board is an
   SSO hop: it bounces through the account page and only comes back signed in.
5. `GET /api/account/session` -> 200 JSON `{"user":null,...}` signed out; `user` is an object when signed in.
   (`/api/account/me` and `/api/desktop` are 404/denied without a login.)

Android does not use a return URL: it starts `/account/?app=companion&challenge=..&state=..` (PKCE) and the platform hands
the result back through the `blackoutburst-companion://auth` deep link. That does not exist for a window, so the window
decides itself. Whether the platform honours `?next=` on `/account/` could not be tested without signing in; the redirect
back below does not depend on it.

`afterLogin(url, signedIn)` in `src/urls.js` (pure, tested), run after every main-frame navigation:
- bare `/account/` -> reloaded once with `?next=<companion url>` (needs no session);
- companion and other account/api-account pages -> stay;
- any other blackoutburst.com page (platform home, Board) -> back to the companion **only if** `signedIn === true`.
  `main.js` computes that by fetching `/api/account/session` with the window's own session (`isSignedIn`, `user` non-null).
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
  `app.setLoginItemSettings` with the portable exe path (`PORTABLE_EXECUTABLE_FILE`) and `--hidden`, so it starts in
  the tray. Only applies to the packaged app. If the portable exe is moved, toggle it off and on.
- **Global shortcut**: **Ctrl+Alt+C** shows/hides the window (hides only if it is already focused). If another app
  owns it the registration fails silently (logged); the tray still works.

## Not verified / limitations

- #84 pieces were tested only by `node --test` (endpoint, card logic, update comparison/banner script). The banner
  injection, the daily timer and `session.fetch` with the login cookie were not run in a live Electron window, and
  `publish-desktop.sh` was not run against the real data folder.

- **Never run on real Windows** (nor under wine). Only the build and the JS logic tests
  (`test/desktop.test.mjs`) ran. Login, cookie persistence, single instance and window state are
  implemented but untested in a live window; live-site cookie attributes were not inspected.
- The `.exe` file icon (Explorer/taskbar-of-exe) is Electron's default: editing the exe resources
  needs wine, so `signAndEditExecutable` is off. The window/taskbar icon at runtime is the companion's.
- #83 features (tray, toast, overlay badge, autostart, shortcut) are **built, not run on Windows**. Unverified:
  toast activation after a click on a closed-to-tray app, overlay rendering, that the page's `dataset` event
  reaches the preload in a real window, autostart from the portable exe's path. The live site must be deployed with
  the `dataArrived` hook before toasts fire; until then the app just shows no toasts.
- Unsigned: Windows SmartScreen will warn on first run.
- No tray or notifications (later tickets). No silent self-install: the app only announces updates (below).
- No auto-update (later ticket).
