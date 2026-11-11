# C-chan's agent sandbox (#71)

Super agent plan, part 1/7. C-chan dispatches Board work to sub-agents she creates (#73), launched by the runner
(#72). Those agents run here, isolated from the owners' credentials, production services and the other companions'
data. The server is small (8 cores, 16 GB RAM, GTX 1060), so everything they run shares one resource ceiling.

## What it is

- **User** `cchan-agents` (system user, locked password, `nologin` shell, no sudo). The owner account `ubuntu` is in
  its group, so it can read results (branches, logs) without sudo.
- **Root** `/var/lib/cchan-agents` (0750, owned by the sandbox user):
  - `home/`: `HOME` of every agent process (git identity "C-chan agents").
  - `claude/`: `CLAUDE_CONFIG_DIR`, the sandbox's own Claude Code login. It is empty until the owner signs in once
    (#72). No owner credential is ever copied in.
  - `repos/<repo>.git`: bare clones of the allowed repos over public HTTPS. The allowlist is `repos.json`
    (`{"name": "url"}`) when present, else `personal-agent` and `agent-board`.
  - `worktrees/<repo>/<agent>-t<ticket>/`: one Git worktree per agent and ticket, on branch `agent/<agent>/t<ticket>`.
  - `bin/`: root-owned `node` and `claude`, so agents cannot replace their own tools.
  - `logs/`: run logs (#72).
- **Slice** `cchan-agents.slice`: CPUQuota 400 % (4 of 8 cores), MemoryHigh 5 G, MemoryMax 6 G, TasksMax 1024, for
  all agents together.
- **Hardening** `ops/sandbox/properties` (installed at `/usr/local/lib/cchan-sandbox/properties`), applied to every
  sandbox process:
  - `ProtectHome=yes`: `/home`, `/root` and `/run/user` are empty.
  - `TemporaryFileSystem` over `/var/lib`, `/opt`, `/srv`, `/mnt` and `/media`, with only `/var/lib/cchan-agents`
    bound back. Other services' data (TheScreamer's agent host, agent pool, lead, mail, Postgres, Let's Encrypt,
    Forma, IBKR) does not exist in there.
  - `InaccessiblePaths` for logs, mail, spools, backups, caches and TLS keys.
  - `ProtectSystem=strict`: everything is read-only except the sandbox root.
  - `ProtectProc=invisible`: other users' processes (and their command lines and environments) are hidden.
  - `PrivateTmp`, `PrivateDevices`, `NoNewPrivileges` (no sudo/setuid), no capabilities, `RestrictNamespaces`, and
    the kernel/cgroup/clock protections.
  - Network: allowed (GitHub, npm, the model API).

## How to run something in it

Always go through systemd. The Unix permissions alone are not the boundary: `/home/ubuntu` is traversable (0711),
and other services keep world-readable files.

```sh
sudo cchan-sandbox-run [--cwd DIR] [--max-seconds N] [--unit NAME] -- command args...
```

Each call is its own transient unit inside `cchan-agents.slice`. It gets the hardening above, a working directory
under the sandbox root and a hard deadline (`RuntimeMaxSec`, default 1 h). Stopping the unit kills everything the
command started. stdin, stdout and stderr pass through, and the exit status is the command's.

Worktrees (JSON out, exit 2 on refusal):

```sh
W="sudo cchan-sandbox-run -- /var/lib/cchan-agents/bin/node /usr/local/lib/cchan-sandbox/ops/sandbox/worktree.mjs"
$W create --repo personal-agent --agent coder-1 --ticket 72 [--base main]   # fetch, then a new worktree/branch
$W remove --repo personal-agent --agent coder-1 --ticket 72 [--delete-branch]
$W list
$W sync --repo personal-agent
```

A worktree whose branch already exists (a resumed run) checks that branch out again. Removing a worktree discards
uncommitted files but keeps the branch for review, unless `--delete-branch` is passed.

## How the runner (#72) uses it

1. For a launch request (agent X, ticket Y, model Z): `worktree.mjs create` for the ticket's repo.
2. Start headless Claude Code in that worktree as its own unit:
   `cchan-sandbox-run --unit cchan-agent-<agent>-t<ticket> --cwd <worktree> --max-seconds <deadline> -- claude -p ...`.
   The model, max turns and tools are `claude` flags. Concurrency is the runner's own counter, under the slice ceiling.
   The unit name doubles as the run id: `systemctl is-active` is its status, `systemctl stop` stops it and kills every
   child process.
3. When the run ends: confirm the unit is gone, then `worktree.mjs remove`, and report cleanup to the Board.
4. Publishing: the sandbox holds no GitHub or SSH credentials. The finished branch stays in
   `/var/lib/cchan-agents/repos/<repo>.git`. Review and integration (rebase, tests, push as Blackoutburst) happen
   outside the sandbox, by the reviewer flow (#76) or the server agent.

`cchan-sandbox-run` needs root (systemd-run on the system manager). The companion service runs with
`NoNewPrivileges` and cannot use sudo. The runner therefore runs as its own small service (#72) rather than inside
the companion process.

## Tests and the verification browser in a worktree (#78)

A fresh worktree has no `node_modules`. Run `node ops/sandbox/install-deps.mjs` once: it installs the lock file's pinned
packages into `/var/lib/cchan-agents/deps/<lock sha256>` and links `./node_modules`, so `node --test` passes. The
browser used to operate the app is set up by `node ops/verify/verify.mjs setup`; see [VERIFICATION.md](VERIFICATION.md).

## Install, update and verify

```sh
sudo ops/sandbox/setup.sh                                    # idempotent; also refreshes node/claude/tools
sudo cchan-sandbox-run -- /usr/local/lib/cchan-sandbox/verify.sh
```

`verify.sh` prints one line per check, never any file content. It checks that the owners' homes and credentials,
other services' data, TLS keys, logs, mail, `/root`, `/etc/shadow` and other users' processes are unreadable. It also
checks that the sandbox can write its root, has no sudo, and can run node, claude, git and reach GitHub.

## Known limits

- Loopback services (the companion on 4318, Postgres, Dovecot, game servers) are reachable over TCP. Agents need
  loopback for their own test servers. Each of those services requires its own login.
- World-readable system config under `/etc` (for example Postfix's `main.cf`) stays visible, as on any Linux host.
  Secrets there are root-only and stay unreadable.
- `claude` is a copy of the server's current version. Re-run `setup.sh` to update it (`DISABLE_AUTOUPDATER=1` inside).
