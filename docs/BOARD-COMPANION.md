# The companion on the Board

An owner whose runtime config has a `board` entry gets a companion that acts on the Board
(board.blackoutburst.com) for them. On the Board side the companion is a **companion profile**
(Board 2.19, schema 19, Board ticket #50): its own identity shown as "Name · for Owner", with the
owner's project scope and four fixed owner powers: dispatch, answer requests, accept reviews and
pause/resume agents. It never claims or does ticket work. Pairing it, its permissions and its
projects stay with the human owner.

## Setup (once per owner, by the owner)

1. Board → Agents → Profiles → Create companion.
2. Pair it with "Connect agent", using a dedicated config dir on the server, for example
   `~/.config/personal-agent/board/<label>`. The credential stays in that folder; the app never reads it.
3. In the runtime file (`owners.json`), give the owner a `board` entry:

```json
"board": {
  "configDir": "/home/ubuntu/.config/personal-agent/board/blackout",
  "allowedTools": ["get_work", "list_projects", "list_tickets", "get_ticket", "get_text", "get_thread",
    "list_human_requests", "read_inbox", "create_ticket", "update_ticket", "post_message",
    "release_ticket", "resolve_human_request", "update_companion_profile"]
}
```

`pythonPath`/`connectPath` default to `COMPANION_BOARD_PYTHON`/`COMPANION_BOARD_CONNECT`.

## What the app does (`src/board-companion.mjs`)

- **Needs-you.** Every 2 minutes it lists the open Board requests addressed to the owner. Each new
  one becomes a private background `board` wake (table `board_needs_you_seen` remembers it). The
  prompt names only the request and ticket IDs; the companion reads the text with its Board tools as
  untrusted content. It may answer simple, settled, low-risk requests itself with
  `resolve_human_request` and stay silent; otherwise it asks the owner in chat and passes their
  answer on. Deployments, spending, deletions, credentials and security always go to the owner.
  Board wakes can call `resolve_human_request`; every other background wake stays read-only.
- **Profile sync.** At start, on every check and whenever the owner changes the companion's name or
  look, the Board profile's name, avatar and description follow (`update_companion_profile`).
  Unchanged values are not sent again.
- **Files.** `attach_to_board` (in the files MCP server, offered only to Board owners) uploads one
  workspace file, such as a screenshot the owner sent (inbox/), to a Board thread through the owner's
  bridge (max 10 MiB). The companion then adds the returned id to `create_ticket`/`update_ticket`
  `attachment_ids` or a `post_message`. Like every Board write, only after the owner's yes in chat.

The Board connection is `src/board-client.mjs`: the paired `connect.py --stdio` bridge with its own
session (`companion-app-<random>`), JSON-RPC over stdio, 30 s timeouts.
