# Personal runtime consumer contract v1

Status: local implementation boundary and qualification requirements, 1 November 2026. This is **not an installed runtime protocol, a connected provider, or actual owner-isolation proof**. The running account-only release remains `9d57d26`; the private-state candidate is `8eecd11`. The new binding registry is backend-only and unwired. Existing account/demo/default modes still report provider and runtime unavailable. No runtime endpoint or model executor is added.

This contract implements the dated amendments to companion #7 and retains every actual-runtime obligation transferred by the owner-approved #2/#5/#6 scope splits. #7 must not be completed on synthetic evidence alone. Existing dependency edges and historical foundation evidence remain intact.

## Authority and ownership

The platform account authority establishes the current principal. `createAccountAccess` and the immutable provisioning map supply one stable companion identifier; neither a browser-submitted companion/runtime ID nor an administrator/display name supplies authority. The registry independently resolves exactly one retained identity mapping on every operation. The mapping's domain-separated principal digest is `identityKey` below; it is not a credential.

Registration or rebinding requires **both** current platform admission and a separately enrolled runtime authority for the same identity, companion and runtime incarnation. A browser-supplied key cannot enroll itself. The runtime foundation owns authenticated enrollment, owner control, current revocation and replay protection. A stored registration receipt is routing metadata; it does not attest subscription eligibility or authorize inference. Every consuming execution/history/event operation must enforce current owner scope and binding generation at the runtime boundary.

The shared application may retain opaque routing references and minimal status. Personal provider tokens, refresh material, runtime private keys, credential paths and provider conversation/session IDs remain in the appropriate protected runtime store. They must not appear in this registry, client state, Board, source exports or shared logs. The private companion store separately owns user-visible conversation/goal/memory records.

## Local registry interface

`RuntimeBindingStore` uses `BootstrapStore.db`, independent backend-only tables and its own initialization marker. Authoritative bindings are never stored in client-writable private-state kinds, preferences or work records. `companionId` is an internal argument obtained only after fresh server admission, not an authentication credential. This module supplies no HTTP route and does not perform the fresh central-session lookup itself; its future caller must do so before each protected operation.

| Operation | Required behavior |
| --- | --- |
| `register(companionId, request)` | First binding requires expected generation zero, fresh independent runtime authorization and an unused runtime incarnation for this owner. Commit a monotonically versioned binding atomically. |
| `rebind(companionId, request)` | CAS against the exact retained generation, authorize the new runtime independently, preserve companion identity and fence the previous binding. Never import another owner's history. |
| `resolve(companionId, request)` | Resolve only that companion's exact current runtime/incarnation/generation and obtain fresh independent authority. Return bounded backend routing metadata, not a provider session or executable capability. |
| `disconnect(companionId, request)` | Immediately advance the local generation and fence new local use without requiring the remote provider to be available. Generation zero may fence an in-flight initial registration. Remote logout, token removal and process cleanup remain separately unconfirmed. |

Registration, rebinding and routing requests contain a bounded `requestId`, `runtimeId`, `runtimeInstance` and `expectedGeneration`. Disconnect needs the request ID and expected generation. A runtime incarnation is reserved to its original owner even after disconnect/rebind; silent cross-owner recycling is forbidden. A replacement requires independently qualified re-enrollment, not deleting a row or resetting a counter. Historical mutation retries return metadata receipts, never usable routing handles or restored authority. Changed requests sharing an ID conflict.

### Injected runtime authority

The local adapter is `verifyAuthority(challenge, {challengeDigest, signal})`. Its default is unavailable. A test constructor can inject synthetic authority; no environment variable, browser field or CLI switch enables it. This seam is a **consumer requirement**, not a claim that orchestration currently implements an endpoint with this shape.

The frozen challenge binds version `1`, audience `blackoutburst-personal-agent-runtime-binding-v1`, action (`register`, `rebind` or `route`), `identityKey`, `companionId`, runtime ID/incarnation, request ID, expected generation, fresh nonce and issuance/deadline timestamps. Maximum validity and verification wait are ten seconds. Accepted results have exactly `challengeDigest`, a 64-character lowercase-hex `receiptDigest`, and `expiresAt` within that challenge's deadline. `null` rejects authority; malformed, expired, absent or failed verification is unavailable. Raw proof material and exception text are never returned or persisted.

The registry rechecks retained identity, generation and authority deadline after asynchronous verification and under its commit/read transaction. A concurrent disconnect/rebind invalidates a late callback. It persists nonsecret digests and deterministic mutation receipts and fails closed on corrupt or incompatible retained state. A future qualified verifier must authenticate the intended runtime independently, check current owner enrollment/revocation and prevent challenge replay; matching an untrusted response digest is insufficient.

## Selected provider route and version pin

Current official documentation describes managed ChatGPT browser/device login and automatic token refresh in Codex. Each owner must complete any qualified flow on their own runtime; the application must not collect OAuth tokens or substitute another owner's account. The documentation explicitly disallows app-server authentication for commercial or hosted services and directs those services to Sign in with ChatGPT. The selected home-server topology still needs actual owner-control and supported-route qualification; separate accounts or an unwired stdio adapter do not clear that constraint. [Official app-server authentication](https://learn.chatgpt.com/docs/app-server#auth-endpoints).

Credentials can live under the assigned `CODEX_HOME` or an operating-system credential store. Store selection and headless device login must be explicitly qualified; a directory name is no isolation proof. [Official authentication and credential storage](https://learn.chatgpt.com/docs/auth#credential-storage).

Pin the actual executable version/hash and generated protocol schema before integrating any native adapter. No executable pin is established here: `codex` was not found in the inspected noninteractive SSH PATH, which does not prove it is absent elsewhere. No search of credential homes, native login, app-server launch or inference was performed. Default stdio is the proposed narrow adapter transport; do not expose a native control listener through the public companion proxy. Any alternate transport requires its own authentication, version and support qualification. [Official protocol/schema reference](https://learn.chatgpt.com/docs/app-server#message-schema).

## Runtime foundation and lifecycle

The existing Board source pin `25b35ad276cf9056f0cdd9d81791456a6499c189` supplies useful runner, exact-session resume, cancellation, journaling and reconciliation primitives. Its project/ticket/message admission is not private-companion authorization. Orchestration #66 must deliver independently authenticated private owner admission and deliberate event/history/status projections before companion #8 consumes them. No fake project/ticket or Board transcript path may carry private conversation.

Shared `ubuntu` access is the confirmed trusted host-administration model. A concrete deployment must demonstrate separation between the shared web process and each owner's credential/thread store, and between owner runtimes. Separate service identities or an equivalently demonstrated boundary must prevent ordinary application/runtime processes reading another store. Same-UID directories and read-only mounts do not establish that separation. Host administrators remain trusted; document that limit instead of advertising isolation from root.

| State/observation | Required handling and owning proof |
| --- | --- |
| Bound locally | Metadata only; keep provider entitlement, runtime qualification and cleanup separate. |
| Native connection | Each owner completes their own login; an authorized completed turn proves that owner's connection, with requested model/catalog distinct from observed served-model evidence. |
| Refresh/expiry/revocation | Runtime manages its own credentials. Current denied/unavailable states stop new use; preserve the correct private companion state and keep the other owner independent. |
| Usage limit/provider failure | Owner-specific pause with actionable sanitized status; no fallback account, pooled token or silent API-billing change. |
| Disconnect | Fence locally first. Record provider logout and owned-process cleanup independently; a requested stop is not confirmed cleanup. |
| Reconnect/restart | Revalidate owner, runtime incarnation and generation; resume only the exact saved private session. Reconcile prior process/session/external effects before retrying uncertain work. |
| Status/events/history | Return only the authenticated owner's deliberate projection; no raw runtime/account objects or private exceptions. Reject forged foreign references and stale generations on every path. |

## Qualification ledger and next delivery

Local synthetic tests cover the registry invariants only. They cannot pass any actual login, credential-home, runtime routing, entitlement, lifecycle, private-history or deployment gate.

| Gate | Current evidence / owner |
| --- | --- |
| Account admission and stable companion | #5 done53 under explicit account-only acceptance. Both owners reported passes; exact-source isolated expiry proof was accepted, actual pilot timeout unobserved. |
| Private-state implementation | #6 done9 at `8eecd11`; undeployed. Its approved split retains actual runtime evidence in #7/#8. |
| Local binding registry | Source-only candidate; synthetic verifier, no live transport or runtime registration. |
| Qualified private runtime contract | Orchestration #66 remains blocked/design-only at version3; provider lifecycle #6 remains blocked8 at inspection. Coordination request `ec859aafa047739f46c219af358dcc2e` asks the owning agents for current delivery and exact pins. |
| Actual homes/enrollment/native connection | Retained in #7; no real credentials, login or inference inspected/activated. |
| Private execution/recovery/lifecycle | Orchestration #66 and companion #8; no qualification inferred from Board-scoped supervision. |
| Protected candidate deployment | #20; current account-only staging approval does not authorize new runtime/service activation. |
| Cross-device private history/full pilot | #21; explicitly retained, unqualified by this source delivery. |

The next external contribution is the owning runtime's concrete authenticated enrollment/verification and lifecycle contract with exact implementation/version evidence. Adapt this seam to that delivered protocol before enabling any path. Obtain concrete owner authorization for required protected installation, native login, narrowly scoped inference and lifecycle tests after preparing reviewable artifacts; each owner performs their own sign-in. Pending answers do not clear gates. Continue independent eligible companion work while that delivery is pending.
