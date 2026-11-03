# Historical account-only staging gate

The owner approved account-only staging and the #5 acceptance split on 1 November 2026. That milestone used the reviewed [operator source](../ops/account-preview/README.md) and exact generated, SHA-pinned bundle/command in Board task #5, superseding the manual proposal below. Those inputs are archived history, not current release commands: **do not rerun them against the native companion**. Use [OPERATIONS.md](OPERATIONS.md) for current operations.

Everything below records the original proposal and its evidence limits. Statements about absent runtimes, proposed HTTPS placement, boot-disabled startup or incomplete #5 refer to that earlier milestone. The server lead has since confirmed HTTPS, boot startup and the releases/current layout; the current runbook records that confirmation separately from the new release-tool drill still owed by the operator. Account #24's separately authorized production error guard is independent.

## Original proposed placement

- Host: existing home server `blackoutburst.com`, shared trusted administrator `ubuntu`.
- Source: `/home/ubuntu/personal-agent/releases/<verified-source-commit>/`, deployed from the attached source archive and checked against its SHA256. Keep the prior release for rollback.
- Private metadata: `/home/ubuntu/personal-agent-data/`, mode `0700`, owned by ubuntu; existing BootstrapStore enforces private SQLite file modes on POSIX. Contains only companion identity mappings at this stage.
- Private configuration: `/home/ubuntu/personal-agent-config/pilot.json`, file mode `0600`, directory mode `0700`, ubuntu-owned. Populate only the two intended existing central-account UUIDs privately. Do not paste identifiers, cookies or account records into Board messages. No provider credentials are requested.
- Interpreter: existing root-owned `/opt/blackoutburst-platform-runtime/node-v24.22.1`, whose version must be checked before installation.
- Listener: `127.0.0.1:4318` (free at the read-only preflight); mode `account`, fixed public Origin `https://blackoutburst.com`.
- Public staging path: proposed `https://blackoutburst.com/personal-agent-preview/`, via a dedicated exact prefix in the existing HTTPS virtual host. Inspect the installed complete virtual host before editing to rule out conflicting locations. A no-slash request redirects to the slash; proxy strips the prefix and supplies the fixed loopback Host. Do not expose `/internal/account/session` or add account CORS origins.

The candidate's `ops/personal-agent-account.service` and `ops/personal-agent-preview.conf` are proposed operator inputs. The root-owned nginx include and system service require privileged installation. The worker cannot perform a passwordless sudo operation on this host; an operator must install/reload these reviewed files, or explicitly provide an appropriate existing privileged execution path. Do not send a sudo password through Board.

## Original installation sequence (historical, do not execute)

1. Pin the delivered source commit/archive hash, unpack a new release, run `node --version`, source checks and synthetic tests with the pinned interpreter. No dependency installation is needed.
2. Create the two private directories with ubuntu ownership and mode `0700`. Obtain only the two intended existing central UUIDs through the account operator's private administration, and write the exact pilot schema in README with mode `0600`. Do not extract sessions/passwords/tokens, create accounts or emit identifier values in logs/receipts. Validate the file with `loadPilotSubjects` without printing it.
3. Render the reviewed service template by replacing its source-release placeholder with the exact release path. Confirm the unit name is unused; if it already exists, stop for operator review instead of replacing it. Retain a unit/enablement snapshot. Install the system unit, reload systemd and start only `personal-agent-account.service`; leave it disabled at boot unless separately approved. Check service status and the loopback status endpoint; anonymous/invalid session POSTs must deny access with no-store.
4. Back up the existing nginx include; add only the dedicated preview locations in the existing HTTPS server block, run `nginx -t`, then reload nginx. Access logging is disabled for the new prefix; inherited error-log behavior must be reviewed separately before any real pilot session, without logging credentials, request bodies or private account identifiers. Recheck the existing account health and public internal-route denial. Do not apply unrelated virtual-host edits.
5. Each invited owner independently signs in through the existing platform account page and checks the preview. Do not collect their cookie/credentials in chat or Board. Record only sanitized pass/fail evidence: stable companion on repeat/concurrent checks; distinct two-owner identities; unsigned/uninvited rejection; logout/expiry/reset revocation on the next request; service-unavailable denial. Real account lifecycle changes require each owner's participation/authorization; synthetic expiry/reset tests do not substitute for those real checks.
6. Keep personal Codex, private conversation storage and runtime registration unavailable. No provider login, runtime installation, model invocation or private-history access is part of this gate.

## Original rollback and acceptance limits

If staging checks fail, stop the new companion unit and restore the prior unit/enablement snapshot (including the absent-unit baseline for a new installation), then reload systemd. Restore the preview nginx include from its saved copy, checking `nginx -t` before reload. Retain private metadata and the previous source release; do not delete account/session data or rewrite identity mappings. The account service guard deployed under account #24 is independent and stays in place.

Account mode passing synthetic tests qualifies the candidate's implemented guards, not real HTTPS cookie behavior, actual pilot admission, production tenant isolation or personal-runtime ownership. Companion #5 is not complete on this artifact alone. Under the approved split, runtime ownership/rebinding/credential routing remains with #7 and execution/events/history isolation/recovery with #8. Those obligations were retained, not waived; dependency edges remain unchanged.
