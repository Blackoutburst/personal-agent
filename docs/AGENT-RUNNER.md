# C-chan's agent runner (#72) and roster (#73)

Super agent plan, part 2/7. C-chan launches sub-agents on Board tickets: "agent X on ticket Y with model Z". Each
run works the ticket headless in the sandbox from #71 ([SANDBOX.md](SANDBOX.md)). The runner enforces the limits,
reports to the Board and confirms cleanup.

## Pieces

| Piece | File | Runs as |
| --- | --- | --- |
| Runner service | `ops/agent-runner/runner-service.mjs`, unit `cchan-agent-runner.service` | `ubuntu` (needs `sudo cchan-sandbox-run`) |
| Run lifecycle, limits | `src/agent-runner.mjs` | in the runner |
| Agent roster (agents, teams, policy) | `src/agent-roster.mjs`, state `~/personal-agent-data/agent-runner/roster.json` | in the runner |
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
     turns, minutes, branch @ head, commits, cleanup) and the `git fetch` line for reviewing the branch (with `--upload-pack` setting
     `safe.directory`, because the bare clone belongs to `cchan-agents`; the reviewer needs the `cchan-agents` group).
   - Blocked: a **Needs-you** question goes to the owner.
   - Failure, timeout or stop: the ticket goes back to **todo** with the reason, and the claim is released.
   - Every step is also posted on the ticket's thread.

Run states: `queued`, `preparing`, `running`, `stopping`, then `succeeded`, `blocked`, `failed` (`errorCode`
`MAX_TURNS`, `USAGE_LIMIT`, `RATE_LIMITED`, `NOT_SIGNED_IN`, `PROVIDER_ERROR`, `RUNNER_ERROR`), `timeout`, `stopped`,
`cancelled` or `interrupted`.

`USAGE_LIMIT` (the subscription quota is used up) and `RATE_LIMITED` (a transient API rate limit or overload, such as
429 or 529) are not code failures. The run carries `retryAt` when the provider said when the quota resets. The
`run.ended` event carries `errorCode` and `retryAt`, and C-chan's wake says to pause and relaunch after that time
instead of treating it as the agent's fault. The Board execution ends with `quota_or_rate_limit`. After a runner restart, a run that was mid-flight has lost its output pipe. The runner stops its unit,
cleans up and reports it `interrupted`. Committed work stays on the branch, and C-chan may relaunch the run, which
resumes the branch.

## Roster (#73)

C-chan does not have one static agent. She keeps a roster of the agents she needs, and every launch must name one of
them. The runner stores the roster and enforces it.

| Field | Meaning |
| --- | --- |
| `name` | `coder-1`, `rev-1`, ...; also the branch name `agent/<name>/t<number>` |
| `role` | `coder` (actions `work` + `commit`), `reviewer` (action `review`) or `merger` (action `merge`, #85) |
| `kind` | `standing` (kept; can be in one team) or `task` (one `ticketId`; archived when that ticket is done) |
| `model` | `haiku`, `sonnet`, `opus` or `fable`. A launch runs on this model. To escalate a stuck ticket, give its agent a bigger model. |
| `actions` | `work` (claim, then move to review), `commit` (edit and commit), `review` (review another branch), `merge` (land an accepted branch on main, #85) |
| `repos` | the sandbox repos it may work in (`[]` = any) |
| `skills`, `instructions` | short rules and standing instructions added to its prompt (hard limits from #74 are refused here too) |
| `maxTurns`, `maxMinutes` | its own limits, never above the runner's |
| `status` | `active`, `paused` (launches refused) or `archived` |

Teams group standing agents, for example `web-team` with three Haiku coders and one Opus reviewer. Every agent and
team has a `version`, and an update must give the version it read.

**Enforced at launch.** The agent must exist and be active. The mode (`work`, `review` or `merge`) must be one of its actions,
the repo one of its repos, and a task agent's ticket its own ticket. A `model` passed with the launch must match the
agent's model. A plain launch with an unknown name and a model still works: it creates a per-task coder for that
ticket (`createdBy: launch`).

**Enforced after the run.** An agent without `commit` runs with no file-editing tools (`--disallowedTools
Edit,MultiEdit,Write,NotebookEdit`). Its Bash can still write files, so the runner also checks the branch when the run
ends. A no-commit work run must leave no commits, and a review run must leave the reviewed head unchanged. Otherwise
the run fails with `POLICY`, whatever the agent reported.

**Review runs.** `agents_launch` with `mode: review` and a reviewer agent:

- The runner reads the ticket but does not claim it, so the ticket stays in review.
- It creates the reviewer's worktree and resets its branch to `reviewBranch` (default: the last successful work branch
  on the ticket). The reset runs as the sandbox user.
- The reviewer reads the diff, runs the tests and checks each acceptance criterion. It ends with `VERDICT: approve |
  changes_requested`, `FINDINGS:` and `EVIDENCE:`. Without a verdict, the run fails with `NO_VERDICT`.
- The report is posted on the ticket's thread, and the ticket is not changed. The `run.ended` event carries `mode` and
  `verdict`. C-chan accepts the work or returns it (#76), based on that independent report, never on the author's "done".

**Merge runs (#85).** After an accepted review, C-chan lands the branch on `main` herself: `agents_merge` (or
`POST /runs` with `mode: merge`, `agent`, `ticketId`, `repo`, `branch`) with an agent that has the `merge` action (role
`merger`). A merge run uses no model, no unit and no worktree (so no model budget applies). The runner enforces:

- the gate, at launch: `config.merge` is set; C-chan's latest decision on the ticket is an `accept` (no `return` after
  it) citing a review run that is independent, approving and on the latest work (`NO_ACCEPT`, `NO_REVIEW`,
  `NOT_INDEPENDENT`, `STALE_REVIEW`, `VERDICT_MISMATCH`); `branch` is exactly the reviewed branch; the reviewed head was
  not merged already (`ALREADY_MERGED`);
- the head, when the run starts and again on the fetched copy: if the branch is not at the reviewed head commit, nothing
  is merged (`BRANCH_MOVED`);
- the steps (`src/agent-merge.mjs`), in a throw-away clone of origin: merge the branch into the current `origin/main`
  (`--no-ff`, one merge commit), run `node --test` on that result, and only then push the merge commit to `origin` as a
  plain fast-forward (never forced; if `main` moved meanwhile it starts again, up to 3 times). The merge commit uses the
  configured identity (default `Blackoutburst <github@blackoutburst.dev>`), and git uses the keys already set up for the
  owner on this server; the origin is the remote of the sandbox's bare clone. The suite runs with a scrubbed
  environment (own `HOME`, no ssh agent).
- success: the ticket is claimed, set to **done** with the merge commit as evidence, a message is posted, and the
  ticket's per-task agents are archived.
- conflict (`MERGE_CONFLICT`) or failing suite (`TESTS_FAILED`): no merge, no push. The ticket goes back to **todo**
  with the output on its thread, and C-chan gets a `manager.attention` line (`merge_refused`) to relaunch a coder.
- anything else (moved branch, clone/fetch/push failure, interrupted): no merge, the ticket stays in review, the
  thread says why, and the Manager line is `merge_failed`. Retrying after an interruption is safe: a head that is
  already part of `main` is reported as merged.

`config.merge` (see `ops/agent-runner/config.example.json`): `identity`, `testCommand` (default `["node","--test"]`),
`prepareCommand` (runs before the tests; the example config uses `["node","ops/sandbox/install-deps.mjs"]` to link
`node_modules`; its failure is `MERGE_ERROR`, not a test failure. Without it, a test run that cannot start because
packages are missing is also `MERGE_ERROR`). Git runs as the owner; the prepare step and the test run go through
`sudo cchan-sandbox-run` like agent units, in a clone under `/var/lib/cchan-agents/merge` and `origin` (override of the remote). Releasing the server (restart, rollout) is not part of it
and stays with the owner.

**On the Board.** Each roster agent is mirrored as a managed agent profile named `C-chan · <name>`, with role, model,
skills, the runner's projects and its status. Creating, updating and archiving the agent does the same to the profile.
These profiles are unbound: no device, no session, no credential and no permissions. The runner does every run's Board
work with its own identity, and the roster in the runner stays the source of truth. The mirror needs the owner's
**agent profile management** grant on the runner's Board profile (`Home Server · C-chan agents`). Until the owner turns
it on, each sync is refused. The roster records `board.error`, keeps working and retries every 10 minutes from the
Board poll.

`GET /status` carries a `roster` summary (`Roster.summary()`): `agents` (`active`, `paused`, `archived`, each with a
`total` and a count per role, `coder` and `reviewer`), `teams` (number of active teams) and `board` (`mirrored`
agents, `pending` ones not yet mirrored, and the latest mirror `error` or `null`). Archiving is mirrored to the Board
too, so archived agents count in `mirrored`, `pending` and `error` like the others. Agents with an unknown status are
not counted.

C-chan's tools: `agents_roster`, `agents_save_agent` (create, or update with `expectedVersion`),
`agents_archive_agent`, `agents_save_team`, `agents_archive_team`. As with launch and stop, C-chan's own proactive
wakes cannot use the write tools.

## Manager mode (#76)

C-chan manages Blackout's approved projects on her own: see [MANAGER.md](MANAGER.md). The runner adds:

- the budget: no Opus or Fable launch at or above 80% weekly usage (`BUDGET`), read from the runs' rate events;
- the decision log: accept and return checked against an independent review run;
- a sweep after every Board poll that raises `manager.attention` wake events (ready and idle, needs a review, verdict
  ready, failing, quota reset, stuck) and `manager.unbacked` (done with no backed accept).

## Limits

Set in the runner config (`limits`) and capped in code:

| Limit | Default | Hard cap |
| --- | --- | --- |
| `maxConcurrent` (runs at once) | 2 (live config: 5) | 8 |
| `maxTurns` (per run) | 80 | 400 |
| `maxSeconds` (deadline per run) | 3600 | 14400 |
| `maxQueued` | 20 | 100 |
| `heartbeatSeconds` | 60 | |

A launch may ask for fewer turns or a shorter deadline, never more. All runs together also stay under the sandbox
slice: 4 CPUs, 6 GB RAM, 1024 tasks.

## Event-driven

C-chan is never woken on a timer for this:

- The runner logs events: `run.queued`, `run.started` and `run.ended` (state, `cleanupConfirmed`, `errorCode`,
  `retryAt`).
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
| `GET /status` | limits, running/queued counts, Board watch state, projects, `roster` (see below) |
| `GET /runs[?active=1]` | runs (instructions are not returned) |
| `GET /runs/<id>` | one run |
| `POST /runs` | launch (body as above, plus `mode` and `reviewBranch`; `maxSeconds` instead of `maxMinutes`) |
| `POST /runs/<id>/stop` | stop: the unit and every child process |
| `GET /events?after=N&wait=S` | events after seq N, waiting up to S ≤ 30 s |
| `GET /roster[?archived=1]` | agents and teams |
| `POST /roster/agents` | create an agent |
| `POST /roster/agents/<name>` | update it (`expectedVersion` + changes) |
| `POST /roster/agents/<name>/archive` | archive it (`expectedVersion`) |
| `POST /roster/teams` | create or update a team (`expectedVersion` to update) |
| `POST /roster/teams/<name>/archive` | archive it (`expectedVersion`, `archiveMembers`) |
| `GET /manager` | manager mode (#76): approvals, weekly budget, attention findings, recent decisions |
| `POST /manager/approvals` | a standing approval `{ projectId, direction, requestId }` (owner chat only) |
| `POST /manager/approvals/<project>/revoke` | withdraw it |
| `POST /manager/decisions` | log a decision; accept/return need an independent `reviewRunId` |

Routing is in `src/agent-runner-api.mjs` (`createRunnerApi`), shared by the service and the tests.

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

- The finished branch stays in the sandbox's bare clone until it is merged: with `config.merge` set, C-chan merges
  accepted work herself (merge runs, #85). Without it, integration happens outside the runner, by the server agent.
- The agent tools are listed to every companion's tool server, but only the owners in
  `COMPANION_AGENT_RUNNER_OWNERS` get them approved and reach the runner. Others are refused.
- A runner restart interrupts running agents rather than reattaching to them.
- The sandbox has `node` but no working `npm` yet, and worktrees have no `node_modules`, so an agent cannot run
  `npm test` or tests that need npm dependencies (seen in the first end-to-end run, #79). Since #78,
  `node ops/sandbox/install-deps.mjs` links the pinned packages into a worktree, and `node --test` runs the whole suite
  there; `npm` itself still does not start in the sandbox.
