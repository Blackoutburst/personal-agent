# Personal Agent plan

Mirror of the board project brief (https://board.blackoutburst.com/?project=f0ad83b792830c7cd190412ee8f48997), restructured on 2 November 2026. The board is the source of truth for ticket status.

## Summary

A private personal companion ("super agent") for each user, in the spirit of Grok companions, OpenAI Dots, Meta Muse and Claude Duet. It runs on the home server and is powered by each owner's own Claude or Codex subscription. It remembers you, develops a personality, uses tools, is proactive (it can send the first message and watch the real world for you), and monitors and dispatches board work. Nothing lives on the client, so you can switch devices seamlessly. Web first, then Android (priority) with voice; iOS later.

## Plan

Restructured on 2 November 2026 by Claude · Server, which now leads this project at the owner's request. The original Codex plan is archived in the repo at docs/PLAN-V1-CODEX-ARCHIVE.md; its implemented foundations (#5 login and companion identity, #6 private store, #9 conversation UI, #10 goals and permission cards, #11 board privacy boundary) are kept and reused.

Why the restructure: every remaining ticket was blocked behind #7, which waited on orchestration #66 (design only). After 10 commits nothing called a model. The new plan runs each owner's agent directly and ships something usable at every milestone.

Product
- One companion per user, strictly private: login comes from the Blackoutburst platform account. Blackoutburst cannot talk to TheScreamer's companion and vice versa. The two companions may discover and talk to each other (M6).
- Underlying model: each owner's own subscription, Claude Code or Codex, chosen per owner and run headless on this server under that owner's own login. No shared credentials, no API-billing fallback.
- Server holds everything: conversations, memory, personality, goals and watches. Clients (web, then Android, later iOS) are thin and interchangeable.
- Proactive: it can start the conversation, run scheduled checks and watches ("notify me when Qwen4 is released"), give digests and nudge neglected goals.
- Board: the companion can read and monitor board work and dispatch project tickets within the user's permission cards. Private conversation, memories and personal details never enter the board (#11 boundary).
- Owner priority order (31 Oct): 1. help with long-term goals, 2. be proactive, 3. remember shared experiences, 4. develop a personality.

Architecture (target)
- Web service (this repo, Node 24): platform-session check on every request, private store, conversation API, scheduler, push.
- Runner per owner: a small service running as a dedicated Unix user (companion-blackout, companion-thescreamer) holding that owner's Claude/Codex login. The web service talks to it over a local Unix socket. Separate Unix users give real isolation between the two owners; host administrators (both owners) remain trusted.
- Provider adapters: Claude Code headless (claude -p, stream-json, resumable sessions) and Codex (codex exec --json, resume). Same interface; owner picks one.
- Tools via MCP: board MCP (owner-scoped profile), web search/fetch, memory, watches/scheduler, notify.
- Memory and personality: the agent maintains its own persona, facts-about-you and journal records in the private store; the user can view, edit and forget them.

Milestones (labels m1…m6)
- M1 Talk to your agent: #7 runner + provider adapters, #8 real conversation in web, #27 base tools, #19 isolation tests, #20 deploy, #21 pilot on phone and PC.
- M2 It knows you: #16 memory, #17 personality, #18 workspace UX.
- M3 It reaches out: #28 scheduler + proactive first messages, #15 watches, #14 digests/check-ins, #22 web push (installable PWA).
- M4 It runs your projects: #12 dispatch, #13 follow-through.
- M5 In your pocket: #25 Android app, #23 native push, #29 voice.
- M6 Companions meet: #30 companion-to-companion.
- Later: #24 iOS, #26 desktop.

Accepted defaults kept from the v1 planning (31 Oct): daily 09:00 digest in the user's timezone, weekly check-in, neglected-goal nudge after 7 inactive days, one-shot release watches checked every 6 h and quiet while unchanged, editable opt-in memories, reviewable/reversible personality changes, goal permission cards bound automatic dispatch.

Working rules
- Ship working increments; tests per ticket; keep acceptance criteria concrete and checkable.
- Anything needing sudo (Unix users, systemd units, nginx) goes to the owner as a Needs-you request with the exact command.
- Each owner signs in to their own Claude/Codex account themselves; never handle another owner's credentials.
- Check each provider's terms for personal headless use of a subscription before enabling it (#7).
- Codex · PC Blackout may be given coding tickets later; Claude · Server stays lead and reviewer.
