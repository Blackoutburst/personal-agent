# Per-owner agent runtime (M1, ticket #7)

Each owner's companion runs on **their own** Claude or ChatGPT subscription, through the
unmodified official CLI (`claude` or `codex`) on this server. This app never reads, copies or
stores provider credentials: sign-in is the provider's own flow, run by the owner, and the
credentials stay in that owner's provider home.

Privacy is app-level (see the trust model in PLAN.md): the web client only ever routes a
signed-in account to its own agent. Both owners are trusted server admins; there is no OS
user isolation.

## Layout

```
$COMPANION_RUNTIME_DIR/<label>/claude-home   CLAUDE_CONFIG_DIR for that owner (or codex-home = CODEX_HOME)
$COMPANION_RUNTIME_DIR/<label>/workspace     working directory of that owner's agent
```

Directories are created with mode 0700. `COMPANION_RUNTIME_FILE` (outside the checkout) maps
platform accounts to owners and holds no secrets:

```json
{"owners": [
  {"subject": "<platform account id>", "label": "blackout", "name": "Blackout", "provider": "claude", "model": "opus"},
  {"subject": "<platform account id>", "label": "screamer", "provider": "codex"}
]}
```

## Routing

`CompanionRunner.turn(companionId, …)` resolves the owner only from the server-side companion
ID provisioned at the owner's first web sign-in (`companion-identity-v1`). Nothing the browser
sends selects a label, home or path. Turns of one owner run one at a time; owners run in
parallel. Provider session IDs (for `--resume` / `exec resume`) are returned to the caller,
which keeps them per conversation thread.

## Conversations

`src/conversations.mjs` (ticket #8, see CONVERSATION-UI.md) calls `turn()` for each user
message, with instructions built from the companion's own files (COMPANION.md) as system prompt. It stores the provider
session id per thread and passes it back as `resume`. `turnForLabel` (admin only) is what
`manage.mjs ask` uses.

## Statuses and errors

`status()` returns `unconfigured`, `provider-missing`, `signed-out` or `ready` (+ plan).
Turn errors: `NO_RUNTIME`, `NOT_SIGNED_IN`, `USAGE_LIMIT` (with `resetsAt` when known),
`PROVIDER_MISSING`, `PROVIDER_ERROR`, `TIMEOUT`, `CANCELLED`. There is no fallback to another
owner's account or to an API key.

## Admin commands

```
export COMPANION_DATA_DIR=… COMPANION_RUNTIME_FILE=… COMPANION_RUNTIME_DIR=…
node manage.mjs owners               # status of every owner
node manage.mjs login <label>        # the owner signs in with their own account
node manage.mjs ask <label> "hello"  # one smoke-test turn, streamed
```

## Provider notes

- Claude: `claude -p --output-format stream-json --verbose --include-partial-messages`, prompt on
  stdin. Verified against Claude Code 2.1.316. Using the official CLI with your own
  subscription is what Anthropic's terms allow; the Agent SDK with claude.ai sign-in is not.
- Codex: `codex exec [resume <id>] --json -c sandbox_mode="workspace-write" -` (writes only in the
  companion workspace, see COMPANION.md), instructions prepended to
  the prompt. codex-cli 0.166.0 is installed in the user npm prefix (no sudo). Transient
  "Reconnecting…" error events are ignored; the final `turn.failed` decides.
- Tests (`test/runner.test.mjs`) use fake provider binaries; no credentials or usage involved.

## Owner tools and MCP (#27)

The private runtime file accepts optional `tools` and `board` settings. Keep the
existing `issuer` and optional owner `name`; these are independent of tool policy.
For example:

```json
{"owners":[
  {"subject":"<account A>","label":"blackout","provider":"claude",
   "tools":["Read","Edit","Write","Glob","Grep","WebSearch","WebFetch"],
   "board":{"configDir":"/private/blackout/board","connectPath":"/absolute/board/connect.py"}},
  {"subject":"<account B>","label":"screamer","provider":"codex",
   "tools":["WebSearch","WebFetch"]}
]}
```

Omitted Claude tools retain the companion's existing five file tools. An explicit
list selects exactly those file/web capabilities; `[]` selects none. Codex's native
file tools and workspace-write policy remain provider-owned; its configurable web
search/fetch is one capability, so specify both web names or neither. Omission
disables that native web capability. No new shell or execution-policy flag is set
by this tool configuration change. The existing companion workspace and Claude
`acceptEdits` behavior are preserved; see [COMPANION.md](COMPANION.md).
Codex's upstream native shell policy is also unchanged here; the lead's earlier
no-shell clause versus its current file-tool setup requires an explicit review
decision. This change does not claim to disable that intrinsic tool.

Omitted `board` adds no Board transport. Its paths must be absolute. `pythonPath`
defaults to `/usr/bin/python3` or `COMPANION_BOARD_PYTHON`; `connectPath` may instead
come from `COMPANION_BOARD_CONNECT`. The owner separately pairs the bridge using
`--client other --config-dir ...`; never commit paired directories or credentials.
`board.allowedTools` defaults to `get_work`, `list_projects`, `list_tickets`,
`get_ticket`, `get_text`, `get_thread`, `list_human_requests`, and `read_inbox`.
Trusted owner configuration accepts exact future names for M4; M1 retains these
read defaults. Unknown fields, relative paths, duplicate names and wildcards fail.

Applications may supply the synchronous runner constructor callback
`mcpServersFor(owner)`, returning additional stdio descriptors with `name`, absolute
`command`, string `args`, optional string `env`, and explicit exact `allowedTools`.
The `board` name is reserved for the owner's bridge. This application API is not
an owners.json field or a conversation/turn parameter. No memory MCP is added:
the companion's native workspace files remain the source of its soul and memory.

A turn's `allowedTools` may only narrow configured native names and exact
`mcp__<server>__<tool>` names. Omission inherits; explicit `[]` selects no configured
native/MCP tools, although Codex's intrinsic file tools remain available. Servers
with no selected tools are omitted. Both runner entrypoints reject expansion
before queueing or spawning and snapshot the selected paths, arguments and env.
Conversations inherit per-owner policy, so web/MCP settings reach normal app turns.

Claude receives explicit `--tools`, exact auto-approved names, strict inline MCP
JSON and empty settings sources. Codex0.166 uses resume-compatible
`-c web_search="live"` (or `"disabled"`) and per-server `enabled_tools`, command,
args and env overrides. Its configuration tables **deep-merge**: these overrides
do not clear other user/system/project servers or inherited fields. The lead's
controlled-host setup keeps those layers free of unrelated MCP configuration;
the generated arguments alone are not a global tool/MCP isolation boundary.

Official sources: [Codex web search](https://learn.chatgpt.com/docs/web-search),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[Claude CLI](https://code.claude.com/docs/en/cli-reference), and exact
[Codex0.166 source](https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856).
Fake-provider tests prove validation, argument propagation and owner scoping;
Claude · Server performs real-provider web/MCP checks during review.
