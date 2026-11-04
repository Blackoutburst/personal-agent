# Conversation protocol (ticket #8)

The chat with your companion (COMPANION.md) runs on this protocol. `/conversation.html` now redirects to
the companion app. The service has two modes:

- **Account mode** (`COMPANION_MODE=account`): real conversations. Every request revalidates
  the platform session and routes the account only to its own companion, which answers through
  that owner's own Claude or Codex (see RUNTIME.md). Conversations are kept on the server, so
  every device of the same owner sees the same threads.
- **Demo mode** (`COMPANION_MODE=demo`): a synthetic fixture for UI development. Replies are
  canned, marked `synthetic:true` and labelled "no AI" on the page.

Default mode is unavailable.

## Protocol

`POST api/conversation` with a JSON body. Same-origin only; the body limit is 64 KiB in account
mode (16 KiB otherwise). Responses carry `version:1` and `synthetic` (`false` in account mode).

| Action | Request fields beyond `action` | Response fields |
| --- | --- | --- |
| `snapshot` | optional `threadId` | `threads`, selected `threadId` (nullable), the latest 60 `messages`, `cursor`, `runtime:{state, provider?}`, optional current or latest failed/stopped `turn` |
| `createThread` | `requestId`, `title` | `thread:{id,title}` |
| `submit` | `requestId`, `threadId`, `text` | `accepted:{requestId,threadId,messageId}` |
| `events` | `threadId`, `cursor` | `events`, next `cursor`, `lastSeq`, `hasMore` (100 events per page) |
| `cancel` | `requestId`, `threadId` | `cancel:{requestId,threadId,state}`: `stopping`, `cancelled` (was queued) or the final state |

`runtime.state` is `ready`, `signed-out`, `unconfigured` or `provider-missing`
(`development-double` in demo mode).

A snapshot includes the open reply as `turn:{requestId,state:'streaming'}`. With no open
reply, it retains the latest owner turn when its state is `error` or `cancelled`, using
the same turn/error fields as events. A newer successful owner turn clears that context.
This read does not replay an event or provider call; the cursor remains at the current head.

Events per thread are contiguous:

- `message` holds the full current text of a message (the client upserts by id); an assistant message may
  carry `feeling`, the face the companion chose (COMPANION.md);
- `noop` is an earlier event of a message whose newer text appears later in the same page;
- `turn` holds `requestId` and `state`: `streaming`, `complete`, `error` or `cancelled`. On
  `error` it adds `error:{code, message, resetsAt?}`. `resetsAt` is ISO 8601. Codes include
  `NOT_SIGNED_IN`, `USAGE_LIMIT`, `NO_RUNTIME`, `PROVIDER_MISSING`, `PROVIDER_ERROR`, `TIMEOUT`
  and `INTERRUPTED`.

`submit` is idempotent by `requestId`: a retry returns the same answer, while a different
payload under the same id is `CONFLICT` (409). A new thread titled "New conversation" takes its title from its first message.

### Texting like a person (live: `texting`, `gatherMs` 3500, `COMPANION_TEXTING=off` turns it off)

The owner can keep texting while a reply is on its way; only a running background wake still answers `BUSY` (409).

1. **Waiting for the owner to finish.** An owner turn waits before it starts: `gatherMs` after a normal text, half
   of it after one that looks finished (`?`, `!`, a full sentence, an emoji), double after a fragment (≤3 words without
   punctuation, a trailing comma, "and", "so", "mais"…) or a file on its own (`quietWindow`, src/texting.mjs). While
   the owner is typing it keeps waiting, at most 60 s after their last text. Typing comes from the apps (`typing`
   action `{threadId, active}`, sent at most every 3 s while the message box has text, held 6 s; clearing the box
   or sending ends it, and while a voice message is being recorded) and from Discord (`TYPING_START`, held 11 s).
   A voice message on its own waits half of `gatherMs` (FILES.md, Voice messages). A text sent during the wait folds the waiting
   turn into its own (DB state `merged`; clients see that turn `complete`).
2. **Starting over while nothing is seen.** A running reply that has shown nothing yet and has not acted (no
   tool call: the providers report `acting` when one starts) is stopped and merged into the new text's turn, so
   one reply answers everything. A reply already shown, or one that acted, finishes; the new text is answered right
   after it.
3. **Bubble by bubble.** Each finished bubble (text before a blank line outside a code block) shows as soon as it
   is written; the one being written never shows. Clients keep showing "typing" until the turn ends.
4. **Silence and context.** The companion gets every text of the burst, one per line, with a note when there are
   several, and a note when they were sent during or within 30 s of its last reply (add only what is new). A reply
   of exactly `NO_REPLY` (or ending in a `NO_REPLY` line) sends nothing. A new thread titled "New conversation" takes its title from its first message.

## Server (`src/conversations.mjs`)

Replies run on the server, independent of any browser. Closing the page does not stop them.
Turns are queued per companion, so each owner's agent answers one message at a time.

- The assistant message is created on the first text and updated every 400 ms while streaming.
- Each thread keeps its provider session id, so later messages resume the same agent session.
- Stop aborts the agent process and keeps what was written so far.
- A crash or restart never re-runs a reply silently. A reply that was running is marked
  `INTERRUPTED`; a queued one runs after restart. A graceful stop marks running replies
  `INTERRUPTED` and keeps queued ones.
- No model turn is ever started without a user message.

Limits (`LIMITS`): 8,000 characters per user message, 100,000 per reply, 80 per title and
200 threads per owner.

## Client (`public/conversation-client.mjs`)

The client model provides `open`, `select`, `create`, `send`, `retry`, `cancel`, `refresh`,
`poll`, `setDraft`, `clear` and `subscribe`. It validates every response strictly, recovers
from event gaps with a snapshot, and keeps an uncertain send's request id for an explicit
retry. It never resends on its own. The companion app (COMPANION.md) uses it for its single
ongoing chat: it polls every 0.5 s during a reply, every 2 s right after something happened, then backs off
(see Idle performance below); a hidden tab reads once a minute and reloads when it becomes visible again.

Failed reads use bounded reconnect backoff and an explicit Reconnect chat action when
exhausted. These reads never retry a write. An uncertain write keeps its original key for
explicit retry; a definite BUSY/CONFLICT refusal keeps the unsent text for review without
overwriting newer typing. Drafts and unconfirmed payloads remain local to the current tab.

## Tests

- `test/conversation-account.test.mjs` runs the account mode end to end with fake `claude`
  programs: streaming, resume, owner isolation, idempotency, stop, errors, restart and
  shutdown. It also drives the browser client model against the real server.
- `test/conversation-client.test.mjs`, `test/conversation-http.test.mjs` and
  `test/conversation-integration.test.mjs` cover the client contract, the HTTP boundary and the
  demo fixture.

No real accounts, conversations or provider usage enter the tests.

## Idle performance (#60)

Report: with the companion tab open and idle, a YouTube 1080p60 tab dropped ~24% of frames; closing the companion fixed it.

**Root cause (measured).** Headless Chromium 1248 against a local harness serving `public/` with a fake signed-in API
(Claude-chan and Pip), CDP trace + `Performance.getMetrics` + a MutationObserver, 60 s idle windows:

| idle, per minute | before (6217a61) | after, 30 s in | after, 4 min in |
| --- | --- | --- | --- |
| compositor frames drawn (`DrawFrame`) | 3601 (60 fps, nonstop) | 18 | 22 |
| running infinite animations | 4 (`breathe` + `frame-blink` on the stage and top-bar avatars) | 0 (paused) | 0 |
| main-thread paints / layouts | 174 / 210 | 36 / 18 | 44 / 22 |
| DOM mutations | 2772 | 19 | 22 |
| API requests | 29 (22 `events`, 2 `boardInbox`, 2 `groups:list`, 3 `clientActive`) | 15 | 4 |

1. GPU: the avatar's idle loops (`breathe`/`bob`/`float` on the SVG `.char-body`, `frame-blink`/`blink`) were infinite CSS
   animations, on two avatars. Chrome composites them, so the main thread stays tiny, but the compositor and the GPU process
   draw a new frame 60 times a second forever, in Chrome's GPU process that the video tab shares.
2. Every second `renderAll()` rewrote the same texts and flags (`textContent`, `hidden`, `disabled`, `document.title`): about
   46 mutations a second, each forcing style, layout and paint.
3. Network: the chat read every 3 s (plus request time) forever; an open group read every 1.5 s and rebuilt every message and
   avatar on each read (and with `cache-control: no-store` every avatar picture was fetched again).

**Fix.**
- `public/idle.mjs` `createMotion`: the root carries `data-motion="awake"` for 12 s after something happens (input, focus,
  coming back, a message arriving) and while a reply runs; otherwise every `.char` animation is `animation-play-state: paused`
  (no frames). Blinking is no longer an animation: `data-blink` flips for 160 ms every 3.5–7.5 s (two small paints). Leaving
  the window rests at once; hidden tabs and `prefers-reduced-motion` never move or blink. Visible change: she breathes for a
  few seconds after you do something, then holds still and keeps blinking.
- Change-only rendering: `setText`/`setProp` in the app, the 1 s timer only redraws when the face changes (happy ending,
  night), the Board list and group list/conversation only redraw when their data changed.
- Reads (`idleDelay`): 0.5 s while a reply runs, 2 s for 20 s after the owner used the page or the chat changed, then 5 s,
  15 s (after 1 min) and 30 s (after 3 min). Input brings the next read forward, focus reads at once. A hidden tab reads
  once a minute (Chrome throttles hidden timers to about that anyway), so it still learns about a new message within about
  a minute. Groups use the same ladder from 1.5 s. Board/group badges: every 30 s, every minute hidden, every 2 minutes
  after 5 idle minutes. A companion message written on its own after 4 idle minutes showed up 29.7 s later (the 30 s
  ceiling); replies to the owner's messages stay at 0.5–2 s. SSE would make that instant but needs nginx changes
  (`proxy_read_timeout 10s` and buffering on the prefix location), so it is left for later.
- One arrival hook: `dataArrived(source, detail)` in `companion-app.mjs` (subscribe with `onDataArrived`) fires once per
  new companion message in the open chat (also in a hidden tab, `hidden: true`) and per new group message.

Unchanged: #59 active-client beats (20 s while in active use), #49 push presence (15 s while the chat is visible, if
notifications are on), the 10 min outfit check. The service worker was not refetching anything in the harness while idle
(no static request in 60 s); its fetches came from avatar pictures being rebuilt, which no longer happens.
Not verified here: real Chrome with a GPU next to a YouTube tab.
