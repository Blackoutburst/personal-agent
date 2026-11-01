# Personal Agent bootstrap

A local development skeleton for the Blackoutburst personal companion. It contains an original responsive web client, a loopback HTTP server, SQLite metadata/namespace interfaces, an internal provisioning primitive and explicit adapter boundaries. It does not authenticate a Blackoutburst account, run a model, connect to the Board or implement private conversation storage.

The default mode is `unavailable`. An explicit `demo` mode displays synthetic preview data and labels the account and Board adapters `development-double`; provider and runtime remain `unavailable`. Neither mode connects a production service. The preview makes no external service requests and supplies no credentials.

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
| `COMPANION_MODE` | `unavailable` by default; `demo` opts into synthetic preview data. Neither enables a production adapter. |
| `COMPANION_PORT` | Optional local port; defaults to `4318`. |

The external directory contains `bootstrap.sqlite`, a versioned local metadata store. Demo mode writes only its synthetic contract fixture in the `development` namespace. The status API's storage `ready` / `local-bootstrap` state means that this local store opened successfully; it does not establish authenticated tenant storage. The store rejects paths resolving inside the checkout, checks its application/schema version and applies owner-only permissions on POSIX. Windows ACL qualification remains open.

Use synthetic data only. This bootstrap does not implement a production storage boundary, account binding, retention or secret management. Production filesystem ACLs, encryption, revocation and deletion behavior require the separate private-storage qualification in companion #6.

## Check the skeleton

```sh
npm run check
npm test
```

`check` runs the configured `node --check` source checks; `test` runs `node --test`. These checks cover the implemented skeleton, not live authentication, two-user isolation, provider eligibility, model execution or deployment acceptance. No `build` command is required.

## Internal provisioning primitive

`src/provisioning.mjs` is an unwired development primitive for companion #5. A trusted internal caller must inject a validator; without one, validation is unavailable. Every provisioning request validates an opaque proof and requires an exact issuer/subject allowlist match before atomically obtaining the same private companion ID from the metadata store.

The retained mapping uses a domain-separated SHA-256 issuer/subject key and a random UUID; it does not store the proof or raw principal tuple. The companion ID is an identifier, not an authentication credential. Invalid retained identity state stops provisioning for review instead of silently replacing the ID.

No HTTP authentication or provisioning route, cookie parser or real-account connection is added. The development validator used by synthetic tests is not a production identity authority. Concurrency and guard tests exercise the primitive only; they do not qualify a real pilot. Account #23's source/interface discovery is complete; companion #5 remains incomplete until real account and owner-runtime binding are integrated and verified.

## Internal account validator

`src/account-validator.mjs` supplies an unwired server-side validator for the discovered account contract. Its trusted configuration selects the literal-loopback `/internal/account/session` endpoint and fixed issuer. The input is only a selected central session-cookie value, not an identity assertion or a raw browser header. It forwards that cookie to the account authority, performs fresh validation on every call and returns only the exact issuer/subject tuple. It does not retain a successful principal or expose provider credentials.

The validator disables redirects, bounds its response and timeout, distinguishes an authentication denial from service unavailability and rejects malformed success responses. No server route imports or calls it; default and demo modes keep their existing unavailable/synthetic boundaries. Tests use temporary synthetic local services only. A proposed consumer factory does not establish a live account connection.

The current account service has an uncaught internal-authenticator error path. This validator must deny access on connection loss; that behavior does not repair the account service's failure containment. The owning fix and reviewed deployment remain production release gates, along with real pilot invitation/owner bindings, logout/revocation and private runtime qualification. See the [current contract handoff](https://board.blackoutburst.com/?thread=95868bf09f5e19d5701f0d2cc7ef2d07&message=36d3467c1782acfb7a2d4ddd98aa4cb3).

## Integration boundaries

Blackoutburst login and the Codex subscription connection are separate contracts. The app must eventually derive its companion identity from a validated central account, never a client-supplied account or Board-owner ID. Each user needs a separate qualified provider/runtime boundary. A synthetic preview cannot establish any of these properties.

The Board remains responsible for project work. Companion conversations, memories, goals and personality stay in a separate private store. They must not enter Board tickets, messages, attachments, metadata or logs. The future Board adapter consumes MCP contracts; this project does not copy or embed the Board executor.

The revised pilot targets two personal Codex runtimes on the existing Blackoutburst home server, which both owners administer through the shared `ubuntu` SSH account. Each runtime still needs its own managed login, credential/state home, saved threads and application binding. Separate directories do not establish isolation from the shared host administrator. Actual runtime registration, application-level cross-user denial and production storage/service boundaries remain unqualified. No commercial plan-sharing form is assumed by default, and no runtime is activated by selecting this direction.

See [foundation interfaces and upstream owners](docs/FOUNDATIONS.md) and [runtime, dependency and license decisions](docs/DEPENDENCIES.md). This bootstrap handles no live credentials and performs no deployment or runtime activation.
