# Push notifications (Android and the installed web app)

When a companion message is delivered (a reply, or a proactive message such as a reminder, check-in or watch
result), the owner's Android devices get a notification, unless the app is open.

## How it works

- **Server** (`src/push.mjs`): the app registers its Firebase Cloud Messaging token with
  `POST api/companion {action: "pushRegister", token}`. The server binds the token to the signed-in owner
  (`push_devices`; a token re-registered by another account moves to it; newest 10 per owner).
  `pushUnregister` removes only the caller's own token. On each delivered message (the `onSettled` hook shared
  with Discord), every device of that owner gets a **data-only** FCM message, `{type, threadId, messageId, name}`,
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
  server POSTs to them. The same settle events as Android push send `{type, threadId, messageId, title, body}`,
  encrypted for that browser alone (RFC 8291 aes128gcm, VAPID RFC 8292, Node crypto only), so the push service only
  relays ciphertext. `body` is a plain-text preview of up to 180 characters, or "New message" when the device turned
  the preview off. Subscriptions the push service reports gone (404/410) are removed. Logs carry counts only.
- **Settings** (Me › Settings › Notifications, `public/web-push-ui.mjs`): "Notify me on this device" asks for permission
  straight from the tap (Safari requires a gesture) and subscribes; "Show the message in the notification" changes the
  preview. In iPhone Safari outside the Home Screen app it explains how to install instead.
- **Key**: the VAPID key pair lives at `~/.config/personal-agent/web-push-vapid.json` (chmod 600, or
  `COMPANION_WEB_PUSH_KEY`). It is created on first use, but the live unit has `ProtectHome=read-only`, so on the
  server it was created ahead of time (3 Nov 2026). Replacing it invalidates every web subscription: each device turns notifications on again.
