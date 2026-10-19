# Concord — enterprise collaboration implementation

Next.js App Router / React / strict TypeScript frontend, a Node.js TypeScript modular API, PostgreSQL transactions and persistent event replay. **Limited local development release; the full 146-requirement specification is not complete.**

## Access the running local release

- Web (Docker release): **http://localhost:3101**
- API readiness: http://localhost:4100/ready
- Alice: `alice@acme.test` / `Development123!`
- Bob: `bob@acme.test` / `Development123!` (use a separate browser profile/private window for independent messaging)
- Eve: `eve@northstar.test` (other organization); Sam: `guest@partner.test` (guest). Same development password.

These synthetic accounts are forbidden in production mode. Local deployment uses loopback bindings and development identity. It is not externally deployed or production ready.

## Start from source

Requirements: Node 24 LTS, npm, Docker Compose, Chrome for browser tests.

```sh
npm ci
docker compose up -d postgres
npm run db:seed
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.scanning.yaml -f compose.storage.yaml -f compose.email.yaml up -d --build --wait
```

For source development, run only Postgres in Docker, then `DEV_AUTH=true npm run api` and `npm run dev` in two terminals. For an optimized host build use `npm run build` then `npm run start`. Read [operations](docs/OPERATIONS.md) before changing deployment or data.

For real local provider sign-in, add the [SSO overlay](docs/OPERATIONS.md#local-sso-overlay-011) and run the explicit subject-provisioning command. The running local release is `0.1.84-local`. Activity now offers Older/Newer pages of 50 matching messages, with retry and Refresh activity returning to newest. Activity supports exact message viewing and explicit load/error recovery while preserving the selected filter and current draft. Browser mention/reply alerts open the exact current message source in a separate tab. The profile indicator now shows verified presence with a text label and shares live state with Settings. Presence settings shows the active override expiry and lets you return to automatic presence early. Settings now includes expiring workspace presence overrides and a server-refreshed current status. Timeline replies offer View replied-to message to open the current authorized parent source, even beyond loaded history. Exact reply sources offer View replied-to message for current authorized parent content without leaving your draft. Select All, Unread, Pinned or Muted conversations and combine it with name filtering; Clear conversation filters restores the list. Filters reset on reload/workspace/account changes. Conversation lists show literal last-message previews; Refresh conversations retries failed snapshots without changing drafts or read positions. New messages support Markdown formatting, safe links and a preview; existing messages remain plain text. Structured mentions use channel-authorized recipients and appear in the recipient’s Mentions activity filter. Use the composer paperclip to send a scanned conversation file with your current message; recipients download through current permissions.

## Working scope

- Development sign-in, organization selection, resource authorization and independent tenant memberships; live local Keycloak OIDC/PKCE sign-in, durable single-use callbacks and signed-token assurance checks; password+OTP MFA, one-time recovery codes, signed provider logout and bounded provider-session reconciliation verified locally; tenant-scoped identity events and minimized authentication-failure auditing implemented; enterprise configuration, forgotten-password/lost-all-factors recovery and deployment validation remain unfinished.
- Teams and standard/private/shared channels; direct/group chats; channel access previews and transactional conversion/move APIs.
- Durable messages, replies, reactions, edits/deletion, saved flags, explicit read positions and per-recipient receipts; persistent server drafts, tab-scoped pending-send recovery across reload/navigation, typing, expiring presence, authorized search/activity, real event replay and popout windows.
- Private task boards and forms with responses/comments, local meeting scheduling/RSVP/cancellation, profiles/themes/privacy preferences, feedback.
- Manual single-use invitations, membership role/revocation controls, basic audit view.
- Private local uploads with real ClamAV scanning, durable scan jobs and authorized clean-file downloads, retry-safe uploads and conservative orphan cleanup. Clean files are now promoted to a real local S3-compatible store when the storage overlay is enabled. Previews, editor integration and versioning remain unfinished.
- Automated API/browser checks, Docker images and local deployment, CI definition, bounded latency and database restore smoke exercises.

The UI explains unavailable services. **No real media, E2EE, PSTN, collaborative editor, external calendar or email integration is currently implemented.** Enterprise governance, advanced browser features, production monitoring/HA/backups/TLS and large-scale verification remain incomplete. A production build passing is not full product acceptance.

## Verification

```sh
docker compose exec -T postgres createdb -U concord concord_test # first test run only
npm run requirements
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm run build
```

Core integration tests use a separate test database. Browser tests use the running local deployment, create labeled test records, and include independent sessions. Reports are in `playwright-report`; screenshots in `test-results`. Full development dependency audit has an unresolved upstream braces advisory; production dependency audit is clean at the recorded check.

## Documentation and continuity

- [Architecture, runtime selection, diagrams, threat model and decisions](docs/ARCHITECTURE.md)
- [Machine-readable 146-entry requirements register](docs/requirements.json)
- [Readable traceability matrix](docs/TRACEABILITY.md)
- [Verification report](docs/VERIFICATION.md)
- [Operations, provider setup, backup and rollback](docs/OPERATIONS.md)
- [Durable progress checkpoint and next executable steps](docs/PROGRESS.md)

All mandatory requirements remain in scope. No mandatory feature has been silently deferred, and partial implementation does not count as verification of a whole requirement.

To enable the verified local scanner, add `-f compose.scanning.yaml` to the combined Compose command (see [scanner operations](docs/OPERATIONS.md#local-file-scanning-0110)). Without a worker, uploads remain quarantined.

If an upload response is lost, reselect the same file in the same tab after reload to retry without duplication. Only recovery identifiers/fingerprints are stored locally; the browser must ask you to select the bytes again.

For the current object-backed release, include both scanner and storage overlays:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.scanning.yaml -f compose.storage.yaml up -d --build --wait
docker exec concord-collaboration-file-worker-1 node services/core/migrate-object-storage.ts
```

See [object-storage operations](docs/OPERATIONS.md#object-storage-0113) before omitting an overlay or rolling back. Existing object-backed files require the storage service even though local recovery copies remain. SSO provisioning remains as documented above; this command does not provision new enterprise identities.

Encrypted core backup and isolated restore are available on the current0.1.13 application images:

```sh
ALLOW_LOCAL_BACKUP=true npm run backup:local
ALLOW_LOCAL_BACKUP=true npm run restore:local -- .data/backups/core-REPORTED-ID.jwe
```

Keep the separately generated recovery key safe. These tools cover the core database and referenced local/S3 files, not Keycloak or external provider recovery. See the [backup runbook](docs/OPERATIONS.md#coordinated-encrypted-core-backups-operational-increment-on0113) for limits and verification.

Local release0.1.14 adds scan-gated TXT/MD/CSV source previews: open a channel's Files tab, upload a supported file, wait for ready, then select Preview. Text is shown literally and bounded to32,768 UTF-16 units; complete files remain downloadable. PDF/image previews, versions and collaborative editing are explicitly unavailable. The preview rechecks access while open and clears on failure. This remains a partial local product, not a full enterprise release.

Release0.1.15 adds immutable file revisions. In Files, choose Versions beside an original. Its uploader can select a new file with the same name/format; it receives a separate scan before download. Other authorized members can download ready versions. Old attachment links keep their original bytes. Deleting the original withdraws every version. History is limited to100 accepted versions; collaborative editing remains unavailable.

Release0.1.16 adds opt-in desktop mention alerts and server-enforced daily quiet hours. In Settings, allow browser notifications, enable alerts, set quiet times and save notification settings. The schedule uses your saved profile timezone. Only the currently open workspace is polled; alerts show workspace/channel names without message text. Activity remains the fallback. Closed-tab/mobile push and email digests are not implemented.

Release0.1.17 adds opt-in hourly missed-activity digests, including authorized private-channel counts. Start with the additional `-f compose.email.yaml` overlay; the capture-only inbox is http://localhost:5185. The UI exposes preferences, quiet hours and recent job statuses. Local SMTP is verified; external email delivery remains unconfigured. See the local SMTP runbook for the complete six-overlay startup command, conservative retry semantics and required production setup.

Release0.1.18 makes file-worker health reflect scanner availability and signature freshness as well as its heartbeat. Messaging/API readiness stays independent during scanner outages. Local outage/recovery and all five affected live file browser checks passed. See the scanner-readiness runbook in `docs/OPERATIONS.md`; no new startup overlay or migration is required.

Release0.1.19 adds **Activity → Replies to me** for other people's replies to your messages. Replies remain visible after being read and disappear from this filter if the parent/reply is deleted or access is revoked. Use Open conversation to follow up. Browser reply alerts and subscriptions to all replies in a thread remain unavailable.

Release0.1.20 adds a separate **Enable browser reply alerts** checkbox in Settings. Browser permission and this explicit opt-in are both required; the existing mention toggle remains independent. Alerts show workspace/channel names without reply text. Quiet hours and current access checks apply. Keep the workspace open; closed-tab/mobile push and thread-wide subscriptions remain unavailable.

Release0.1.21 adds **Settings → Workspace invitations**. Signed-in recipients can review organization, role and expiry, then accept without copying a token. Invitations must match their stored account email; existing or inactive memberships require administrator help. Manual token acceptance remains available. Invitation emails and new-account provisioning remain unavailable.

Release0.1.22 adds a **Review workspace invitations** notice wherever you are in the app. It opens a dedicated invitation view. You can decline an invitation without joining; administrators can issue a new one later. Counts refresh across tabs within a polling interval and are labeled across workspaces.

Release0.1.23 adds **Calendar → Edit meeting** for organizers. Update title, description and times; a time change resets attendee responses to pending. Use Refresh calendar to see changes. Concurrent stale edits are rejected with recovery instructions. Recurrence, external calendar synchronization and real meeting media remain unavailable.

Release0.1.24 adds attendee checkboxes to **Calendar → Edit meeting**. Organizers can add/remove active workspace members. Removing someone withdraws calendar access; adding them back starts a pending RSVP. Retained responses stay unchanged unless the time changes. External calendar invitations remain unavailable.

Release0.1.25 removes the calendar's silent100-meeting cutoff. Use **Load more meetings** and optional inclusive **Calendar from/through** dates. Failed page loads offer Retry without discarding already loaded cards. Refresh restarts browsing; date ranges are limited to366days.

Release0.1.26 automatically refreshes an open Calendar when relevant meetings or responses change. Updates return browsing to the first page and preserve open edit drafts. If change detection becomes unavailable, stale cards clear and reload on recovery. Hidden-tab/browser throttling can delay updates; external calendar sync remains unavailable.

Release0.1.27 adds **Scheduling timezone** to meeting creation/editing. Nonexistent daylight-saving times are rejected. Repeated times require an explicit earlier/later choice, preventing silent clock-change adjustments. Calendar cards still display in your browser timezone and identify the saved scheduling zone.

Release0.1.28 adds bounded **Daily / Weekly** meeting series in the scheduling dialog. Choose interval and occurrence count. Meetings keep local clock time across daylight saving; invalid occurrences reject the entire series. Each occurrence has independent RSVP/editing, and organizers can **Cancel series**. Monthly/yearly recurrence and series-wide editing remain unavailable.

Release0.1.29 adds **Edit scope → All noncancelled occurrences** in recurring-meeting editors. Update the entire active series' title, description and attendees with conflict protection. Cancelled occurrences stay unchanged. Times and recurrence rules still require individual occurrence edits; whole-series rescheduling remains unavailable.

Release0.1.30 adds **Reschedule series**. Adjust the first-occurrence anchor, timezone, daily/weekly frequency and interval across active occurrences. Stable IDs, cancelled entries, titles and attendees are preserved. Changed occurrence times reset RSVPs; count remains fixed.

Release0.1.31 adds **Monthly / Yearly** recurrence and an explicit missing-date policy. Reject invalid month dates or use the last valid day; January31 schedules return to March31 after February, and leap-day schedules return to February29 in leap years. Monthly/yearly series are bounded to5calendar years.

Recovery tooling now writes encrypted backup envelope5 with calendar, reminder and moderation/policy table digests. The isolated restore exercise verifies schedules, exceptions, attendee permissions, reminder settings/dismissal and due APIs. Run `ALLOW_LOCAL_BACKUP=true node scripts/test-calendar-recovery.mjs`. Application images remain0.1.38; versions1–4 remain readable with their original verification scope. See `docs/OPERATIONS.md` for key handling and recovery limits.

Release0.1.32 adds **Total series occurrences** to Reschedule series. Increase it to append meetings while preserving existing IDs and cancellations. New meetings copy the last active occurrence's title/attendees and start with pending attendee RSVPs. Counts cannot decrease; cancel unwanted occurrences.

Release0.1.33 adds **Upcoming noncancelled occurrences** in Edit scope and **Only upcoming occurrences** in Reschedule series. Server time determines eligibility. Past and in-progress meetings stay unchanged; selected future occurrences cannot be moved into the past.


Local release0.1.34 adds **Cancel upcoming occurrences** alongside whole-series cancellation. Upcoming means the meeting has not started according to the server clock; historical and ongoing meetings retain their content, responses and schedule. This is a partial local collaboration release; external calendar synchronization, media and production gates remain open.


Local release0.1.35 adds **Preview occurrences** to recurring meeting creation and series rescheduling. Review dates in the scheduling timezone before saving; missing month dates and DST errors appear in the preview. Changing schedule inputs hides stale results. Rescheduling previews canonical candidates, while the server preserves applicable exceptions and checks current access on save.


Local release0.1.36 adds opt-in **In-app reminder** on each calendar meeting (5/15/30/60minutes). Reminders appear in the workspace while the app is open, respect quiet hours and can be dismissed across windows. Settings/dismissals persist in PostgreSQL. A changed start time re-arms a dismissed reminder; new series occurrences defaultoff. Background push/email reminders remain outside this increment.


Local release **0.1.37** adds channel posting restrictions. Organization owners/admins with channel access can open **Conversation details → Posting permissions** and restrict posts, replies and edits to those roles. Members keep reading and editing saved drafts. Policy changes are audited and propagate to connected participants; the backend enforces them even for direct API requests. Direct/group chats are excluded.


Local release **0.1.38** adds **Report message** for team-channel messages, a persistent receipt, and **Admin → Message reports** for authorized reviewers. Admins must have current channel access. They can dismiss a report or remove the message with an audited decision; reporters see status without private reviewer notes. Deleted messages offer **View report status**. Direct/group reports and immutable evidence retention are not implemented in this increment.


Moderation recovery: run `ALLOW_LOCAL_BACKUP=true node scripts/test-moderation-recovery.mjs` to verify restored posting policies, private-channel access, report receipts and decision retries. `ALLOW_LOCAL_BACKUP=true node scripts/test-calendar-recovery.mjs` verifies calendar/reminder APIs with the same envelope5 tools. These exercises use disposable local restore resources and synthetic source organizations; they do not establish production recovery objectives.


Local release **0.1.39** adds **Admin → Audit history** search by exact action, actor id, target and a bounded time range. Results paginate, retry failed pages, and clear when the workspace changes. Event metadata renders as text. Current owner/admin authorization applies to every request; immutable archival and retention controls remain unfinished.


Local release **0.1.40** adds **Admin → Audit history → Download audit JSON** for current workspace owners/admins. Apply any edited filters first. The download includes all matching events, limited to1,000 events/2MiB; larger selections must be narrowed. Generation is limited to five exports per actor/workspace per rolling minute. The browser verifies tenant scope, format and SHA256 before handing the file to its download manager. This is an audit-only export; full user/workspace exports remain unfinished.


Local release **0.1.41** adds **Admin → Usage report** for current workspace owners/admins. Select 1–31 UTC days to inspect retained message activity and planned meeting duration, plus current logical file-version bytes and conversations. Only resources the caller can access are counted. Refresh manually; actual attendance, service quality and costs remain unavailable.


Local release **0.1.42** adds current direct/group participants in **Conversation details**, plus group renaming and **Leave group** with confirmation. Refresh participants after a rename conflict. Leaving removes access and the personal draft while preserving existing messages for other participants. Rejoining and administrative participant management remain unfinished.


Local release **0.1.43** adds **Conversation details → Manage group access** for workspace owners/admins who already belong to the group. Choose a workspace member and explicitly confirm access to all retained messages/files before adding. Removal requires confirmation, revokes live access and clears that member’s personal draft/preferences while preserving shared messages. Re-admission requires another explicit history grant. Selective history access and broader lifecycle controls remain unfinished.


Local release **0.1.44** adds **Conversation details → Channel settings** for current workspace owners/admins with access to standard/private/shared channels. Edit name/description or archive/restore, then save. Conflicting edits require refresh. Archiving retains history/drafts and blocks new messages; restoring lets members send their preserved draft. Restore an archived parent team first. All details API edits now require current revision.


Local release **0.1.45** adds **Teams → Manage team ownership** for joined teams. A current team owner can select an eligible existing member and confirm transfer. The former owner remains a member and can then leave; the last active owner must transfer first. Inactive/disabled co-owners do not bypass that guard. Team ownership changes no workspace role or channel access. Refresh ownership after conflicts or uncertain responses.


Local release **0.1.46** adds **Conversation details → Channel access** for owners/admins who already have private/shared channel access. Explicitly grant retained history to a workspace member, or confirm removal to revoke access and clear that member’s personal draft/preferences. Standard channels keep team-inherited access. Granted channels outside joined teams appear under **Other channels** after refresh/reload; opening them does not join the team. Re-admission requires fresh history consent.


Local release **0.1.47** adds **Teams → Manage team members** for workspace owners/admins already in the team. Explicitly grant retained standard-channel history when admitting a member or guest. Confirmed removal revokes standard access and private-channel grants and clears drafts/preferences there, while preserving shared grants/content. Owners must transfer first; use Leave team for yourself. Re-admission does not restore private grants. Ordinary members can still self-join open teams; guests need explicit admission.


Local release **0.1.48** adds guarded **Teams → Manage team ownership → Recover team ownership** when no active owner remains. Only a workspace owner already in the team can confirm an eligible existing successor. Inactive former owners become ordinary members, so later account reactivation does not restore ownership. Workspace roles/channel grants stay unchanged. Teams with an active owner must use normal transfer; this does not recover or re-enable user accounts.

Local release **0.1.49** adds **Files → Your deleted files** for uploader recovery. Refresh the list, select a file/version and confirm renewed visibility to current conversation members. Each recovery requires a fresh malware scan; originals and versions are restored separately. Current access, archive state, storage quota and stale deletion cycles are checked. Retention schedules, permanent purge, legal holds and message recovery remain unfinished.

Local release **0.1.50** adds **Conversation details → Message and file preservation** for workspace owners with current team-channel access. Review and confirm a reason to apply a hold, or confirm release. Active holds block message edits/removal (including moderation removal) and file deletion; new posts, uploads and scanned file recovery remain available. Current owner notes stay outside participant history. This limited preservation control does not implement full legal-hold cases, retention schedules, permanent purge or recovery of deleted message text.

Local release **0.1.51** extends encrypted backups to version 6 with explicit preservation, file lifecycle and scan-job digests. The isolated restore exercise verifies that holds still block destructive actions, private owner notes stay protected, deleted versions return to quarantine on recovery, and authorized release restores existing mutation rules. Versions 1–5 retain their previous validation scope. This is bounded local recovery evidence; production backup scheduling, offsite retention and regional recovery targets remain open.

Local release **0.1.52** adds **Conversation details → Message retention** for workspace owners with current team-channel access. Save a manual age policy, preview up to 100 expired messages and explicitly confirm text clearing. Changed previews, lost authority and preservation holds block application. Saving never deletes messages, and each remaining batch requires another preview. Text clearing cannot be undone in the application; files, reference records and backup copies remain. Automatic scheduling and storage purge are still unfinished.

Local release **0.1.53** extends encrypted backups to version 7 with explicit retention-policy and reference-record digests. An independent restore verifies applied message tombstones, retained attachments and permissions, active/disabled/default policies, hold protection and duplicate-approval rejection. New artifacts also receive local tags for their exact API/Postgres/object image IDs. Domain behavior and UI are unchanged. Older formats keep their recorded verification scope; an older archive still requires its exact recorded application image.

Local release **0.1.54** adds version 8 portable image companions: each encrypted data backup is paired with an encrypted bundle of its exact API, PostgreSQL and object-store images. Restore authenticates the bundle before importing missing images. A disposable missing-image drill verifies exact image recovery, snapshot data and permissions without removing primary service images. Keep both artifact files and the separate key; this does not provide offsite distribution or a complete ten-service deployment backup.

Local release **0.1.55** adds an authenticated recovery tooling kit with restore helpers, development S3 configuration and bundled Node dependencies. It restores from outside the checkout without npm installation; retain the encrypted data/image pair and key separately. See [kit commands and trust boundary](docs/OPERATIONS.md#portable-recovery-tooling--release-0155).

Local release **0.1.56** transfers restore configuration and verifier helpers through Docker into stopped containers, removing host bind-path dependencies. The authenticated kit passes a drill that rejects all bind mounts, with cleanup verified after both injected transfer failures. Real remote-engine and clean-engine recovery remain unverified.

Local release **0.1.57** adds owner-reviewed file retention in conversation details. Set a manual age policy, preview complete version families and explicitly confirm each batch of up to100active files. Preservation holds block execution. Soft deletion stops downloads while retaining bytes and attachment references; uploaders can recover under existing rules and a fresh scan. No scheduler or permanent purge is added.

Local release **0.1.58** adds older/newer pages to deleted-file recovery. Uploaders can reach originals beyond the newest100entries, recover them, then return to recover their versions. Each page remains bounded and checks current access; recovery still requires a fresh scan.

Local release **0.1.59** adds version9 backup verification for file-retention policies and post-execution lifecycle state. Independent restore checks retained file bytes/references, policy and hold behavior, and uploader recovery returning files to quarantine until a fresh scan. Earlier backup formats retain their original verification scope.

Local release **0.1.60** captures a fourth recovery image containing the scanner and its current virus definitions. Version10 restore verifies the definitions, runs real clean/EICAR checks, and verifies recovered original/version files through fresh scans and authorized downloads. Captured definitions still expire under the existing7-day freshness rule.

Local release **0.1.61** adds explicit scanner refresh for version10/11 backups. It creates a new encrypted pair, preserves the original data and three data image IDs, embeds authenticated origin evidence, and verifies a complete isolated restore before publication. Use `ALLOW_LOCAL_BACKUP=true npm run backup:refresh-scanner -- BACKUP [KEY]`; see [operations](docs/OPERATIONS.md#scanner-only-backup-refresh--release-0161). The existing7-day signature gate remains in force.

Local release **0.1.62** adds `ALLOW_LOCAL_BACKUP=true npm run backup:verify -- BACKUP [KEY]`. It authenticates the stored backup pair without Docker or plaintext staging. This preflight does not replace a full restore or test scanner freshness; see [operations](docs/OPERATIONS.md#backup-pair-preflight--release-0162). Cached-image restores now also avoid writing a plaintext image tar.

Local release **0.1.63** lets you browse conversation files beyond the newest100. Use Older/Newer files or Refresh files; scan status continues updating on the current page. Uploading returns to the newest page. Versions, previews, downloads and deleted-file recovery keep their existing access and scanning rules.

Local release **0.1.64** adds filename search. Submit workspace search, choose **Files**, and optionally filter by conversation. Ready results offer authorized downloads; **Open files** opens the source conversation’s Files tab. Search results refresh under current access rules. Message search remains available; file contents and other entity types are not searched.

Local release **0.1.65** lets you browse message and filename search beyond50matches. Use **Older matches**, **Newer matches** or **Refresh matches**; the selected filters stay in effect and permissions are rechecked on each page.

Local release **0.1.66** opens the exact message selected in search, including older matches. Copied message links open the same read-only view after sign-in. Current permissions, edits, deletion and attachment availability are rechecked; opening the conversation preserves your draft.

Local release **0.1.67** adds **View file** to filename search. It opens the exact original, including files older than the newest Files page, without leaving your search or draft. Current metadata/access and scan status refresh automatically; ready files download through the existing protected route.

Local release **0.1.68** adds **Copy file link** to the selected-file view. Authorized recipients open that exact original after sign-in, including on reload; the view continues to check current access and file availability.

Local release **0.1.69** adds **Preview selected file** to search and copied-file source views for ready TXT, Markdown, and CSV originals. Previews show literal source text through the existing protected, bounded preview route.

Local release **0.1.70** adds **View versions** to file views opened from search or copied links. Download separately scanned revisions and, as the original uploader, add a new version while the original source stays unchanged.

Local release **0.1.71** adds **Saved** navigation for your saved messages in the current workspace. Browse older pages, open the exact message without leaving your draft, or unsave it. Entries follow current access and deletion status and are ordered by message creation time.

Local release **0.1.72** adds **Save message / Unsave message** inside exact-message views from search, Saved, and copied links. The action updates your personal collection without changing the conversation or draft.

Local release **0.1.73** adds **Mark unread from here** to exact-message views. It moves your read position back to the selected message while retaining your draft; Mark as read explicitly advances it again. Existing read receipts reflect the same position.

Local release **0.1.74** adds personal **Hide conversation** and **Hidden conversations** controls. Open a hidden conversation without unhiding it, or show it in your list again. Hiding preserves access, messages, drafts, pinning, and mute settings.
