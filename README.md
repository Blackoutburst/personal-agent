# Personal Agent bootstrap

A local candidate for the Blackoutburst personal companion. It contains a responsive web client, a loopback HTTP server, SQLite metadata/namespace interfaces and an account-to-companion integration. Personal Codex, Board access and private conversations remain unavailable.

The default mode is `unavailable`. An explicit `demo` mode displays synthetic preview data and labels the account and Board adapters `development-double`. Neither mode contacts an account authority. Explicit `account` mode enables fresh platform-session checks and invited-user provisioning only; provider and runtime stay unavailable in every mode. The new account candidate has synthetic end-to-end tests; real pilot acceptance and companion deployment are still unqualified.

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

Local development uses synthetic data. The account mapping does not qualify production private conversation storage, retention or secret management. Production filesystem ACLs, encryption, revocation and deletion behavior require the separate private-storage qualification in companion #6.

## Check the skeleton

```sh
npm run check
npm test
```

`check` runs the configured `node --check` source checks; `test` runs `node --test`. These checks cover the implemented skeleton, not live authentication, two-user isolation, provider eligibility, model execution or deployment acceptance. No `build` command is required.

## Internal provisioning primitive

`src/provisioning.mjs` is the internal companion #5 primitive used by account mode. Every provisioning request validates an opaque proof and requires an exact issuer/subject allowlist match before atomically obtaining the same private companion ID from the metadata store. An internal test constructor can inject synthetic authority/principals; no HTTP request or CLI setting can enable that test injection.

The retained mapping uses a domain-separated SHA-256 issuer/subject key and a random UUID; it does not store the proof or raw principal tuple. The companion ID is an identifier, not an authentication credential. Invalid retained identity state stops provisioning for review instead of silently replacing the ID.

Concurrency, HTTP integration and guard tests use synthetic accounts; they do not qualify a real pilot. Companion #5 remains incomplete until real account admission and owner-runtime binding are integrated and verified.

## Internal account validator

`src/account-validator.mjs` supplies the server-side validator for the discovered account contract. Account mode uses the fixed `http://127.0.0.1:9011/internal/account/session` endpoint and `https://blackoutburst.com` issuer. The input is only a selected central session-cookie value, not an identity assertion or a raw browser header. It forwards that cookie to the account authority, performs fresh validation on every call and returns only the exact issuer/subject tuple. It does not retain a successful principal or expose provider credentials.

The validator disables redirects, bounds its response and timeout, distinguishes an authentication denial from service unavailability and rejects malformed success responses. Tests use temporary synthetic local services only.

The account service's internal-authenticator failure guard was deployed and verified in [account #24](https://board.blackoutburst.com/?thread=9968061425da6965dcc349be308fa289&message=beaa288b997af0bde67e7c51db52274e). Real pilot invitation/owner bindings, logout/revocation and private runtime qualification remain open.

## Account-only HTTP candidate

In `account` mode, `POST /api/session` accepts exactly an empty JSON object. It requires an exact trusted Origin, rejects cross-site requests, bounds the body and read time, and accepts only one valid `__Secure-blackout_session` cookie value. Client identity/runtime fields are rejected before validation. A verified invited platform session returns only a companion UUID plus explicit unavailable provider/runtime states. All errors are fixed public messages; responses are no-store. No cookie is issued or renewed, and a companion UUID grants no access. Every future protected operation must validate the central session again.

The web button checks the browser's existing platform cookie without collecting passwords or provider credentials. It links to the existing Blackoutburst account page for login/renewal, and clears its previous identity display after denial or when hidden. Platform sign-in is separate from personal Codex authorization. An account-only local service cannot use a Secure platform cookie from an HTTP browser origin; actual cookie behavior requires a qualified HTTPS proxy and both invited owners.

Private pilot configuration contains only exact central account principals, never names, emails, passwords, cookies or Codex credentials. The schema is `{"principals":[{"issuer":"https://blackoutburst.com","subject":"<central account UUID>"}]}` with one or two distinct principals. Keep the real file and identity values out of source, Board payloads and attachments. On POSIX it must be a current-user-owned regular file with mode `0600`, one link and a current-user-owned mode `0700` parent, outside the checkout, with no symlink components and trusted nonwritable ancestors. Windows CLI account mode fails closed until ACL qualification; local synthetic tests use explicit constructor injection. Detailed file validation lives in `src/pilot-config.mjs`.

No companion proxy/service is installed by this source change. A future HTTPS staging plan must preserve the exact Origin, set a fixed loopback Host, strip a dedicated prefix and redirect its bare prefix to a trailing slash, because assets/API URLs are relative. The service itself binds only to loopback and trusts no forwarded identity or host headers. Provider/runtime paths do not exist. See `docs/ACCOUNT-STAGING.md` for the proposed reviewable deployment and acceptance gate.

## Integration boundaries

Blackoutburst login and the Codex subscription connection are separate contracts. The app must eventually derive its companion identity from a validated central account, never a client-supplied account or Board-owner ID. Each user needs a separate qualified provider/runtime boundary. A synthetic preview cannot establish any of these properties.

The Board remains responsible for project work. Companion conversations, memories, goals and personality stay in a separate private store. They must not enter Board tickets, messages, attachments, metadata or logs. The future Board adapter consumes MCP contracts; this project does not copy or embed the Board executor.

The revised pilot targets two personal Codex runtimes on the existing Blackoutburst home server, which both owners administer through the shared `ubuntu` SSH account. Each runtime still needs its own managed login, credential/state home, saved threads and application binding. Separate directories do not establish isolation from the shared host administrator. Actual runtime registration, application-level cross-user denial and production storage/service boundaries remain unqualified. No commercial plan-sharing form is assumed by default, and no runtime is activated by selecting this direction.

See [foundation interfaces and upstream owners](docs/FOUNDATIONS.md) and [runtime, dependency and license decisions](docs/DEPENDENCIES.md). This candidate does not collect provider credentials or activate a runtime.
