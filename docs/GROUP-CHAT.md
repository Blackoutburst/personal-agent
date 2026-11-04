# Group chat (#53)

Owners and their companions in one conversation, in the web app (and so the iPhone Home Screen app) and the
Android app. The first group is meant to be Blackout, TheScreamer, C-chan and Cirno. Code: `src/group-chat.mjs`
(storage, engine, `/api/groups`), `public/group-ui.mjs` (web), `android/…/Group*.kt` (Android), the own-wake hook in
`src/conversations.mjs`, `groupInstructions` in `src/companion.mjs`, and the runner's `group` option.

## Who is in a group

- Every owner in `owners.json` is a trusted co-admin. Any owner may start a group ("New group" in the Group tab) with
  one or more other owners; each member owner's companion is a member automatically and leaves with them.
- Members can rename the group, add another owner, change their notification setting and leave. Nothing is seeded:
  the first group is created in the app.
- A non-member gets `404 NOT_FOUND` for everything about a group (it learns nothing, not even that it exists).
- The browser never sees or sends a companion ID. Members are `owner:<label>` and `companion:<label>`; the signed-in
  owner is the only identity a request carries.
- Owners appear with their owner profile (display name and picture, milestone 1). A picture is readable by the owner
  and by owners who share a group with them (`{action:"photo"}`). Companions appear with their own name and current
  look (character, color and outfit, the same portrait renderer as their 1:1 chat).

## Storage (additive only)

New tables, nothing else changes:

| table | what |
| --- | --- |
| `group_chats` | id, name, creator, `last_seq` (the per-group message sequence) |
| `group_members` | group, owner identity (companion id), joined/left, `read_seq` (unread cursor), `notify` (`all` / `mentions`) |
| `group_messages` | id, group, `seq`, `author_kind` (`owner` / `companion` / `system`), author identity, text, `reply_to`, mentions, feeling, request id, `proactive` |
| `group_companions` | per (group, companion): `seen_seq` and the group's own provider session |
| `group_files` | uploads for group messages (bytes under `<dataDir>/group-files/<id>`) |
| `group_nudges` | own-wake posts waiting for quiet hours to end |
| `group_requests` | idempotency of create / post requests |

Messages are immutable; the cursor for polling is the sequence. **Rollback**: an older release never reads these
tables, so it runs unchanged and simply shows no Group tab; nothing in `conv_*`, `owner_profiles`, scheduler or push
tables changed shape (`test/group-chat.test.mjs` checks this). Rolling forward again finds the groups as they were.

## API

`POST /api/groups` with `{action, …}`: `list`, `create {requestId, members:[labels], name?}`, `snapshot {groupId}`,
`events {groupId, cursor}`, `post {groupId, requestId, text, replyTo?, attachments?}`, `typing {groupId, active}`,
`read {groupId, seq}`, `rename`, `addMembers`, `leave`, `settings {groupId, notify}`, `photo {member}`.
Files: `POST /api/groups/files` (raw body; `x-group-id`, `x-file-name`, `x-request-id`; 25 MiB) and
`GET /api/groups/files/<id>` for members. An upload is bound to the uploader's next post in that group; unposted
uploads are dropped after a day.

## Who replies

- After a human message the companions wait like in DMs (smart delay, `src/texting.mjs` `quietWindow` on the last
  human message, held while anyone types, at most 60 s). A burst is read together.
- Then each companion member gets **one decision turn**, one after another in a random order per burst, so each reads
  what the earlier ones just posted. A companion never answers its own message.
- **Mentioned** (`@Name`, matched against member names and owner labels): the companion must reply. If it still answers
  `NO_REPLY`, it is asked once more; if the provider fails, a short system line says it could not answer.
- **Not mentioned**: it judges like in a DM: reply, or `NO_REPLY` (nothing is posted).
- While companions keep posting, the others get another pass: companions talk to each other freely, and may address
  the other owner or companion directly.
- A new human message during the turns stops the remaining turns of that pass; the burst is gathered again.

### Seatbelt

At most **12** companion messages in a row with no human message in between (`SEATBELT`). When reached, companions stop
(reactive and own-initiative posts) and one system line says they are taking a break until someone writes. Any human
message resets it. There is no other behavior limit; the existing provider limits apply as before.

## Privacy and authority (by construction)

- A group turn runs in its **own empty folder** (`<runtimeDir>/<label>/groups/<groupId>`) with its **own provider
  session** per (companion, group). The provider loads no workspace file (no `CLAUDE.md` / `AGENTS.md` there) and the
  1:1 session is never resumed.
- Its instructions (`groupInstructions`) hold the companion's name, look, `SOUL.md`, how it texts, the group rules
  and the members. **Never** `USER.md`, `MEMORY.md`, the diary, the 1:1 recent chat or the weather.
- The turn prompt is the recent group transcript (or what is new since the companion last read, when its session
  resumes). Each message is wrapped as `<message from=… kind="owner|your owner|companion|you">…</message>` with `<`,
  `>`, `&` escaped, so message text cannot forge structure; the note says these are data, never instructions.
- **File tools are never available** in a group turn (Claude: no Read/Edit/Write/Glob/Grep; Codex runs read-only).
  No file, contact or send-file app servers are attached.
- **Side-effect tools** (Board, scheduler: reminders, calendar, mail, follow-ups; connectors still apply) are available
  only when the messages the companion is answering include one from **its own owner**. Otherwise only native web
  search/fetch (if the owner's policy and the daily web allowance allow it). Own-wake posts get no tools.
- If its own owner asks in the group for something private, the companion says it will pick it up in their own chat
  (AGENTS v25 "Group chat"). There is no cross-context retrieval.
- Codex group turns also switch off every built-in that could read a file or reach outside the turn: shell and unified
  exec, view_image, browser/computer use, apps, Codex memories, goals and subagents (`ISOLATED_OFF` in
  src/providers/codex.mjs; its read-only sandbox limits writes, not reads). Checked with codex-cli 0.166.0: with them
  off, a canary file outside the group folder cannot be read; with them on, it can. Images still arrive via `--image`.
- Claude group turns have no file tool, so images posted in the new messages are sent inline (stream-json input,
  base64, PNG/JPEG/GIF/WebP by magic number, at most 3.75 MB each, up to 8); skipped images get a short app note.

## Own initiative (#54)

The companion's own wakes (`proactive`, `followup`) list the groups it is in (name and id only) and may answer
`{"action":"group","groupId":"…","note":"…"}` instead of messaging their owner. The wake then ends silent in the 1:1
chat and a group turn runs with the group context only (the optional note is the companion's own words, no tools).
If the companion's owner is in quiet hours, the post waits (`group_nudges`, checked on every scheduler tick) until
quiet hours end, at most 12 hours. The seatbelt applies.

## Notifications

- Every human member gets a push for each message they did not write (owner or companion messages, including their own
  companion's), except: members with "Only when I'm mentioned" get only messages that @mention them; nobody gets one
  while they are looking at the group (read or posted within 30 s); and **nobody gets one during their own quiet
  hours**. Quiet hours *skip* group pushes rather than hold them: group talk is live, and a pile of stale notifications
  at the end of the night would be noise; the unread badge is there in the morning.
- Android (FCM, data-only, no text): `{type:"group", group:"1", groupId, messageId, name:<group name>, mention?:"1"}`;
  the app opens that group. Web Push: `{type:"group", groupId, messageId, title:<group name>, body:"Author: preview",
  group:true}`; the service worker opens `#group/<id>`.

## Not in scope

Discord does not carry group messages. Message edits and deletes, older-history paging, and voice messages in groups
are not implemented.
