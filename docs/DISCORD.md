# Discord

Each owner can link **their own Discord bot** so they can talk to their companion in Discord direct messages. Reminders and other proactive messages (docs/SCHEDULER.md) are also sent there. It is set up in the Look page of the web app and the Android app, under "Discord".

## Setup (owner)

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), open **Bot**, press **Reset Token** and copy the token.
2. Paste the token in the companion settings and press Connect. The server checks it with Discord (`GET /users/@me` must be a bot account), stores it and connects. The token is never returned to any client; the settings only show the bot's name and state.
3. Add the bot to a server you're in, using the invite link the settings show (`scope=bot`, no permissions). Discord only lets you DM a bot you share a server with.
4. Send the bot the 8-character pairing code the settings show, in a direct message. The code lasts an hour, and a new one is generated when it expires. The Discord user who sends it becomes the paired owner.

## Behaviour

- **Who is heard.** Only direct messages from the paired user are answered. Messages in servers, messages from other users and messages from bots are ignored, and so is every message before pairing except the code. One bot can belong to only one companion.
- **Where messages go.** A DM becomes a normal turn in the owner's ongoing chat (`Conversations.ongoingThread`), so the web and Android apps show it too. The reply is sent back when the turn ends. A reply longer than 2,000 characters is split into several messages, and the bot shows "typing" while the companion is working. Mentions are disabled in what the bot sends.
- **Busy chat.** If a reply is already running, for example one started from the web, the bot says so and doesn't queue the message.
- **Files.** Attachments in the owner's DM (at most 8) are downloaded from Discord's CDN (`cdn.discordapp.com` /
  `media.discordapp.net` only, no bot token sent) into the chat file store, the same as app uploads, so the companion
  sees images and can read files. Anything it couldn't fetch is named in a short note and the rest is answered.
  Files the companion sends with `send_file` show in the app only.
- **Channel note.** A Discord turn's prompt (request id `discord-<message id>`) ends with a short note that the message
  came from the owner's Discord DM and that tables don't render there. The stored message is only what the owner wrote.
- **Reminders.** When a reminder or other proactive message is delivered, `Conversations` calls `onSettled` with `proactive: true`, and the bridge sends the text to the paired DM channel.

## Connection

`src/discord.mjs` uses the Discord Gateway v10 over Node's built-in WebSocket, so there is no extra dependency.

- It identifies with the `DIRECT_MESSAGES` intent only. Message content in DMs with the bot doesn't need the privileged Message Content intent.
- It sends heartbeats and reconnects with backoff when the connection drops.
- On fatal close codes (invalid token, 4004/4010–4014) it stops reconnecting and records the problem. The settings then ask the owner to reconnect with a new token.

REST calls go to `https://discord.com/api/v10`, retry once on 429, and time out after 10 s.

## Storage and privacy

The `companion_discord` table stores, per companion:
- the token,
- the bot id, name and application id,
- the pairing code,
- the paired user's id and name,
- the DM channel id.

The token is stored in the service's private SQLite database (mode 600), under the same trust model as the rest of the companion state (docs/RUNTIME.md). Disconnecting deletes the row and closes the gateway connection.
