# Studio "Ops" app (#75)

A read-only Studio app where Blackout watches C-chan's agents (#71 sandbox, #72 runner). Web: `#studio/ops` (tile "Ops",
French labels). Android: the "Ops" tab (English), which replaces the Board tab button. Read-only: no action can launch,
stop or change anything from here.

## What it shows

| Section | Source |
| --- | --- |
| Agents: name, role (the name's first word), model, ticket, state, turns, heartbeat age | the runner's run list (`agentRow`) |
| Pipeline: todo / in progress / review / blocked / done, per ticket | read-only `list_tickets` of the runner's configured Board projects (`OpsBoard`, cached 15 s). `null` (shown as "Board unreachable") when the read fails |
| C-chan's decisions: launched, escalated, returned, results, review, accepted, blocked | derived from the runner's event log (below) |
| Usage: runs, turns and run time per model, last 24 h and 7 days, plan-limit stops | the runner's run list |
| Per-ticket Board messages | click a ticket: read-only `get_ticket` then `get_thread` for a ticket of an allowed project |

**Decision log is derived, not authored.** Nothing records C-chan's reasoning ("because..."). The log reads what the
runner observed: a launch on a stronger model than the ticket's previous run is an *escalation*, a later launch on the same
ticket is a *return*, `board.done` is *accepted*. Reasons stay in the Board thread (per-ticket history). If C-chan should
log explicit reasons, that needs a write path (a tool) and is a follow-up.

**Usage is what the runner can measure.** The Max plan reports no token counts, so it shows turns and run time per model
and how often the plan limit stopped a run.

## Path

`runner-service` `GET /ops` and `GET /tickets/<id>/messages` (Unix socket, `src/agent-ops.mjs`) → `POST /api/studio`
`{ action: "ops" }` / `{ action: "opsMessages", ticketId }` (`createStudioHttp`, option `ops`, only when the agent runner
is configured) → web `public/ops-ui.mjs` / Android `OpsViews.kt`. Allowed for every Studio member (same rule as the
calendar). `access` reports `apps.ops`. Board text (titles, messages) is shown as plain text only and never followed.

## Refresh

Both clients reload every 10 seconds while Ops is open (the web stops when the app or the Studio tab is left) and have a
Refresh button ("Actualiser").

## Board tab removed

The web nav link and the Board list view are gone (`#board` now lands in the chat; "Done" in a Board sub-conversation
returns to the chat). On Android the Board tab button is gone; notification links still open a Board sub-conversation in
the chat. Board messages to Blackout (Needs-you, mentions) are meant to arrive in the main chat as the batched escalation
message (#74); until #74 lands they still go to Board sub-conversations, reachable by notification and `#board/<thread>`.

## Android note

Android had no Studio tab, so Ops is its own tab there. The Kotlin was written without a Gradle build available in the
sandbox: it is covered by `OpsProtocolTest` but was not compiled.
