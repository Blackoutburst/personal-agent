# Manager mode (#76)

Super agent plan, part 4/7. Blackout gives C-chan ideas and direction. C-chan is the manager of his Board projects:
she makes the tickets, dispatches them to her agents, unblocks, escalates, and accepts or returns work on an independent
review. She never does ticket work herself. Humans are asked only for hard limits (#74) and for changes to the agreed
scope or direction.

Owner decision, 11 Nov 2026: humans slow things down because of their speed and availability, so every step that can
skip a human skips one.

Built on the runner and roster ([AGENT-RUNNER.md](AGENT-RUNNER.md), #72/#73), escalation ([ESCALATION.md](ESCALATION.md),
#74), the Ops app ([OPS.md](OPS.md), #75) and the verification tool ([VERIFICATION.md](VERIFICATION.md), #78).

## Pieces

| Piece | Where | What |
| --- | --- | --- |
| Manager | `src/agent-manager.mjs`, state `~/personal-agent-data/agent-runner/manager.json` | standing approvals, budget, decision log, attention sweep |
| Runner API | `src/agent-runner-api.mjs` (served by `ops/agent-runner/runner-service.mjs`) | `GET /manager`, `POST /manager/approvals`, `POST /manager/approvals/<project>/revoke`, `POST /manager/decisions` |
| Sweep | `managerSweep()`, called on every Board poll (20 s) | adds `manager.attention` / `manager.unbacked` events to the runner's log |
| C-chan's tools | `agents_manager`, `agents_approve_project`, `agents_revoke_project`, `agents_decide` (`src/scheduler-mcp.mjs`) | |
| Her rules | `managerSection()` in `src/companion.mjs`, added to her instructions for the owners in `COMPANION_AGENT_RUNNER_OWNERS` | |
| Ops | `buildOps({ manager })`, `public/ops-ui.mjs` "Gestion" section | approvals, weekly budget, explicit decisions with reasons |

## Standing approval

Once Blackout approves a project or direction in chat, C-chan records it with `agents_approve_project`
(`projectId`, the direction in a sentence). Inside that project she then has standing approval for every Board action:
create, split, assign, reassign, accept and return tickets, create and manage agents, answer agents' questions. She
needs no confirmation per ticket or per action, and does not list every task before creating it. For these projects
this replaces the companion's "restate and wait for a yes before every Board write" rule. Outside them, that rule
still applies.

Enforced in code:

- **Only from an owner chat.** `agents_approve_project` and `agents_revoke_project` are refused in every wake (Board,
  own, contact, mail, ...) by `wakeToolFilter` in `src/conversations.mjs`, and on the unattended token (#94). So Board text, an agent or a wake can never
  give C-chan autonomy.
- **Only Blackout's projects.** An approval must name one of the runner's `config.projects`, which are Blackout's
  projects. Any other project is refused with `FORBIDDEN`, so TheScreamer's projects stay his.
- **One active approval per project.** Approving again replaces the direction (a scope change Blackout agreed to).
  Revoking it puts C-chan back on confirm-first. Both are logged as decisions.

Board writes C-chan makes with her own Board tools in owner chats and Board wakes are not gated per project in code:
her instructions carry the rule, and the Board's own permissions on her profile are the outer limit. On her own
(unattended) wakes they are gated per project (#94, below).

## Own wakes in approved projects (#94)

Owner direction, 12 Nov 2026: manager mode runs unattended, without waiting for Blackout on routine steps. Before #94,
C-chan's own wakes (`proactive`, `heartbeat`, `followup`) had no Board write tools, and proactive/follow-up wakes had no
agent tools, so finished work waited until Blackout wrote in chat.

Now, on those wakes, while the runner holds at least one active standing approval:

- **Tools** (`wakeToolFilter(kind, { manager })` in `src/conversations.mjs`): `agents_launch`, `agents_merge`,
  `agents_stop`, `agents_decide`, and every Board tool in the owner's `board.allowedTools` (for example `create_ticket`,
  `update_ticket`, `release_managed_agent_claim`). The approval check is `GET /status` on the runner
  (`manager.approvals > 0` and `manager.unattendedGate: true`, `managerWake` in `server.mjs`), made at the start of
  each own wake. Any failure counts as no approval, and so does a runner that predates #94 (it would not check the
  project), so the runner must be restarted on this code before own wakes act.
- **Per project, enforced in code for the agent tools.** These turns run with a second scheduler token for the companion
  (`unattended`, from `CompanionRunner.turn({ unattended: true })` → `mcpServersFor(owner, { unattended: true })`).
  Calls on it carry `unattended: true` to the runner, which takes a launch, merge, stop or decision only when the
  ticket (as seen by its Board watch, never as claimed by the request) is in a project with an active approval
  (`NOT_APPROVED` otherwise; a `plan` decision may name the approved project instead). Hard limits, the roster,
  the budget and the review and merge checks still run after that. `agents_approve_project` and
  `agents_revoke_project` are refused on that token as well (`OWNER_CHAT_ONLY`).
- **Board writes per project, enforced in code** (`src/board-write-gate.mjs`). An unattended turn runs its Board MCP
  server through the session bridge in gated mode (`bindBoardSession(..., { gate })` in `src/runner.mjs`, `--gate` in
  `src/board-session-bridge.mjs`). Reads (`READ_ONLY_BOARD_TOOLS`) pass. Every other Board call is held while the
  bridge resolves each target it names on the Board with its own read calls: tickets via `get_ticket`, threads via
  `get_thread` (its ticket, or its own project for a ticket-less thread), requests via `list_human_requests`, messages
  via `get_message`, and project ids as targets of their own. The gate **fails closed** on exact schemas
  (`BOARD_WRITE_SCHEMAS`, `TICKET_CHANGES`): only
  `release_managed_agent_claim {ticket_id, expected_version, idempotency_key, reason, recovery_evidence, view}`,
  `update_ticket {ticket_id, expected_version, changes}`,
  `post_message {thread_id, body, idempotency_key, reply_to, attachment_ids}`,
  `create_ticket {project_id, title, description, acceptance_criteria, idempotency_key, depends_on, priority, labels,
  required_skills, attachment_ids}` and `resolve_human_request {request_id, answer}` may pass. Any other write tool
  (`delete_ticket`, `release_ticket`, `upload_attachment`, `update_companion_profile`, ...) is refused, and so is any key
  a schema does not list. `update_ticket.changes` may only hold the TicketChanges keys `acceptance_criteria`,
  `assignee_agent_id`, `assignee_owner_id`, `attachment_ids`, `blocked_reason`, `depends_on`, `description`,
  `evidence`, `labels`, `outcome`, `priority`, `progress`, `recheck_after_seconds`, `release_claim`,
  `required_skills`, `resolution`, `resource`, `status`, `title`, `unblock_owner`; anything else (`project_id`,
  `blocking`, `prerequisites`, `epic`, `depends-on`, `links`, ...) is refused, so a relation cannot hide under a name
  the gate does not know. The main id is required; plain fields must be a string, number or boolean (lists of them for
  labels, acceptance criteria, skills, evidence, resource); `attachment_ids` must be a list of well-formed ids (shape
  only: attachments are not resolvable through the Board's read tools). Every resolved id (main id, `reply_to`,
  `depends_on`) must land in **one** project, even when a second project is approved too, and that project must have
  an active standing approval: the bridge asks the app with the turn's unattended scheduler token (agents op
  `boardGate`, which reads `GET /manager` approvals on the runner and needs an agent owner). Otherwise the call never
  reaches the Board and the model gets a tool error starting "Refused on your own wake:" with the reason. A call with
  no checkable target, an unknown or unreadable target, a malformed id, more than 50 targets or a list over 200 items,
  a failed approval check, or a gated bridge without the token are all refused. The gate token is removed from
  connect.py's environment. The `create_ticket`, `post_message` and `resolve_human_request` key lists are taken from
  how the app uses those tools, not checked against the live Board schema: a real optional key missing here is refused
  (fail closed) until it is added.
- **Unchanged:** contact wakes (another companion writing) get none of this. Mail, the personal and Studio calendars,
  companion contacts, web tools, repo creation and approvals follow the same rules on every wake kind as before.
  Without any approval, own wakes are exactly as before, except that heartbeat wakes' agent launches, merges, stops
  and decisions now also need an approved project (they used the owner-chat token before).
- **Board wakes** (runner events, Needs-you, mentions) keep using the owner token and their existing tools.

Tests: `test/manager-wakes.test.mjs`, `test/manager-wakes-account.test.mjs`, `test/board-write-gate.test.mjs`.

## Run-event wakes and status push (#98)

`AgentEvents` (`src/agent-runner-client.mjs`) turns runner events into wakes without waiting for a timer:

- **Approved projects only.** `GET /events` marks each event `approved` (its ticket's project, from the Board watch, has an
  active standing approval). Unmarked or unapproved events are skipped, so a runner that predates #98 wakes nobody.
- **One wake per run event.** A run end (succeeded, failed, interrupted, merge conflict/error via its Manager line) or a
  ticket entering review/ready is a Board wake carrying the result; a run id wakes at most once (`agent_wake_seen`).
  Events are coalesced (3 s window, then one wake for everything), capped at 12 wakes an hour; the rest wait in
  `agent_wake_pending` and go out as one wake when the cap frees.
- **Tools on that wake.** It is a Board wake, so it has the owner-token agent tools (launch, merge, stop, decide) and the
  owner's Board tools, a superset of #94's.
- **Interrupted runs** (runner restart) say so in the wake and tell her to relaunch at once.
- **Status push.** Only milestones (ticket done/merged, deployed, desktop release published, release/deploy failed,
  repeated failure, Needs-you) become one short owner message (a `watch` wake), never per step. While the owner's quiet
  hours are on they wait in `agent_milestone_pending`.

Tests: `test/manager-run-wakes.test.mjs`. Not run live: real runner restart, real Board, real push delivery.

## Running unattended

The runner's model-free Board watch (#72) already turns run results and Board changes into wakes. Manager mode adds a
sweep after every poll, over the tickets of approved projects and the runner's runs. It raises a `manager.attention`
event (one wake line, fixed text with ids, numbers, agent names and models only, never Board text) when:

| Finding | When | Suggested step |
| --- | --- | --- |
| `ready_idle` | todo, dependencies delivered, nobody on it | dispatch, or relaunch/reassign after a return or a failure |
| `needs_review` | in review with our agent's work, no verdict on its current head | launch a reviewer that is **not** the author |
| `review_ready` | a verdict exists and no accept/return decision cites it | accept (approve) or return (changes requested) |
| `failing` | the last 2+ work runs failed or timed out (not quota) | escalate one model up, or split |
| `quota_reset` | the last run stopped on `USAGE_LIMIT`/`RATE_LIMITED` and its `retryAt` has passed | relaunch |
| `stuck` | blocked, or waiting on a human, for 30+ min | unblock, reassign, split, escalate; the owner only for a hard limit or a scope change |

A ticket with an active run is skipped. A ticket waiting for a quota reset raises nothing until `retryAt` (it is not a
code failure, #72). Each finding wakes C-chan once. If it is still open after 2 h, it wakes her again.

A ticket of an approved project that becomes **done** with no accept decision on record raises `manager.unbacked`. That
means a person accepted it, or C-chan did without a reviewer report. It shows in the Ops log as "Sans revue".

## Reviews

Work that enters review gets a reviewer run (`agents_launch mode review`, #73) by a reviewer agent. C-chan accepts or
returns it only on that report, never on an agent's own "done". She logs the decision with `agents_decide` **before**
she does it on the Board. The runner refuses the decision unless:

- `reviewRunId` is a review run on this ticket that ended with a verdict (`NO_REVIEW`);
- the reviewer has the reviewer role and is not an author of the reviewed branch (`NOT_INDEPENDENT`);
- the review checked the latest delivered head, so newer work needs a new review (`STALE_REVIEW`);
- the verdict matches: accept needs `approve`, return needs `changes_requested` (`VERDICT_MISMATCH`).

The decision records the reviewer, the author, the run and the reviewed head. A return goes back to the coder with the
findings, and its next delivery is reviewed again.

## Merging (#85)

An accept is followed by `agents_merge` (ticket, repo, the reviewed branch, an agent with role `merger`), not by moving
the ticket on the Board by hand. The runner merges without a model: it refuses unless C-chan's latest decision on the
ticket is an accept backed by an independent approving review of the latest work, and unless the branch is still at the
exact reviewed head. It then merges into current `main`, runs the full `node --test` suite and pushes to origin with
Blackout's configured git identity; the ticket goes to done with the merge commit as evidence and its per-task agents
are archived. On a conflict or failing tests nothing is merged: the ticket goes back to todo with the output, and the
Manager line `merge_refused` tells C-chan to relaunch a coder (the next delivery is reviewed and merged again). Details:
[AGENT-RUNNER.md](AGENT-RUNNER.md#roster) (merge runs). Deploying the server after a merge is automatic only when
Blackout turned it on (#100, below); otherwise it stays with him.

## Desktop release after a merge (#90, #91)

With `"release": { "desktop": true }` in the runner config, a merge that goes through (full suite passed, main pushed)
and raises `desktop/package.json`'s version also releases the Windows desktop app, so nobody runs the scripts by hand.
The runner does it itself, without a model, in `src/desktop-release.mjs`. No merged code runs as the owner account:

1. the owner side (git only) makes a fresh clone of `config.merge.origin` and checks the merge commit is on
   `origin/main` (never an agent branch, never the sandbox's clone);
2. the gate, read from the commit objects: the version on the merge commit must be `x.y.z`, higher than on its first
   parent (the main it was merged into) and higher than what `<dataDir>/downloads/desktop.json` names. No bump, a lower
   or equal version, or a server that already serves it: nothing is built or published. An `already_merged` result
   releases nothing either. A first parent or served version that is **not** `x.y.z` is not comparable: it is left out
   of the gate and the thread post says so ("Note: …"); it never blocks later releases (the server serves nothing for a
   non-`x.y.z` `desktop.json` anyway). A non-`x.y.z` version on the merge commit itself is an error (`release_failed`);
3. **the build runs in the agent sandbox**: the sandbox user makes its own copy of the merge commit under
   `/var/lib/cchan-agents/release` (a git bundle on stdin, exactly like the merge's test copy) and runs
   `bash scripts/build-desktop.sh` there through `sudo -n cchan-sandbox-run --cwd … --max-seconds …`, the same wrapper
   and unit hardening as the tests (sandbox user, its `HOME`, no owner keys, no agent socket, network allowed);
4. the installer, its blockmap and `latest.yml` come out as bytes from `cat` run **as the sandbox user** into the
   runner's private temp dir (the owner never opens a path in the sandbox, so a planted symlink cannot make it read its
   own files). `latest.yml` must name the version, the installer's file name and its sha512 (and size);
5. **the runner publishes with its own code** (`publishDesktop`); `scripts/publish-desktop.sh` from the merge is never
   run. The installer and blockmap are copied into `downloads/` (temp name, then rename); `latest.yml` and
   `desktop.json` are staged in a new feed directory and switched in together (below); then the served files are
   checked: `desktop.json` names the version and file, the served installer has the built sha256 and sha512, the served
   `latest.yml` lists that sha512, the blockmap matches.

Call path: `AgentRunner#releaseDesktop` → `SandboxOps.releaseDesktop` (adds the wrapper, `sandboxDir`
`/var/lib/cchan-agents/release`) → `releaseDesktop`: owner `git clone/merge-base/show/bundle` → sandbox `sh` (copy) →
sandbox build command → sandbox `cat` ×3 → runner `publishDesktop` → sandbox `rm -rf` of its copy.

**Pair-atomic feed.** `downloads/latest.yml` and `downloads/desktop.json` are fixed symlinks to
`.feed/current/latest.yml` and `.feed/current/desktop.json`; `.feed/current` points at one feed directory and is
replaced with a single `rename`. Readers see either the old pair or the new pair, never a mix, also after a crash. On
the first release the plain files a hand publish left are copied into a feed directory and replaced by the symlinks
(same content). A later hand publish with `scripts/publish-desktop.sh` still works (it renames plain files over the
symlinks); the next runner release converts the folder again. The previous feed directory is kept, older ones removed.

The ticket thread gets "Desktop X published … Installer … sha256 …", or the failure with its output. A failed build or
an inconsistent build (missing file, `latest.yml` not matching the installer) publishes nothing. A failed publish or
check switches the previous pair back in one rename and removes the installer files it added, so the previously
published version is still served, byte for byte. Either way the Manager line `release_failed` is raised; main is never
rolled back. A runner restart in the middle raises the same line (the pair is consistent; check which version
`desktop.json` names). Releases run one at a time. Installed apps pick the new version up through the in-app updater
(#89, [DESKTOP.md](DESKTOP.md)). Server deploys are the next section (#100).

Trust: the merged code (build script, `npm install` with its install scripts, electron-builder) runs only as the sandbox
user, like the merge's tests (#85). What the owner account trusts from it is data: the three files, which the runner
checks against each other and serves. The installer itself is still built from merged code and goes to Blackout's
machines through the updater; that is the trust Blackout gives an accepted, reviewed merge by turning this on.

## Server deploy after a merge (#100)

With `"deploy": { "server": true }` in the runner config, a merge that goes through (full suite passed, main pushed)
is also deployed to the server and the affected services are restarted, so nothing waits on main for a manual release.
Off by default. The runner does it without a model, owner-side, after the desktop release (one job at a time), in
`src/server-deploy.mjs`, with the existing release tool (`ops/release.mjs`, [OPERATIONS.md](OPERATIONS.md)) and the
existing layout (`~/personal-agent/releases/<sha>`, `current`, `previous`, backups):

1. **Fetch.** `config.merge.origin`'s `main` into a runner-owned bare mirror (`deploy.repo`, default
   `~/.cache/cchan-agent-runner/deploy.git`); the merge commit must be on it. An `already_merged` result deploys nothing.
2. **What changed** between the deployed release (`current`) and the merge commit:
   - only `docs/`, `test/`, `desktop/`, `android/`, `scripts/`, `character-kit/`, `ops/verify/`, top-level `*.md`:
     nothing is deployed and nothing is said;
   - anything else: the companion (`personal-agent-account.service`) is restarted, since switching `current` changes
     the code it loads;
   - files the runner loads (`ops/agent-runner/runner-service.mjs` and everything it imports, followed through the
     imports at the merge commit) or `package*.json`: the runner (`cchan-agent-runner.service`) is restarted too, last.
   - `ops/deploy/` changed: the report says Blackout should re-run the install command (the installed copies are fixed).
3. **Idle.** Before the companion is stopped, the runner waits until no owner turn is running or queued: the companion
   writes `{busy, pid}` to `<dataDir>/companion-activity.json` on every turn start/end. Bounded by `deploy.idleWaitMs`
   (default 5 minutes); after that it goes ahead, and a reply still running is marked INTERRUPTED as with a manual release.
4. **Release.** `node <the runner's own ops/release.mjs> release <commit>` with `COMPANION_RELEASE_REPO` = the mirror
   and `COMPANION_SYSTEMCTL=/usr/local/lib/cchan-deploy/systemctl-deploy`: archive, private backup while stopped, switch
   `current`/`previous`, start, health check on `/api/status`. On a failed health check the tool itself selects the
   previous release again and checks it: the result is `rolled_back`. A tool refusal (`LOCKED`, `SOURCE`, …) keeps the
   previous release (`failed`); `RECOVERY` means the rollback failed too (`recovery_failed`, the server may be down).
5. **Runner restart** (only when runner code changed). The runner starts no queued run and waits until active agent
   runs ended (`deploy.runnerWaitMs`, default 30 minutes; after that they are interrupted as on any runner restart and
   reported as usual). It writes the hand-over (`<runner data>/deploy.json`: commit, previous release, run), posts
   "restarting the runner" on the ticket, and runs `sudo -n cchan-deploy guard-runner`. That starts the guard
   (`ops/deploy/runner-guard.mjs`, root-installed copy) in its own transient systemd unit as `ubuntu`, so it survives
   the runner being stopped. The guard runs `sudo -n cchan-deploy restart-runner` (a `systemctl --no-block restart`
   job), then waits for the new runner to acknowledge (`deploy-ack.json`: its commit and pid, written once it listens),
   for the unit to be active with that pid, and for it to stay so for a settle time. Healthy: `deployed`. Not: it rolls
   back with the previous release's own `release.mjs rollback` (switches `current` back, restarts and health-checks the
   companion) and restarts the runner again, which now runs the previous code: `rolled_back`.
6. **Report.** The runner that is running at the end (the new one, the restored one, or the old one if the restart was
   refused) reads the guard's result, posts on the ticket thread and raises one Manager line per deploy: `deployed`
   (commit, units restarted, health check passed: C-chan tells Blackout it is live) or `deploy_failed` (rolled back,
   rollback failed, runner not restarted, not run, or cut off by a restart). Main is never rolled back; fix forward.

**Privilege.** The runner gets no general sudo. Root runs only `/usr/local/sbin/cchan-deploy` (`ops/deploy/cchan-deploy`),
a root-owned script with four verbs and no other argument: `stop-companion`, `start-companion` (systemctl stop/start
`personal-agent-account.service`), `restart-runner` (`systemctl --no-block restart cchan-agent-runner.service`) and
`guard-runner` (`systemd-run` of the root-installed guard with `--uid=ubuntu`). Fixed unit names, fixed absolute paths, a
fixed PATH; sudo resets the environment. The sudoers rule (`ops/deploy/cchan-deploy.sudoers`) lists exactly those four
command lines. Nothing from a release directory or the merged commit runs as root: the release tool, the archive
checkout and the rollback run as `ubuntu`, as when Blackout released by hand.

**One-time install (Blackout)**, from a reviewed checkout of a main that contains #100:

```sh
sudo sh ops/deploy/install.sh
```

It checks the sudoers file with `visudo -cf`, then installs `/usr/local/sbin/cchan-deploy` (0755),
`/usr/local/lib/cchan-deploy/systemctl-deploy` and `runner-guard.mjs`, and `/etc/sudoers.d/cchan-deploy` (0440), all
root-owned. Then release that main by hand once as before (so `current` contains #100 and the companion writes its
activity file), restart the runner, and add to `~/.config/cchan-agent-runner/config.json`:
`"deploy": { "server": true }`; optional keys: `"releaseRoot"` (default `~/personal-agent`), `"dataDir"` (default
`~/personal-agent-data`), `"repo"` (the mirror), `"idleWaitMs"`, `"runnerWaitMs"`, `"healthUrl"` (default the tool's
`http://127.0.0.1:4318/api/status`). Restart the runner. Check once by hand that `sudo -n /usr/local/sbin/cchan-deploy
stop-companion` works as `ubuntu` without a password prompt (then `start-companion`). **Turning it off:** remove the
key or set `"server": false` and restart the runner; merges then go on as before and deploy nothing. Uninstall: delete
the four installed paths. Requires merging to be on.

Not run live: the whole flow is tested with temp repos, the real release tool against a fake systemctl and a loopback
health server, the root script in a non-root test mode with fake systemctl/systemd-run, and the guard and the runner's
self-restart across real processes with a fake sudo/systemd. No real sudo, systemd unit, sudoers file or server
release was exercised.

Reviewers can operate the real web app with the verification tool (#78) and attach screenshots and a manifest as
evidence. Android is not covered by that tool.

## Model escalation and budget

Escalation ladder: haiku → sonnet → opus → fable (`nextModel`). To escalate, C-chan gives the ticket's agent the next
model (`agents_save_agent`), logs `escalate_model`, and relaunches it.

Budget (from the ticket thread): no Opus or Fable above about 80% weekly usage. The runner reads the subscription's
weekly utilization from the `rate_limit_event`s of its own runs (`unifiedWindows.seven_day.utilization`, a fraction).
At or above `manager.premiumMaxWeekly` (default `0.8`), it refuses every Opus or Fable launch, and every
`escalate_model` to them, with `BUDGET`. The reading expires at the window's `resetsAt`. Until any run has reported a
reading, nothing is throttled. The sweep then suggests splitting or retrying on the same model instead of escalating.
Quota stops (`USAGE_LIMIT`) and rate limits (`RATE_LIMITED`) keep their own failure reason (#72): the Board execution
ends with `quota_or_rate_limit`, and C-chan relaunches after the reset.

## Hard limits

They are unchanged from #74 and always go to Blackout, even inside an approved project: deployments, spending,
deleting things, credentials, security. A launch whose instructions hit one is refused (`HARD_LIMIT`) and becomes a
Needs-you on the ticket. An approval never covers them.

When Blackout answers that Needs-you "yes" himself, the next launch on that ticket hitting the same limit goes through:
the runner checks the Board for a Needs-you it raised for that limit on the ticket, answered "yes", whose resolver in
the Board's activity is Blackout as a human (an answer C-chan gives as companion never counts). Each such answer admits
exactly one run and is then spent (kept in the runner's state); a later launch needs a new answer. A "no", an open
request, or a Board read that fails all keep the refusal.

## Decision log

`agents_decide` kinds: `plan`, `dispatch`, `unblock`, `reassign`, `split`, `escalate_model`, `accept`, `return`,
`escalate_owner`, `answer`, `pause`. Each takes a one-line reason and is idempotent per `requestId`. The Ops app merges
these explicit decisions (`decided_*`, with the reason, and for reviews the reviewer, run, verdict and author) with the
log it derives from runs and events, plus `attention` and `unbacked` lines. The last 500 decisions are kept.

## End-to-end test

`test/manager-e2e.test.mjs` runs the real runner, Board reporter, Board watch, roster, manager, runner API and
companion tool path against an in-memory Board and a scripted sandbox. In the test:

1. Blackout's direction is recorded once.
2. C-chan creates three tickets (API, then UI depending on it, then deploy).
3. The API is built, sent back by the reviewer, fixed and accepted.
4. The UI fails twice on Sonnet, is escalated to Opus, delivered, reviewed and accepted.
5. The deploy ticket hits the hard limit, and the only Needs-you goes to Blackout.

It also checks:

- an accept on the coder's word alone is refused;
- every accept and return names an independent reviewer;
- task agents are archived when their ticket is done;
- the decisions reach the Ops data.

**What it does not cover:** C-chan's model. Her choices in the test are scripted from the wake lines and her rules. The
real Board and its permissions are not exercised, nor the real sandbox, systemd units and git, nor real Claude runs.

## Owner setup (Needs-you)

Only the owner can grant these on the Board and on the host:

1. **C-chan's companion profile** (Board → Agents → Profiles → C-chan): its project scope must include each project
   she manages (Personal Agent `f0ad83b792830c7cd190412ee8f48997`). It must keep the powers *dispatch*, *answer
   requests*, *accept reviews* and *pause/resume agents*. If the Board has separate grants for creating tickets with
   dependencies, editing or returning tickets in review, turn them on for this profile.
2. **Blackout's runtime file** (`owners.json`, `board.allowedTools`): add every Board write tool a manager needs,
   at least `create_ticket`, `update_ticket`, `post_message`, `release_ticket` and `resolve_human_request`, plus the
   Board's tools for ticket dependencies and for accepting or returning a review if they are separate. Then restart
   the companion. This app does not ship that file, and the Board's exact tool names were not visible from the sandbox.
3. **The runner's Board profile** (`Home Server · C-chan agents`): the *agent profile management* grant (#73, so the
   roster appears on the Board) and, if wanted, *Runtime execution* (#72).
4. **Release** (a deployment, so the owner's decision): install this branch, then restart the runner
   (`sudo systemctl restart cchan-agent-runner`) and the companion. Optional: set `manager.premiumMaxWeekly` in
   `~/.config/cchan-agent-runner/config.json`.
5. **Merge (#85), one time:** install this branch and restart the runner (this change itself is merged by Blackout or
   the server agent, not by the runner it changes); add `"merge": {...}` to the runner config, including
   `"origin": "https://github.com/Blackoutburst/personal-agent.git"` (example in `ops/agent-runner/config.example.json`;
   without `origin` merges are refused); check that the owner account on the server can push there with its existing
   credentials, for example (as `ubuntu`, a dry run that changes nothing but needs push access):
   `R=/var/lib/cchan-agents/repos/personal-agent.git; GIT_TERMINAL_PROMPT=0 git -c safe.directory=$R --git-dir $R push --dry-run https://github.com/Blackoutburst/personal-agent.git refs/remotes/origin/main:refs/heads/main`
   (read access alone: `git -c safe.directory=$R --git-dir $R ls-remote https://github.com/Blackoutburst/personal-agent.git main`),
   and watch the real push of the first merge; make sure `node --test` works in a fresh clone in the sandbox (the
   packages for the suite, e.g. a `prepareCommand` such as `["node","ops/sandbox/install-deps.mjs"]`); create a merger
   agent (`agents_save_agent`: `role: merger`, any model, it is not used). No directory has to be created: the sandbox
   user makes `/var/lib/cchan-agents/merge` itself. The merge steps run on `/var/lib/cchan-agents/bin/node` by default (`config.merge.nodePath` overrides; `null` means the default). The runner's own node under `/opt` is not used: the sandbox hides `/opt`, so the binary must live under the bound `/var/lib/cchan-agents` and be executable by the sandbox user, and a node older than `engines.node` is refused with a readable `merge_failed` reason (#92).
6. **Desktop release (#90, #91), one time, optional:** install this branch and restart the runner. The build runs as the
   sandbox user, so check once that it can build there: from a clone made by the sandbox user under
   `/var/lib/cchan-agents`, `sudo -n /usr/local/sbin/cchan-sandbox-run --cwd <clone> -- bash scripts/build-desktop.sh`
   (it needs npm, or `curl`/`openssl` for the pinned npm fallback, `node` on the sandbox PATH and network for the
   Electron downloads). If npm is somewhere specific, put it in the command:
   `"buildCommand": ["/usr/bin/env", "NPM_CLI=/var/lib/cchan-agents/…/npm-cli.js", "bash", "scripts/build-desktop.sh"]`.
   Check that `~/personal-agent-data/downloads` is where the companion serves the app from. Then add to
   `~/.config/cchan-agent-runner/config.json`:
   `"release": { "desktop": true }`; optional keys: `"dataDir"` (default `~/personal-agent-data`, the companion's
   `COMPANION_DATA_DIR`), `"buildTimeoutMs"` (default one hour), `"buildCommand"` (argv run in the sandbox copy, default
   `["bash","scripts/build-desktop.sh"]`). `"publishCommand"` and `"home"` from #90 are ignored now (the runner
   publishes itself; the build uses the sandbox user's HOME). Restart the runner.
   **Turning it off:** remove the key or set `"desktop": false` and restart the runner; merges then go on as before and
   publish nothing. Requires merging to be on (step 5).
7. **Server deploy (#100), one time, optional:** `sudo sh ops/deploy/install.sh` from a reviewed checkout, release
   that main by hand once, restart the runner, then `"deploy": { "server": true }` in the runner config and restart it
   again. Details and how to turn it off: [Server deploy after a merge](#server-deploy-after-a-merge-100).
8. **Approve a project in chat**, for example: "C-chan, you manage the Personal Agent project: build X." She records
   it, and from then on works it alone.
