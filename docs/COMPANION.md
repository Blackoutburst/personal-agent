# The companion

Each owner has one companion: a friend who lives on the home server, not a chatbot and not an assistant
session. The idea follows OpenClaw and Meta Muse's SOUL.md: the companion is a set of files that it reads
at the start of every session and keeps rewriting itself.

## Its files

They live in the owner's companion workspace, `$COMPANION_RUNTIME_DIR/<label>/workspace`:

| File | What it holds | Who writes it |
| --- | --- | --- |
| `SOUL.md` | Who it is: character, voice, what it cares about. Starts from a template ("You're not a chatbot. You're becoming someone."). | The companion; it tells its owner when it changes it |
| `USER.md` | What it knows about its owner: about them, people, likes and dislikes | The companion; the owner can correct or forget bullets in the app |
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

## Claude-chan art

Claude-chan is an illustrated character (gpt-image-2 through Codex; sources and tools live outside the repo in
`~/companion-art/claude-chan`). Every picture is an edit of one base picture with the same framing, so:

- **outfits** (`public/characters/claude/outfits/*.webp`) are whole pictures with her resting face;
- **faces** (`.../faces/*.webp`) are feathered patches of the face area (eyes and eyebrows fully covered), drawn over any outfit.
- **fronts** (`.../fronts/<outfit>.webp`, every outfit but base) hold what the outfit has in front of the face area
  (a brim, other bangs, a collar), drawn over the face so hats stay in front. The ahoge only shows without a hat.

The app shows the outfit, then the face for its mood and the outfit's front layer (none for idle; blink and talk patches flash over it).
The Android app ships the same files in `assets/characters/claude`.

**Outfits** (`src/wardrobe.mjs`). The owner can pin one on the Look screen; by default (`outfit: "auto"`) the
server picks, in the owner's timezone: special days from 7 am (Valentine's Day, Easter Sunday and Monday,
Lunar New Year, 14 July fireworks, Halloween, 24 and 25 December, New Year's Eve until 3 am, 1 and 2 January),
pajamas from 10 pm to 7 am, the cardigan from 7 pm, and during the day an outfit of the season that changes
from day to day. `get` and `setProfile` return `wearing`; the apps ask again every 10 minutes. Weather outfits
(rain, snow, windy, sunny) are drawn but wait for a forecast source.

**Feelings.** AGENTS.md (version 2) asks the companion to start each reply with `[feeling:<name>]`.
`splitFeeling` takes it off while the reply streams (a partial tag is held back, so it never shows), and the
message carries `feeling`. The apps show that face while the reply is written and for a few seconds after;
the drawn characters use the nearest of their faces.

**Knowing itself.** The instructions describe the companion's look (character and color) and, for
Claude-chan, what she is wearing right now. A change of name or look starts a fresh agent session.

## The app

`public/index.html` has three screens, all friendly and without technical words:

- **Chat**: the character, the ongoing chat and a text box. The character shows how it is doing: idle,
  listening (while you type), thinking, talking, happy (after a reply) and sleepy (at night).
- **Memories**: complete saved text from USER.md ("About you"), MEMORY.md ("Our memories") and read-only diary days.
  Bullets have correction and confirmed Forget controls. Each document shows its filename and that file's modified
  time, not an invented origin or creation date for an individual fact. Non-bullet prose and original line endings
  remain in the saved document/export. An embedded-CR line stays visible as raw text without single-line controls.
- **Look**: the character (Pip, Mochi, Sprout or Luna), its color and its name. The first visit opens
  this screen as "Meet your companion". Below it, the app theme: System (the default, follows the device),
  Light or Dark. It is kept per browser in `localStorage` and applied by `public/companion-theme.js`, a
  small blocking script in the page head (the page's policy allows no inline script), so a dark page never
  flashes light. The Android app has the same choice, kept on the phone.

`POST /api/companion` serves it: `get` (profile and agent state), `setProfile` (`name`, `character`,
`color`, `timezone`), `memory`, `editMemory`, `forget`, `forgetAll` and `exportMemory`. The chat uses `POST /api/conversation`
(CONVERSATION-UI.md). Every request revalidates the platform session.

## Corrections, forgetting and export

Remembering remains automatic: the companion keeps its native notes and diary without asking for promotion.
There is no separate memory/retrieval framework, per-fact provenance database or new permission grant. AGENTS.md's
rule not to restore a removed memory remains unchanged. Memory text never authorizes Board writes.

The web and Android controls use a SHA256 revision of the complete original file bytes for each correction or
bullet deletion. An occurrence ID is bound to the filename, LF line number and text, so identical bullets can be
changed independently. A stale device gets 409 MEMORY_CONFLICT and reloads; a correction draft stays available
for review/copy and is never silently resubmitted against a new revision. A lost acknowledgement is reconciled
by reloading; the old revision cannot apply a second mutation after the bytes changed.

Writes are synchronous while the owner's app/native lane is idle. Queued/running turns, cancellation still waiting
for actual process close, shutdown and recovered running rows return 409 MEMORY_BUSY. A quiet DB wake that has
not started does not block indefinitely. The app validates the byte revision, prepares private replacement files,
durably resets that owner's provider-session mappings, then atomically replaces bytes. A reset failure cannot
publish the edit. Session epochs fence late normal/wake callbacks so they cannot restore the old resume mapping.
Other owners' sessions stay unchanged. One active app service owns native execution; independent operator/native
CLI writers are outside that coordination and require stopping the app before maintenance.

Forgetting a bullet removes that occurrence from its selected note file and resets native sessions. The UI says
"Removed from memory. Past chats aren't changed." The diary and chat history stay. The separate confirmed
"Forget everything the companion remembers" action empties USER.md and MEMORY.md and deletes valid diary-day
files. It keeps SOUL.md, conversations, shared files and unrelated workspace content. It uses a revision of the
whole selected memory set; an open confirmation keeps the revision that the owner actually reviewed. Each file
publication is atomic; a multi-file filesystem failure can leave a partial clear and returns an error, never a
success claim. Reload the remaining state and explicitly retry with its current revision.

Fresh sessions still receive the last 16 chat messages. These controls do not semantically erase a fact repeated
in retained chat, other files, exported copies or provider history, and do not add a suppression list. Provider-side
retention and operator backups are separate from app deletion; existing backups can retain earlier bytes until the
operator removes them under the installation's retention policy. No secure-erasure or immediate backup-purge
promise is made. Deleting a conversation is its existing separate confirmed action.

Export fetches a fresh authenticated owner-only JSON document containing USER.md, MEMORY.md and the valid
diary days with complete content, file revisions and modified times. It contains no SOUL/AGENTS, provider home,
credentials or arbitrary workspace files. The browser downloads a short-lived local Blob; Android uses the system
document picker and cleans incomplete output after cancellation or owner reset. Keep downloaded copies private.
There is no public/static export link or credential in a URL.

Access refuses unsafe/link/shared/nonregular files, invalid UTF8 and unsupported size/count limits instead of
truncating a view or export. Limits are 256KiB per file, 2MiB total saved content, 1024 documents, 10,000 projected
bullets, 4096 directory entries and a 16MiB JSON response. Corrections are one nonempty line, at most 4000
characters/16,000 UTF8 bytes, without control characters or tabs. Bounds are service limits, not a deletion policy;
oversized originals are preserved for the owner/operator to recover. No schema migration is introduced.

Protocol: `memory` returns `{files,revision}`. Each file includes `file,content,revision,modifiedAtISO,readOnly,sections`;
section items have `id,text,line`. `editMemory` takes `file,id,text,expectedRevision`, and `forget` takes
`file,id,expectedRevision`. `forgetAll` requires `expectedRevision` for the whole set plus `confirm:true`.
Successful mutations return the canonical snapshot plus `changed`, `removed` or `cleared` respectively.
`exportMemory` returns `{export:{format:"companion-memory-v1",exportedAt,files}}`. Unknown selectors/extra fields
are rejected; owner/workspace selection is always server-derived. Older clients without revisions must update
before changing notes; they cannot bypass conflict checking.

Voice comes later, with speech recognition and voices running on the server.

## Android app download

The Look page shows a "Download for Android" card when a release is published on the server. To publish one, put the APK and a small `android.json` in `<COMPANION_DATA_DIR>/downloads/`:

```json
{"version":"0.3.1","file":"companion-0.3.1.apk"}
```

`/android.json` returns `{version, size}`, and `/companion.apk` serves the file as an attachment named `companion-<version>.apk`. Both answer 404 when nothing valid is published. The file name must be a plain `.apk` name inside `downloads/`. APKs are never committed to git.
