# Collaboration platform architecture — ADR baseline 2026-10-12

Status: design approved for first implementation increment by the execution rules in the specification. This is not release verification. Primary register: `requirements.json`; generated human matrix: `TRACEABILITY.md`. All 146 primary requirements are required: the two integration requirements have mandatory providers even though marketplaces are optional. GIFs/stickers, general whiteboards/polls, broader tasks, directory sync, advanced discovery and marketplace remain optional subfeatures, not removed primary IDs.

## Discovery and constraints

Repository is a Next.js 16.4.0 / React 19.3.0 App Router starter, TypeScript strict. Unrelated `.idea` files are preserved. Node 24.19.0, Java 21, Go and Python are installed. Docker engine 29.4 is reachable with sandbox escalation. No external deployment target or provider configuration has been supplied. Local Docker staging incurs no new cloud resources. Sites hosting was assessed but its Worker/Vinext runtime is not chosen because the specification requires Next.js and persistent backend connections.

Read installed Next guides for installation, layouts, server/client components, route handlers, caching, and deployment. Keep existing framework pins and lockfile. Official compatibility: [Next 16](https://nextjs.org/docs/app/guides/upgrading/version-16) requires Node >=20.9; [Node release policy](https://github.com/nodejs/Release) identifies 24 as LTS; [PostgreSQL support](https://www.postgresql.org/support/versioning/) uses five-year major support. Registry versions selected at implementation are pinned, including transitive lockfile. Local build/test evidence, rather than version numbers alone, establishes compatibility. Security audit remains required before release.

## ADR-001: modular TypeScript core

| Service / context | Runtime and data ownership | Alternatives evaluated | Reason / interface / scaling / extraction trigger |
|---|---|---|---|
| Web | Next.js/React/TS, owns no authoritative records | Other frontend excluded | SSR shell, client workspace/media; direct same-origin `/v1` via ingress, no business rules in Next. Stateless replicas |
| Core | Node 24/TypeScript/Fastify; identity/membership, collaboration, messages, calendar/work/governance schemas in PostgreSQL 17 | Spring Boot/Java 21: excellent complex transactions, more JVM/tooling overhead for first increment. Go: efficient concurrency, higher cost for rich domain validation. Python: no ecosystem advantage for this transactional core | One deployment, strict validation, SQL transactions and shared contracts; REST v1 + SSE. Scale stateless API; extract real-time only on measured connection or GC pressure |
| Durable worker | Same Node codebase, outbox/jobs tables owned by core | Dedicated queue initially unnecessary | PostgreSQL leases/SKIP LOCKED, bounded retries and DLQ. Independent process when processing load requires it; no other service writes core tables |
| Media | Mature LiveKit SFU (Go upstream), external provider boundary; owns transient media rooms | Custom Go media server rejected; managed provider possible | Browser connects directly using short-lived server-authorized room grants; TURN/SFU scale independently. No media through Next/API |
| Documents | Provider-owned collaborative document engine (Collabora/OnlyOffice candidate) | Node/Yjs when restricted native text documents suffice | Provider session/version contract; no direct core-table writes. Provider selection/live verification unresolved |
| Processing | Initially provider adapters + Node workers; Python only when extraction/transcription libraries justify a separate worker | Java/Go possible but no current library advantage | Signed object references/events; worker reports results via API, not cross-service SQL |
| Telephony | SIP/PSTN provider integration boundary | Browser-only simulation rejected | Requires real trunk/numbers/billing/region and live calls. No approved chargeable resources |

No redundant Redis, Kafka or search cluster initially. PostgreSQL full-text search with authoritative ACL joins; dedicated search only after measured need. S3-compatible object storage for binary files/recordings; database owns ACL and metadata. Ephemeral presence expires; durable replay uses outbox. Development infrastructure can use filesystem/object adapters but must never claim production object durability from them.

## Context/container/deployment

```mermaid
flowchart LR
 U[Members and guests] --> W[Next.js browser / SSR]
 W -->|HTTPS REST and SSE| I[Ingress]
 I --> N[Next.js stateless]
 I --> C[Node modular core]
 C --> P[(PostgreSQL)]
 C --> O[(Object storage)]
 J[Worker] --> P
 J --> E[Email / calendar / scanner / editor]
 C --> ID[OIDC identity provider]
 W -->|WebRTC direct| M[LiveKit SFU / TURN]
 C -->|Scoped grants| M
 C --> OBS[Logs metrics traces]
```

Local staging: loopback ports web 3100/API 4100/Postgres 55432. Compose dedicated project/network/volumes, never touch other projects. Deployment target: TLS ingress + web/core/worker containers, managed replicated PostgreSQL, encrypted object storage, separately routable UDP/TCP media. At least two API instances and synchronous replica needed before durability/availability sign-off. No production deployment until all required gates, target authorization, TLS and secrets are available.

## Roles and permission matrix

Identity is global; organization membership is independent and active/revoked. Tenant roles: owner/admin/member/guest. Team membership determines standard channel access. Private/shared channels use explicit channel members. Same-tenant shared channels initially; external tenant membership requires explicit guest representation and policy, never trusting a foreign tenant claim. Direct/group conversations use explicit participants. Removing membership removes current history access; already downloaded plaintext is unrecoverable.

| Action | Owner/admin | Team owner | Member | Guest |
|---|---|---|---|---|
| Tenant settings/roles/audit/export | Yes scoped tenant | No | No | No |
| Team lifecycle/member administration | Yes | Own team | Create/join public/leave subject to last owner | Invite-only |
| Read standard channel | Must be team member | Own team | Team member | Team member |
| Read private/shared channel | Explicit member required; admin has no implicit content access | Explicit member | Explicit member | Explicit member + policy |
| Change channel type/team | Tenant admin + channel access | Own team + channel access | No | No |
| Message/file/task/forms | Authorized resource member | Same | Same | Same except policy-limited file mutation |
| Edit/delete message | Own; moderator delete policy | Moderator in scope | Own | Own |
| Meeting control | Organizer/assigned role, not tenant admin by default | Same | Assigned role | Assigned role |

Every request/subscription/send rechecks membership in the authoritative database. Resource IDs never confer access. Unknown/denied resources yield indistinguishable 404. Tenant queries use membership-derived scope and parameterized SQL. Cross-table composite FKs prevent cross-tenant attachments/threads. Mutation authorization and writes share resource locks to avoid revocation races. Account closure revokes sessions. No shared tenant-sensitive Next cache; all private responses `no-store`.

## Entities and boundaries

```mermaid
erDiagram
 USER ||--o{ MEMBERSHIP : has
 ORGANIZATION ||--o{ MEMBERSHIP : contains
 ORGANIZATION ||--o{ TEAM : contains
 TEAM ||--o{ TEAM_MEMBER : grants
 TEAM ||--o{ CHANNEL : contains
 CHANNEL ||--o{ CHANNEL_MEMBER : grants
 CHANNEL ||--o{ MESSAGE : orders
 USER ||--o{ MESSAGE : authors
 MESSAGE ||--o{ REACTION : receives
 CHANNEL ||--o{ READ_POSITION : tracks
 CHANNEL ||--o{ FILE_VERSION : protects
 CHANNEL ||--o{ TASK : organizes
 CHANNEL ||--o{ FORM : collects
 ORGANIZATION ||--o{ MEETING : schedules
 ORGANIZATION ||--o{ AUDIT : records
 MESSAGE ||--o{ OUTBOX : emits
```

Conversations and channels may share a stream record but retain distinct kind/membership semantics. IDs UUID, sequence allocated under stream lock, UTC timestamps and IANA timezone on meetings. Tenant/resource ACL is the common authority for search/files/work. SQL migrations are ordered, checksum-recorded and transactional. Expand/contract, never destructive downgrade in routine rollback.

## API and event drafts

REST `/v1`: `/session`, `/organizations`, `/organizations/:id/bootstrap`, `/teams`, `/channels`, `/channels/:id/messages?before=seq&limit=50`, `/channels/:id/read`, `/channels/:id/events?after=cursor`, `/search`, `/files`, `/tasks`, `/forms`, `/meetings`, `/policies`, `/audit`, `/exports`, `/migrations/preview` and `/migrations/:id`. Schemas validate IDs/enums/body bounds; conflicts 409; unauthenticated 401; inaccessible 404; rate 429; provider unconfigured 503 with actionable code. Error envelope `{error, correlationId}`. Session cookie HttpOnly/SameSite; Origin validation on mutations; OIDC authorization-code/PKCE and issuer/audience/nonce validation. Development identity is explicitly gated and prohibited in production.

Writes with retriable effects carry stable UUID `clientId`/idempotency key. Uniqueness scope `(stream, actor, clientId)` and payload conflict detection. Accepted means committed on primary, sent means client observed durable acceptance, delivered means recipient acknowledged, read means explicit monotonic read cursor. Do not conflate SSE send with delivered. Read receipts honor preferences, target initial capacity 32 members, eventual receipt events.

Outbox envelope: `{id, version:1, tenantId, resourceId, type, occurredAt, payload}`. Keep payload minimal (invalidations rather than plaintext), authorized hydration required. Ordering is per conversation; global event sequence is cursor only, commit inversion must not lose events (serialize relevant writes or replay overlap/dedup). At-least-once, not exactly-once. SSE reconnect cursor/bounded replay with reset snapshot, heartbeat and queue caps. Slow sockets disconnect before unbounded buffering. Outbox and write in one transaction; consumers idempotent via unique delivery key. Retry capped at 8, exponential jitter, timeout, terminal DLQ, operator replay with audit.

```mermaid
sequenceDiagram
 participant A as Sender
 participant C as Core
 participant D as PostgreSQL
 participant B as Recipient
 A->>C: POST message with stable clientId
 C->>D: BEGIN; lock stream; verify current ACL
 C->>D: insert message + outbox + audit; COMMIT
 C-->>A: persisted id/sequence
 B->>C: authorized SSE cursor
 C->>D: recheck ACL and replay committed outbox
 C-->>B: invalidation/cursor
 B->>C: GET history; POST read position
```

## Migration safety (GAP-01–03)

Same-tenant only. Preview snapshots source/target membership and ACL revision, listing gained/lost historical access including guests. Require confirmation of the preview revision. Execution locks stream and relevant team membership, validates revision, prepares job/audit. For current relational metadata transaction atomically changes team/type/membership and increments ACL revision; stable IDs preserve references. Large external ACL propagation uses deny-until-reconciled fence, resumable states prepared/fenced/reconciling/complete/failed. Files/download authorization always checks database, preventing a stale public object link. Search joins current ACL. Subscriptions recheck on delivery and heartbeat; notifications recheck at send. Failed jobs remain fenced and operator-recoverable. No public-to-private intermediate release.

```mermaid
sequenceDiagram
 participant U as Authorized owner
 participant C as Core
 participant D as Database
 U->>C: Preview target type/team/member set
 C-->>U: grants/revokes/history effects + revision
 U->>C: Execute preview revision
 C->>D: Lock, revalidate ACL/revision, atomic metadata + audit + outbox
 D-->>C: Commit or rollback all
 C-->>U: Complete (or resumable job state)
```

## Encryption and browser feasibility

[LiveKit E2EE](https://docs.livekit.io/transport/encryption/) provides SDK encryption but key distribution remains the application's responsibility. Never generate endpoint-only keys on the server. For durable text/file E2EE evaluate maintained MLS implementation or Matrix Olm/Megolm SDK against device verification/recovery/browser compatibility before enabling. This is an explicit later-increment security blocker, not permission to implement ad-hoc crypto. No encrypted label until protocol and independent review/tests are complete. Default server-processable mode visibly identified.

| Capability | Server-processable | Endpoint-only encrypted |
|---|---|---|
| Text/search/email | Server authorized indexing/digest | Ciphertext server; local search only; content-free digest |
| File scanning/preview | Quarantine until scan, isolated preview | Cannot server scan; endpoint warning and local preview; no false clean badge |
| Coauthoring | Provider authorized processing | Requires compatible encrypted editor; otherwise unavailable |
| Media | SFU transport encryption; optional consented processing | Verified endpoint key epochs, fail closed if unsupported |
| Recording/transcription/coach | Consented provider processing | Explicit recording endpoint handles plaintext locally, encrypts output, shares keys only to authorized devices |
| Retention/discovery | Server deletion/hold/export | Ciphertext retention/hold only; no plaintext discovery promise |

Device identity verified out-of-band/SAS; membership changes rotate epochs; new member history policy explicit; removed devices cannot get new keys. Recovery via user-held recovery secret or verified device, never server plaintext escrow under provider-blind mode. Lost recovery means lost content. Key/metadata exposure: backend knows members/times/sizes/routing, not content. Downloaded keys/plaintext cannot be revoked. Malicious client delivery/XSS remains a threat requiring CSP/dependency controls and review.

| Browser feature | Chrome / Edge | Firefox | Safari | Validation |
|---|---|---|---|---|
| Core UI/SSE/multiple windows | Supported candidate | Candidate | Candidate | Current + previous stable, actual versions recorded later |
| Camera/mic/share | getUserMedia/getDisplayMedia detection | Same | Shares/device differences detected | HTTPS, user gesture, denial handling |
| E2EE | SDK/encoded-transform runtime check | Runtime check | Runtime check | Fail closed; no blanket support claim |
| Gallery | target 16 tiles | target 9 | target 9 | Measure CPU/frame drops; reduce subscriptions |
| Effects / spatial/music/AGC | Constraint/worklet/canvas capability checks | Same | Same | Low-power disable and accessible alternative |
| OS remote control | Not provided by browser | Not provided | Not provided | WEB-06 app-level control explicitly labeled; full desktop requires scope decision |
| Coach / avatars | Opt-in local processing + text equivalent | Same | Same | No recording without consent; limitations visible |

E2EE and advanced browser APIs are not verified by architecture. Need real devices and independent participants. WEB-18 needs provider account/trunk/phone numbers and billing authorization, regions and consent determined by deployment owner. PSTN cannot be silently treated as endpoint-encrypted browser participant.

## Workload, budgets and SLOs

Sign-off target: 10000 registered/2000 concurrent connections, 100 messages/s, 1M messages, 100 concurrent meetings x 50 participants, 500 attendee moderated event, 32-person receipt group. These are targets, not demonstrated capacity. Lab baseline: report host CPU/RAM/browser versions, data set, process replicas, warm/cold, 50ms RTT/10Mbps plus 3Mbps lossy profile. Web LCP 2.5s/INP 200ms/CLS .1 p75. API p95 read 300ms/write 500ms, delivery 1s, search 2s. Idle <100MB JS heap and <20KB/min background traffic target; chat <200MB and <10% single CPU, meeting <1GB and <70% CPU on reference 4-core laptop; battery measured 30min differential. No field metric claims from lab.

Core 99.95% monthly; media 99.9%; external provider latency/availability measured separately. Primary commit is local durability initially, not region-safe. Production synchronous standby must preserve acknowledged writes for single-node failure; regional recovery RPO<=5min via WAL backups, RTO<=60min. Region loss may lose acknowledged data within that RPO; this is explicitly distinct from normal durable ack.

## Threats and operational design

Threats: IDOR and confused tenant, stale socket/notification ACL, XSS/key theft, CSRF, malicious upload, replay/idempotency collisions, migration ACL races, provider compromise, abuse/backpressure, audit tampering, cross-tenant caches. Mitigations: parameterized SQL/current ACL in every path, immutable IDs/FKs, origin checks/HttpOnly cookies, text rendering/no raw HTML, quarantine and size bounds, no public object ACL, commit outbox, redacted logs and least-privilege deployment credentials. Independent penetration/security review remains open.

Use request IDs, release version, structured redacted logs, latency/status metrics and trace IDs without message bodies/cookies. Alert on 5xx burn rate, queue age/DLQ, disk/WAL, backup age, scan backlog, media joins; dashboards with no content. Server error telemetry must scrub URLs/identifiers. CI type/lint/domain/integration/browser/axe/build/audit; nightly load/failure/restore. Release image digest + manifest, health/readiness, SIGTERM drain then bounded shutdown. Secrets injected, never committed. Development seed refused in production. Backups encrypted with separate key/access, daily full plus continuous WAL, retention 30d subject to holds; restore monthly into isolated environment and verify checksums/ACL. Rollback app only with compatible schema; otherwise forward-fix or restore and reconcile outbox. Costs reported by active user/GB/meeting-minute; provider calls off without configured budget.

## Increments / risks / gate

1. Phase 2: schema, real identity boundary/development login, tenant ACL, server/client contract, CI, shell.
2. Phase 3a: durable streams/messages/reactions/threads/read/reconnect/drafts/search.
3. Phase 3b: files/quarantine/editor, private tasks/forms, scheduling/notifications/providers/settings.
4. Phase 4: atomic channel migration; separately gated E2EE protocol/device lifecycle.
5. Phase 5: real media first, then role/lobby/breakouts/artifacts; advanced browser features individually tested; telephony separately gated.
6. Phase 6: governance/lifecycle/export/closure/reporting.
7. Phases 7–9: hardening/staging/production/handover. Every requirement has its own criteria/evidence; partial subfeatures never qualify whole entry as Verified.

Blockers: B-TARGET external staging/production domain/credentials absent; B-SSO enterprise issuer/client/MFA test accounts; B-CALENDAR consent/account; B-EMAIL delivery domain/SMTP; B-EDITOR selected/licensed provider; B-TRANSCRIPTION language/provider or approved local model; B-PSTN trunk/numbers/region/billing; B-E2EE maintained protocol selection and security validation; B-DEVICES real browser/device matrix and independent audio endpoints; B-OBSERVATION monthly SLO/battery/user study evidence. Local database/core/chat are independent. Future-provider blockers do not affect the first coding increment. Architecture gate: validated 146 IDs, mapped owners/phases/workflows/dependencies/criteria, bounded local deployment and security modes; first increment has no unresolved feasibility blocker.

## ADR-009 — Durable OIDC transactions and local provider verification (0.1.1)

Keep identity protocol handling in the modular core using pinned openid-client 6.8.8. Replace process-local pending PKCE state with short-lived PostgreSQL transactions; atomic delete-returning provides single-consumer callback handling across replicas. Bind state to the initiating browser and issuer/client/callback/assurance policy; never infer membership from email. Keep the verifier and nonce server-side. Purge expired rows on login and every minute; a stopped service may retain expired rows until restart, but never accepts them. Outstanding flows are globally capped at 1,000 and authentication routes use a per-instance/IP 60/minute limit. DB at-rest protection remains an environment prerequisite.

Local feasibility provider: Keycloak 26.7.3, pinned image digest, separate owned H2 development volume, loopback port5180, 1 CPU/768MiB. It owns identity credentials, not application memberships. This is a provider deployment, not a new custom Java business service. Production requires a supported managed or HA IdP with TLS, verified MFA/recovery policy, session revocation integration and independently managed storage. Local public credentials and HTTP routing are forbidden in production.

Require the configured ACR claim on the validated ID token, regardless of browser authorization hints. The ACR string has no universal meaning: the deployment owner must map it to a verified provider MFA policy. Production boot validates explicit storage, origins, client settings, HTTPS and assurance configuration before migrations. Config changes can invalidate in-flight logins; prompt a fresh sign-in rather than accepting a weaker flow.

Official references checked for this increment: [Keycloak containers](https://www.keycloak.org/server/containers), [realm import](https://www.keycloak.org/server/importExport), [Keycloak ACR/step-up administration](https://www.keycloak.org/docs/26.7.0/server_admin/index.html), [openid-client discovery](https://github.com/panva/openid-client/blob/main/docs/functions/discovery.md). Installed 6.8.8 declaration signatures were used for discovery/custom fetch; insecure transport is explicitly local-only. Unknown provider subjects are denied, even when email matches an existing organization domain.

## ADR-010 — Recoverable browser send operations

Before transmitting a message, save its immutable client ID, exact body/thread reference and user/workspace/channel scope in bounded tab-scoped sessionStorage. This survives reload and conversation navigation within a tab; it is not an offline application shell or a guarantee across browser closure/storage deletion. Retain at most32 pending conversations, one operation per conversation. Fail before network transmission when storage cannot be written. Never automatically replace an ambiguous operation with a new identifier. Explicit retry reuses the same immutable payload; authoritative server ACL and idempotency rules still apply.

Keep this server-processable plaintext only for unresolved sends. Remove it on acknowledgment, explicit discard, logout/broadcast logout, access revocation or sign-in as another identity. Discard only removes the local retry record; an already accepted server message cannot be unsent this way. Storage is not an authorization boundary; validate its shape and resource scope, and rely on backend permissions on every retry. Users can continue editing a separate draft while an operation is unresolved, but must resolve/discard it before sending another message in that conversation. Acknowledgment and subsequent draft/history refresh are separate outcomes: failure to refresh must not relabel an accepted operation as unaccepted.

## ADR-011 — Signed provider logout and session revocation

Implement OpenID Connect Back-Channel Logout using maintained JOSE verification and the configured issuer's discovered JWKS. Accept only signed RS256 logout tokens for the configured issuer/client, with fresh issued-at time and mandatory expiry, unique event ID, explicit logout event, no nonce, and a subject or session identifier. The endpoint accepts a bounded form POST and uses token authentication instead of browser cookies/Origin. All other mutation Origin checks remain intact.

Own provider/session bindings, replay receipts and revocation tombstones in PostgreSQL. Delete matching application sessions atomically with an audit record; repeated signed events return success without repeating effects. Serialize identity issuance/revocation for each issuer/client to prevent an in-flight callback recreating a revoked provider session. Retain replay receipts/tombstones24h, longer than the5-minute login window; subject revocation uses an issued-at cutoff so a later authentication can sign in. Scope revocation to issuer, client and sid (and sub if present), or to subject when sid is absent. Existing development sessions have no provider binding and are unaffected.

Active SSE connections revalidate the application session every second and close after revocation; the UI must clear local state on session termination. ADR014 supersedes the original missed-event limitation: access now requires a provider check no older than60seconds, within an8-hour absolute application session. No claim that disabling an IdP user always emits logout, or that provider logout and application-local logout are equivalent. Production requires HTTPS reachability from the IdP and provider-specific delivery/retry verification.

Protocol reference: [OpenID Back-Channel Logout1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html). Library: [panva/jose](https://github.com/panva/jose), registry-pinned6.2.12, Node24 runtime. Local provider administration follows [Keycloak temporary admin recovery](https://www.keycloak.org/server/bootstrap-admin-recovery); no public development administrator is permitted in production.

ADR011 implementation note: migration005 invalidates pre-binding legacy sessions once without deleting user content. Provider logout has a separate600/minute per-instance/IP budget. Local live Keycloak delivery and independent-user isolation are verified; a temporary configuration administrator was removed afterward.

## ADR012 — Provider-managed OTP and meaningful assurance

Accepted for the local identity increment. Keycloak26.7.3 owns OTP secrets, enrollment and verification; the application continues to receive only signed OIDC claims and stores provider/session bindings. The browser flow orders LoA1 (required password) before LoA2 (required OTP), using the maintained built-in level condition. Both levels have max-age0 for explicit reauthentication. The application client has minimum/default ACR `urn:concord:mfa`, mapped to LoA2; the API independently requires this exact signed ACR. No constant claim mapper is used. First login without an OTP requires provider enrollment. Existing lower-assurance application sessions must be invalidated on deployment.

A separate loopback-only confidential test client has minimum LoA1 and no application deployment bound to it. It exists solely to verify that signed password-only tokens cannot satisfy a stronger API policy even when browser hints are removed. Test OTP generation uses pinned OTPAuth9.5.2, a development dependency; only synthetic accounts are automated. Enrollment secrets are stored in ignored local test state with mode0600, never in source, release evidence, frontend bundles or production. Identity browser traces/screenshots are disabled because enrollment screens expose secrets. Losing test state requires explicit local provider credential reset, never automatic weakening of the flow. Human users use their own authenticator.

Account recovery, recovery-code enrollment and enterprise lifecycle checks remain separate unfinished work. Enforcing MFA here does not establish enterprise readiness. Development shortcut login remains explicitly development-only and is forbidden in production.

Sources checked against pinned provider code: [Keycloak step-up flow](https://github.com/keycloak/keycloak/blob/26.7.3/docs/documentation/server_admin/topics/authentication/flows.adoc), [LoA condition](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/authenticators/conditional/ConditionalLoaAuthenticator.java), [OTPAuth](https://github.com/hectorm/otpauth).

## ADR013 — Provider-managed second-factor recovery

Accepted for the next local increment. Keycloak26.7.3's supported recovery-code authenticator owns generation, storage, consumption and regeneration. Password remains LoA1. LoA2 allows either configured OTP or a configured recovery code. A separate conditional fallback requires OTP enrollment if neither credential is configured; never grant LoA2 by skipping an empty alternatives flow. Build a new versioned flow, validate its structure, then switch the realm binding; retain the previous flow for diagnosis. Existing application ACR policy stays unchanged.

Settings can launch Keycloak's allowlisted recovery-code required action through the existing PKCE login path only when the deployment explicitly declares `OIDC_PROVIDER=keycloak`. Provider-managed reauthentication precedes code display. The application never receives codes and never treats a browser-returned action-status parameter as proof of completed enrollment. Cancelling can return to a normal authenticated application session but cannot be reported as enrollment success. Tests use synthetic credentials, no traces/screenshots or source-controlled recovery secrets.

Verify enrollment, second-factor recovery, invalid/reused-code rejection, regeneration invalidating the previous set, unchanged signed assurance, and no-factor enrollment. This is recovery from loss of an authenticator with a retained password and pre-enrolled recovery codes. Forgotten-password/email recovery, loss of all factors, enterprise helpdesk verification remain separate incomplete scope. Provider-disable reconciliation is locally verified under ADR014. Recovery codes are bearer secrets and cannot recover an account after all factors/codes are lost.

Source: [Keycloak26.7 recovery-code administration](https://www.keycloak.org/docs/26.7.0/server_admin/index.html), [pinned flow condition](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/authentication/authenticators/conditional/ConditionalSubFlowExecutedAuthenticatorFactory.java).

## ADR014 — Bounded provider-session reconciliation

Accepted for the local revocation increment. Keep signed back-channel logout as the fast path. Retain only a refresh token, encrypted using maintained JOSE compact JWE (`dir`/`A256GCM`) with a versioned256-bit keyring injected through a server-only file. Bind each encrypted payload to its application-session hash, issuer, client and subject. Do not persist plaintext access/ID/refresh tokens, use offline scopes, or grant the application provider-admin roles. This is server-side secret encryption, not E2EE; a compromised running API can use its credentials.

On authenticated requests and SSE checks, reuse a successful provider check for at most60seconds. After that, introspect the refresh token through the confidential client's RFC7662 endpoint, verify subject/client, then refresh it and encrypt the successor. Refreshing only when the application is accessed preserves provider expiry for inactive applications. A connected SSE session counts as activity. Application sessions retain their8-hour absolute expiry. Provider inactive responses or terminal invalid_grant remove the local session and audit a bounded reason. Provider timeouts/outages or invalid metadata fail closed with503 once freshness expires; never mint a fresh local lease on failure. Existing dev shortcut sessions are independent and remain forbidden in production.

Use short durable per-session leases (no database connection held across provider HTTP), process-local request coalescing and bounded concurrency. Updates must be conditional on the lease and existing session so a late refresh response cannot recreate logged-out access. Re-read session authorization after checking. Server time defines60-second freshness, provider calls have5-second timeouts, retry leases have bounded jitter. A busy peer check returns retryable503 after expiry rather than exhausting SQL connections. Legacy bindings without an encrypted token must sign in again when enforcement is enabled. Require explicit enforcement/key-file configuration in production.

Local development can create a mode0600 random keyring in its existing private API data volume, only with explicit development authentication and non-production mode. Production never auto-generates keys. Rotate by distributing a ring containing old+new keys with a new active ID, recreate instances, allow successful checks to rewrap credentials, then remove old keys only after all old bindings expire or are rewrapped. Losing keys forces reauthentication; keep key backup/recovery separate from SQL backups and test target secret-manager integration before production.

Live acceptance must cover disabled users (without assuming logout delivery), deliberately missed logout callbacks, active SSE revocation, independent identities, provider outage/recovery and persisted encrypted credentials across API restart. Laboratory tests additionally cover tampering/binding/key rotation, concurrent checks, stale leases, late responses after logout and terminal/transient failures. This closes a local session gap, not enterprise directory synchronization, full audit compliance or an operational revocation SLA.

References: [pinned Keycloak refresh introspection](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/protocol/oidc/RefreshTokenIntrospectionProvider.java), [openid-client introspection](https://github.com/panva/openid-client/blob/main/docs/functions/tokenIntrospection.md), [JOSE](https://github.com/panva/jose).

## ADR015 — Identity audit scope and failure privacy

Authentication is global; membership determines which organization administrators may observe a verified identity's session lifecycle. Within the same SQL transaction as successful sign-in/local logout/reconciliation, append the existing global event and one organization event per currently active membership. For signed provider logout, retain the global provider receipt and add one scoped event per distinct affected user, without exposing other users or aggregate session counts to tenant administrators. No client-provided organization or role determines event scope. Inactive/former memberships receive no new events; historical events remain scoped to their original organization.

Record rejected local sign-in, OIDC initiation/callback and back-channel submissions globally, with no actor attribution from unverified input. Metadata is restricted to a fixed route category, HTTP outcome and generated UUID request correlation ID (not the process-local default counter); target is a fixed authentication label. Never retain entered email/password, IP, query string, cookies, state/code, JWTs, provider descriptions or raw errors. Errors from provider screens that never reach this API remain provider-owned evidence; this is not comprehensive IdP event ingestion. Do not duplicate every expired-session poll. Requests rejected by the existing rate limiter (429) are excluded to avoid audit amplification; rate-limit telemetry/aggregation remains future work.

Audit persistence is awaited. Session mutations and success records commit atomically; a failed failure-audit write returns generic503 and emits only a bounded operational log. The existing tenant admin audit endpoint exposes only tenant rows and continues denying ordinary members/foreign tenants. No public/global authentication audit endpoint is introduced. Database-superuser tamper resistance, external immutable audit sinks, retention/holds, full audit filtering/export and tenant lifecycle policy remain unimplemented; this increment does not complete BE-FR-32 or BE-NFR-19.

## ADR016 — Versioned formatted message bodies

Add `messages.format` constrained to `plain` or `markdown-v1`, defaulting to plain for existing rows and older API clients. Persist the source string (10,000-character bound) with the format; never store generated HTML. POST idempotency compares format as well as body/thread. PATCH preserves format when omitted; explicit changes are validated. Committed message events retain existing ordering and resource authorization. Search/activity previews continue showing source text in this increment.

Use pinned react-markdown10.1.0 (official React>=18 peer compatibility verified) for CommonMark formatting. No raw-HTML plugin, MDX, executable content, image fetching or syntax plugins. Raw HTML is displayed as text; only absolute HTTP(S) links without credentials become anchors, with noreferrer/noopener and a new tab. Image syntax becomes an explicit text placeholder; no external request occurs. Headings are reduced to emphasized paragraphs to preserve application heading structure. The exact renderer is shared by preview/history/edit. Plain messages remain literal, including Markdown-looking characters.

Composer offers keyboard-accessible formatting controls and optional preview; drafts retain Markdown source through existing persistence. New pending operations carry the format; older browser records without it replay as plain. Never relabel an already persisted/retried operation using current composer state. Existing ownership checks, thread behavior and tenant isolation apply unchanged. Legacy clients may display formatted source literally; no silent body migration. This completes only the formatted-text/link portion of FE-FR-10, not structured mentions or attachment references. Review raw-HTML/URL/image restrictions if plugins are ever introduced.

Reference: https://github.com/remarkjs/react-markdown (official README security, components and URL-transform guidance; checked2026-10-12). No cryptographic or provider dependency is added.

## ADR017 — Structured channel-authorized mentions

Use explicit Markdown links `[@Display name](concord-mention:USER_UUID)` as portable source, preserving drafts and existing retry payloads. Parse with the maintained CommonMark AST (remark-parse11/unified11, already pinned transitively); promote these to direct dependencies. Only inline link nodes with the reserved scheme count; text, code, images, raw HTML and reference-style links do not notify. Plain-format messages never create mentions. Maximum20 distinct recipients; malformed reserved links are rejected. Display labels do not establish identity: history uses authoritative directory names for validated mention rows.

Migration009 creates normalized message_mentions with message/user foreign keys and unique(message,user). In the existing channel-locked message transaction, validate every recipient against current active membership/channel access and non-disabled identity, then insert references before the durable outbox event. Edits atomically replace references; deletion clears them. Retry checks precede new validation so a prior accepted operation remains deduplicated after recipient revocation. No extra copies of message plaintext are created.

Reuse the authorized channel-members endpoint for the picker; exclude disabled accounts. Activity filter `mentions` selects references for the requesting identity, including already-read messages, while enforcing current org/channel ACL and deleted state. Default unread activity is preserved and labels mentions. The Activity screen polls every5seconds while open with stale-response guards and clears data on failures. No email/browser push is claimed; no unknown tenant or user identifiers in events. Existing channel locks serialize with membership/conversion mutations; read-time ACL checks remain authoritative after revocation. Private channels and same-tenant shared channels use the same access predicate. No cross-tenant channel migration or @everyone fanout.

History displays validated mentions as non-navigating highlighted spans with server-resolved names; preview shows the typed label as untrusted text until accepted. A user must remove a now-ineligible mention before editing that source. Existing source text may retain a previously known display label after revocation; neither downloaded history nor knowledge can be retroactively revoked. Names/UUIDs already present in authorized history are metadata, not access grants. Keep richer delivery preferences, quiet hours, email digests and full notification lifecycle open.

## ADR018 — Durable quarantine scanning increment

Keep existing private-volume storage for this increment; S3/object storage, resumable uploads, file versions/previews/coauthoring and message attachments remain open scope. Integrate official ClamAV1.5.4 over its documented INSTREAM protocol. The official image lacks an ARM64 manifest; use its pinned AMD64 digest under local Docker emulation, with4GiB limit and persistent signature data. No scanner port is publicly exposed. TCP ClamD is unauthenticated/unencrypted, so only the isolated local container network is supported here; production needs a private authenticated transport boundary and approved deployment configuration.

Use a core-owned PostgreSQL file_scan_jobs table. Upload metadata and one scan job commit together, after immutable private bytes are written. Workers claim one eligible job with SKIP LOCKED, a random lease and60-second expiry; no SQL connection is held during filesystem or scanner I/O. Each scanner command has a20-second deadline (up to40seconds for capability/freshness and content checks) and bounded reply size; loaded signature date must be no older than7days and version must report INSTREAM support. Retry transient failures with exponential backoff/jitter (five attempts), then retain a dead job with generic reason and quarantined bytes. Authorized uploader requeue resets the bounded attempt budget; no fake clean result if the provider is absent. Crashed jobs become claimable after lease expiry; late results cannot replace a newer lease or resurrect deleted files.

Scan immutable bytes whose size/SHA256 match authoritative metadata. A clean verdict marks ready; detections mark rejected; errors stay quarantined. Commit file state, job completion, audit and outbox atomically under the channel lock (same ordering as delete/membership/migration). A dedicated worker uses the same modular-core image/schema owner and a read-only file mount, allowing separate scaling without another service writing owned tables. Deleted files cancel jobs. Existing quarantined files are enqueued by additive migration.

Downloads require current channel access, ready state and a second size/hash validation. Serve attachment-only application/octet-stream, nosniff, no-store and a safely encoded filename. Never serve quarantined/rejected/missing/tampered bytes. Check authorization again after reading bytes; revocation cannot recall already downloaded content. Only UTF-8 plain-text .txt/.md/.csv and signature-checked PDF/PNG/JPEG uploads are accepted in this increment; declared MIME must match, but this is not comprehensive content disarm/reconstruction or a malware guarantee. No encrypted-file scanning claim. Existing unsupported files stay quarantined on worker validation failure. Keep the existing1MiB upload/100MiB local tenant bounds; these are not enterprise capacity targets.

References checked2026-10-12: official https://docs.clamav.net/manual/Usage/ClamdProtocol.html (INSTREAM framing and TCP trust boundary), https://docs.clamav.net/manual/Installing/Docker.html (image/signature persistence and memory), https://www.clamav.net/downloads (1.5.4).

The pinned scanner configuration alerts on encrypted archives/documents and exceeded scan limits, with bounded archive recursion/file counts. Such heuristic detections are rejected, not treated as clean. This is server-processable scanning, not E2EE.

## ADR019 — Scanned message attachments

Implement channel-local attachment references before object storage: the existing scanner and private byte repository are sufficient for an integrated authorized sharing increment. This ordering does not defer mandatory object storage, upload idempotency or reconciliation; those remain next independent work. No new runtime/provider/library is required.

POST message accepts up to10 distinct UUID attachmentIds, canonicalized and persisted as an immutable retry snapshot on messages. Normalized message_attachments links enforce file/message foreign keys. Under the existing channel lock, every new reference must point to a ready file in that same channel and organization. A current member may share another member's already-visible ready file; never copy/move bytes or widen access. Check prior clientId and full payload equality before reevaluating file state, so a lost-response retry still acknowledges an accepted operation after file deletion. Attachment sets cannot be altered by text edit in this increment.

History projects authoritative current file metadata only for ready same-channel references; deleted/unavailable files render a generic unavailable entry without the former filename. Deleted messages expose no attachments. Download always uses the existing current-ACL/ready/integrity endpoint. File deletion events already cause history refresh; no signed permanent links or authority from client names. Retained UUID references record accepted operation identity, not permission to retrieve content. Member revocation and channel conversions retain existing authoritative access checks. No cross-channel forwarding or encrypted attachments are claimed.

The composer paperclip opens an accessible picker of current conversation files, with loading/error/empty/retry states and unavailable scan states. Choosing Send file sends that file with the current draft, or a simple fallback body, immediately; this explicit action avoids introducing an unsaved attachment-selection draft. Existing session-scoped pending recovery stores attachment UUIDs alongside the exact text/clientId and preserves them through reload/retry. Legacy pending records mean zero attachments. History renders attachment download links separately from formatted user text. Text-only edit preserves attachments; deleting a message hides its links without deleting shared files. Tests cover ready/quarantine/rejection, same-channel and tenant boundaries, forged/stale references, concurrency/idempotency, deletion, independent-user browser download and lost-response recovery. File storage/provider work remains explicitly incomplete.

## ADR020 — Upload retry identity and local orphan reconciliation

Before adding an object-store provider, close the existing local upload ambiguity: a committed upload whose response is lost must not create duplicate file/job/audit rows on retry, and a failed SQL commit must not trigger deletion of possibly committed bytes. This increment keeps local private storage explicitly; S3/object storage remains mandatory open work, not a completed provider integration.

Add nullable client_id to files with a unique(channel_id,created_by,client_id) constraint. Legacy callers may omit it and retain non-idempotent semantics; the new UI always sends a UUID. Normalize UUIDs and compare filename, canonical MIME, decoded size and SHA256 under the channel lock before quota/write. Return existing id/current state for identical retries (including deleted state); reject changed payload409. Revalidate channel authorization for every retry. Server-generated storage keys remain immutable. Hold the existing tenant quota lock and a shared global storage advisory transaction lock across the bounded <=1MiB local write and metadata/job/outbox commit. This limited local I/O-in-transaction choice is not a pattern for remote object-store operations.

Write bytes with exclusive create, fsync file, then fsync directory before committing metadata. Never unlink on an ambiguous transaction failure; cleanup owns orphan removal. The maintenance process scans only the application file root, in bounded batches under the exclusive counterpart of the storage lock. Remove only UUID-named regular files older than one hour with no files.storage_key row at all. Preserve young bytes, symlinks, directories, unknown names, and every referenced file including soft-deleted/rejected/quarantined records. Skip a batch when uploads hold the lock and retry on a later pass. Stream directory enumeration to bound memory. A SQL outage or inability to acquire/check authoritative state must not delete files. Separate worker uses the same owning core image, writable bytes and database, not scanner credentials. Counts-only logs; no filenames/content. This is crash-orphan cleanup, not retention, legal hold or user-content purge.

Frontend recovery keeps only scoped pending metadata (identity/channel, random operation ID and SHA256 fingerprint) in session storage, never file contents. Reselecting the same bytes/name/type after reload reuses the ID; a confirmed response removes the pending record. Invalid/unavailable storage fails before sending. Bound to32 pending entries; sign-out/session-clear removes metadata. Reselect is explicit because browsers cannot restore a chosen local file after reload. New upload attempts with different bytes obtain different IDs; already-confirmed uploads intentionally selected again are new operations. Automated tests cover real SQL concurrency, payload conflicts, lost response/reload/reselection, revoked access, deletion retries, orphan grace/protected files/symlinks and cleanup lock exclusion. Object storage, upload progress, physical retention quotas and production durability remain open.
