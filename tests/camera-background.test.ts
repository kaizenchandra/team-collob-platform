import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBackground,
  backgroundURL,
  sameBackground,
  validateBackgroundImage,
  BACKGROUND_LIMITS,
} from "../lib/background-library.ts";
test("missing preferences default to None; corrupt preferences require explicit recovery", () => {
  assert.deepEqual(parseBackground(undefined), { kind: "none" });
  assert.deepEqual(parseBackground({ kind: "blur" }), { kind: "blur" });
  assert.deepEqual(parseBackground({ kind: "image", id: "valid-id" }), {
    kind: "image",
    id: "valid-id",
  });
  assert.deepEqual(
    parseBackground({ kind: "image", id: "https://external.test/image" }),
    { kind: "image", id: "unavailable" },
  );
  assert.deepEqual(parseBackground("broken"), {
    kind: "image",
    id: "unavailable",
  });
});
test("only bundled or user-library images resolve; missing images do not silently use raw camera", () => {
  assert.equal(
    backgroundURL({ kind: "image", id: "concord-indigo" }, []),
    "/media/backgrounds/concord-indigo.png",
  );
  assert.equal(
    backgroundURL({ kind: "image", id: "private" }, [
      { id: "private", url: "blob:private" },
    ]),
    "blob:private",
  );
  assert.throws(
    () => backgroundURL({ kind: "image", id: "private" }, []),
    /unavailable/,
  );
  assert.equal(backgroundURL({ kind: "none" }, []), undefined);
  assert.ok(sameBackground({ kind: "blur" }, { kind: "blur" }));
  assert.ok(
    !sameBackground(
      { kind: "image", id: "first" },
      { kind: "image", id: "second" },
    ),
  );
});
test("upload validation rejects unsupported content, oversized files and forged raster headers before decoding", async () => {
  await assert.rejects(
    validateBackgroundImage(
      new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
    ),
    /JPEG, PNG or WebP/,
  );
  await assert.rejects(
    validateBackgroundImage(
      new File(["bad"], "image.png", { type: "image/png" }),
    ),
    /contents do not match/,
  );
  await assert.rejects(
    validateBackgroundImage(
      new File([new Uint8Array(BACKGROUND_LIMITS.maxBytes + 1)], "large.jpg", {
        type: "image/jpeg",
      }),
    ),
    /no larger/,
  );
});
