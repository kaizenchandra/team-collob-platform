"use client";
/* Device-local asynchronous preferences and preview capture deliberately update UI state. */
/* eslint-disable react-hooks/set-state-in-effect, @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import {
  BACKGROUND_LIMITS,
  BUILTIN_BACKGROUNDS,
  NONE,
  backgroundURL,
  loadBackgroundLibrary,
  saveBackgroundLibrary,
  sameBackground,
  validateBackgroundImage,
  type BackgroundChoice,
  type BackgroundImage,
} from "@/lib/background-library";
import { applyCameraBackground } from "@/lib/camera-background";

export function useBackgroundLibrary(scope: string) {
  const [choice, setChoice] = useState<BackgroundChoice>(NONE),
    [images, setImages] = useState<(BackgroundImage & { url: string })[]>([]),
    [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState("");
  const choiceRef = useRef(choice),
    lifetime = useRef({ active: true }),
    owned = useRef(new Set<string>());
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);
  useEffect(() => {
    const life = { active: true },
      urls = owned.current;
    lifetime.current = life;
    setReady(false);
    setChoice(NONE);
    setImages([]);
    void loadBackgroundLibrary(scope)
      .then((data) => {
        if (!life.active) return;
        choiceRef.current = data.choice;
        setChoice(data.choice);
        setImages(
          data.images.map((i) => {
            const url = URL.createObjectURL(i.blob);
            urls.add(url);
            return { ...i, url };
          }),
        );
      })
      .catch(() => {
        if (life.active) {
          setChoice({ kind: "image", id: "unavailable" });
          setStorageError(
            "Background preferences could not be loaded. Select None or another background before turning on your camera. Choices will last only for this session if storage is unavailable.",
          );
        }
      })
      .finally(() => {
        if (life.active) setReady(true);
      });
    return () => {
      life.active = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, [scope]);
  async function save(nextChoice: BackgroundChoice, nextImages = images) {
    choiceRef.current = nextChoice;
    setChoice(nextChoice);
    try {
      await saveBackgroundLibrary(scope, {
        choice: nextChoice,
        images: nextImages.map(({ id, name, blob }) => ({ id, name, blob })),
      });
      setStorageError("");
    } catch {
      setStorageError(
        "Applied for this session. Browser storage is unavailable or full; this change could not be saved.",
      );
    }
  }
  async function upload(file: File) {
    if (images.length >= BACKGROUND_LIMITS.maxImages)
      throw new Error(
        `Remove an image before adding more (limit ${BACKGROUND_LIMITS.maxImages}).`,
      );
    const life = lifetime.current,
      blob = await validateBackgroundImage(file);
    if (!life.active) throw new Error("Background settings closed.");
    const image = {
      id: crypto.randomUUID(),
      name: file.name.slice(0, 100),
      blob,
      url: URL.createObjectURL(blob),
    };
    owned.current.add(image.url);
    const next = [...images, image];
    try {
      await saveBackgroundLibrary(scope, {
        choice: choiceRef.current,
        images: next.map(({ id, name, blob }) => ({ id, name, blob })),
      });
      if (!life.active) throw new Error("Background settings closed.");
      setImages(next);
      return image;
    } catch (e) {
      URL.revokeObjectURL(image.url);
      owned.current.delete(image.url);
      throw e;
    }
  }
  async function remove(id: string) {
    const next = images.filter((i) => i.id !== id);
    await saveBackgroundLibrary(scope, {
      choice: choiceRef.current,
      images: next.map(({ id, name, blob }) => ({ id, name, blob })),
    });
    const removed = images.find((i) => i.id === id);
    setImages(next);
    if (removed) {
      URL.revokeObjectURL(removed.url);
      owned.current.delete(removed.url);
    }
  }
  return { choice, images, ready, storageError, save, upload, remove };
}
export type BackgroundLibrary = ReturnType<typeof useBackgroundLibrary>;
export function BackgroundEffects({
  library,
  deviceId,
  onApply,
  onClose,
}: {
  library: BackgroundLibrary;
  deviceId: string;
  onApply: (choice: BackgroundChoice) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(library.choice),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [support, setSupport] = useState<boolean | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const video = useRef<HTMLVideoElement | null>(null),
    track = useRef<LocalVideoTrack | null>(null),
    operation = useRef(false),
    heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
    let active = true;
    void import("@livekit/track-processors")
      .then((m) => {
        if (active)
          setSupport(
            m.supportsBackgroundProcessors() &&
              m.supportsModernBackgroundProcessors(),
          );
      })
      .catch(() => {
        if (active) setSupport(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    let active = true;
    const element = video.current;
    let current: LocalVideoTrack | undefined;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        current = await createLocalVideoTrack({
          deviceId: deviceId || undefined,
          resolution: { width: 640, height: 360, frameRate: 15 },
        });
        if (!active) {
          current.stop();
          return;
        }
        track.current = current;
        await applyCameraBackground(
          current,
          draft,
          backgroundURL(draft, library.images),
          () => {
            current?.stop();
            if (active)
              setError(
                "Local preview stopped. Your outgoing video has not changed. Choose another background or retry the preview.",
              );
          },
          () => {
            if (active)
              setNotice(
                "Processing is slow on this device. Close other camera apps or choose None.",
              );
          },
        );
        if (!active) {
          current.stop();
          return;
        }
        if (element) current.attach(element);
      } catch (e) {
        current?.stop();
        if (active)
          setError(
            e instanceof DOMException && e.name === "NotAllowedError"
              ? "Camera preview permission denied. Allow camera access in browser settings and retry. Your outgoing video has not changed."
              : e instanceof Error
                ? `Local preview unavailable: ${e.message}. Your outgoing video has not changed.`
                : "Camera preview unavailable. Check camera permissions and device settings. Your outgoing video has not changed.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      current?.stop();
      track.current = null;
      if (element) {
        current?.detach(element);
        element.srcObject = null;
      }
    };
  }, [preview, draft, deviceId, library.images]);
  async function action(fn: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Background action failed. Please retry.",
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  const missing =
    draft.kind === "image" &&
    ![...BUILTIN_BACKGROUNDS, ...library.images].some((i) => i.id === draft.id);
  const select = (choice: BackgroundChoice) => {
    setDraft(choice);
    setError("");
  };
  const option = (choice: BackgroundChoice, label: string, url?: string) => (
    <button
      type="button"
      className="background-option"
      role="radio"
      aria-checked={sameBackground(draft, choice)}
      aria-label={label}
      disabled={busy || (choice.kind !== "none" && support !== true)}
      onClick={() => select(choice)}
    >
      {url ? (
        <img src={url} alt="" />
      ) : (
        <span className={`background-swatch ${choice.kind}`} aria-hidden="true">
          {choice.kind === "none" ? "○" : "◌"}
        </span>
      )}
      <span>{label}</span>
      {(sameBackground(draft, choice) ||
        sameBackground(library.choice, choice)) && (
        <strong>
          {sameBackground(library.choice, choice) ? "Applied" : "Selected"}
        </strong>
      )}
    </button>
  );
  return (
    <section
      className="background-effects"
      aria-label="Background effects"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onClose();
        }
      }}
    >
      <h3 ref={heading} tabIndex={-1}>
        Background effects
      </h3>
      <p>
        Preview is local only. Apply changes your outgoing camera when it is on.
        It never turns your camera on.
      </p>
      <div className="background-preview">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="Background effect preview"
          hidden={!preview}
        />
        {!preview && (
          <p>
            Start a separate camera preview to try an effect without changing
            what others see.
          </p>
        )}
        {preview && loading && (
          <p role="status">Preparing camera and background…</p>
        )}
      </div>
      <button
        className="secondary"
        disabled={
          busy ||
          loading ||
          !navigator.mediaDevices?.getUserMedia ||
          (draft.kind !== "none" && support !== true)
        }
        onClick={() => setPreview((v) => !v)}
      >
        {preview ? "Stop local preview" : "Start local preview"}
      </button>
      {support === null && <p role="status">Checking background support…</p>}
      {support === false && (
        <p role="status">
          Effects are unavailable in this browser. Use current Chrome or Edge
          with WebGL2 and modern video processing, or select None.
        </p>
      )}
      {missing && (
        <p role="alert">
          Saved background is unavailable. Select None or another image before
          turning on your camera.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {library.storageError && <p role="status">{library.storageError}</p>}
      <div
        role="radiogroup"
        aria-label="Choose background"
        className="background-options"
        onKeyDown={(e) => {
          if (
            ![
              "ArrowRight",
              "ArrowLeft",
              "ArrowDown",
              "ArrowUp",
              "Home",
              "End",
            ].includes(e.key)
          )
            return;
          const buttons = Array.from(
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="radio"]:not(:disabled)',
              ),
            ),
            index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
          if (index < 0) return;
          e.preventDefault();
          const next =
            buttons[
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? buttons.length - 1
                  : (index +
                      (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1) +
                      buttons.length) %
                    buttons.length
            ];
          next?.focus();
          next?.click();
        }}
      >
        {option(NONE, "None")}
        {option({ kind: "blur" }, "Blur")}
        {BUILTIN_BACKGROUNDS.map((i) => (
          <div key={i.id}>
            {option({ kind: "image", id: i.id }, i.name, i.url)}
          </div>
        ))}
        {library.images.map((i) => (
          <div key={i.id}>
            {option({ kind: "image", id: i.id }, i.name, i.url)}
            <button
              className="secondary"
              disabled={busy}
              aria-label={`Remove background ${i.name}`}
              onClick={() =>
                void action(async () => {
                  if (
                    library.choice.kind === "image" &&
                    library.choice.id === i.id
                  )
                    await onApply(NONE);
                  await library.remove(i.id);
                  if (draft.kind === "image" && draft.id === i.id)
                    setDraft(NONE);
                  setNotice(
                    "Image removed. If it was applied, the background is now None.",
                  );
                })
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <label className="background-upload">
        Upload image
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy || support !== true}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file)
              void action(async () => {
                const image = await library.upload(file);
                setDraft({ kind: "image", id: image.id });
                setNotice(
                  "Image saved on this device. Select Apply to use it.",
                );
              });
          }}
        />
      </label>
      <p>
        JPEG, PNG or WebP, up to{" "}
        {Math.round(BACKGROUND_LIMITS.maxBytes / 1024 / 1024)} MB. Stored in
        this browser only.
      </p>
      <details>
        <summary>Image requirements and storage</summary>
        <p>
          Minimum 320 × 180; up to {BACKGROUND_LIMITS.maxDimension} pixels per
          side and 8 megapixels. Up to {BACKGROUND_LIMITS.maxImages} images per
          account and workspace in this browser. Images fill the background
          without stretching. Removing an applied image restores the original
          background. Effects may leave surroundings visible.
        </p>
      </details>
      <footer>
        <button
          className="primary"
          aria-label="Apply background"
          disabled={
            busy ||
            loading ||
            missing ||
            (draft.kind !== "none" && support !== true)
          }
          onClick={() =>
            void action(async () => {
              await onApply(draft);
              onClose();
            })
          }
        >
          {busy ? "Applying…" : "Apply"}
        </button>
        <button
          className="secondary"
          aria-label="Cancel background changes"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
      </footer>
    </section>
  );
}
