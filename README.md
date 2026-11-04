# Personal Agent

> **Restructured 2 November 2026.** The current plan is [docs/PLAN.md](docs/PLAN.md); the original v1 plan is archived in [docs/PLAN-V1-CODEX-ARCHIVE.md](docs/PLAN-V1-CODEX-ARCHIVE.md). Retained foundation interfaces and prototype pages are distinguished below from the current companion.


A private Blackoutburst companion with web and Android clients, authenticated conversations and each owner's own Claude Code or Codex runtime. See [the companion](docs/COMPANION.md), [runtime configuration](docs/RUNTIME.md) and the current [operations runbook](docs/OPERATIONS.md).

The default mode is `unavailable`. An explicit `demo` mode displays synthetic preview data and labels the account and Board adapters `development-double`. Neither mode contacts an account authority. Explicit `account` mode enables fresh platform-session checks, invited-user provisioning, private APIs and native turns when an owner runtime is configured. Missing runtime configuration remains explicitly unavailable. Local startup does not deploy or sign anyone into a provider.

## Run locally

Use **Node.js 24.22.1** and its bundled npm. There are no npm dependencies to install and no bundler or build step. HTML, CSS and JavaScript are served directly. Verify the operator's deployed interpreter separately as described in the runbook.

From this directory, set an absolute data directory **outside the checkout**, then start the server. `npm run dev` runs the root `server.mjs`. The server binds only to `127.0.0.1`, using port 4318 by default; open the loopback URL printed at startup.

PowerShell:

```powershell
node --version # v24.22.1
$env:COMPANION_DATA_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'personal-agent-dev'
$env:COMPANION_MODE = 'unavailable'
npm run dev
```

POSIX shell:

```sh
node --version # v24.22.1
export COMPANION_DATA_DIR="$(mktemp -d /tmp/personal-agent-dev.XXXXXX)"
export COMPANION_MODE=unavailable
npm run dev
```

Stop the server with Ctrl+C. Keep the same `COMPANION_DATA_DIR` value when resuming the same local metadata store. The POSIX example deliberately creates a new temporary directory each time it is executed.

For the synthetic preview, stop the server, change only the mode, then restart it:

```powershell
$env:COMPANION_MODE = 'demo'
npm run dev
```

```sh
export COMPANION_MODE=demo
npm run dev
```

| Setting | Contract |
| --- | --- |
| `COMPANION_DATA_DIR` | Required absolute path outside the checkout. Runtime metadata belongs here, separate from source and configuration. |
| `COMPANION_MODE` | `unavailable` by default; `demo` opts into synthetic preview data; `account` explicitly enables platform-session validation. |
| `COMPANION_PORT` | Optional local port; defaults to `4318`. |
| `COMPANION_PILOT_FILE` | Required in CLI account mode: private absolute JSON file outside the checkout; see below. Ignored in default/demo. |
| `COMPANION_PUBLIC_ORIGIN` | Optional exact HTTPS origin for the trusted reverse proxy. Without it, only the actual loopback origins are accepted. Never derived from forwarded headers. |

The external directory contains `bootstrap.sqlite`, a versioned local metadata store. Demo mode writes only its synthetic contract fixture in the `development` namespace. The status API's storage `ready` / `local-bootstrap` state means that this local store opened successfully; it does not establish authenticated tenant storage. The store rejects paths resolving inside the checkout, checks its application/schema version and applies owner-only permissions on POSIX. Windows ACL qualification remains open.

Local development uses synthetic data. The historical #5/#6 foundation acceptance did not itself qualify native runtimes or deployment. Current application isolation tests are documented in [ISOLATION-TESTS.md](docs/ISOLATION-TESTS.md); operator release/restore evidence and the real pilot remain separate. Windows ACL qualification remains open.

## Check the source

```sh
npm run check
npm run test:isolation
npm test
```

`check` runs the configured syntax checks; `test:isolation` selects the owning application-isolation suites; `test` runs the complete suite. They use synthetic accounts and fake providers, not real sign-in, model execution or deployment evidence. No `build` command is required.

## Internal provisioning primitive

`src/provisioning.mjs` is the internal companion #5 primitive used by account mode. Every provisioning request validates an opaque proof and requires an exact issuer/subject allowlist match before atomically obtaining the same private companion ID from the metadata store. An internal test constructor can inject synthetic authority/principals; no HTTP request or CLI setting can enable that test injection.

The retained mapping uses a domain-separated SHA-256 issuer/subject key and a random UUID; it does not store the proof or raw principal tuple. The companion ID is an identifier, not an authentication credential. Invalid retained identity state stops provisioning for review instead of silently replacing the ID.

Concurrency, HTTP integration and guard tests use synthetic accounts. Historically, #5 completed its account-only acceptance: both invited owners reported admission and non-expiry checks passing, and the owner accepted an isolated exact-source expiry test. That split did not include native runtime or full-pilot acceptance; current runtime and operating contracts are linked above.

## Internal account validator

`src/account-validator.mjs` supplies the server-side validator for the discovered account contract. Account mode uses the fixed `http://127.0.0.1:9011/internal/account/session` endpoint and `https://blackoutburst.com` issuer. The input is only a selected central session-cookie value, not an identity assertion or a raw browser header. It forwards that cookie to the account authority, performs fresh validation on every call and returns only the exact issuer/subject tuple. It does not retain a successful principal or expose provider credentials.

The validator disables redirects, bounds its response and timeout, distinguishes an authentication denial from service unavailability and rejects malformed success responses. Tests use temporary synthetic local services only.

The account service's internal-authenticator failure guard was deployed and verified in [account #24](https://board.blackoutburst.com/?thread=9968061425da6965dcc349be308fa289&message=beaa288b997af0bde67e7c51db52274e). Account-only invitation, identity stability and logout/relogin were accepted in #5. Installed-provider and actual pilot checks remain distinct from these foundation tests.

## Account HTTP boundary

In `account` mode, `POST /api/session` accepts exactly an empty JSON object. It requires an exact trusted Origin, rejects cross-site requests, bounds the body and read time, and accepts only one valid `__Secure-blackout_session` cookie value. Client identity/runtime fields are rejected before validation. A verified invited platform session returns a companion UUID and that companion's provider/runtime status. All errors are fixed public messages; responses are no-store. No cookie is issued or renewed, and a companion UUID grants no access. Every protected operation validates the central session again.

The web button checks the browser's existing platform cookie without collecting passwords or provider credentials. It links to the existing Blackoutburst account page for login/renewal, and clears its previous identity display after denial or when hidden. Platform sign-in is separate from personal Codex authorization. An account-only local service cannot use a Secure platform cookie from an HTTP browser origin; actual cookie behavior requires a qualified HTTPS proxy and both invited owners.

Private pilot configuration contains only exact central account principals, never names, emails, passwords, cookies or Codex credentials. The schema is `{"principals":[{"issuer":"https://blackoutburst.com","subject":"<central account UUID>"}]}` with one or two distinct principals. Keep the real file and identity values out of source, Board payloads and attachments. On POSIX it must be a current-user-owned regular file with mode `0600`, one link and a current-user-owned mode `0700` parent, outside the checkout, with no symlink components and trusted nonwritable ancestors. Windows CLI account mode fails closed until ACL qualification; local synthetic tests use explicit constructor injection. Detailed file validation lives in `src/pilot-config.mjs`.

The earlier account-only release `9d57d26` and its disabled-at-boot staging state are historical. Current operator-confirmed HTTPS, boot startup and release layout are recorded in [OPERATIONS.md](docs/OPERATIONS.md); [ACCOUNT-STAGING.md](docs/ACCOUNT-STAGING.md) retains the original staging history. The proxy preserves Origin, supplies a fixed loopback Host and strips the preview prefix. The service remains loopback-only and trusts no forwarded identity or host headers.

## Integration boundaries

Blackoutburst login and the personal Codex connection are separate contracts. Account mode derives companion identity from a validated central account, never a client-supplied account or Board-owner ID. Each user still needs a separate qualified provider/runtime boundary. A synthetic preview cannot establish that external boundary.

The Board remains responsible for project work. Companion conversations, memories, goals and personality stay private. Current [owner-scoped Board tools](docs/BOARD-COMPANION.md), including explicitly requested file attachments, use the owner's paired bridge and accepted confirmation/privacy rules; this project does not copy or embed the Board executor.

Each owner uses their own configured Claude or Codex login/home, workspace and saved sessions on the trusted shared host. The accepted privacy boundary is application routing, not OS-user isolation. [ISOLATION-TESTS.md](docs/ISOLATION-TESTS.md) maps the reproducible negative tests and their limits; installed-provider behavior and real pilot observations remain operator evidence.

See [historical foundation interfaces](docs/FOUNDATIONS.md) and [runtime, dependency and license decisions](docs/DEPENDENCIES.md). Provider sign-in remains owner-managed; the release workflow never reads or copies provider homes or private login/configuration directories.

## Private-state implementation

Account mode includes the owner-scoped private ledger/API. See [PRIVATE-STATE.md](docs/PRIVATE-STATE.md) for its authenticated contract, ordering/retry semantics, privacy boundaries and verification limits. Native memory and conversation/runtime controls have their own current APIs and owning tests.

## Per-owner native runtime

[RUNTIME.md](docs/RUNTIME.md): each owner's own Claude Code or Codex agent on the server (`src/runner.mjs`, provider adapters in `src/providers/`, admin tool `manage.mjs`).

## Conversation clients

The main web app and Android client use authenticated [conversations](docs/CONVERSATION-UI.md) with the owner's configured native runtime. The retained `conversation.html` demo exercises synthetic replies without a model; it is not the deployed companion's runtime-status contract. Task #9's earlier UI milestone at `2e2a7eb` is historical evidence, separate from current source and operating acceptance.

## Retained private goals and permission-card prototype

The original goal/permission-card workflow is recorded in the [archived v1 plan](docs/PLAN-V1-CODEX-ARCHIVE.md). Its `src/goals.mjs` and owning tests remain, but the current client no longer ships `goals.html` or the former `docs/GOALS.md`. This prototype does not activate the native runtime or supply the authority for its configured Board tools; its local reservation/consent tests remain in the full suite.

## Project-only Board boundary

The retained [deterministic outbound facade](docs/BOARD-BOUNDARY.md) constructs qualified project-template packets and fails closed without its required providers. It is separate from current owner-configured native Board forwarding and requested file attachment. Its synthetic marker tests do not intercept every native MCP call; see [ISOLATION-TESTS.md](docs/ISOLATION-TESTS.md) for the precise coverage distinction.

### Human display profile (group chat foundation)

Me → Your profile lets each signed-in owner save a display name and picture on web and Android.
This identity is separate from the companion’s name, look and private workspace. Profile pictures are bounded
raster images; edits use revisions and remain bound to the current platform session. This is the first
owner-profile increment of #53. Group conversations, mentions, proactive group replies, group attachments,
notifications and the iOS client remain separate unfinished parts of that ticket.
