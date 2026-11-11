# C-chan's agent runner (#72)

Super agent plan, part 2/7. C-chan launches sub-agents on Board tickets: "agent X on ticket Y with model Z". Each
run works the ticket headless in the sandbox from #71 ([SANDBOX.md](SANDBOX.md)). The runner enforces the limits,
reports to the Board and confirms cleanup.

## Pieces

| Piece | File | Runs as |
| --- | --- | --- |
| Runner service | `ops/agent-runner/runner-service.mjs`, unit `cchan-agent-runner.service` | `ubuntu` (needs `sudo cchan-sandbox-run`) |
| Run lifecycle, limits | `src/agent-runner.mjs` | in the runner |
| Providers | `src/agent-providers.mjs` | in the runner |
| Sandbox operations | `src/agent-sandbox-ops.mjs` | in the runner, through `sudo cchan-sandbox-run` |
| Board reporting and watch | `src/agent-runner-board.mjs` | in the runner, with its own Board worker identity |
| C-chan's tools and wakes | `src/agent-runner-client.mjs`, `agents_*` tools in `src/scheduler-mcp.mjs` | in the companion |

The runner is its own service because the companion runs with `NoNewPrivileges` and cannot use sudo. It listens
only on a Unix socket, `~/personal-agent-data/agent-runner/runner.sock` (0600). The companion can reach it. Sandboxed
agents cannot see it, because `ProtectHome` hides `/home`.

## A run

1. **Launch.** C-chan calls `agents_launch` with `agent`, `ticketId`, `repo`, `model` (`haiku`, `sonnet`, `opus` or
   `fable`), optional `instructions`, `base`, `maxTurns`, `maxMinutes` and a `requestId`. A retry with the same
   `requestId` returns the same run. One run at a time per ticket and per agent name. Extra launches wait in a FIFO
   queue.
2. **Claim.** The runner reads the ticket and refuses projects outside its config. Then it claims the ticket with its
   own Board identity.
3. **Worktree.** It creates `worktrees/<repo>/<agent>-t<number>` on branch `agent/<agent>/t<number>`. An existing
   branch is resumed.
4. **Runtime execution.** `reserve_execution` and `start_execution` record the run on the Board, which then shows
   capacity and heartbeats. If the Board refuses this (the profile has no Runtime grant), the run continues with lease
   renewals and thread posts, and `run.board.executionError` says why.
5. **Agent.** The runner starts `claude -p --model <id> --max-turns N` as unit `cchan-agent-<run id>` with
   `--max-seconds` (the deadline, as systemd's `RuntimeMaxSec`). The agent gets no MCP servers and no Board access.
   Its prompt is the ticket (description, acceptance criteria) plus C-chan's instructions. It works, tests and commits
   on its branch. Its final message ends with `OUTCOME:` / `EVIDENCE:`, or `BLOCKED:` with one question.
6. **Heartbeats.** Every minute the runner sends `heartbeat_execution`; if the Board says `should_stop`, the run is
   stopped. Every fifth minute it sends `renew_ticket` with a progress line (turn count). If the claim is lost, the
   run stops.
7. **Cleanup.** When the process ends: check the unit is gone (stop it if not), read the branch head and commit
   count, remove the worktree. Cleanup is *confirmed* only when the unit is gone and the worktree removed.
   `finish_execution` reports `cleanup_confirmed` to the Board accordingly.
8. **Board result.**
   - Success: the ticket goes to **review** with the agent's outcome and evidence, plus the runner's summary (model,
     turns, minutes, branch @ head, commits, cleanup) and the `git fetch` line for reviewing the branch.
   - Blocked: a **Needs-you** question goes to the owner.
   - Failure, timeout or stop: the ticket goes back to **todo** with the reason, and the claim is released.
   - Every step is also posted on the ticket's thread.

Run states: `queued`, `preparing`, `running`, `stopping`, then `succeeded`, `blocked`, `failed` (`errorCode`
`MAX_TURNS`, `USAGE_LIMIT`, `NOT_SIGNED_IN`, `PROVIDER_ERROR`, `RUNNER_ERROR`), `timeout`, `stopped`, `cancelled` or
`interrupted`. After a runner restart, a run that was mid-flight has lost its output pipe. The runner stops its unit,
cleans up and reports it `interrupted`. Committed work stays on the branch, and C-chan may relaunch the run, which
resumes the branch.

## Limits

Set in the runner config (`limits`) and capped in code:

| Limit | Default | Hard cap |
| --- | --- | --- |
| `maxConcurrent` (runs at once) | 2 | 4 |
| `maxTurns` (per run) | 80 | 400 |
| `maxSeconds` (deadline per run) | 3600 | 14400 |
| `maxQueued` | 20 | 100 |
| `heartbeatSeconds` | 60 | |

A launch may ask for fewer turns or a shorter deadline, never more. All runs together also stay under the sandbox
slice: 4 CPUs, 6 GB RAM, 1024 tasks.

## Event-driven

C-chan is never woken on a timer for this:

- The runner logs events: `run.queued`, `run.started` and `run.ended` (state, `cleanupConfirmed`).
- A model-free Board watch lists the allowed projects every 20 s (`watchSeconds`). It adds `board.ready` (a ticket's
  dependencies are delivered), `board.review`, `board.done`, `board.blocked` and `board.needs_you`.
- The companion long-polls `GET /events` (`AgentEvents`) and wakes as soon as an event lands. Each batch of `run.ended`
  and `board.*` events becomes one Board wake for C-chan. The wake prompt carries only ids, numbers and states; titles
  stay on the Board. Board wakes keep a 30 s spacing, so the next agent starts within seconds of a run ending or a
  dependency finishing.
- Board wakes and owner chats may use `agents_launch` and `agents_stop`. C-chan's own proactive wakes may not.
- Runner wakes (`agents-…`) start even during the owner's quiet hours, so agents chain at night too. A message C-chan
  writes to the owner from such a wake still waits until quiet hours end.

## Providers

`src/agent-providers.mjs` defines the interface:

```js
{ name, available, models: { alias: modelId },
  command({ model, maxTurns, systemPrompt }) -> { binary, args, env },   // prompt goes on stdin
  parseLine(line) -> [{ type: 'turn'|'tool'|'rate'|'done'|'error', ... }] }
```

- **Claude** (enabled): `/var/lib/cchan-agents/bin/claude -p --output-format stream-json`. It uses the sandbox's own
  login (`CLAUDE_CONFIG_DIR=/var/lib/cchan-agents/claude`) and runs in `bypassPermissions` mode, because the sandbox
  unit is the boundary. It has no MCP servers.
- **Codex** (slot, #77): `available: false`, so a launch with it is refused with `PROVIDER_UNAVAILABLE`. Enabling it
  means:
  - filling in `command` (`codex exec --json` with a sandbox `CODEX_HOME` login);
  - filling in `parseLine` (Codex JSON events to the same event types);
  - adding its models.

  Nothing else changes.

## Runner API (Unix socket, JSON)

| Request | What |
| --- | --- |
| `GET /status` | limits, running/queued counts, Board watch state, projects |
| `GET /runs[?active=1]` | runs (instructions are not returned) |
| `GET /runs/<id>` | one run |
| `POST /runs` | launch (body as above; `maxSeconds` instead of `maxMinutes`) |
| `POST /runs/<id>/stop` | stop: the unit and every child process |
| `GET /events?after=N&wait=S` | events after seq N, waiting up to S ≤ 30 s |

## Setup (once)

1. Install the units (root):
   ```sh
   sudo install -m 0644 ops/agent-runner/cchan-agent-runner.service /etc/systemd/system/
   sudo install -m 0644 ops/personal-agent-account.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
2. Config: copy `ops/agent-runner/config.example.json` to `~/.config/cchan-agent-runner/config.json` and set the
   projects, the Needs-you owner and the limits.
3. Board identity (owner only):
   - Create a worker agent profile for the runner, for example "C-chan · Agents", on the allowed projects, with work
     permissions (and Runtime execution, if wanted).
   - Pair it with `connect.py` into `~/.config/cchan-agent-runner/board`. The credential stays in that folder, and the
     runner never reads it.
4. Sandbox Claude login (owner only, once):
   ```sh
   sudo -u cchan-agents env HOME=/var/lib/cchan-agents/home CLAUDE_CONFIG_DIR=/var/lib/cchan-agents/claude \
     /var/lib/cchan-agents/bin/claude auth login
   ```
5. `sudo systemctl enable --now cchan-agent-runner` and restart the companion.
6. Check: C-chan's `agents_status` shows the limits and `board.ok: true`.

## Known limits

- The finished branch stays in the sandbox's bare clone. Integration (rebase, tests, push as Blackoutburst) happens
  outside the sandbox, by the reviewer flow (#76) or the server agent.
- The agent tools are listed to every companion's tool server, but only the owners in
  `COMPANION_AGENT_RUNNER_OWNERS` get them approved and reach the runner. Others are refused.
- A runner restart interrupts running agents rather than reattaching to them.
- The sandbox has `node` but no working `npm` yet, and worktrees have no `node_modules`, so an agent cannot run
  `npm test` or tests that need npm dependencies (seen in the first end-to-end run, #79). Planned with #78: a
  node+npm toolchain in the sandbox `bin/`, and `npm ci` in new worktrees.
