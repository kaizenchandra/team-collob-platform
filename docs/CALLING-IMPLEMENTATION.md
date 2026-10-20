# Calling implementation checklist — 0.1.126

Inspection: Next16.4/React19 client workspace, Fastify5 API, PostgreSQL migrations/transactional outbox, HttpOnly cookie sessions plus existing OIDC/current membership checks, authenticated SSE, LiveKit2.23 client/2.19 server SDK and self-hosted SFU/Redis are present. Native CSS/lucide design system; node:test/Playwright/axe and pinned Docker Compose are the verification tools. Preserve the existing recording/breakout implementation but do not expand it: those features are outside this task. Existing unrelated changes remain intact.

Approach: extend the existing call/grant model and SDK, add durable events/attendance/policies, improve prejoin/meeting/history screens, then verify separate users against the real local SFU. Initial gaps and acceptance mapping follow; final status will be updated after verification.

| Requirement | Existing / gap | Frontend | Backend / data / acceptance |
|---|---|---|---|
| FE-01 | Conversation/group calls exist; instant/link/profile gaps | Workspace, media workspace | instant/invite/link access; eligible membership and copied-link tests |
| FE-02 | Incoming polling and outcomes; device-winner/busy gaps | Incoming banner, outgoing status | invitation winner/session, durable events; acceptance/cancel races |
| FE-03 | Device enumeration; no live preview | Prejoin preview | local capture lifecycle; denied/missing/cleanup tests |
| FE-04 | SDK tiles; layout/pin gaps | ConnectedMedia | actual SDK speaker/track state; layout/pinning/failure tests |
| FE-05 | Actual toggles/switches exist | ConnectedMedia | SDK controls; remote reception and cleanup tests |
| FE-06 | Actual sharing exists; presentation/policy gaps | Sharing stage/sticky toolbar | sharing lease/provider permission; competing capture tests |
| FE-07 | Own hands exist; host/order cleanup gaps | Collaboration/roster | ordered hands, host lower, grace; order/reconnect tests |
| FE-08 | Persisted retry chat; pagination/unread gaps | Call chat | keyset pages/read cursor; deterministic order/dedup tests |
| FE-09 | Mute/remove/transfer exist; unmute request gap | Roster, unmute prompt | durable request, trusted moderation; actual provider effects |
| FE-10 | Leave/end exist; confirmation/host departure gaps | End confirmation | idempotent leave, host succession, attendance; release tests |
| FE-11 | Basic outcomes; attendance/duration gaps | History/details/call again | persistent attendance/history/chat policy; access tests |
| FE-12 | Existing responsive design/axe | All meeting controls | keyboard/mobile/focus/error/unsupported verification |
| BE-01 | Basic durable call lifecycle | — | serialized transitions, ended-state guards and idempotent operations |
| BE-02 | SQL responses; real-time/winner gaps | — | authenticated durable SSE, per-session acceptance, race tests |
| BE-03 | Current ACL/session binding exists | — | reuse channel/membership auth for links/events/chat/tokens |
| BE-04 | Host transfer exists; succession gap | — | host/participant roles; deliberate/grace departure policy |
| BE-05 | Short scoped tokens exist; webhook gaps | — | verified raw-body webhooks/replay IDs, generation provisioning |
| BE-06 | SDK signaling; app polling gap | — | durable versioned media changes + authoritative resnapshot |
| BE-07 | Device grants/leases exist; attendance gaps | — | attendance intervals, one active call/user, grace and cleanup |
| BE-08 | Unrestricted sharing gap | — | one room sharing lease, trusted publisher permission reconciliation |
| BE-09 | Timestamp hands exist | — | monotonic queue sequence, host actions, final-departure cleanup |
| BE-10 | Persistence/bounds/dedup exist | — | deterministic pagination, read cursors,30-day retention/post-access |
| BE-11 | Server mute/remove; stale token gap | — | retire/delete physical generations on bans; audit, no remote unmute |
| BE-12 | Audit/basic history exist | — | provider attendance timestamps/durations; scoped metadata only |
| BE-13 | Reconciler/leases exist | — | durable reconciliation, token renewal, idempotent callbacks/timeouts |

## Application policies (not Teams defaults)

Default limits:32 participant device connections/call;100 eligible invitation recipients;32 active calls/deployment. Server configuration can lower these with MEDIA_PARTICIPANT_LIMIT, MEDIA_INVITATION_LIMIT and MEDIA_ACTIVE_CALL_LIMIT; invalid or over-capacity values fail startup. Authenticated current organization/channel membership is required, including existing guest accounts; no anonymous guests. Links identify calls and grant no access. One active call per user, multiple devices/tabs in that same call allowed; a pending invitation's first authenticated session to accept wins, other sessions stop ringing and cannot claim that acceptance. Manual explicit joining of the same authorized meeting remains available.25-second reconnect grace/5-second lease renewal; provider disconnect retains logical hand/attendance during grace. Intentional host departure transfers to the earliest live eligible user; no successor ends the meeting. Host loss transfers after grace. One active screen publisher per room, server lease and provider permissions; no forced remote capture. Chat persists30 days; current eligible nonremoved members can read after joining or from ended-call history, late joiners see retained room history, removed users lose chat/media access. Call duration is creation-to-end; attendance is sum of actual media-connected intervals per device (overlapping devices are not collapsed). Chromium is automated locally; Firefox/Safari features are capability gated but physical-device/browser matrix acceptance is not claimed. HTTPS/WSS, routable ICE and authenticated TURN are required outside loopback; WebRTC transport encryption is not endpoint-only encryption.

## Official references consulted

- [Teams instant meetings](https://support.microsoft.com/en-us/teams/meetings/start-an-instant-meeting-in-microsoft-teams): meeting creation/prejoin/link and invite workflow. Our invitations, limits and chat policy use application ACLs rather than Teams tenant policy.
- [Teams controls](https://support.microsoft.com/en-us/teams/meetings/use-meeting-controls-in-microsoft-teams): mic/camera and raised-hand interactions.
- [Teams presentation](https://support.microsoft.com/en-us/teams/meetings/present-content-in-microsoft-teams-meetings): explicit sharing and retained controls.
- [Teams attendee A/V permissions](https://support.microsoft.com/en-us/teams/meetings/manage-attendee-audio-and-video-permissions-in-microsoft-teams-meetings): host mute versus user-controlled unmute.
- [LiveKit tokens](https://docs.livekit.io/frontends/reference/tokens-grants/), [participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/): scoped credentials, trusted permissions and self-hosted revocation limitations. Application-specific physical-room retirement is required for removal.
- [LiveKit verified webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/): raw-body JWT/hash verification, replay deduplication and reconciliation.
- [LiveKit networking](https://docs.livekit.io/transport/self-hosting/ports-firewall/) and [deployment](https://docs.livekit.io/transport/self-hosting/vm/): TLS/ICE/TURN. No paid infrastructure authorized or used.

## Verification categories

Automated DB/API/state tests; separate authenticated browser sessions with synthetic camera/microphone sources against actual SFU; browser real screen-capture and track/decoded-byte verification; physical device/hearing and cross-network/TURN tests separately pending. Do not describe synthetic sources as physical-device acceptance.

## Protocol and transaction boundaries

All application paths below are under `/v1/organizations/:org`. Cookie authentication, current organization and channel membership apply on every request. Body schemas reject unknown fields; UUIDs, 4000-character literal chat bodies and signed-64-bit sequence cursors are validated. Errors use the existing `{error}` envelope and `X-Request-Id`:400 invalid input,401 session expired,403 removed/host-only,404 inaccessible resource,409 ended/expired/conflicting state or busy,429 quota,503 unavailable provider. Identifiers returned in payloads are opaque, never authorization credentials.

| Contract | Inputs / result | Retry and authorization |
|---|---|---|
| POST `direct-conversation` | `{userId}` → `{id}` existing/new direct conversation | Pair advisory lock; non-guest creator, eligible target; repeats return same pair |
| POST `instant-meetings` | `{clientId,title,mode,userIds}` → `{id,channelId}` | Global provisioning quota lock, caller/client identity dedup; first accepted request owns its body |
| POST `channels/:channel/calls` | `{clientId,mode}` → `{id}` | Channel lock + one-active-call unique index; existing active conversation call returned |
| GET `calls`, GET `calls/incoming` | authorized call list / unresolved invitations | Read current membership, archive and invitation deadline; never return transport tokens |
| POST `calls/:call/respond` | `{response:accepted|declined,clientId?}` → `{ok}` | User lock then call lock; first pending response wins; acceptance binds login session and supplied device; same winner repeat succeeds; competing device409 |
| POST `calls/:call/join` | `{clientId,recordingConsent}` → `{grantId,identity,roomId,roomVersion,url,token}` | User lock then call lock; one active call/user; session/device grant dedup; bans/end/current ACL rechecked; room created through server only |
| POST `calls/:call/connections/:grant/heartbeat` | `{roomId,roomVersion}` → `{ok,roomId,roomVersion,...newCredentials?}` | Same session/user only; cannot renew expired/revoked grants; generation change mints a newly scoped token after authorization |
| DELETE `calls/:call/connections/:grant` | → `{ok}` | Owner session, repeated departure succeeds; final direct-device hangup ends direct call; group host succession reconciled |
| GET `calls/:call` | call, logical rooms, current device participants, invitations | Authoritative application snapshot; SDK separately supplies actual media state |
| POST `.../connections/:grant/hand` | `{raised}` → `{ok}` | Live owner session; repeated raise keeps original monotonic order |
| POST `.../connections/:grant/share` | `{sharing}` → `{ok}` | Call transaction serializes room lease claim; conflicting owner409; server changes LiveKit allowed sources; periodic reconciliation restores correct rights |
| GET / POST `.../connections/:grant/chat` | `?before=seq` / `{clientId,roomId,body}` → page / `{id}` | Live owner session/current room; persistent ACK; immutable call/user/client dedup before rate checks;100/page,10 sends/10 seconds,10000/call |
| POST `.../connections/:grant/read-chat` | `{seq}` → `{ok}` | Monotonic per-user/room read cursor bounded by existing room sequence |
| POST `.../participants/:grant/moderate` | `{action:mute|remove|lower-hand|request-unmute}` | Host only, audit; provider mute; ban + revoke all user devices + retire all physical generations on removal; request never activates remote capture |
| POST `calls/:call/host` | `{userId}` → `{ok}` | Existing host only; current eligible live participant, no banned target |
| POST `calls/:call/end` | `{}` → `{ok}` | Host only, end timestamp durable/idempotent, revoke grants, provider room deletion; UI requests confirmation |
| GET `calls/:call/history` | call duration/outcome and observed per-device attendance | Current nonremoved membership; no private message/token content in audit |
| GET `calls/:call/chat` | `?before=seq` → retained main-room history,50/page | Ended call/current nonremoved membership; late joiners see retained history |
| GET `media/events` | `Last-Event-ID` / `?after` → SSE `media.changed` | Current cookie session revalidated each second; DB-backed10-stream/user quota, bounded output and10-second stream lease |
| POST `/v1/media/webhook` | raw `application/webhook+json`, signed Authorization | LiveKit JWT + body SHA256; provider ID primary-key dedup; only invalidates currently active generation, never revives lifecycle |

Meetings transition from created/ringing to active (live application grants plus independently observed provider connections), then terminal ended. The durable end timestamp is the terminal fence. Invitations independently transition pending→accepted/declined/missed/cancelled/busy; manual authorized joining is separate from accepting a resolved invitation. Participants progress authorized→connecting→media connected→reconnecting→departed/revoked. The SDK owns ICE/signaling and track state. Backend lease renewal alone does not count as actual attendance: active provider participants produce attendance intervals, closed on loss/replacement/revocation. Attendance measures provider-reported active device intervals, not human audibility or continuous RTP reception. Polling adds roughly2 seconds after the provider reports a change; provider transport grace may delay that report.

Event IDs are durable invalidation cursors, not an exactly-once command channel or a total database commit order. Replayed/delayed invalidations trigger a fresh authorized snapshot; SDK reconnect and SSE open trigger resnapshot. Fresh streams start at the current organization cursor and resnapshot immediately, avoiding historical refresh floods; an explicit Last-Event-ID/after cursor replays retained invalidations. With healthy SSE, directory/service polls run every15 seconds, invitation fallback every6 seconds and selected-call fallback every5 seconds; faster polling resumes after stream errors. Bounded polling remains a fallback for event gaps. Webhooks never directly apply lifecycle transitions, so delayed `room_finished` callbacks cannot end a newer room generation. Database constraints and call locks deduplicate chat and lifecycle races across API instances; media signaling remains entirely LiveKit's responsibility.

The browser keeps a per-tab device UUID and at most16 unacknowledged call-message intents in sessionStorage. Retry intents expire after24 hours, are scoped by actor/call/room, preserve immutable message IDs across refresh/rejoin, and clear on sign-out. No automatic send occurs on recovery. Multiple same-call devices are allowed; different calls are rejected. Refresh requires an explicit rejoin and never silently reactivates capture. Unexpected closure is handled by the25-second server lease, rather than depending on unload. A participant that never establishes media or remains absent from the provider for25 seconds expires even if an application heartbeat continues. Physical generation changes reconnect eligible survivors and close the previous attendance interval. Host departure selects earliest eligible nonexpired grant, then ends an empty meeting; brief loss retains hands and host until grace expires.

Self-hosted limitations: provider-refreshed tokens can retain earlier source permissions until reconciliation; sharing release/expiry enforcement is bounded by the2-second reconciler and does not promise instantaneous revocation under provider outages. Removal and termination use stronger physical-room deletion plus `room.auto_create=false`; this setting and a dedicated provider namespace are required deployment dependencies. During provider outages the application records revocation and exposes failure, while media enforcement resumes when trusted provider control recovers. Do not advertise outage-independent revocation or endpoint-only encryption.

## Local setup and verification commands

Compose's API startup applies checked migrations automatically, including037–038. For a separate installation, run `npm run db:migrate` with its `DATABASE_URL` before starting API and media-worker. Fresh local identity/data setup uses the repository's existing seed/identity procedure. Existing volume data is retained.

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml up -d --build --wait
npm run typecheck
npm run lint
npm test
npx playwright test tests/browser/team-calls.spec.ts tests/browser/meeting-protocol.spec.ts
```

Open http://localhost:3101 in separate browser profiles; use existing local Alice/Bob accounts (`alice@acme.test`, `bob@acme.test`, local-only password `Development123!`). Start from a profile or conversation, or select Calls→Meet now and invite eligible users. Copy the meeting link to the other signed-in profile; an unrelated tenant/account receives no access. Preview devices, choose initial mic/camera, and join. Use the grid/speaker layout, pin, share, chat, raise hand, participant moderation, Leave or host-confirmed End actions. Local overlay endpoints are loopback only: API4100, web3101, signaling7880, ICE TCP7881/UDP7882, authenticated UDP TURN3478 and relay40000–40100. TURN credentials are generated by LiveKit for authorized participants; no anonymous relay is configured.

Outside loopback: use trusted application HTTPS and LiveKit WSS/HTTPS, routable SFU ICE addresses, correctly opened UDP/TCP ports, authenticated TURN/TLS with a trusted domain certificate and a dedicated provider. Replace all development keys/passwords using server secrets; configure signed webhook delivery to the API, run the independent media-worker, and monitor its heartbeat. Restrict the TURN peer allow-list to the SFU network; the local config allows loopback only. No public infrastructure or paid services were provisioned.

Attendance/event retention and live-user lookup indexes are added by038. The API Docker image builds from the dependency layer rather than requiring a Next.js compilation; frontend production builds and type checks are still verified independently. The database lock regression test verifies event foreign-key checks can run while a lifecycle transaction holds its non-key update lock.

`infra/livekit/server.production.example.yaml` is a nondeploying provider template. Replace its key/secret/Redis settings, TURN domain and trusted certificate paths, webhook URL, and any exact private SFU peer allow-list. Point API/worker LIVEKIT_URL and LIVEKIT_API_URL at that same provider. Open the documented media/TURN ports and test a forced relay connection before enabling external calling. The example intentionally does not provision DNS, certificates or public infrastructure. `infra/livekit/server.yaml` remains loopback development only.

## Delivered status and remaining acceptance

Implemented means working code with the local checks below, **not** independent physical-device or production certification. Partial entries name the remaining limitation explicitly. No claim of full Microsoft Teams parity is made.

| ID | Status | Delivered / remaining |
|---|---|---|
| FE-01 | Implemented | Profile/conversation/group audio/video; Meet now invite UI, copy link, current ACL on link/join |
| FE-02 | Implemented | Caller/type, answer/decline/cancel, outcomes/busy, device-bound winner, authenticated events + fallback reads |
| FE-03 | Implemented | Camera preview, initial media choices, supported device controls, capture errors and preview teardown; physical device matrix pending |
| FE-04 | Implemented | Actual SDK tiles/avatars/mute/camera/speaking/quality, grid/speaker, local pin, connecting versus disabled video |
| FE-05 | Implemented | Actual track mute/camera/device settings, audio-only participation, SDK-derived remote indicators |
| FE-06 | Implemented | Explicit native browser capture, shared stage, shared-audio request where supported, application stop and capture-ended cleanup |
| FE-07 | Implemented | Persistent monotonic hand queue, own lower/raise, host lower, grace retention and final clear |
| FE-08 | Implemented | Persisted literal chat, deterministic pages/read cursors/unread, ACK/retry, refresh-safe immutable send journal |
| FE-09 | Implemented | Live device roster/roles, trusted mute/remove/host transfer, user-controlled unmute request and removal notice |
| FE-10 | Implemented | Independent group leave, direct hangup, confirmed host-only End, SDK/track/timer/subscription cleanup |
| FE-11 | Implemented | Outcomes/call again/details, provider-observed attendance, distinct meeting duration and retained authorized ended chat |
| FE-12 | Partial acceptance | Responsive390px fit and scoped axe checks pass; labels/keyboard/focus/confirmation/error states implemented. Physical permission/device errors and Firefox/Safari/OS accessibility matrix not independently accepted |
| BE-01 | Implemented | Separate lifecycle/invitation/connection state, transaction locks and uniqueness, terminal end fence, repeated operation behavior |
| BE-02 | Implemented | Authenticated durable event invalidations; first session/device acceptance, resolved ringing and serialized response/end operations |
| BE-03 | Implemented | Existing cookie/OIDC/current organization/channel ACL on API, tokens, chat and event stream; identifiers grant no access |
| BE-04 | Implemented | Trusted host checks, transfer, intentional/grace-based succession, no successor→end, persistent bans |
| BE-05 | Implemented | Server-provisioned generations,15-second least-privilege join tokens, current access renewal, signed raw-body callbacks and replay dedup |
| BE-06 | Implemented | SDK signaling, authenticated DB-backed app events, snapshot recovery and fallback polling; delayed callbacks cannot revive/end a new generation |
| BE-07 | Implemented | User/device/session separation, one active call/user, same-call multiple devices,25-second leases/media-loss expiry and attendance |
| BE-08 | Partial strict enforcement | Atomic one-owner screen lease, trusted source permissions, release/expiry cleanup. Self-hosted provider-refreshed tokens can briefly carry old source rights until2-second reconciliation; zero-window adversarial replay is not guaranteed |
| BE-09 | Implemented | Server sequence ordering, idempotent raise/lower, authorized host lower, grace preservation and departure/end clearing |
| BE-10 | Implemented | SQL persistence, client-ID dedup, deterministic sequence pages, persist-before-ACK, size/rate/call caps, read cursors,30-day access/retention policy |
| BE-11 | Implemented | Trusted media mute, ban/all-device revoke, physical-room retirement/deletion against unexpired token replay, audit, no forced remote unmute |
| BE-12 | Implemented | Metadata/invitations/outcomes/attendance/moderation audit and scoped history; tokens/chat bodies excluded from application audit logs |
| BE-13 | Partial production acceptance | Independent worker, leases, timeout/retry, cleanup/indexes, provider-outage503 and idempotent rejoin tested; long-running fault injection, load-at-limit and external network/TURN/TLS acceptance remain |

## Recorded verification — 0.1.126-local

- **Automated:**169/169 pass in `docs/evidence/core-final-0.1.126.txt`, including fresh migrations037–038, current ACL/tenant isolation, invitation winners, ordered/paged/deduplicated chat, host authorization/transfer, signed/replayed callbacks, concurrent event-FK/heartbeat locking, accept-versus-end races and provider-outage retry idempotency. A controlled provider RPC regression also verifies a delayed CreateRoom is serialized before end; creation holds the call lifecycle lock through the bounded provider operation, so it cannot follow a completed retirement. Test database is `concord_calling_verify_126`, separate from application data. An earlier run in the heavily reused `concord_test` timed out deleting old fixture users; a fresh isolated database passed and the unrelated cleanup timeout was not hidden or fixed by deleting existing data.
- **Build/checks:** production web/API images build; typecheck passes; lint exits0 with one preexisting unused eslint-disable warning in `notification-permission.tsx`. Evidence: `build-final-0.1.126.txt`, `build-web-final-0.1.126.txt`, `build-api-final-0.1.126.txt`, `typecheck-0.1.126.txt`, `lint-0.1.126.txt`.
- **Separate authenticated browsers with synthetic devices:** eight workflows pass together in `browser-media-final-0.1.126.txt`; a prior layout/protocol/profile rerun also passes3/3 in `browser-protocol-final-0.1.126.txt`. Actual LiveKit SFU tracks/received audio bytes/decoded video are verified, rather than simulated API success. Includes one-to-one audio/video, three-user group video, mute/camera, screen capture, ordered hands, chat retry/dedup/refresh/history, independent leave, explicit and automatic host transfer, unmute consent, host end confirmation, current membership/session revocation, unauthorized link/token/chat denial, still-unexpired10-minute token replay after removal, terminal join rejection and capture cleanup. The10-minute replay credential is a test-signed equivalent of a provider-refreshed token, using the synthetic local issuer; no production credentials are used.
- **Screen sharing:** browser capture is selected by Chromium automation, remote content dimensions are checked; application Stop passes. The browser-ended branch is exercised by stopping the captured track and dispatching its ended event. This verifies that cleanup path, not a human clicking an OS/browser Stop control. Physical shared-system-audio support remains unverified.
- **TURN:** forced `iceTransportPolicy:relay` passes with received audio, decoded remote video and `relay/udp` diagnostics in both sessions. Initial allocation succeeded but media failed until `rtc.enable_loopback_candidate=true` was enabled. This is authenticated loopback TURN, **not** cross-network or TURN/TLS acceptance. Google/default STUN and direct SFU ICE remain SDK/provider responsibilities.
- **Regressions:** existing breakout isolation, consented recording, downloaded MP4 audio/video decoding, fresh-call lifecycle, current authorization and mobile/scoped axe checks pass. These checks preserve earlier features; expanding recordings/breakouts was not part of this task.
- **Visual:** final pinned-speaker/toolbar screenshot `instant-meeting-0.1.126.png` inspected. Existing call screenshots and scoped axe/mobile checks also retained.
- **Blocked/unperformed:** independent physical devices, human-audible two-way audio, different external networks/NATs, public trusted WSS/HTTPS/TURN/TLS, Firefox/Safari/OS-specific capture/output/permission matrix, accessibility assistive-technology matrix, load at32 devices, and extended provider/DB/Redis outage testing. Required deployment steps and template are above. No paid infrastructure was created.

Acceptance A–D/F–M is verified locally with synthetic capture and the described SDK/API assertions; E includes actual capture plus a synthetic ended-event path; N verifies preview/published capture cleanup and disconnects. These results are not a substitute for physical-device and cross-network sign-off. Full independent-device end-to-end completion is **not claimed**.

## Important implementation files

- `services/core/media.ts`: existing call/grant routes extended for invitation winners, busy/outcomes, trusted moderation, renewal, terminal fences and shared room provisioning.
- `services/core/meeting-protocol.ts`: instant/profile workflows, authenticated event stream, verified callbacks, attendance, succession, share permissions, chat reads/history and cleanup.
- `services/core/media-config.ts`, `media-worker.ts`, `server.ts`: validated server-only provider configuration/limits, independent reconciliation and authenticated integration registration.
- `migrations/037_meeting_protocol.sql`, `038_meeting_cleanup_indexes.sql`: durable protocol records, constraints, event triggers, ordering and cleanup/history indexes.
- `app/components/media-workspace.tsx`, `meeting-panels.tsx`, `call-collaboration.tsx`, `workspace.tsx`, `app/globals.css`: connected meeting/prejoin/history/chat/profile/Meet now UI, supported controls and resource lifetime management.
- `lib/media-contracts.ts`, `lib/pending-call-chat.ts`: runtime response validation and bounded immutable retry storage with sign-out cleanup.
- `compose.media.yaml`, `infra/livekit/server.yaml`, `server.production.example.yaml`, `.env.example`: local SFU/Redis/TURN/workers and deployment templates. Keep the media overlay alongside the existing compose files.
- `tests/core.test.ts`, `tests/media-config.test.ts`, `tests/pending-call-chat.test.ts`, `tests/browser/meeting-protocol.spec.ts`, `team-calls.spec.ts`, `media.spec.ts`: API/transaction/security/unit tests and actual local SFU/browser acceptance.

For reproducible isolated API tests, set `TEST_DATABASE_URL=postgres://concord:local-development-only@localhost:55432/concord_calling_verify_126` and `TEST_FILE_ROOT=.data/calling-verify-126` before `npm test`; create this database first if absent. Browser tests use the loopback development application and synthetic local users in its normal database, creating their own conversations/calls. Run `caffeinate -i npx playwright test tests/browser/media.spec.ts tests/browser/meeting-protocol.spec.ts tests/browser/team-calls.spec.ts` on macOS to avoid idle suspension during acceptance; on other systems run `npx playwright test ...` with the host kept awake. Never point the isolated core suite at the application's database or configure its reconciler against a provider owned by a different database.

Final replay-load regression: fresh SSE streams tail the current cursor and resnapshot, while explicit reconnect cursors can replay. Historical replay previously triggered refresh floods and API429 responses; the failed run is preserved as `browser-media-quota-regression-0.1.126.txt`. The final eight-workflow run passes with the unchanged API quota; sanitized response counts are recorded in `api-load-0.1.126.json`. Live event delivery is additionally checked by counting actual authenticated `media.changed` events in the browser, not inferred from fallback polling.
