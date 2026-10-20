import { Track, type LocalVideoTrack } from "livekit-client";
import type { BackgroundChoice } from "./background-library";
/** Only called for camera tracks. Raw media is never published while a requested effect initializes. */
export async function applyCameraBackground(
  track: LocalVideoTrack,
  choice: BackgroundChoice,
  image: string | undefined,
  onFailure: (message: string) => void,
  onSlow: () => void = () => {},
) {
  if (track.source !== Track.Source.Camera)
    throw new Error("Background effects apply only to camera video.");
  if (choice.kind === "none") {
    await track.stopProcessor();
    return;
  }
  const { createSafeProcessor } = await import("./safe-background-processor");
  const fail = () => {
    track.stop();
    onFailure(
      "Background processing failed. Camera stopped to protect your surroundings. Choose None or another background, then turn your camera on.",
    );
  };
  let cleanup: (() => Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = (async () => {
      if (track.isStopped) throw new Error("Camera stopped.");
      const existing = track.getProcessor();
      if (existing) {
        if (
          existing.name !== "concord-camera-background" ||
          !("setBackground" in existing) ||
          typeof existing.setBackground !== "function"
        )
          throw new Error(
            "Another camera processor is active. Turn your camera off before changing effects.",
          );
        // Switch inside the same processor. SDK setProcessor replaces an old processor via a raw-track intermediate.
        await existing.setBackground(image);
      } else {
        const { processor, ready } = await createSafeProcessor(
          image,
          fail,
          onSlow,
        );
        cleanup = () => processor.destroy();
        if (track.isStopped) throw new Error("Camera stopped.");
        await track.setProcessor(processor);
        if (track.isStopped) throw new Error("Camera stopped.");
        await ready;
      }
      if (track.isStopped) throw new Error("Background processing stopped.");
    })();
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Background processing did not start.")),
          20000,
        );
      }),
    ]);
  } catch (e) {
    fail();
    await cleanup?.().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
