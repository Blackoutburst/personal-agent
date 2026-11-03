# Companion operations

This is the runbook for the existing invitation-only companion. In the task #20 operator
answer of 3 November 2026, Claude confirmed that HTTPS at
`https://blackoutburst.com/personal-agent-preview/`, boot startup, the releases/current
layout and manual private SQLite backups were already working. He reported live source
`ccfbcd3`. These are operator-reported facts, not checks performed by this source change.
The accepted `f998506` merge adds #19 tests/docs without application changes.

Do not reinstall the service/proxy, recreate pilot accounts or rerun archived task #5
installers. [ACCOUNT-STAGING.md](ACCOUNT-STAGING.md) and `ops/account-preview/` retain that
historical workflow; their pinned manifests and rollback assumptions are not current
release inputs. The server lead reviews/merges this tool, then owns the actual release,
rollback and backup-to-restore drill. Source tests do not complete those operator actions.

## Existing locations

These paths describe the source unit and existing layout; listing a path here does not
authorize reading its private contents. The operator reconciles any installed overrides.

| Location | Purpose |
| --- | --- |
| `~/src/personal-agent` | Operator's source repository; release archives come from verified Git revisions. |
| `~/personal-agent/releases/<full-sha>` | Source release directories; treat them as immutable. |
| `~/personal-agent/current` | Symlink to the selected release. One service opens the private data. |
| `~/personal-agent/backups/<timestamp>-<random>/` | Private backup sets created by the release tool. |
| `~/personal-agent-data/bootstrap.sqlite` and `files/` | Private database and attachment bytes, outside source/static routes. |
| `~/personal-agent-data/runtimes/<label>/workspace/` | Owner-native SOUL/USER/MEMORY/diary, inbox and other workspace files. |
| `~/personal-agent-config/pilot.json` | Existing private invitation configuration; not a backup input. |
| `~/.config/personal-agent/owners.json` | Existing private account-to-runtime configuration; never read/copied by this tool. |
| `runtimes/<label>/claude-home`, `codex-home`; `~/.config/personal-agent/` | Provider logins, paired Board configuration and other private configuration. Entirely excluded. |

The current unit source is `ops/personal-agent-account.service`: Node 24.22.1, loopback
4318, `personal-agent-account.service`, `Restart=on-failure` and boot enablement through
`multi-user.target`. `ops/personal-agent-preview.conf` is an include for the existing HTTPS
vhost, including upload/companion-edit body limits and denial of `/internal/`. Neither is
installed or reloaded by the release tool. Configuration/login changes remain separately
authorized owner/operator work; never print their contents into logs, Git or Board.

## Before an operator release

Review the exact revision, compatible rollback target and private backup retention. Use
the pinned runtime and run the existing gates from the candidate source:

```sh
node --version
npm run check
npm run test:isolation
npm test
```

There is no npm dependency installation or application build step. See
[ISOLATION-TESTS.md](ISOLATION-TESTS.md) for synthetic accounts/fake providers, Linux storage
checks and the shared-UID application boundary. A green suite does not establish actual
provider sign-in, entitlement, arbitrary model privacy or deployed readiness.

The operator must be able to stop and join the existing service and all native turns
before copying/restoring private state or opening it with another version. Do not run a
second instance, a rolling overlap or a competing scheduler/Discord/Board process. A
process using the same shared data/workspaces outside systemd must also be stopped.

## Release tool

Run `ops/release.mjs` from the reviewed source using Node 24.22.1. The CLI supports:

```sh
node ops/release.mjs release          # HEAD
node ops/release.mjs release <rev>    # verified Git revision
node ops/release.mjs rollback
node ops/release.mjs backup
node ops/release.mjs restore <set>
```

| Environment variable | Default / meaning |
| --- | --- |
| `COMPANION_RELEASE_ROOT` | `~/personal-agent`; contains releases, backups, current/previous links and the operation lock. |
| `COMPANION_DATA_DIR` | `~/personal-agent-data`; matches the current unit. |
| `COMPANION_RUNTIME_DIR` | `<COMPANION_DATA_DIR>/runtimes`; the nested current-unit layout is supported. |
| `COMPANION_RELEASE_REPO` | Checkout containing the tool; set explicitly if using another source repository. |
| `COMPANION_SYSTEMCTL` | `/usr/bin/systemctl`; an absolute executable receiving only `stop`/`start` and `personal-agent-account.service`. |
| `COMPANION_HEALTH_URL` | `http://127.0.0.1:4318/api/status`; only literal-loopback HTTP with that exact path and no credentials/query/fragment. |

Use the data-owning service account and explicit paths matching the installed unit. The
tool requires current-user-owned regular files and refuses linked/shared/unsafe objects;
do not run the entire tool as root or weaken file permissions to bypass a refusal.
Service-control authorization remains the operator's existing arrangement. Setting
`COMPANION_SYSTEMCTL` does not grant privilege or install a sudo rule; an unauthorized
command fails. Neither this runbook nor source delivery authorizes new host privileges.

On the current server the operator already has passwordless sudo, so it uses the checked-in
`ops/systemctl-sudo` helper, which forwards only `stop`/`start` of
`personal-agent-account.service` to `sudo -n systemctl` and refuses anything else:

```sh
cd ~/src/personal-agent
COMPANION_SYSTEMCTL=$PWD/ops/systemctl-sudo /opt/blackoutburst-platform-runtime/node-v24.22.1 ops/release.mjs release
```

Releases made before this tool used short-SHA directory names and an absolute `current`
link; the tool refuses those, so `current` was moved once to a `releases/<full-sha>` copy of
the same commit before the first tool release (3 November 2026).

When invoking the tool through `current/ops/release.mjs`, set `COMPANION_RELEASE_REPO` to
the actual Git checkout: an archived release has no `.git` directory. Both release and
rollback compare an existing cached target with a fresh archive from that checkout.

For synthetic callers, `createReleaseTool({repoDir, rootDir, dataDir, runtimeDir, service,
health, now})` injects service control and health checks. This is a testing seam, not a
browser/API administration route. No command enables boot startup, signs into a provider,
reads runtime configuration or deploys on the PC.

Every operation holds `<root>/.release-lock`. Another operation refuses rather than racing;
a crash can leave a stale lock. The operator must establish that no tool/service writer is
active before removing one. Never automatically take over a lock or run a second root
against the same private data. Service-stop completion must mean all writers/native
children have joined; an injected callback which merely signals them is insufficient.

`release` resolves the revision to a full commit and stages its Git archive before stopping
the service. It snapshots private state while stopped, updates `previous`/`current`, then
starts and checks health. `rollback` selects the recorded previous release and uses the
same backup/switch/start flow; a missing previous target refuses. Review compatibility
before either command. An existing cached release is compared with its canonical Git
archive before use; that byte check does not establish semantic/client compatibility.
The tool does not run the source gates for you.

On a release/start/health failure, it stops the attempted process, restores the original
links, and starts/checks the original release. This recovery restores **code selection**,
not a SQLite/workspace snapshot; retain the pre-change set and require compatible readers.
An initial release with no original `current` has no invented fallback: a failed attempt
leaves the links absent and service stopped. `backup` also stops/snapshots/starts/checks;
it attempts service recovery if snapshot creation or restart fails.

## Backup set and consistency

A timestamped set contains `manifest.json`, a `bootstrap.sqlite` produced with SQLite
`VACUUM INTO`, optional `files/` and `workspaces/<label>/`. The workspace copy contains
native memory/personality/diary and inbox files, not the adjacent provider homes. The
database, attachment tree and workspaces must represent the same quiesced service state;
copying a live database alone or a workspace while a native turn writes is insufficient.

Sets/directories are private mode `0700`; files are `0600`. The database itself can contain
private Discord credentials, conversation/history and other secrets. Treat the entire set,
including its manifest and filenames, as private; keep it outside releases/public storage
and Board attachments. A memory export contains USER/MEMORY/diary only and does **not**
replace the database/files/workspace backup.
Sets exceeding 200,000 file entries, 200,000 directory entries or a 16 MiB manifest refuse
rather than publish a truncated backup.

Provider homes and **all** of `~/.config/personal-agent/` (logins, tokens, `owners.json`,
paired configuration) are never read or copied. Pilot configuration, service/proxy files
and native provider retention are also outside the set. Restoring data does not restore
logins/configuration: the operator retains those independently without supplying them to
this tool. Do not follow a workspace symlink into any excluded location.

Restore is an operator-controlled replacement of the included data/workspace state, not
a merge and not secure erasure. Newer chat, attachments, memory or receipts can be lost
when selecting an older set; preserve a fresh complete set and make the retention choice
explicit. Do not manually overlay an old SQLite file on newer binaries/workspaces or copy
WAL/SHM sidecars from a different point in time.

`backup` returns its completed absolute set path as a JSON string. `restore <set>` accepts
that path or its set basename directly beneath this root's `backups/`; arbitrary outside
paths, unexpected payload paths and size/hash mismatches refuse. The private manifest is
trusted input, not a signed authenticity proof against someone rewriting it and its hashes.
Restore validates and rehashes the set,
stages it, stops/joins the service and snapshots the pre-restore state before swapping.
Included workspace directories and the attachment tree are replaced exactly; owner labels
not included in that set are left alone, and excluded provider/configuration trees are
never overlaid. Old SQLite sidecars are kept apart from the restored database.

Because provider homes retain their newer native state, the staged **live restored copy**
clears `conv_threads.provider_session` and resets `session_turns` before startup. The next
owner turn starts a fresh native session with restored context. This does not modify the
backup set, erase chats/memory or read/remove provider-held sessions. A failed restore
reinstates the original held database/files/workspaces and resume mappings, then starts
and checks that original state. A successful restore keeps the pre-restore backup and
removes the temporary held originals.

Success is JSON on stdout: release/rollback return `current`, `previous` and `backup`;
restore returns `restored`, the pre-restore `backup` and `sessionsReset:true`. Errors exit
nonzero with fixed error JSON, without dumping arbitrary process output or private state.
`HEALTH` means the attempted state failed its check and recovery was attempted; it is not
a successful release receipt. `RECOVERY` requires manual intervention: do not assume the
service is stopped or healthy even after its best-effort stop, do not blindly retry, and
have the operator stop/join it
before inspecting preserved backups, links and any `.restore-old-*` objects. Keep original
data until recovery is understood; never delete it to make another command pass. `SET`,
`UNSAFE`, `LOCKED`, `SOURCE`, `BACKUP` or `SERVICE` failures must be reconciled before retry.

## Compatible rollback

Migrations must stay additive: preserve identity mappings, private tables/columns,
receipts, files and native workspace contents. An unchanged bootstrap schema number or a
successful SQLite open is not a compatibility check. Source rollback normally keeps data;
it must not drop new tables, rewrite roles or erase private records to make old code run.

Known historical lower bounds are contacts `0c685c536ebeebc42afe9ba9833718e284750de8`
(AGENTS v7 and attributed untrusted peer cards) and release watches
`12b15ce9a86a47e9757d49c55caff7476df88482` (AGENTS v8). Do not roll back to strict readers
that reject/misattribute peer messages or reinterpret watch occurrences. Older routine
code can ignore its separate tables, but that narrow compatibility proof does not make
an arbitrary older companion release safe.

For initial review of this tool, operator-confirmed `ccfbcd3` is the concrete current-feature
baseline; `f998506` changes only #19 tests/docs. This baseline has AGENTS v12 and the
accepted file, memory/personality, contact, watch, Board and Discord handling. The two
historical commits above are not universal rollback floors. Every later rollback target
must retain all readers/protocols required by the retained data and current clients,
including peer-as-untrusted-data handling and attachment metadata. Review AGENTS/session
refresh behavior too; a numerically older instruction version is not automatically safe.

The tool does not infer semantic schema/client compatibility from ancestry. If the previous
release is incompatible, do not select it: keep service stopped for an operator recovery
decision, or choose a separately reviewed compatible release/consistent backup pair.
Never downgrade live clients to a peer-unaware reader merely to restart the service.

## Operator evidence and retained limits

After review/merge, Claude records one real release through the tool, one compatible
rollback and one backup-to-restore drill. Record sanitized revision/set identifiers,
stop/start and health outcomes, automatic recovery outcome if exercised, retained data
checks and any failure requiring manual recovery. Never attach the private set, request
bodies, owner identifiers, credentials or native transcripts as public evidence.

`/api/status` establishes HTTP/storage readiness, not Git identity or either owner's
provider login. Verify the selected release separately and let each owner perform any
needed real sign-in or private pilot checks. Installed HTTPS/boot state is not re-proved
by these source changes. #20 closes on the server lead's actual operator evidence, not on
source delivery or an all-green synthetic run.
