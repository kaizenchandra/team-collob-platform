# Calling interface improvements

The call window uses the existing authenticated LiveKit integration, persisted meeting state, room grants, chat, invitation delivery and trusted moderation APIs. No backend contracts, database migrations or media stack were replaced. Existing recording and breakout controls remain available in Device settings and Participants respectively.

## Findings and implemented changes

- The active meeting was a long scrolling card: controls and participants could disappear below settings and diagnostics. The window now has a separate meeting stage, side panel and persistent toolbar. Shared content receives its own stage with a thumbnail strip.
- Local and remote video had equal prominence during direct calls. Remote video now takes the main area, with a compact local preview; groups use an adaptive grid. Active-speaker view and local-only pins remain available. Camera-off avatars, speaking indicators and actual microphone/camera status come from SDK participants. Enabled cameras without a received track say video is connecting or unavailable.
- Controls were scattered across the page. The toolbar provides labeled microphone, camera, sharing, hand, participant, chat and settings actions. Leave is separate from host-only End, which requires confirmation. Pending capture and device actions prevent repeated operations. Device selections commit only after SDK success.
- Hidden chat could be marked read, and room-generation changes remounted UI state. Chat now stays mounted while closed, reports unread counts, retains drafts and retries, and follows incoming messages only when already near the bottom. Authorized media reconnection preserves panels, layout and pins. Room changes still isolate chat history as required by existing policy.
- Camera capture failure could fail the whole connection. Each requested device now fails independently with recovery instructions; audio participation can continue with the camera off. Audio calls do not start a camera. Cancelling the native share picker reports that sharing was not started and makes no server publication claim.
- A reconnect banner could remain after a successful connection. Actual connected events now clear it. Unmute requests appear above the stage without covering call controls.
- Mobile panels occupy the stage area while the toolbar stays accessible. Opening panels does not unmount media. Minimize/Return preserves the active call while navigating existing workspace views. Full page reload still uses the established rejoin flow.
- Panels focus their heading, Escape closes the panel and returns focus, toolbar arrow/Home/End navigation is supported, end confirmation traps/restores focus, and focus rings and text labels supplement color. Local camera video is mirrored; presentation video is never mirrored. Reduced motion and safe-area padding are respected.

## Reference behavior and application decisions

Official Microsoft Teams sources reviewed on 2026-10-21:

- [Use meeting controls](https://support.microsoft.com/en-us/teams/meetings/use-meeting-controls-in-microsoft-teams): consistent meeting controls and chat/people panels.
- [Use video](https://support.microsoft.com/en-us/teams/meetings/use-video-in-microsoft-teams): gallery, self-preview and personal pinning. The [official gallery screenshot](https://support.microsoft.com/en-us/teams/media/galleryview.png) was inspected as a visual reference.
- [Present content](https://support.microsoft.com/en-us/teams/meetings/present-content-in-microsoft-teams-meetings): prominent content, presenter identity and explicit sharing controls.

Application decisions: retain Concord's light surfaces, typography, tokens and icons; use a bottom toolbar and full-screen stage panels on mobile; prefer remote video in two-person meetings; preserve existing membership checks and one-active-call policies. These are application choices, not claimed Teams defaults or complete Teams parity. The browser still owns source selection and sharing permissions. Existing server generation retirement may briefly reconnect media when screen sharing stops.

## Files

- `app/components/call-meeting-surface.tsx`: stage, tiles, panels, toolbar, confirmation and keyboard behavior.
- `app/components/media-workspace.tsx`: SDK binding, media failure recovery, device switching and call-window integration.
- `app/components/call-collaboration.tsx`: panel visibility, unread tracking and scroll continuity.
- `app/components/workspace.tsx`: duplicate launch prevention and chat/profile call entry points.
- `app/globals.css`: responsive call layouts and accessibility states.
- `tests/browser/calling-ux.spec.ts`, `call-ui.ts` and existing calling specs: focused UX acceptance and panel-aware regressions.

## Local setup and verification

Use the existing environment and media setup in [MEDIA.md](MEDIA.md). No new environment variables or migration are required. With the local stack configured:

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml up -d --build --wait
npm run typecheck
npm run lint
npx playwright test tests/browser/calling-ux.spec.ts tests/browser/call-window.spec.ts tests/browser/team-calls.spec.ts tests/browser/meeting-protocol.spec.ts tests/browser/meeting-resilience.spec.ts tests/browser/media.spec.ts
```

Open `http://localhost:3101` in separate signed-in browser profiles with eligible workspace members. Start Audio/Video from a conversation or profile; Answer on the other profile. Open a listed call to use prejoin preview/device setup. Use Chat/Participants/Device settings without leaving, and Minimize/Return for workspace navigation. Test host End separately from individual Leave.

Verification results and limitations are recorded below. Screenshots in `docs/evidence/calling-ux-*.png` use Chromium synthetic devices; green test patterns are intentional media sources, not production UI or fake participants.

Physical-device and public-network acceptance remains the separate [independent-device checklist](MEDIA-DEVICE-ACCEPTANCE.md). This change does not assert hardware audibility, external-network acceptance, or full browser parity.

## Actual verification — 2026-10-21

| Category | Result |
|---|---|
| Production build | Docker web build passed with Next.js compilation and TypeScript validation; rebuilt web container started healthy on port 3101. |
| Static checks | `npm run typecheck` and `git diff --check` passed. `npm run lint` passed with one existing unused-disable warning in `notification-permission.tsx`; no lint errors. |
| Browser regressions | **15/15 passed, 3.7 minutes**, sequential Chrome runs against the local API/Postgres/LiveKit stack. [Full output](evidence/calling-ux-browser.txt). |
| Targeted scroll check | **1/1 passed, 16.1 seconds**, after adding long-history assertions: incoming messages preserve scroll position and remain unread while the user reads older messages. [Output](evidence/calling-ux-scroll.txt). Application source was unchanged after the full suite. |
| Actual browser/media transport | Separate authenticated cookie sessions for Alice, Bob and Sam. Direct audio/video, three-person audio/video, decoded remote video, positive inbound audio RTP statistics, actual mute/camera publication changes, sharing, independent leave, host termination and capture cleanup passed. Inputs were Chromium synthetic camera/microphone sources, not physical hardware. |
| Invitations and access | Chat/profile entry points, incoming Answer, Decline, outgoing Cancel, missed calls, authorized links, cross-organization denial, trusted mute/unmute request, removal/re-entry denial, host transfer and host-only End passed. |
| Continuity and errors | Panel toggles and Minimize/Return preserve live capture track IDs; camera denial/busy-device recovery retains audio; drafts survive panel changes and room-generation retirement; lost chat ACK retries deduplicate; metadata failures show errors; temporary authorization loss cannot revive an ended meeting. |
| Sharing | Actual browser capture path and remote video, app Stop, concurrent share denial and provider-generation retirement passed. Picker cancellation was injected as a DOM exception and made zero share claims. Browser-stop handling was tested by stopping the capture track and dispatching its ended event, not by manually clicking native browser chrome. |
| TURN | Forced local relay verified decoded video, positive received audio and `relay/udp` transport. This is a loopback/local TURN test, not cross-network or TURN/TLS acceptance. |
| Responsive/accessibility | Desktop 1280×720 and 1280×900; tablet 834×1112; mobile 390×844 and 360×740. Tested accessible toolbar/panel navigation, focus restoration, end confirmation, no page horizontal overflow, visible primary controls with mobile panels, and zero scoped axe violations in exercised call surfaces. Screenshots inspected after implementation. |
| Hardware and browser limits | Physical microphone/camera audibility, OS-level device unplugging, manual native sharing-stop controls/shared audio, mobile keyboard/notch behavior, screen-reader output, Edge/Firefox/Safari and independent public networks were not verified. Autoplay recovery remains wired to LiveKit's audio playback state but was not exercised under a real browser autoplay block in this run. |

The initial regression run exposed an old assertion that expected pinning to reset on room retirement, plus a test race against a video element being replaced during reconnection. Tests now assert pin continuity and wait for current decoded media. The complete rerun above passed; no backend/media-policy changes were made to bypass these checks.

Inspected screenshots: [direct desktop](evidence/calling-ux-desktop.png), [mobile](evidence/calling-ux-mobile.png), [group](evidence/calling-ux-group.png), [chat](evidence/calling-ux-chat.png), [presentation with thumbnails](evidence/calling-ux-sharing.png).
