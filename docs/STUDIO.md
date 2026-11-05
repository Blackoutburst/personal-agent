# Studio tab (#65)

The web app's **Studio** tab is shown to Studio members (Android has no Studio tab). A Studio is a shared mailbox whose
`mail` block in `owners.json` lists `studioViewers` (docs/MAIL.md, "Private Studio contact view" and "Shared mailbox").

## App grid

`#studio` opens on a grid of app tiles; `#studio/<app>` opens one app with a back control to the grid (deep links and the
browser back button work). The tiles come from the `APPS` array in `public/studio-ui.mjs`; a new app adds an entry there,
an access flag in the `/api/studio` `access` answer and its view.

| Tile | Route | Who sees it | What it is |
| --- | --- | --- | --- |
| Boîte mail | `#studio/mail` | the `studioViewers` | the read-only contact book and correspondence (#52), unchanged |
| Calendrier | `#studio/calendar` | every Studio member | the shared Studio calendar below |

`{ "action": "access" }` answers `{ allowed: true, apps: { mail, calendar } }`, or 403 when neither is allowed. The Studio
nav link appears for any member, so an owner who shares the mailbox without being a viewer (screamer today) sees the
tab with the Calendar tile only.

## Shared Studio calendar

One calendar per Studio, keyed by the mailbox address (`src/studio-calendar.mjs`, table `studio_calendar_events`,
`studio` = the address). Members are the owners in `studioViewers` plus the owners whose own `mail.address` is that
mailbox. Each member and each member's companion read and edit the same events.

- Fields: title (200), start and optional end (local `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` for all day; at most 366 days
  long), location (200), notes (2,000), company (200), contact (254). No repeat and no reminders.
- Timed events are stored as UTC instants and shown in each member's own timezone (their profile timezone); all-day
  events are dates. Input times are the acting member's local wall time.
- `created_*` and `updated_*` record who added and last changed an event: kind `human` (the owner's display name from
  Me › Profile) or `companion` (the companion's name), plus the member's companion id (not returned).
- Updates are full replacements guarded by `expectedVersion` (409 on conflict; resending an applied change is
  accepted). Create retries are idempotent per member and kind (`requestId`). At most 1,000 events per Studio; a view
  covers at most 400 days and also returns the next 20 upcoming events (`upcoming`).
- All text is members' data, shown as plain text and never followed as instructions.

### HTTP

`POST /api/studio` (same session and origin checks as the mailbox view), for members only (others 403):

```json
{ "action": "calendar", "input": { "from": "2026-11-01", "days": 42 } }
{ "action": "createEvent", "input": { "requestId": "…", "event": { "title": "…", "start": "2026-11-12T14:00", "company": "acme.example" } } }
{ "action": "updateEvent", "input": { "id": "…", "expectedVersion": 1, "event": { … the whole event … } } }
{ "action": "deleteEvent", "input": { "id": "…" } }
```

The path is already covered by nginx's `^~ /personal-agent-preview/` prefix location; no nginx change.

### Companion tools

`studio_calendar_list`, `studio_calendar_create`, `studio_calendar_update` and `studio_calendar_delete` in the scheduler
MCP (`src/scheduler-mcp.mjs`, action `studioCalendar` on `/internal/scheduler`), with the personal calendar's shape and
conventions (`requestId` retries, `expectedVersion`). They are in a turn only when the owner is a Studio member
(`Connectors.toolFilter`, `studioMember`), and the server checks membership again. Mail, connector and Board wakes get all
four, like the mail tools; the companion's own wakes and contact wakes may only list (they never send mail either).
AGENTS.md (version 29, "Studio calendar") tells the companion that meetings, calls and deadlines from Studio work go here,
never on the owner's personal calendar.

The web UI is `public/calendar-ui.mjs` (the personal calendar's month grid and editor) with French labels, the company
and contact fields, a "who added it" line and an "À venir" agenda.
