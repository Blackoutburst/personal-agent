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
  {"subject": "<platform account id>", "label": "blackout", "provider": "claude", "model": "opus"},
  {"subject": "<platform account id>", "label": "screamer", "provider": "codex"}
]}
```

## Routing

`CompanionRunner.turn(companionId, …)` resolves the owner only from the server-side companion
ID provisioned at the owner's first web sign-in (`companion-identity-v1`). Nothing the browser
sends selects a label, home or path. Turns of one owner run one at a time; owners run in
parallel. Provider session IDs (for `--resume` / `exec resume`) are returned to the caller,
which keeps them per conversation thread.

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
- Codex: `codex exec --json --sandbox read-only -`, persona prepended to the prompt. Not yet
  verified against a real `codex` install on this server.
- Tests (`test/runner.test.mjs`) use fake provider binaries; no credentials or usage involved.
