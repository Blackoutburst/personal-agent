# Runtime evidence: PASS

- Commit `7c7316230958` on `agent/coder-2/t78`
- Ran the real server (account mode, synthetic owner) in headless Chromium, viewport 420x860
- 2026-11-11T12:47:50.121Z to 2026-11-11T12:47:51.110Z
- Console errors: 0, page errors: 0, failed requests (HTTP >= 400): 0

## Steps

1. ok [setup] goto #
2. ok [setup] wait #view-look:not([hidden])
3. ok [setup] fill #name value "Verify"
4. ok [setup] click #save-look
5. ok [setup] wait #view-chat:not([hidden])
6. ok goto feature chat
7. ok expect #view-chat #input
8. ok screenshot chat-empty
9. ok fill #input value "Hello from the verification demo"
10. ok expect #send:not([disabled])
11. ok click #send
12. ok expect #messages text "Hello from the verification demo"
13. ok screenshot chat-after-send
14. ok goto feature calendar
15. ok expect #view-calendar h1 text "Calendar"
16. ok screenshot calendar
17. ok goto feature me-settings
18. ok state 
   ```json
   {"view":"me","url":"/#me/settings","title":"Verify","text":"Your profile\nMemories\nCompanion\nWatches\nConnectors\nSettings\nSettings\n\nQuiet hours, routines and how the app looks. Reminders and watches wait until quiet hours end.\n\nDaily digest\nAt\nWeekly check-in\nOn\nMonday\nTuesday\nWednesday\nThursday\nFriday\nSaturday\nSunday\nAt\nProactive companion\nWakes per day\nOccasional check-ins\nBoard wakes per day\nNo limit\nQuiet from\nuntil\nSave\nYour timezone: UTC. Daily and weekly times use this zone. Quiet hours can delay delivery. Occasional check-ins run at most every six hours and 
   ```
19. ok screenshot me-settings

## Screenshots

- `01-chat-empty.png` (view `chat`, /#chat) sha256 `084ce357f903d8cb`
- `02-chat-after-send.png` (view `chat`, /#chat) sha256 `80f1c1fb8ca9751c`
- `03-calendar.png` (view `calendar`, /#calendar) sha256 `ef96e7137dc105cb`
- `04-me-settings.png` (view `me`, /#me/settings) sha256 `f40ad42feefe47b7`
