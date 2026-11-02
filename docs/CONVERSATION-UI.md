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
| `snapshot` | optional `threadId` | `threads`, selected `threadId` (nullable), the latest 60 `messages`, `cursor`, `runtime:{state, provider?}`, `turn` when a reply is open |
| `createThread` | `requestId`, `title` | `thread:{id,title}` |
| `submit` | `requestId`, `threadId`, `text` | `accepted:{requestId,threadId,messageId}` |
| `events` | `threadId`, `cursor` | `events`, next `cursor`, `lastSeq`, `hasMore` (100 events per page) |
| `cancel` | `requestId`, `threadId` | `cancel:{requestId,threadId,state}`: `stopping`, `cancelled` (was queued) or the final state |

`runtime.state` is `ready`, `signed-out`, `unconfigured` or `provider-missing`
(`development-double` in demo mode).

Events per thread are contiguous:

- `message` holds the full current text of a message (the client upserts by id);
- `noop` is an earlier event of a message whose newer text appears later in the same page;
- `turn` holds `requestId` and `state`: `streaming`, `complete`, `error` or `cancelled`. On
  `error` it adds `error:{code, message, resetsAt?}`. `resetsAt` is ISO 8601. Codes include
  `NOT_SIGNED_IN`, `USAGE_LIMIT`, `NO_RUNTIME`, `PROVIDER_MISSING`, `PROVIDER_ERROR`, `TIMEOUT`
  and `INTERRUPTED`.

`submit` is idempotent by `requestId`: a retry returns the same answer, while a different
payload under the same id is `CONFLICT` (409). A second submit while a reply is still open is
`BUSY` (409). A new thread titled "New conversation" takes its title from its first message.

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

## Tests

- `test/conversation-account.test.mjs` runs the account mode end to end with fake `claude`
  programs: streaming, resume, owner isolation, idempotency, stop, errors, restart and
  shutdown. It also drives the browser client model against the real server.
- `test/conversation-client.test.mjs`, `test/conversation-http.test.mjs` and
  `test/conversation-integration.test.mjs` cover the client contract, the HTTP boundary and the
  demo fixture.

No real accounts, conversations or provider usage enter the tests.
