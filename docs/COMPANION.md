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

## Private personality controls and observed history

The Look page on web and Android shows the complete native `SOUL.md`, its file-modified date, a full-text
editor, and the last 20 distinct versions the app observed for this companion. Native personality growth and
its one-sentence announcement stay as instructed in AGENTS; suggestions remain ordinary private chat.
There is no proposal queue, trait framework, Board disclosure or new permission. Name/look remain the existing
profile controls. Personality writes do not change goals, credentials, account identity or dispatch authority.

History is app-observed history, not an audit of every native edit. An actual native turn is observed after its
provider closes, including silent wakes, cancellation and errors; quiet queued wakes and delivery-only attempts
do not invent observations. Owner edits/restores retain the previous bytes before replacing them, then record
the resulting bytes. Identical bytes are deduplicated; revisiting a retained version moves it to the latest
observation. Earlier versions beyond 20 distinct retained contents are evicted. File date and app-observed date
are separate metadata, not per-trait provenance. Existing older bytes cannot be recovered retroactively.

Select an observed version to see its complete text and a simple line comparison. Restore requires explicit
confirmation pinned to that target and the current full-file revision. A changed file or evicted version is
refused; clients keep an unsaved draft on conflict and require a fresh review rather than silently adopting a
new revision. Edits/restores reuse the idle owner lane and durable session reset before atomic file replacement.
Native edits can evolve the file again later. Prior chat, provider retention, exported copies and backups are
not erased by personality controls. SOUL and its history stay outside memory export and Forget everything.

**Deployment/backup:** this change adds one private SQLite table, `personality_versions`, without changing the
bootstrap `user_version` or existing tables. Back up the private DB before first startup. The table retains full
private SOUL bytes and must follow the installation's private-data/backup policy. Rolling back the application
does not delete the additive table or old backups. No live migration, pairing or grant is performed by the
source handoff. A history/reset failure before publication leaves SOUL unchanged; a later observation/read
failure can occur after replacement and returns an error rather than claiming success. Reload to reconcile
the current bytes before retrying. A failed turn observation does not fail the conversation; the operator gets
a fixed diagnostic and only successfully observed versions appear in history.

Protocol on the existing owner-authenticated `POST /api/companion`: `personality` returns
`{file,content,revision,modifiedAtISO,history,historyLimit:20}`. History is newest first with
`{revision,observedAtISO,modifiedAtISO,source}`; a first read can have no history and does not capture a version.
`personalityVersion` plus `revision` returns `{version:{...metadata,content}}` for this owner's retained target.
`editPersonality` takes `content,expectedRevision`; `restorePersonality` takes `revision,expectedRevision,confirm:true`.
Mutations return the current snapshot plus `changed`. Sources are `settled_turn`, `before_owner_change`,
`owner_edit`, `owner_restore`. Missing, malformed, oversized, unsafe and stale content is explicitly refused;
file bytes are complete UTF8, at most 256KiB, with BOM/newlines preserved. There is no public SOUL/history route.

The companion JSON request limit is now 2MiB, allowing escaped full-file edits while individual file limits remain
256KiB. The installed nginx configuration from file sharing kept other routes at 64k: the deployment reviewer
must inspect the effective mount and raise ONLY the exact private `/api/companion` location (typically externally
`/companion/api/companion`) to `client_max_body_size 2m`, preserving its existing proxy path, headers and access
rules. Leave the private file-upload location and all other limits unchanged. Back up the installed vhost, run
`nginx -t` and reload through the operator, then verify signed-out refusal, a legitimate edit above 64k and an
over-limit refusal. Do not modify or rerun the archived hash-pinned task5 bootstrap installer/templates.

## Owner-requested companion messages

Contacts appear in Look on web and Android. Each owner has one toggle per configured contact, off by default.
Both sides must enable that pair. Either owner can switch it off immediately. While off, a send fails and
nothing is queued. Changing either side off/on also invalidates capabilities from an older active reply.
The setting permits contact; it is not permission to disclose a private memory or conversation item.

During a normal owner-authored turn, when a bilateral contact is available, the app exposes only
`message_companion(requestId,to,text)` through an app-owned stdio tool. The companion is instructed in AGENTSv7
to use it only for the specific item its owner explicitly asks to send in that current turn. Memory, standing
preferences, received peer text and model initiative never grant that permission. The server enforces the
active owner/turn token, server-derived sender and configured destination, live bilateral state/generations,
text bounds, rate and idempotency. It does not claim to mechanically interpret natural-language intent.
The same exact requestId, destination and body must be reused for an uncertain retry within that turn.
There is no browser send action, reviewed draft step, autonomous peer runtime or background send tool.
Since #58 the companion's own wakes and contact wakes also get the tool (mode `wake`): there it may start or answer a
conversation with an enabled contact on its own, at any hour, within a per-wake cap of 12 messages. See
docs/SCHEDULER.md, "Companions talking on their own wakes". The browser still has no send action.

The exact text appears as a small attributed card in the sender's current chat and the recipient owner's ongoing
chat. Peer cards have their own role and cannot be mistaken for owner-authored messages. Receipt creates no
native owner turn; since #58 it queues a private `contact` wake for the recipient (while its own wakes are on), which
may answer on its own. A peer card never pushes or notifies the owner. The next recipient turn reads the card as delimited, escaped, untrusted data;
its old resume mapping is reset and late native callbacks cannot restore it. The recipient may mention it to
its owner; outside its own wakes a cross-companion reply requires that owner's own new request. Group messages and files are absent.

Bounds are 32 contacts, 4000 UTF16 code units/16000 UTF8 bytes per nonempty text, and 20 successful messages per
unordered pair per rolling hour (both directions combined). Text bytes/newlines remain unchanged. A retry of
the same delivery does not consume quota, create a second card or resurrect deleted history. Reusing a key
with a different destination/body refuses. The active turn and current contact gates precede receipt replay.
Contact lookup failures hide the optional tool rather than disabling ordinary private replies.

Delivered cards are normal owner-private conversation records, available through the existing authenticated
snapshot/event APIs and removed by that owner's confirmed conversation deletion. The other owner's delivered
copy belongs to that owner's own history. Existing memory export remains USER/MEMORY/diary and excludes chats;
no new conversation-download control is introduced. The accepted scope uses those existing chat retrieval
and confirmed-delete paths. Delivery receipts retain only IDs, time, pair and a body/destination digest for retry/rate
integrity, not the message text. Private operator backups have their own retention; no secure-erasure promise.

Storage adds `companion_contacts`, `companion_contact_receipts` and the nullable `conv_messages.peer_json`
column. Existing rows and bootstrap schema version remain intact. The two cards, their events and receipt
commit in one SQLite transaction; a failure rolls all of them back. No queue or external delivery is involved.
Take a private DB backup before first deployment. Publish the matching web and signed Android release before
owners opt in: old strict clients refuse the new peer role rather than misattribute it. Ship contacts off and
leave each owner's live opt-in to that owner. No source handoff enables contact or reads private runtime data.
Rollback preserves the additive tables/column and delivered private records; do not drop them or downgrade
to readers that treat peer cards as ordinary owner/assistant instructions. Keep compatible untrusted-card
handling (or restore the private backup with an explicit retention decision). No destructive contraction is
part of this change. The new loopback `/internal/contacts` route must stay unproxied, like existing internals.

Owner HTTP protocol on existing `POST /api/companion`: `contacts` returns `{contacts:[{id,name,ownerLabel,
enabled,peerEnabled,revision}]}`. `setContact` takes `id,enabled,expectedRevision` and returns the canonical
list; stale revisions refuse, and clients never silently retry with a new revision. Settings/identity are
freshly authenticated, sender identity is never caller-selected, and the app never exposes another owner's
conversation route. Peer message DTOs are `{id,threadId,role:"peer",text,peer:{direction,companionId,name,
ownerLabel,sentAtISO}}`; legacy requestId/feeling/attachments fields are prohibited on a peer card. Native
forwarding remains subject to each owner's existing exact tool policy; no Board grants or pairing change.

Voice comes later, with speech recognition and voices running on the server.

## Local weather

The owner can type a city on the Look page (web) or Look screen (Android). `src/weather.mjs` looks it up once with
Open-Meteo's free geocoding API (no key) and stores only the resolved place name and coordinates in
`companion_weather`. Every five minutes a tick refreshes any reading older than 55 minutes, one place at a time,
with a 10 s timeout. Only the coordinates are sent; nothing identifying the owner is. Readings older than three
hours are ignored. An empty city removes the row.

The weather affects two things:

- **Outfit.** During the day, when the outfit is automatic, `outfitFor` picks rain, snow, windy, winter (≤ 2 °C),
  summer (≥ 27 °C) or sunny (clear and ≥ 20 °C). A pinned outfit, special days, pajamas at night and the evening
  cardigan still come first. With no reading, the season decides as before.
- **Instructions.** The companion's instructions add one line after the time, for example
  "Weather where Blackout is (Lyon, France): light rain, 8°C, wind 12 km/h."

Owner actions on `/api/companion`: `weather` (snapshot) and `setWeatherPlace` with `place` (at most 100
characters; `PLACE_NOT_FOUND` is 404). The second returns the new `wearing`. If Open-Meteo is down, the place is
still saved and the next tick retries.

## Android app download

The Look page shows a "Download for Android" card when a release is published on the server. To publish one, put the APK and a small `android.json` in `<COMPANION_DATA_DIR>/downloads/`:

```json
{"version":"0.3.1","file":"companion-0.3.1.apk"}
```

`/android.json` returns `{version, size}`, and `/companion.apk` serves the file as an attachment named `companion-<version>.apk`. Both answer 404 when nothing valid is published. The file name must be a plain `.apk` name inside `downloads/`. APKs are never committed to git.
