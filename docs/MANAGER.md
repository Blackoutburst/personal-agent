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
  own, contact, mail, ...) by `wakeToolFilter` in `src/conversations.mjs`. So Board text, an agent or a wake can never
  give C-chan autonomy.
- **Only Blackout's projects.** An approval must name one of the runner's `config.projects`, which are Blackout's
  projects. Any other project is refused with `FORBIDDEN`, so TheScreamer's projects stay his.
- **One active approval per project.** Approving again replaces the direction (a scope change Blackout agreed to).
  Revoking it puts C-chan back on confirm-first. Both are logged as decisions.

Not enforced in code: the Board writes C-chan makes with her own Board tools. Those go through her paired companion
profile, which this app cannot gate per project. Her instructions carry the rule, and the Board's own permissions on
her profile are the outer limit.

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
[AGENT-RUNNER.md](AGENT-RUNNER.md#roster) (merge runs). Releasing the server stays with Blackout.

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
   user makes `/var/lib/cchan-agents/merge` itself.
6. **Approve a project in chat**, for example: "C-chan, you manage the Personal Agent project: build X." She records
   it, and from then on works it alone.
