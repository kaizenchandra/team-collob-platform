# Organization hierarchy

The Organization navigation item, account menu’s **My organization**, and employee profile cards’ **View organization** open the same read-only employee explorer. It uses authenticated PostgreSQL records, not chat-team ownership or workspace roles as reporting relationships. Existing message and LiveKit calling actions are reused; navigating this view does not own or dispose the media session.

## Source data and setup

Inspection found users’ names, titles, work email, memberships and presence, but no employment manager, department, unit or location source. Migration `042_organization_directory.sql` adds a workspace-scoped `organization_people` projection linked to existing memberships. No existing employee is assigned an invented manager or attached to a default root. No HR/identity-directory synchronization or reporting-line editing UI/API is introduced.

An approved directory/provisioning process must supply those assignments before existing employees have populated reporting hierarchies. The source is still a deployment dependency. Do not infer employment relationships from teams, organization roles or approval routes. Test records are generated only in isolated verification workspaces and their memberships are deactivated after verification.

Run the established migration command against the application database:

```sh
npm run db:migrate
npm run typecheck
npm run lint
```

No new packages, secrets or environment variables are required. Existing `DATABASE_URL`, application authentication and calling configuration remain applicable. API startup applies migrations in the existing local Compose setup. Rebuild the API/web images when running containerized code.

The source contract is one row per `(org_id,user_id)`:

- `reporting_status=unknown` means not configured; `root` explicitly records no primary manager; `assigned` requires `manager_id` referencing a membership in the same workspace.
- Optional authorized fields: department, organizational unit and work location. User name/title/email and live presence continue to come from their existing sources.
- `visibility=workspace` permits active workspace members to read the profile. `restricted` permits only the employee and current owners/admins. Inactive memberships and disabled accounts are excluded from navigation, search and counts. Existing historical communication identity remains governed by its existing permissions; restriction does not erase message author names.
- `source_label` and optional `source_as_of` identify the directory source. Database updates increment `revision` and refresh `updated_at`; the UI distinguishes source time, record time and last read time.
- This is a current primary-assignment projection. Effective-dated, matrix, dotted-line and vacant-position models are absent in the repository and are not synthesized.
- Self-manager writes are rejected by a constraint. Multi-person cycles are reported and traversal stops; display code never repairs or changes source assignments.

## Read contracts and permissions

All endpoints require an authenticated, current active membership of the requested workspace. A caller cannot provide an administrator override. Responses use the existing `Cache-Control: no-store` policy. Missing, foreign, inactive or restricted people return the same unavailable `404` response; inactive callers fail membership authorization. Invalid UUIDs, malformed cursor pairs, unknown parameters and page sizes outside 1–50 are rejected.

Paths below are relative to `/v1/organizations/:id/organization`:

| GET endpoint | Result |
| --- | --- |
| `/people?q=&department=&roots=&limit=&afterName=&afterId=` | Authorized search by literal name/title/email/department/unit substring, exact department and explicit roots. Stable `(lower(name),id)` ordering and keyset cursor. |
| `/departments` | Up to 100 authorized department suggestions; the search field also accepts other exact values. |
| `/people/:person` | Employee, visible immediate manager, root-first visible manager path, path status and read timestamp. |
| `/people/:person/profile` | Authorized employee contact/organization card and visible manager. |
| `/people/:person/reports` | Paginated authorized direct reports. |
| `/people/:person/peers` | Paginated colleagues with the same visible recorded primary manager. |

Pages return `{people,nextCursor}` where a cursor is `{name,id}` and null indicates the final page. Profile fields include visible direct-report count, not hidden or inactive employee totals. A hidden/unavailable manager stops the reporting path and peer lookup; the implementation neither skips that manager nor reveals their ID. Context and paged reads use repeatable-read transactions so counts and returned records share a snapshot. Bootstrap directory visibility uses the same server predicate as profile/search/branch reads.

Manager traversal is capped at 20 ancestors with an explicit continuation warning and navigable upper entries. Each expanded branch loads only on demand, 20 employees per page (API maximum 50). Five nested displayed levels are followed by a **View next level** action rather than ever-smaller cards. This keeps every visible employee reachable without loading the whole organization.

## Interaction and application decisions

The selected employee has a labeled highlighted card, their immediate manager above, direct reports below and optional same-manager peers alongside. Root, unconfigured manager, inaccessible manager, no reports, source failure, cycle and truncated path have distinct messages. Multiple roots are searchable; unknown employees are never labeled leaders.

Back/Forward, Back to me, explicit centering, breadcrumbs and a shared-data list alternative provide navigation without canvas panning. Selection history (IDs only, last 40) is stored in session storage scoped to workspace and signed-in user. Search and page positions persist during refresh; loaded visible branches refresh every 15 seconds and when the tab becomes visible. Data failures withdraw stale profile details and provide retry. Refreshing does not recenter the view.

Employee cards reuse interactive portal profile popovers (200 ms opening/180 ms closing delays), Escape/outside dismissal, keyboard/touch access and viewport positioning. Profile fetches are abortable and timeout after eight seconds. Asynchronous keyboard openings retain focus inside the loading dialog and move to the first authorized action when it arrives, without moving pointer users’ focus or stealing focus from a selected control. Only one transient profile popover opens at a time.

There is no photo source in the current schema; initials are shown. Missing titles are labeled instead of fabricated. Messaging and audio/video calls reuse the existing identity/permission-aware workflows. Communication controls and hierarchy selection are separate targets. Layout uses readable cards and normal document scrolling, collapses into a focused vertical view on narrow displays, wraps long names and respects reduced motion.

## References and differences

Official reference material reviewed, including the Org Explorer screenshot:

- [Use the Organization tab in Microsoft Teams](https://support.microsoft.com/en-au/teams/apps-service/use-the-organization-tab-in-microsoft-teams): selected-person context and navigation to managers and reports.
- [Org Explorer](https://support.microsoft.com/en-us/people-skills/org-explorer) and its [official screenshot](https://support.microsoft.com/en-us/people-skills/media/teams-org-explorer.png): manager path, focused employee, peers, progressive expansion and people search.
- [Profile cards in Microsoft 365](https://support.microsoft.com/en-us/outlook/profile-cards-in-microsoft-365): concise identity, organization details and communication actions.

These are interaction references. The visibility rules, polling interval, page sizes, expansion limits, storage projection, unknown/root distinction and supported actions are application decisions, not claimed Teams defaults. No Microsoft Graph integration is required or implemented.

## Implementation files

- `app/components/organization-explorer.tsx`, `lib/organization.ts`: hierarchy, navigation, search, progressive lists and typed contracts.
- `services/core/organization.ts`, `services/core/organization-access.ts`, `services/core/server.ts`: authenticated queries and shared visibility.
- `migrations/042_organization_directory.sql`: constraints, indexes and revision trigger.
- `app/components/profile-popovers.tsx`, `app/components/workspace.tsx`, `app/globals.css`: profile/account entry points, shared contact actions and responsive presentation.
- `tests/organization.test.ts`, `tests/browser/organization.spec.ts`: defensive path logic, real database/API isolation and interaction/media checks.

## Verification

Local verification on 2026-10-21:

- API and web production Docker builds succeeded; migration 042 applied to local application and regression databases.
- TypeScript passed; ESLint passed with the existing unused-directive warning in `notification-permission.tsx`.
- All 106 existing backend regression tests and three organization unit tests passed.
- Four new Chrome browser tests and three existing profile/group-call browser regression tests passed against the real API/database: authorization and workspace isolation; visible-only counts/search/bootstrap; restricted manager boundaries; paging 44 reports with no duplicates; roots/unknown/inactive/disabled profiles; cycles and 20-ancestor limit; failed/retried reads; stale response rejection; branch expansion/refresh; profile pointer/keyboard/touch dismissal; correct same-name employee selection and communication targets. The regression run caught and verified a fix for focus arriving before asynchronous profile data.
- Separate authenticated browser sessions exchanged audio and video through local LiveKit from employee actions using Chrome’s simulated camera/microphone devices. Navigation preserved the active call. This verifies real transport with simulated capture, not physical-camera or cross-network/TURN performance.
- Screenshots in `docs/evidence/organization-*` cover 1440×1000, 1366×768, 834×1194, 1194×834, 390×844 and 640×480, long names, profile details and cycles. Automated horizontal-overflow assertions and a scoped Axe scan (zero violations) ran. CSS 200% zoom is tested separately from actual browser zoom.

Physical-device media, other browser engines, actual browser zoom and assistive-technology manual testing remain unverified. The application has no authoritative employee assignments until its approved directory source populates the projection; no production reporting lines were fabricated.
