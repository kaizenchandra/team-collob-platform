# Embedded calling and profile interactions

## Decisions and implementation

Calls use the existing LiveKit media stack and trusted backend authorization. The Calls workspace remains mounted for the signed-in user and organization. Its call area is an ordinary region in the main application content, rather than a native modal dialog. Incoming invitations use an in-flow banner. Application header and navigation remain available.

Minimizing or navigating to another supported application view renders a compact dock through a portal from the same connected media component. Its microphone, camera and stop-sharing actions use the same media operations as the expanded controls, including background processing and failure handling. This creates no additional room, publication, playback or media subscription. Return to call clears search and restores the expanded layout. Participant and chat panels retain their existing state. Leaving and authorized host termination retain existing server checks and cleanup.

Continuity covers navigation inside the application. Browser refresh, changing signed-in identity/organization, closing a tab or navigating to another website are separate session boundaries; this change does not claim media survives a page reload.

Profile cards use the existing server-authorized workspace bootstrap directory (name, initials avatar, title when provided, email, workspace role and reported presence). No additional personal data API, external upload, directory guessing by display name, or fabricated job/department data is introduced. Chat headers resolve actual participant IDs through the existing authorized chat endpoint, with abort and scope checks. Users absent from the authorized directory receive only their already-visible name and an unavailable-details explanation; contact and calling actions are withheld. Directory presence reflects the last directory snapshot, while own-account presence uses the existing live presence provider.

One shared popover owner permits only one profile card/account menu at a time. Opening delay is 200 ms and closing delay is 180 ms. Cards are portaled outside scroll containers, clamped to viewport boundaries, kept above the visible meeting toolbar, and repositioned on scrolling/resizing. Pointer hover, focus, click/tap, Enter/Space, ArrowDown, Escape and outside dismissal are supported. Click pins a card until dismissal; pointer-only opening does not steal focus. Route changes and disappearing triggers dismiss obsolete cards and pending timers.

Cards appear on chat participant headers, message author names/avatars, workspace and team member lists, conversation participant management, call tiles and call rosters. Message and audio/video actions use existing conversation/call workflows. View profile expands the available authorized details in the card. The account menu provides profile/settings navigation, real presence updates (one-hour override), persisted theme changes, and explicit sign out. Hover never executes an account action.

## References

Reviewed official Microsoft documentation on 2026-10-21:

- [Find more information about a teammate](https://support.microsoft.com/en-us/teams/chat/find-more-information-about-a-teammate-in-microsoft-teams): hover and touch/select profile card entry points.
- [Profile cards in Microsoft 365](https://support.microsoft.com/en-us/outlook/profile-cards-in-microsoft-365): identity, contact details and contextual actions.
- [Use meeting controls](https://support.microsoft.com/en-us/teams/meetings/use-meeting-controls-in-microsoft-teams): accessible, consistent meeting actions and chat/participant panels.
- [Multitask during a meeting](https://support.microsoft.com/en-us/teams/meetings/multitask-during-a-microsoft-teams-meeting): continuing a meeting while using other application areas. This application's embedded view/dock and lack of call pop-outs are explicit product decisions from this task, not claims of identical Teams behavior.

## Local setup and verification

No migrations, new dependencies, credentials or environment variables are required. Use the existing local web/API/LiveKit deployment documented in the calling setup. Tests need the local services on web 3101, API 4100 and PostgreSQL 55432. The focused browser suite creates isolated development users/organizations and disables them afterward; it does not ring shared seed users.

```sh
npm run typecheck
npm run lint
npx playwright test tests/browser/embedded-calling-profiles.spec.ts tests/browser/background-effects.spec.ts
```

Verification results are recorded below after the final test run. Browser capture uses simulated microphone/camera inputs over actual local LiveKit connections. Physical cameras/microphones, independent physical devices, external networks, TURN relay, Safari and Firefox require separate verification.

## Important files

- `app/components/media-workspace.tsx`: embedded call region, shared-room dock controls, nonblocking incoming and terminal call status.
- `app/components/call-meeting-surface.tsx`: compact audio gallery and participant profile triggers.
- `app/components/profile-popovers.tsx`: shared delayed, viewport-positioned popover primitive, authorized profile cards, chat header identities and account dropdown.
- `app/components/workspace.tsx`: account/menu wiring, stable media owner, search return behavior and message/directory triggers.
- `app/components/team-members.tsx`, `membership-panels.tsx`, `chat-management.tsx`: member and participant entry points.
- `app/globals.css`: embedded stage sizing, dock, audio layouts, responsive controls and profile presentation.
- `tests/browser/embedded-calling-profiles.spec.ts`: isolated authenticated acceptance tests. Existing call/window/background test selectors now target the embedded region.

## Verification results

- Production Docker web build and TypeScript check passed.
- ESLint passed with one pre-existing unused-disable warning in `notification-permission.tsx`.
- Seven browser acceptance tests passed together: four existing background/calling regressions plus three new embedded calling/profile tests. The final focused run passed all three tests in 16.2 seconds, including termination while navigating away and mobile profile cards remaining above the call toolbar.
- Actual local LiveKit media with simulated Chrome camera/microphone inputs: one-to-one audio/video initiation, answer/decline/cancel, three-person audio/video, decoded remote video and received audio bytes, microphone changes observed remotely, stable camera track identity through navigation/search/docking, background processing, device recovery, independent leave, host end and stopped capture tracks.
- Profile/account interactions: correct identities under rapid hover switching, pointer transfer into cards, click, Enter, Tab focus, Escape restoration, outside dismissal, viewport bounds, touch tap, persisted light/dark theme, real presence changes, profile/settings navigation, explicit sign-out, and profile-card Message/Audio call/Video call actions targeting the intended participant.
- Automated axe checks on the popover and existing background/call surfaces passed.
- Screenshots inspected at desktop 1280×800 and mobile 390×844: `evidence/embedded-call-desktop.png`, `evidence/embedded-call-mobile.png`, `evidence/profile-card-desktop.png`, `evidence/account-menu-mobile.png`. Green camera test patterns are simulated capture, not physical-camera verification.
- Unverified: physical microphones/cameras, separate physical devices, cross-network/TURN relay, Safari/Firefox, and reconnect behavior under a new external outage. Existing reconnect/media backend behavior was preserved.
