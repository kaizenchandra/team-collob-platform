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
