# Feature map

Generated from `ops/verify/feature-map.json` by `node ops/verify/verify.mjs map --markdown`. Do not edit by hand.

Every feature is reached in the real app by its URL hash. `ready` is a selector that is visible only once the screen really shows. Keep this file in step with public/index.html and the router in public/companion-app.mjs (test/verify.test.mjs fails when they drift; `verify.mjs check-map` visits every entry in the running app).

**First run:** A fresh data dir has no companion, so every hash shows the look picker until one is saved. The tool runs the `onboard` setup (First run: choose a companion) before any feature.

| Id | Screen | Hash | How to reach it | Visible when |
| --- | --- | --- | --- | --- |
| `chat` | Chat with the companion | `#chat` | Default screen after onboarding; the Chat link in the top bar, or the companion avatar top left. | `#view-chat:not([hidden]) #input` |
| `calendar` | Calendar | `#calendar` | Calendar link in the top bar. | `#view-calendar:not([hidden])` |
| `me-profile` | Me > Your profile | `#me/profile` | Me link in the top bar, then the Your profile tab. | `#view-me:not([hidden]) #me-tabs a[data-section=profile][aria-current]` |
| `me-memories` | Me > Memories | `#me` | Me link in the top bar (opens on Memories). | `#view-me:not([hidden]) #view-memories:not([hidden])` |
| `me-companion` | Me > Companion (look, personality, weather) | `#me/companion` | Me > Companion tab. | `#view-look:not([hidden])` |
| `me-watches` | Me > Watches (release watches, reminders) | `#me/watches` | Me > Watches tab. | `#view-me:not([hidden]) #me-tabs a[data-section=watches][aria-current]` |
| `me-connectors` | Me > Connectors (GitHub, mail, X, Discord) | `#me/connectors` | Me > Connectors tab. | `#view-me:not([hidden]) #me-tabs a[data-section=connectors][aria-current]` |
| `me-settings` | Me > Settings (notifications, voice, devices) | `#me/settings` | Me > Settings tab. | `#view-me:not([hidden]) #me-tabs a[data-section=settings][aria-current]` |
| `group` | Group chats | `#group` | #group URL (the Group link appears in the top bar when groups are available to the owner). | `#view-group:not([hidden])` |
| `studio` | Studio (mail, calendar, Ops) | `#studio` | #studio URL (the Studio link appears only for owners granted Studio access; the verification harness grants none, so the view is reachable by URL but empty). | `#view-studio:not([hidden])` |

