# Original v1 plan (Codex, 31 Oct – 1 Nov 2026)

Archived on 2 November 2026 when the project was restructured. This is the board project brief as it stood at project version 24. It is kept for history; the current plan is in docs/PLAN.md and on the board.

## Description

One persistent personal companion per user, with Blackoutburst and TheScreamer each using their own owner-controlled personal Codex runtime/account on the always-on server. Web first; existing platform login; goals, project-only Board dispatch/follow-through, in-web proactive updates and private memory/personality. Native clients later. Qualify the actual personal-runtime operating model.

## Context

The v1 product plan was completed in ticket #1 on 31 October 2026. The owner subsequently requested all tasks for the existing execution loop to build the project. This chat creates and organizes the backlog; the existing loop carries out ticket work within its granted scope.

Vision and priority
A personal agent that grows with its user and persists across devices: a companion with continuity of identity and shared history as well as practical capabilities. All of the following are end goals, in the owner's stated importance order:
1. Help pursue long-term goals.
2. Be proactive.
3. Remember shared experiences.
4. Develop a personality over time.
This ordering guides tradeoffs; it does not imply that every end-state capability must ship fully in v1.

Confirmed decisions from the owner
- Run on Blackoutburst servers and remain available when every user device is offline.
- Start with a simple responsive web client.
- Exactly one personal companion per user, with a persistent identity, personality and memory across devices.
- The companion automatically creates and dispatches work to the existing autonomous board within user-defined goals and permissions.
- The companion is the primary conversational interface to the board: follow work through completion, answer routine questions within its context and authority, bring user decisions back, and report results. Users retain direct manual access to the board.
- V1 proactive triggers include board progress or blockers, neglected goals and scheduled check-ins.
- Users can request periodic monitoring, for example: 'Notify me when X is released.' Checks run on the server while clients are offline. V1 delivers updates only inside the web client; no notification is sent anywhere while it is closed. Out-of-app notifications are deferred to native/mobile apps. Exact schedule semantics still need refinement.
- Board tickets and all other board content contain project-work context only. Personal conversations, memories and personal details stay with the companion and must not enter the board.
- Reuse the existing Blackoutburst platform account and login.
- Personal runtime direction selected on 1 November 2026: Blackoutburst uses his own Codex account/runtime; TheScreamer uses his own. Target genuinely owner-controlled self-hosted personal runtimes on the always-on server, with a web client routing each authenticated owner to their own companion/runtime. Native Codex app-server login, directly or through a qualified OpenClaw integration, is the route to qualify in #2/#7; a commercial plan-sharing application is no longer the assumed pilot path.
- Prefer reuse of existing projects rather than rebuilding agent runtime, session, tool and connectivity infrastructure.
- Later clients: native iOS and Android; native desktop apps are a possibility.
- Project participants: Blackoutburst and TheScreamer.

Experience and reuse references
The owner named Grok bot, OpenAI dots, Meta Muse, the upcoming Claude Duet, OpenClaw and Cindy as inspiration. These are user-supplied references, not assertions that all named features are available. Evaluate OpenClaw as a reuse candidate. Cindy is an experience reference whose published monorepo excludes its backend; verify reusable components before any choice. The owner selected the thin integration direction on 31 October 2026; detailed framework/component, fork and license-adoption decisions remain subject to qualification.

Existing foundations
Board agents and server-side orchestration:
https://board.blackoutburst.com/?project=b5e74de3c3b57dcabc7c804faa676625
Blackoutburst account and login:
https://board.blackoutburst.com/?project=d03d401aee77dbf8708b0148a11dcee9
Build on these foundations. Verify their actual capabilities and readiness during design. The new project's subject is the personal companion experience and its integration, not a parallel rebuild of the board/server agent.

Accepted v1 planning defaults — 31 October 2026
Owner answered “Use the proposed v1 planning defaults” in request 40208a4631626b8a122083ed5bb4a2ab.
Decision: https://board.blackoutburst.com/?thread=f3dd922aed3ae1862a35ba810800aeb8&message=07c44b0c3f1ca725d04543ab61c24975
- Invitation-only pilot for Blackoutburst and TheScreamer.
- Text and pasted links first; uploads and voice deferred.
- Goal-specific permission cards and approved project-work templates bound automatic dispatch; Board edits/cancellations are reconciled.
- Editable opt-in personal memories and reviewable/reversible personality suggestions; private continuity across devices.
- Material Board updates when observed, 10-minute reconciliation, daily 09:00 in-web digest in the user's chosen timezone, weekly check-in and neglected-goal reminders after seven inactive days.
- One-shot release watches default to six-hour checks after exact source/condition confirmation; quiet while unchanged, one evidenced in-web result, editable/cancellable.
- Thin companion integration around existing account/Board/Codex foundations. OpenClaw is a qualified alternative if it removes a demonstrated gap; Cindy is an experience/client-component reference whose public backend is excluded.
Those decisions completed the planning baseline. The subsequent backlog request and current execution scope are recorded below; ticket #1 remains a completed planning-only historical record.

Current execution and evidence — 1 November 2026
The existing authorized worker implements this backlog. Ticket #1 remains the historical completed planning baseline; later direct owner instructions authorized implementation, server file access, the account-service fix, repository publication and direct main pushes. Board text never grants shell/provider/deployment authority.

#2 completed discovery of the native personal route and confirmed home-server/shared-ubuntu administration. It did not qualify actual credential homes, runtime control, independent private admission or inference. Native app-server authentication must fit actual owner-controlled personal use; separate accounts or successful inference alone do not settle supported deployment scope. A commercial sharing form is not the assumed pilot path. Shared ubuntu access is trusted host administration, not credential/process isolation.

Completed implementation milestones
- #3/#4 historical foundation map/bootstrap are preserved. Reviewed Board source pin25b35ad276cf9056f0cdd9d81791456a6499c189 is reference evidence, not deployed/private-runtime qualification.
- #5 is done53 for account-only binding. Both invited admissions, repeat/two-tab stability, distinct companions and logout/relogin passed by owner report. Owner expressly accepted a fresh exact-source isolated expiry test; actual pilot session timeout remains unobserved. Decision fd65b924a31afa0bd1b63c72a359041e; completion https://board.blackoutburst.com/?thread=348cdea23b1576335ef0da22733f9a8f&message=fedd9c6970281bbf737f3e53f1ff21c0 .
- #6 is done9 for tested local private-state implementation under accepted split ebd5a263629c7589433744ba39cc144b. Main8eecd111976b858ccc892f368c1182b1f3849615 contains owner-scoped private records/threads, ordered mutations, CAS/idempotency, signed cursors, logical deletion, protected file/sidecar handling and corruption guards. Windows81total:68pass0fail13skip; exact exported Linux81total:77pass0fail4skip. Source archive79f8727418a6aee771c5d80b50fd72d485cfc06ecce94a256cc60ba90aed0b66, attachment bfdaffbae73b8bf41549beae62d15cef. Delivery https://board.blackoutburst.com/?thread=bf14efefa2c55a7b5d8d4e4a58b9b425&message=61cd742d218d2fd34bb550300e15a014 . This source is not deployed.

Current live boundary
The separate account-only preview is https://blackoutburst.com/personal-agent-preview/ at release9d57d26203554e461e1271d2c9cca4421a54e308. V3 operator receipt and independent source/effective-service/listener/HTTP verification pass; boot startup is disabled. Provider/runtime are unavailable. Owner receipt1d5a88a5260ea2e0d9393c3f1244227d; independent evidence https://board.blackoutburst.com/?thread=348cdea23b1576335ef0da22733f9a8f&message=809546ce49b2a6811e3d7967447a5d0b . Earlier v1 refusal and v2 rollback remain historical; no repeat root installation or UUID entry is pending. Account #24 internal-authenticator503 guard is separately deployed/verified.

Retained acceptance, not waived
#7 is blocked6 after local source delivery: apply dated amendments2541ce124d59e9f1cdb041396d0b79d2/c765738f47ad2e80c2bdfe283a76912c and approved #2/#5/#6 transfers. Publish the versioned per-owner registration/authentication/routing/lifecycle contract and reconcile current scaffold/config/artifacts. ALL actual runtime registry/registration, independently authenticated owner/companion/runtime/generation binding and rebinding, isolated CODEX_HOME/credentials/thread stores, owner-completed native login, actual authorized inference, and owner-specific refresh/revocation/disconnect/expiry/limits remain unqualified. Requested model/catalog and observed served model must stay distinct. Shared app may hold routing metadata, never provider credentials.
#8 and orchestration #66 retain private execution/events/history admission, runtime-side swap/ownership/lifecycle, offline wake, restart/stop/recovery and effect reconciliation. Current orchestration #66 contract is design-only; no fake Board work scope may authorize personal prompts.
#20 owns protected deployment/release of the private-state/runtime candidate. #21 owns actual cross-device/private-history and full two-user pilot acceptance. These obligations are explicitly retained by the owner-approved #5/#6 splits; local HMAC/cursors, unavailable-route denials and synthetic tests do not pass them.

Permission and privacy
Account-only staging approval grants no runtime installation/registration/activation, provider login, inference or private-history access. Prepare concrete reviewable changes before asking for needed external actions through MCP. Each owner completes their own sign-in; no token sharing, credential pool, other-owner fallback or silent API-billing switch. Keep private conversations, memories, identifiers, cookies and personal details out of every Board payload/attachment and public source. Outbound Board context is project work only.

Reuse the account and orchestration foundations; route missing owning contracts upstream rather than rebuilding a parallel executor. Preserve original dependency edges and prior evidence. Existing provider onboarding/recovery/cleanup gates remain; a pending answer or synthetic pass does not clear them.

Official references: https://learn.chatgpt.com/docs/app-server#auth-endpoints ; https://learn.chatgpt.com/docs/auth#login-on-headless-devices .
Approved planning baseline: https://board.blackoutburst.com/?thread=f3dd922aed3ae1862a35ba810800aeb8&message=9252c55cc9e2a2863c50cb23a781c9b5 .
Repository https://github.com/Blackoutburst/personal-agent is linked; direct main pushes are owner-authorized.


Latest implementation delivery — 1 November,18:32Z
Main is now2e2a7ebc1c1f70869091168b28892ff63393f0f6. Registry contract/sourcecb46ddd was published with97checks (Windows84pass0fail13skip; Linux93pass0fail4skip). #7 remains blocked6 awaiting the owning qualified private admission/lifecycle contract; coordination ec859aafa047739f46c219af358dcc2e has no qualifying reply. Runtime66 remains blocked3/design-only. No real Codex connection/credential-home/routing/eligibility/inference/lifecycle gate is cleared.
#9 responsive conversation candidate is published at2e2a7eb: separate text/link UI, exact-action retry, event replay/gap recovery, cross-client idle polling, private-display lifecycle guards and explicit synthetic fixture only. Account conversation freshly validates admission then stays unavailable; no fake assistant/private-runtime provenance is inferred. Final127checks: Windows114pass0fail13skip; exactLinux123pass0fail4skip;8retained syntheticDOM lifecycle checks pass, independent material review fixes verified. Full57Gitblobarchive173181bytes SHA256b9b3ae940d78ca5729fb8a152abea82666d4bb95294e696580738c6287bae278, attachment803a5ee03e21117402802531ae86cf05 exactroundtrip. Delivery https://board.blackoutburst.com/?thread=b1ee4d95b2895c18e1179f66d7e2c00a&message=bf85d9a9872df7d577d43a9c16d18cfd .
#9 is now DONE7 after the owner reported desktop/narrow-layout and keyboard checks pass in message404bbc55199aaa451af03d8277ea313b; human action5e3adbb63d20f671e4549b0a5e98bfac resolved. Completion: https://board.blackoutburst.com/?thread=b1ee4d95b2895c18e1179f66d7e2c00a&message=6305474dc4ba70474051a4b0c730bd18 . This accepts the UI milestone against its clearly synthetic service, not real private-runtime/full-pilot qualification. Source main2e2a7eb remains exact and clean; tests were not repeated without a code change. The temporary synthetic loopback review process/listener were fingerprint-verified and stopped after acceptance; no fixture contents were read/uploaded. Browser evidence is owner-reported; Node/DOM/protocol evidence remains explicitly synthetic. Continue the next eligible task, long-term goals/milestones/permission cards #10.
Installed server remains account-only9d57d26, independently observed18:32Z active/running samePID1816096, bootdisabled. No current candidate deployment or real personal runtime activation. Accepted5/6 split evidence and ALL7/8/20/21 actual gates remain as above.

Goals/permission implementation — 1 November,20:32Z
Task10 is DONE4. Source main a6a89658bd5e7704c01054a436dcac357337d167 implements private goals/plans/milestones/review and dedicated authoritative versioned cards, exact static project-work preview/confirmation, lifetime reservations, fresh account-bound writes and bounded idle sign-in checks. Independent authority defaults unavailable; no actual Board dispatch, provider, spending, runtime or deployment was started. Outbound work projection excludes private goal narratives/mappings; #11/#12 retain the whole Board boundary and actual dispatch integration. Native browser review of the new goals page remains unperformed; logical/controller/HTTP proof is synthetic and does not qualify fullpilot21.
ExactNode24 checks171: Windows158pass0fail13skip; exact exportedLinux167pass0fail4skip. Core19/19, client/controller18/18, actuallocalHTTP/integration7/7 independently reviewed. Fixed snapshot bounds, stale consent-read races, control-capacity failclosed and multiwindow valid-owner-switch/idle session privacy. Full68Gitblobarchive228594bytes SHA2564a473ebf398428a1b61c285fffddedb5120c8fae08d63e049bd0ac0445f0d814, attachmentad20e55451647dd37d60e3365c8f4835 exactroundtrip. Delivery https://board.blackoutburst.com/?thread=1f8feb880a637e34b034a17858dbbc5a&message=088fdc2270f75c9d412b5135a3ca4c72 . Continue eligible11 project-only Board payload boundary. Task7blocked6 actualruntime/66contract remains unqualified; live9d57d26 account-only server unchanged.

Project-only Board boundary — 1 November,20:55Z
Task11 is DONE4 at main6ee1fc4fbd71f7cd7b9347c6d4b26aa098d1b0b2. Closed shared payload constructors require current authoritative reservation, separately qualified pinned project template/target, complete private/control inspection and fresh synchronous final guard. Supported static-template ticket/reply/comment/generatedJSONattachment paths exclude private mappings/resources and raw fields/files/metadata/tool passthrough; unsupported operations stay closed. Fixed private errors/audits exclude rejected content. All27 new tests pass independently; fullNode24 checks198: Windows185pass0fail13skip; exactLinux194pass0fail4skip. Archive74Gitblobs253187bytes SHA256d34f65be4edcdf56678dd2d786909a4d0e62049e361a35c6b019908e591ab142,attachment8a74c9a664da49830e4e74db9f72115d exactroundtrip. Delivery https://board.blackoutburst.com/?thread=7131a1eb882d8e6a8a42f6dc766e52aa&message=18538a2af85489b40aaf6a1ef2a01580 . No actual transport/catalog/private-context provider is configured; unknown-secret semantics are not claimed. Task12 must bind logical request/reservation/public key and uncertain outcomes durably before real dispatch; this privacy facade is not retry-safe. Task13 owns qualified worker reports. Actual7/8/20/21 gates and liveaccount-only9d57d26 unchanged. Both upstream owning threads checked without new qualified delivery.

## Environment

Source/main https://github.com/Blackoutburst/personal-agent @6ee1fc4fbd71f7cd7b9347c6d4b26aa098d1b0b2, remotely verified/clean. Node24.22.1/no npm deps. Latest198checks Windows185pass0fail13skip; exactLinux194pass0fail4skip. New27 boundary/inspector/real-GoalStore tests independently reviewed;21 syntax checks pass. Source74Gitblobs253187bytes SHA256d34f65be4edcdf56678dd2d786909a4d0e62049e361a35c6b019908e591ab142,attachment8a74c9a664da49830e4e74db9f72115d exactroundtrip. Task9DONE7 owner browserpass,10DONE4 localgoals,11DONE4 localprivacyboundary. No actual Board transport/catalog/privatecontext provider;12durable dispatch/13workerreport constructors remain. Goals nativebrowserUXunperformed/fullpilotretained. Task7blocked6 awaitingqualifiedprivate66contract; actualprovider/runtimeunavailable. Liveaccountpreview9d57d26203554e461e1271d2c9cca4421a54e308 remains https://blackoutburst.com/personal-agent-preview/ ; lastobservedPID1816096active/running,bootdisabled,loopback4318. No current source deployed. Actualruntime7/8/deployment20/privatecrossdevice/fullpilot21 gates remain.
