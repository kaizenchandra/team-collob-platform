# Bounded meeting layout

## Changes and overflow causes

The previous camera stage used `overflow:auto`, an auto-fit grid, width-driven aspect ratios and fixed minimum video heights. Additional rows could exceed the available height. The wrapping mobile toolbar consumed several rows, panels hid the stage on narrower screens, and meeting history occupied space below the call controls.

The meeting now has a compact header, a shrinking media region and a separate persistent toolbar. All intermediate flex/grid containers have explicit shrinking constraints. A ResizeObserver measures the actual gallery viewport after navigation, controls, banners and panels take their space. The application also follows `visualViewport.height` while an expanded call is active, accommodating keyboard/browser viewport changes without changing the media connection.

The measured gallery chooses up to 12 tiles per page, using a preferred minimum cell of 176×124 CSS pixels and falling back to one participant in a tighter space. These are application decisions, not Teams defaults. The final partial row is centered. Stable participant identity order is retained in Gallery; speaking does not reorder that view. Local pinning and Active speaker deliberately feature one participant, with bounded paged thumbnails. Two-person video uses a primary remote tile and a compact adjacent local preview; camera-off/audio meetings use the regular balanced avatar gallery.

Previous/Next controls show the current page, page count and participant count. All participants remain reachable when the capacity changes. Off-page camera components stay mounted under their stable identity keys. Audio playback lives outside paged tiles and stays mounted independently. No page or panel operation joins a new LiveKit room, republishes the camera or starts duplicate audio. LiveKit's existing adaptive streaming may pause hidden incoming video data and resume it when visible; it does not stop the outgoing camera or off-page audio.

Shared content uses `object-fit:contain` and a complete bounded presentation region. A paged participant strip sits below it, or alongside it in a short workspace. Stopping a share restores the selected gallery/speaker mode. Chat, roster, moderation, device/effect settings and history scroll independently inside their panels. In portrait layouts panels share the workspace with the stage; short workspaces use side-by-side panels. The stage is not hidden when a panel opens.

Microphone, camera, share, More and Leave remain in the compact toolbar. Wider layouts also expose hand, participants, chat, device settings and host end directly. More provides secondary actions at narrower widths, including the authorized host end action. Pointer/focus tooltips, visible focus, real media state, pending/disabled states and existing end confirmation remain supported. Camera-off and connecting states are distinct; long names truncate visually while retaining accessible names.

## Important files

- `app/components/call-meeting-surface.tsx`: measured/paged gallery, speaker and one-to-one layouts, independent audio sinks, compact toolbar and bounded panels.
- `lib/meeting-layout.ts`: pure grid fitting and partial-row positioning.
- `app/components/media-workspace.tsx`: keyboard viewport sizing and moving active meeting history into More.
- `app/globals.css`: bounded stage/media constraints, panel layouts, compact controls, safe areas, camera thumbnail sizing and reduced-motion behavior.
- `tests/meeting-layout.test.ts`, `tests/browser/meeting-viewport.spec.ts`: grid invariants and authenticated live-media/browser acceptance.
- `tests/browser/call-ui.ts`: existing test helpers follow secondary controls through More when needed.
- `scripts/test-core.mjs`: includes the new grid tests.

No new dependencies, server APIs, migrations, environment variables or media credentials are required. Existing uncommitted calling/profile changes were preserved.

## References

Official documentation reviewed on 2026-10-21:

- [Customize your meeting view in Teams](https://support.microsoft.com/en-us/teams/meetings/customize-your-meeting-view-in-microsoft-teams): local pinning, presentation priority and explicit gallery pages.
- [Use meeting controls in Teams](https://support.microsoft.com/en-us/teams/meetings/use-meeting-controls-in-microsoft-teams): readily available core controls and More overflow for secondary actions.
- [Use video in Teams](https://support.microsoft.com/en-us/teams/meetings/use-video-in-microsoft-teams): gallery/speaker views and camera-off identity presentation.
- [LiveKit track subscriptions and adaptive streams](https://docs.livekit.io/transport/media/subscribe/): track attachment and visibility-based video optimization. Existing SDK signaling, authorization and media ownership are retained.

The bottom toolbar, 12-tile cap, minimum cell dimensions, panel breakpoints and visual styling are application-specific adaptations. This does not claim Teams feature parity.

## Verification

Commands:

```sh
node --import tsx --test tests/meeting-layout.test.ts
npm run typecheck
npm run lint
npx playwright test tests/browser/meeting-viewport.spec.ts
npx playwright test tests/browser/background-effects.spec.ts tests/browser/embedded-calling-profiles.spec.ts
```

Local browser tests require the existing web/API/PostgreSQL/LiveKit services. They create isolated authenticated users and organizations and disable them afterward. Camera/microphone inputs are simulated Chrome devices; calls and remote media transmission use the actual local LiveKit service. Tall shared content uses a test-only animated canvas stream published through the real screen-sharing path. Wide sharing also exercises Chrome's automated native desktop capture.

Production web build, TypeScript and ESLint passed (ESLint retains one pre-existing unused-disable warning in `notification-permission.tsx`). All three grid unit tests passed. Four existing background/calling browser regressions and three embedded/profile regressions passed across runs; the account test was rerun separately after the combined run hit the local authentication rate limit. The final expanded viewport/media browser acceptance test passed in 43.9 seconds (44.6 seconds including setup/reporting), including one-to-one camera-on/camera-off layouts and continued audio after both cameras were disabled. Geometry checks read viewport, tile and caption bounds coherently in one browser evaluation and wait for ResizeObserver layout updates. Evidence is stored as `docs/evidence/meeting-fit-WIDTHxHEIGHT.png` and `meeting-share-WIDTHxHEIGHT.png`. Screenshots of representative laptop, portrait, landscape, screen-sharing, two-party and avatar layouts were visually inspected.

The viewport matrix covers 1920×1080, 1440×900, 1366×768, 1024×600, 834×1194, 1194×834, 390×844, 844×390 and 360×740. Additional checks use a compact 390×500 stage with real pagination, a simulated 430px visual viewport, 640×400 as a 200%-zoom-equivalent layout and a larger root font size. The latter are emulations, not physical-mobile-keyboard or browser-toolbar zoom verification.

Browser assertions measure the main workspace, call region, stage and gallery for overflow; verify every visible tile stays within the gallery bounds; check essential controls stay in the viewport; page through all three live users; retain the same outgoing camera track ID; exercise pin/unpin, panels and chat drafts; send/receive persistent chat; host-mute and self-unmute; raise/lower hands through More; verify keyboard focus restoration; fit wide/tall screen content; and confirm remote audio/video reception, fresh remote frames after a browser-context network interruption, two-party primary/local-preview layouts, continued audio with both cameras off, and host termination. Grid unit tests cover counts through 100; live browser media verification uses three users and exceeds capacity in compact layouts.

One-to-one camera-on and camera-off snapshots additionally cover 1366×768, 390×844 and 844×390 (`meeting-pair-*` and `meeting-avatars-*`).

Not verified: physical cameras/microphones, independent physical devices, cross-network/TURN relay, Safari/Firefox, translated application strings, and physical mobile browser/keyboard behavior. Extremely constrained viewports cannot make all content readable at once; the layout reduces the visible participant count and preserves navigation rather than adding a camera-stage scrollbar.
