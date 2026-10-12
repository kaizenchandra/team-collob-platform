# Verification report — 0.1.12-local

Full specification is **not complete**. Phase 1 architecture gate passed. Foundation/core collaboration are partially implemented, with an independently useful local slice deployed. Phases 2–9 have **not** passed their full gates; local deployment is not equivalent to the required enterprise staging/production release.

## Executed checks

| Command / check | Actual outcome | Boundary |
|---|---|---|
| `node scripts/requirements.mjs` | 146 unique expected IDs; required fields/status validation passes | No requirement removed or mandatory scope deferred |
| `npm run typecheck` | Pass | Strict TS frontend/backend/tests |
| `npm run lint` | Pass | Narrow documented remote-state effect exception in UI; no blanket lint disable |
| `npm run build` | Pass | Next 16.4 / React 19.3 standalone build, host and Linux image |
| `npm test` | 46/46 pass | 39 core/security checks and 7 pending-storage unit checks; real PostgreSQL/event stream and JOSE validation |
| `TEST_LOCAL_OIDC=true TEST_SCANNING=true npm run test:e2e` | 27 pass, 2 explicitly skipped in3.4minutes | Chrome 155.0.8059.40, real local deployment; administrator-enabled provider fault injection not rerun for0.1.12 |
| Axe light/dark chat samples | Zero violations for selected WCAG A/AA tags | Not a complete WCAG2.2AA or screen-reader audit |
| Desktop/mobile screenshot & overflow | Pass at Playwright desktop and 390x844 | Full tablet/browser/device/workflow matrix not executed |
| Docker image build/deployment | Pass, web/API/Postgres/Keycloak/ClamAV/file-worker/file-reconciler health checks | Loopback local development only; image identities in release.json |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities at check | No OS-image security scan or independent security assessment |
| Full `npm audit` | 5 high findings in dev dependency chain | Unpatched `braces` stack-exhaustion advisory via Next ESLint plugin/fast-glob/micromatch; do not downgrade Next blindly |
| `node scripts/load-smoke.mjs` | 200 HTTP requests, concurrency 5, zero errors | Small development dataset, loopback, warm services; not target-scale sign-off |
| `bash scripts/restore-smoke.sh` | Message counts match; zero orphan messages; ~1s | Local unencrypted pg_dump to disposable database; no WAL/RPO/region or file-volume restoration proof |

Measured load smoke p95: message history reads **11.29ms**, message search **7.28ms**, preference writes **10.36ms**. Host: macOS ARM64, 11 logical CPUs, 18GiB RAM, Node 24.19.0. Docker app limits: 1 CPU/512MiB per service, Postgres 512MiB. Network is loopback; browser default desktop viewport and 390x844 mobile viewport. No upload/media/provider work included. Records: [load JSON](evidence/load-smoke.json), [restore output](evidence/restore-smoke.txt), [browser output](evidence/browser-tests.txt). UI captures: [desktop](evidence/workspace-desktop.png), [mobile](evidence/workspace-mobile.png), [dark](evidence/workspace-dark.png).

## Backend acceptance exercised

1. Anonymous session and cross-origin mutations rejected.
2. Cross-tenant bootstrap/history/search/tasks/forms/activity/audit/files denied; member audit denied.
3. Team guest cannot discover private channel.
4. Twelve concurrent retries with one client ID produce one SQL message and one outbox event; changed-payload reuse conflicts.
5. Message ownership, threads, reactions, monotonic read cursor and out-of-range rejection.
6. Message/search/draft persistence survives a fresh API instance using the same database.
7. Private task assignee permission, completion and form response/author access.
8. Conversion preview shows revoked guest; execution changes ACL atomically; same operation retry returns prior outcome and stale revision conflicts.
9. Meeting invitees must belong to tenant; only organizer can cancel; attendee RSVP persists.
10. Real guest file upload remains quarantined; download denied, cross-tenant access denied, uploader deletion allowed.
11. 32-person group read receipt aggregation, with privacy opt-out reducing visible recipients.
12. Real SSE replay; removing membership ends a connected subscriber at next poll (~1 second); Last-Event-ID resumes only newer events.
13. Invitation identity binding/expiry/single-use/revoke, privilege denial, last owner protection, membership revoke/restore.
14. Receipt privacy opt-out and revoked login session.
15. Fresh production processes reject development authentication/seeding and missing OIDC configuration.

## Browser acceptance exercised

- Alice and Bob in independent authenticated contexts exchange messages through the backend, react in real time, reload persisted history, recover server drafts.
- Private-channel board creation/status and form creation/response.
- Workspace switch clears previous workspace data; unavailable calling state is explicit.
- Light UI axe scan, desktop/mobile screenshots and no document horizontal overflow.
- Separate same-session windows synchronize a message; logout clears both windows.
- Guest uploads actual document bytes into quarantine and deletes own document.
- A deliberately lost HTTP acceptance response retries with the same client ID and leaves exactly one visible message.
- Browser network offline retains draft in the window and resynchronizes after explicit online reconnection; reload retrieves it.
- Dark preference saves/persists and sampled dark UI axe scan passes.
- Untrusted markup remains literal message text; no image or script execution.

Observed failures were corrected and rerun: test heading accessible-name mismatch; navigation/avatar contrast; missing explicit online/offline reconnection; unnecessary event hydration bursts (coalesced); history pagination refresh dropping older messages; tenant-bearing popout URLs and stale search-result guard. No mock media or provider result is counted as verification.

## Requirement-level result

Current register: **4 Verified, 80 In progress, 15 Blocked, 47 Not started, 0 Optional/deferred primary requirements**. No primary requirement is marked complete merely because a representative subflow works.

Verified local requirement IDs:

- **FE-FR-02**: authorized organization selection/label/state isolation; cross-tenant negative API tests and browser switch.
- **BE-FR-11**: message identifiers/order/retry deduplication; concurrent SQL-backed test.
- **WEB-01**: separate windows, synchronized message state, secure shared session and logout.
- **WEB-15**: authorized guest document add/delete; actual quarantined bytes, browser workflow and negative access checks. Broader file sharing, processing and coauthoring remain separately incomplete requirements.

The remaining entries are individually retained with acceptance criteria, owner, phase, dependencies, status, evidence scope and open work in [requirements.json](requirements.json). Implemented pieces do not verify whole requirements with unmet criteria. Notable partially implemented scope: identity, channel lifecycle, messaging actions, presence, notifications, file handling, tasks/forms, scheduling, migration, administration, resilience and non-functional controls.

## Release blockers and limitations

No configured external target, enterprise IdP/MFA test account, calendar consent, SMTP domain, editor, transcription or telephony account was supplied. Their live checks remain blocked; several provider adapters themselves also remain unwritten. Media, browser E2EE, durable text/file E2EE, recording/transcripts, advanced browser collaboration, large events/queues/PSTN are not implemented. Do not interpret unavailable-state UI as feature implementation.

Governance/retention/export/closure/jobs/reporting are incomplete. Audit SQL role is not tamper-resistant. Outbox pruning and general asynchronous jobs remain incomplete; file scans now have a durable worker, bounded retries and dead jobs. Message bodies are server-processable; only scanned-ready uploads can download; deleted file bytes are retained. No live media, Safari/Firefox/Edge, load-at-target, soak, failover, full backup encryption, HA, operational alerting, cost or observation-period verification. Frontend strings are not localized. CPU/memory/battery and LCP/INP/CLS field objectives remain unverified.

Full production release is not authorized by passing this limited local suite. The user authorized deployment within a configured environment; only the local loopback environment was available. No chargeable cloud resources were created and no production deployment was attempted.

The resized mobile screenshot initially showed a Chromium capture artifact. A fresh mobile page confirmed one application root, one topbar, and root/body/viewport all 844px high; the browser test now reloads after resizing before capturing. Mobile message controls were also made reachable rather than hidden. These checks do not replace real-device interaction testing.

## Identity increment — local provider only

`tests/browser/identity.spec.ts` uses real Keycloak26.7.3 and Chrome, explicitly gated by `TEST_LOCAL_OIDC=true`; ordinary runs skip these cases without claiming provider coverage. Synthetic Alice/Bob subjects are prebound; an unknown subject is denied despite valid provider credentials. Signed-token assurance rejection is checked after removing browser request hints; the provider response and token exchange are real. A fourth case restarts the task-owned API container between login initiation and callback to validate durable state across a real process restart.

Additional database tests verify state expiry, wrong-browser/config isolation, one successful consumer among eight concurrent attempts, explicit HTTPS/assurance production settings and independent session-status/logout rate budgets. Core suite now has18 checks. Initial integrated tests found rate-budget interference and a local IPv6 dev server competing with IPv4 Docker; the test browser now maps localhost to127.0.0.1, leaving the existing listener untouched. No successful MFA enrollment/challenge, recovery, IdP-driven session revocation, HA identity durability, or production identity deployment is claimed.

Final deployed URL is http://localhost:3101 (Docker), API4100, local IdP5180. Host development stays on3100. Final 14/14 browser run includes the four live identity checks and ten collaboration regressions; final core suite18/18. Evidence files contain actual execution output.

## Message recovery increment — 0.1.2-local

Final suite:22/22 backend/storage tests and18/18 Chrome tests. Four pending-storage unit cases exercise reloaded-reader ID/thread persistence, immutable payload conflict, user/org/channel isolation, identity cleanup, corrupt/failed storage and bounded capacity. The browser tests use the real message API and deliberately drop an accepted HTTP response, change conversation, reload, and retry once without a duplicate. A separate draft remains intact while retrying the original operation. Additional cases verify logout clears pending text, another identity cannot inherit it, storage denial sends no POST, a failed draft update does not undo acknowledgment, and Help clears malformed storage without signing out.

Frontend privacy/recovery scope is tab-local sessionStorage,32 pending conversations, server-processable plaintext. No browser-close durability, offline page shell, offline draft persistence or full draft-conflict resolution is claimed. Existing availability/load/restore observations above were not rerun or broadened by this UI increment. Current146-entry register retains4 Verified,79 In progress,15 Blocked and48 Not started.

## Provider logout increment — 0.1.3-local

25/25 core/storage and19/19 browser checks pass. Signature tests generate real RSA keys and signed JWTs; they reject wrong key/issuer/audience, expired/stale/future/missing claims, nonce-bearing/non-logout payloads, and map key-fetch dependency failure to503. These are cryptographic/domain tests, not live-provider claims. PostgreSQL checks cover issuer/client/sid isolation, five concurrent duplicate logout consumers, one audit effect, subject cutoff, late callback denial and fresh login after cutoff. API boundary checks exercise the narrow Origin exception, malformed/oversized bodies and unchanged protection for other mutations.

The fifth live identity browser case signs Alice and Bob in through real Keycloak, rejects an unsigned logout attempt, creates a pending local message, performs actual provider RP logout in another tab, then observes Alice's API401/login UI/local pending cleanup while Bob's API remains200. The provider itself signs and POSTs the logout JWT; no simulated token or callback establishes this live evidence. Full browser suite also verifies collaboration, persistence/retry/privacy, accessibility samples and real API restart during sign-in.

Migration evidence records118 old unbound sessions invalidated and0 remaining at the legacy cutoff. This is a one-time reauthentication requirement, not a content deletion. Temporary local provider administrator was removed after configuration. Runtime dependency audit after JOSE installation:0 vulnerabilities; earlier development-tool advisory remains open. Signed logout does not prove delivery during outages, provider key rotation, account-disable notification, positive MFA/recovery, fleet-wide latency or complete audit/governance. Four whole requirements remain Verified; all146 primary IDs retained.

## MFA increment — 0.1.4-local

Final results:26/26 core/storage checks and20/20 Chrome checks, including six real-provider tests. `mfa-browser-tests.txt` additionally records explicit fresh OTP enrollment after resetting only synthetic Bob's test credential; the reset ended provider sessions and did not remove application content. Positive sign-ins pass the API's exact signed ACR policy. Invalid authenticator input leaves the API unauthenticated. A separate password-only client supplies a real signed weaker token, which the stronger API replica rejects. Removing both browser assurance hints from the main client still requires OTP and succeeds only after verification. Existing restart, subject provisioning denial and provider logout cases continue to pass with MFA.

New database checks reject unknown/weak assurance, a different provider client, unbound sessions outside development and disabled users; the same session reader protects normal requests and SSE validity polling. Migration006 adds nullable assurance without removing content. No whole identity requirement is marked complete: recovery, enterprise deployment and lifecycle/reconciliation remain open.

Configuration was applied twice successfully after fixing nested-flow discovery for repeatability. A fresh disposable Keycloak26.7.3 instance with no external network imported the checked-in realm and started successfully (`identity-import-check.txt`), then was removed. This import check is startup evidence; browser MFA evidence comes from the persistent local realm. Temporary administrator removed after configuration.

Initial test failures exposed OTP reuse within30 seconds and a theme-specific error selector. Tests now wait for a fresh time step and assert the visible error; provider non-reuse protection was not weakened. Identity screenshots/traces are disabled. Test-only seeds remain in ignored mode0600 local state and are excluded from Docker context/evidence. Runtime audit reports0 vulnerabilities; the5 development-tool advisory findings remain unresolved. Strict type checking, lint, Linux production image builds,146-entry validation and all four container health checks pass. Current image IDs and source checksum are in `release.json`. Local deployment only; no external staging/production verification or full phase gate completion is claimed.

## Recovery-code increment — 0.1.5-local

27/27 backend/storage checks and21/21 Chrome browser checks pass against the local release. The new recovery scenario starts from Settings, performs real provider password/OTP reauthentication, confirms code storage, signs in with a recovery code under the unchanged required signed ACR, rejects an invalid code and a consumed code, accepts the next code, regenerates the set, cancels a further regeneration, rejects an unused code from the replaced set, then accepts a code from the current set. Thus cancellation preserves the confirmed set. Browser request inspection found none of the generated code strings in application-origin URLs or bodies. This is bounded observed browser evidence, not a universal proof of every plaintext boundary.

`recovery-lifecycle-tests.txt` records the initial passing lifecycle run; `browser-tests.txt` includes the final cancellation check and all regressions. `recovery-browser-initial-failure.txt` retains a test failure caused by omitting the username during provider reauthentication; the test was corrected and rerun. No provider response or token was mocked. Synthetic Bob's OTP was explicitly reset before the identity regression; actual enrollment and API401 before completing it were observed under the new fallback flow. The final broad run also preserves downgrade resistance and signed provider logout behavior.

Backend tests verify that only the configured provider recovery action is allowed, arbitrary actions/redirects and duplicate action arrays fail, and an unconfigured provider returns503. Settings shows loading/unconfigured/error/retry states. The staged flow installer passed twice; an isolated fresh realm imported and started (`recovery-import-check.txt`), then the disposable container was removed. The temporary provider administrator was removed. No SQL migration was needed for recovery.

Typecheck/lint/146-entry validation and Docker production builds pass. The first build caught an application-version replacement that unintentionally changed two transitive dependency references; original pins/constraints were restored before the successful build. No dependency upgrade was made in this increment. Runtime audit remains0 vulnerabilities; the previously recorded development-tool advisory remains unresolved. No password-email recovery, lost-all-factors/helpdesk recovery, enterprise identity deployment or full identity phase completion is claimed.


## Provider freshness and outage recovery — 0.1.6-local

ADR014 and migration007 are implemented. Server-only JWE refresh credentials are bound to the local session/issuer/client/subject. Production requires reconciliation and injected encryption keys. Checks use provider introspection/refresh, a60-second freshness window,20-second durable leases,5-second HTTP deadlines, bounded concurrency and retry cooldown. Inactive sessions are deleted and audited; dependency failures after freshness expires return503 without extending authorization. This encryption is not provider-blind E2EE.

`npm test`:31/31 pass, including vault tampering/binding/rotation, concurrent check coalescing, stale lease reclamation, terminal revocation, missing legacy credentials, outage fail-closed behavior and a late response after local deletion. `npm run typecheck`, `npm run lint`, production Docker builds and146-entry validation pass. Runtime dependency audit:0 vulnerabilities; prior development dependency advisory remains open.

The full browser command was `DEV_AUTH=true TEST_LOCAL_OIDC=true TEST_PROVIDER_ADMIN=true CONCORD_TEMP_ADMIN_PASSWORD=<temporary-local-secret> npm run test:e2e`:23/23 pass in5.6minutes, Chromium155.0.8059.40. With the actual provider callback deliberately unavailable, disabling Alice revoked access in60015ms and a separate provider logout revoked access in59989ms. Bob remained signed in. These are individual local observations, not a production revocation SLA. Test cleanup restored Alice and the callback before subsequent tests; the temporary administrator was removed afterward.

The real provider-outage check restarts the API, confirms encrypted credentials still refresh, stops Keycloak, expires the test session's freshness, and verifies session/profile operations return503. After provider startup, authorized access and Live state return with the draft intact. Artificially expiring freshness in this case tests the expired state directly; the disable/logout cases above wait naturally. An initial targeted run exposed EventSource remaining closed after an HTTP503 handshake. The client now explicitly reconnects with bounded exponential backoff/jitter and ignores stale callbacks. The affected test and full suite passed after the fix. Initial failure remains in `evidence/provider-reconciliation-tests.txt`; successful targeted retest is `evidence/provider-outage-tests.txt`; final regression is `evidence/browser-tests.txt`.

Local key-file metadata check: mode0600, ownerUID1000; no key contents were logged. Key rotation is unit-tested; fleet rotation, backup encryption/restore, provider compatibility and enterprise availability are not established. The supplemental cleanup query initially used the wrong synthetic username and failed; no state was changed by that query. Successful fault-test cleanup and later identity tests provide the account/callback evidence. Administrator deletion succeeded.

Final local smoke:200 requests at concurrency5, zero errors; p95 history11.29ms, search7.28ms, preference writes10.36ms. This uses development shortcut authentication and excludes provider reconciliation latency. All four containers report healthy; image identities/source checksum are recorded in `evidence/release.json`. No external staging/production deployment or full-scope gate is claimed.


## Scoped identity audit — 0.1.7-local

Implemented ADR015: `identity-audit.ts` projects verified identity events into current active memberships inside the session mutation transaction. Local and OIDC sign-in, local logout, signed provider logout and provider-inactive reconciliation are covered. Global authentication-failure records contain exactly route category, status and server-generated correlation UUID; actor/organization remain null. Untrusted names, tenant IDs, tokens, query strings and provider descriptions are excluded. Normal session polling and throttled429 attempts are not individually audited. Provider-screen errors that do not reach this API remain outside coverage. No new global audit endpoint exists.

`npm test`:35/35 pass (31 core/database/security and4 pending-storage checks), evidence `evidence/core-tests-0.1.7.txt`. New checks exercise failure privacy, forged request-ID rejection, current membership scoping, foreign/member denial, inactive membership exclusion and rollback. A real PostgreSQL test trigger rejects audit writes: sign-in returns generic503, issues no cookie and leaves session count unchanged. The trigger is removed in finally cleanup and only affects the isolated test database. An initial test used an already-logged-out fixture and was corrected; repeated execution also exposed process-local correlation-ID collisions, fixed with server-generated UUIDs.

`npm run typecheck`, `npm run lint`,146-entry validation, Docker production image builds and health-gated local deployment pass. `TEST_LOCAL_OIDC=true npm run test:e2e`:21passed,2skipped in2.9minutes. This verifies collaboration, real provider MFA, callback replay auditing, organization-scoped OIDC sign-in, restart/logout and recovery codes. Two administrator-enabled provider fault-injection scenarios were explicitly not rerun; their0.1.6 observations remain historical evidence, not new0.1.7 executions. New audit behavior for reconciliation is covered in the database suite. Focused Admin-screen verification is recorded separately in `evidence/audit-browser-0.1.7.txt`.

Runtime audit reports0 vulnerabilities (`runtime-audit-0.1.7.txt`); no dependency versions changed. No new load/capacity/DR claim; the displayed load figures remain the0.1.6 measurement. No schema or provider reconfiguration was needed, and no temporary administrator was created. Build/deploy logs: `build-0.1.7.txt`, `deploy-0.1.7.txt`; immutable image IDs and final health: `release.json`.

Remaining: provider event ingestion, failed-attempt aggregation, broader access/policy audit coverage, audit search/export/retention, least-privilege SQL roles and immutable archival. This release does not complete BE-FR-32 or BE-NFR-19, enterprise identity, or full phases2–9. External staging/production access remains unavailable.


## Formatted messaging — 0.1.8-local

ADR016/migration008 implement explicit `plain` and `markdown-v1` body formats. Existing rows and omitted-format requests remain plain. New composer formatting, preview, safe links, editing and format-preserving retry storage are integrated with the real API/SQL/event stream. The pinned react-markdown10.1.0 renderer renders HTML as text, replaces images with placeholders, and only activates absolute HTTP(S) links without credentials. No raw-HTML plugins or remote embeds are enabled. Source strings remain bounded to10,000characters; search/activity previews show source text.

`npm test`:37/37 pass (32 core/database/security,5 storage checks), including concurrent formatted-send deduplication, conflicting-format409, unknown-format400, legacy plain messages, PATCH format preservation/conversion and legacy pending records. `npm run typecheck`, `npm run lint`,146-entry register validation, production Docker builds and health-gated deployment pass. `npm audit --omit=dev --audit-level=high`:0 runtime vulnerabilities after adding79 renderer dependencies; the existing5high development advisory chain remains open.

`TEST_LOCAL_OIDC=true npm run test:e2e` initially produced22passes,1test failure and2explicit provider-admin skips in3.1minutes. The failure was an overbroad bold-element selector matching both author and message content. The affected scenario then exposed an edit-test locator targeting the background composer; it now scopes to the dialog and asserts the edited value before submission. No application change was needed for these locator corrections. `npx playwright test tests/browser/collaboration.spec.ts --grep 'formatted composition'` passes after both corrections; final targeted output and screenshot include the scrolled, visible formatted message. Across the initial run and targeted correction,23distinct browser cases passed. The full run was not falsely relabeled all-green; evidence retains its initial failure.

New browser assertions verify toolbar selection, shared preview/history rendering, independent Alice/Bob delivery, formatted edits, persistence after reload and literal legacy Markdown-looking text. Security assertions verify no executable/data/relative/protocol-relative/credential-bearing links, no injected HTML nodes, no remote image requests in preview or history, and safe link rel attributes. Composer axe sample has0violations for selected WCAG tags. Existing light/dark, desktop/mobile overflow, pending retry/offline and MFA/recovery flows pass. These remain Chrome/local laboratory checks, not full browser/device/accessibility or performance conformance.

Evidence: `core-tests-0.1.8.txt`, `browser-tests-0.1.8.txt` (initial run), `formatted-browser-0.1.8.txt` (passing correction), `formatted-messages.png` (visually reviewed), `build-0.1.8.txt`, `deploy-0.1.8.txt`, `runtime-audit-0.1.8.txt`, `release.json`. No new load/DR measurement; earlier metrics remain explicitly historical. No provider administrator or external resources created.

Structured mentions, message attachment entities, full delivery acknowledgments, advanced rich editing, and the wider mandatory backlog remain unfinished. No whole requirement newly marked Verified. Local0.1.8 is not enterprise staging/production or full-scope completion.


## Structured mentions — 0.1.9-local

ADR017/migration009 add recipient references derived from explicit CommonMark inline links. Plain text/code/images/reference-style links do not trigger mentions. Server validation limits20unique recipients and rejects malformed, foreign, inaccessible or disabled identities. Message, references and existing outbox event commit together; edits replace references and deletion clears them. Retries deduplicate before new recipient validation. History renders canonical directory names for validated references, including uppercase UUID source and forged labels. The channel picker uses the authorized channel-members endpoint and excludes disabled users.

`npm test`:39/39 pass (34 core/database/security,5 pending-storage), including parser boundaries/limits,6concurrent retries, one mention/outbox row, failed-send rollback, private/cross-tenant/disabled-recipient denial, canonical-name projection, mention activity after read, immediate server-side removal after access revocation, accepted retry after revocation, failed-edit rollback and removal/re-add/delete lifecycle. Strict typecheck/lint,146-ID validation, production image builds and health-gated deployment pass. Runtime audit0; existing development advisory remains open. Dependencies remark-parse11.0.0/unified11.0.5 were promoted from the existing locked graph to direct dependencies; no new transitive package set was introduced.

Targeted browser mention workflow passed after replacing an unread-count-sensitive navigation selector with the authorized channel deep link. The broad live-provider run then passed24tests with2explicit provider-admin fault-injection skips in3.7minutes. Review identified case normalization needed in the mention renderer; after fixing/rebuilding/redeploying, `npx playwright test tests/browser/collaboration.spec.ts` passed all17cases against the final image. The enhanced mention case changes the source to an uppercase recipient UUID and forged label, and verifies activity still displays `@Bob Chen`. Unaffected identity/recovery tests were not needlessly repeated after the renderer-only correction.

Actual two-browser checks cover private picker excluding the guest, selected-recipient draft persistence/reload, in-app mention arrival while Activity stays open, canonical display, and disappearance after the author removes the mention. Existing formatting/XSS/link/embed checks, draft recovery, separate windows, isolation and accessibility/responsive samples remain passing. Activity uses5-second polling while open, not guaranteed push latency; full browser/device/notification and production objectives remain unverified. The most recent50message records are returned; comprehensive pagination, new-mention timestamps, email/browser push, delivery jobs, quiet hours/preferences and notification lifecycle remain unfinished.

Evidence: `core-tests-0.1.9.txt`, `mention-browser-0.1.9.txt`, `browser-tests-0.1.9.txt`, `collaboration-final-0.1.9.txt`, `mention-activity.png` (visually reviewed), `build-0.1.9.txt`, `deploy-0.1.9.txt`, `runtime-audit-0.1.9.txt`, `release.json`. No new load/DR/availability evidence or external production deployment. Counts stay4whole Verified,79In progress,15Blocked,48Not started; all146identifiers retained.


## Durable file scanning — 0.1.10-local

ADR018 preceded production coding. Migration010 adds PostgreSQL scan jobs and backfills quarantine. A separate worker uses the core image, read-only bytes, bounded ClamAV INSTREAM requests, signature freshness checks, leases, five attempts with backoff/jitter, dead-job status and uploader requeue. File type/size/hash checks and current ACL gate downloads; completion atomically writes file state, audit and event. Deletion cancels jobs without resurrecting content from late scans. The Files screen polls status and offers ready downloads or eligible failed-job retry.

`npm test`:40/40 passed. New SQL-backed checks inject scanner outcomes to isolate concurrent claims, transient failure, exhausted attempts, unauthorized/authorized requeue, ready downloads, cross-tenant denial, checksum tampering, rejection, deletion during scanning and expired-lease recovery. Those injected outcomes are not provider verification. Typecheck/lint passed; API/web/custom scanner images built and deployed locally. Runtime dependency audit reported0 vulnerabilities.

`TEST_SCANNING=true npx playwright test tests/browser/file-scanning.spec.ts`:1/1 passed against actual ClamAV1.5.4, without a scanner double. It stops the actual worker, uploads a clean text file and observes quarantine/no download, starts the worker and downloads identical bytes with the expected filename. It uploads the harmless standard EICAR antivirus test string, observes rejected state/no download and verifies direct API409. The screenshot was visually inspected. This tests detection of that signature, not universal malware coverage. The signature freshness check passed against the loaded real database. Encrypted/limit-exceeded alerts are configured but not exhaustively exercised with a document corpus.

Boundaries: local macOS ARM64 Docker with AMD64 scanner emulation; Chrome only. No scanner throughput/capacity, target-load, file-volume restore, production authenticated scanner transport, object storage, E2EE, previews, versions or editor claim. Byte storage remains private local volume. Files are at most1MiB and tenant logical usage100MiB; retained deleted bytes and orphan reconciliation require lifecycle work. Worker heartbeat is liveness only. No remote CI or external staging/production deployment occurred.

Evidence: `core-tests-0.1.10.txt`, `scanning-browser-0.1.10.txt`, `browser-tests-0.1.10.txt`, `file-scanning.png`, `build-0.1.10.txt`, `deploy-0.1.10.txt`, `runtime-audit-0.1.10.txt`, `release.json`. BE-FR-35 advances from Not started to In progress; no whole requirement newly verified. Register:146 entries,4 Verified,80 In progress,15 Blocked,47 Not started.

Full combined browser regression:25 passed,2 provider-admin fault tests explicitly skipped in3.7minutes. Existing messaging, guest documents, local OIDC/MFA/logout and recovery-code flows passed alongside real scanner verification. All six deployed containers are healthy; release.json records immutable image IDs and the source checksum.


## Scanned message attachments — 0.1.11-local

ADR019 specifies ready same-channel references, immutable retry identity, current-state history and explicit composer behavior before coding. This increment deliberately uses the existing verified private-volume/scanner boundary; mandatory object storage, upload idempotency/reconciliation and lifecycle remain next work. Migration011 adds message attachment snapshots and normalized FK references. The composer paperclip now opens a real file picker; Send file includes the current draft or a fallback caption. History exposes current authorized download links or a generic unavailable label. Text edits preserve attachments; deleted messages hide them. Pending session records retain references across reload/retry.

`npm test`:42/42 passed (36 core/database/security checks,6 pending-storage checks). New cases exercise quarantine/rejected/missing/cross-channel/cross-tenant denial, duplicate/max-count validation, concurrent accepted retry deduplication, changed reference conflict, another member sharing an already-visible file, deleted-file retry acknowledgement, metadata suppression, text-edit preservation and message deletion. The reference tests set file states in the isolated test database; they do not establish scanner provider results. Pending-storage tests verify retained references, mutation denial and malformed UUID rejection. Typecheck/lint and production API/web image builds pass. Runtime dependency audit reports0 vulnerabilities; existing dev advisory remains open.

Targeted `TEST_SCANNING=true npx playwright test tests/browser/file-scanning.spec.ts`:2/2 passed. Actual scanner clean/EICAR/restart coverage is retained. The new independent-user test uploads through the real API and waits for actual ClamAV readiness, sends through the picker, deliberately loses an accepted response, reloads/retries and observes exactly one message. A second user downloads exact bytes with the right filename and sees the reference after reload. File deletion updates that user's live history to unavailable and direct download returns404. No test double is used for the scanner or messaging in this browser check.

Limits: one-file-at-a-time UI, no unsent attachment draft selection, no replacement/removal through text edit, no cross-channel forwarding, versions/previews, object storage, file content search, E2EE or production storage proof. Existing local1MiB/file bounds apply. No new browser/device matrix, load, DR or operational-objective claims. Whole requirement counts remain146 total:4 Verified,80 In progress,15 Blocked,47 Not started. Current source/evidence/checkpoint distinguish local deployment from blocked external staging/production.

Evidence: `core-tests-0.1.11.txt`, `attachments-browser-0.1.11.txt`, `browser-tests-0.1.11.txt`, `message-attachments.png`, `build-0.1.11.txt`, `deploy-0.1.11.txt`, `runtime-audit-0.1.11.txt`, `release.json`.

Full0.1.11 combined browser regression:26 passed,2 provider-admin fault checks explicitly skipped in3.5minutes. Screenshot framing was corrected to scroll the recipient message into view; the affected attachment test passed again (`attachment-capture-0.1.11.txt`) and the screenshot was visually reviewed. No application change followed the production build.


## Upload recovery and orphan reconciliation — 0.1.12-local

ADR020 precedes coding. Migration012 scopes upload clientId to channel/uploader, compares filename/canonical MIME/decoded size/SHA256 and returns the original current-state file on identical retries. Existing legacy clients can omit the ID and remain non-idempotent. Local writes fsync file/directory; failures retain possible orphan bytes instead of risking deletion after an ambiguous commit. Cleanup holds the exclusive counterpart of the upload shared storage lock, streams500-entry batches, and only removes hour-old regular UUID-named files with no metadata row. Referenced deleted/rejected/quarantined files remain protected. A separate maintenance container performs minute-spaced passes with counts-only logs.

Frontend session recovery stores opaque operation identity and file fingerprint scoped to user/channel, without raw filename or contents. Reselecting a matching file after reload reuses its upload ID. Confirmed acceptance removes metadata; sign-out/session-clear/Help clears it. Invalid/full/unavailable storage blocks sending. No automatic file-handle restoration, byte storage or upload-progress claim.

Core/storage tests46/46 passed (39 core/database/security,7 storage). Added real SQL concurrent retry/event/job deduplication, changed-content/name conflicts, cross-tenant denial, uploader identity scoping and deleted-file retry without resurrection. A real failing SQL trigger confirms failed metadata writes retain young orphan bytes; after the grace period the cleanup removes them. Tests exercise shared-lock exclusion, old orphan deletion, young/unknown/symlink/reference protection. Test files now use `.data/test-files`, separate from application roots. Typecheck/lint, production API/web builds, health-gated local deployment and runtime audit0 passed. No dependency versions changed.

Targeted browser suite3/3 passed against the real scanner/API. New case discards an accepted upload response, reloads, reselects the file, observes the identical clientId, one stored file and eventual ready state; pending metadata clears. Existing real clean/EICAR/restart and independent-user attachment download/retry/deletion checks remain passing. `TEST_RECONCILIATION=true node scripts/test-local-reconciliation.mjs` verifies the actual scheduled worker removes a task-created old orphan while preserving a young fixture (3916ms in this run); finally removes its fixtures. This is not an orphan corpus/large-directory capacity test.

Limits: private local filesystem only; no S3/object storage. Fsync calls and local restart tests do not prove power-loss/replicated durability, RPO or HA. Ambiguous COMMIT protection is implemented; the test injects an SQL metadata failure, not a network failure exactly during COMMIT. Cleanup protects all rows and therefore does not reclaim soft-deleted referenced bytes or enforce retention/legal holds. Local filesystem clock and exclusive application ownership are assumed. A very large pass can exceed the heartbeat budget; fairness/capacity and alerts remain unverified. Stop maintenance before downgrading to a pre-lock API. No production or whole requirement completion claim.

Evidence: `core-tests-0.1.12.txt`, `upload-browser-0.1.12.txt`, `browser-tests-0.1.12.txt`, `reconciliation-live-0.1.12.txt`, `build-0.1.12.txt`, `deploy-0.1.12.txt`, `runtime-audit-0.1.12.txt`, `release.json`. Register unchanged:146 entries,4 Verified,80 In progress,15 Blocked,47 Not started.

Full0.1.12 regression:27 browser cases passed,2 provider-admin fault cases explicitly skipped in3.4minutes. Existing collaboration, attachment, OIDC/MFA/logout and recovery-code workflows passed alongside new upload recovery. Local release now has seven services; final observed health and immutable IDs are in release.json.
