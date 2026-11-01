# Private goals and permission cards v1

This implementation adds the private goal workflow for task #10. It stores goals, milestones, an editable plan, next step and review metadata, plus authoritative versioned permission cards. It performs **no Board dispatch, provider/model call, publication, spending, runtime activation or deployment**. A confirmed card is local owner consent, not Board/profile/shell authority. Existing runtime #7/#8, orchestration #66, deployment #20 and actual private cross-device/full-pilot #21 gates remain.

`goals.html` opens the workspace. Default mode stays closed. Account mode freshly validates the current platform session and invited principal for every request, derives its stable companion on the server, and returns that owner's private state. Demo mode explicitly uses a synthetic server principal and marks responses synthetic; it does not read the browser's real account to select an owner. A retained demo record cannot become account-owned state. Do not put personal details in a shared demo or any Board/source artifact.

## Goal workflow

Each goal has a server-generated ID, CAS version and authorization generation. The private value contains `title`, `desiredOutcome`, `notes`, `plan`, `nextStep`, nullable canonical-UTC `reviewAt`, milestones `{id,title,done}`, and status `active`/`paused`. Progress is the count of completed milestones, not an invented estimate. Plans and next steps are editable user proposals; no connected model creates them here. Goal review records a private `reviewedAt` timestamp. It does **not** renew permission-card consent.

Pause/resume advances the authorization generation. A paused goal denies work; resuming does not silently restore old grants or a card confirmed for an earlier generation. The current card must be reviewed and reconfirmed. There is no hard-delete/forgetting action in this slice; retention/deletion remains with the private-memory/forgetting work.

Goal/card state is private companion data. Neither the goal title, narrative, notes, milestone IDs, goal-to-card mapping nor later goal-to-ticket mapping belongs in Board content, metadata, labels, comments or attachments.

## Exact owner consent

Each goal has at most one persistent card. The card defines:

- Literal project IDs, actions, task types and exact resource references; no wildcard expansion or resource resolver.
- Total lifetime task, token and spending caps for that card ID, including already reserved amounts.
- An exact currency unit when spending is permitted; zero spending uses a null currency. No conversion or API-billing fallback exists.
- Absolute UTC `notBefore`/`expiresAt`, review cadence, and allowed actions that still require a concrete user decision.
- A static project-work template with `title`, `instructions` and `acceptanceCriteria`.

Saving any card edit makes it a draft and invalidates previous authority. Confirmation requires an explicit action carrying the exact current card version and server preview digest. The digest binds the complete saved policy, template, owner/goal/card identity and authorization generation. The UI must show the saved constraints/template and prevent confirmation of unsaved form edits. It never fills the project template from private goal text. No variable interpolation is performed.

Confirming an existing confirmed card is an explicit consent review. It advances the version/review timestamp and fences old grants. Editing, reviewing, reconfirming, pausing or revoking **never resets lifetime budget reservations**. New caps cannot be below held totals; currency cannot change after positive cost is held. Revocation takes effect for all future checks; an old confirmation retry returns only its historical receipt and cannot revive consent.

Card review deadlines derive only from `confirmedAt + reviewEveryDays`; goal review metadata is separate. Expiry, a future time window, review due, pause, generation mismatch, draft/revoked state, out-of-scope requests, required decisions and exhausted caps deny authorization. Routine matching work needs no per-ticket confirmation once every independent authority check is satisfied. New/outside scope requires a concrete new owner decision rather than an implicit expansion of the card.

## Private management API

The fixed same-origin path is `POST api/goals`. It reuses the existing exact-Origin, fetch-site, JSON media type, 64 KiB body and three-second read guards. Client-supplied owner/runtime/authority selectors grant nothing. Responses are no-store with fixed errors; raw exceptions/private payloads are not echoed.

Successful responses are `{version:1, synthetic:boolean, companionId, data:...}`. This protocol version is separate from CAS revisions in mutation receipts. The initial snapshot binds the opened workspace to its server-derived companion. Subsequent requests carry `expectedCompanionId` in the HTTP envelope, separate from the core action. The server compares it with fresh platform admission before any mutation; a valid cookie for a different account still receives401 and cannot save a previous owner's form. Mutations without a workspace binding receive409. The identifier is not an authentication credential or a user-selectable owner grant.

`snapshot` returns private `goals` and `cards`, including progress, saved policy/preview digest, held/remaining budgets and local blocked reason. It does not return the internal request/reservation ledger or an executable capability. The browser checks every response's owner binding and mode marker; mismatch clears private state. The companion identifier stays internal to this owner channel and is not displayed or posted to Board.

| Action | Fields beyond `action` |
| --- | --- |
| `snapshot` | None |
| `saveGoal` | `requestId`, nullable `goalId`, `expectedVersion`, full `goal` |
| `reviewGoal` | `requestId`, `goalId`, `expectedVersion` |
| `saveCard` | `requestId`, `goalId`, nullable `cardId`, `expectedVersion`, full `card` |
| `confirmCard` | `requestId`, `cardId`, `expectedVersion`, `previewDigest`, literal `confirm:true` |
| `revokeCard` | `requestId`, `cardId`, `expectedVersion` |

Creation uses null ID/version zero; existing records use their current version. Mutations return metadata receipts. Stable request IDs deduplicate exact semantic requests; changed requests conflict. A stale receipt never rolls current state back. After a write/retry the browser obtains a fresh snapshot. The client retains an uncertain write only in memory for explicit retry, and clears forms, preview confirmation, private data and pending state on hide/access loss. Epoch/abort and latest-read guards reject stale callbacks, out-of-order snapshots and mode/owner changes; there is no automatic resend after clear/reopen. Late current-epoch access denial still clears state even when a later read already completed.

An explicitly open, visible account workspace also probes `api/session` every15seconds with a5second deadline. Healthy probes preserve drafts and reviewed previews and send no goal action. Denied, unavailable or changed account identity clears private fields and requires an explicit reopen. Demo mode does not probe real accounts. This bounds idle detection; it does not claim instantaneous detection of an external logout. Every actual goal mutation independently enforces the current owner binding at the server.

## Internal authorization and future dispatch

`GoalStore` uses dedicated authoritative tables in `BootstrapStore.db`. It never reads arbitrary `PrivateStateStore` goal/permission JSON as consent. Protected initialization/owner markers, sealed owner documents, current immutable identity checks, CAS and immediate transactions guard ownership, integrity, replay and reservation totals. An HMAC is an integrity check, not encryption or isolation from the trusted host administrator. Existing storage/Windows ACL qualification limits remain.

Only trusted server callers may use `evaluate`, `reserve` and `checkReservation`; none is a browser action. All require the current card version/generation, an exact candidate scope and a fresh independently enrolled project/profile authority verifier. The verifier is absent by default. A browser key, echoed challenge, local confirmation, supplied project ID, administrator name or this worker's broad credential cannot supply another user's Board authority.

The injected verifier receives an owner-bound, nonce/deadline-bound scope challenge. It must qualify the correct platform-owner-to-Board-profile/project binding and actual resource/action intersection through its own authenticated channel. It receives no goal/card narrative or goal/card ID. Verification waits/validity are bounded to ten seconds. Owner identity, card/version/generation, pause/revocation, deadlines, scope and limits are rechecked after asynchronous verification under the commit/read transaction.

`evaluate` does not consume a budget or dispatch. `reserve` atomically holds conservative lifetime task/token/cost bounds and returns metadata only. Concurrent reservations cannot exceed caps. Retrying an uncertain reservation keeps the same held budget; there is no automatic refund/settlement/expiry reset. `checkReservation` revalidates the current policy and independent authority before exposing a deliberate static work projection. Historical receipts are not reusable execution capabilities. Limits are held estimates, not a claim of measured provider usage or money spent; unknown usage/cost must not silently be treated as zero by a future adapter.

The eligible `work` projection contains only the allowed project/action/task type/resource and approved static template. Private grant/card/reservation metadata is returned separately for internal use and must not be posted to Board. #11 owns the complete outbound project-only boundary; #12 owns actual duplicate-safe dispatch, fresh checks immediately before effects, qualified usage enforcement and private goal-to-ticket receipts. Board idempotency keys must be independent opaque project-work IDs, not embedded private goal IDs. No fake Board work scope is used for a personal conversation.

## Capacity and verification limits

The bounded local slice supports 20 goals/cards, 20 milestones/scope entries, 4,096 request/reservation records and a 2 MiB owner document. It does not silently truncate, delete, reset budgets or refund uncertain effects. Authority fails closed when request/control capacity is exhausted or the document enters its reserved control margin; this applies to fresh and already reserved work before and after verifier waits. The browser's bounded response allowance also covers the larger snapshot plus duplicate static preview. Full capacity requires operator review, not loss of retained private history or reuse of old grants.

Focused synthetic core, account/demo HTTP, client and lifecycle checks establish the local implementation contract. They include real local HTTP between synthetic clients and the actual controller executed against a synthetic DOM. Native browser layout/keyboard review of the new goals page is unperformed while browser automation is disabled; the earlier conversation page has a separate owner-reported acceptance. These tests do not qualify a real Board connection, provider runtime, actual in-flight process stop, protected deployment or the full two-user pilot. Local pause/revocation fences future authorization; confirmed cleanup of already-running external work remains an independent runtime/dispatch responsibility. User-entered personal goals and real credentials must never be copied into test fixtures, source archives or Board evidence.
