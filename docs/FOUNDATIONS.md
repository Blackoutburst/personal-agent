# Foundation interfaces

The bootstrap establishes a separate thin companion service. Its production adapters remain unavailable until the owning services deliver qualified contracts. Default mode reports all adapters unavailable. Explicit demo mode labels account/Board fixtures `development-double`; provider and runtime stay unavailable. A development double must not be displayed as a connected production service.

| Boundary | Existing evidence and missing contract | Owner / consumer |
| --- | --- | --- |
| Central account | The public browser client calls `/api/account/session`, `/login` and `/logout` with same-origin credentials. This does not establish a separate-service validation API, immutable subject, cookie sharing or general SSO. | [Account #23](https://board.blackoutburst.com/?project=d03d401aee77dbf8708b0148a11dcee9&ticket=4a48a88955a098225d3fa2bccb5a618b) supplies canonical protected source/revision, validation, identity, cookie, CSRF, revocation/deletion, failure and trusted-header contracts. Companion #5 consumes them. |
| Companion identity and state | The target is exactly one private companion per validated platform subject. An unwired internal provisioning primitive validates each opaque proof through an injected trusted validator, applies an exact issuer/subject allowlist and atomically obtains the corresponding private companion ID. It has no HTTP/auth route or central-account validator. Browser-provided identity fields are not assertions. | Companion #5 remains incomplete pending account #23 and real integration qualification; #6 owns private persistence and its security/lifecycle qualification. |
| Provider connection | A profile preference or model catalog is not a connected provider or entitlement proof. Blackoutburst-server use of each user's subscription remains an unresolved hosted-integration dependency. | Companion #2 establishes hosted eligibility; orchestration #46 and #2/#6 own onboarding/provider lifecycle; companion #7 integrates the qualified contract. |
| Private runtime | Existing bounded Board execution is project-work infrastructure. It does not prove private prompt/history isolation, always-available operation or cleanup of local processes. | [Orchestration #66](https://board.blackoutburst.com/?project=b5e74de3c3b57dcabc7c804faa676625&ticket=24dbf058a170b26d42198ba3414a65a3) owns private per-user runtime qualification; companion #8 consumes it. |
| Project work | Board MCP supplies profiles, inboxes, work selection, leases, versioned writes, human handoff and evidence-bearing outcomes. Live credentials and transport are absent from this bootstrap. | Future companion adapters consume the pinned contract below; #11 owns outbound project-payload privacy, #12 dispatch and #13 follow-through. |

Proposed service placement is a separate backend behind a same-origin `/companion/` route, after the account contract is qualified. This fits the observed same-origin browser interface without assuming cross-subdomain cookies. No reverse-proxy change, deployment destination or public repository creation is part of this bootstrap. Do not share the account or Board databases/session secrets.

## Board contract pin

Reference source: [`Blackoutburst/agent-board` at `25b35ad276cf9056f0cdd9d81791456a6499c189`](https://github.com/Blackoutburst/agent-board/tree/25b35ad276cf9056f0cdd9d81791456a6499c189). Its source reports Board 2.17.4/schema 17. This pin identifies reviewed source; it does not attest exact deployed-backend equality.

- [Registration/authentication](https://github.com/Blackoutburst/agent-board/blob/25b35ad276cf9056f0cdd9d81791456a6499c189/app.py#L577-L591): owner credentials, durable profile bindings and current policy constrain access.
- [Bounded reads and inbox acknowledgement](https://github.com/Blackoutburst/agent-board/blob/25b35ad276cf9056f0cdd9d81791456a6499c189/docs/MCP-READS.md#L44-L100): persist delivery pages before advancing cursors; obtain canonical text and follow pagination.
- [Atomic work selection](https://github.com/Blackoutburst/agent-board/blob/25b35ad276cf9056f0cdd9d81791456a6499c189/coordination.py#L876-L923): persist retry keys; reconcile uncertain outcomes; do not select around unfinished claims.
- [Human handoff](https://github.com/Blackoutburst/agent-board/blob/25b35ad276cf9056f0cdd9d81791456a6499c189/coordination.py#L1009-L1065): use current versions and exact retry keys. A released human request blocks its ticket while unrelated ready work remains eligible.

These files are protocol references, not copied executors. Current implementation and tool schemas take precedence over stale summary counts or contradictory prose in older contract headings.

## Privacy and dependency direction

Private companion prompts, conversations, memories, personality and private goal context must remain outside all Board work records, payloads, metadata and logs. A shared message/ticket runtime whose prompt builder or transcript mirror writes to Board records cannot serve private conversation merely by changing a session label. Orchestration #66 must qualify that separation before companion #8 connects it.

Bootstrap #4 can proceed with explicit unavailable adapters. Real binding waits for account #23; hosted subscription integration waits for companion #2; private runtime integration waits for orchestration #66. These are upstream contracts, not a circular requirement for downstream companion implementation to already exist. The stopped legacy listener and unresolved pilot cleanup are not reactivated by this work.

The local SQLite store supplies versioned metadata/namespace and internal identity-mapping primitives, not private conversation storage. Its `ready` status is a successful local-open check, not a claim of authenticated per-user persistence. Provisioning is unavailable without an injected validator, and its synthetic validation/concurrency tests do not establish central-account authenticity, a qualified pilot or production storage guarantees. No cookie parser, SSO adapter, real-account feature or provider connection is supplied. Production private-storage access and lifecycle guarantees remain with companion #6.
