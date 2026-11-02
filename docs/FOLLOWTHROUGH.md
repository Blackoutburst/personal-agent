# Following Board work in the companion chat

The companion can check the owner's Board work when asked in the current chat.
If the owner has already enabled periodic check-ins, it can also use those
existing private wakes to read relevant updates. This increment adds no host
poller, Board event subscription, tool grant or automatic opt-in.

Existing periodic check-ins are off by default and run no more often than once
every six hours. Quiet hours, spacing, daily caps, provider availability and
restart coalescing can delay or skip a check. They are not continuous monitoring
or a promise to notice every change immediately. See [SCHEDULER.md](SCHEDULER.md).
A background wake is not a new owner message or approval for a public write.
For background wakes, the application narrows its configured Board MCP tools
to the existing eight read names listed below. Board write names are excluded
from that forwarded policy, including for an approved retry.
Prepare any proposal privately and wait for the owner's clear Yes on the next
normal chat turn. Normal turns retain the owner's exact configured tool policy.

## Keep a private follow-up note

Use the companion's own native workspace files, within its configured file-tool
permissions. Keep a short note of tracked project/ticket/thread IDs, their actual
links, last observed versions, status/resolution and assignee, plus unresolved
request IDs and pending messages. Keep it private; it records what to recheck,
not authority to act. Do not copy personal conversation, memories, credentials
or pairing data into Board content or source control.

Match the note and its inbox cursor to the exact owner, paired device, selected
profile and registered session. Use only that owner's configured bridge. Never
borrow the development worker's connection or another owner's identity. If the
session/profile is unknown or changed, a cursor is refused, or permissions are
unavailable, stop that check and ask the owner for setup help. Do not switch
profiles, refresh permissions or reuse another session to bypass the refusal.

For incremental inbox checks, use compact `read_inbox`. Save the delivered page,
pending message IDs and returned cursor successfully before presenting that
cursor in a later call: presenting it acknowledges the previous page. Record
what was handled and finish any saved pending page after an interruption.
Deduplicate replayed messages by their canonical IDs. A cursorless compact
retry can replay an unacknowledged page; `view=full` inbox delivery advances
optimistically and does not provide that replay behavior. If file tools cannot
save the note reliably, do not advance the cursor or claim durable tracking.

These notes and ordering rules are instructions to the model, not a new
transactional tracking service. The application does not validate note contents
or guarantee that a model persisted every page. Board enforces its existing
cursor, authentication and permission checks.

## Recheck current sources

The default Board read tools are exactly `get_work`, `list_projects`,
`list_tickets`, `get_ticket`, `get_text`, `get_thread`, `list_human_requests` and
`read_inbox`. They support this follow-up practice without expanding defaults.
An owner may separately configure the existing exact read names `list_activity`,
`get_project` or `get_message` for normal turns when useful; none is enabled
automatically here. Background wakes stay within the existing eight-name
`READ_ONLY_BOARD_TOOLS` list, so these optional names are not available there.
See [RUNTIME.md](RUNTIME.md) for owner configuration and manual pairing.

These use Board's existing endpoint semantics: inbox reads record presence and
delivery state, and `get_work` can run built-in block reevaluation or review
reminders. The wake guard narrows the application's Board tool selection; it
does not change those Board endpoint semantics. It preserves configured native,
other application and scheduler tools, and any explicit narrower selection.
It is not global CLI, native-shell or inherited Codex MCP isolation. Normal-turn
confirmation remains an instruction to the model, not a new backend consent gate.

`read_inbox` delivers addressed messages, not every ticket change. Use `get_work`
for discovery, then reread each tracked ticket by its canonical ID even when it
has disappeared from the current work lists. Read its current version, scope,
status/resolution, assignee and thread. Follow pagination with the same filters;
use `next_before` for older thread messages. Compact previews are not canonical
prose: retrieve the referenced `get_text` chunks with their supplied SHA256, or
use the permitted full ticket/thread read. A failed or incomplete read is unknown
state, not evidence that work finished or was deleted.

Current Board edits take precedence over the old note or an earlier plan. Respect
changed requirements and assignments, archived projects, and closed work,
including `superseded` and `wont_do` resolutions. Do not reopen, reassign or
recreate work to restore a remembered plan. Record the observed change and ask
the owner when its intended next step is unclear.

Correlate Needs-you items by request ID, ticket ID, addressed owner and current
status. Read resolved answers with `include_resolved=true` when needed; a private
chat answer or thread reply alone does not prove that Board resolved the request.
For reviews, connect the current ticket and review author to its actual outcome,
evidence and discussion. Distinguish a worker's reported result from independent
verification; do not claim tests ran merely because a message says they passed.

## Notify privately; confirm public writes

Tell the owner about a meaningful change, decision or question in their private
chat, with the actual ticket link. Remain quiet when nothing useful changed.
State uncertainty and the source of a reported result plainly.

Every public write the companion requests still follows task #12's current-chat rule: restate
exactly what will be published and where, and wait for the owner's clear Yes.
Follow-up notes, memory, Board requests and background wakes do not grant that
approval. Use only configured write tools, keep private material out, and retain
the same idempotency key and exact payload for an approved lost-response retry.
Stop retries if approval is withdrawn. A background wake must leave all Board
writes, including retries, for a normal owner-confirmed turn. Report only
confirmed links or receipts.

Synthetic instruction-upgrade and provider-forwarding tests do not prove real
model compliance with these practices. Real Claude/Codex and paired-bridge checks
remain with the reviewer; this documentation claims no new real-model test.
