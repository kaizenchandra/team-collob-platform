# Camera background effects

Implemented on the published LiveKit camera track: original background (None), person/background segmentation with Blur, two built-in images, and validated custom raster images. Audio and screen-sharing tracks do not use this processor. No backend API, database migration, media provider, or paid infrastructure was added.

## Workflow and reference

Open **Background effects** in prejoin setup, or **Device settings → Background effects** during a call. Select None, Blur, a built-in image, or Upload image. Start local preview explicitly to try the selection on an independent, unpublished camera track. **Apply** changes the outgoing camera if it is on; otherwise it saves the choice for the next explicit camera-on action. **Cancel** destroys the preview and leaves the current outgoing effect unchanged. Closing settings or minimizing the call also closes the effects preview. Call controls remain outside the panel.

Microsoft's [background workflow](https://support.microsoft.com/en-us/teams/meetings/change-your-background-in-microsoft-teams-meetings) informed prejoin/in-meeting selection, custom images, preview and explicit application. [Accessible background selection](https://support.microsoft.com/en-us/accessibility/teams/use-a-screen-reader-with-backgrounds-in-microsoft-teams-meetings) informed named options and keyboard controls. Concord retains its own toolbar, typography, light surfaces, two bundled abstract images and account/workspace/device-scoped persistence. These choices are application-specific, not complete Teams parity or Teams defaults. Effects do not guarantee concealment of everything around a person.

The implementation follows the official [LiveKit video processor documentation](https://github.com/livekit/track-processors-js/blob/main/processor-docs/video-processors.md) and the installed `livekit-client@2.23.0` / `@livekit/track-processors@0.8.2` source. SDK lifecycle reference: [LocalVideoTrack](https://docs.livekit.io/reference/client-sdk-js/classes/LocalVideoTrack.html). References reviewed 2026-10-21.

## Processing and privacy

- Reuses LiveKit's MediaPipe segmentation, GPU mask/compositing, frame-stream wrapper, image cover/crop behavior and bundled runtime/model in `public/media`. Segmentation runs in the browser; camera frames are not sent to an external segmentation service. The processed outgoing video still travels through the existing LiveKit meeting transport.
- A guarded `BackgroundTransformer` emits only successfully segmented/composited frames. It replaces the SDK's raw-first-frame and raw-frame fallback paths. None explicitly removes processing.
- Blur/image switches reuse the same processor. They freeze processed output while preparing the new image, then resume with processed frames. They do not republish video, reconnect a room, change participant identity, restart audio or process screen-sharing video. Using SDK `setProcessor` to replace an existing processor was deliberately avoided because its cleanup restores the raw source as an intermediate step.
- A new camera receives its saved effect and produces a processed frame **before publication**, including rejoin and room-generation reconnection. SDK camera switches restart the same guarded processor. Camera Off unpublishes/stops the camera and processor; Camera On creates a fresh processed camera. None and camera-off preferences never enable capture by themselves.
- GPU/segmentation failure, failed initialization or an eight-second visible-page processing stall stops/unpublishes camera video and reports an error. Audio and sharing remain independent. The user must choose None/another effect and explicitly turn the camera on. Missing/corrupt preferences or inaccessible browser storage block camera publication until an explicit choice; they do not silently fall back to the original scene.
- Model initialization has a bounded UI timeout; late completion checks that the source camera is still live before attaching processing. Preview/call exit stop native capture immediately. The SDK finishes releasing initialization resources when an in-flight SDK load settles. An image fetch has its own eight-second timeout.
- Processing adapts between 5 and 15 frames per second; sustained slow frames produce a warning. The SDK's GPU segmentation still performs synchronous work on the browser thread. This is not a promise of smooth performance on every device; reduce camera quality, close the independent preview, or select None on slower devices.

## Images and preferences

Existing server file storage belongs to conversations, not private user media libraries. Custom backgrounds therefore remain in IndexedDB (`concord-camera-backgrounds`, key `organizationId:userId`) along with the selected preference. Nothing is silently posted to a conversation or external service. Choices/images are available only in this browser profile for that account/workspace; clearing browser data removes them. Local browser storage is not a security boundary against someone who controls that browser profile or DevTools.

Default limits: JPEG, PNG or WebP; 5 MB per file; minimum 320×180; maximum 4096 pixels per side and 8 megapixels; six images. Validate raster signature, decode, dimensions and still-image chunks; reject SVG, animation, corrupt/oversized/too-small inputs. Re-encode as a still JPEG with flattened alpha and no metadata, preserving aspect ratio and bounding the longest side to 1920. The processor uses cover cropping without stretching. Blob URLs and image bitmaps are released on removal/unmount/processor teardown.

Upload saves the image to the device library; applying it remains explicit. Removing the currently applied image switches the camera and preference to None **before deletion**. Failed storage writes are reported, with session-only behavior identified. The two bundled PNG backgrounds are original procedural artwork with a [CC0 dedication](../public/media/backgrounds/LICENSE.txt).

## Files and setup

- `app/components/background-effects.tsx`: selector, unpublished preview, IndexedDB hook, focus and keyboard behavior.
- `lib/background-library.ts`: choices, persistence, asset resolution, validation and configurable limits.
- `lib/camera-background.ts`: camera-only application, in-place switching and fail-closed timeout handling.
- `lib/safe-background-processor.ts`: guarded SDK transformer, processing-rate adaptation and resource lifecycle.
- `app/components/media-workspace.tsx`, `meeting-panels.tsx`, `call-meeting-surface.tsx`: published camera/prejoin/settings integration and panel cleanup.
- `app/globals.css`, `public/media/backgrounds/`: responsive styling and licensed built-ins.
- `Dockerfile`, `compose.local.yaml`, `.env.example`: optional build-time limits.
- `tests/browser/background-effects.spec.ts`, `tests/camera-background.test.ts`, `scripts/test-core.mjs`: media acceptance, validation/policy tests and unit-suite registration.

No new dependency installation or migration is needed. Existing model/runtime assets and the LiveKit setup in [MEDIA.md](MEDIA.md) are required. Use trusted HTTPS/WSS outside localhost.

Optional web build variables:

```dotenv
NEXT_PUBLIC_BACKGROUND_MAX_BYTES=5242880
NEXT_PUBLIC_BACKGROUND_MAX_IMAGES=6
NEXT_PUBLIC_BACKGROUND_MAX_DIMENSION=4096
```

The local Compose build forwards these values; direct Docker builds accept the same `--build-arg` names. Rebuild the web image after changing limits. Minimum dimensions, 8 MP ceiling, normalized longest side and processing-rate policy are centralized in the library/processor source.

```sh
docker compose -f compose.yaml -f compose.local.yaml -f compose.identity.yaml -f compose.storage.yaml -f compose.scanning.yaml -f compose.email.yaml -f compose.media.yaml up -d --build --wait web
npm run typecheck
npm run lint
node --import tsx --test tests/camera-background.test.ts
npx playwright test tests/browser/background-effects.spec.ts
```

Browser acceptance uses the loopback development API/database and creates isolated, private test users/workspaces using the existing seeded development password hash. It sends no email. Its fixture accounts/memberships are disabled after verification. The shared seed accounts remain unchanged. Development Postgres and the original seed identity must be available.

## Verification — 2026-10-21

- **Production build passed**, web container rebuilt and running on port 3101. Typecheck and `git diff --check` passed. Lint passed with the existing unused-disable warning in `notification-permission.tsx`; no new warnings/errors.
- **3/3 Node tests passed**: preference corruption recovery, scoped image resolution/no implicit raw fallback, and unsupported/forged/oversized upload rejection.
- **4/4 browser workflows passed in 52.3 seconds**, separate authenticated Chrome 155.0.8059.85 contexts with real local LiveKit media transport and Chromium synthetic cameras/microphones. [Full result](evidence/background-effects-browser.txt).
- Remote decoded pixels verify None → built-in → Blur → custom image, plus restoration. Blur reduced the sampled horizontal edge metric from approximately **1.54 to 0.56** on the synthetic source. This is an integration assertion, not a human-image quality benchmark. [Pixel measurements](evidence/background-effects-pixels.json).
- Private preview visibly differs from the still-original remote stream; Cancel leaves remote video unchanged. Applying effects retains the remote camera track identity, and received audio bytes continue increasing. Group verification uses three independent authenticated participants. Screen-sharing pixels remain unchanged by camera effect changes.
- Camera off/on, a supported fake camera-device switch, saved prejoin preference reload without camera activation, uploaded-image and preference restoration after refresh, unpublished-preview capture cleanup, uploaded-image removal/None fallback, invalid MIME/header/decoding/size/dimensions, unavailable support, injected GPU-context loss, missing model and unavailable preference storage all passed. Explicit recovery restores video; failure leaves audio connected. Leaving releases all instrumented native capture tracks.
- Additional isolated regressions passed: chat Audio/Video entry points, repeated-click deduplication, incoming Answer, Decline, outgoing Cancel, individual leave and host End. Accessibility checks returned zero scoped axe violations. Keyboard panel controls/focus and image choices are implemented; desktop 1280×720 and mobile 390×844 layouts were exercised, with screenshot inspection and reachable call controls/Apply/Cancel.

Screenshots: [local preview](evidence/background-effects-preview.png), [remotely received background](evidence/background-effects-remote.png), [desktop selector](evidence/background-effects-desktop.png), [mobile selector](evidence/background-effects-mobile.png). Green patterns are the intentional synthetic camera source, not product mock participants.

The initial shared-account test retry collided with another development call, so final acceptance used isolated fixtures and did not terminate unrelated meetings. A test assertion was also changed to await preference-save completion rather than counting a hidden preview element as active capture.

### Verification limits

Remote **browser/media transport and actual segmentation/compositing were verified**, with synthetic inputs and software-capable WebGL. Physical camera/person boundary quality, physical microphone audibility, real GPU/mobile performance, hardware unplugging, mobile keyboards, full screen-reader output and Edge/Firefox/Safari were not verified. Effects require runtime support for WebGL2 and modern video frame processing; unsupported browsers retain None with clear messaging. Independent public networks/TURN were not rerun for this feature; the existing [device acceptance gate](MEDIA-DEVICE-ACCEPTANCE.md) remains unchanged. These results do not replace independent physical-device acceptance.
