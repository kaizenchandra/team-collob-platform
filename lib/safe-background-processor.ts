import {
  BackgroundTransformer,
  ProcessorWrapper,
  supportsBackgroundProcessors,
  supportsModernBackgroundProcessors,
} from "@livekit/track-processors";
import type { ProcessorOptions, Track } from "livekit-client";

/** SDK segmentation/compositing, with no raw-first-frame or raw-error passthrough. */
class SafeTransformer extends BackgroundTransformer {
  private failed = false;
  private lastTimestamp = -Infinity;
  private frameInterval = 1_000_000 / 15;
  private lastFrame = performance.now();
  private slowFrames = 0;
  private closed = false;
  private switching = false;
  private epoch = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private readyResolve!: () => void;
  ready = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });
  constructor(
    private image: string | undefined,
    private fail: () => void,
    private slow: () => void,
  ) {
    super({
      blurRadius: 10,
      assetPaths: {
        tasksVisionFileSet: "/media/vision",
        modelAssetPath: "/media/selfie_segmenter.tflite",
      },
    });
  }
  private failure() {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.fail();
    this.readyResolve();
  }
  override async loadAndSetBackground(path: string) {
    const response = await fetch(path, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Background image unavailable.");
    const bitmap = await createImageBitmap(await response.blob());
    if (this.closed) {
      bitmap.close();
      throw new Error("Background preview closed.");
    }
    const previous = this.backgroundImageAndPath;
    try {
      await this.gl?.setBackgroundImage(bitmap);
      this.backgroundImageAndPath = { path, imageData: bitmap };
      previous?.imageData.close();
    } catch (e) {
      bitmap.close();
      throw e;
    }
  }
  override async init(options: Parameters<BackgroundTransformer["init"]>[0]) {
    const epoch = ++this.epoch;
    this.closed = false;
    this.failed = false;
    this.switching = false;
    this.options = { ...this.options, imagePath: undefined, blurRadius: 10 };
    this.lastTimestamp = -Infinity;
    await super.init(options);
    if (this.closed || this.epoch !== epoch)
      throw new Error("Camera processing was cancelled.");
    if (this.image) {
      this.options = {
        ...this.options,
        imagePath: this.image,
        blurRadius: undefined,
      };
      this.gl?.setBlurRadius(null);
      await this.loadAndSetBackground(this.image);
    }
    this.lastFrame = performance.now();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        performance.now() - this.lastFrame > 8000
      )
        this.failure();
    }, 1000);
  }
  async changeBackground(image: string | undefined) {
    if (this.closed || this.failed || !this.gl)
      throw new Error("Background processor stopped.");
    const epoch = this.epoch;
    this.switching = true;
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    try {
      this.gl.setBlurRadius(image ? null : 10);
      if (image) await this.loadAndSetBackground(image);
      else {
        this.backgroundImageAndPath?.imageData.close();
        this.backgroundImageAndPath = null;
      }
      if (this.closed || this.epoch !== epoch)
        throw new Error("Camera processing was cancelled.");
      this.image = image;
      this.options = {
        ...this.options,
        imagePath: image,
        blurRadius: image ? undefined : 10,
      };
      this.lastFrame = performance.now();
      this.lastTimestamp = -Infinity;
      this.switching = false;
      await this.ready;
    } finally {
      if (this.epoch === epoch) this.switching = false;
    }
  }
  override async transform(
    frame: VideoFrame,
    controller: TransformStreamDefaultController<VideoFrame>,
  ) {
    try {
      if (this.failed || this.closed || this.switching) return;
      if (!frame.codedWidth || !frame.codedHeight) return;
      // Cap both SDK paths at 15 processed frames/s, without modifying the camera/audio tracks.
      const timestamp = frame.timestamp ?? performance.now() * 1000;
      if (timestamp - this.lastTimestamp < this.frameInterval) return;
      this.lastTimestamp = timestamp;
      if (!this.canvas || !this.gl || !this.imageSegmenter)
        throw new Error("Background processor unavailable.");
      const context = this.canvas.getContext(
        "webgl2",
      ) as WebGL2RenderingContext | null;
      if (!context || context.isContextLost())
        throw new Error("Background GPU context lost.");
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      const start = performance.now();
      let output = false;
      this.imageSegmenter.segmentForVideo(frame, start, (result) => {
        try {
          if (!result.categoryMask)
            throw new Error("Person segmentation unavailable.");
          this.gl!.updateMask(result.categoryMask.getAsWebGLTexture());
          this.gl!.renderFrame(frame);
          controller.enqueue(
            new VideoFrame(this.canvas!, { timestamp: frame.timestamp }),
          );
          output = true;
        } finally {
          result.close();
        }
      });
      if (!output)
        throw new Error("Background processor did not produce a frame.");
      this.lastFrame = performance.now();
      const elapsed = this.lastFrame - start;
      this.frameInterval =
        elapsed > 66
          ? Math.min(1_000_000 / 5, this.frameInterval * 1.1)
          : elapsed < 35
            ? Math.max(1_000_000 / 15, this.frameInterval * 0.98)
            : this.frameInterval;
      this.readyResolve();
      if (this.lastFrame - start > 100) {
        if (++this.slowFrames === 30) this.slow();
      } else this.slowFrames = 0;
    } catch {
      this.failure();
    } finally {
      frame.close();
    }
  }
  override async destroy() {
    this.closed = true;
    ++this.epoch;
    this.readyResolve();
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    const bitmap = this.backgroundImageAndPath?.imageData;
    try {
      await super.destroy();
    } finally {
      bitmap?.close();
    }
  }
}

export async function createSafeProcessor(
  image: string | undefined,
  failed: () => void,
  slow: () => void,
) {
  if (!supportsBackgroundProcessors() || !supportsModernBackgroundProcessors())
    throw new Error(
      "Background effects require a browser with WebGL2 and modern video processing. Use current Chrome or Edge, or choose None.",
    );
  const transformer = new SafeTransformer(image, failed, slow);
  class SafeProcessor extends ProcessorWrapper<
    Parameters<SafeTransformer["update"]>[0],
    SafeTransformer
  > {
    async setBackground(image: string | undefined) {
      await transformer.changeBackground(image);
    }
    override async init(options: ProcessorOptions<Track.Kind>) {
      try {
        if ((options.track.readyState as string) === "ended")
          throw new Error("Camera stopped.");
        await super.init(options);
        if ((options.track.readyState as string) === "ended")
          throw new Error("Camera stopped.");
      } catch (e) {
        failed();
        this.trackGenerator?.stop();
        await this.processor?.readable.cancel().catch(() => {});
        await transformer.destroy();
        throw e;
      }
    }
  }
  const processor = new SafeProcessor(
    transformer,
    "concord-camera-background",
    { maxFps: 15 },
  );
  return { processor, ready: transformer.ready };
}
