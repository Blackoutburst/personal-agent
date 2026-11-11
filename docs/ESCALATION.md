# Escalation (#74)

Super agent plan, part 5/7. C-chan resolves most blocked/review deadlocks herself: unblock, reassign, escalate the model,
accept or return a review. Only what truly needs the owner reaches them.

## Hard limits (always the owner, even in manager mode)

Deployments, spending, deleting things, credentials, security. `src/escalation.mjs` (`hardLimit(text)`) is a deliberately
broad keyword check: a false positive costs one short question, a false negative lets an agent act alone.

- **Launches.** `AgentRunner.launch` refuses instructions that ask for a hard-limit action (`HARD_LIMIT`, HTTP 403). The
  run is never queued. The runner's Board reporter raises a **Needs-you** on the ticket, with the limit and the choices
  (yes / no / something else), once per `requestId`.
- **Agents.** Every agent prompt carries the hard limits. An agent that needs one ends with `BLOCKED: <question>`, which
  already becomes a Needs-you for the owner (#72).
- **C-chan.** A new Needs-you request whose text hits a hard limit is flagged in her wake (a fixed label, never Board
  text) and she must not answer it herself.

Not enforced in code: ticket text read by agents, and C-chan's own `resolve_human_request` calls (the Board bridge cannot
see the request text). Those rely on the prompts above.

## Batching

New Needs-you requests found in one 2-minute check become **one** wake (`needsYouBatchPrompt`), not one per request. It
lists numbered requests (ids and ticket numbers only), tells C-chan to resolve the safe ones herself, and send the rest in
one short numbered message with choices ("1 yes, 2 no"). A single request keeps the per-ticket topic routing from #55;
a batch goes to the general chat.

## Answering resolves the Board

C-chan's wake tells her to resolve each matching request with `resolve_human_request`, using the owner's answer for that
number, then confirm in one line. This is model-driven; there is no code path that resolves from chat text.
