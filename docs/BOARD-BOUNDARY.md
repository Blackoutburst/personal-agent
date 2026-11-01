# Project-only Board boundary

The local task11 boundary constructs outbound Board calls from qualified project templates. It does not configure a real Board connection, use this worker's session or credentials, read personal credential homes, or activate dispatch. Default/demo/account HTTP modes have no outbound Board route. Actual owner-scoped transport and durable effect recovery remain task12; project-only worker-report integration remains task13. Runtime7/8, protected deployment20 and the full two-user pilot21 remain independent gates.

## Closed construction

The private entry point accepts an operation, reservation/request references, an exact project-template reference and, when necessary, an opaque target reference. It accepts no caller-provided message text, file bytes, goal title, private resource URL, metadata dictionary, MCP name, session identifier or arbitrary tool arguments.

A current authoritative `GoalStore.checkReservation` supplies the allowed project/action and static template. The complete result is private: its grant, companion/card/goal/reservation identifiers and resource reference are never forwarded. Resource URLs can contain private links or credentials even when they are valid permission-card literals. Local owner confirmation is necessary consent; it cannot declassify forbidden personal information.

A separately trusted project-content resolver must qualify the exact project, pinned template ID/revision/digest and same-project Board thread. It must obtain project-only content from its owning authority, not accept a model's assertion or a browser-supplied `safe:true` flag. The static template must match the currently confirmed card exactly. The boundary does not interpolate private goal fields or append arbitrary facts.

| Operation | Rendered public call |
| --- | --- |
| Ticket | Minimal `create_ticket` project ID, static title/instructions/acceptance criteria and opaque public retry key |
| Reply/comment | Minimal `post_message` to the qualified project thread, using the exact static project template and public retry key |
| Attachment | `upload_attachment` with a fixed public filename/media type and JSON generated only from that template |
| Anything else | Fixed private denial and zero transport calls |

Arbitrary worker reports, files/binaries, project updates, registration, human questions, administrative calls and generic MCP passthrough are deliberately unavailable. Future operations must add dedicated constructors inside this boundary, with their own qualified project-only inputs and regression tests. Task13 must not turn a worker's free-form response into a message by bypassing it. Board tool contracts are pinned to `agent-board` source `25b35ad276cf9056f0cdd9d81791456a6499c189`; trusted task12 transport must add its independently qualified session outside content construction.

## Required private inspection

The deterministic inspector checks the complete rendered public envelope, including generated attachment text, links, retry metadata and filenames. Its trusted private-context provider is absent by default. A positive test fixture is not production qualification. A real provider must attest to complete, fresh owner-scoped privacy sources and execute within the appropriate private boundary; provider credentials must not be imported into the shared application simply to scan them.

Known conversation/memory/personality/goal/link/identity markers and common credential guards supplement strict field and provenance rules. Inspection denies rather than redacts. Bounded normalization/encoding checks reject seeded leak attempts; they do not establish a universal classifier for unknown secrets or personal semantics. Unknown provenance or personal context requiring a broader disclosure remains private and requires a project-safe reformulation.

Checks are ordered: fresh reservation, qualified project catalog, rendered allowlist, asynchronous private inspection, final fresh reservation, synchronous privacy-current/deadline assertion, immediate transport handoff. A pause, revoke, changed template, stale proof, changed private context or failed verifier denies handoff. This is a local freshness fence, not an atomic transaction with a remote Board or an instantaneous external-profile revocation guarantee. Task12 must qualify effect recovery, current scope at the owning transport and durable duplicate prevention before enabling publication.

## Private results and public logging

Denials return fixed actionable codes/messages to the private companion. They never copy the rejected content or raw exceptions into Board messages, attachments, metadata, transport errors or audit records. Audit events contain only enumerated event/code/operation constants. An opaque public retry key is independent of private identifiers and content. It is not a durable cross-restart dispatch journal or proof of exactly-once effects. This privacy facade is not retry-safe: a second `publish` call creates a new public key even with the same private request reference. No automatic retry exists. Before real transport is enabled, task12 must durably bind the reservation, logical request, public key and uncertain outcome before the external effect, and reconcile that same attempt after failure/restart. A held lifetime reservation alone does not enforce one external effect.

Synthetic tests seed private markers across text and attachment paths, reject unknown fields/operations, exercise current-owner and permission changes, and capture transport/audit output. They use no real personal conversations, credentials, Board sessions or provider calls. Existing local privacy tests do not clear the actual qualified catalog/inspector/transport, protected deployment or full-pilot gates.
