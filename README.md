# Personal Agent bootstrap

A local candidate for the Blackoutburst personal companion. It contains a responsive account-preview client, a loopback HTTP server, account-to-companion integration and a private SQLite ledger/API. Personal Codex, Board access and model-backed conversation remain unavailable.

The default mode is `unavailable`. An explicit `demo` mode displays synthetic preview data and labels the account and Board adapters `development-double`. Neither mode contacts an account authority. Explicit `account` mode enables fresh platform-session checks, invited-user provisioning and the private-state API; provider and runtime stay unavailable in every mode. The running account-only preview remains pinned to its earlier release. This private-state candidate is not deployed, and a full companion/runtime pilot remains unqualified.

## Run locally

Use **Node.js 24.22.1** and its bundled npm. There are no npm dependencies to install and no bundler or build step. HTML, CSS and JavaScript are served directly. The version choice follows the Node 24.22.1 platform convention recorded in the account foundation; it is not a claim that the companion is deployed there.

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
| `COMPANION_PUBLIC_ORIGIN` | Optional exact HTTPS origin for a trusted future reverse proxy. Without it, only the actual loopback origins are accepted. Never derived from forwarded headers. |

The external directory contains `bootstrap.sqlite`, a versioned local metadata store. Demo mode writes only its synthetic contract fixture in the `development` namespace. The status API's storage `ready` / `local-bootstrap` state means that this local store opened successfully; it does not establish authenticated tenant storage. The store rejects paths resolving inside the checkout, checks its application/schema version and applies owner-only permissions on POSIX. Windows ACL qualification remains open.

Local development uses synthetic data. The private-state implementation milestone #6 is complete under its accepted implementation/qualification split. Actual protected deployment, runtime credential/thread isolation and cross-device private-history acceptance remain with #7/#8, #20 and #21. Windows ACL qualification remains open. Local source tests do not prove those external boundaries.

## Check the skeleton

```sh
npm run check
npm test
```

`check` runs the configured `node --check` source checks; `test` runs `node --test`. These checks cover the implemented skeleton, not live authentication, two-user isolation, provider eligibility, model execution or deployment acceptance. No `build` command is required.

## Internal provisioning primitive

`src/provisioning.mjs` is the internal companion #5 primitive used by account mode. Every provisioning request validates an opaque proof and requires an exact issuer/subject allowlist match before atomically obtaining the same private companion ID from the metadata store. An internal test constructor can inject synthetic authority/principals; no HTTP request or CLI setting can enable that test injection.

The retained mapping uses a domain-separated SHA-256 issuer/subject key and a random UUID; it does not store the proof or raw principal tuple. The companion ID is an identifier, not an authentication credential. Invalid retained identity state stops provisioning for review instead of silently replacing the ID.

Concurrency, HTTP integration and guard tests use synthetic accounts. Separately, #5 is complete for account-only acceptance: both invited owners reported admission and non-expiry checks passing, and the owner accepted an isolated exact-source expiry test. An actual pilot session timeout remains unobserved. All actual runtime binding and full-pilot obligations remain in #7/#8 and #21.

## Internal account validator

`src/account-validator.mjs` supplies the server-side validator for the discovered account contract. Account mode uses the fixed `http://127.0.0.1:9011/internal/account/session` endpoint and `https://blackoutburst.com` issuer. The input is only a selected central session-cookie value, not an identity assertion or a raw browser header. It forwards that cookie to the account authority, performs fresh validation on every call and returns only the exact issuer/subject tuple. It does not retain a successful principal or expose provider credentials.

The validator disables redirects, bounds its response and timeout, distinguishes an authentication denial from service unavailability and rejects malformed success responses. Tests use temporary synthetic local services only.

The account service's internal-authenticator failure guard was deployed and verified in [account #24](https://board.blackoutburst.com/?thread=9968061425da6965dcc349be308fa289&message=beaa288b997af0bde67e7c51db52274e). Account-only invitation, identity stability and logout/relogin are accepted in #5. Provider revocation and actual private runtime qualification remain open.

## Account-only HTTP candidate

In `account` mode, `POST /api/session` accepts exactly an empty JSON object. It requires an exact trusted Origin, rejects cross-site requests, bounds the body and read time, and accepts only one valid `__Secure-blackout_session` cookie value. Client identity/runtime fields are rejected before validation. A verified invited platform session returns only a companion UUID plus explicit unavailable provider/runtime states. All errors are fixed public messages; responses are no-store. No cookie is issued or renewed, and a companion UUID grants no access. Every future protected operation must validate the central session again.

The web button checks the browser's existing platform cookie without collecting passwords or provider credentials. It links to the existing Blackoutburst account page for login/renewal, and clears its previous identity display after denial or when hidden. Platform sign-in is separate from personal Codex authorization. An account-only local service cannot use a Secure platform cookie from an HTTP browser origin; actual cookie behavior requires a qualified HTTPS proxy and both invited owners.

Private pilot configuration contains only exact central account principals, never names, emails, passwords, cookies or Codex credentials. The schema is `{"principals":[{"issuer":"https://blackoutburst.com","subject":"<central account UUID>"}]}` with one or two distinct principals. Keep the real file and identity values out of source, Board payloads and attachments. On POSIX it must be a current-user-owned regular file with mode `0600`, one link and a current-user-owned mode `0700` parent, outside the checkout, with no symlink components and trusted nonwritable ancestors. Windows CLI account mode fails closed until ACL qualification; local synthetic tests use explicit constructor injection. Detailed file validation lives in `src/pilot-config.mjs`.

The earlier account-only release `9d57d26` is installed behind the dedicated HTTPS preview prefix, with boot startup disabled. This source candidate has not replaced it. The proxy preserves the exact Origin, sets a fixed loopback Host, strips the dedicated prefix and redirects its bare prefix to a trailing slash, because assets/API URLs are relative. The service binds only to loopback and trusts no forwarded identity or host headers. Provider/runtime paths do not exist. See [account staging and retained installation evidence](docs/ACCOUNT-STAGING.md).

## Integration boundaries

Blackoutburst login and the personal Codex connection are separate contracts. Account mode derives companion identity from a validated central account, never a client-supplied account or Board-owner ID. Each user still needs a separate qualified provider/runtime boundary. A synthetic preview cannot establish that external boundary.

The Board remains responsible for project work. Companion conversations, memories, goals and personality stay in a separate private store. They must not enter Board tickets, messages, attachments, metadata or logs. The future Board adapter consumes MCP contracts; this project does not copy or embed the Board executor.

The revised pilot targets two personal Codex runtimes on the existing Blackoutburst home server, which both owners administer through the shared `ubuntu` SSH account. Each runtime still needs its own managed login, credential/state home, saved threads and application binding. Separate directories do not establish isolation from the shared host administrator. Actual runtime registration, application-level cross-user denial and production storage/service boundaries remain unqualified. No commercial plan-sharing form is assumed by default, and no runtime is activated by selecting this direction.

See [foundation interfaces and upstream owners](docs/FOUNDATIONS.md) and [runtime, dependency and license decisions](docs/DEPENDENCIES.md). This candidate does not collect provider credentials or activate a runtime.

## Private-state implementation

The source now includes an account-mode private ledger/API candidate. See [PRIVATE-STATE.md](docs/PRIVATE-STATE.md) for its authenticated contract, ordering/retry semantics, privacy boundaries and verification limits. The running account preview has not been updated to this candidate; runtime connections remain unavailable.

## Personal runtime binding candidate

[PERSONAL-RUNTIME.md](docs/PERSONAL-RUNTIME.md) pins the versioned per-owner registration, authentication, routing and lifecycle consumer contract. `src/runtime-bindings.mjs` is an unwired backend-only metadata registry with a runtime-authority verifier that defaults unavailable. It fences stale generations and keeps authoritative bindings separate from client-writable private-state records. It adds no HTTP route, provider login, process launcher or model call. Synthetic verification is not actual runtime qualification. The owning orchestration contract, protected homes, owner-controlled native connections and real lifecycle/isolation evidence remain required.

## Conversation client candidate

Open `conversation.html` on the local candidate to try the [text-and-links conversation client](docs/CONVERSATION-UI.md). Positive interaction requires explicit `demo` mode and is prominently labelled synthetic replies/no AI. The bounded fixture supports threads, paged incremental replies, reconnect and exact-action retries across two test clients. Account mode freshly checks platform admission but keeps personal Codex and conversation unavailable. Task #9 completed its UI milestone at source `2e2a7eb` after the owner reported desktop/narrow-layout and keyboard checks passing. Actual private-runtime/full-pilot qualification remains separate, and this source has not replaced the deployed account-only preview.

## Private goals and permission cards

`goals.html` provides the [private goal workflow and versioned permission cards](docs/GOALS.md): editable goals/plans/milestones, review/pause controls, saved project-text previews and explicit local consent. Account mode revalidates the owner on every API request; demo state is labelled synthetic and separated from real accounts. Lifetime reservations never reset when a card is edited or reconfirmed. Independent Board authority is unavailable by default; no card or browser operation starts dispatch, a provider, spending or a runtime. Candidate deployment and actual end-to-end pilot qualification remain separate.
