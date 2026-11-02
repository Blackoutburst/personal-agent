# Reminders and proactive messages

Account mode starts the scheduler in the existing web service after its loopback listener is ready. A configured, provisioned owner with a companion profile can ask for a reminder, close every client, and receive the companion's assistant message in the same ongoing chat on the next open. No extra daemon or privileged installation is introduced. Push delivery belongs to task #22; the existing private conversation event stream remains the integration point.

The companion receives three owner-bound app tools: `create_schedule`, `list_schedules` and `cancel_schedule`. Creation requires a stable request ID, reminder text and an ISO timestamp with an explicit offset or Z. Listing supplies current time and the profile's IANA timezone so relative requests can be resolved correctly. This increment schedules one-time UTC instants; it does not add a cron language or promise daily wall-clock recurrence across DST. Future watch/Board event code can call the trusted `enqueueEvent` service with an owner and stable private event key. It never uses this worker's Board connection or raw Board-write tools.

The web chat's Upcoming disclosure shows all active reminders and lets the owner cancel them. Quiet hours are editable there. Periodic check-ins require the owner's opt-in, are off by default and run no more often than once every six hours. Quiet hours default to 22:00–08:00 in the profile timezone; equal start/end disables quiet hours. All wake turns, including silent ones, count against durable five-minute spacing and a 24-turn local-day cap. Preference changes and cancellation apply before another model start and before message publication. A model cannot enable check-ins or change quiet hours through its reminder tools.

`SchedulerStore` retains private jobs, request fingerprints, generation fences, occurrence IDs, local-day counters and provider cooldowns when supplied. A due job's occurrence is inserted transactionally with any recurring-cursor advance. Exact create/event retries reuse the retained identity; conflicting payloads refuse. Missed reminders catch up once within 24 hours, otherwise remain visibly missed. Periodic slots coalesce into at most one eligible wake instead of replaying a backlog. Snapshots include every active reminder and ten recent inactive items; older durable records are retained for idempotency. Creation also returns its canonical `created` receipt even when an old replay is outside the visible history.

`Conversations.enqueueProactive` is an internal typed entry. It stores its trigger privately, creates or reuses the owner's canonical ongoing thread, and queues alongside normal chat turns. It never inserts a synthetic user message. A synchronous policy check and queued→running CAS occur in the same SQLite write transaction before handoff. Deltas are buffered privately. After the same native feeling-tag split used by ordinary replies, the final envelope must be exactly `{"action":"message","text":"…"}` or `{"action":"silent"}`. An incomplete tag or malformed envelope fails closed. Only validated message text and optional valid feeling metadata become an assistant row; silence, malformed output and control JSON never stream into chat. Final message/quiet state commits atomically. If quiet time begins during the turn, its completed text and feeling wait privately for delivery, including across restart, without another model call. The additive message/wake migrations retain existing history and use explicit insert column lists.

Cancellation persists the schedule/generation fence first, then aborts any known active conversation wake. A late result cannot publish after cancellation. It cannot undo a tool effect already handed off or erase a message already delivered. On restart, queued admissions resume with the same occurrence identity; running/handoff occurrences become interrupted and are never automatically sent to the provider again. A crash between recording handoff and actually starting the provider can miss one reminder. Without provider idempotency, the application cannot guarantee both no missed executions and no duplicate executions. It chooses at most one attempt and preserves the interrupted state for the owner. Overlapping active service instances on the same data directory remain unsupported; CAS still prevents the same turn or occurrence from starting twice, and recovery runs only after the configured listener binds successfully.

The provider's MCP child is a finite stdio adapter. It receives an ephemeral per-owner token and a fixed loopback broker URL from the application constructor. Browser requests revalidate the platform session and same origin; tool requests use their own owner token and never accept an owner, session, path or URL selector. The broker allows only create/list/cancel; settings remain on the authenticated browser path. The scheduler child receives its token through its environment, but the accepted provider adapters serialize that environment map in CLI configuration arguments. Tokens can therefore appear in the provider process arguments; this uses the existing trusted shared-host model and does not claim OS-level owner isolation. Tokens are invalid after application restart. Each JSON-RPC frame and HTTP request is bounded; bounded snapshots fit the 512 KiB response envelope. The bridge follows the MCP 2025-11-25 [stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

The scheduler reuses the accepted task #27 app-MCP callback and owner tool-policy inheritance on current appearance/outfit main85ebbc0. It preserves native workspace instructions, the ordinary streamed feeling path, the current character/outfit UI and profile-triggered session resets. Neither original #27 handoff nor source #50 is rewritten. This PC performs synthetic validation only. Real provider smoke, source integration, publication and deployment remain with Claude · Server; no subscription was used or production service activated during development.

## Optional daily digests and weekly check-ins

Upcoming keeps the existing six-hour check-in option and adds two independent
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
