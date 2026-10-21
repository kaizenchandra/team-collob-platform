# Calendar experience

## Delivered workflows and source data

The former list-only calendar is now a Day, Work Week, Week and Month workspace with Today, previous/next, a date picker, timezone, personal/team filters, stable view restoration, overlapping meeting lanes, a current-time line, date-only all-day blocks, month overflow actions and an accessible full-range agenda. Desktop uses one bounded calendar scroll region; small screens use an agenda. Time-grid headers stay visible and popovers portal outside the grid. Working shifts are labelled per day and nonworking time is shaded.

Existing Postgres meeting, attendee, reminder, version and recurrence records remain authoritative. The existing occurrence/whole-series/upcoming-only editor, cancellation, RSVP, reminders and recurrence preview remain available from meeting details. Creation now captures agenda, location, audio/video/in-person type and an optional team. Team selection invites the team's current active roster plus explicit attendees; this is a snapshot of invitations, not automatic access for future team members. Only organizers and explicit invitees can read a meeting. Team context does not grant workspace-wide calendar access.

There were no HR leave, holiday, employee-location or working-hours services in this repository. New authenticated Postgres-backed sources provide working schedules, holiday-calendar assignment, company/regional/public holiday dates maintained by administrators, and full/partial-day leave requests with administrator approval. These are actual persisted records, not illustrative events. They do not automatically import an external HR system or a public-holiday dataset. Administrators must enter the applicable real holiday dates; employees choose the calendar assigned to their work location in Hours & availability. No holidays are guessed from browser location.

Meeting details show agenda as plain text, organizer, date, duration, timezone, type/location, expandable RSVP roster and existing authorized actions. The shared interactive popover supports 200 ms hover opening, 180 ms closing, pointer travel, click, focus/keyboard, Escape and outside dismissal. Fetches are identity-scoped and aborted on disposal. Opening a card does not join. No separate meeting-agent entity exists in the inspected scheduling models.

Join explicitly resolves a durable calendar occurrence → call mapping under transaction locks, then opens the existing integrated LiveKit pre-join/device setup. Concurrent Join requests reuse one call. An active session in that call is shown again without rejoining; a different active call returns an actionable conflict. Backend meeting eligibility is checked again before media authorization. Removed calendar invitees lose channel access, grants are revoked, and room generations rotate through the existing credential-retirement mechanism. Cancellation ends the associated call and revokes grants; generic channel-call creation cannot restart the scheduled meeting.

## Application policies (not Microsoft Teams defaults)

- Authenticated current workspace members only; meeting details require an explicit invitation or organizer role. Calendar identifiers never grant access. No new external provider/Graph connector was added.
- New room creation opens 15 minutes before start and closes at scheduled end. An unused prepared call survives abandoned device setup until scheduled end; opening Join alone does not consume the occurrence. The same time-window checks apply at actual media authorization. An already attended/running room remains joinable until its actual termination. A terminal room is never recreated for that occurrence. Its organizer is the initial host; existing host-transfer/departure policies remain in force.
- Existing call capacity, per-device ownership, grace periods, media-token checks and cleanup are reused. Audio/video remains in the existing SFU stack. Calendar UI does not own the media session.
- One configurable shift per weekday, including overnight shifts. Work Week follows configured weekdays; an unconfigured schedule displays a labelled Mon–Fri 09:00–17:00 fallback in the user's timezone. This display fallback does **not** make attendee availability known. Equal shift start/end denotes a 24-hour shift. Adjacent shifts form continuous working time.
- Working timezone is stored per user/workspace. The profile timezone is used before configuration. Initial Today follows the working timezone, including when it is a different civil date. Explicitly chosen dates survive route changes in user/workspace-scoped session storage.
- Meetings/partial leave use instants; full-day leave and holidays use civil dates, without UTC-midnight shifting. Full-day leave end dates are inclusive; API visible ranges are half-open. DST grids use actual elapsed minutes (23/25-hour days), distinguish repeated-hour offsets and omit nonexistent hours. Existing recurrence keeps local anchors and rejects invalid clock gaps.
- Employees request/cancel their own leave; workspace owners/admins approve or cancel requests. Only own pending/approved leave is exposed by the calendar feed. Other employees' approved leave is disclosed as **Unavailable** in scheduling free/busy checks, without reasons, record IDs or private meeting titles. There is no HR-wide employee-leave browsing view.
- Administrators maintain named holiday calendars; employees select the applicable calendar. Assigned dates are visible in the all-day region. Empty calendars contain no assumed dates.
- Availability is limited to active users in the same workspace. It combines internal meetings, approved leave, assigned holidays and configured shifts. Missing schedules, inaccessible users and failed requests remain unknown. Conflicts warn and do not block scheduling. A series preview does not claim every future attendee is free.
- Persisted schedule/leave/holiday records follow existing database backup/retention policies; no new background deletion policy was invented. No private message/agenda content or media credentials are added to logs.

## Contracts and important files

| Contract | Authorization and behavior |
| --- | --- |
| `GET /organizations/:org/meetings?from=&to=&afterStart=&afterId=` | Existing scoped, deterministic occurrence pagination; range queries, no duplicates across pages. Adds team/location/type metadata. |
| `POST /organizations/:org/meetings` | Existing creation/recurrence with optional `description`, `location`, `meetingType`, `teamId`; stable `clientId` now deduplicates single meetings too. Conflicting payload reuse returns 409. Legacy recurrence hashes remain compatible. |
| `GET /organizations/:org/meetings/:meeting/details` | Organizer/invitee only; authorized roster and linked-call status. |
| `POST /organizations/:org/meetings/:meeting/call` | Explicit action only; scope, cancellation, lifecycle, early-join, capacity and existing-call policy checks; returns fixed `{id, channelId, mode}`. Does not itself acquire browser devices. |
| `GET/PUT /organizations/:org/calendar/settings` | Own workspace schedule, IANA timezone, unique ISO weekdays 1–7, HH:mm shifts and assigned holiday calendar. |
| `GET /organizations/:org/calendar/blocks?from=&to=` | Own authorized range-limited date-only holidays and pending/approved leave. |
| `GET /organizations/:org/calendar/teams/:team` | Current team member only; active roster for scheduling availability. |
| `POST /organizations/:org/calendar/availability` | Bounded time range and up to 100 active workspace users; only conflict categories, unknown or available; optional own editing exclusion. |
| `POST /organizations/:org/calendar/leave`, `GET .../my-leave` | Own leave creation and active request history. |
| `GET .../calendar/leave`, `PATCH .../calendar/leave/:leave` | Admin review; own cancellation allowed. Cancelled requests cannot be approved again. |
| `GET/POST/DELETE .../calendar/holidays[/:holiday]` | Admin-only maintenance; year-scoped listing; unique calendar/date/title. |

Frontend: `app/components/calendar-canvas.tsx`, `calendar-settings.tsx`, `panels.tsx`, `meeting-editor.tsx`, `profile-popovers.tsx`, `workspace.tsx`, `media-workspace.tsx`, `app/globals.css`.
Backend/data: `services/core/calendar.ts`, `calendar-media.ts`, `meeting-protocol.ts`, `work.ts`, `security.ts`, `media.ts`, `server.ts`; migrations `040_calendar_experience.sql`, `041_calendar_request_deduplication.sql`; shared Temporal helpers `lib/calendar.ts`; API image includes the shared helper in `Dockerfile`.
Verification: `tests/calendar.test.ts`, updated `tests/browser/calendar.spec.ts`, `tests/browser/calendar-experience.spec.ts`, existing `tests/core.test.ts` and `tests/meeting-time.test.ts`.

## Setup and local use

No new package, credential or environment variable is required. Deploy the API and media worker from the same build; an old media worker will still apply the former generic empty-call timeout. Existing `DATABASE_URL`, application/session settings and LiveKit configuration from `docs/MEDIA.md` are required for actual media. The API startup applies immutable, checksum-checked migrations; for a standalone setup use `npm run db:migrate` against the intended database.

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml build api web
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml up -d --wait api web media-worker
npm run typecheck
npm run lint
node --import tsx --test tests/calendar.test.ts tests/calendar-media.test.ts tests/meeting-time.test.ts
npx playwright test tests/browser/calendar.spec.ts tests/browser/calendar-experience.spec.ts
```

Open `http://localhost:3101`, choose Calendar, configure Hours & availability, and have an administrator add the real applicable holidays/approve leave. Schedule a meeting with another authenticated workspace user (or your team), select its card and Join near its start. The other user opens the same calendar occurrence and joins independently. Both see the same integrated call; no application popup is created. Browser permissions remain native. The tests use isolated generated organizations and identities and never alter shared demonstration users' calendars.

## References

Official material reviewed on 2026-10-21:

- [Get started with the Teams calendar](https://support.microsoft.com/en-us/teams/meetings/get-started-with-the-microsoft-teams-calendar), including its calendar screenshot: date navigation, view selection and calendar entry presentation.
- [Manage your calendar in Teams](https://support.microsoft.com/en-us/teams/meetings/manage-your-calendar-in-microsoft-teams): details, RSVP and work-week interaction patterns.
- [Schedule a meeting in Teams](https://support.microsoft.com/en-us/teams/meetings/schedule-a-meeting-in-microsoft-teams): attendee and channel/team context, scheduling and availability workflows.
- [Set work hours and location](https://support.microsoft.com/en-us/outlook/notifications-and-settings/set-your-work-hours-and-location-in-outlook): per-day hours and location-dependent scheduling context.

These inform interaction patterns only. The database models, approval/visibility policies, manually maintained holiday calendars, snapshot team invitations, 15-minute join window, fallback hours and persistence choices are application-specific decisions. There is no Teams/Outlook synchronization or inferred Microsoft policy.

## Verification results

Verified locally on 2026-10-21:

- Production API/web Docker builds passed. API, web and media worker are running the matching build. Migrations 040/041 applied through normal startup; the isolated backend suite also verifies migration/checksum compatibility.
- `npm run typecheck` passed; `npm run lint` passed with one pre-existing unused eslint-disable warning in `notification-permission.tsx`. `git diff --check` passed.
- All 106 existing backend regression tests passed, including organization isolation, calendar revisions/recurrence, legacy request hashes, invitation races, media credentials, moderation and provider replay behavior.
- All 18 focused calendar/join-window/date-time tests passed: overlap lanes, configured weekdays, adjoining overnight shifts, DST gaps/folds, 23/25-hour timelines, exact repeated-hour positions and join-window lifecycle.
- The complete 10-test calendar Chrome suite passed in about one minute. The three new experience tests were rerun with additional rendered full-day leave, partial-day dimensions and regional-calendar assertions: all three passed in 16 seconds.
- Browser checks covered 1440×900, 1366×768, 834×1194 and 390×844. Screenshots were visually inspected. Desktop main-container overflow was measured; overlapping lanes, Month More events, keyboard/click/hover details, popover viewport bounds, mobile agenda, Escape/outside dismissal and saved date/view were checked.
- Calendar creation/editing, RSVP reset, invitation removal/re-addition, cancellation, recurrence across DST, monthly expansion with stable IDs, yearly rescheduling, upcoming-only edits, 53-event pagination, failed-page retry and cross-window reminder dismissal passed.
- Real local LiveKit transport was used between two separately authenticated Chrome contexts with **simulated camera/microphone devices**. Tests observed decoded remote video, live remote audio playback, unchanged grant IDs when returning through Calendar Join, a prepared call surviving the cleanup cycle, legacy implicit-organizer access, invitee removal denial, termination and released video tracks. This is not a physical-device or cross-network media certification.
- Approved full-day leave and assigned regional holidays rendered in the all-day region; partial-day leave occupied its actual two-hour interval. Own calendar feeds withheld another user's leave; free/busy withheld private titles/identifiers. Uninvited/cross-workspace details/token access and unauthorized approvals/holidays were denied. Conflicting scheduling retries and unauthorized availability exclusions were tested.

Evidence: `docs/evidence/calendar-verification.txt`, `calendar-details-desktop.png`, `calendar-details-mobile.png`, `calendar-month-desktop.png`, `calendar-leave-approved.png`, and `calendar-{1366x768,834x1194,390x844}.png`. Screenshots contain generated isolated test records, not production records.

Remaining dependencies/limits: real HR/public-holiday imports and automatic employee-location assignment are absent; administrators must maintain applicable holidays and approve leave. External provider calendar synchronization/URLs are not configured. Free/busy is a snapshot of internal data, not a reservation, and does not certify external calendars. Whole-organization leave browsing, arbitrary RRULE/import formats, split daily shifts, drag-rescheduling and physical mobile/other-browser testing were not added. Physical-camera/microphone, cross-network/TURN, Safari and Firefox checks did not run; the local media results above used Chrome and simulated capture. These limitations are not presented as working controls or external integrations.
