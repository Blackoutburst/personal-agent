# Application isolation checks

The accepted privacy boundary is application routing: a signed-in owner reaches their own
companion, native runtime, history and files. Both owners are trusted server administrators;
the service and native processes share a Linux UID. Separate Unix users or containers are
not part of this contract. See [RUNTIME.md](RUNTIME.md).

Before every deployment, run from the exact candidate checkout with **Node.js 24.22.1** and
its bundled npm:

```sh
node --version
npm run check
npm run test:isolation
npm test
```

`test:isolation` is an explicit selection of existing owning suites in `package.json`, not a
second test framework. It does not replace syntax checks or the complete suite. No npm
dependencies, real account, provider login, Board pairing or Discord token are needed.
Fixtures create disposable SQLite databases, workspaces and fake CLI programs; integration
tests use synthetic account validation and local loopback HTTP/stdio children. The test
environment must permit those local sockets and child processes.

Use a Linux checkout with canonical LF script/fixture bytes for the predeploy record so the
POSIX file checks execute. Record the candidate revision and any uncommitted patch, Node/OS
versions, command exit statuses, summaries and skip reasons. A blocked socket/process or a
platform skip is not evidence that its boundary passed. Do not copy private runtime files,
tokens or real conversations into a test fixture or deployment report.

## Owning coverage

The focused command's exact file list lives in `package.json`. These are source-level
regression proofs, not a live deployment receipt.

| Boundary | Existing proof |
| --- | --- |
| Account authority | `account-http`, `account-integration`, `account-validator`, `provisioning`: fresh validation/revocation, distinct stable companion identities, exact Origin/cookie rules and refusal of client-selected runtime/owner fields. |
| Private-state HTTP | `private-state`, `private-state-http`: the active account-only `/api/private/state` route revalidates each device/request; foreign owner/thread/record/cursor substitutions refuse, revocation takes effect, and owner-bound retries/deletion cannot resurrect removed content. |
| Chat, events and sessions | `conversation-http`, `conversation-account`, `runner`: foreign thread snapshot/events/submit/cancel refusal; owner-derived home/workspace, issuer binding, same-thread resume, independent sign-out, cancellation and restart. Provider programs in these tests are fake CLIs. |
| Tool configuration | `tool-policy`, `tool-runner`: both providers' fresh/resumed arguments retain the selected owner's configured bridge, exact tool names and app descriptors; requested subsets cannot expand authority or borrow the other owner's tools. |
| Uploads and media | `file-account`, `files`, `file-mcp`, `conversation-files-client`: foreign upload/thread/media/removal/bind refusal, authenticated Range/HEAD, separate quotas, current-turn outbound confinement, deletion and exact lost-ACK retries. Link/FIFO/parent-replacement cases exercise real disposable filesystem objects on Linux. |
| Native memory | `conversation-account`, `memory`, `memory-ui`: own USER/MEMORY/diary read/export, foreign or stale revision refusal, read-only diary, idle/reset-before-publication fences and late UI responses. Forget-all preserves SOUL, chat and the other owner's files. |
| Personality | `conversation-account`, `personality`, `personality-ui`: own full SOUL/history, foreign/evicted version refusal, current-byte CAS, pinned restore, owner session reset and late-response/draft fences. |
| Scheduler and release checks | `scheduler-account`, `scheduler`, `scheduler-routines`, `scheduler-mcp`, `release-watches`, `release-watch-conversations`, `release-watch-runner`: owner token/job/watch binding, foreign cancellation/CAS refusal, per-owner preferences, quiet/cancel/generation/restart fences and fresh web-only release checks without owner/app MCP transports. |
| Proactive lanes | `proactive-conversations`: owner-scoped admission/transcripts, queue/session continuity, cancelled or interrupted callback fences, buffered delivery and narrowing of application-supplied tool selections. |
| Intentional companion sharing | `contact-account`, `contacts`, `contact-mcp`, `contact-ui`: default-off bilateral opt-in, owner-turn capability lifetime, no browser direct-send/owner selector, exact attributed peer cards and no automatic recipient reply. The two-provider contact-reset canary cases verify that B's next fresh native input contains B's USER/MEMORY/SOUL/chat plus the specifically shared item, without A's unrelated private canaries. This deliberate share is an allowed boundary crossing. |
| Own linked Discord | `discord`: one bot per companion, pairing-code admission, rejection of other DM senders, routing to the owner's ongoing chat, own proactive delivery and unlink cleanup. Discord I/O is injected; no actual Discord service is contacted. |
| Web owner/request fences | `conversation-client`, `conversation-files-client`, `companion-app-recovery`, `memory-ui`, `personality-ui`, `contact-ui`, `reminders-ui`: auth/reset clears private state; late old-owner replies or detached controls cannot restore it; draft/CAS/exact-retry handling does not silently resend writes. App-shell tests use a synthetic DOM, not a hardware/browser qualification. |
| Storage | `store-privacy`: process-owned SQLite modes, links, ownership and sidecar checks. |
| Board helper | `board-companion`: two configured owners keep request wakes, profile updates and requested attachments on their own injected bridge. Mentions come from each companion's own Board inbox (its own session), with per-companion dedup and cursor. It checks request-owner filtering/dedup, IDs rather than request-question text in prompts, unchanged-profile suppression, unconfigured refusal, stable attachment keys and finite file-MCP exposure. |
| Board attachment application route | `file-account`: simultaneous synthetic owner turns get distinct tokens; each token reads its own same-named workspace file and reaches only its own injected Board bridge. Foreign paths/body identity selectors refuse without uploads; cancelling A expires its token while B continues. |
| Weather context | `weather`: two synthetic admitted owners set/read distinct places; body identity selectors refuse without effects, clearing A preserves B, and own weather instruction context excludes the other place. Account admission is injected here; account suites cover the actual HTTP authority boundary. |

Each name in the table refers to `test/<name>.test.mjs`, except
`board-adapter.integration.test.mjs` discussed below.
GoalStore-specific prototype suites remain in `npm test`, outside the focused selection;
they are not substitutes for native-memory or current-runtime integration checks.

## Board evidence and limits

Current native forwarding uses each owner's configured paired bridge and exact tool
selection (`src/tool-policy.mjs`, `src/runner.mjs`). Generic wakes retain configured Board
reads only; Board-triggered `board` wakes (Needs-you requests and mentions) retain every
Board tool the owner configured, so they can answer on the Board. Release checks forward no Board/app transport. The app's profile
sync and requested attachment path also use the owning bridge. See
[BOARD-COMPANION.md](BOARD-COMPANION.md) for the current policy and
[RUNTIME.md](RUNTIME.md) for normal-turn confirmation and private-content instructions.

`board-boundary`, `board-private-inspector` and `board-adapter.integration` exercise the
retained deterministic facade with synthetic private markers and finite packets. That
facade is not an interceptor for every current native MCP call. Its passing tests must not
be presented as universal filtering of model-generated native Board output.

The proactive fixture checks that only a `board` wake retains its owner's configured
resolver: generic wakes drop it, B cannot borrow A's resolver, other Board writes remain
absent from wakes, and normal A turns retain their configured selection. Neither this
selection proof nor the injected Board helper proves actual Board profile permissions,
a model's low-risk judgment, or the content of a real paired call.

## What a green run means

The suite detects regressions in authenticated application ownership, context selection,
capability lifetime and private client-state handling using synthetic data. POSIX mode,
link and ownership checks protect process-owned storage; they do not prove tenant OS
denial under the accepted shared UID. A conditional foreign-UID test may legitimately
skip when the environment cannot change fixture ownership; record that limitation.

Fake providers prove the app's selected inputs, homes, sessions and generated arguments.
They do not qualify installed Claude/Codex behavior, inherited native configuration,
credentials, hardware clients or real sign-in. No suite claims semantic consent parsing,
universal private-data egress prevention, or erasure of past chats/provider retention.
Actual installed-provider, paired-bridge and deployment checks remain operator evidence;
keep them separate from these reproducible source tests.
