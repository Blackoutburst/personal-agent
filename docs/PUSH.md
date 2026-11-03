# Android push notifications

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
