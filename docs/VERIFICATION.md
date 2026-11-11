# Verification tool for agents (#78)

Super agent plan, part of #71. "It compiles" and "the author says done" are not proof. Coder and reviewer agents run
the **real companion web app** in a headless browser inside the sandbox, operate it, and leave evidence: screenshots,
the page state they read, console/page errors and failed requests, all in one manifest with file hashes.

Design rule (from the pstack write-up this follows): one agent that can reliably operate the product comes first, then
context (the [feature map](FEATURE-MAP.md)), then evidence, and only then more agents in parallel.

## What runs

`ops/verify/verify.mjs` starts `server.mjs` in-process on a free loopback port, in `account` mode with one synthetic
owner (an injected validator, no real account service and no credentials), on a throwaway data directory. No model
runtime is configured, so the model is never called: chat shows the app's own "isn't set up yet" note. Chromium is
Playwright's headless shell. Nothing leaves the sandbox except what the app itself would do (nothing).

Not covered: Android. The sandbox has no emulator or device, and `android/` needs the SDK. The web app is the same UI
in the Android WebView-style client for the screens above, but Android-only behaviour (push, notification, native
bridge) is **not** verified by this tool and a report must say so.

## Setup (once per sandbox)

```sh
node ops/sandbox/install-deps.mjs     # test suite: pinned npm packages once per lock file, linked as ./node_modules
node ops/verify/verify.mjs setup      # browser: playwright-core + headless Chromium into /var/lib/cchan-agents/verify
```

Both write only under `/var/lib/cchan-agents` and need no root. `install-deps.mjs` makes the whole suite
(`node --test`) pass in a worktree; before it, `test/minecraft-abilities.test.mjs` failed on the missing `mineflayer`
module. `VERIFY_HOME` overrides the browser install folder; `COMPANION_AGENT_DEPS_DIR` the shared npm folder.

## Commands

```sh
node ops/verify/verify.mjs map                          # the feature map (markdown); --json for machines
node ops/verify/verify.mjs shot chat calendar me-settings --out DIR
node ops/verify/verify.mjs run steps.json --out DIR     # operate the app, see below
node ops/verify/verify.mjs check-map                    # open every mapped screen, fail if one does not show
```

Options: `--out DIR` (default `./verify-evidence/<time>`), `--viewport WxH` (default 420x860), `--no-setup`.
Exit code 0 only when every step passed; a failed step stops the run and adds `failure.png`.

A fresh data dir has no companion, so the tool first runs the map's `setup` steps (pick the default look, name it,
save). Steps file: a JSON array.

| `do` | fields | meaning |
| --- | --- | --- |
| `goto` | `feature` (map id) or `hash` | open the screen and wait for its `ready` selector |
| `click` | `selector` or `text` | click |
| `fill` | `selector` or `text`, `value` | type into a field |
| `press` | `key` | keyboard key |
| `wait` | `selector` or `ms` | wait for visibility / a short pause |
| `expect` | `selector`, optional `text`, `visible: false`, `url` | assert; a miss is a failure |
| `state` | optional `selector` | read the view, URL, title and visible text into the manifest |
| `screenshot` | `name`, optional `fullPage` | `NN-name.png` |

Selectors are ordinary CSS; ids in `public/index.html` are stable. Add `"continueOnError": true` to a step to go on.

## Evidence

Each run writes, into `--out`: the screenshots, `evidence.json` (steps with results, commit and whether the tree was
dirty, console errors, page errors, HTTP errors, sha256 of each screenshot) and `EVIDENCE.md` (the same, readable).
A worked example is committed in [docs/evidence/t78](evidence/t78/EVIDENCE.md): `steps.json` is the input.

Evidence is of the code at `commit`. Commit first, then run, so `dirty` is false.

## Feature map

[FEATURE-MAP.md](FEATURE-MAP.md) is generated from `ops/verify/feature-map.json`: each screen's id, URL hash, how a
user reaches it, and the selector that is visible only when it really shows. It is kept honest three ways:

- `test/verify.test.mjs` fails if an entry points to a missing source file, a view that is not in `index.html`, a
  hash the router does not know, or if the generated markdown is stale.
- `verify.mjs check-map` opens every entry in the running app (the "maintain" step: run it after changing a screen).
- Whoever adds or renames a screen edits the map in the same change (see the checklist below).

Maintenance checklist when a change adds or moves a screen: add/adjust the entry in `feature-map.json`, run
`node ops/verify/verify.mjs map --markdown > docs/FEATURE-MAP.md`, run `check-map`.

## Who attaches what

- **Coder**: for a UI-visible change, run `shot`/`run` after committing and put the `EVIDENCE.md` summary and the out
  directory in the EVIDENCE block. Commit evidence into the repo only when the ticket wants it kept (screenshots are
  binary).
- **Reviewer** (review runs must leave the reviewed head unchanged, so never write into the worktree): use
  `--out /var/lib/cchan-agents/evidence/t<ticket>-<agent>`, drive the acceptance criteria that touch the UI with a
  steps file, and paste `EVIDENCE.md` plus the directory path into `EVIDENCE:`. Verdict `approve` needs real runtime
  evidence for each user-visible criterion, or an explicit statement of why none applies (backend only, Android only).
  The runner posts the report on the ticket's thread; screenshots stay in the evidence directory, which the owner
  (group `cchan-agents`) can read.

## How manager mode (#76) uses it

C-chan does not take "done" from the author. For a ticket with user-visible behaviour:

1. Launch a reviewer (`agents_launch`, `mode: review`). Its brief says: run the tests, run `verify.mjs` on each
   acceptance criterion that touches the UI, attach the evidence.
2. Accept only when the report has `VERDICT: approve` **and** `EVIDENCE:` contains an `EVIDENCE.md` with `PASS`, the
   commit equal to the branch head, `dirty` false, zero page errors, and screenshots whose names match the criteria.
3. Return the ticket (`changes_requested`) when: the verdict says so; evidence is missing for a user-visible
   criterion; the commit is not the head; a step failed (`FAIL`, `failure.png`); or page errors / unexpected failed
   requests appear. Quote the failing step and screenshot path in the return message.
4. Not UI-verifiable (Android-only, needs real accounts or a live model): the reviewer says so, and C-chan asks the
   owner rather than accepting on the author's word. The hard limits in [ESCALATION.md](ESCALATION.md) are unchanged.

`/interrogate` (several models attack a finished diff) from pstack is a later step and not part of this ticket.
