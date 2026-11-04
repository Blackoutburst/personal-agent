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
payload under the same id is `CONFLICT` (409). The owner can keep texting while a reply is open:
a turn waits `gatherMs` (live: 5 s, `COMPANION_GATHER_MS`) after its message before it starts, and a
message sent during that wait folds the waiting turn into its own (state `merged` in the DB; clients see
it `complete`), so a burst of short texts gets one reply that sees them all, one per line. A message sent
while a reply is already running is queued and answered right after it. Only a running background wake
still answers `BUSY` (409). A new thread titled "New conversation" takes its title from its first message.

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
ongoing chat: it polls every 0.5 s during a reply and every 3 s otherwise, pauses while the page is
hidden and reloads the snapshot when it becomes visible again.

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
