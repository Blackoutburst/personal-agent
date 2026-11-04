# Push notifications (Android and the installed web app)

When a companion message is delivered (a reply, or a proactive message such as a reminder, check-in or watch
result), the owner's Android devices get a notification, unless the app is open. While the owner has any client open (#59), pushes wait 90 s
and are dropped if the owner actively looked at the conversation in that time ([Active client](#active-client-59)).

## How it works

- **Server** (`src/push.mjs`): the app registers its Firebase Cloud Messaging token with
  `POST api/companion {action: "pushRegister", token}`. The server binds the token to the signed-in owner
  (`push_devices`; a token re-registered by another account moves to it; newest 10 per owner).
  `pushUnregister` removes only the caller's own token. On each delivered message (the `onSettled` hook shared
  with Discord), every device of that owner gets a **data-only** FCM message, `{type, threadId, messageId, name}`
  (plus `board: "1"` for a Board sub-conversation, docs/BOARD-INBOX.md, so the tap opens it in the Board tab),
  with Android priority HIGH. The message text never goes through Google. Turns that came in through Discord are
  not pushed, because Discord notifies for those itself. Tokens Google reports as gone are removed.
- **App** (`Push.kt`): `PushService` receives the data message, skips it if the app is in the foreground,
  notifications are off, the permission isn't granted or nobody is signed in, and dedupes by message id. It then
  fetches the message over the owner's session and shows "<companion name>: <plain-text preview>". "Show the
  message in the notification" off → "New message". Tapping it opens the Chat tab on that conversation.
  Opening the app clears its notifications.
- Sign-out unregisters the token, then deletes it. The Look tab has the on/off and preview switches. The Android
  permission is asked once, right after the first message the owner sends, and the Look tab offers a way back if
  it was refused.

## Configuration

- Server: the FCM service-account key at `~/.config/personal-agent/fcm-service-account.json` (chmod 600, or
  `COMPANION_PUSH_KEY`). Without it, push is off; registration still works.
- Android build: the Firebase project's `google-services.json` at `~/.config/personal-agent/google-services.json`
  (or `COMPANION_FIREBASE`) is read by Gradle into BuildConfig. No google-services plugin is used, and nothing is
  committed. Without it the app builds with push hidden.
- Firebase project: `ai-companion-700bc`, Android app `dev.blackoutburst.companion`.

## Web Push and the iPhone (installed web app)

There is no native iOS app: a free Apple ID only signs an app for 7 days, and anything longer needs the paid
Apple Developer Program (and review for the App Store). Instead, the web client is an installable web app (PWA). On
iPhone: open it in Safari, Share → **Add to Home Screen**, and open it from the Home Screen. It is free, permanent,
needs no review and updates with every deploy. The same works on Android Chrome and desktop browsers.

- **Install**: `public/manifest.webmanifest` (standalone, the cream theme), icons in `public/icons/` (rendered from the
  Android launcher icon), Apple meta tags in `index.html`, and safe-area padding for the notch and home bar.
- **Service worker** (`public/sw.js`, scope = the app's path): network first for the app's own files, with the last
  loaded copy as an offline fallback; `api/` is never cached. It shows push notifications and opens the chat when one
  is tapped. While the app is open and in front it skips the notification, except on Apple's push service, which may
  revoke a subscription whose pushes show nothing. Opening the app clears its notifications.
- **Open on the chat (#49)**: while the app is visible on the Chat tab it sends `webPushPresence {endpoint, present: true}`
  every 15 s, and `present: false` (a keepalive request) when it is hidden, closed or leaves the chat. The server sends
  that device no push until 40 s after the last report, so nothing is sent and Safari has nothing to revoke. Other
  devices, and the same device on another tab or in the background, are notified as usual. Kept in memory only.
- **Server** (`src/web-push.mjs`): `POST api/companion` actions `webPushKey` (this server's VAPID public key),
  `webPushSubscribe {endpoint, p256dh, auth, preview}`, `webPushStatus {endpoint}` and `webPushUnsubscribe {endpoint}`,
  always for the signed-in owner (`web_push_subscriptions`; re-subscribing from another account moves it; newest 10 per
  owner). Endpoints must be https URLs of the browsers' push services (Apple, Google, Mozilla, Microsoft), because the
  server POSTs to them. The same settle events as Android push send `{type, threadId, messageId, title, body}`
  (plus `board: true` for a Board sub-conversation: `sw.js` then opens `#board/<threadId>`),
  encrypted for that browser alone (RFC 8291 aes128gcm, VAPID RFC 8292, Node crypto only), so the push service only
  relays ciphertext. `body` is a plain-text preview of up to 180 characters, or "New message" when the device turned
  the preview off. Subscriptions the push service reports gone (404/410) are removed. Logs carry counts only.
- **Settings** (Me › Settings › Notifications, `public/web-push-ui.mjs`): "Notify me on this device" asks for permission
  straight from the tap (Safari requires a gesture) and subscribes; "Show the message in the notification" changes the
  preview. In iPhone Safari outside the Home Screen app it explains how to install instead.
- **Key**: the VAPID key pair lives at `~/.config/personal-agent/web-push-vapid.json` (chmod 600, or
  `COMPANION_WEB_PUSH_KEY`). It is created on first use, but the live unit has `ProtectHome=read-only`, so on the
  server it was created ahead of time (3 Nov 2026). Replacing it invalidates every web subscription: each device turns notifications on again.

## Active client (#59)

While the owner has any client open, a companion message is not pushed to their devices at once. Two presence levels:

- **Active**: a web or PWA tab that is visible, focused and had input (pointer, key, wheel, touch; not scrolling, which
  the chat does by itself) in the last 2 minutes, or the Android app in the foreground and touched in the last 2
  minutes. Only an active client showing a conversation counts as the owner seeing it.
- **Present** (#59 follow-up): any signed-in web or PWA tab that is open, whatever its visibility or focus (a background
  tab, another window in front), plus every active client. The Android app in the background is not present.
- **Protocol**: `POST api/companion {action: "clientActive", client, state: "active"|"open"|"closed", active, threadId?}`.
  `client` is a random id per tab or app run, `threadId` the conversation shown (main chat or a Board sub-conversation),
  absent on other tabs. The web client sends `state` plus `active: state === "active"`. Older clients send only the
  boolean: `active: true` is `active`, `active: false` is `closed` (Android 0.25.x sends it when the app goes to the
  background; a web tab loaded before this change sends it on blur), so they behave exactly as before. The answer is
  `{active, state}`.
- **Web timings**: an active tab reports `active` every 20 s and at once when the conversation on screen changes. Blur,
  hiding the tab or 2 minutes without input report `open` at once (keepalive; with the conversation that was on
  screen, except after the input timeout, when it does not count as seen), then `open` every 30 s from the tab's
  existing 10 s check (no new timer; Chrome throttles a hidden tab's timers to about once a minute, which is fine).
  `pagehide` and sign-out report `closed` (keepalive); coming back from the back/forward cache reports `open` again.
- **Server** (`src/active-clients.mjs`): memory only, per owner, at most 16 clients. An `active` report counts for 50 s
  and does not lengthen presence (an active client that vanishes stops counting after 50 s, as before); an `open`
  report counts as present for 150 s (one late or missed beat from a throttled tab). `closed` forgets the client at once.
- **Hold**: a finished reply, proactive or wake message, or Board sub-conversation message for an owner with a present
  client is held for 90 s instead of going to Android (FCM), Web Push and the Discord DM mirror. Then: if an active
  client reported that conversation on screen at or after the message arrived, it was read and nothing is sent;
  otherwise everything goes out as usual. So a background tab delays pushes by 90 s but never swallows one unless the
  owner actually looked. No present client: pushed at once, as before.
- **Early decision**: when the owner's last present client reports `closed`, held messages are decided at once (pushed
  if not seen). A client going from active to open (switching window, hiding the tab) decides nothing early: the tab is
  still open and the owner may come back to it within the 90 s, which is the case the hold is for. Silent expiry
  decides nothing early either; held messages then wait out the delay.
- **Not held**: replies to messages the owner sent from Discord (answered in the DM at once; never pushed anyway),
  failed, stopped and merged turns.
- **Group chat**: a group push for a member with a present client is held the same way and dropped if the member
  read the group (its read marker reached the message) within the 90 s. The existing rule still applies first: no
  push to a member who read or posted in the group in the last 30 s, and none in quiet hours.
- **Fail open**: held messages are also written to `push_holds` in the store (removed when decided). On start, whatever
  a previous run still held is delivered at once (presence does not survive a restart), so a restart can make a push
  late but never loses it. Nothing new goes into any push payload.
- #49's per-device Web Push presence (below) still applies on top: a device open on the chat gets no Web Push at all.
- Older clients just never report; an older server answers `clientActive` (or the new `state` field) with 400, and the
  web and Android clients then stop asking until reloaded or restarted.

### Unread mark in the web tab

A new companion message (the app's `onDataArrived` hook: the open chat or Board sub-conversation, and the open group)
that arrives while the tab is hidden or unfocused, or while its conversation is not on screen, marks the tab
(`public/unread-mark.mjs`): the favicon gets a static red dot (the original icon drawn on a 64 px canvas with the dot,
set as a data URL on `<link rel="icon">`; the original href is restored), the title gets a `(•) ` prefix, and where the
browser supports it the installed app gets a badge (`navigator.setAppBadge`). A dot rather than a count: arrivals are
noticed per read, and a hidden tab reads once a minute, so a count would be wrong whenever several messages land in
one read. The mark for a conversation clears when the tab is visible and focused on it, checked on visibilitychange,
focus and view or conversation changes only: no timers, nothing animates.

## Group chat (#53)

Group messages push to every human member who did not write them, with a group flag and the group id for the deep
link (Android data `{type:"group", group:"1", groupId, messageId, name}`, still no message text; Web Push titled with
the group, body "Author: preview"). Mention-only members get only messages that mention them, and nobody gets a group
push during their own quiet hours. Details: [GROUP-CHAT.md](GROUP-CHAT.md).
