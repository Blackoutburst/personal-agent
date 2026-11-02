# The companion

Each owner has one companion: a friend who lives on the home server, not a chatbot and not an assistant
session. The idea follows OpenClaw and Meta Muse's SOUL.md: the companion is a set of files that it reads
at the start of every session and keeps rewriting itself.

## Its files

They live in the owner's companion workspace, `$COMPANION_RUNTIME_DIR/<label>/workspace`:

| File | What it holds | Who writes it |
| --- | --- | --- |
| `SOUL.md` | Who it is: character, voice, what it cares about. Starts from a template ("You're not a chatbot. You're becoming someone."). | The companion; it tells its owner when it changes it |
| `USER.md` | What it knows about its owner: about them, people, likes and dislikes | The companion; the owner can forget lines in the app |
| `MEMORY.md` | Long-term memories: ongoing things, moments, promises | Same |
| `memory/YYYY-MM-DD.md` | A short diary for each day | The companion |
| `AGENTS.md` | How it lives, remembers and talks | The app (replaced when its version changes) |
| `CLAUDE.md` | `@AGENTS.md`, so Claude Code reads the same rules (Codex reads AGENTS.md) | The app |

`src/companion.mjs` creates missing files from templates and never overwrites the companion's own files.

## How a turn starts

The app builds the instructions (`instructions()`): the companion's name, the owner's name, the local time
in the owner's timezone, the contents of SOUL.md, USER.md and MEMORY.md, and the last two diary days. Claude
gets them in every turn's system prompt. Codex gets them when a new session starts, because its
instructions become part of the conversation.

The companion edits its files with its own file tools: Claude with Read/Edit/Write/Glob/Grep and
`--permission-mode acceptEdits` (no shell), Codex in `sandbox_mode="workspace-write"`. Both can write only
inside the workspace.

There is one ongoing chat. The provider session is resumed, and a new one starts after 6 hours of quiet,
after 40 turns, or right after the owner made it forget something. A new session gets the last 16 chat
messages for continuity. Everything older lives in the files.

## The app

`public/index.html` has three screens, all friendly and without technical words:

- **Chat**: the character, the ongoing chat and a text box. The character shows how it is doing: idle,
  listening (while you type), thinking, talking, happy (after a reply) and sleepy (at night).
- **Memories**: USER.md ("About you") and MEMORY.md ("Our memories") grouped by heading, with "Forget"
  on every line (confirmed in place).
- **Look**: the character (Pip, Mochi, Sprout or Luna), its color and its name. The first visit opens
  this screen as "Meet your companion". Below it, the app theme: System (the default, follows the device),
  Light or Dark. It is kept per browser in `localStorage` and applied by `public/companion-theme.js`, a
  small blocking script in the page head (the page's policy allows no inline script), so a dark page never
  flashes light. The Android app has the same choice, kept on the phone.

`POST /api/companion` serves it: `get` (profile and agent state), `setProfile` (`name`, `character`,
`color`, `timezone`), `memory`, `forget` (`file`, `id`). The chat uses `POST /api/conversation`
(CONVERSATION-UI.md). Every request revalidates the platform session.

Voice comes later, with speech recognition and voices running on the server.
