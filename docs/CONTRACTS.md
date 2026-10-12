# API and event contracts — 0.1.3-local

Authoritative domain rules reside in `services/core`. Frontend calls the API directly; Next renders the shell and serves assets. JSON request schemas use Zod; session and message responses are runtime validated by `lib/contracts.ts`. Other client responses currently use static types and remain a contract-hardening gap.

All `/v1` routes require a current HttpOnly session cookie, except capabilities, development login and OIDC redirect/callback. Requests use `credentials: include`. Mutation Origin must equal WEB_ORIGIN; unsupported origins receive 403. Resource access failures use 404 to prevent discovery. Errors have `{error, correlationId}`, with validation paths on 400. Responses are no-store. IDs are UUID; message/event sequence values are JSON strings (PostgreSQL bigint).

| Resource | Routes and behavior |
|---|---|
| Session | POST `/session` development credentials; GET identity/authorized organizations; DELETE revoke current session |
| Enterprise identity | GET `/auth/login`, `/auth/callback`: OIDC discovery, code/PKCE/state/nonce; exact subject preprovisioning; no automatic membership |
| Profile | PATCH `/profile`: permitted name/job/timezone/status and preferences |
| Workspace | GET `/organizations/:id/bootstrap`: authorized teams/channels/directory; POST `/presence`: heartbeat/manual state/expiry |
| Teams | GET/POST `/organizations/:id/teams`; PATCH `/:team`; POST `/:team/join`, `/:team/leave` |
| Channels/chat | POST `/organizations/:id/channels`: kind/team/name/description/members; PATCH `/channels/:id/details`; GET `/channels/:id/members` |
| Messages | GET/POST `/channels/:id/messages`; PATCH/DELETE `/:message`; POST `/:message/reactions`, `/:message/save` |
| Draft | GET/PUT `/channels/:id/draft`: body, per actor/channel; last write wins; no durable offline client queue |
| Read state | POST `/channels/:id/read`: monotonic seq bounded by conversation head; GET `/receipts`: opted-in current authorized recipients, cap 100; tested at 32 |
| Organization preferences | PATCH `/channels/:id/preferences`: pinned/muted/hidden; not all have complete UI semantics yet |
| Typing | POST/GET `/channels/:id/typing`: 5s TTL, local instance only; not a distributed presence implementation |
| Events | GET `/channels/:id/events?after=cursor`, Last-Event-ID supported; authenticated SSE; 100/event page, 1s poll, 64KB slow-client cap, 10 connections/user/instance |
| Search/activity | GET `/organizations/:id/search?q=...` authorized FTS messages, max 50; GET `/activity` unread messages, max 50 |
| Work | GET/POST `/channels/:id/tasks`; PATCH `/:task`; GET/POST `/:task/comments`; GET/POST `/forms`; GET/POST `/:form/responses` (all responses restricted to author) |
| Calendar | GET/POST `/organizations/:id/meetings`; PATCH `/:meeting`: response/cancel; local-only single occurrence |
| Files | GET/POST `/channels/:id/files`; POST JSON base64 <=1MB; DELETE `/:file` uploader-only soft deletion; GET `/:file/download` permits only ready bytes; POST `/:file/retry` requeues uploader-owned dead scan jobs |
| Migration | POST `/channels/:id/migration-preview`; POST `/migrate` includes exact preview snapshot/clientId; same tenant, admin+source access, transactional revision/ACL reconciliation |
| Membership | PATCH `/organizations/:id/members/:user` role/active, protects last owner; invitations GET/POST, DELETE `/:invitation`, POST `/invitations/accept` identity-bound token |
| Audit/feedback | GET `/organizations/:id/audit` admin max100; POST `/feedback`; audit append is not tamper-proof archival |

Message POST `{clientId, body, parentId?}` is idempotent by `(channel, actor, clientId)`. The same key with changed content returns 409. Other writes do not yet have general idempotency guarantees. Database insert and event append share a local transaction and stream row lock. A returned 201 proves primary commit, not recipient delivery or regional replication. Read positions are explicit and not inferred merely from delivery.

SSE events are minimal invalidations: `id: <cursor>`, `data: {id,type}`. Hydration uses the authorized message/receipt API. On revocation the stream sends `event: revoked` and closes. Each poll checks session and resource access. Ordering is per channel because writes lock the channel before allocating IDs. No cross-channel total commit order is promised. Browser coalesces event hydration; online/offline handlers reconnect using the last observed cursor. The entire durable log is retained currently; pruning/reset snapshots are unfinished.

Uploads are private local objects named by server UUID, never user-supplied paths. Metadata contains SHA-256 and tenant/channel/actor; a file created before a failed SQL transaction is removed. Logical deletion currently retains underlying bytes pending lifecycle implementation. No encrypted-file claim.

## Identity transaction contract

`GET /v1/auth/login` creates a PostgreSQL-backed five-minute single-use transaction, sets an HttpOnly browser-binding cookie, and redirects to the provider with S256 PKCE and nonce. `GET /v1/auth/callback` checks that binding before consuming state atomically, validates the authorization response/token with openid-client, enforces configured `OIDC_REQUIRED_ACR`, and resolves the exact issuer/subject. Unknown/disabled identities get no session. Authorized callbacks set an eight-hour local session and clear the flow cookie. No provider tokens reach the frontend.

Local HTTP transport/routing requires explicit non-production flags. ACR request hints are not trusted; the signed ID-token claim is checked again. Shared state is bound to issuer, client, callback and ACR policy. Expired flows cannot be consumed and are cleaned on login and periodically. Authentication attempts are limited separately from session-status reads and logout. Signed provider logout is described below; local MFA, second-factor recovery and reconciliation are described below; enterprise rollout remains incomplete.

## Browser send recovery contract (0.1.2)

Before POST `/v1/channels/:id/messages`, the client persists the immutable clientId/body/parentId and current user/organization/channel scope in sessionStorage. One unconfirmed operation per conversation; at most32 records per tab. A storage write failure prevents transmission. Explicit retries reuse the stored payload regardless of subsequent composer edits. Navigation/reload restores the pending state; sending another operation in that conversation stays disabled until retry/discard. A successful POST is acknowledged independently of subsequent draft/history refresh; those failures never recreate an unconfirmed operation.

Local records contain server-processable plaintext, are not trusted for authorization, and are cleared on acknowledgment, explicit discard/reset, logout (including broadcast to open windows), identity change, or active-channel access revocation. Clear/discard does not delete accepted server messages. Session storage cannot guarantee recovery after tab closure, browser data deletion, or an offline page reload without an application shell. Unsaved offline drafts remain window-memory only. Full FE-FR-33/FE-NFR-09 acceptance remains incomplete.

## Back-channel logout and session lifecycle (0.1.3)

`POST /v1/auth/backchannel-logout`: bounded application/x-www-form-urlencoded body with one `logout_token`; authentication is its validated provider signature and claims. No browser Origin/session required for this exact POST path; every other mutation retains its Origin checks.200 means processed/already processed,400 invalid token/request,413 oversized,429 throttled with Retry-After,503 identity-key dependency unavailable. Supported signing profile:RS256; explicit JWT/logout+jwt types accepted, encrypted logout unsupported.

Persist `oidc_sessions` as a cascade-owned child of local sessions. `oidc_logout_events` and `oidc_revocations` retain replay/tombstone evidence24h. Provider session creation and revocation use the same PostgreSQL transaction-scoped advisory lock per issuer/client. Since release0.1.6, session-bound encrypted refresh tokens are retained as described below; no plaintext provider tokens are stored. `identity.signed_in`, `identity.provider_logout`, and migration005's `identity.legacy_sessions_revoked` are global audit actions; no JWTs, session cookies or raw bodies are logged.

SSE `session-ended` (empty JSON data) means the local authenticated session expired/revoked and closes the connection. `revoked` still means resource access changed. A transient database failure closes the stream for reconnection without falsely declaring permission revocation. Application-local logout remains separate from provider logout. Provider user disabling and missed-event reconciliation are locally verified in release0.1.6; complete enterprise lifecycle remains open scope.

### Session assurance, release0.1.4

OIDC session bindings additionally store the signed `acr` value (nullable for old bindings). Every authenticated request and SSE validity poll requires the configured issuer/client and, when set, exact `OIDC_REQUIRED_ACR`. Unknown/lower/foreign assurance yields the existing401 session-ended behavior. Sessions without an OIDC binding are accepted only in explicit non-production development authentication mode. Changing policy requires application reauthentication; callback claims are checked before session creation. No OTP secret or provider access token is stored by the application. Release0.1.6 adds encrypted refresh credentials (below).

### Recovery entry point, release0.1.5

`GET /v1/capabilities` includes `recoveryCodes:boolean` (configured issuer/client and `OIDC_PROVIDER=keycloak`). `GET /v1/auth/login?action=recovery-codes` adds the fixed provider parameter `kc_action=CONFIGURE_RECOVERY_AUTHN_CODES` to the existing state/nonce/PKCE/essential-ACR flow. Unknown/duplicate action values or arbitrary redirect/action parameters return400; unsupported provider configuration returns503. Standard login without an action is unchanged. Callback authentication uses signed claims; browser-provided action-status hints never establish recovery enrollment. Provider owns code generation, verification, consumption and replacement. Application has no recovery-code API/data table.

### Provider freshness, release0.1.6

With reconciliation enabled, authenticated endpoints and SSE validity polls require a provider-session check no older than60seconds. API success still requires current local membership and exact issuer/client/ACR policy. Inactive provider session:401 and durable local-session deletion. Provider dependency/key/capacity failure after freshness expires:503, no authorization extension, bounded retry cooldown. Clients may retry; a503 is not evidence of account revocation. Existing signed back-channel logout remains the fast path. SQL stores only session-bound JWE refresh credentials, freshness and lease metadata; plaintext tokens never enter frontend contracts. Old provider bindings with no credential require reauthentication.

### Authentication audit, release0.1.7

Successful OIDC/development sign-in, local sign-out and inactive-provider reconciliation append global and active-membership organization audit rows atomically with the session mutation. Signed logout additionally appends one tenant event per distinct revoked identity, without disclosing provider-wide totals. `/v1/organizations/:id/audit` remains admin-only and excludes global records. No new global audit HTTP endpoint exists.

Failed authentication endpoints append `identity.authentication_failed` globally with null actor/organization, fixed `authentication` target and exactly `{route,status,correlationId}` metadata. Route values: `development_sign_in`, `oidc_start`, `oidc_callback`, `provider_logout`. Correlation IDs are server-generated UUIDs; caller request-ID headers are ignored. No submitted identity, query, cookie, token or raw provider error is retained. Throttled429 requests and ordinary expired-session polls are excluded. Provider-screen failures that do not reach the application are not observed. Failure-audit storage errors yield generic503; successful session changes roll back with a generic5xx if their audit insert fails. General tenant audit search/export/retention and an immutable external sink remain unfinished.

### Message format, release0.1.8

POST `/v1/channels/:id/messages`: optional `format` enum `plain | markdown-v1`, default `plain`. The existing `body` remains bounded source text, not HTML. Format is included in retry equality; reusing a clientId with a different format returns409. Responses/history include format. PATCH accepts optional format and preserves it when omitted; unsupported formats return400. Old rows/clients remain plain. No permission or event ordering changes.

The Next composer sends markdown-v1 and persists that value in pending operations. Older pending records lacking format replay as plain. Drafts store source text. Editing can explicitly choose plain or Markdown. Renderer supports CommonMark emphasis, lists, code, quotes and HTTP(S) links; executable/relative/credential-bearing links are inert, images become text placeholders, HTML is literal. Search/activity previews remain source text. Structured mentions and attachment reference entities remain pending.

### Structured mentions, release0.1.9

Markdown-v1 source can contain `[@Name](concord-mention:UUID)` inline links. The API derives recipients from the CommonMark AST; it does not accept a separate client-authoritative recipient list. Maximum20unique valid UUIDs; all must identify active, non-disabled channel members. Invalid/ineligible recipients return400 and the entire message/event/reference transaction rolls back. Plain text/code/images/reference-style links do not create mentions. Existing retry payload equality remains body/format/thread-based. Accepted retries still return the existing message after a recipient loses access.

History now returns `mentions: [{id,name}]`, resolved from authoritative users; only these validated references render as highlighted mentions. Edits replace references atomically, and deletion removes them. `/v1/channels/:id/members` excludes disabled users. `/v1/organizations/:id/activity?filter=unread|mentions` defaults to unread. Mentions mode includes read messages, excludes own-authored/deleted messages and always rechecks current channel ACL. Rows include format, mentions and a `mentioned` boolean. Most recent50results; full pagination/notification lifecycle remains future work. The Activity view refreshes every5seconds while open. This is in-app activity only, not browser push/email delivery.


### File scanning and downloads, release0.1.10

POST `/v1/channels/:id/files` accepts at most1MiB decoded bytes and the existing100MiB tenant logical quota. Allowed extensions: UTF-8 txt/md/csv (no NUL), magic-checked pdf/png/jpg/jpeg. Declared MIME must match or be application/octet-stream; text/plain also accepts md/csv. Bad type/signature yields400. This is basic format validation, not a full document parser. The transaction creates quarantined metadata plus a queued `file_scan_jobs` row. Provider errors never imply a clean verdict.

GET file listings includes `state`, `scan_status`, `attempts`. Files are quarantined, ready, rejected or deleted; jobs are queued, running, done, dead or cancelled. Worker completion emits `file.scanned` with id/state and audit `file.ready` or `file.rejected` in the same transaction. This increment's file UI polls every3seconds while open. Scan status does not convey access: every read/download/retry/delete enforces current channel permissions.

GET `.../files/:file/download` requires ready state; quarantined/rejected returns409, missing/deleted or denied resource returns404, size/hash/read failure returns503. Ready bytes are verified and ACL/state rechecked after reading, then served as no-store/nosniff attachment-only application/octet-stream with UTF-8 encoded filename. No inline preview. POST `.../files/:file/retry` allows only the uploader of a quarantined file with a dead job; non-dead returns409, ineligible actor404. It resets attempts/availability and audits `file.scan_retried`. Deletion cancels the job atomically and does not physically purge retained bytes. Retryable upload idempotency and object-store transactions remain future work; scan completion itself uses compare-and-set leases and a unique file job.


### Message attachments, release0.1.11

POST `/v1/channels/:id/messages` adds optional `attachmentIds` (default empty, max10 distinct UUIDs). IDs normalize to lowercase and sort; ordering is not meaningful. Each new reference must name a ready file in the same channel/organization, otherwise400; normal channel denial is404. A reference never grants file access. An eligible member can share another uploader's visible file. Body remains required; the UI uses "Shared a file." when sending without a caption.

Migration011 adds the immutable `messages.attachment_ids` retry snapshot and `message_attachments` FK links. Full accepted retry equality includes the canonical attachment set; changed attachments with an existing clientId return409. Prior acceptance is checked before current file eligibility so deletion cannot invalidate a lost-response acknowledgement. Creation/reference validation/outbox commit atomically under the channel lock. PATCH edits text/format and preserves attachment links; attachment replacement is not supported yet.

History adds `attachments: [{id,name,state}]`, where ready references expose authoritative name and deleted/unavailable references expose null name and `unavailable`. Deleted messages return no attachment entries. History rechecks channel access; download links use the existing current-ACL/scan/integrity endpoint. Search/activity retain caption/source navigation, not file-content indexing. File deletion emits an existing channel event that refreshes history. File deletion does not delete messages; message deletion does not delete shared files.

The composer opens a file picker with explicit Send file actions and a route to Files for uploading/scanning. Selecting Send file immediately submits the current draft plus that reference. Pending session storage preserves attachment IDs/clientId/body for recovery, with legacy records meaning zero references. No attachment selection is stored as an unsent server draft in this increment. Retry uses the original references even when the visible composer has changed. Object storage/upload idempotency/reconciliation and multi-file selection remain unfinished.


### Upload retry identity, release0.1.12

POST `/v1/channels/:id/files` accepts optional UUID `clientId`. New UI uploads always provide it; older callers without it remain non-idempotent. Identity scope is channel + authenticated uploader + clientId. An identical retry (filename, canonical MIME, decoded size and SHA256) returns the original file id and current state without extra bytes/job/audit/event. Changed payload returns409. Current channel access is required even for retries. Deleted uploads return the original id with state deleted, without resurrection. A confirmed upload selected again is intentionally a new operation.

Private local writes now fsync the file and directory before metadata acknowledgement. SQL failure leaves bytes for safe reconciliation, never eager deletion after a possibly successful commit. Metadata/job/audit/outbox remain one transaction; local writes are bounded1MiB and protected by a shared storage lock. This is not a cross-store atomicity or power-loss/HA durability guarantee. A future remote object store needs a different staged protocol.

Browser session storage keeps only uploader/channel IDs, clientId and a SHA256 fingerprint of filename/MIME/content hash for unconfirmed uploads. It does not retain bytes or raw filename. Reselecting the same file after reload retries that operation. Confirmed responses clear it; sign-out/session-ended/Help clearing removes upload recovery records. Invalid/full/unavailable storage fails before transmission. Maximum32 pending records. Closing the tab/clearing storage loses retry metadata; no persistent browser file handle is assumed. Upload progress and automatic resume remain unfinished.

The maintenance process streams the private directory in batches of500 UUID entries. Under an exclusive try-lock paired with upload shared locks, it checks all matching storage keys (including deleted files). It only unlinks regular, unreferenced, older-than-one-hour bytes. Unknown names, links, directories, young and referenced bytes stay. Busy batches are skipped for a later pass; database failure prevents deletion. This is orphan reconciliation, not retention or content deletion policy.
