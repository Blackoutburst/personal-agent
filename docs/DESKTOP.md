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
- The system `npm` on the host is broken (missing `semver`), so the script accepts `NPM_CLI`
  pointing at a working `npm-cli.js` (e.g. from `npm-10.x.tgz` on the registry) and puts a shim on PATH.

## Rebuild

    scripts/build-desktop.sh                      # working npm
    NPM_CLI=/path/to/npm-cli.js scripts/build-desktop.sh   # broken system npm

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

## Not verified / limitations

- **Never run on real Windows** (nor under wine). Only the build and the JS logic tests
  (`test/desktop.test.mjs`) ran. Login, cookie persistence, single instance and window state are
  implemented but untested in a live window; live-site cookie attributes were not inspected.
- The `.exe` file icon (Explorer/taskbar-of-exe) is Electron's default: editing the exe resources
  needs wine, so `signAndEditExecutable` is off. The window/taskbar icon at runtime is the companion's.
- Unsigned: Windows SmartScreen will warn on first run.
- No tray, notifications or auto-update (later tickets).
