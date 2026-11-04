# Board inbox (#55)

The companion's Board messages (Needs-you requests, @mentions and replies, pings to the owner, reviews) no longer
land in the owner's main chat. They go to a **Board** tab with **one sub-conversation per Board thread or ticket**,
for example "#15 · Fix login". The main chat is for the owner and the companion; if the owner raises a Board topic
there, the companion still handles it there.

## How a Board wake is routed

1. `BoardCompanion` (`src/board-companion.mjs`) turns Board events into scheduler event wakes of kind `board`, as
   before. Before queueing one it records what it is about with `BoardInbox.route(companionId, requestId, topic)`:
   - a mention or owner ping knows its Board thread; the ticket behind it (number, title) comes from one read-only
     `get_thread` (view `full`, limit 1);
   - a Needs-you request knows its ticket (id, number, title from `list_human_requests`); its discussion thread comes
     from one read-only `get_ticket`.
   The lookup is skipped when the topic is already known (an existing sub-conversation or a wake recorded moments
   ago). A failed lookup is logged without content and the wake is grouped by what it carries. After queueing,
   `routed()` stores the scheduler occurrence id.
2. `Conversations.enqueueProactive` sends a `board` wake to `BoardInbox.threadForWake`, which finds the route by the
   wake id (or, if the process stopped between queueing and recording, through the scheduler's `event:<requestId>`
   key) and returns that topic's sub-conversation, created on first use. A topic matches by Board thread, then by
   ticket. A wake with no known thread or ticket goes to one general **Board** sub-conversation, never the main chat.
3. Everything else is unchanged: the wake runs with the same background restrictions (`wakeToolFilter`, kind `board`
   keeps the owner's Board tools), in that sub-conversation's own provider session. Non-Board wakes (reminders,
   calendar, watches, #54 proactive and follow-ups, connector and mail notices) still go to the main chat.

A delivered Board message reopens an archived sub-conversation, so it shows unread again. A silent wake (handled on
the Board without asking the owner) leaves an archived topic archived: there is nothing new to read.

## Replying

A sub-conversation is an ordinary `conv_threads` row: history, files, voice, typing, streaming, cancel and events work
as in the main chat. An owner message there is a normal owner chat turn (owner chat tools, web allowance), and its
prompt gets a short app note naming the ticket number, title (marked untrusted Board text), ticket id and Board
thread. The companion's memory files are shared: one companion, one memory. Replying in an archived topic reopens it.

## API (`POST api/conversation`, same auth, origin and CSRF rules as the other conversation actions)

- `{action: "boardInbox", archived?: boolean}` → `{threads: [{threadId, label, ticketNumber?, general, archived,
  unread, updatedAt, preview?, previewRole?}], unread, any}`. `unread` is the badge: the number of open topics with
  at least one companion message after the owner's read marker (#61; each row's `unread` is that topic's message
  count). `any` says whether the owner has any Board conversation (the apps show the tab
  only then). Newest activity first, at most 200.
- `{action: "boardRead", threadId}` → `{threadId, unread}`: marks the topic read up to its latest message.
- `{action: "boardArchive", threadId, archived}` → `{threadId, archived, unread}`: Done (archive, also marks read) or
  Reopen. Only the owner's own topics; anything else is 404.
- `snapshot`/`events`/`submit`/`typing`/`cancel` take a sub-conversation's `threadId` like any thread. The main
  snapshot's thread list and Past chats (`archivedThreads`) never include Board sub-conversations.

## Clients

- **Web and iPhone (the PWA)**: a Board tab (shown once there is a Board conversation) with an unread badge (unread
  conversations, 1-9 then 9+), Open and Archived filters, a row per topic (unread dot and count, label, time, preview,
  and a labelled "Done" / "Reopen" button with a tooltip that says it moves the topic to Archived / back to Open). `#board/<threadId>` opens a
  topic in the chat view with a "‹ Board · #15 · title · Done" bar; Past chats and New chat are hidden there. An open
  topic is marked read when it opens and when a new companion message arrives. The badge refreshes every 30 s.
- **Android** (0.24.0, versionCode 34): the same Board tab between Chat and Calendar, with the badge on the tab, the
  list, the sub-conversation with its bar, Done/Reopen, and an Open/Archived filter. Every new field is optional, so
  the app works against an older server (the tab stays hidden).
- **Push**: settle events for a Board sub-conversation carry `board`; Android's data-only FCM payload gets
  `board: "1"` and Web Push's encrypted payload `board: true`. No Board text is added to either payload. A tap opens
  that sub-conversation (Android: Board tab; web: `sw.js` navigates to `#board/<threadId>`).

## Discord

A DM cannot hold threads, so the split is done with Discord's reply-to:

- A Board sub-conversation's message (a Board wake, or the answer to a Discord reply in that topic) is sent to the DM
  with a first line `**📋 #15 · title**`. The Discord ids of the messages sent are stored (`board_inbox_discord`, 90
  days).
- When the owner uses Discord's **Reply** on one of those messages, the reply goes to that sub-conversation (with the
  ticket note and the Discord channel note). Any other DM message goes to the main chat, as before.
- Typing in the DM still holds the main chat's waiting reply only.

## Storage and rollback

Additive only; no legacy table changes shape (tested):

- `board_inbox_threads(thread_id PK, companion_id, board_thread_id, ticket_id, ticket_number, title, general,
  archived_at, read_rowid, created_at, updated_at)`: which conversation is which Board topic, Done state and the read
  marker (a `conv_messages` rowid).
- `board_inbox_routes(companion_id, request_id, wake_id, board_thread_id, ticket_id, ticket_number, title,
  created_at)`: what each queued Board wake is about (pruned after 30 days).
- `board_inbox_discord(companion_id, message_id, thread_id, created_at)`: Board DM messages for reply-to routing.

A sub-conversation's `conv_threads` row is created with `archived_at` set. The new release ignores that stamp for Board
topics (they stay writable); an **older release** that knows nothing of these tables therefore sees them as read-only
**Past chats** titled "#15 · title": never in its open chat list, never chosen as the ongoing chat, and Board messages
already delivered stay readable there. After a rollback, new Board wakes go to the main chat again (old behaviour) and
Discord replies are not routed. Rolling forward again picks the topics up unchanged. Board wakes queued but not yet
run at rollback time still run in their sub-conversation and appear in Past chats.

## Not covered

- Board events that never become a companion wake (the companion's own Board posts) are not mirrored here.
- Wakes delivered to the main chat before this release stay there.
