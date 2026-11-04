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

A delivered Board message reopens an archived sub-conversation, so it shows unread again. So does a silent wake
(#61b, below): it leaves an activity line to read.

## Silent Board wakes: the activity line (#61b)

A Board wake can end `silent`: the companion answered on the Board (or resolved the request, or decided nothing was
needed) and chose not to message the owner. Before #61b that left the sub-conversation empty and never unread. Now:

- In the same transaction that marks the wake `silent`, `BoardInbox.silentWake` adds one **activity line** to the
  sub-conversation (`board_inbox_notes`) and reopens the topic if it was archived. The text is the app's, named after
  what the provider reported doing (tool names only, from the runner's `tool` events; Claude reports them, Codex does
  not):
  - `post_message` → "Claude answered on the Board."
  - `resolve_human_request` → "Claude answered the Board request."
  - another Board write tool → "Claude updated the Board."
  - only reads → "Claude checked this on the Board and had nothing to ask you."
  - no tool names (Codex) → "Claude handled this on the Board."
- Right after, one read-only `get_thread` (view `full`, limit 20) through the app's own Board session
  (`BoardCompanion.ownPost`) looks for the companion's latest post in that Board thread since the wake started (5 s
  clock slack). A post is the companion's when its author is this app's Board agent (`read_inbox` session
  `agent_id`) or the owner's companion profile (`profile_kind: companion`, `companion_for` = the Board owner). If one
  is found the line becomes "answered on the Board" with a quote (one line, control characters removed, at most 200
  characters) and the post's Board link; otherwise it keeps its text and gets the thread's Board link. The general
  Board topic has no Board thread, so no lookup. A failed lookup changes nothing (best effort).
- The updated line reaches clients as a normal `message` event. It is never a `conv_messages` row, so it is never in
  the model's history (recent messages, resumed sessions), never an owner turn, and it never goes through
  `onSettled`: no push, no Discord, no #59 PushHold.
- In the API the line is a message `{id, threadId, role: "app", text, url?, preview?}` in `snapshot` (merged with the
  messages by time) and `events`. `preview` is Board text (untrusted): the web and Android apps show it as plain text
  only, never as Markdown or links; `url` is checked to be absolute http(s) without credentials before it is a link.
- Non-silent Board wakes are unchanged (their message is the conversation's activity, as before).

## Unread

A topic is unread when it has activity the owner has not seen since they last opened it: a companion message after
`read_rowid` (a `conv_messages` rowid, #61) or an activity line after `read_note_seq` (#61b). A row's `unread` is the
number of both (messages plus silent wakes, which each left one line), so a silent wake shows as "1" and never as a
bare dot. Opening (`boardRead`) and Done (`boardArchive`) move both markers to the latest item. Open topics are
ordered by their latest activity: the newest message or activity line, else when the topic was made. A newer activity
line is also the row's preview (sent as `previewRole: "assistant"`, which older clients already accept).

## Replying

A sub-conversation is an ordinary `conv_threads` row: history, files, voice, typing, streaming, cancel and events work
as in the main chat. An owner message there is a normal owner chat turn (owner chat tools, web allowance), and its
prompt gets a short app note naming the ticket number, title (marked untrusted Board text), ticket id and Board
thread. The companion's memory files are shared: one companion, one memory. Replying in an archived topic reopens it.

## API (`POST api/conversation`, same auth, origin and CSRF rules as the other conversation actions)

- `{action: "boardInbox", archived?: boolean}` → `{threads: [{threadId, label, ticketNumber?, general, archived,
  unread, updatedAt, preview?, previewRole?}], unread, any}`. `unread` is the badge: the number of open topics with
  unread activity (#61, #61b: a companion message or an activity line after the read markers; each row's `unread`
  counts both). `any` says whether the owner has any Board conversation (the apps show the tab
  only then). Newest activity first, at most 200.
- `{action: "boardRead", threadId}` → `{threadId, unread}`: marks the topic read up to its latest message and
  activity line.
- `{action: "boardArchive", threadId, archived}` → `{threadId, archived, unread}`: Done (archive, also marks read) or
  Reopen. Only the owner's own topics; anything else is 404.
- `snapshot`/`events`/`submit`/`typing`/`cancel` take a sub-conversation's `threadId` like any thread. The main
  snapshot's thread list and Past chats (`archivedThreads`) never include Board sub-conversations.

## Clients

- **Web and iPhone (the PWA)**: a Board tab (shown once there is a Board conversation) with an unread badge (unread
  conversations, 1-9 then 9+), Open and Archived filters, a row per topic (unread dot and count, label, time, preview,
  and a labelled "Done" / "Reopen" button with a tooltip that says it moves the topic to Archived / back to Open). `#board/<threadId>` opens a
  topic in the chat view with a "‹ Board · #15 · title · Done" bar; Past chats and New chat are hidden there. An open
  topic is marked read when it opens and when a new companion message or activity line arrives. The badge refreshes
  every 30 s. An activity line shows centred and muted: the app text, the Board quote in quotation marks, and an
  "Open on the Board" link (new tab, `noopener`).
- **Android** (0.24.0, versionCode 34): the same Board tab between Chat and Calendar, with the badge on the tab, the
  list, the sub-conversation with its bar, Done/Reopen, and an Open/Archived filter. Every new field is optional, so
  the app works against an older server (the tab stays hidden). Since 0.25.4 (versionCode 39) it shows activity
  lines (role `app`: text, plain-text quote, "Open on the Board") and skips any message role it does not know instead
  of failing the chat. **0.25.3 and older reject role `app`**: a Board topic holding an activity line fails to open
  there until the app is updated (the list, badge and every other chat are unaffected).
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
- `board_inbox_notes(seq PK, id, thread_id, companion_id, wake_id, kind, text, preview, url, since_at, created_at,
  updated_at)` (#61b): activity lines, one per silent Board wake (unique per wake), deleted with their topic.
- `board_inbox_threads.read_note_seq` (#61b, `ALTER TABLE ... ADD COLUMN ... DEFAULT 0`): the activity-line read
  marker.

#61b rollback: an older release knows neither the notes table nor the new column and ignores both: its Board tab
counts messages only and its snapshots never show activity lines (they are not `conv_messages`). The one rough edge:
a client already following a topic's events past an activity line's `message` event would get an error from the older
release for that event page (no such message) until it reloads the chat, which then works.

A sub-conversation's `conv_threads` row is created with `archived_at` set. The new release ignores that stamp for Board
topics (they stay writable); an **older release** that knows nothing of these tables therefore sees them as read-only
**Past chats** titled "#15 · title": never in its open chat list, never chosen as the ongoing chat, and Board messages
already delivered stay readable there. After a rollback, new Board wakes go to the main chat again (old behaviour) and
Discord replies are not routed. Rolling forward again picks the topics up unchanged. Board wakes queued but not yet
run at rollback time still run in their sub-conversation and appear in Past chats.

## Not covered

- Board events that never become a companion wake are not mirrored here; the companion's own posts appear only as
  the quote on a silent wake's activity line.
- Silent Board wakes from before #61b have no activity line (nothing is backfilled).
- The quote is the companion's latest post in the thread since the wake started; if it posted several times, only the
  last is quoted, and a post by the same Board agent from another session in that window would be taken as its own.
- Wakes delivered to the main chat before this release stay there.
