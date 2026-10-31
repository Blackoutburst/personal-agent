# Personal Agent bootstrap

A local development skeleton for the Blackoutburst personal companion. It contains an original responsive web client, a loopback HTTP server, SQLite metadata/namespace interfaces and explicit adapter boundaries. It does not authenticate a Blackoutburst account, run a model, connect to the Board or implement private conversation storage.

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

`check` runs `node --check` over the server, store, adapters and client script; `test` runs `node --test`. These checks cover the implemented skeleton, not live authentication, two-user isolation, provider eligibility, model execution or deployment acceptance. No `build` command is required.

## Integration boundaries

Blackoutburst login and the Codex subscription connection are separate contracts. The app must eventually derive its companion identity from a validated central account, never a client-supplied account or Board-owner ID. Each user needs a separate qualified provider/runtime boundary. A synthetic preview cannot establish any of these properties.

The Board remains responsible for project work. Companion conversations, memories, goals and personality stay in a separate private store. They must not enter Board tickets, messages, attachments, metadata or logs. The future Board adapter consumes MCP contracts; this project does not copy or embed the Board executor.

See [foundation interfaces and upstream owners](docs/FOUNDATIONS.md) and [runtime, dependency and license decisions](docs/DEPENDENCIES.md). This bootstrap selects no hosted subscription route, handles no live credentials and performs no deployment or runtime activation.
