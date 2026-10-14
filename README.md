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

For real local provider sign-in, add the [SSO overlay](docs/OPERATIONS.md#local-sso-overlay-011) and run the explicit subject-provisioning command. The running local release is `0.1.13-local`. New messages support Markdown formatting, safe links and a preview; existing messages remain plain text. Structured mentions use channel-authorized recipients and appear in the recipient’s Mentions activity filter. Use the composer paperclip to send a scanned conversation file with your current message; recipients download through current permissions.

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
