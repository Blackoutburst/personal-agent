# Reminders and proactive messages

Account mode starts the scheduler in the existing web service after its loopback listener is ready. A configured, provisioned owner with a companion profile can ask for a reminder, close every client, and receive the companion's assistant message in the same ongoing chat on the next open. No extra daemon or privileged installation is introduced. Push delivery belongs to task #22; the existing private conversation event stream remains the integration point.

The reminder interface has three owner-bound app tools: `create_schedule`, `list_schedules` and `cancel_schedule`. The separate release-watch interface below adds `create_release_watch` and `update_release_watch`. Reminder creation requires a stable request ID, reminder text and an ISO timestamp with an explicit offset or Z. Listing supplies current time and the profile's IANA timezone so relative requests can be resolved correctly. This increment schedules one-time UTC instants; it does not add a cron language or promise daily wall-clock recurrence across DST. Future watch/Board event code can call the trusted `enqueueEvent` service with an owner and stable private event key. It never uses this worker's Board connection or raw Board-write tools.

The Watches tab (web and Android, #41) shows all active reminders and lets the owner cancel them. Quiet hours, check-ins and the routines are edited in Me › Settings. Periodic check-ins require the owner's opt-in, are off by default and run no more often than once every six hours. Quiet hours default to 22:00–08:00 in the profile timezone; equal start/end disables quiet hours. Ordinary reminder/routine/generic wake turns, including silent ones, count against durable five-minute spacing and a 24-turn local-day cap; the bounded release-watch check cadence is described below. Preference changes and cancellation apply before another model start and before message publication. A model cannot enable check-ins or change quiet hours through its reminder tools.

`SchedulerStore` retains private jobs, request fingerprints, generation fences, occurrence IDs, local-day counters and provider cooldowns when supplied. A due job's occurrence is inserted transactionally with any recurring-cursor advance. Exact create/event retries reuse the retained identity; conflicting payloads refuse. Missed reminders catch up once within 24 hours, otherwise remain visibly missed. Periodic slots coalesce into at most one eligible wake instead of replaying a backlog. Snapshots include every active reminder and ten recent inactive items; older durable records are retained for idempotency. Creation also returns its canonical `created` receipt even when an old replay is outside the visible history.

`Conversations.enqueueProactive` is an internal typed entry. It stores its trigger privately, creates or reuses the owner's canonical ongoing thread, and queues alongside normal chat turns. It never inserts a synthetic user message. A synchronous policy check and queued→running CAS occur in the same SQLite write transaction before handoff. Deltas are buffered privately. After the same native feeling-tag split used by ordinary replies, the final envelope must be exactly `{"action":"message","text":"…"}` or `{"action":"silent"}`. An incomplete tag or malformed envelope fails closed. Only validated message text and optional valid feeling metadata become an assistant row; silence, malformed output and control JSON never stream into chat. Final message/quiet state commits atomically. If quiet time begins during the turn, its completed text and feeling wait privately for delivery, including across restart, without another model call. The additive message/wake migrations retain existing history and use explicit insert column lists.

Cancellation persists the schedule/generation fence first, then aborts any known active conversation wake. A late result cannot publish after cancellation. It cannot undo a tool effect already handed off or erase a message already delivered. On restart, queued admissions resume with the same occurrence identity; running/handoff occurrences become interrupted and are never automatically sent to the provider again. A crash between recording handoff and actually starting the provider can miss one reminder. Without provider idempotency, the application cannot guarantee both no missed executions and no duplicate executions. It chooses at most one attempt and preserves the interrupted state for the owner. Overlapping active service instances on the same data directory remain unsupported; CAS still prevents the same turn or occurrence from starting twice, and recovery runs only after the configured listener binds successfully.

The provider's MCP child is a finite stdio adapter. It receives an ephemeral per-owner token and a fixed loopback broker URL from the application constructor. Browser requests revalidate the platform session and same origin; tool requests use their own owner token and never accept an owner, session, path or URL selector. The broker permits only the finite reminder and release-watch operations documented here; settings remain on the authenticated browser path. The scheduler child receives its token through its environment, but the accepted provider adapters serialize that environment map in CLI configuration arguments. Tokens can therefore appear in the provider process arguments; this uses the existing trusted shared-host model and does not claim OS-level owner isolation. Tokens are invalid after application restart. Each JSON-RPC frame and HTTP request is bounded; bounded snapshots fit the 512 KiB response envelope. The bridge follows the MCP 2025-11-25 [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The scheduler reuses the accepted task #27 app-MCP callback and owner tool-policy inheritance on current appearance/outfit main85ebbc0. It preserves native workspace instructions, the ordinary streamed feeling path, the current character/outfit UI and profile-triggered session resets. Neither original #27 handoff nor source #50 is rewritten. This PC performs synthetic validation only. Real provider smoke, source integration, publication and deployment remain with Claude · Server; no subscription was used or production service activated during development.

## Optional daily digests and weekly check-ins

Me › Settings keeps the existing six-hour check-in option and adds two independent
owner-controlled routines: a daily digest (off by default, 09:00 local) and a
weekly check-in (off by default, Monday 09:00 local). Each has an editable local
time; the weekly option also has an editable weekday. The profile's IANA timezone
is authoritative. These are earliest delivery times: quiet hours, spacing,
daily caps, provider availability and cooldown can defer delivery. Preferences
belong to the authenticated browser owner; model tools cannot enable or change
them. They do not start a Board poller, send email or browser push, or revive a
structured goals/permission-card store.

The account API adds optional `settings.dailyDigest` (`enabled`, `localTime`) and
`settings.weeklyCheckin` (`enabled`, `localTime`, `weekday`) groups. Weekdays are
ISO 1=Monday through 7=Sunday. Browser `configure.input` accepts partial groups:
omitted groups and members preserve their stored values. An unchanged older UI
can still save its three legacy preferences without resetting routines. A new UI
hides unsupported groups and omits their drafts when an older server does not
return the complete capability. It does not replay uncertain saves automatically.

Schedules use local calendar periods rather than 24-hour or seven-day UTC
increments. A nonexistent wall time moves to the first valid local minute after
the gap; an ambiguous repeated time uses its earlier occurrence. Admission is
limited to one attempt per routine/local period, even after edits, off/on,
timezone changes or restart. A weekly period starts Monday, independently of the
selected delivery weekday. Enabling or editing never requests a historical
backfill. After downtime the service coalesces to the latest due period; newer
periods supersede older pending routine output rather than replaying a backlog.

Generation, timezone and cancellation state are checked again before a model
starts and before private text is delivered. Edits, disabling and supersession
cancel the matching active/deferred conversation wakes; already delivered
messages and tool effects cannot be undone. An interrupted or uncertain attempt
is retained rather than automatically rerun for that period. Prompts ask for a
brief private digest or check-in from current context and silence when there is
nothing useful. A neglected goal may be mentioned only when its dates are
actually known; this is not a backend seven-day milestone tracker. Task #13's
background Board tool guard remains in force.

### Additive storage and rollback

`scheduler_routine_preferences` and `scheduler_routine_occurrences` are separate,
identity-bound tables. The four legacy scheduler table shapes, positional
writers, reminders, six-hour cursors, counters and receipts stay intact. New
routine UUIDs are mapped to the existing private `watch` kind only in the new
store/service view; they are never inserted into the legacy occurrence table.

This separation also makes rollback to the accepted pre-routine scheduler safe:
older code ignores the new tables and cannot admit or publish their IDs. Routine
work pauses while legacy reminders and old-client preference saves continue.
Keep the new tables and history for a later upgrade; do not delete or rewrite
private data to roll source back. The existing one-active-service deployment
rule still applies: stop/join the current service and native turns before a
different version opens the same data directory. No overlapping server rollout
is introduced by this feature.

The compatibility fixture `test/fixtures/scheduler-v1.mjs.txt` is the unchanged
scheduler from `8981aa6` (SHA256
`43e38ca38fe0c1f81a247f8a735c9685befda415f0e94b6d60300c848daf908b`).
Migration tests execute that old reader/writer on synthetic shared data, verify
old owner/reminder paths and invisible routine IDs, and reopen with the new code.
No real account, provider, private database or live migration is part of those
tests. Deployment and real provider/bridge checks remain with Claude.


## Owner-confirmed release watches (#15)

The companion confirms a short condition in the current owner chat (for example, “Qwen4 is officially released by Alibaba/Qwen”), then calls `create_release_watch(requestId, condition)`. These are distinct `release_watch` occurrences, never the generic `watch` provenance used by daily/weekly routines. `list_schedules` includes current watch definitions, times, result, source URLs and one-line evidence. `update_release_watch` accepts a stable request ID, watch ID, current expectedVersion and edit/pause/resume/cancel operation. Include a condition only for edit. Exact retries replay the same logical request without restoring an old definition; conflicts require inspecting current state and a new owner decision, never an automatic rebase.

There are ten saved nonterminal watch slots per companion; pausing keeps a slot and cancellation frees it. Snapshots show these definitions and the ten most recent terminal watches. Creation is chat-only; the Watches tab (web and Android) lists each watch with its state, next and last check, the latest result with its source links and, for topic watches, recent digests, and offers edit (condition, and the interval for topic watches), pause/resume and confirmed cancellation. The browser cannot create a watch through its schedules route.

A new or resumed/edited active watch checks immediately. Later checks are six hours apart, with one latest catch-up after downtime rather than replaying intervals. Checks share the owner's serialized native lane, use a fresh provider session, and do not alter normal chat session mappings. The dedicated check temporarily forwards only native WebSearch/WebFetch (Codex native live web search), no Board or app MCP tools. Ordinary configured tools are unchanged. Generic reminder/daily/weekly/heartbeat wakes cannot create or update release watches. Codex checks request read-only sandboxing. Provider intrinsic tools, native home and inherited CLI configuration remain provider-owned; this is no universal isolation or model-compliance guarantee. Operators must qualify the actual installed CLI behavior. No application HTTP fetcher, source adapter, GoalStore or new permission-card framework is added.

Checks may run during quiet hours; owner-facing delivery waits. Global scheduler disablement and provider cooldown still apply. The ordinary reminder/routine five-minute spacing and 24-turn daily allowance remain unchanged; release checks use their own bounded ten-watch/six-hour cadence (up to forty scheduled checks daily, plus explicit owner edits/resumes), avoiding starvation of either kind.

The check returns strict `found` with at least one HTTP(S) source URL, one-line evidence and an owner-facing linked message; `not_yet`; or `stale` when tools are missing, output is malformed, or the provider cannot check. This is agent evaluation, not deterministic verification or a no-false-match guarantee. Not-yet stays silent. Three consecutive stale checks produce one notice, delivered after quiet hours; further failures in that streak stay silent. A non-stale check resets the streak. Results are stored with the actual check time, even when no notification is sent. Interrupted attempts are recorded stale without repeating a provider handoff; reconciliation can deliver a due stale notice without another native call.

Found evidence and the buffered message survive quiet periods and restarts. One-shot completion commits in the same SQLite transaction as the single assistant message. Current owner identity, watch generation/state and global/quiet gates are checked before publication. Edits, pauses and cancellations durably fence pending/running/deferred results and cancel their conversation wakes; a late callback cannot publish old evidence. Owner-stopped/deleted pending delivery schedules the next regular check rather than leaving an active watch stranded. Normal delivery also reaches only that owner's already-linked Discord DM through the existing proactive bridge. Nothing is posted to the Board; no actual watch or Discord link is activated by a source handoff.

## Recurring topic watches (#40)

A topic watch follows a subject over time (a stock, a model family…) instead of waiting for one release. After the owner confirms the topic and frequency, the companion calls `create_topic_watch(requestId, topic, intervalHours)`. The interval is 6 to 168 hours; the instructions suggest 24. Topic watches are rows of the same store, with `mode='topic'`, `interval_hours` and a `history` of reported digests (the last 12). They share the ten watch slots, fences, quiet-hour buffering, stale-streak notice and restart recovery described above. `list_schedules` shows them as `kind: 'topic_watch'` with `intervalHours` and the five newest `digests` (`at`, `evidence`, `urls`).

Each check runs at the watch's own interval and is given the earlier digests. `found` means genuinely new information and carries a short digest with sources; `not_yet` means nothing new and stays silent. A found whose source URLs were all reported before is recorded as `not_yet` without a message, a deterministic guard on top of the model's judgement. Delivery appends the digest to the history and keeps the watch active; it never completes. `update_release_watch` pauses, resumes or cancels it, and its `edit` takes a new topic and/or `intervalHours`. A new topic clears the history; an interval-only edit keeps it. Release watches refuse `intervalHours`.

Additive migration: `scheduler_release_watches` gains `mode` (default `release`), `interval_hours` (default 6) and `history` (default `[]`), so existing release watches are unchanged. Older code would treat a topic row as a one-shot release watch, so a rollback past this change should pause topic watches first.

### Additive rollout and rollback

Claude/operator backs up the private database before deployment. This adds `scheduler_release_watches`, `scheduler_release_occurrences`, `scheduler_release_receipts`, and nullable `conv_wakes.release_result_json`; bootstrap user_version and all legacy row shapes, routine preferences and reminders remain intact. Publish the matching web modules and scheduler broker together. AGENTS version8 is refreshed through the existing native-file-preserving, session-reset-before-instructions path; USER/MEMORY/SOUL/diary bytes are not replaced. No nginx or archived bootstrap-installer update is required; `/internal/scheduler` remains loopback-only and unproxied.

Old scheduler code ignores the new tables and does not admit their release occurrences; old web code ignores the additive watch list. Rollback therefore suspends watches, without deleting private definitions, evidence or receipts. Preserve the additive tables/column and compatible conversation readers; never silently contract/drop them or reinterpret release checks as legacy routines. Restore forward code to resume queued work, record already-running interrupted attempts stale, and publish buffered notices exactly once. Real CLI/native-web and owner's linked Discord qualification and deployment remain with the server reviewer; local tests use synthetic accounts/providers only.

## Proactive wakes (#54)

The companion also wakes on its own, so it can speak first without an owner reminder, calendar event, watch, Board
ping or mail. Two kinds share the ordinary wake path and its strict `{"action":"message","text":…}` /
`{"action":"silent"}` envelope:

- `proactive`: the companion's own wakes. Owner setting `settings.proactive` = `{ enabled, perDay }`, `perDay` one of
  2, 4, 6 or 8 (Me › Settings: "Proactive companion" with Rarely/Sometimes/Often/A lot). Owners who never chose are on
  at four a day. The next wake is `now + (24 h / perDay) × factor`, with a uniform random factor in [0.5, 1.5), so the
  times vary from day to day. After downtime there is at most one pending own wake (no backlog replay) and the next one
  is drawn from the moment it was noticed. Any change of the setting bumps a generation, cancels queued/admitted own
  wakes (including a message still held for quiet hours) and draws a fresh next wake. The private prompt says nobody
  asked, gives the owner's local date/time and whether quiet hours are on, and asks the companion to review memory,
  calendar, reminders/follow-ups, ongoing things and recent chat, then message only when genuinely worth it, do quiet
  work (notes, `schedule_followup`) or stay silent. Silence is a normal outcome and publishes nothing.
- `followup`: a follow-up the companion scheduled for itself with the scheduler tool `schedule_followup(requestId, at,
  note)` (ISO time with offset/Z, in the future and at most 60 days ahead, note at most 500 characters, at most 20
  active per companion). An exact retry returns the same follow-up; a changed payload under the same requestId is a
  conflict. `cancel_followup(id)` cancels one; `list_schedules` returns active ones as `followups`. The owner sees
  them read-only in Watches (web and Android) and can cancel them (`cancelFollowup` on the browser path); only the
  companion can create them. At its time it becomes one `followup` wake carrying the note and the same
  message/quiet/silent choice; any attempt completes it. Like reminders, one catch-up within 24 hours, otherwise it is
  marked missed. While own wakes are switched off, follow-ups stay saved but do not run.

Both kinds may start during quiet hours (quiet work); delivery of their message uses the existing deferral: the
completed text waits privately in `waiting_delivery` until quiet hours end, and no push/Discord notification is sent
before then. The five-minute spacing, the 24-turn local-day cap, provider cooldown and the global scheduler switch apply
to them like other ordinary wakes. Their wakes keep the Board read-only tool set and never get web tools or `mail_send`;
the ask-first rules for Board writes, mail and spending are unchanged (AGENTS version 23 says so explicitly).
`configure` accepts a partial `proactive` group; older clients that omit it keep the stored values, and an older server
that does not return the group hides the web/Android controls.

Not in scope: after group chat (#53) lands, an own wake might also talk to the other companion. Today own wakes have no
peer/contact tools.

### Additive storage and rollback

New tables only: `scheduler_proactive_settings` (per owner: enabled, per_day, generation, next_at),
`scheduler_followups` (request receipts and state) and `scheduler_proactive_occurrences` (their own occurrence rows with
cancel flags, like routines). Own wakes are never written to the legacy `scheduler_occurrences` table: older scheduler
code admits any unknown kind there as a generic wake, so keeping them out means older code ignores them entirely. The
legacy table shapes, positional writers and the v1 fixture are unchanged. `conv_wakes` stores the new kind strings in its
existing `kind` column. On rollback, own wakes and follow-ups simply stop; a message still held for quiet hours stays
undelivered (older code cannot find its occurrence) until forward code returns. Keep the tables; do not delete them.

