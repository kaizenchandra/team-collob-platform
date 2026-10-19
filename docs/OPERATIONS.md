# Operations and release runbook

This is a **limited local development release**, not a complete enterprise release. The production gate is closed. API and frontend images were built and exercised locally; provider, HA, encryption, real-media and operating-period gates remain open. Do not expose development authentication or seeded passwords externally.

## Startup

Node 24, npm, Docker Compose. From repository root:

```sh
npm ci
docker compose up -d postgres
npm run db:seed
npm run build
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

Open http://localhost:3101. API http://localhost:4100/ready. Postgres is loopback-only at 55432. Docker applies migrations on API startup, protected by PostgreSQL advisory lock and stored checksum. The seed command is explicitly non-production and idempotent only for an empty user table. Existing user records are not overwritten. Never run `docker compose down -v` against data you need.

Alternative host development: keep only the PostgreSQL container; `DEV_AUTH=true npm run api` and `npm run dev` in separate terminals. The optimized host startup is `npm run build && npm run start`. Do not run host and container servers on the same ports.

Development accounts all use `Development123!`: Alice (`alice@acme.test`) is Acme owner and Northstar member; Bob (`bob@acme.test`) is Acme member; Eve (`eve@northstar.test`) is Northstar owner; Sam (`guest@partner.test`) is an Acme guest. These are synthetic `.test` identities. API startup refuses DEV_AUTH in NODE_ENV=production. Development seed also refuses production.

## Verification

```sh
docker compose exec -T postgres createdb -U concord concord_test # first run only
npm run requirements
npm run typecheck
npm run lint
npm test
npm run test:e2e
npm audit --omit=dev --audit-level=high
node scripts/load-smoke.mjs
bash scripts/restore-smoke.sh
```

Integration tests use `concord_test`, override via TEST_DATABASE_URL. Browser tests run against the local deployment and create labeled test records. Browser prerequisite: installed Google Chrome, or `npx playwright install --with-deps chrome` on supported CI. Suites use real PostgreSQL and two independent browser sessions; no provider test doubles establish live provider completion. CI is supplied but has not run on a remote CI service.

## Health and supervision

`docker compose -f compose.yaml -f compose.local.yaml ps` reports health for all three containers. `/health` is process liveness, `/ready` checks SQL. Containers have restart policy, memory/CPU limits, non-root app users, init, and shutdown grace period. API allows 10 event connections/user/instance and closes slow sockets; current drain may force termination at 10 seconds. Connection state survives through persisted events, not memory.

Structured logs include request ID/status/duration and omit request query strings, credentials and message bodies. Health checks are active. Prometheus dashboards, distributed traces, paging alerts and multi-instance drains are **not configured**; no operational monitoring completeness claim. Outbox is currently a durable replay log; file scanning has its own durable worker/retry/dead-job handling; general background jobs and retention of the outbox log are unfinished.

## Backup/restore

`bash scripts/restore-smoke.sh` takes a local pg_dump, restores to a new disposable database, compares message counts and checks FK orphan count, then removes only that new restore database. The dump is mode 0600 under ignored `.data/backups`. It is unencrypted and **not** a production backup strategy. Quarantined files are in the `files-data` volume and require separate snapshot/restore. Earlier host uploads, if any, remain under `.data/files`; transferring to containers requires copying them into the volume with uid/gid 1000 ownership and checksum verification before allowing access.

Production prerequisites: encrypted managed backups, restricted recovery identity, WAL archival <=5-minute lag, standby and off-region policy, object versioning/snapshot coordination, tested secret recovery. Define residency and hold/retention obligations first. Demonstrate RTO <=60min and RPO <=5min with recorded failure conditions. Single-primary local commit is not HA durability. No monthly availability or region recovery claim is made.

## Release and rollback

Release label `0.1.13-local`, image digests and actual verification recorded in `evidence/release.json`. Tags are convenience references; promote by immutable image digest. Build context excludes secrets, .git, local data and browser output. Do not rebuild an old tag and assume it identifies identical code.

For a local rollback, retain previous image IDs with `docker image tag <image-id> concord-web:rollback` and equivalent API; update an override to those immutable images and `compose up -d --no-build`. Migrations are forward-only and checksum-verified. Migrations001–013 are forward-only; assess the specific schema compatibility before rollback. An app rollback is valid only while its database contract is compatible. Do not delete migration records or apply a destructive down migration. Use a forward-fix for incompatible schemas; restore an isolated verified backup before traffic cutover if necessary, then reconcile outbox/idempotency records.

## Enterprise provider setup (blocked)

- Identity: configure HTTPS OIDC_ISSUER, CLIENT_ID, CLIENT_SECRET and exact callback `/v1/auth/callback`; provider authorization code/PKCE, nonce and state validation are implemented with openid-client. Provision users.oidc_subject as `<issuer>|<sub>` and grant organization membership explicitly. Email does not automatically confer membership. Require MFA/recovery in the IdP. Test issuer/audience, MFA assurance, logout/revocation and failover before enabling production; shared pending-login storage is implemented; signed provider logout is locally verified; local MFA/recovery-code/reconciliation checks pass; enterprise rollout and complete account recovery remain unfinished.
- Email: SMTP credential, verified sending domain and privacy/quiet-hours policies. Digest worker and delivery adapter are not implemented; no emails are sent.
- Calendar: choose authorized Graph/Google/CalDAV provider, consent scope and webhook validation. Only local scheduling exists; recurrence/availability/provider synchronization are unfinished.
- Files: configure encrypted S3-compatible storage and least-privilege service credentials; implement isolated previews/versioning. The local ClamAV overlay, durable scan queue and clean-file downloads are verified; production storage/scanner deployment remains unfinished.
- Documents: select Collabora/OnlyOffice or approved editor with appropriate licensing; implement scoped session and permission revocation. No coauthoring currently exists.
- Media/artifacts: supply LiveKit SFU/TURN endpoint/keys and network routing; implement application grants/consent and browser integration. Independent participants must exchange real media. Captions/transcription require an approved model/provider and language policy. No media/recording/transcription currently exists.
- E2EE: integrate and review maintained protocol/device key lifecycle before enabling. Never substitute server-generated shared keys for provider-blind encryption. Current content is server-processable.
- PSTN: provider trunk/account, numbers, region, budget, consent and real call tests. No provider calls or chargeable resources were created.
- Deployment: external target, DNS/TLS, secrets manager, production database/object storage, network, monitoring and operational owner absent. Full production deployment remains blocked by both missing access and missing mandatory implementation.

## Incident priorities

Suspend tenant membership or sessions to contain an access incident. Do not log message text, cookies, invitation tokens or provider secrets while investigating. For database outage, reads/writes fail closed; drafts remain in the current browser window and retry safely. For provider outage, mandatory provider screens must state unavailable rather than report success. Security remediation policy target: critical within 24 hours, high within 7 days; documented current development-tool advisory remains open with no patched braces release in the queried registry.

## Local SSO overlay (0.1.1)

This uses a real Keycloak provider, with synthetic accounts and persistent local identity data. It does not enable production MFA or recovery email; provider-driven session revocation is covered by the0.1.3 setup below. The two provisioned accounts are Alice/Bob with the development password listed in README. The additional `unprovisioned@acme.test` account is deliberately denied application access.

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml up -d --build
DEV_AUTH=true node --import tsx scripts/provision-local-identity.ts
node scripts/wait-ready.mjs http://localhost:5180/realms/concord-local/.well-known/openid-configuration
TEST_LOCAL_OIDC=true npx playwright test tests/browser/identity.spec.ts
```

Use **Enterprise sign-in** at localhost:3101. The provision command binds known synthetic UUID subjects; it does not link users by incoming email or grant new membership. Keycloak imports the realm only if absent; editing its JSON does not update an existing volume. Do not delete identity data to apply a configuration change; use an approved provider administration/migration procedure. No management administrator or SMTP service is configured by this overlay.

The API uses `OIDC_INTERNAL_ORIGIN=http://keycloak:8080` only in explicitly enabled `OIDC_LOCAL_HTTP=true` mode to route container traffic. It retains the public `http://localhost:5180/realms/concord-local` issuer and browser URLs. Both bypass settings are rejected in production. All ports are loopback-only. Keep the identity overlay in subsequent Compose commands while using this provider. It adds a health check and waits for Keycloak readiness before starting the API.

Production must set `OIDC_REQUIRED_ACR` to the exact verified provider MFA assurance value, not an arbitrary number or example string. The API requests it as an essential claim and rejects lower/missing values in the signed ID token. Local tests now verify both MFA enrollment/challenge and rejection of insufficient assurance after browser hints are removed (see0.1.4 below). Application logout deletes the local session; an existing provider SSO session can sign in again. Signed back-channel logout is now locally verified. Local IdP disable/missed-event reconciliation is verified in0.1.6; forgotten-password/lost-all-factors recovery remains unfinished; authentication audit is partial/global.

Migration003 adds only `oidc_transactions`; older images can ignore this table. Roll back application images without dropping it; no down migration or data reset is required. In-flight callbacks spanning a policy/config change may be rejected and must restart. TLS, encrypted database storage/backups, secret injection and production provider validation remain release gates.

The Docker frontend is published on loopback3101 to avoid the pre-existing IPv6 Next development server on3100. Host `npm run dev`/`npm run start` still use3100. Both origins are explicitly allowed by the local API; provider sign-in returns to3101. No unrelated listener was stopped.

## Pending-send recovery (0.1.2)

An ambiguous send displays **Retry safely** with the original text; retries reuse its original identifier even after navigation/reload. Resolve it before sending a different message in that conversation. You may edit a separate draft while the original operation is pending. **Discard retry** only removes the local recovery record; it cannot retract a server-accepted message. Help provides **Clear all local pending sends** for malformed storage or intentional cleanup. Both actions preserve server messages.

Local recovery data is unencrypted, bounded to32 records and scoped to the tab/current identity/workspace/channel. Sign-out removes it in open windows via the existing broadcast. Browser closure/storage deletion can lose it; this release does not supply an offline page shell or offline draft persistence across reload. A denied browser-storage write blocks sending rather than transmitting an operation that cannot be recovered. No schema change is needed for this increment; rollback to0.1.1 can ignore the new storage key, but older UI cannot recover its operations. Resolve pending sends before UI rollback.

## Provider-driven session revocation (0.1.3)

Register `https://YOUR_API/v1/auth/backchannel-logout` with the production IdP. This release accepts signed RS256 tokens (no encrypted/JWE logout), validates issuer/client audience, issued-at within5minutes, expiry, logout event and identifier, and rejects nonce-bearing tokens. Unknown form extensions are ignored; duplicate logout_token parameters and bodies larger than16KiB are rejected. Browser cookies are not authentication for this endpoint. JWKS dependency failures return503; bad tokens400; successful and repeated events200. Provider requests have a separate600/minute per-instance/IP budget and receive Retry-After on429. Validate your provider's delivery/retry behavior and key rotation before production.

A valid event deletes only matching issuer/client/provider-session bindings, with subject matching where supplied. Subject-only events apply an issued-at cutoff. Persisted24h tombstones prevent a delayed callback restoring a logged-out session; receipts suppress duplicate audit/effects. Active SSE polls session validity every second, then emits `session-ended`; UI state and local pending text are cleared, including open same-origin windows. This is an observed local test, not a fleet-wide revocation SLA. Since0.1.6, independent reconciliation requires a provider check no older than60seconds even if events cannot reach the API (see below). Disabling a provider account is not assumed to send a logout event.

Migration004 adds provider bindings, receipts and tombstones;005 requires pre-binding legacy sessions to reauthenticate and records the count in the global audit table. Content, drafts and memberships are retained. Drain older API instances when upgrading; they cannot create these bindings. Authentication success and provider logout audit rows are global/operations-scoped, not exposed by the tenant audit-search UI. Audit immutability and complete authentication-failure auditing remain unfinished.

For a new local realm, the imported client already includes `http://api:4100/v1/auth/backchannel-logout`. For an existing local volume, use the dedicated temporary-admin flow below; no realm reset/import overwrite is necessary. Set `CONCORD_TEMP_ADMIN_PASSWORD` in your shell to a temporary local password (not a production secret), then:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml stop keycloak
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml run --rm --no-deps -e CONCORD_TEMP_ADMIN_PASSWORD keycloak bootstrap-admin user --username concord-local-admin --password:env CONCORD_TEMP_ADMIN_PASSWORD --no-prompt
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml up -d keycloak
node scripts/wait-ready.mjs http://localhost:5180/realms/concord-local/.well-known/openid-configuration
DEV_AUTH=true node scripts/configure-local-logout.mjs
DEV_AUTH=true node scripts/configure-local-logout.mjs --remove-admin
unset CONCORD_TEMP_ADMIN_PASSWORD
TEST_LOCAL_OIDC=true npm run test:e2e
```

The temporary administrator used in this delivery was removed. Tests require no administrator: they perform actual provider RP logout in a separate browser tab and observe its back-channel delivery. The configuration script only targets this project's loopback development realm and refuses production mode.

Rollback to an older API loses provider-revocation enforcement. Prefer a forward fix; if rollback is unavoidable, disable SSO, drain connections and invalidate sessions before rollback, then keep identity unavailable until verified protection is restored. Do not drop provider tables or assume the security behavior is backward compatible.

## Provider-managed MFA (0.1.4)

The local application client now requires password and OTP with signed ACR `urn:concord:mfa`. Keycloak's LoA1 password and LoA2 OTP conditions run in order; both have max-age0, so a new application sign-in requires fresh authentication. The provider minimum ACR and independent API signed-claim check prevent browser hint removal from weakening authentication. Never replace these with a constant claim mapper. `concord-assurance-test` is a synthetic, loopback-only client for negative tests; no deployed API uses it.

New identity volumes import this configuration. Existing volumes require the temporary-admin procedure above; run `DEV_AUTH=true node scripts/configure-local-mfa.mjs` before removing that admin, then rebuild/recreate API and web with all three Compose files. The script retains users, asserts exact authenticator order/configuration, and is repeatable. Migration006 adds `oidc_sessions.acr`. API requests and SSE polls check the configured issuer/client/assurance; old unknown-assurance provider sessions must sign in again. Development shortcuts remain local-only. Do not roll back to a version that omits this policy; drain traffic and prefer a forward fix. No column removal or data reset is needed.

For human enrollment, choose Enterprise sign-in, enter the synthetic password, scan the provider QR code into an authenticator, and submit its current code. Do not use these accounts outside development. Automated identity tests enroll only the three fixed synthetic users and store their OTP seeds in ignored `.data/local-test-otp.json` with mode0600. Do not publish that file, browser error artifacts, or test reports that contain enrollment screens. Identity screenshots/traces are disabled. OTPAuth is only a test dependency; application code never generates or receives OTP seeds. Tests wait for a new30-second token when needed and do not allow token reuse.

If automated enrollment already owns an account, use the development shortcut for ordinary app inspection, or explicitly reset its test credential and enroll your authenticator. With the temporary local administrator active:

```sh
DEV_AUTH=true node scripts/reset-local-test-otp.mjs bob@acme.test
# Next human or automated provider sign-in must enroll a new authenticator.
# This resets only a fixed synthetic account and ends its provider sessions.
DEV_AUTH=true node scripts/configure-local-logout.mjs --remove-admin
unset CONCORD_TEMP_ADMIN_PASSWORD
```

This maintenance tool is not end-user recovery. Recovery codes and provider reconciliation are locally verified in0.1.5–0.1.6; recovery email and verified enterprise rollout remain unfinished. Losing a real second factor must not be addressed by lowering ACR or bypassing authentication.

## Second-factor recovery codes (0.1.5)

Go to **Settings → Sign-in recovery → Manage recovery codes**. With a verified Keycloak deployment (`OIDC_PROVIDER=keycloak`), this starts a fresh PKCE sign-in and provider-owned code enrollment. Authenticate with your password and existing OTP (or an existing recovery code), save the displayed codes privately, and confirm on the provider screen. The workspace never displays, persists or generates codes. The provider requires codes in their displayed sequence. On a later sign-in choose **Try Another Way → Recovery Authentication Code** and use the requested unused code with your password. Reused codes fail. Replacing a set invalidates its unused codes; cancelling replacement preserves the existing set. Returning to the app does not itself assert successful enrollment.

The realm now uses the staged `concord-recovery-v1` flow. LoA1 still requires password. LoA2 conditionally runs configured OTP/recovery alternatives, followed by mandatory OTP enrollment when neither factor is configured. Both levels retain max-age0. The previous flow remains in an upgraded realm for diagnosis; only the new binding is active. New volumes import the new flow. Existing volumes use the temporary-admin procedure and `DEV_AUTH=true node scripts/configure-local-mfa.mjs`, then remove that admin. The installer builds/validates nested flows before binding, supports repeat execution, and retains users/content. Recovery codes are supported by pinned Keycloak26.7.3; no preview-feature flag is enabled.

Recovery actions are allowlisted server-side; arbitrary `kc_action`/redirect parameters are rejected. Non-Keycloak/unconfigured deployments show an unavailable explanation. The API's issuer/client/signed-ACR checks continue to apply. No new SQL migration or weaker assurance value is introduced. To disable this entry point, unset `OIDC_PROVIDER` and recreate the API; do not weaken ACR. A provider flow rollback can make recovery codes unusable: prefer a forward fix and retain the MFA policy.

Automated recovery tests use only synthetic Alice, replace her recovery set, keep codes only in the test process, and discard them afterward. Do not use this account for real personal access. Traces/screenshots are disabled for identity tests; error context may still contain provider page data, so never publish raw browser artifacts. Fresh import was checked in an isolated disposable provider, then that container and the temporary admin were removed.

This feature addresses a lost authenticator when the user retains their password and a pre-enrolled recovery code. Forgotten-password email recovery, loss of every factor/code, verified helpdesk identity recovery and enterprise rollout remain incomplete. Account-disable propagation and missed-event reconciliation are locally verified in0.1.6. SMTP/provider setup and operational authorization are still required for those workflows; never reset a real user's factor using the synthetic development reset tool.

## Provider-session reconciliation (0.1.6)

Enable `OIDC_RECONCILE=true` with `OIDC_TOKEN_KEY_FILE` pointing to a server-only keyring. Production requires both and never generates a key. The ring format is `{"active":"v1","keys":{"v1":"BASE64URL_32_RANDOM_BYTES"}}`; replace the placeholder using a cryptographically secure secret generator or secret manager. Between1and4key IDs are allowed. Mount read-only with narrowly restricted access; do not put keys in source, frontend configuration, SQL backups, logs or browser storage. Apply deployment-specific secret-manager and backup controls before production.

The explicit local identity overlay creates a random mode0600 keyring at `/app/.data/identity-token-keys.json` in the existing API data volume, only in local HTTP + development-auth mode. Keep that volume across API restarts. Do not display or copy its contents into evidence. Losing it makes retained credentials unreadable and requires application reauthentication. The key is not a public development password. Production operators must supply their own ring and verify its backup/restoration independently of the database.

Migration007 adds encrypted provider credentials, freshness and check leases to the provider-session table. Existing bindings without credentials require sign-in again; no token can be reconstructed from an old session. Application sessions keep an8-hour absolute limit. Active requests and SSE polls revalidate after at most60seconds: RFC7662 refresh-token introspection, subject/client checks, then a refresh grant. Only the replacement refresh token is encrypted and retained. Provider access/ID tokens are discarded; no offline scope is requested. New local realm configuration enables refresh-token revocation with zero reuse; apply the existing local provider installer to upgrade a persisted realm.

The provider-check lease lasts20seconds; each provider HTTP operation has a5-second deadline. Same-process callers share checks, at most32checks run per instance, and durable leases coordinate instances without holding SQL connections during network calls. Failed checks retry no sooner than a bounded2–5second jittered cooldown. Stale/expired leases can be reclaimed. A late response cannot recreate a deleted session or overwrite a newer lease. A crash or lost response after provider refresh rotation can make the previous credential unusable; require reauthentication rather than replaying an uncertain refresh indefinitely. This is not exactly-once processing.

Inactive introspection or terminal `invalid_grant` removes the local session and writes a global `identity.session_reconciled` audit event. Disabled-user and missed-logout behavior must be verified with each provider. Once freshness expires, timeouts, provider errors, unavailable keys or concurrent checks yield retryable503 and do not authorize writes. SSE closes/retries without declaring logout or discarding drafts on503; confirmed session end yields401 and the existing session-ended cleanup. During the existing60-second freshness window a session can still be accepted after a provider-side change. This bound is a local policy, not a measured enterprise SLA. Local development shortcut sessions are intentionally independent; production prohibits them.

Rotate keys by deploying an active new ID alongside the prior IDs to every instance, recreating instances to load the ring, and allowing successful checks to rewrap credentials. Retain old keys until no unexpired bindings use them (or explicitly revoke remaining sessions); never delete an old key solely because the new one was deployed. Keep keys for any authorized backup restoration policy, or explicitly accept that restored sessions must reauthenticate. Database restoration must not resurrect provider-ended access without fresh reconciliation; expire all restored freshness timestamps before serving traffic. Prefer forward fixes. Rolling back to a pre-reconciliation API removes the enforcement and is not a safe security rollback; drain traffic and invalidate provider sessions if an emergency rollback is required.

Fault-injection tests require the temporary local admin procedure, `DEV_AUTH=true`, `TEST_LOCAL_OIDC=true`, `TEST_PROVIDER_ADMIN=true` and `CONCORD_TEMP_ADMIN_PASSWORD`. Run `npx playwright test tests/browser/provider-reconciliation.spec.ts`. They only target fixed synthetic users/loopback endpoints, deliberately make the client's callback undeliverable, disable/re-enable Alice, stop/start this project's Keycloak and restart its API. Their `finally` cleanup restores account/client settings and provider availability. Do not run against a shared enterprise environment. Remove the temporary administrator after the test. Application runtime has no provider-admin credential or service-account role.

## Identity audit scope (0.1.7)

No schema migration or provider reconfiguration is required. Deploy API/web0.1.7 images together; earlier migrations001–007 remain unchanged. Successful identity events share a transaction with session mutations and project only to active organization memberships. Unknown/unverified failures are global with no claimed identity attribution. The existing administrator audit view displays scoped events; database/operator access is required for global records. Do not expose a global audit query to tenant administrators. Never copy provider tokens or recovery secrets into diagnostic evidence.

Failure-audit storage errors return503; success-event storage failures roll back their session transaction with a generic5xx; investigate database health/permissions using the generated correlation UUID. Logs emit only a bounded failure message. Rate-limited attempts are not individually persisted, and comprehensive rate-limit metrics/provider event ingestion remain open scope. This is an append-only application convention, not tamper-proof storage: the current application database role and database administrators can alter rows. Configure least-privilege writer/reader roles, immutable archival and retention/holds before an enterprise audit-integrity claim.

A rollback to0.1.6 does not require a schema downgrade but stops new tenant/failure audit coverage; preserve existing audit rows. Forward fixes are preferred. Earlier token-reconciliation key and rollback requirements still apply.

## Formatted message rollout (0.1.8)

Migration008 adds `messages.format` with a default/plain constraint; it does not rewrite message bodies. Take the standard authorized backup, run additive migrations before new API traffic, and deploy API before the new web bundle. The normal server startup applies checksum-verified migrations. Existing clients omit format and remain plain; new clients validate known format values. Keep008 when rolling back application images; do not drop the column or rewrite source. An older frontend shows Markdown source literally, and an older API does not preserve the new format contract on mutation: freeze formatted writes and prefer a forward fix over mixed-version rollback. No down migration is supplied.

The dependency lockfile pins react-markdown10.1.0 and its dependency graph. Do not add raw HTML/MDX/embed plugins or relax URL handling without a new security review and browser tests. Inline image syntax intentionally does not fetch content; file scanning/sharing remains separate. No provider configuration or secrets are added.

## Structured mentions (0.1.9)

Migration009 adds normalized mention references and a recipient index; no existing bodies are rewritten or backfilled. Deploy migrations/API before the web bundle. Older clients may show the typed label without highlighting; current clients resolve authoritative names from history. Editing an existing mention whose recipient has lost access requires removing that mention before resubmission. Activity reads remain authorized at request time, including after channel conversion or membership revocation; cached/downloaded text is not retroactively erasable.

No provider/secret configuration is needed. Mentions are stored transactionally with messages and their existing outbox event. Activity polling is bounded to one in-flight request per open view every5seconds. Email, quiet hours, push preferences and a complete notification worker are not provided by this increment. Keep migration009 on an application rollback; older APIs do not maintain references on edit, so freeze message mutations and prefer a forward fix until a compatible API is restored. Do not drop/reference-rebuild data automatically or claim old binaries maintain mention consistency.


## Local file scanning (0.1.10)

The combined local release runs with:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.scanning.yaml up -d --build --wait
TEST_SCANNING=true npx playwright test tests/browser/file-scanning.spec.ts
TEST_LOCAL_OIDC=true TEST_SCANNING=true npm run test:e2e
```

Retain the identity overlay for an existing provider-enabled installation. Fresh identity installation also needs the subject-provisioning and MFA setup above. Scanner-only development can omit the identity overlay. Never omit overlays when intentionally recreating services whose configuration depends on them.

ClamAV1.5.4 uses a pinned official AMD64 base because that release lacks an ARM64 manifest; local ARM runs through emulation. Budget4GiB/2CPU for signatures and scanning, plus256MiB/0.5CPU for the worker. Initial signature download needs outbound network and may take minutes. The scanner has no host port; its unauthenticated TCP3310 is confined to the local Compose network. This is not a production authenticated transport boundary. `clamav-signatures` persists updates; signatures older than7days or with an unverifiable date cause fail-closed retries. The custom config rejects encrypted content and exceeded scan limits, bounding recursion/files/time. No comprehensive malware-detection guarantee is implied.

API startup and the worker both run checksum-protected migration010. It adds one job per quarantined file, including existing records. Upload and job metadata commit together; bytes reside on `files-data`. The worker mounts bytes read-only and uses `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`, `DATABASE_URL` and `FILE_ROOT`. No browser credentials or scanner secrets are needed. For host development these worker settings must be supplied separately; do not expose ClamD publicly to make host access convenient.

Jobs expose queued/running/done/dead/cancelled status through authorized file listings. A claim has a60-second lease; two sequential scanner commands each allow20seconds. Failed attempts back off exponentially with jitter, at most five attempts; exhausted jobs remain quarantined. The uploader can select Retry scan to reset the attempt budget. Lease expiry recovers an interrupted claim; a stale completion cannot resurrect deleted files. Logs intentionally omit file contents and raw scanner responses. Inspect worker/container health and job status before retrying; old unsupported file formats remain quarantined. Worker health is a recent-loop heartbeat, not a guarantee that the database or scanner is available; alerting is still unfinished.

Use the same four Compose files with `ps` or `logs file-worker clamav` for diagnosis. SIGTERM drains the current scan, with60seconds shutdown grace. For rollback, stop the worker first and retain migration010/job records; use compatible immutable API/web images or a forward-fix. Never edit applied migration checksums. Database and private-file snapshots must be coordinated for recovery; signature caches can be refreshed independently. File-volume restoration is not yet tested. Deleted bytes are retained and excluded from the current logical quota: physical reclamation, storage lifecycle and full storage-abuse protection remain open. Object storage, signed sharing links, versions, previews, coauthoring, message attachment references and E2EE are not implemented by this increment.


## Message attachment rollout (0.1.11)

The combined four-file Compose startup above deploys API/web/worker0.1.11 while retaining the unchanged scanner0.1.10 image. Migration011 is additive: empty retry snapshots for existing messages, plus FK attachment references for new sends. Production builds and migration checksum checks apply as before. Upgrade the API before serving new frontend attachment sends. An old client can still send text-only payloads; an old server would ignore unknown attachmentIds, so downgrading the API while new clients are active is unsafe. Drain/replace clients with a compatible UI or forward-fix; do not remove applied migration records or assume an additive schema alone makes behavior rollback-safe.

Run `TEST_SCANNING=true npx playwright test tests/browser/file-scanning.spec.ts` for the real scanner plus independent-user attachment/lost-response/deletion flows. The test creates labeled files/messages, uses real local authentication/scanning/downloads, deliberately discards one accepted HTTP response, and deletes its file. Test data may retain message history and soft-deleted bytes under current lifecycle limitations. No new provider setup or secrets. Text edits retain attachments; file deletion makes history links unavailable; message deletion hides links without removing files. Object storage and file lifecycle work remain open.


## Upload recovery and maintenance (0.1.12)

The existing four-file Compose command now deploys `file-reconciler` alongside API/web/file-worker0.1.12 and the unchanged scanner0.1.10. It shares core data ownership, has database/file-root configuration, a writable private volume,128MiB/0.25CPU limits, no public port, heartbeat health and60second shutdown grace. Every minute it streams a cleanup pass with bounded500-entry batches; log events contain examined/removed/skipped counts only. Heartbeat is liveness, not complete operational alerting. A large directory may take longer than the heartbeat budget; target-scale operation remains unverified.

Only files with no metadata row, UUID names, regular-file type and age over one hour are candidates. All referenced bytes, including soft-deleted files, are protected. A database error fails closed. Uploads hold the shared storage advisory lock; cleanup uses a nonblocking exclusive counterpart. Failed uploads deliberately retain orphan bytes until this grace period passes. Grace applies to mtime and assumes a task-owned trusted filesystem clock. Do not mount unrelated directories as FILE_ROOT. No administrator API can trigger arbitrary-path deletion.

Migration012 adds nullable client_id plus a scoped partial unique index; legacy rows are untouched. Deploy the API before the new UI. Stop the reconciler when rolling back to an API that does not hold the storage lock, even though old orphan ages are usually young; mixed-version cleanup safety is not promised. Preserve migrations and old immutable image identities; prefer a forward-fix if retry semantics are needed by active clients. A downgrade can ignore clientId and duplicate retried uploads. Physical retention/hold policy and object-storage rollout remain open; cleanup does not reclaim referenced soft-deleted data.

`npm test` now sets FILE_ROOT to `.data/test-files` (override only with TEST_FILE_ROOT) as well as the isolated concord_test database. Never point test reconciliation at application storage. The old host `.data/files` and container `files-data` remain untouched by tests. `TEST_SCANNING=true npx playwright test tests/browser/file-scanning.spec.ts` includes lost HTTP acceptance, reload and explicit file reselection with the original upload ID. Browser tests use real local application storage and delete only their own labeled files through normal APIs.


## Object storage (0.1.13)

Use the five Compose files shown in README. `object-store` is pinned SeaweedFS4.48 with a persistent `object-data` volume and1GiB/1CPU limits. No provider port is published. Only API and file-worker join the internal objects network; the provider does not join the default network. `infra/seaweedfs/local-s3.json` contains synthetic development-only bucket-scoped reader/writer credentials. API uses the reader, worker the writer; live tests verify anonymous read and reader-write denial. Internal filer/master interfaces are trusted-runtime surfaces, not production authentication boundaries. Admin UI is disabled. Never expose this topology or reuse these credentials externally.

All S3 configuration stays server-side. Endpoint/bucket/key/secret must be supplied together. HTTP requires explicit S3_ALLOW_INSECURE_LOCAL=true and non-production mode. Production forbids the synthetic local-* credentials and requires HTTPS; encrypted storage, IAM/secret-manager rotation and network policies are still target prerequisites. Generic errors omit raw provider responses. API readiness remains database-based so messaging survives object outages; separate object-provider health and file-job status must be monitored. The local provider health checks master liveness, not authenticated bucket round-trip; application integration tests provide that separate evidence.

Uploads stage locally and enqueue scanning. On clean scan, the worker writes and checksum-verifies S3 bytes, then atomically marks ready/s3. Failure stays quarantined with existing bounded retries/dead-job recovery. Worker lease and storage-overlay shutdown grace are120seconds to cover scan and two bounded15second object operations. This is not a distributed exactly-once guarantee. API/worker still need the persistent local spool; independent stateless upload replicas are not supported by this increment.

Migration of existing ready local files:

```sh
docker exec concord-collaboration-file-worker-1 node services/core/migrate-object-storage.ts
TEST_OBJECT_STORAGE=true node scripts/test-local-object-storage.mjs
TEST_LOCAL_OIDC=true TEST_SCANNING=true npm run test:e2e
```

Migration emits promoted/skipped/failed counts and nonzero exit for failures; rerun after resolving storage/integrity problems. It preserves IDs, ACL, metadata and local bytes; only verified pointers switch. The live test uses its own labeled fixture, tests permissions/corruption/provider stop-start/no-fallback/messaging availability and repeated promotion, then soft-deletes it. It intentionally interrupts the local provider, so run only in this development environment. An initial rollout command found0 existing ready/local rows; repeatability is established by the actual scanned fixture test, not by that empty command.

Do not rollback to an API/worker that does not understand s3 rows, or remove the storage overlay after promotion. Old binaries would read local copies and defeat the authoritative-pointer boundary. Retain a compatible image or forward-fix. Data recovery must restore PostgreSQL, object-data and local quarantine spool consistently; the coordinated local core/file restore exercise below is verified, while enterprise identity and offsite recovery remain incomplete. Object restart persistence and a task-owned corruption/repair test are not DR acceptance. Production encryption, replication/RPO, versioning/retention and monitoring remain open. Local copies and unreferenced objects are deliberately retained until a separate retention/intent-aware reclamation design is implemented; the existing orphan reconciler only handles unreferenced local UUID files.


## Coordinated encrypted core backups (operational increment on0.1.13)

The earlier restore-smoke.sh verifies only an unencrypted database dump. Prefer these new local tools for the current core database + authoritative file set:

```sh
ALLOW_LOCAL_BACKUP=true npm run backup:local
ALLOW_LOCAL_BACKUP=true npm run restore:local -- .data/backups/core-REPORTED-ID.jwe
ALLOW_LOCAL_BACKUP=true npm run test:recovery
```

The commands are deliberately restricted to the existing loopback development installation. Backup checks the task API container's development mode, reads the source PostgreSQL service at127.0.0.1:55432, exports a REPEATABLE READ snapshot, uses that snapshot for pg_dump and file metadata, and exports bytes through the existing checksum-verifying storage dispatcher. Concurrent normal writes can continue because referenced local/object bytes remain immutable and physically retained. **Do not add physical garbage collection without coordinating snapshot readers.** Missing or corrupt referenced data fails the entire backup rather than producing a partial success.

Artifact: `.data/backups/core-UUID.jwe`, authenticated JWE dir/A256GCM using pinned jose. Recovery key: `.data/backup-keys/local-core.key`, random32bytes, separate from artifact, mode0600. Directories are created mode0700; key permissions are checked. Do not print/commit the key or package it with the artifact. Losing it loses recovery access. Copy keys to a separately controlled recovery system before treating this as a dependable operational backup; that process is not implemented here. Older plaintext smoke dumps remain unchanged and need their own retention decision. No plaintext database/file backup is persisted on host disk by the new exporter; data exists in bounded memory and child-process pipes.

Limits:10000 file rows,32MiB aggregate file bytes,64MiB JSON envelope, bounded command buffers and3minute child deadlines. Larger datasets fail explicitly; production needs streaming encryption/managed backups rather than increasing limits without review. Version1 historical envelope includes source immutable image IDs, database archive/checksum, snapshot time, selected relational counts and all file pointers/verified bytes, including soft-deleted entries. Provider accounts/keyrings, Keycloak's identity-data, object orphans and nonauthoritative retained copies are not backed up. Full enterprise identity recovery therefore remains incomplete.

Restore authenticates and validates before creating resources. It creates a randomly named `concord-restore-*` internal Docker network, fresh PostgreSQL/object services and file volumes without publishing ports; loads the archive; writes local bytes and S3 objects; verifies every pointer/size/hash/count; and tests restored development sign-in plus available authorized/cross-tenant downloads. It never overwrites the live database or volumes. Finally removes only its own named verifier, service containers, volumes and network. Reported cleanup failures name remaining exercise resources and return nonzero; inspect that report before manual cleanup. Use the exact reported names, never broad Docker prune commands.

`test:recovery` uploads its own scan-verified fixture, makes a backup, deletes the source fixture after the snapshot, restores it independently, and checks tampered ciphertext rejection. `ALLOW_LOCAL_BACKUP=true node scripts/test-restore-failure.mjs ARTIFACT` checks rejection/cleanup after an authenticated manifest/database count mismatch. Measured2.9seconds restore is a warmed local exercise from already available images, excluding decryption/cleanup; it is not RTO/RPO acceptance. No automatic schedule, offsite copy, rotation/retention policy, legal hold or region recovery is configured.

A discovered legacy file was missing from the container volume. `recover-legacy-local-files.mjs` recovers only missing local records with matching host `.data/files` size/SHA256, uses exclusive-create writes and records `file.bytes_restored`. One deleted record was recovered; no fabricated bytes or metadata deletion. This helper is optional repair for that specific historical layout, not normal restore. It requires ALLOW_LOCAL_BACKUP=true and a development container. If no valid copy exists, preserve the blocker and do not mark backup complete.

## Source preview operations (0.1.14)

No schema or provider configuration changes. Deploy API/web together; worker/reconciler use the same updated core image. GET previews rereads and checksum-validates authoritative bytes (max1MiB) every5seconds per open visible modal. This is bounded per request but not a demonstrated large-scale preview capacity; monitor storage traffic before increasing audience/file limits. Browser requests time out at8seconds while backend S3 operations retain their15second deadline. Storage outage/corruption clears the UI and fails closed. Download errors now use the same shared access function. No source text is logged/cached/stored by the preview feature. Roll back to0.1.13-compatible API/web images without a database migration; retained S3 pointers still require the storage overlay.


## Recording a local release

Run `node scripts/record-release.mjs` only after build, health-gated deployment and required checks pass. The recorder derives version from package.json; validates all8containers are running/healthy; matches API/web/workers/scanner/object-provider image identities; checks API version, readiness and web HTTP; then atomically writes docs/evidence/release.json. Missing runtime, wrong image or failed health leaves the previous record untouched. Old evidence remains historical and must not be treated as current health. Docker inspection has15second command deadlines; HTTP has10second deadlines. The workspace source hash includes tools/tests and is not an image-build attestation. Local checks never authorize or prove production deployment.

## Revision rollout (0.1.15)

Migration014 is additive and treats all existing files as version1 originals. API startup runs migrations before readiness; scan/maintenance workers use the same release. Roll API/web/worker together. Root lists remain bounded100 and histories bounded100 accepted versions, including deleted ordinals for the cap. New versions consume logical quota and retained physical storage independently. No cleanup or object-key rewrite occurs. Backups continue to capture every row and referenced immutable byte set; the version2 revision-aware local restore exercise below now verifies history and exact downloads; full production recovery remains open.

After creating revisions, do not roll back to0.1.14 delete semantics: old root deletion would leave revisions accessible. Forward-fix with compatible0.1.15 semantics, or restore a coordinated pre-migration database/file snapshot into an isolated environment and reconcile intervening writes. Dropping revision columns is not a safe rollback. Scanning leases and root deletion use the same channel lock; canceled/deleted children cannot be published ready by an outstanding worker. Pending/rejected new versions never remove prior ready downloads. Coauthoring/version-conflict integration remains unfinished.


## Revision-aware encrypted recovery (tooling on0.1.15)

New backups write envelope version2, including revision_root/revision_number for every file. Validation rejects missing metadata, absent/nested/cross-tenant/cross-channel roots, repeated ordinals and accessible children of deleted roots before target creation. Restore compares manifest revision metadata to restored SQL and verifies eligible local-channel history/downloads plus cross-tenant history denial. Existing version1 backups remain readable but report revisionMetadataVerified=false; do not present them as revision recovery evidence.

`ALLOW_LOCAL_BACKUP=true npm run test:recovery` now creates an original and revision, waits for actual scanning/S3 publication, snapshots both, deletes the source lineage and verifies that exact lineage in the isolated restore. `ALLOW_LOCAL_BACKUP=true node scripts/test-restore-failure.mjs ARTIFACT --revision` re-encrypts a test copy with a valid but incorrect ordinal, verifies database mismatch and cleanup, then removes only that copy. Omit --revision for the existing count-mismatch exercise. Errors are concise; no minified verifier source or content dump is needed in failure reports.

2026-10-14 evidence:65files (45local/20S3) restored, both fixture revisions downloaded exactly, authorized history and cross-tenant denial pass, all temporary infrastructure removed. Snapshot export386ms; isolated restore4021ms and repeat4172ms exclude decryption/cleanup and use warmed local images. Version1 compatibility restored48files (41local/7S3). These are laboratory measurements, not production RTO/RPO. Key custody, Keycloak/provider data, offsite/schedule/retention and large-volume streaming remain unfinished. Encrypted artifact path/digest appears in evidence; recovery key stays in ignored separate mode0600 storage and must never be printed or committed.

## Mention alerts rollout (0.1.16)

Migration015 adds notification_settings and notification_claims; API migrates before readiness. No provider credential, dependency or separate worker is added. Quiet hours use saved user timezone and server time; keep server clock synchronized. Browser constructor support varies: desktop secure-context permission is required, mobile/service-worker delivery remains unavailable. OS toast delivery is outside server acknowledgement; the claim ledger means at-most-once allocation, not exactly-once delivery. API denial and loss never remove Activity entries.

Claims/settings are included in the full PostgreSQL backup archive but no new notification-specific restore exercise was run. Claim retention/cleanup remains pending under enterprise retention scope. The bridge checks only the active organization, at10second intervals; load/cost at target concurrency is unmeasured. Rollback to0.1.15-compatible app images leaves additive tables intact and stops alert construction; no column/table drop is required. Recovery by replaying claims is intentionally not automatic because it would risk duplicate notifications.

## Local SMTP digest deployment (0.1.17)

Use all six overlays:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.scanning.yaml -f compose.storage.yaml -f compose.email.yaml up -d --build --wait
ALLOW_LOCAL_EMAIL_TEST=true node --import tsx scripts/test-local-digests.mjs
```

Mailpit1.31.5 is pinned by digest; UI is loopback http://localhost:5185, SMTP has no host port. It joins default and internal mail networks because this runtime does not publish ports from internal-only networks. No relay/forwarding configuration is supplied. Sender adapter and Mailpit independently restrict recipients to .test; local mode is rejected in production. Capture storage has a persistent volume and500-message cap. It contains synthetic local test mail, not verified external delivery. Do not use Mailpit as an enterprise outbound relay. Nodemailer10.1.0 uses no file/URL content access, one configured sender and the directory recipient address; credentials stay server-side and SMTP errors are reduced to codes.

Digest worker owns no new service schema: it is another process in the modular core, with192MiB/0.5CPU,40second shutdown grace, heartbeat and configured SMTP guard. API exposes configured/unconfigured status and personal recent jobs. Production requires a verified sender/domain, implicit TLS SMTP465, user/password secrets and HTTPS application origin; SPF/DKIM/DMARC, regional obligations, bounce/complaint processing, costs and deliverability are unverified. Do not set SMTP_LOCAL_CAPTURE in production. No external provider account or chargeable resource is created by this release.

Investigate uncertain jobs against provider logs/Message-ID before any manual action. Never blindly reset sending/uncertain jobs: SMTP may already have accepted them. Dead means permanent rejection or exhausted retries; canceled means no currently eligible recipient/activity. A sending lease expiry becomes uncertain, not a retry. Sent means SMTP acceptance only. Already submitted email cannot be recalled by later access changes. Authorization is checked just before submission; current application links still enforce revocation on opening.

Migration016 is additive; rollback to0.1.16 stops the digest worker and email overlay while retaining tables for audit/investigation. Do not drop jobs/reservations to force resend. Backup database dumps include new tables but email-specific restore/provider-volume recovery has not been exercised. Claim/job retention, scheduled monitoring/alerts and representative load/cost remain unfinished. The live test creates isolated synthetic users/workspace, disables/archives them afterward and preserves job/audit evidence; it never sends to external recipients or rewrites unrelated preferences.

### Scanner-aware worker readiness (0.1.18)

`compose.scanning.yaml` now runs `node services/core/file-worker-health.ts` for the worker health check. It requires a valid heartbeat younger than120seconds (at most5seconds ahead) and a successful three-second scanner capability/signature probe. The existing seven-day signature age policy is unchanged. An unavailable scanner or stale/unverifiable signatures mark the worker unhealthy even while its loop continues; uploads remain quarantined and existing bounded scan retries apply. Docker health alone does not restart the worker. Investigate scanner service health, signature refresh/network access and queued/dead scan jobs; do not bypass quarantine or mark files clean manually. The core API remains independently available.

Local fault exercise (temporarily stops the task-owned scanner and restarts it in a finally block): `ALLOW_LOCAL_SCANNER_TEST=true node scripts/test-scanner-readiness.mjs`. It requires initially healthy scanner/worker containers, observes worker unhealthy with API ready, then verifies restored health. Do not run it concurrently with file scanning tests or active uploads. If interrupted externally, restore with `docker start concord-collaboration-clamav-1` and verify both services. This exercise does not establish production alert delivery, signature-update availability or a monthly SLO.

### Browser reply alerts (0.1.20)

Migration017 adds default-disabled reply preferences and a separate enablement timestamp. Deploy through the existing migration-on-start process; no new service or secret. In Settings, grant browser notifications and explicitly enable browser reply alerts. Mention and reply toggles are independent; quiet hours apply to both. Keep the workspace open. Messages predating category enablement are not newly alerted, and each claim is reserved once across tabs/categories. Claims lost after allocation are not automatically replayed; Activity is the recovery path. Existing received notifications cannot be recalled after later permission changes. Rolling back to0.1.19 leaves additive columns intact and stops reply notifications; avoid deleting claims or dropping columns to force replay.

### Invitation inbox (0.1.21)

Already-provisioned identities can open Settings → Workspace invitations to see and explicitly accept invitations addressed to their account email. The assigned role and expiry are displayed before acceptance. Invitations are rechecked every5seconds; invalid/used invitations disappear. The existing manual token path remains supported. Email delivery and account self-provisioning remain unavailable. Existing inactive memberships are intentionally hidden from the inbox and cannot be reactivated through either acceptance path; an administrator must resolve them.

No migration/provider/secret changes. Concurrent acceptance is serialized per identity; invitation revocation and acceptance are ordered by row locking. Revoking an invitation after acceptance does not remove membership: use membership administration. Browser fixture creates a synthetic organization and ends by revoking its invitations and disabling its memberships; evidence records are retained. This is local behavior, not an external identity/mailbox-verification claim.

### Invitation discovery and decline (0.1.22)

Pending invitations produce an in-app notice across authenticated screens, explicitly labeled across workspaces. Review opens Your invitations; Settings remains available. The notice polls every5seconds with an8second request deadline and clears counts on failure. It holds no persisted local data, resets on identity changes and displays50+ when the bounded inbox is full. Acceptance/decline updates may take one polling interval to reach another tab.

Recipients may decline valid invitations; the existing revoked state and invitation.declined audit record the decision. This action never changes membership, and cannot decline an already accepted invitation. Admins can issue a new invitation. No migration/secret/provider change. This remains an in-app notification only, with no email/browser invitation push. Production polling load/alerting and full retention remain open.

### Meeting edits (0.1.23)

Migration018 adds meeting revision1. Organizers choose Calendar → Edit meeting; input times are browser-local, explicitly labeled. Untouched inputs preserve original instants, including fractional seconds. The meeting's existing timezone metadata is retained; attendee roster is unchanged. Time changes reset other attendees to pending. Calendar Refresh loads current data for attendees and organizers. On stale-edit conflict, close the dialog, refresh and reopen; do not automatically overwrite a newer revision.

Cancelled meetings cannot be edited or receive new RSVPs. Update/cancel/respond actions are audited. If rolling back, retain the additive revision column; older binaries do not enforce edit/RSVP revision semantics, so prefer forward-fix while editing is in use. Calendar synchronization, recurrence, timezone selection/DST ambiguity prompts and real joining remain incomplete. No provider/secret changes. Local browser test cancels its synthetic meeting on completion.

### Meeting attendee edits (0.1.24)

Organizer Edit meeting now includes attendee checkboxes from the authorized workspace directory. Organizer cannot be removed. Missing/inactive existing entries are labeled unavailable and can be removed; unavailable recipients must not be submitted. Saving uses the same revision check as time edits. Removing an attendee withdraws subsequent calendar/RSVP access; re-adding starts pending. Unchanged attendees retain responses unless the time also changes. Other users refresh their calendars to observe changes; previously viewed/downloaded information cannot be recalled.

No schema/provider/dependency change. Older clients omitting attendees preserve roster. Native calendar/email invitations, connected media permissions and full enterprise directory synchronization remain separate incomplete requirements. Browser fixture verifies removal/re-addition and cancels its meeting afterwards.

### Calendar range and pagination (0.1.25)

Migration019 adds `(org_id,starts_at,id)` index. Calendar loads50 rows and offers Load more. Optional Calendar from/through are inclusive browser-local dates, converted to an overlap interval ending at next local midnight; range limit366days. Clear both and Apply dates for all history. Refresh restarts at first page; creation/edit also refresh within the applied range and does not silently expand it. Concurrent rescheduling may move meetings across a cursor; UI deduplicates but cannot guarantee a snapshot, so refresh when needed.

API cursors retain database microsecond precision. Current access is checked per page; no authorization-bearing cursor secret exists. Page requests have8second timeout and cancel superseded/unmounted requests. Append failure retains loaded cards and offers Retry; replacement failure clears stale cards. Local browser fixture inserts53 isolated meeting records, then deletes those exact IDs in cleanup. This validates pagination behavior, not large-scale capacity/index latency or a production SLO. No provider/dependency change.

### Automatic calendar refresh (0.1.26)

Migration020 adds durable recipient/workspace counters; no backfill required. Open Calendar polls every5seconds with8second timeout and immediately on visibility resumption. Meeting changes refresh page1 and announce the page reset. Open edit drafts are preserved, so conflicting saves still receive revision409. Loading many pages does not trigger unbounded automatic refetching. Counter failures clear stale displayed meetings and show automatic-retry status; recovery refetches page1 even with unchanged counter. Hidden browser tabs may throttle timers; no background delivery deadline is promised.

Create/edit/cancel/RSVP and counters commit atomically. Removed attendees receive invalidation but subsequent calendar access remains denied. Member revocation prevents counter access; information already copied cannot be recalled. Rollback to older writers would stop counter updates for their mutations, so prefer forward-fix or disable automatic-refresh claims until all writers are compatible. No new provider/secret/dependency. This is local polling behavior, not measured production delivery latency/capacity.

### Scheduling timezone and daylight saving (0.1.27)

Create/edit dialogs expose Scheduling timezone and Repeated clock time. Default zone for creation is browser zone; editor uses saved meeting zone. Select an IANA zone using suggestions or enter one. Changing zone reinterprets wall-clock fields. A gap from advancing clocks is rejected; a repeated time requires earlier/later selection. Existing unmodified editor instants preserve their original resolution, so text/roster edits do not accidentally move a folded time. Each endpoint is validated before the API write; server still enforces interval/authorization.

Pinned @js-temporal/polyfill0.5.1 uses Intl timezone data; deploy browser/OS updates under compatibility tests because tzdata rules can change. No schema/secret/provider changes. Tests use2026NewYork transition dates and nonhour Asian offsets; this is not exhaustive historical/future timezone certification. Both endpoints share one occurrence selection; independent start/end choices, recurrence and external calendar interoperability remain open. Runtime audit evidence updated for this dependency change.

### Recurring series (0.1.28)

Migration021 introduces scoped series registry and occurrence identity. Creation supports bounded daily/weekly repeats, max52 occurrences/366day start span. Local clock times stay fixed in the selected timezone; a clock-change gap or unresolved repeated time anywhere rejects the whole series. Organizer edits affect one occurrence, clearly labeled. Cancel occurrence affects one; Cancel series cancels every occurrence, including past entries, and invalidates attendee calendars. Series-wide rescheduling/roster changes, monthly/yearly rules and external delivery remain open.

The create dialog retains a stable operation ID for unchanged retries while mounted; reload loses that local operation state, so reload-recovery is not claimed. Core persists matching request identity and returns original IDs even after cancellation. A changed payload must use a new operation ID. Never delete registry rows to force a retry. Older binaries cannot create series and might ignore series metadata; use forward-fix/compatible writers when series exist. Include registry/occurrence tables in core database backup; a new series-specific restore exercise remains pending. No new provider/dependency/secret.

### Whole-series content and roster edits (0.1.29)

Migration022 adds series revision. Open any active occurrence's editor and choose All noncancelled occurrences. Title, description and selected attendees replace every active occurrence; initial selections come from the opened occurrence, so review them if occurrence rosters differ. Cancelled occurrences and all times/zones stay unchanged. Retained responses are preserved, new attendees pending. Series-wide rescheduling is unavailable. Stale edits require close/refresh/reopen; the UI never silently overwrites.

Individual content/roster edits and cancellations increment the parent revision, with consistent series→occurrence lock order. RSVP stays serialized per occurrence but does not invalidate series content editing. Older writers do not increment series revisions and may use incompatible lock order; prefer compatible forward-fix deployment rather than rolling back during series editing. Include new revision in core SQL backups; series-specific restore verification remains pending. No provider/dependency/secret change.

### Canonical whole-series rescheduling (0.1.30)

Migration023 backfills series anchor UTC start/end/timezone from ordinal1, then requires them for new writes. Organizers choose Reschedule series from any active occurrence. Loaded dates explicitly refer to first ordinal slot, not the opened occurrence. Set new anchor, zone, daily/weekly frequency and interval; count stays fixed. All candidate slots undergo DST/span validation, including cancelled ordinal slots, while cancelled meeting rows remain untouched. Active text/roster exceptions are retained and time changes reset their attendees' responses.

Canonical registry is separate from individual exceptions: cancelling or editing ordinal1 does not change future rescheduler initialization. Stale edits require close/refresh/reopen. Stable occurrence IDs remain; compatible creation replay returns those IDs without resurrection. Migration makes old series-creation writers incompatible because new anchor fields are required; use forward-fix or a coordinated restore with compatible binaries. No provider/dependency/secret changes. Series-specific restore verification and rule/count expansion remain pending.

### Monthly/yearly recurrence (0.1.31)

Migration024 expands frequency check and adds defaultreject month-day policy. Choose Monthly/Yearly and Missing month date in creation or rescheduling. Reject prevents whole-series creation when a later date is absent; Use last valid day produces Jan31→Feb28→Mar31 and Feb29→Feb28 in nonleap years, returning to Feb29 in leap years. Each slot derives from canonical anchor; overnight local duration follows generated start. DST validation still applies. Monthly/yearly horizon5calendar years; max52occurrences and interval1–12. Calendar date filter remains independently limited366days, so browse separate ranges for multi-year series.

Legacy defaultreject creation replay hashes are preserved. Old schedule callers omitting policy preserve stored policy. Older writers cannot safely interpret new frequency values or month-day policy; forward-fix/compatible release required. This is bounded recurrence, not general RRULE/weekday/skip-invalid-date support. Core SQL backup includes policy; series-specific restore verification remains pending. No new provider/dependency/secret.

### Calendar-aware encrypted recovery (envelope3, application0.1.31 unchanged)

`npm run backup:local` now includes counts and ordered-row SHA256 digests for meetings, meeting_series, meeting_attendees and calendar_versions in the same exported PostgreSQL snapshot. Digests remain inside the encrypted artifact; recovery checks them before domain API verification. Source and restored queries use explicit UTC/ISO formatting and each table is bounded50000rows. Existing file limits/encryption/separate0600key requirements remain. Never print or commit `.data/backup-keys/local-core.key` or decrypted artifacts.

Run `ALLOW_LOCAL_BACKUP=true node scripts/test-calendar-recovery.mjs` for a synthetic monthly/yearly fixture with cancelled occurrence, canonical reschedule, individual exception/removed attendee and RSVP. Snapshot precedes source series cancellation. Isolated recovery verifies exact owner/recipient list projections, canonical metadata, tenant denial, removed attendee RSVP denial and stable creation replay without overwriting snapshot state. An authenticated-but-wrong calendar digest must fail with cleanup. `ALLOW_LOCAL_BACKUP=true npm run test:recovery` retains real ClamAV/S3 revision/download/tenant checks and ciphertext-tamper rejection. Version1/2 restore remains supported; calendarVerified=false correctly records missing calendar evidence in legacy envelopes.

No application image change. Restorer binds the host's read-only calendar helper into the artifact's recorded API image. Keep host recovery tools with handover/version control and run compatibility tests when schema changes. Calendar/API exercise input is synthetic and supplied explicitly via CALENDAR_RESTORE_FIXTURE by the fixture driver; generic restoration verifies table digests/graph without assuming account fixtures. These exercises cover core SQL/local/S3 only; Keycloak, email/media/external calendars, offsite backups and full production RTO/RPO remain unverified.

### Append-only series expansion (0.1.32)

In Reschedule series, increase Total series occurrences up to52 within the existing horizon. Existing IDs and cancelled occurrences are retained. New entries copy highest-ordinal active occurrence's content/attendees; if those identities no longer qualify, update the active roster first rather than bypassing eligibility. New entries have pending attendee responses. Decreases are intentionally rejected; cancel unwanted occurrences. Fully cancelled/no-active series cannot be expanded.

Expansion can accompany rescheduling and commits all new slots/count/revision/counter invalidation/audit together. Stale requests fail before additions. A retry of original creation returns its original occurrence IDs despite a larger current series, preserving the original acknowledgment boundary. No migration/provider/dependency change. Envelope3 recovery now exercises a6slot series created originally as4slots, checking full restored graph plus original4-ID replay. Older binaries may return all IDs on creation replay after expansion, so use compatible writers for retry semantics.

### Upcoming-only series scope (0.1.33)

Meeting editor offers Upcoming noncancelled occurrences for title/description/roster edits; Reschedule series offers Only upcoming occurrences. Upcoming means existing start>=one authoritative database cutoff captured after locks. Meetings already started, including ongoing ones, are preserved exactly. Affected proposals/new slots may not move before cutoff. Date fields still anchor slot1; historical slots remain exceptions when canonical rule changes. All candidate slots still validate under existing recurrence bounds/DST policy.

No future details rows yields409. Expansion can add future slots from last active template while preserving old rows, but all-cancelled/no-active series cannot revive. Defaultfalse preserves old clients/all-active scope. Audit includes scope/cutoff/preserved count. No schema/provider/dependency change. This is not an organizer-local-clock assumption or a future-only series split into a new identity. Retained historical information and downloaded copies remain governed by separate retention/access work.


Release0.1.34 upcoming cancellation requires no schema change. Deploy updated API/web together for the optional scope field. Cancellation retry is a no-op when no eligible rows remain. Historical active rows keep the series registry active and can still be explicitly edited/cancelled; calendar invalidation is scoped to affected attendees. Canonical schedule/count unchanged. Application rollback must account for older API rejecting futureOnly; do not pair new client with old API. Recover data through the recorded encrypted-backup procedure rather than assuming cancellation is reversible.


Release0.1.35 preview requires no migration/provider configuration. Shared Temporal generator must stay compatible in web/API artifacts; preview makes no remote writes and does not replace backend validation. At most52 slots are generated/displayed in a focusable bounded scrolling list. No preview data persists to local storage. Rollback has no data migration; retain current series metadata/schema compatibility.


Release0.1.36 migration025 adds meeting_reminders with composite attendee FK/cascade and user index. Existing meetings remain opt-out. API startup applies additive migration under existing migration lock; deploy current API/web together. Reminders are read-time due projections, with no new worker/queue or external provider; API/storage outage clears stale banners and retries. Poll10sec/deadline8sec, up to20 reminders ordered by time/ID. Dismissals/config persist across app restarts; due status follows DB clock, so maintain clock synchronization. No reminders after meeting starts, and quiet-hour expiry does not guarantee delivery if already started. New series slots do not inherit personal preferences. Current SQL dump includes reminder data; calendar-specific digest fixture covers older4tables and has not independently verified reminder restore. Rollback retains additive table; forward-fix migration rather than destructive drop. Never restore removed attendees' reminder settings by client inference.

Reminder dismissal is scoped to the last dismissed exact start instant: moving back to that same instant retains dismissal until the user turns the reminder off/on. This bounds stored dismissal state to one timestamp; it is not a complete reminder history.


## Reminder-aware recovery — envelope4 (application images0.1.36 unchanged)

New `ALLOW_LOCAL_BACKUP=true npm run backup:local` artifacts include exact meeting_reminders row digest/count in addition to the existing4calendar tables. Same limits/separate ignoredkey and immutable-file snapshot apply; new table <=50000rows. `ALLOW_LOCAL_BACKUP=true node scripts/test-calendar-recovery.mjs` creates only a synthetic organization/series/due meeting, captures owner and recipient settings plus dismissed exactstart, then cancels source series and deletes source due preference after snapshot. Disposable internal restore compares rows/digests, exact owner/recipient APIs, recurring replay, due reminder/tenant/removed-attendee boundaries and successful persisted dismissal. A valid encrypted wrong reminder digest must reject and clean all exercise resources. Finally synthetic source meetings canceled/membershipsdisabled; unrelated tenant data untouched. No key or decrypted content printed.

Actual0.1.36 exercise:99files restored (59local/40S3),143meetings/26series/236attendees/11calendarcounters/5reminders,4827ms localrestore; reminderMetadataVerified/reminderApiVerified/calendarVerified/calendarApiVerified=true. Authenticated reminder digest mismatch rejected; cleanupcomplete forbothpaths. No eligible ready general-channel file in this fixture, so download/isolation flagsfalse; prior independent file recovery proof retained. Existing v3 artifact independently restored99files in11379ms, calendarVerified=true and reminderMetadataVerified/reminderApiVerified=false, cleanupcomplete. Versions1/2 likewise retain prior evidence scope. v3archives captured before reminder table existed cannot prove its restoration. Clock-sensitive due fixture requires completion before its30minute start; keep explicit nonquiet recipient and no external-delivery claim.

Host snapshot helper mountedread-only into recorded immutable APIimage must remain version-aware; retain archived helper/toolchain for reproducible older restores. Current source health record updated, appimages/schemaunchanged. Full offsite/provider/Keycloak/media recovery and production RTO60m/RPO5m/durability/backupretention objectives remain unverified. Lab millisecond results are not production guarantees.


## Channel posting policy — release 0.1.37

Migration026 adds channels.posting_restricted defaultfalse, preserving existing behavior. API startup applies the additive migration. Deploy current API/web together. Organization owner/admin must also have channel access; private channel membership is never bypassed. An admin toggle and message send/edit use the same channel row lock. Existing channel revision protects against stale policy writes; refresh after409. Changed policy/audit/outbox event commit atomically; no-op update creates no event. Connected clients refresh through existing SSE recovery.

This restriction covers new text posts/replies/edits. Reading, saved drafts, own eligible deletion, reactions, files and work boards retain their existing permissions. Accepted message replay remains confirmable after restriction without inserting new content. Administrative role revocation is checked on subsequent writes. No report queue, custom moderator roles, posting schedule or meeting policy is claimed here. Current SQL backups include the additive column; dedicated recovery exercise has not been rerun for this schema. Retain the column on application rollback; use a forward fix for schema issues. Older app images must not be used to enforce the new restriction because they do not check it.


## Message reporting — release 0.1.38

Migration027 adds scoped message_reports references, immutable reporter/message uniqueness, resolution state constraints and queue/quota indexes. No message-body snapshot is stored. Apply via existing API startup migration lock; deploy current API/web together. Keep table on rollback and use a forward fix. SQL dumps include it, but dedicated report restore verification has not been run. Retention/legal holds/export workflows remain incomplete; no certification claim follows from audit rows.

Admin queue/action requires organization owner/admin plus current channel ACL; private-channel access is never bypassed. Admins without channel access cannot discover or resolve those reports until properly admitted. Existing organization audit role still sees actor/report reference/action metadata, never reason/details/private note or message text in these new entries. Reporter receipts require current channel access and omit review notes/identity. Removal follows existing soft-deletion behavior and clears mentions, with a transactional outbox event; other reports remain for explicit review. Reporters can look up their status on a deleted message. Direct/group reporting is explicitly unavailable, so full moderation scope remains open.

Limits:10 new reports/hour per reporter/channel, details/note1000chars, review20rows default/50max. Same report retry is deduplicated under channel lock. Queue uses explicit refresh and keyset pages; current ACLs are rechecked on every request/action. Already rendered plaintext cannot be retroactively recalled. Concurrent decisions produce one committed decision and conflicts for competitors; refresh after409. Retry an uncertain accepted decision with the original revision/action/note to confirm without duplicate events. Use a separately authorized role/membership change rather than bypassing channel access. No new worker/provider/external resource required.


## Moderation-aware recovery — envelope5, application0.1.38 unchanged

New backups include nine moderation/policy/ACL/content/audit/outbox table digests in the same exported repeatable-read SQL snapshot as calendar/files. Existing10000-file/32MiB-file-bytes/64MiB-envelope and50000-row-per-table limits remain explicit local bounds. Separate ignored0600 JWE key is unchanged. Never print key/decrypted content; retain compatible source helpers alongside recovery artifacts. Host helpers are mounted read-only into the recorded immutable API image. Older envelopes do not acquire new verification claims.

Run `ALLOW_LOCAL_BACKUP=true node scripts/test-moderation-recovery.mjs`. The isolated synthetic tenant contains a restricted visible private channel, another private channel inaccessible to its owner, and open/dismissed/removed cases. After snapshot, only synthetic source policy/pending decision are changed. Restored APIs verify current role/channel boundaries, current policy enforcement, receipts without private notes, accepted message replay, duplicate report/decision idempotence, exact audit/event increments and processing of the pending case. Report and channel digest mismatches must each reject with cleanup. Finally synthetic memberships are disabled, test sessions revoked and negative artifacts deleted. Positive encrypted artifacts remain ignored/local.

Final exercise restored101files (61local/40S3),372messages/16channels/9reports/3394audit rows/952outbox rows in3678ms; moderationMetadataVerified/moderationApiVerified true, both mismatch cases rejected. Calendar/reminder regression restored101files/157meetings/28series/274attendees/17calendar counters/9reminders in4056ms, with their APIs true and moderation metadata true (no moderation API fixture on that run). Legacyv4 artifact restored99files in3593ms, moderation flags false as required. General file download/tenant flags were false for these fixtures because no eligible ready general-channel file existed; earlier independent file proof retains its scope.

The initial calendar regression's positive restore passed, but its negative path failed before digest checking when pg_restore raced the temporary initialization server shutting down. Pinned entrypoint inspection confirmed listen_addresses='' during initialization. TCP readiness fixed the race; complete calendar and moderation reruns passed. Preserve the original failed log. Inventory confirms zero remaining concord-restore containers/networks/volumes. This is local evidence only: offsite/Keycloak/provider/media recovery, production retention, durability, RTO/RPO and immutable audit certification remain open.


## Audit search — release 0.1.39

Migration028 adds tenant/id, tenant/action/id and tenant/time/id indexes; no data rewrite or external search service. Normal transactional index creation may briefly lock the audit table during startup; use a measured online migration plan before a production-size deployment. Current local dataset only is verified. Existing startup migration lock prevents duplicate application. Deploy API/web together; older clients ignore nextCursor while retaining100-row default. Forward-fix schema/index issues and retain the audit data on rollback.

GET audit search requires current owner/admin membership on every page. Tenant scope is authoritative; action/actor/target are exact filters, not role inputs. Bigint IDs remain strings through API, cursor and client. Range is paired UTC, half-open and<=366days. UI enters browser-local times and submits UTC. Historical former actors can be filtered by known ID even when absent from current people suggestions. Metadata is displayed literally and never used as executable markup. Search does not alter stored events. Result scope is cleared on workspace change; failed page retries preserve earlier results, and failed initial queries clear them.

These indexes support current bounded searches; actor/target-only large-volume latency, production load/availability and tamper-resistant archival have not been measured or established. Query pagination is not a database snapshot. Retention/legal holds, audit export and immutable storage remain separate unfinished work. Version5 backup row manifests still cover audit rows; dedicated recovery is not repeated for index-only schema change, and previous image/snapshot evidence retains its scope.


## Audit JSON downloads — release 0.1.40

Deploy API/web together using the existing six compose overlays; no new migration, dependency or provider. Per-request output is limited to1000 events/2MiB with conservative JSON header headroom. A bounded1001-row selection rejects oversized exports instead of truncating. Database processing can still encounter large individual metadata rows; production memory/load behavior remains unmeasured. Operators/users should narrow action/actor/target/time filters after413. Five successful generation records per actor/org rolling minute are enforced transactionally;429 retries wait60seconds. Shared-IP limits also remain active. Audit retention must preserve this recent window if retention is later added.

The UI exports applied filters across all matches, independently of loaded pages. Changed filters must be searched first. It verifies tenant, format/count/row scope and exact-byte SHA256 before a temporary Blob download, aborts on workspace/unmount changes, and supports retry without discarding search results. The server digest detects response corruption; it is not an independent signature or tamper-resistant archive. Use TLS outside loopback. Download managers control saving; generation audit does not establish recipient delivery. Downloaded content cannot be recalled. Raw JSON retains large numbers; downstream tooling must avoid lossy numeric parsing.

94 automated tests and three deployed Chromium audit/moderation flows pass. Browser evidence includes actual25-event download, changed-byte digest rejection with no download, successful retry, tenant reset and390px layout. No recovery drill repeated for this endpoint-only change; previous image-specific recovery evidence retains its scope. Full user/tenant export, immutable archival, retention/holds, production capacity and external deployment remain open.


## Usage reports — release 0.1.41

Admin → Usage report requires current owner/admin membership and applies current resource ACL. Refresh manually after activity or access changes; failure clears prior results. Dates are UTC with exclusive end,1–31days. Explain partial accessible scope before comparing reports between administrators. Current logical file metadata totals can include quarantined/blocked/historical versions and differ from physical object storage. Scheduled seconds do not measure actual calls. No analytics warehouse/job/provider or new schema introduced. Production query cost remains unmeasured. API image must include lib/usage-contract.ts alongside its existing runtime helpers; the corrected deployment checks actual API readiness as well as image build success.


## Group chat lifecycle — release 0.1.42

Open a direct/group conversation's Conversation details to see current active participants. Refresh participants manually after membership changes or errors. Group members can rename a nonarchived group; conflicts retain the typed name and require Refresh participants before retrying. Rename is not restricted to workspace administrators. Existing group details API callers must send current revision.

Leave group requires an explicit second confirmation. Warn that personal draft/preferences are removed and access is revoked while existing shared messages remain. This is voluntary departure, not content erasure. Last participant may leave; there is no rejoin control. API retries after departure return404; a lost response can be checked through refreshed bootstrap. Successful leave removes the conversation from client navigation before refreshing bootstrap, and refresh failures are surfaced. Previously copied/rendered/downloaded content cannot be recalled. Backup format/schema remain unchanged; this release does not add independent post-departure restore evidence or retention enforcement.


## Explicit group history grants — release 0.1.43

Conversation details → Manage group access appears for current workspace owners/admins who already belong to a group. Choose an eligible workspace member, then explicitly check the full-history grant to enable Add participant with history. This grants prior retained messages and files; quarantine/deleted states retain existing download restrictions. Re-admitting someone who left or was removed requires the same grant. No future-only history option is offered.

Removal requires a second confirmation, preserves shared content and clears the removed member's personal draft/preferences. Refresh participants after conflicts or uncertain responses. Current-revision no-ops do not duplicate audit, while stale retries conflict. The admission cap counts all explicit membership rows, including inactive members;100 prevents further additions until a participant is removed. Existing oversized groups remain readable/removable. Other admins cannot discover or self-join an inaccessible group through these routes. Archived groups cannot be changed; voluntary leaving retains previous behavior. Audit records reference IDs/history scope only, without message/file contents. No schema or backup-format change; post-grant/removal recovery and production capacity have not been independently tested in this increment.


## Channel details and archive — release 0.1.44

Current owners/admins with access to a standard/private/shared channel can open Conversation details → Channel settings. Edit name/description and choose Archive channel, then Save channel settings. Refresh channel settings discards local unsaved edits in favor of current values. A stale save preserves typed input and asks for refresh; it cannot overwrite another admin or policy/team change.

Archiving keeps history and personal drafts. Existing subscribers see the archive notice and cannot send new messages/replies; direct API sends return409. Restoring re-enables sending under current posting rules. If the parent team is archived, restore it first, then refresh channel settings. Archive does not erase content, change recipients or withdraw downloaded bytes.

All details PATCH callers must now include current revision, including non-group channels/direct chats. Older clients without revision receive409 and must refresh/upgrade; missing revision is not treated as unconditional overwrite. Existing browser fixture cleanup now reads settings revision. No schema or backup-format change, and no new independent archive-state backup restore or rolling-client compatibility verification is claimed.


## Team ownership — release 0.1.45

Teams → joined team → Manage team ownership shows current owners and eligible successors. Only a current team owner can transfer their own ownership, including when their workspace role is an ordinary member. Choose an existing active/enabled non-guest team member, review the demotion notice, then Confirm ownership transfer. Cancel with Keep ownership. The former owner remains a member and can use Leave team afterward. The new owner keeps their existing workspace role; this operation grants no organization administration or additional channel history.

Refresh ownership after conflicts or an uncertain response; a completed transfer removes the caller's owner controls, and a retry403 does not imply it was rolled back. Owner-set comparisons prevent overwriting changed owners, and archived teams must be restored first. Inactive/disabled co-owners do not permit the last active owner to leave. No eligible successor means transfer is unavailable until an eligible member joins; guest admission/team membership management is still a separate unfinished scope. Ownership snapshots are bounded to1000members. No independent transfer-state backup recovery or production-capacity claim is added; schema/backup format unchanged.


## Private/shared channel membership — release 0.1.46

Current workspace owners/admins who already have channel access can use Conversation details → Channel access. Refresh the roster before acting on conflicts or uncertain responses. Choose a workspace member and explicitly confirm all retained messages/files before Add member with history. Other channel content retains its existing permissions. This grants no team membership or access to another tenant; same-tenant guests may be admitted explicitly.

Remove a member with a second confirmation. Access is revoked, draft/preferences cleared and shared content retained. Self removal is refused to avoid accidental administrative lockout. Inactive/disabled explicit members remain visible for cleanup and count toward the100-row admission cap. Archived channels must be restored before changing membership. Standard channels inherit team membership; these controls do not appear there. Re-admission requires fresh history consent. Roster display is bounded to1000entries; oversized views fail explicitly rather than truncate. Channel membership changes increment the same revision as settings/policies/migration, so stale decisions conflict.

Existing team-leave behavior can remove private explicit grants; shared explicit membership follows its existing separate ACL. No automatic team enrollment or guest-policy expansion, cross-tenant shared-channel service, retention purge or self-join is introduced. Existing backup manifests already hash channel_members, but no new post-admission/removal restore proof is claimed in this release.

Channels granted outside your joined teams appear under Other channels after workspace refresh/reload. Opening them does not join their parent team or reveal its standard channels. This keeps explicit private/shared grants discoverable without a deep link.


## Administrative team members — release 0.1.47

Teams → joined team → Manage team members is available to current workspace owners/admins. Team ownership alone does not grant organization administration. Choose an active workspace identity, including a guest, and explicitly confirm retained standard-channel history/files before admitting. Private/shared channels still require separate grants. Refresh team members after stale/uncertain responses; refresh discards the selected target/confirmation state.

Removal has a second confirmation explaining loss of standard access and all private grants in that team, clearing personal drafts/preferences there while keeping shared-channel grants and shared content. Owners must transfer first; use Leave team for yourself. Inactive/disabled ordinary members can be cleaned up, while inactive owner recovery remains separate unfinished work. An absent-team-member no-op does not withdraw separately granted private access. Re-admission restores standard access only. Guests cannot self-join; ordinary members retain open-team self-join, so this is removal rather than a durable ban.

Roster/admission is bounded to1000entries for this administrator workflow; oversized views fail explicitly. Team snapshots use a current ID/role-set hash rather than a stored team revision. Current account eligibility/roles are rechecked separately. New changes invalidate standard/affected-private channel revisions, so old channel settings/policy/migration reviews may need refresh. Shared grants keep their existing scope. No new independent team-removal backup restore, production capacity, owner recovery or full lifecycle claim is added.


## Teams without an active owner — release 0.1.48

Teams → Manage team ownership exposes Recover team ownership only to a workspace owner already in a team with no active/enabled owner. Choose an eligible existing member, review the inactive-owner reset notice, then Confirm ownership recovery. Cancel recovery preserves state. Ordinary workspace admins cannot recover, and teams with an active owner must use normal transfer. Restore archived teams first.

Recovery demotes inactive former owners to ordinary team members and appoints the selected member. Reactivating an old account does not restore its former owner role. Workspace roles, memberships and channel access do not change; no user account is re-enabled. Refresh ownership after stale/uncertain responses; duplicate requests after success409 because an active owner now exists. Last-active-owner departure protection still applies to the successor.

This repairs the narrow team-ownerless case. It is not enterprise account recovery, forced team join, arbitrary owner demotion, deletion or full operational recovery. Roster/owner views retain their1000-row bound. No independent post-recovery backup restore or production-capacity claim is added, and schema/backup format are unchanged.

## Uploader file recovery — release 0.1.49

Files → Your deleted files → Refresh deleted files lists own retained tombstones for the selected conversation. Recover originals before individual versions, review renewed visibility to current members and confirm. Recovery consumes the same100MB active workspace quota as upload. Restore an archived conversation first. Every recovered file returns to quarantine; monitor existing worker health/job status and use uploader Retry scan for exhausted jobs. Missing/corrupt bytes or scanner outages remain fail-closed. Never mark a recovered file ready manually. Old attachment links resume only after a new clean verdict; copied content is outside revocation scope.

Migration029 adds files.lifecycle_revision and deleted-uploader lookup; migration030 adds audit.actor_id index after repeated1000-identity test cleanup exceeded10s on326k retained audit rows. No audit rows were purged and database timeout stays unchanged. Apply with normal migration runner/API boot. Full database backups include new column/index, but no new cross-version restore drill was performed. Retention expiration, legal holds, permanent file purge, message recovery and account closure remain unimplemented.

## Message/file preservation — release 0.1.50

A current workspace owner who can already access a standard/private/shared channel uses Conversation details → Message and file preservation. Enter a current case note, review and explicitly confirm application. Refresh discards unsaved note changes. Applying/releasing is protected by its own revision; refresh after409. Owner/admin role alone never grants private-channel access; ordinary admins cannot manage or read hold notes. Holds can be managed while a channel is archived.

Active holds block message edits/deletions, moderator removal and uploader file deletion. Moderators may dismiss reports; a blocked removal leaves the report open and content unchanged. This control keeps held content visible under current ACL. If visibility must be restricted, manage channel access under its existing rules; no hold exemption for moderators exists. New messages/files and independently scanned recovery remain available. Release requires review/confirmation by a currently authorized owner. Audit records state/revision/reference only; current note is stored separately from participant history, without versioned case-note history.

Migration031 creates channel_preservation. Full database dump captures it, but existing selective backup comparison summaries do not independently hash this table and no new post-hold restore drill was performed. No purge/retention worker exists; future expiration, purge and account/tenant closure must honor active holds under channel serialization before shipping. Tasks/forms/calendar/personal state are outside this hold. No full legal/compliance acceptance, retention scheduling or historical deleted-message recovery claim.

## Preservation-aware backup and independent restore — release 0.1.51

`ALLOW_LOCAL_BACKUP=true npm run backup:local` writes version6 encrypted archives with explicit preservation/file/scan-job digests plus lifecycle revisions. Existing file/dump integrity, lineage, calendar/reminder/moderation comparisons and local limits remain:10000files,32MiB file bytes,64MiB plaintext envelope,50000rows per digested table. Any limit/integrity failure stops backup rather than omitting data. Owner notes remain inside encrypted payload; keep mode0600 key separate from artifacts. Restore before-target validation and exercise resource cleanup remain mandatory.

Run `ALLOW_LOCAL_BACKUP=true node scripts/test-preservation-recovery.mjs` only against the loopback development deployment. It creates an isolated synthetic organization with active/released/inaccessible-owner holds and real-scanned S3 original/version, captures a snapshot, changes only fixture source hold/body/file state, and restores in a private temporary network/database/object volume. Restored API checks owner-only notes/current ACL, held edit/author-admin deletion/moderation removal/file deletion409 without mutations, exact bytes/version history/lifecycle tokens, recovered deleted version quarantine/job reset and authorized release followed by permitted mutation. Three authenticated digest-mismatch envelopes(hold/files/scan jobs) must fail with complete exercise cleanup. Synthetic source relations/spool files and negative envelopes are removed; encrypted valid artifacts remain. Synthetic source S3 object bytes remain pending a future safe purge policy; this is not a permanent-deletion exercise.

Legacy1–5 parsing retains original scope; recorded old images are used for those archives, without migrating them or inferring new preservation guarantees. New drill verifies the archive's recorded0.1.51image; final deployment health is recorded separately. General seeded-channel download/revision fixture flags can be false when no such ready fixture exists; preservationApiVerified independently requires exact download/version checks on its private fixture. No region/WAL/RPO, production RTO, scheduled/offsite retention, key-rotation/restore or full compliance acceptance claim. Browser evidence from0.1.50 retains its scope; no UI change or new browser run here.

## Owner-reviewed message retention — release 0.1.52

In a standard/private/shared channel, a current workspace owner with channel access opens Conversation details → Message retention. Enable manual retention, choose1–3650days and save; policy starts disabled, and saving never expires anything. Age is creation time plus elapsed24-hour days; editing does not reset age. Preview uses the saved policy; save/refresh unsaved changes first. Each preview shows at most100oldest eligible messages, time span and whether more batches remain. Review the irreversible text-clear/retained-file-backup explanation and explicitly confirm. No scheduler/worker applies policy automatically.

Do not confirm if you need the original text available here: body is cleared and current app has no message-restore API. Existing tombstone references, parent links, attachment rows/files, reactions, saved/read positions, report notes, audit and backup copies are retained under their existing rules. This feature does not fulfill permanent-deletion obligations or delete binary bytes. Fresh preview is required for every batch. Preview expires after10min; changed message/policy/hold state or lost current owner/channel authority rejects application without partial effects. Holds block every batch, including on archived channels. Hold release does not implicitly execute retention.

Migration032 creates channel_message_retention and partial message-age index. Current version6 full dump captures new policy table, but selective manifests do not yet hash/independently verify that table and the0.1.51restore exercise predates this schema. No post-policy or post-retention restore/old-image compatibility claim is added. Preserve policy/age index on application rollback; prefer a forward fix. No automatic expiration, file policy, backup expiration, safe permanent purge, case administration or production lifecycle acceptance in this increment. Browser/integration fixtures use isolated synthetic organizations only; no real channel policy or message text is changed by acceptance tests.

## Retention-state and tombstone recovery — release 0.1.53

Coordinated backup now emits version7 with explicit retention policy, message attachment, reaction, saved-message and read-position counts/digests. Existing encryption/key separation, immutable image IDs, file integrity/lineage/lifecycle checks, version6 preservation and older metadata requirements/local bounds remain. Restore compares digests/graph before API fixture mutations. Missing/incomplete/invalid/count-mismatched version7 metadata fails before resource allocation; authenticated wrong digests fail after restore with exercise cleanup.

Run `ALLOW_LOCAL_BACKUP=true node scripts/test-retention-recovery.mjs` on the loopback development deployment. It creates only synthetic owner/member/private channels with applied/held/disabled/default policies and real-scanned S3 attachment. Snapshot already contains a reviewed text-cleared tombstone with removed mentions and retained references. Source fixture policy/hold/body/file state changes after snapshot; independent restore must retain original snapshot semantics. Verifier compares exact fixture records before login, then permits expected sign-in audit append and checks denied retention requests against a new baseline. It tests consumed-approval409/no duplicate effects, current owner/private ACL, held preview/apply, old hold-state approval rejection after release, fresh manual batch and save-without-execution. Wrong policy/attachment digests must fail with complete isolated cleanup. Source fixture DB/spool/negative envelopes cleaned, valid encrypted artifacts retained; synthetic source S3 bytes remain pending purge policy.

The existing preservation recovery drill emits/accepts version7 and keeps its file quarantine/scan-lease checks. Older1–6 format parsing retains prior required fields, with no new retention flags or automatic migrations. A real version6 archive restore was attempted in0.1.53 but failed because its recorded API image sha256:79bc16f158d80b0a03790d4918f14943bdec69470ca0e2901cc634203fec83e2 is absent locally; cleanup completed. Do not replace the recorded image with a newer tag or interpret parser tests as successful old-image recovery. Retain/export exact images with backup artifacts before claiming image recovery readiness. No registry/image-archive provision is implemented here.

No domain/UI change/new browser run in this increment;0.1.52browser evidence retains scope. These are bounded local snapshot/behavior drills, without production RTO/RPO, regional/WAL, scheduled/offsite backup/image retention, physical purge, old-schema migration or legal-compliance acceptance claims. General seeded-channel download/revision flags may remain false/empty when no eligible ready seeded fixture exists; retentionApiVerified separately requires exact private attachment download and policy/tombstone checks.

0.1.53 new-artifact availability protection: backup now creates concord-backup-api/postgres/objects:<artifactUUID> tags for the exact recorded IDs before publishing the encrypted artifact and returns them as imagePins. Keep these tags alongside their corresponding archive; ordinary release retagging no longer leaves these new image references dangling. The final drill verifies all3IDs, and post-release evidence checks pins still match after final rebuild. On publication failure cleanup is attempted for newly created tags only. No expiration is implemented. Tags alone do not survive explicit image removal/prune-all or machine loss; offline/registry image export and offsite retention remain open. They do not recover the already-missing version6 image.

## Portable runtime images — release 0.1.54

`ALLOW_LOCAL_BACKUP=true npm run backup:local` now publishes version8 main `core-<UUID>.jwe` plus encrypted `core-images-<UUID>.bin`. Keep both in the same directory; move the mode0600 key separately. API/Postgres/object images are captured by exact IDs and retain existing local image pins. Companion encryption/HKDF/AAD and authenticated descriptor prevent image import before verification. No image tar is buffered into the64MiB JSON envelope; encrypted companion has4GiB local ceiling. Allow disk for encrypted bundle plus a temporary decrypted tar during restore. Actual local bundle in this increment is575163428bytes(~549MiB); size/timing vary with images. No automatic artifact/pin/bundle expiration.

Restore with the existing command and main artifact path. Version8 checks companion even with cached images; missing IDs trigger authenticated Docker load, followed by exact-ID inspection. Decrypted tar exists only in a private temp directory and is unlinked on normal success/failure. Only after image preparation succeeds are temporary network/database/object volumes created. Legacy1–7 have no companion, so unavailable recorded images fail early before restore resources; do not substitute another image. The old missing version6 API image remains unrecoverable from its data artifact alone. Version7 original-image restore passed in0.1.54.

Run `ALLOW_LOCAL_BACKUP=true node scripts/test-image-recovery.mjs` locally. It creates synthetic private content and real scanned S3 file, makes genuine version8 backup, then creates a metadata-only disposable API derivative for a separate test envelope/bundle. Only the unused derivative is removed. Digest, symlink and valid-envelope/wrong-GCM-tag negatives must reject without importing it. Positive restore must load its exact missing ID, verify API version/snapshot message/file bytes/current tenant-policy permissions and preserve primary container IDs/images. Temporary decrypted dirs, disposable image/container and synthetic DB/spool/test envelopes/bundle are cleaned; genuine encrypted pair/pins retained. Source S3 fixture bytes retain existing no-purge lifetime. No real channel retention policy or primary image is removed.

This captures3images for existing API/core DB/file restore scope, not web/identity/scanner/email images, their external state, secrets provisioning or full ten-service topology. It is same-engine Linux-architecture image-import proof; no separate clean daemon/other host/architecture, offsite distribution, region/WAL/RPO, production RTO, key rotation or all-service recovery claim. Domain/UI behavior unchanged;0.1.52browser scope not rerun. New data backups cannot reconstruct runtime images already absent from older archives.

Release0.1.54 required a compatible repository checkout and host bind mounts for verifier helpers/config. Release0.1.55 adds a portable kit; release0.1.56 below removes those bind mounts. Image companions carry runtime images, not the host recovery tooling/configuration or separate identity/provider state. Preserve that tooling with deployment materials when planning another host.

## Portable recovery tooling — release 0.1.55

From the trusted checkout with installed pinned dependencies, export a kit for an existing authenticated backup:

```sh
mkdir -p .data/recovery-kits
ALLOW_LOCAL_BACKUP=true npm run recovery:kit -- .data/backups/core-UUID.jwe .data/recovery-kits/NEW_NAME
# Optional third argument: explicit backup key path.
```

Destination must not exist. Kit contains restore scripts/helpers, local-development S3 configuration and complete jose/zod package trees including licenses; no backup bytes, image bytes or key. Keep the encrypted main backup and its encrypted image companion together; transfer the kit separately with a trusted launcher checksum and protect the key through a separate channel. Kits are bound to the exact main artifact, not interchangeable across backups. Treat the kit as sensitive operational code/configuration even though the key is excluded. No expiry or automatic offsite copy is added.

Recovery requires Node24, Docker CLI and an accessible compatible Docker engine; no checkout, npm installation or package download:

```sh
ALLOW_LOCAL_BACKUP=true node /safe/kit/run-recovery-kit.mjs /safe/backups/core-UUID.jwe /separate/key/local-core.key
```

Trust and verify the launcher before invoking it. Export prints launcherSha256; deliver that value through a trusted channel independent of the kit. The launcher is the trust entry point and cannot authenticate itself. Release0.1.55 launcher SHA256: `29e8f2b2ae0a0331d935b0c9ed7031e44ef829f3c3a41e6c6b23d9847fca5305`. The authenticated manifest binds every packaged file's path/size/hash plus backup SHA256 using a domain-separated HMAC. No packaged code is loaded until authentication/integrity checks finish. Files are staged with private modes under OS temporary storage; staging is removed on normal completion/failure. Unsafe paths, duplicate entries and symlink files/parents reject; limits5000files/64MiB total/8MiB per file. The image companion is independently authenticated by existing restore tooling before image import or disposable resource creation. On interruption/power failure, inspect private temporary directories and exercise resources using existing restore cleanup guidance.

The command runs a disposable verification drill and cleans the restored environment; it does not promote a persistent replacement deployment. Existing explicit development opt-in, recorded immutable images, isolated internal network, metadata/byte checks and resource cleanup remain. `CONCORD_BACKUP_KEY_FILE` optionally supplies a key path to the direct restore CLI; the launcher supplies this from its required key argument.

Recorded kit is retained locally in ignored `.data/recovery-kits/0.1.55` (931 authenticated files, about6.4MB) bound to core-3884dd3c-88aa-4027-939b-a14c9eea8a9d. Two outside-checkout drills passed; second uses independently copied backup/image/key paths and cached runtime images. Copies of artifacts/key were removed after verification. This proves absence of checkout helper/package-install dependencies on the current host. It does not prove clean-engine, different-host/architecture, key loss, full ten-service restoration, offsite retention or production RPO/RTO. Generic drill's optional fixture/download authorization flags remain false; prior specific API fixture evidence retains its original scope.


## Docker-transferred recovery inputs — release 0.1.56

New restore tooling creates object-store/verifier containers stopped, copies small configuration/helper tar streams via Docker cp stdin and starts only after successful transfer. No daemon-host bind paths or host tar executable are required. Config is copied to /tmp/concord-s3.json; five verifier modules to /app. Each flat archive has at most8files/1MiB each/2MiB total, known names and root-owned0444 regular files. Target container names are restricted to this exercise's object/verifier namespace. Existing daemon-managed spool/object volumes, internal network, versioned data/image checks and cleanup remain. The verifier's final exit status is checked explicitly. Copy failure triggers cleanup of already-created containers/volumes/network.

Re-export a kit with current tooling using the0.1.55commands above. The launcher and its trusted SHA256 are unchanged; manifest/payload change and include restore-transfer.mjs. Kit .data/recovery-kits/0.1.56 contains932 authenticated files/6,411,739bytes and uses the same original core-3884dd3c encrypted pair/key. Earlier kits retain their original bind-based behavior; do not overwrite their authenticated manifests by hand.

Run the guarded local regression with an existing kit and matching backup:

```sh
ALLOW_LOCAL_BACKUP=true npm run test:transfer-recovery -- .data/recovery-kits/0.1.56 .data/backups/core-3884dd3c-88aa-4027-939b-a14c9eea8a9d.jwe
```

The guard forwards Docker commands to the existing engine but rejects any host bind mounts, injects failure at object-store and verifier transfers, then runs successful restore. All attempts compare primary container IDs/images and exercise/temp resource inventory before/after. Generic drill does not set optional API fixtures; separate transfer-retention-regression-0.1.56.txt proves retention/hold/permission/S3 behavior. Genuine new encrypted pair and3pins retained; synthetic source S3 bytes remain under existing no-purge lifetime. No host registry/daemon change or primary image removal.

A Docker context/DOCKER_HOST may choose the operator's trusted compatible engine; this change eliminates host path sharing, not TLS/connectivity/authorization requirements. Image load uses Docker CLI and transfers local archive bytes. Actual remote/clean daemon and cross-architecture recovery have not been exercised; current evidence uses cached images on the same local engine. Full ten-service topology/provider state/key delivery/offsite/RPO/RTO remain unfinished.

## Manual file retention — release 0.1.57

Migration033 adds separate channel_file_retention policy table/index. Deploy API/web/file-worker/reconciler/digest-worker together; startup migrates before readiness. Existing policies default disabled, and message-age policy stays independent. Owner with current channel ACL uses Conversation details → File retention to enable days1–3650, save, preview, review then explicitly confirm each batch. Save does not delete; no worker/scheduler expires files automatically. Refresh discards unsaved changes and approval; stale/error approval must be previewed again. Hold prevents apply, and hold on/off cycle invalidates earlier approval. Archived team channels can be reviewed/applied; recovery requires unarchived channel.

Age is newest creation time across original+all versions, including deleted versions, using elapsed24-hour days. A recent version protects the family. Soft-delete complete families only; oldest family first, at most100active file rows, stop before next family would exceed remaining capacity. Count/bytes preview is active logical data, not reclaimed physical disk. Original/version100cap prevents an ordinary family exceeding one batch. Fresh confirmation required for any remaining batch. Token10min expiry and full family snapshot invalidate newer versions/verdict/storage/deletion/recovery changes; current owner/access also rechecked.

Applying sets deleted, increments each active lifecycle revision, cancels jobs/leases and stops downloads. It preserves bytes in local/S3 and all file/history/attachment/message/audit/backup records. Existing uploader can recover original then individual versions through Files → Your deleted files, with current access/quota/fresh scan; owner cannot restore another uploader's file. Newest100 list cap unchanged; older entries may require known-ID API recovery; list pagination remains unfinished, especially if visible versions depend on an older original outside the list. Recovery does not reset age, and recovered old files may appear in another manual preview. Active hold still permits existing additive recovery rules, but blocks retention removal. No permanent purge/backup expiry is added.

Roll back application only if required while preserving new table; do not remove migration checksum/state or drop policy/history to reset revisions. Current v8 backup full pg_dump includes new table, but selective digests/API recovery have no independent file-policy/post-execution verification yet. Do not infer it from earlier message retention or file byte restore evidence. Keep this NFR/whole-lifecycle gate open.

Core113/113 and real Chrome owner/uploader flow verify held/stale/cancel/error, no automatic deletion, complete-family removal, actual ClamAV/S3 recovery, scoped axe and390px no overflow. Browser fixtures are synthetic and cleaned from DB/spool; S3 fixture bytes remain under existing no-purge policy. Production scheduling/store/replica/backup purge, case administration and regional recovery remain unfinished.

## Deleted-file recovery pagination — release 0.1.58

Files → Your deleted files → Refresh now loads the newest page of up to100 uploader-owned deleted files. Older deleted files and Newer deleted files navigate; Refresh returns to the newest page. Only one page of metadata is retained. If an original is older than100newer versions/files, browse Older until the original is available, recover/scan it, then return Newer to recover selected versions. Other uploaders' deleted files remain unavailable even to workspace owners.

Navigation cancels pending recovery confirmation. A page-load error preserves the current page for retry; refresh errors clear stale data. Recovery removes just that visible row and preserves cursor even if the recovered row was the page boundary. No need to recover unrelated visible files just to expose older originals. An empty page after recovery remains navigable. Browsing is live, so Refresh to see newly deleted files and recomputed newest boundaries after recovery. Current access/quota, original-before-version and fresh malware scanning still apply, including preservation and archived-channel behavior established previously.

API callers may use paired beforeCreated/beforeId from nextCursor; preserve6fractional timestamp digits and do not convert through JavaScript Date. Existing no-query response remains first100 with additive nextCursor; hasMore retained. Cursor is not authorization; each data query rechecks active membership/channel access/uploader. No schema/index migration or backup manifest change. Earlier0.1.49–0.1.57 newest100 limitation is resolved by current UI/API paging, while older deployed clients retain their original UI behavior until upgraded.

## File-retention state recovery — release 0.1.59

New local backup command emits version9 with file-policy count/SHA256 manifest in addition to existing image companion and metadata. Keep encrypted main/image pair and key separate; existing command/limits/modes remain. New fileRetention manifest hashes channel_file_retention in the shared exported snapshot. Restore authenticates/validates before resources, then compares policy digest/graph before API login mutations. Version1–8 restore skips this table and reports fileRetentionMetadataVerified=false/fileRetentionApiVerified=false; original image IDs still required.

Run local synthetic verification:

```sh
ALLOW_LOCAL_BACKUP=true npm run test:file-retention-recovery
```

It creates private channels for applied/held/disabled/default/private policy states, actual scanned S3 original/version families and retained attachment message. It applies one reviewed family, makes genuine encrypted snapshot/pins, then changes source policy/hold/body/recovery state. Isolated restore must retain snapshot and enforce consumed/held/current-owner/private rules, release-invalidated approval/fresh family execution and uploader recovery quarantine reset. Policy/file/job wrong-digest negatives must reject with complete cleanup. It does not alter a real source hold/policy or upgrade an archived app image. Fixture source organization/rows/spool/negative envelopes cleaned; valid encrypted pair/pins retained; source S3 objects retain existing no-purge lifetime.

The restored environment has API/Postgres/object-store images and no ClamAV service. Recovery verification deliberately leaves restored files quarantined with reset queued jobs and downloads409. No fabricated clean verdict or claimed actual fresh scan inside this drill. Retained bytes are verified directly and still-ready fixture files download through current recipient ACL. Actual new scan after recovery is covered separately by0.1.57–0.1.58browser evidence.

Re-export kits with current tooling so they carry file-retention-backup.mjs. Current .data/recovery-kits/0.1.59 has933 authenticated files/6,421,565bytes bound to core-ccaa71c6-cb62-41e6-96fd-8cf6a3208591. Launcher checksum unchanged. No-bind kit drill verifies version9 policy metadata and both transfer-failure cleanups. Run inventory-sensitive restore drills sequentially: the guard compares all concord-restore-* resources, so concurrent exercises intentionally fail its unchanged-inventory assertion. Initial overlap failure retained in evidence; isolated rerun passes. Generic kit does not enable optional API fixture flag; specific direct file-retention drill provides that API evidence.

Genuine earlier version8 core-3884dd3c archive restore with original images passes without new file-policy claims. Updated image recovery regression uses runtime health release rather than an obsolete hardcoded version and current envelope9, retaining the same disposable-only missing-image test. No new UI/schema, auto schedule/permanent purge/offsite/key distribution/all-service/remote-clean-engine/production RPO/RTO proof.

## Captured scanner and fresh restored recovery — release 0.1.60

New backup command now emits version10 with4runtime images: API/Postgres/object-store plus an artifact-owned scanner image containing current definition files. Local capture reads running concord-collaboration-clamav-1 immutable image and allowlisted /var/lib/clamav files; original definition volume is never mounted into the capture container or modified. Baked-in definitions are removed only in a disposable network-disabled container, followed by copied definitions and a commit with clamd entrypoint/config. Private staging/capture container/temporary image tag cleaned, concord-backup-scanner:<artifactUUID> pin retained after success. Publication failures remove new pins/companion; capture failure publishes no backup. It adds local disk/definition-file copy work, not a new recurring backup schedule.

Bounds:3required main/daily/bytecode .cvd/.cld files plus permitted versioned .sign companions; at most16files,128MiB per file,256MiB combined. Each file name/size/hash/source image/capture time is authenticated in main envelope. Scanner image joins existing4GiB encrypted companion under four-image AAD; old three-image AAD is preserved. Definition capture is separate operational state before database snapshot, not an atomic scanner/provider/database snapshot.

Restore starts captured ClamD on private internal network with no host ports,4GiB memory/2CPU limit and no FreshClam/network download. Allow startup resources/time in the Docker VM (local engine uses amd64 emulation for scanner). File set/size/SHA must match capture. Actual application probe and clean/EICAR checks require streaming protocol and existing signature freshness (7days maximum, future metadata rejected). Successful backup publication is not a promise that old definitions will remain fresh indefinitely. Expired definitions fail closed; release0.1.61 adds the explicit trusted local scanner refresh workflow below. Never bypass the gate or inject a clean verdict to meet recovery tests.

Run the complete file-retention drill to exercise actual post-restore scanning:

```sh
ALLOW_LOCAL_BACKUP=true npm run test:file-retention-recovery
```

It restores original/version to quarantine first, validates reset jobs and denied downloads, then processes fixture jobs with existing real scanner path and verifies fresh verdicts/authorized retained bytes/attachment links. scannerVerified and fileRetentionFreshScanVerified must be true. Generic restore does not run arbitrary queued jobs; its fresh-file fixture flag staysfalse even when scanner probe passes. Definition manifests and scanner health checks do not substitute for a file recovery fixture.

For the authenticated existing pair, run scanner tamper/capture/missing-image checks sequentially:

```sh
ALLOW_LOCAL_BACKUP=true npm run test:scanner-recovery -- .data/backups/core-5a83ec72-82c1-4965-9b29-e19096b154c9.jwe
```

This rejects changed definition hash/set and scanner-image AAD binding, injects capture commit failure and checks no publication/staging/capture/source changes, then exports a separate bundle for a metadata-only disposable scanner derivative, removes only that unused derivative and imports its exact ID through restore. Primary scanner/API/Postgres/object IDs/images unchanged; genuine captured scanner pin/image retained. Test derivative/image/envelopes/bundle removed. It is one missing image configuration on same engine with layers cached, not an empty engine or another host.

Re-export current recovery kit so scanner-contract/capture-scanner helpers are included. .data/recovery-kits/0.1.60 has935authenticated files/6,429,665bytes, unchanged trusted launcher SHA, key excluded, bound to genuine5a83ec72 pair. No-bind kit/transfer-failure drill passes real scanner probes with117files; it does not enable optional file fixture. Legacy9ccaa71c6 archive passes without creating scanner/new scan claims. Actual fixture backup uses running0.1.59API; deployment0.1.60 changes host tooling/version metadata, no domain/UI/schema.

Four images do not capture all10services/provider/secrets/identity/email state, supply offsite/key custody, solve cross-architecture or clean-engine recovery, or meet production RPO/RTO. Source real S3 fixture objects and valid encrypted pairs/pins retain existing no-purge lifetime. Current definition image data is retained with backup; automatic expiry/rotation/scheduling remains unfinished.


## Scanner-only backup refresh — release 0.1.61

Ordinary backups remain version10. To refresh scanner definitions for an existing version10/11 pair, keep its companion adjacent and use the same private32-byte key:

```sh
ALLOW_LOCAL_BACKUP=true npm run backup:refresh-scanner -- .data/backups/core-5a83ec72-82c1-4965-9b29-e19096b154c9.jwe
# Optional explicit key path is the second argument; otherwise CONCORD_BACKUP_KEY_FILE or local-core.key.
```

The tool authenticates the parent/origin/companion and imports exact recorded image IDs if needed. It never starts the parent scanner, so parent definition freshness is not a prerequisite. It captures only the existing trusted local concord-collaboration-clamav-1 scanner; keep that scanner healthy with fresh definitions through the existing local update process. No arbitrary image/URL or definition download option is added. API/Postgres/object image IDs, snapshot time, dump, file bytes/metadata/counts and every inherited manifest stay equal to the embedded original. No original pair or live service is overwritten/restarted.

Output is a new version11 core-UUID.jwe plus core-images-UUID.bin and4pins beside the input. Before exclusive main publication, a private candidate must pass full isolated restore, origin comparison, all117 current fixture bytes/metadata, real clean/EICAR probes and teardown. Candidate validation failure removes new candidate/companion/pins/capture resources. The scanner must pass the unchanged7-day/future-date gate; freshness failure never produces an approved refreshed pair. Definition capture can race normal updates, in which case integrity/probe checks fail safely. Allow normal scanner4GiB/2CPU restore resources and approximately another808MiB companion for this fixture. Keep all genuine pairs/pins under existing no-purge lifetime; no automatic deletion or scheduling is introduced.

Version11 embeds the original encrypted version10 envelope, requiring the same key. Repeated refresh preserves that origin without nested growth; immediate-parent hash/previous scanner ID are audit references, not a verified complete intermediate chain. Restore no longer needs original companion when the new pair is complete. Embedded origin counts toward64MiB plaintext/128MiB encrypted bounds, so a near-limit backup can be too large to refresh; key rotation is not supported by this workflow.

Sequential regression commands (do not overlap restore inventory tests):

```sh
ALLOW_LOCAL_BACKUP=true npm run test:scanner-refresh -- .data/backups/core-5a83ec72-82c1-4965-9b29-e19096b154c9.jwe .data/backups/core-4a02f12b-99d2-4445-93c3-9713b8db7ef8.jwe
ALLOW_LOCAL_BACKUP=true npm run recovery:kit -- .data/backups/core-5908c1e9-ef48-48e1-a3ed-2cc30f5b126d.jwe NEW_PRIVATE_KIT_DIRECTORY
```

The second command requires a nonexistent destination. Retained .data/recovery-kits/0.1.61 is already bound to5908c1e9;937files/6,433,097bytes, key excluded, trusted launcher SHA unchanged. It passes outside-checkout/no-bind recovery and both transfer-failure cleanups. Original5a83ec72 still restores as version10 with scannerRefreshVerified=false; version11 reports true only after origin/data comparison before Docker. Generic fileRetentionFreshScanVerified staysfalse; no optional file recovery fixture was requested in these refresh drills.

Available parent/current definitions were both dated2026-10-17 and fresh during testing. Parent scanner startup was forbidden by a Docker guard, but no naturally expired parent was exercised. Existing stale/future/protocol tests remain enforced. Same-engine local verification does not establish offsite, all-service, clean-engine, cross-architecture, key-distribution or production RPO/RTO acceptance.


## Backup pair preflight — release 0.1.62

On a trusted checkout with Node24 and installed dependencies, check stored backup bytes before provisioning or contacting Docker:

```sh
ALLOW_LOCAL_BACKUP=true npm run backup:verify -- .data/backups/core-5908c1e9-ef48-48e1-a3ed-2cc30f5b126d.jwe
# Optional second argument: private32-byte key path.
```

Keep companion adjacent to main. The command performs bounded private main/key reads, authenticated decryption/schema/file/dump integrity, embedded origin comparison for11, then streams the complete encrypted companion through SHA/header/key derivation/AAD/GCM verification into a discard sink. Main/key must be regular non-symlink files with no group/other permissions. No file write, Docker call, image import or plaintext staging. Output contains minimized integrity counts and explicit restoreVerified=false/scannerRuntimeVerified=false. Versions1–7 have no portable companion and report imageArchiveVerified=false; successful envelope verification does not manufacture a portable-image claim.

Use the result to detect wrong keys, missing/corrupt/mismatched companions and changed refresh origins early. A valid authenticated byte stream need not be an importable Docker tar or restorable database, and this tool cannot establish scanner freshness, current permissions/API behavior or recovery objectives. Continue with the existing full restore drill. Tooling requires trusted source/Node dependencies; the portable kit still exposes its existing authenticated restore launcher, not a new preflight entry point.

Shared restore authentication now discards companion plaintext when all exact recorded images are cached. Missing IDs still require private temporary tar space for Docker import and full authentication before load, with cleanup afterward. A cached-image restore passed with TMPDIR=/dev/null (preflight-cached-no-staging-0.1.62.txt); this does not remove kit staging requirements or Docker VM storage requirements. Missing-image restore still stages/authenticates/imports exact ID as independently tested.

Run actual-pair checks without Docker or usable temporary staging (test harness supplies guards):

```sh
ALLOW_LOCAL_BACKUP=true npm run test:backup-preflight -- .data/backups/core-5a83ec72-82c1-4965-9b29-e19096b154c9.jwe .data/backups/core-5908c1e9-ef48-48e1-a3ed-2cc30f5b126d.jwe .data/backups/core-ccaa71c6-cb62-41e6-96fd-8cf6a3208591.jwe
```

Version10/11/9 pairs each verify117file entries/297,779payload bytes. Docker calls zero, invalid staging path tolerated, original main/companion hashes unchanged; valid-envelope wrong scanner-role binding rejects. Unit cases include both three/four-image protocols, recomputed-digest corruption/tag/header/truncation/key/binding failures, symlink/type/privacy/oversize rejection and legacy1 false scope. Existing real scanner tamper/capture failure/missing exact-image import and no-bind kit regressions also pass. No fixture source data was added. .data/recovery-kits/0.1.62 binds existing5908c1e9 pair:937files/6,433,508bytes, key excluded, trusted launcher SHA unchanged. Ordinary backups stay10, refreshed backups11; no new schedule, retention deletion or key rotation.


## Conversation file paging — release 0.1.63

No migration or provider setting. Files tab now reaches originals older than100 through Older files/Newer files. Refresh files and a successful new upload return to newest; deletion/retry/recovery reload current page, while scan-status polling follows that page. Lists are live and may shift under concurrent uploads/deletions. Versions remain separately listed through Versions, max100 per family. The existing files_retention_roots partial index supports backward tuple traversal.

Run `npm test` plus `TEST_SCANNING=true npx playwright test tests/browser/file-pages.spec.ts tests/browser/file-recovery.spec.ts tests/browser/file-recovery-pages.spec.ts tests/browser/file-scanning.spec.ts --project=chrome` against the complete local stack. New fixture uses real scanned S3 original/version/new upload and101 synthetic metadata-only quarantined originals without jobs/bytes. Synthetic rows test list traversal/status display only; no synthetic verdict is claimed as malware evidence. Fixture SQL/spool is cleaned; real source S3 bytes retain existing no-purge lifetime.

At this turn's start, the engine had no containers or images while all project named data volumes remained. Initial database-dependent tests failed ECONNREFUSED (core-tests-stack-unavailable-0.1.63.txt); no product failure was inferred. Restarted PostgreSQL on its existing volume, rebuilt application/scanner images, pulled configured providers and recreated the loopback stack without resetting data. Restart evidence restart-database/build/deploy-0.1.63.txt. Historical backup image pins were absent with the emptied engine cache; encrypted original companions remain on disk as their portable image recovery source. No primary data restore or image substitution was performed, and no new offsite/clean-engine DR acceptance is claimed.

After digest-only provider pulls on an emptied engine, the current release recorder also requires the local chrislusf/seaweedfs:4.48 and axllent/mailpit:v1.31.5 aliases. Recreate each alias with docker image tag using the exact corresponding Compose-pinned digest reference, then rerun the recorder. Do not retag an unrelated running image to satisfy a health check. Release0.1.63 restored these aliases without changing running image IDs; initial refusal evidence release-health-missing-alias-0.1.63.txt retained.


## Filename search — release 0.1.64

Submit the top-bar workspace search, then choose Files in Search type. Search conversation optionally narrows to a currently accessible conversation. Filename matching ignores case and treats percent/underscore literally. Only original filenames are searched, with no file-content/people/team/meeting search. Ready files have Download links; quarantined/rejected files do not. Open files selects the source conversation's Files tab and preserves the current draft through existing navigation save logic. Browse Older files there for originals beyond the newest100.

At most50 results per page; release0.1.65 adds Older/Newer matches navigation. Search refreshes current access/results every5seconds, withdraws data on failure and provides Retry search. A new submission resets filters and cancels the preceding request; changing workspace/closing search cancels it too. This is local live-query behavior, not a production disclosure-latency guarantee or search snapshot.

No migration/provider setup. Verify with npm test and the file-search/file-pages Chrome specs against the complete local stack. Search fixture uses real scanned S3 original/version/Beta file, plus metadata-only quarantined entries without jobs or stored bytes for bounds/non-ready/hidden-scope checks. No fabricated scan verdict qualifies as malware evidence. Cleanup removes fixture SQL/spool; real source S3 bytes retain existing no-purge lifetime. No change to backup formats, deletion schedules, key custody or enterprise search service deployment.


## Search result paging — release 0.1.65

No migration or provider setting. Submit message/filename search, then use Older matches/Newer matches. Each page is at most50 results, newest first; current entity/conversation filters stay applied. Refresh matches returns to newest. New submission/entity/conversation/workspace starts a new page history. Polling refreshes the current cursor rather than jumping to newest, and an emptied older page still permits Newer/Refresh navigation. Listings are live, not a snapshot or a total-count estimate.

Transient older/newer navigation failure keeps the last successful page; Retry search repeats the attempted target. Current-page refresh/poll failure or access denial removes cached results until a successful check. All pages and file download links continue to require current server permissions. Since0.1.66, message results open the exact read-only dialog below. File source buttons still open conversation context without focusing a particular old file. Filename search remains original-name matching only, not file-content search.

Run npm test and the search-pages/file-search Chrome specs against the complete local stack. The new paging fixture uses one real scanned S3 original for older-page download plus metadata-only quarantined files without jobs/bytes and directly inserted message rows to exercise result boundaries. Those synthetic rows verify query/list behavior only. Fixture SQL/spool is removed, while real source S3 bytes retain existing no-purge lifetime. No new independent backup, scheduling, retention purge or production indexing/latency acceptance.


## Exact message links — release 0.1.66

Click a message search result to inspect that exact current message, even when it is older than the latest50 conversation messages. Linked message shows author/time/text/format/mentions and current attachment availability. It is read-only, not a thread-context window or main-timeline anchor. Closing returns to the current search page; Open conversation uses normal draft-save-before-navigation. If saving fails, keep the draft and retry; closing cancels a pending navigation.

Existing copied links with /?org=...&channel=...#message-... now open this view after sign-in. Hash changes are handled; closing removes its matching hash. Link IDs never grant access. Current permissions/content are polled; failure/deletion/revocation withdraws displayed data. Non-ready/deleted attachments lose names/links, with current server checks on every download. Invalid or ambiguous links are ignored, and inaccessible workspace selection retains the existing sign-in/workspace behavior.

No migration/provider configuration. Verify npm test and linked-message/file-search/search-pages Chrome specs. New fixture uses one actual ClamAV/S3 upload/attachment, real target message and120 directly inserted newer message rows (with channel sequence maintained) to prove exact old-source lookup beyond newest50. Clipboard write is stubbed in-browser to validate generated link without reading/changing the user's system clipboard; native OS clipboard permission/delivery is not newly accepted. Fixture SQL/spool cleaned; real source S3 bytes retain no-purge lifetime. Existing scopes/download/draft/retention/backup contracts remain in effect.

0.1.67-local adds exact original-file source viewing from filename search. View file retains the current conversation/search/draft; existing Open files navigation is unchanged. Details poll current metadata/access every5s with8s timeout and disappear on error/deletion/revocation; Retry file fetches again. Ready-only download remains independently checked server-side. File revisions/deleted originals are unavailable through this endpoint. No migration/new index/backup format, scanner bypass, destructive purge or service topology change.

0.1.68-local: Copy file link creates an original-file source URL usable after sign-in and reload. Recipients require current workspace/conversation access; possession of URL grants no rights. Deleted originals/revisions stay unavailable, ready-only downloads keep current independent scan/integrity checks. File and message hash targets select one source view at a time, invalid targets show no cached content, closing clears only matching hash. Browser clipboard handlers are stubbed for synthetic URLs; tests never inspect or alter the user's OS clipboard. No migration, provider, recovery or purge change.

0.1.69-local lets users inspect source text directly in exact original-file views from search or copied links. Preview selected file is available for ready TXT/MD/CSV, with an explicit Hide file preview control. Text remains literal and bounded; preview errors/hidden document/access loss withdraw cached text, and metadata failure closes inline preview. Existing normal Files preview uses the same lifecycle. Downloads/copy links retain existing checks; no new provider, scanner bypass, migration, backup format or purge operation.

0.1.70-local exposes existing version history inline in selected-file views from search or file links. Each ready revision downloads separately; the source URL/original preview/download continues to select original bytes. Only original uploader sees Upload new version based on current server canUpload; API independently enforces that restriction. Hide versions closes the history request scope; errors/revocation/deletion withdraw history. Normal Files Versions dialog shares the same validated/abortable lifecycle and upload retry behavior. No migration, backup/recovery format, purge, provider or editor change.

0.1.71-local adds Saved in main navigation. Collection is personal and current-workspace scoped; inaccessible/deleted messages disappear on next refresh, stored saved references alone grant no access. Up to50per page ordered by message creation time (save time is not stored); excerpts are literal and limited500characters. Open saved message shows exact current content while retaining draft/conversation; Unsave removes only current user's bookmark through existing API. Polling failures clear content; Retry saved messages reloads current/attempted page, Refresh newest. No migration, provider, backup-format, purge or mark-unread change.

0.1.72-local: Save/Unsave is available directly in linked message source dialogs opened from search/Saved/copied links. Personal Saved collection follows changes on next refresh; dialog shows current personal state after reload and reconciles external changes by polling. Write failures show an explicit error without claiming success; access-denial failures withdraw source. Read requests from before the action are fenced, and closing/scope exit suppresses late UI callbacks. Existing save endpoint now rejects deleted targets and unknown fields/query in a transaction with current authorization; no migration, provider, backup format, purge or mark-unread change.

0.1.73-local adds Mark unread from here in exact-message dialogs opened from search/Saved/copied links. Your existing read position rewinds to before that message only when currently later; already-earlier/absent positions stay unchanged. Current channel counts/activity and existing read receipts use that same position. This affects receipts, unlike a separate private follow-up flag. It preserves the source and draft; reopen/reload does not auto-read. Mark as read in conversation explicitly clears unread again. If only badge refresh fails, Refresh unread count retries that read without another mutation. Deleted/inaccessible targets fail closed. No schema/migration, new event/backup format, purge/provider or automatic marking change.

0.1.74-local: Hide conversation in details removes it from your personal sidebar while leaving the current conversation and draft open. Hidden conversations in sidebar lists only currently accessible hidden entries; Open conversation retains hidden status and saves current draft before navigation, Show in list restores listing. Hide/Show preserves pin/mute flags and does not revoke membership, mute notifications, delete messages or alter read position. Other users' lists are unchanged. Dialog refresh failures withdraw stale rows/retry; failed navigation preserves draft. Preferences now accept strict nonempty partial updates, keeping unspecified fields; no migration, backup-format, provider or purge change. Hidden collection uses current existing bootstrap without new pagination/large-workspace acceptance.


0.1.75-local adds literal last-message snippets beneath sidebar conversation names, including pinned rows. Refresh conversations fetches current authorized names/preferences/counts/previews with8s timeout; failed refresh withdraws snippets and shows a retry notice. It does not open/read conversations or alter the current draft. Snippets show up to100characters without rendering Markdown/links; empty conversations have none. Latest nondeleted message edits/deletion appear on refresh, access revocation removes the row. Automatic refresh remains20s; no preview privacy preference, instant cross-conversation delivery, bootstrap pagination or production acceptance is added.

Mobile sidebar includes Close conversations inside the open panel; external toggle exposes expanded state and controlled sidebar ID. This restores a direct close action when the panel covers the external toggle.


0.1.76-local: Show conversations offers All/Unread/Pinned/Muted, combined with Filter conversations by name. A hidden conversation remains excluded until Show in list through Hidden conversations. Filtering the active conversation out leaves its content/draft open. No matching conversations offers Clear conversation filters; clearing resets both controls. Filters are temporary and reset after reload or workspace/account change. Muting does not mark messages read; explicit Mark as read clears unread normally. Existing20s/manual refresh reconciles flags/counts/current access, failed refresh retains prior navigation metadata and withdraws previews. No migration, provider, backup-format, purge or production acceptance expansion.


0.1.77-local adds View replied-to message to exact source dialogs for replies opened from Saved/search/copied links. It shows the direct parent inline with current permissions, including older parents beyond recent history. Hide replied-to message stops that content fetch; parent failures/deletion withdraw parent content with its own retry while authorized selected reply stays open. Source failure/closing/scope exit closes context. Selected reply Save/Unread/Copy/Open actions remain selected-reply actions. No read marking/draft/navigation/schema/backup change; no full thread/ancestor traversal or production acceptance.


0.1.78-local: View replied-to message beside a timeline reply opens the existing Linked message dialog for its parent, including parents outside loaded history. Closing returns to unchanged conversation and draft. Save/Unsave/Mark unread/Copy actions belong to the selected parent. Missing/deleted/inaccessible parents show the normal error/retry and never cached body. Deleted replies have no source action. No API/schema/migration/provider/backup/purge change or full thread/production acceptance.


0.1.79-local: Settings → Workspace presence lets you choose Available/Busy/Do not disturb/Away/Offline for15minutes–8hours in the selected workspace. Current workspace presence is fetched independently and refreshed5s/manually; unsent dropdown choice is kept until navigation/reload. Existing20s heartbeat preserves override. After expiry you appear Available while connected; over60s without a heartbeat you appear Offline even with an active override. Another workspace/user is unchanged. Failed reads withdraw current status; Refresh presence retries without another mutation, including accepted write with failed confirmation. DND changes displayed presence only; notifications have separate preferences. No new API/schema/backup/provider/purge or full presence/production acceptance.


0.1.80-local: Workspace presence now shows the active override state and expiry time, or Automatic presence is active. Return to automatic presence clears your current override only in the selected workspace. It preserves heartbeat timing; an already disconnected user remains Offline until heartbeat resumes. Current/expiry data comes from a bounded own-state GET, not the full workspace bootstrap. If clearing succeeds but confirmation fails, the acknowledgement remains and Refresh presence retries only the read. Failed clear keeps the prior authorized override visible and reports error. Unsent dropdown choice is retained and does not become current until Set presence. Expired overrides reconcile on5s/manual refresh, no countdown or full activity aggregation. New GET/DELETE need no migration/schema/index/event/backup-format/purge/provider change.


0.1.81-local: Profile indicator shows Available/Busy/Do not disturb/Away/Offline from the same verified own presence snapshot as Settings. Text accompanies dot color; failed current refresh shows Presence unavailable, initial/scope-changing reads show Checking presence. Open profile settings → Refresh presence retries. Set/reset confirmation and current expiry update header and Settings together; existing5s refresh reconciles external changes/expiry. Presence polling continues across views, with one own-state read stream; scope exit aborts old read/write and hides old status. Unrelated unsent profile fields stay mounted on workspace changes. No new API/schema/backup/provider/purge or calendar/notification policy change; full presence/production acceptance remains open.


0.1.82-local: Clicking a mention/reply browser alert opens its exact current message in a separate tab, including messages beyond recent history. Existing login and permissions apply again; deleted/inaccessible content is unavailable, not restored from alert text. Original tab/draft stays open and source reads do not mark messages read. Alerts still show only workspace/channel/type, no message body. Closed/expired/previous-scope handlers cannot activate later. Preferences/permission/quiet/mute/hide/durable dedup unchanged. Malformed claims or construction failure fall back to Activity; claims are not undone/replayed. This does not add closed-tab/mobile push, native OS toast visibility evidence or invitation/call delivery.


0.1.83-local: Activity → View message opens the exact selected source while leaving conversation/draft/filter intact, even outside recent timeline history. Open conversation retains draft-save behavior; failed save stays in Activity with draft kept, leaving Activity cancels late navigation. Refresh activity retries failed current reads; rows withdraw on failure and loading/errors do not claim caught-up. Unread/mentions/replies semantics unchanged (mentions/replies may remain after explicit Mark as read), latest50 matching results only. Filter stays when returning from Chat, resets unread on workspace/account exit. Source reads/actions independently recheck current permissions/deletion; no API/schema/backup/provider/purge or full feed paging/production expansion.


0.1.84-local: Activity Older/Newer controls navigate up to50 matching messages per page. Refresh activity returns newest; selecting another filter or re-entering Activity resets page history. Polling refreshes the current page boundary. Transient page-navigation failure retains the last confirmed page and Retry activity retries the attempted target; current-read/access failure withdraws rows. Empty older pages offer navigation rather than claiming caught-up. No migration, provider/storage/backup-format change.
