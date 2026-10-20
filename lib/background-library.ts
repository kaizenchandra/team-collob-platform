/** Private, device-local background preferences. Never uses conversation file uploads. */
export type BackgroundChoice =
  { kind: "none" } | { kind: "blur" } | { kind: "image"; id: string };
export type BackgroundImage = { id: string; name: string; blob: Blob };
export const BUILTIN_BACKGROUNDS = [
  {
    id: "concord-indigo",
    name: "Concord indigo",
    url: "/media/backgrounds/concord-indigo.png",
  },
  {
    id: "warm-studio",
    name: "Warm studio",
    url: "/media/backgrounds/warm-studio.png",
  },
] as const;
const positive = (value: string | undefined, fallback: number) =>
  Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
export const BACKGROUND_LIMITS = {
  maxBytes: positive(
    process.env.NEXT_PUBLIC_BACKGROUND_MAX_BYTES,
    5 * 1024 * 1024,
  ),
  maxImages: positive(process.env.NEXT_PUBLIC_BACKGROUND_MAX_IMAGES, 6),
  maxDimension: positive(
    process.env.NEXT_PUBLIC_BACKGROUND_MAX_DIMENSION,
    4096,
  ),
  maxPixels: 8 * 1024 * 1024,
  minWidth: 320,
  minHeight: 180,
};
export const NONE: BackgroundChoice = { kind: "none" };
export function parseBackground(value: unknown): BackgroundChoice {
  if (value && typeof value === "object" && "kind" in value) {
    if (value.kind === "none" || value.kind === "blur")
      return { kind: value.kind };
    if (
      value.kind === "image" &&
      "id" in value &&
      typeof value.id === "string" &&
      /^[a-z0-9-]{1,80}$/.test(value.id)
    )
      return { kind: "image", id: value.id };
  }
  return value == null ? NONE : { kind: "image", id: "unavailable" };
}
export const sameBackground = (a: BackgroundChoice, b: BackgroundChoice) =>
  a.kind === b.kind &&
  (a.kind !== "image" || (b.kind === "image" && a.id === b.id));
export function backgroundURL(
  choice: BackgroundChoice,
  images: ReadonlyArray<{ id: string; url: string }>,
) {
  if (choice.kind !== "image") return undefined;
  const image = [...BUILTIN_BACKGROUNDS, ...images].find(
    (i) => i.id === choice.id,
  );
  if (!image)
    throw new Error(
      "Saved background is unavailable. Choose None or another image before turning on your camera.",
    );
  return image.url;
}
type Library = { choice: BackgroundChoice; images: BackgroundImage[] };
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("concord-camera-backgrounds", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("libraries");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("Browser storage is unavailable."));
  });
}
export async function loadBackgroundLibrary(scope: string): Promise<Library> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const req = db
        .transaction("libraries")
        .objectStore("libraries")
        .get(scope);
      req.onsuccess = () =>
        resolve({
          choice: parseBackground(req.result?.choice),
          images: req.result?.images ?? [],
        });
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export async function saveBackgroundLibrary(scope: string, library: Library) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("libraries", "readwrite");
      tx.objectStore("libraries").put(library, scope);
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new Error(
            "Background could not be saved. Browser storage may be full.",
          ),
        );
      tx.onabort = () =>
        reject(new Error("Background storage was interrupted."));
    });
  } finally {
    db.close();
  }
}
export async function validateBackgroundImage(
  file: File,
  limits = BACKGROUND_LIMITS,
): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error(
      "Choose a JPEG, PNG or WebP image. SVG and animated formats are not supported.",
    );
  if (!file.size || file.size > limits.maxBytes)
    throw new Error(
      `Choose an image no larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature =
    file.type === "image/png"
      ? bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71
      : file.type === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
          String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!signature)
    throw new Error("The image contents do not match its file type.");
  const data = new DataView(bytes.buffer);
  for (
    let at = file.type === "image/png" ? 8 : 12;
    file.type !== "image/jpeg" && at + 8 <= bytes.length;
  ) {
    const png = file.type === "image/png",
      typeAt = png ? at + 4 : at,
      type = String.fromCharCode(...bytes.slice(typeAt, typeAt + 4));
    if (["acTL", "ANIM", "ANMF"].includes(type))
      throw new Error(
        "Use a still image. Animated backgrounds are not supported.",
      );
    const length = data.getUint32(png ? at : at + 4, !png),
      step = length + (png ? 12 : 8) + (png ? 0 : length % 2);
    if (step < 8 || at + step > bytes.length) break;
    at += step;
  }
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be decoded. Choose another image.");
  }
  try {
    if (
      image.width < limits.minWidth ||
      image.height < limits.minHeight ||
      image.width > limits.maxDimension ||
      image.height > limits.maxDimension ||
      image.width * image.height > limits.maxPixels
    )
      throw new Error(
        `Use an image at least ${limits.minWidth} × ${limits.minHeight}, up to ${limits.maxDimension} pixels per side and 8 megapixels.`,
      );
    // Flatten alpha, strip metadata and animation, and bound texture memory; keep original aspect ratio.
    const scale = Math.min(1, 1920 / Math.max(image.width, image.height)),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image processing is unavailable.");
    ctx.fillStyle = "#e5e8f0";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error("Image could not be prepared.")),
        "image/jpeg",
        0.9,
      ),
    );
    if (blob.size > limits.maxBytes)
      throw new Error("Prepared image is too large. Choose a smaller image.");
    return blob;
  } finally {
    image.close();
  }
}
