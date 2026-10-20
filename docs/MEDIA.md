# LiveKit media

Calls now use LiveKit for microphone/camera tracks, browser screen capture, host-controlled breakout rooms, microphone moderation and host transfer. The Calls view includes device selection, echo cancellation/noise suppression/gain controls, stereo music capture, codec/resolution/frame rate settings, supported-browser background blur and spatial playback, and sanitized RTC diagnostics downloaded on the local device. Browser/device support varies; these controls report capture failures rather than simulating success.

## Local development

Add `-f compose.media.yaml` to the existing compose command:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml up -d --build --wait
```

Open http://localhost:3101, select Calls, choose a conversation, start/open its call, choose capture and recording consent, and Join call. Starting a call does not capture devices. During a call, choose Apply audio/video settings after changing processing preferences. Meet in a conversation opens its call selection. Calls continue while navigating other workspace views; Leave stops local tracks immediately.

Host controls create up to eight breakout rooms, assign participants, close rooms and return participants to the main room, mute/remove others, transfer host and end the call. Removed participants cannot rejoin that call. Recording requires every current connection in the selected room to consent, including the host. Start recording rotates the provider room and reconnects participants before capture. Recording status is persisted and reconciled; an uncertain start is never automatically replayed. Stop and wait for Complete before downloading. Every current conversation member can download its recordings; downloads recheck current access and support byte ranges. Files are MP4 in the `media-recordings` volume, not public web assets.

The optional overlay runs pinned LiveKit, Redis, Egress and an independent authorization reconciler. Egress needs SYS_ADMIN for its Chrome sandbox per the upstream self-hosting instructions. All exposed media ports bind loopback. The checked-in credentials are local development credentials only. Do not expose this overlay directly to a network.

## External deployment and acceptance

Configure server-only `LIVEKIT_URL` (browser WSS), `LIVEKIT_API_URL` (server HTTPS), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (at least32 characters). Production rejects insecure URLs and local credential prefixes. Add `LIVEKIT_RECORDING_ENABLED=true`, `LIVEKIT_EGRESS_HEALTH_URL` and `MEDIA_RECORDINGS_ROOT` when deploying Egress; API and authorization worker need read access to the recording volume, Egress needs write access. Run `services/core/media-worker.ts` with the same database/authentication/provider configuration as API. Supply persistent storage, retention, encryption and a media-aware backup procedure. The existing coordinated backup explicitly refuses active calls or stored recordings because its format does not contain the recording volume.

Independent physical-device/external-network acceptance is **pending**. The local automated browser test uses two isolated users and synthetic capture streams against the real SFU and Egress; it is not independent hardware verification. Before recording device acceptance, test two separate physical devices on different networks with trusted application HTTPS, LiveKit WSS and routable UDP/TCP ICE plus authenticated TURN fallback. Check two-way audible audio/camera, screen/system-audio capture on each supported OS/browser, mute/device switching/permissions denial, reconnect/network loss, breakout isolation, recording playback and membership/session revocation. Record hardware, browser/OS, networks, ICE transport, results and sanitized diagnostics. Do not mark independentDevicesVerified true based on local automation.

## Authorization limits

Join JWTs expire after15 seconds, bind a per-device opaque identity to a physical room generation and do not allow administration/data publishing. Client authorization renews every5 seconds with a25-second lease. Both API and independent worker reconcile current workspace/channel/session access every2 seconds and remove unauthorized media participants. Self-hosted LiveKit does not immediately revoke issued tokens. LiveKit can refresh transport tokens during a connection; application-minted JWT lifetime alone is not a revocation guarantee. Removal now rotates physical room generations and deletes retired rooms; ending deletes the current room. LiveKit must run with room.auto_create=false so still-unexpired credentials cannot recreate a retired room. Surviving authorized users reconnect through a new room-scoped token. Ordinary lease/access/source-permission enforcement remains bounded by a working reconciler; a complete provider-control outage cannot guarantee immediate media termination. Health checks report media readiness independently of app health. Keep the provider dedicated to this deployment: reconciliation owns all `cc-<UUID>` rooms.

## Background processing assets

`public/media/vision` contains the WASM loader/runtime from pinned `@mediapipe/tasks-vision`0.10.14 (Apache2.0); copied from `node_modules/@mediapipe/tasks-vision/wasm`. The model is the official MediaPipe float16 selfie_segmenter version1:
https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

Model SHA256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`.
Assets are served locally so video processing needs no third-party model fetch at call time. LiveKit track processors are pinned in package-lock.json.

The calling workflow supports direct and group audio/video calls with incoming answer/decline banners and persisted missed/cancelled outcomes. Breakout announcements/timer scheduling, transcription/live captions and other Microsoft Teams features not listed here remain outside this release.


## Direct and group calls (0.1.125)

In Chat, open an existing direct conversation, group chat or team channel. Choose **Audio call** or **Video call** to call and join using the selected media mode. Audio calls start with the camera off; camera and microphone controls can be changed during the call. The Calls view also offers a conversation selector and call type, with a separate explicit Join step before capture. Create a direct/group chat using the existing Start direct message action and select participants before calling.

Authorized conversation members receive an **Incoming call** banner across workspace views, with Answer with audio, Answer with video (for video invitations), and Decline. Invitations expire after45 seconds. Unanswered direct calls end as missed; declining a direct call ends it. Group invitees can answer or decline independently. Leave from the final active device of either direct participant hangs up the direct call; Leave from a group call disconnects that participant. End call for everyone remains a host action. Call history displays initial mode, personal response and end reason. Incoming banners are visual; an audible ringtone, OS push/background calling and PSTN are not supplied.

Use **Raise hand / Lower hand** in the call toolbar. Room participants see the raised-hand queue and tile badge. Moving rooms clears the hand. **Call chat** exchanges literal text with participants in the current room; breakout messages stay in their breakout room. Messages persist on the server, with100 messages per deterministic sequence page while a session-bound live connection is authorized; earlier pages and unread counts are available. Chat is separate from the conversation timeline; its view and draft clear on leaving or moving rooms. Messages have4000-character client bounds, a10-per10-second per-user rate limit and10000-per-call cap. Ambiguous sends retain their immutable actor/call/room-scoped retry identity in sessionStorage for up to24 hours, across refresh and explicit rejoin. Retry is user initiated; sign-out clears the journal. Chat history is retained30 days; eligible nonremoved conversation members can read ended-call main-room history. Already accepted messages remain persisted in their original room.

The local media overlay and versioned app/worker image tags remain necessary alongside compose.local.yaml. No standalone compose.local.yaml-only media deployment is claimed. The supported conferencing cap is32 simultaneous connections per call, with up to100 invitation recipients. Independent physical hardware, cross-network ICE/TURN and browser/OS-specific screen/system-audio checks remain pending as described above.

## Meeting module0.1.126

See [the calling checklist, decisions, API contracts, references and verification report](CALLING-IMPLEMENTATION.md). Added profile calls, instant meetings and authorized links; prejoin camera preview; authenticated durable SSE; device-winner/busy invitation state; active speaker/pinning; one room sharing lease and trusted source permissions; ordered hands and host lowering; unmute requests; paged chat, read cursors and refresh-safe retries; host succession; confirmation before End for everyone; provider-observed attendance and ended history; verified/idempotent webhooks. Migrations037–038 add the protocol records and cleanup/query indexes. Existing recording/breakout behavior is retained; expanding it is outside this task.

Capacity can be lowered with MEDIA_PARTICIPANT_LIMIT (2–32), MEDIA_INVITATION_LIMIT (2–100), MEDIA_ACTIVE_CALL_LIMIT (1–32), identically on API and worker. Reconnect grace remains25 seconds with5-second renewal and server/worker reconciliation. Transient application heartbeat failures retry within grace; explicit authorization denial and expiry stop capture. Never-connected or persistently media-absent device sessions also expire despite application-only heartbeats.

Local TURN is authenticated UDP on3478, with40000–40100 relay ports and loopback-only peer allow-list. It is a local development configuration, not a public TURN/TLS deployment. The final verification report records whether forced relay succeeded; allocation alone does not establish media connectivity. External devices still require trusted HTTPS/WSS, routable ICE and TURN/TLS.


## Remaining-phase hardening0.1.127

Migration039 adds durable physical-room retirement. A sharing lease release, failed publication after claiming rights, or sharing lease expiry retires the current physical generation; all participants briefly reconnect with new room-scoped credentials. This prevents a previously refreshed screen-publishing token from bypassing the next sharing owner. Capture never restarts automatically. Delayed stop callbacks carry their original roomVersion and cannot release a newer lease. Provider permission updates and worker reconciliation use the same call lock. Failed deletion is retried durably and blocks a successful handoff. Host removal and recording generation changes clear obsolete sharing leases; host End also drains the call's retired generations. Existing recording segments are reconciled if a sharing retirement closes their physical room; continuous recording across a share-stop rotation is not supplied.

Run verification against the existing local deployment, sequentially:

```sh
TEST_DATABASE_URL=postgres://concord:local-development-only@localhost:55432/concord_calling_verify_126 TEST_FILE_ROOT=.data/calling-verify-126 npm test
npm run typecheck
npm run lint
caffeinate -i npx playwright test tests/browser/media.spec.ts tests/browser/team-calls.spec.ts tests/browser/meeting-protocol.spec.ts tests/browser/meeting-resilience.spec.ts
RUN_MEDIA_CAPACITY=1 caffeinate -i npx playwright test tests/browser/meeting-capacity.spec.ts
# Opt-in fault injection: no other meetings/tests should run; named local containers pause briefly.
RUN_LOCAL_MEDIA_FAULTS=1 node scripts/verify-media-faults.mjs
```

On systems without caffeinate, omit its `caffeinate -i` prefix and prevent sleep manually. The dedicated test database must already exist; create an empty disposable database with the same owner, rather than pointing tests at application data. API startup automatically applies migration039, and `npm run db:migrate` applies migrations for a manually launched API using DATABASE_URL. Use the complete compose command above to build/start API, web and all workers with matching0.1.127 image tags.

The32-device probe uses two authenticated users and32 distinct device identities, real SFU transport, synthetic microphones,31 remote peers per device, received-audio statistics and33rd-device denial. It is not32 independent people, a UI/video load test or a production performance guarantee. Fault injection pauses only the named loopback SFU/Redis/PostgreSQL development containers, resumes them in finally, and checks actionable failure, recovery, idempotent join and ended-call denial. Physical/external acceptance steps and a recording sheet are in [MEDIA-DEVICE-ACCEPTANCE.md](MEDIA-DEVICE-ACCEPTANCE.md).


If a fault probe is forcibly killed before its finally block runs, explicitly resume the named local containers with `docker unpause concord-collaboration-livekit-1 concord-collaboration-media-redis-1 concord-collaboration-postgres-1`, then check compose health. Do not run fault injection concurrently with tests, backups or meetings. Application database reads have a12-second client deadline in addition to the10-second server statement deadline; uncertain timed-out transaction connections are discarded.


## Call window

**Open call** opens a dedicated call window with pre-join setup; devices are captured only after Preview or Join. **Answer with audio/video** opens that window immediately and connects using the selected mode. Media controls, chat, participants and device settings stay in the window. **Minimize call** (or Escape) keeps the meeting connected; **Return to call** restores the window. Closing pre-join setup stops preview tracks. **Leave call** stops participation; host-confirmed End ends the meeting for everyone. Close the ended-call window to return to the directory. Incoming invitations remain accessible inside an open window.

The call stage now prioritizes remote video in direct calls, uses a group grid and separate shared-content stage, and keeps the toolbar visible while Chat, Participants or Device settings are open. Chat drafts, unread state and local view choices survive panel changes and authorized media reconnections. See [CALLING-UX.md](CALLING-UX.md) for implementation decisions, Teams references, verification and remaining device/browser checks.

## Camera backgrounds

Prejoin setup and in-call Device settings include **Background effects**: None, Blur, built-in images, and private device-local uploads. Preview uses an unpublished camera; Apply changes the real camera publication, and Cancel preserves the prior effect. Saved choices restore before a new camera is published, without enabling the camera automatically. A processing failure stops camera video until an explicit fallback is chosen. See [BACKGROUND-EFFECTS.md](BACKGROUND-EFFECTS.md) for storage/limits, setup, Teams/LiveKit references and separate-session remote-video verification.
