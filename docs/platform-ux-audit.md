# Platform UX audit — 2026-10-21

Stack: Next.js 16.4 / React 19.3 client workspace, existing CSS tokens and Lucide icons, Fastify/PostgreSQL APIs, authenticated SSE updates, scoped identity/membership and LiveKit media. Application sections use local React state; conversation identity already uses native history URLs. Media ownership stays in the mounted workspace rather than section panels. Existing unrelated work is preserved.

## Prioritized implementation checklist

| Severity | Reproduced gap / affected screens | Fix | Verification criterion |
| --- | --- | --- | --- |
| P1 | Mobile conversation drawer obscures destinations and remains open after Escape | Shared dismissal, reuse existing close control, backdrop, focus return and route cleanup | Keyboard/touch/outside dismissal; navigation reveals selected screen |
| P1 | Native Escape closes a busy modal even when its controlled close callback refuses | Prevent native cancellation; restore trigger focus on actual unmount | Busy meeting save survives Escape; normal close still works |
| P1 | Chat shell can push composer below short/zoomed viewports | Bounded history, compact optional formatting and independently scrolling context | Composer and send reachable on portrait/landscape and reduced viewport |
| P2 | No new-message action or preserved reading position on chat return; prepend can shift history | Shared timeline viewport memory, anchor restoration and explicit latest-message action | Incoming messages do not move history readers; latest follows when appropriate; retries do not inflate counts |
| P2 | Selected navigation and conversation tabs lack announced state; browser section navigation lacks context | Accessible current/selected states and workspace-scoped history handling | Back/Forward restores authorized conversation/section without resetting drafts or media |
| P2 | Touch actions have small targets, contextual panels compete for narrow width | Shared focus/target rules and responsive panel/composer constraints | No inaccessible actions or horizontal page overflow |
| P2 | Calendar current-time line has a prohibited aria-label on a generic element | Meaningful named image semantics including active timezone | Calendar accessibility scan passes |
| P1 | Workspace-keyed popover provider remounts settings and discards unsaved global profile edits | Scope popover selection rather than keying the application subtree | Workspace-switch regression retains unsaved profile text and rejects late presence snapshots |
| P2 | Delayed hover-card closing can dismiss a subsequently opened menu | Conditional dismissal by trigger identity and current directory scope | Moving from a profile card to the account menu leaves the new menu open |
| P2 | Chat history failures lack an explicit retry; delayed reads can overwrite newer snapshots | Scoped/versioned reads, visible loading/error/empty states and retry | Fault injection recovers without displaying another conversation's history |
| Regression | Calls, background effects, calendars, pickers, profiles, organization, notifications and settings already have implementations | Reuse current APIs/components; targeted verification, no stack replacement | Existing focused tests plus separate-session media tests pass |

Baseline browser audit: Chat, Teams, Calendar, Organization, Activity, Settings and Calls at 1366×768 and 390×844. No document horizontal overflow in these samples. Scoped Axe found the desktop calendar current-time violation. The mobile drawer remained visible after section navigation and Escape. Baseline screenshots are temporary audit artifacts; verification evidence is under `docs/evidence`.

## Reference behavior and application decisions

Reviewed official Microsoft guidance and its linked screenshots:

- [Chat and channel navigation](https://support.microsoft.com/en-gb/teams/teams-channels/explore-the-new-chat-and-channels-experience-in-microsoft-teams): clear selected context, filters and readable conversation lists.
- [Keyboard conversation navigation](https://support.microsoft.com/en-us/teams/teams-channels/navigate-conversations-with-the-keyboard-in-microsoft-teams): accessible movement between navigation and conversation areas.
- [Calendar customization](https://support.microsoft.com/en-us/teams/meetings/customize-your-calendar-in-microsoft-teams): clear active dates, view choices and filtering.
- [Meeting controls](https://support.microsoft.com/en-us/teams/meetings/use-meeting-controls-in-microsoft-teams): persistent core controls, bounded contextual panels and separate leave/end actions.
- [Profile cards](https://support.microsoft.com/en-us/outlook/profile-cards-in-microsoft-365): explicit contact actions and concise authorized identity details.

These are interaction references, not feature-parity claims. Branding, role checks, retention, media grants and invitation policies remain application-owned. No Microsoft assets are bundled. Reporting assignments still require an approved directory source; existing unknown assignments are not fabricated.

## Delivered shared changes

The checklist fixes above are implemented. The application keeps its existing brand, APIs, permissions and media stack. No new dependencies, schema changes or environment variables are required.

- `app/components/conversation-sidebar.tsx`: responsive drawer behavior, outside/Escape dismissal, focus entry/return and listener cleanup. Primary navigation dismisses obsolete drawer state.
- `app/components/conversation-timeline.tsx`: follows new messages when already at the latest, preserves history readers, counts unique incoming messages, provides an explicit latest-message action and anchors prepended history. Viewport memory is bounded to 24 identity/workspace/conversation keys and stores positions/IDs, not message bodies.
- `app/components/composer-formatting.tsx`, `workspace-viewport.tsx`, `app/globals.css`, `app/layout.tsx`: optional formatting on compact screens, bounded conversation history, independently scrolling draft/context content, usable touch targets and visual-viewport handling for focused text fields. Zoom is not disabled. A sticky draft toolbar was removed after it obscured formatting controls when reply/file context increased height; draft scrolling remains explicit.
- `app/components/workspace.tsx`: native section/conversation/tab history, current/pressed navigation semantics, accessible context panels, scoped history retries and cancellation of obsolete earlier-page reads. Navigation reuses the existing draft-save guard. Calls remain owned by the continuously mounted media component.
- `app/components/primitives.tsx`: native dialog cancellation respects controlled close/busy behavior; actual closure restores a connected trigger or main-content focus.
- `app/components/profile-popovers.tsx`: scope-aware popovers without application remounts, guarded delayed dismissal and announced loading/unavailable/actual account presence. Fetch permissions remain server-authoritative.
- `app/components/calendar-canvas.tsx`: correctly named current-time semantics with the active timezone.
- `tests/browser/platform-ux.spec.ts`: focused drawer, navigation/draft, scroll/anchor, stale read, modal, viewport, popover-race, error-recovery and accessibility regressions. Presence and team-member tests now target the current account workflow and message region rather than ambiguous sidebar previews.

Browser Back/Forward is supported within the current workspace and restores an authorized conversation/section/tab. Changing workspace/account retains the existing resource-bound media cleanup policy; cross-workspace browser history reloads the destination rather than carrying an old media grant into another organization. Search filters and server permissions continue to govern what can be opened.

Draft text follows the existing server autosave/acknowledgement policy (600 ms debounce). Supported section navigation preserves the in-memory draft; durable reload checks wait for successful server persistence. Instant closure before autosave or a failed server save is not claimed lossless. Failed/unconfirmed messages still retry the original immutable request identity. Loaded timeline positions are session memory, not a replacement for server-paginated history after a full reload.

## Verification results

Completed local verification on 2026-10-21:

- Production web Docker build passed. TypeScript passed. ESLint passed with the pre-existing unused-disable warning in `notification-permission.tsx`. `git diff --check` passed.
- `npm test` passed **188 tests**, with zero failures or skips, using `concord_test`.
- **39 distinct Chrome browser workflows passed across focused runs**: 25 platform/attendee/calendar/composer/filter/draft/profile/media/organization/notification/presence cases, four background-effects/direct-call cases, nine team/file/reply/saved-message cases and the additional delayed-popover-dismissal regression. This is not a claim that every browser spec in the repository ran.
- Shared-screen scans covered Chat, Teams, Calendar, Organization, Activity, Settings and Calls at 1366×768 and 390×844. Scoped Axe scans passed, including the repaired current-time line, account presence, reply/composer controls and organization view.
- Chat geometry/screenshots covered 1366×768, 390×844, 844×390, 640×400 and 320×568, contextual panels, long names, 200% CSS zoom and a simulated 430 px visual viewport. Both focused input and Send fit during keyboard emulation; no document horizontal overflow was found. Screenshots are `docs/evidence/platform-chat-*` and were visually inspected.
- The existing meeting viewport acceptance case passed independently: 1920×1080, 1440×900, 1366×768, 1024×600, 834×1194, 1194×834, 390×844, 844×390 and 360×740, plus compact/zoom-equivalent layouts. It checked gallery pages, pinning, independent panels, wide/tall sharing, reconnect and continuing media reception without a scrolling camera stage.
- Separate authenticated browser contexts exchanged actual encoded audio/video through local LiveKit with **simulated camera/microphone inputs**. Direct audio/video, three-user group calls, accept/decline/cancel, moderation, leave/end, dock/navigation continuity and remote effects were exercised. Browser-native desktop capture was automated for sharing; tall-content coverage also used a test canvas stream.
- Background checks verified remote blur, built-in/custom image output, original-background restoration, private preview/cancel, camera switching/lifecycle, unsupported/storage/model failures and fail-closed recovery. Scanned-file reply tests used the existing real local scanner/storage services with `TEST_SCANNING=true`; attachment-picker fault tests intentionally simulated failed/malformed responses.
- A large combined run hit the existing shared API rate window (HTTP 429 confirmed in the network trace). The media viewport case passed in isolation with limits unchanged. A later accessibility scan stalled while closing Axe's temporary browser page; that scan and a timing-affected reply recovery case both passed independently. Genuine failures found during checks—busy Escape, provider remounts, hover dismissal races and obscured draft controls—were fixed and rechecked.

Relevant commands:

```sh
npm run typecheck
npm run lint
npm test
npx playwright test tests/browser/platform-ux.spec.ts
npx playwright test tests/browser/meeting-viewport.spec.ts
npx playwright test tests/browser/background-effects.spec.ts
TEST_SCANNING=true npx playwright test tests/browser/reply-drafts.spec.ts
```

These use the existing local API/web/database/LiveKit/storage/scanner deployment; do not disable production rate limits to run browser batches. No paid services were provisioned.

## Remaining dependencies and unverified checks

- Physical cameras/microphones, separate physical devices, cross-network/TURN relay and other browser engines were not verified.
- CSS zoom, reduced layout dimensions and a synthetic visual viewport were checked; native desktop-browser zoom and a physical mobile keyboard were not. No zoom restriction was added.
- Organization rendering is connected to authorized database records, but production reporting assignments still require the approved directory source described in `organization-hierarchy.md`.
- This is a verified shared UX improvement pass, not Microsoft Teams feature parity or certification of every optional provider in the application's existing limited release.
