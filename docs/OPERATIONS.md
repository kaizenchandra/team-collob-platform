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

Release label `0.1.11-local`, image digests and actual verification recorded in `evidence/release.json`. Tags are convenience references; promote by immutable image digest. Build context excludes secrets, .git, local data and browser output. Do not rebuild an old tag and assume it identifies identical code.

For a local rollback, retain previous image IDs with `docker image tag <image-id> concord-web:rollback` and equivalent API; update an override to those immutable images and `compose up -d --no-build`. Migrations are forward-only and checksum-verified. Migrations001–011 are forward-only; assess the specific schema compatibility before rollback. An app rollback is valid only while its database contract is compatible. Do not delete migration records or apply a destructive down migration. Use a forward-fix for incompatible schemas; restore an isolated verified backup before traffic cutover if necessary, then reconcile outbox/idempotency records.

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
