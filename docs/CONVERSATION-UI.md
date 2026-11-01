# Conversation UI v1 candidate

This source adds `conversation.html`, a responsive text-and-links client, and a pinned synthetic conversation service for task #9 development. It is **not a model-backed conversation service or qualified private-runtime integration**. The deployed account-only preview remains `9d57d26`; this candidate is not deployed. Actual private owner admission, runtime/assistant provenance, provider execution and full cross-device pilot proof remain with #7/#8, orchestration #66 and #21.

Open `/conversation.html` on a local candidate server. Default mode is unavailable. Account mode can freshly check the existing platform session but keeps messaging disabled. Every account-mode conversation API request revalidates admission and returns unavailable; no synthetic history or personal runtime can be selected through request fields. Access denial returns401/403 and clears client state. Positive conversation responses exist only in explicit `COMPANION_MODE=demo` and are permanently marked `version:1, synthetic:true`; the page prominently says synthetic replies, no AI. Use sample text only. The fixture is shared synthetic development data, not a private tenant or personal companion.

## Client and transport

`public/conversation-client.mjs` supplies a browser-compatible model with `open`, `select`, `create`, `setDraft`, `send`, `retry`, `poll`, `clear`/`disconnect`, `getState` and `subscribe`. `createConversationTransport` posts JSON to the fixed relative `api/conversation` path with same-origin credentials/no-store. The public preview prefix is preserved. No API key, provider auth, Board call, localStorage, notification request, link fetch or tool execution is supplied.

| Action | Request fields beyond `action` | Positive synthetic response fields beyond version/marker |
| --- | --- | --- |
| `snapshot` | Optional `threadId` | `threads`, selected `threadId` (nullable), full committed `messages`, decimal-string `cursor`, runtime state `development-double` |
| `createThread` | `requestId`, `title` | `thread:{id,title}` |
| `submit` | `requestId`, `threadId`, `text` | `accepted:{requestId,threadId,messageId}`; never an event cursor |
| `events` | `threadId`, `cursor` | `threadId`, `events`, next `cursor`, head `lastSeq`, `hasMore` |

Per-thread event sequences are contiguous. `message` events contain the full accumulated message text and upsert by ID, so repeated pages/deltas cannot append duplicates. `turn` events carry request ID and streaming/complete/error state. The client advances its cursor only after applying a validated page. Gaps trigger a snapshot reconciliation; thread switches and clear/access loss use abort/epoch guards so stale callbacks cannot repopulate old content.

Uncertain create/send operations keep their exact request ID and payload for explicit retry. Retry reconciles the same action; a changed payload sharing an ID conflicts. No reload/hide/reopen automatically resends private input. Draft/pending state is memory-only. Hiding/leaving the page or denied access wipes messages, draft and pending state; reopening explicitly obtains a fresh snapshot. A service error with an uncertain action retains its retry identifier until explicit close/hide or reconciliation. Visible open demos poll selected threads while idle, with faster catch-up during an active synthetic turn.

Messages are rendered with text nodes. Only explicit http/https links without embedded credentials become clickable anchors; they open only on user selection with no-referrer/noopener. Link content grants no permissions. Composer input is limited to1000JavaScriptcharacters/4096UTF8bytes; thread titles to80UTF8bytes. Keyboard labels, focus states, mobile thread selection and a concise live status are provided. No uploads, voice, browser push, email or external notifications are implemented.

## Fixture and HTTP boundary

`src/conversation-demo.mjs` is a deliberately bounded **development fixture**, instantiated lazily only on an admitted same-origin demo API request. It stores one synthetic JSON record, commits paired messages and idempotency receipts atomically, and reconstructs deterministic events on restart. Each canned turn supplies five events, delivered three per page to exercise incremental rendering/replay. It performs no inference, asynchronous agent execution, account validation or network call. All replies explicitly identify their synthetic origin.

The fixture allows at most five threads and12KiB serialized state. Capacity errors preserve every committed message; this limit is not a production product quota. It never deletes/truncates history to make space. The private companion ledger is not repurposed as trusted assistant output. The fixture's shared data and generated stream are not proof of real account isolation, provider session continuity or durable runtime event ownership.

`src/conversation-http.mjs` reuses the existing exact-Origin, POST, JSON media type,16KiB body and3second read guards. Missing or cross-site origins are denied. Default/account modes cannot access a retained fixture. Account mode additionally performs fresh central validation before returning the fixed unavailable status. Errors are fixed and no-store; native provider/runtime routes remain absent.

## Verification boundary

Node tests cover source/client/service contracts, real local HTTP integration between two synthetic clients, lost acknowledgment after commit, retry/replay without duplicates, restart persistence, gap recovery, late callback denial/clear, malformed/capacity/corrupt-state rejection, and separation from account mode. These are synthetic development proofs. They do not establish actual desktop/mobile interaction, real private history across devices, runtime eligibility, owner homes or provider lifecycle. Browser automation is disabled in this workspace and must not be bypassed. Actual browser layout/keyboard review remains required before claiming that acceptance passed; the owner can review a concrete loopback-only synthetic demo through MCP.

Adapt this client boundary to the owning qualified private conversation/runtime protocol when delivered. Never silently turn a synthetic service into a real account connection or treat client-written role labels as runtime/assistant provenance. Keep private conversations, memories and details outside every Board payload and source artifact.
