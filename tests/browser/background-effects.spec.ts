import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
import { settings } from "./call-ui";
const api = "http://localhost:4100",
  org = randomUUID(),
  bobId = randomUUID(),
  samId = randomUUID(),
  headers = { origin: "http://localhost:3101" },
  base = `${api}/v1/organizations/${org}/calls`;
// Isolated development fixtures avoid interference with people using the shared seed accounts.
const fixtureUsers = [
  {
    id: randomUUID(),
    email: `effects-alice-${org}@example.test`,
    name: "Alice Morgan",
    role: "owner",
  },
  {
    id: bobId,
    email: `effects-bob-${org}@example.test`,
    name: "Bob Chen",
    role: "member",
  },
  {
    id: samId,
    email: `effects-sam-${org}@example.test`,
    name: "Sam Rivera",
    role: "guest",
  },
];
test.beforeAll(async () => {
  const db = new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
  });
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
      org,
      `Camera effects verification ${org}`,
    ]);
    for (const user of fixtureUsers) {
      await connection.query(
        "INSERT INTO users(id,email,name,password_hash) SELECT $1,$2,$3,password_hash FROM users WHERE email=$4",
        [user.id, user.email, user.name, "alice@acme.test"],
      );
      await connection.query(
        "INSERT INTO memberships(org_id,user_id,role,active) VALUES($1,$2,$3,true)",
        [org, user.id, user.role],
      );
    }
    await connection.query("COMMIT");
  } catch (e) {
    await connection.query("ROLLBACK");
    throw e;
  } finally {
    connection.release();
    await db.end();
  }
});
test.afterAll(async () => {
  const db = new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
  });
  try {
    await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
      fixtureUsers.map((u) => u.id),
    ]);
    await db.query("UPDATE memberships SET active=false WHERE org_id=$1", [
      org,
    ]);
  } finally {
    await db.end();
  }
});
const args = [
  "--host-resolver-rules=MAP localhost 127.0.0.1",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-usermedia-screen-capturing",
  "--auto-select-desktop-capture-source=Entire screen",
  "--enable-unsafe-swiftshader",
];
async function login(ctx: BrowserContext, email: string) {
  expect(
    (
      await ctx.request.post(`${api}/v1/session`, {
        headers,
        data: {
          email: fixtureUsers.find(
            (u) =>
              u.name ===
              (email === "alice@acme.test"
                ? "Alice Morgan"
                : email === "bob@acme.test"
                  ? "Bob Chen"
                  : "Sam Rivera"),
          )!.email,
          password: "Development123!",
        },
      })
    ).status(),
  ).toBe(200);
}
async function openEffects(p: Page) {
  await settings(p);
  await p
    .getByRole("button", { name: "Background effects", exact: true })
    .click();
  return p.getByRole("region", { name: "Background effects", exact: true });
}
async function pixels(p: Page, label = "Remote camera") {
  return (
    label === "Remote camera"
      ? p
          .getByRole("article", { name: "Alice Morgan media" })
          .getByLabel(label, { exact: true })
      : p.getByLabel(label, { exact: true })
  )
    .first()
    .evaluate((v: HTMLVideoElement) => {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 90;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0, 160, 90);
      const d = ctx.getImageData(0, 0, 160, 90).data;
      let r = 0,
        g = 0,
        b = 0,
        edge = 0;
      for (let y = 3; y < 87; y++)
        for (let x = 3; x < 157; x++) {
          const i = (y * 160 + x) * 4;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          edge += Math.abs(d[i + 1] - d[i - 4 + 1]);
        }
      const n = 84 * 154;
      return { r: r / n, g: g / n, b: b / n, edge: edge / n };
    });
}
async function indigo(p: Page, label = "Remote camera") {
  await expect
    .poll(
      async () => {
        const c = await pixels(p, label);
        return c.b > c.g * 1.3 && c.b > c.r * 1.3;
      },
      { timeout: 25000 },
    )
    .toBe(true);
}
async function warm(p: Page, label = "Remote camera") {
  await expect
    .poll(
      async () => {
        const c = await pixels(p, label);
        return c.r > c.b * 1.2 && c.r > c.g;
      },
      { timeout: 25000 },
    )
    .toBe(true);
}
async function green(p: Page) {
  await expect
    .poll(
      async () => {
        const c = await pixels(p);
        return c.g > c.r * 2 && c.g > c.b * 2;
      },
      { timeout: 20000 },
    )
    .toBe(true);
}

test("outgoing camera effects: private preview/cancel, blur, built-ins, upload, group, camera lifecycle and fail-closed recovery", async () => {
  test.setTimeout(240000);
  const browser = await chromium.launch({ channel: "chrome", args }),
    contexts = await Promise.all(
      [1, 2, 3].map(() =>
        browser.newContext({ permissions: ["microphone", "camera"] }),
      ),
    ),
    [alice, bob, sam] = contexts,
    [a, b, c] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
  let call = "";
  try {
    for (const [ctx, email] of [
      [alice, "alice@acme.test"],
      [bob, "bob@acme.test"],
      [sam, "guest@partner.test"],
    ] as const)
      await login(ctx, email);
    await a.addInitScript(() => {
      const tracks: MediaStreamTrack[] = [];
      const get = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      Object.assign(window, { effectTracks: tracks });
      navigator.mediaDevices.getUserMedia = async (o) => {
        const s = await get(o);
        tracks.push(...s.getTracks());
        return s;
      };
    });
    const made = await alice.request.post(
      `${api}/v1/organizations/${org}/instant-meetings`,
      {
        headers,
        data: {
          clientId: randomUUID(),
          title: `Background acceptance ${Date.now()}`,
          mode: "video",
          userIds: [bobId, samId],
        },
      },
    );
    expect(made.status()).toBe(200);
    call = (await made.json()).id;
    await a.goto(`http://localhost:3101/?org=${org}&call=${call}`);
    await a
      .getByRole("checkbox", { name: "Enable camera when joining" })
      .check();
    await a.getByRole("button", { name: "Join call", exact: true }).click();
    await b.goto(`http://localhost:3101/?org=${org}`);
    await b
      .getByRole("button", { name: "Answer with video", exact: true })
      .click();
    await green(b);
    const originalSid = await b
      .getByLabel("Remote camera", { exact: true })
      .evaluate((v: HTMLVideoElement) =>
        v.srcObject instanceof MediaStream
          ? v.srcObject.getVideoTracks()[0].id
          : "",
      );
    const raw = await pixels(b);
    await settings(b);
    await b.getByText("Call diagnostics", { exact: true }).click();
    await expect
      .poll(
        async () =>
          Number(await b.getByTestId("media-audio-received").textContent()),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    const audioBefore = Number(
      await b.getByTestId("media-audio-received").textContent(),
    );
    const liveCaptureIds = () =>
      a.evaluate(() =>
        (window as unknown as { effectTracks: MediaStreamTrack[] }).effectTracks
          .filter((t) => t.readyState === "live")
          .map((t) => t.id)
          .sort(),
      );
    const beforePreview = await liveCaptureIds();
    let panel = await openEffects(a);
    await panel
      .getByRole("radio", { name: "Warm studio", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Start local preview", exact: true })
      .click();
    await warm(a, "Background effect preview");
    await a
      .getByRole("region", { name: "Call area" })
      .screenshot({ path: "docs/evidence/background-effects-preview.png" });
    await green(b);
    await panel
      .getByRole("button", { name: "Cancel background changes", exact: true })
      .click();
    await green(b);
    expect(await liveCaptureIds()).toEqual(beforePreview);
    await expect(
      a.getByRole("button", { name: "Background effects", exact: true }),
    ).toBeFocused();
    panel = await openEffects(a);
    await panel
      .getByRole("radio", { name: "Concord indigo", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await expect(panel).not.toBeVisible({ timeout: 25000 });
    await indigo(b);
    await b
      .getByRole("article", { name: "Alice Morgan media" })
      .screenshot({ path: "docs/evidence/background-effects-remote.png" });
    expect(
      await b
        .getByLabel("Remote camera", { exact: true })
        .evaluate(
          (v: HTMLVideoElement) =>
            (v.srcObject as MediaStream).getVideoTracks()[0].id,
        ),
    ).toBe(originalSid);
    panel = await openEffects(a);
    await panel.getByRole("radio", { name: "Blur", exact: true }).click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await expect(panel).not.toBeVisible({ timeout: 25000 });
    await green(b);
    await expect
      .poll(async () => (await pixels(b)).edge, { timeout: 15000 })
      .toBeLessThan(raw.edge * 0.85);
    await writeFile(
      "docs/evidence/background-effects-pixels.json",
      JSON.stringify(
        {
          source: "Chromium synthetic camera through the real LiveKit SFU",
          physicalDevices: false,
          original: raw,
          blurred: await pixels(b),
        },
        null,
        2,
      ) + "\n",
    );
    panel = await openEffects(a);
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "unsafe.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    });
    await expect(panel.getByRole("alert")).toContainText("JPEG, PNG or WebP");
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "small.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    });
    await expect(panel.getByRole("alert")).toContainText(
      "contents do not match",
    );
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "Private studio.png",
      mimeType: "image/png",
      buffer: await readFile("public/media/backgrounds/warm-studio.png"),
    });
    await expect(
      panel.getByRole("radio", { name: "Private studio.png", exact: true }),
    ).toBeChecked();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await expect(panel).not.toBeVisible({ timeout: 25000 });
    await warm(b);
    await expect
      .poll(
        async () =>
          Number(await b.getByTestId("media-audio-received").textContent()),
        { timeout: 15000 },
      )
      .toBeGreaterThan(audioBefore);
    await a.reload();
    await a
      .getByRole("button", { name: "Background effects", exact: true })
      .click();
    panel = a.getByRole("region", { name: "Background effects", exact: true });
    await expect(
      panel.getByRole("radio", { name: "Private studio.png", exact: true }),
    ).toBeChecked();
    await panel
      .getByRole("button", { name: "Cancel background changes", exact: true })
      .click();
    await a
      .getByRole("checkbox", { name: "Enable camera when joining" })
      .check();
    await a.getByRole("button", { name: "Join call", exact: true }).click();
    await warm(b);
    await c.goto(`http://localhost:3101/?org=${org}`);
    await c
      .getByRole("button", { name: "Answer with video", exact: true })
      .click();
    await expect(c.getByLabel("Remote camera", { exact: true })).toHaveCount(
      2,
      { timeout: 15000 },
    );
    const aliceVideo = c
      .getByRole("article", { name: "Alice Morgan media" })
      .getByLabel("Remote camera", { exact: true });
    await expect
      .poll(() => aliceVideo.evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        aliceVideo.evaluate((v: HTMLVideoElement) => {
          const cv = document.createElement("canvas");
          cv.width = 1;
          cv.height = 1;
          const x = cv.getContext("2d")!;
          x.drawImage(v, 0, 0, 1, 1);
          const d = x.getImageData(0, 0, 1, 1).data;
          return d[0] > d[2] * 1.2;
        }),
      )
      .toBe(true);
    await a
      .getByRole("button", { name: "Turn camera off", exact: true })
      .click();
    await expect(
      b
        .getByRole("article", { name: "Alice Morgan media" })
        .getByLabel("Remote camera", { exact: true }),
    ).toHaveCount(0);
    await a
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click();
    await warm(b);
    await a.getByRole("button", { name: "Share screen", exact: true }).click();
    await expect(
      b.getByLabel("Remote screen share", { exact: true }),
    ).toHaveCount(1, { timeout: 15000 });
    panel = await openEffects(a);
    await panel
      .getByRole("radio", { name: "Concord indigo", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await expect(panel).not.toBeVisible({ timeout: 25000 });
    await indigo(b);
    const shared = await pixels(b, "Remote screen share");
    expect(shared.g).toBeGreaterThan(shared.r * 2);
    await a
      .getByRole("button", { name: "Stop screen sharing", exact: true })
      .click();
    await indigo(b);
    // Inject actual GPU-context loss into the transform path; no cooperative remote event is involved.
    await a.evaluate(() => {
      const original = WebGL2RenderingContext.prototype.isContextLost;
      Object.assign(window, {
        restoreEffectsContext: () => {
          WebGL2RenderingContext.prototype.isContextLost = original;
        },
      });
      WebGL2RenderingContext.prototype.isContextLost = () => true;
    });
    await expect(
      a.getByRole("alert").filter({ hasText: "Camera stopped to protect" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      b
        .getByRole("article", { name: "Alice Morgan media" })
        .getByLabel("Remote camera", { exact: true }),
    ).toHaveCount(0);
    await expect(
      a.getByRole("button", { name: "Mute microphone", exact: true }),
    ).toBeVisible();
    await a.evaluate(() =>
      (
        window as unknown as { restoreEffectsContext: () => void }
      ).restoreEffectsContext(),
    );
    panel = await openEffects(a);
    await panel.getByRole("radio", { name: "None", exact: true }).click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await a
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click();
    await green(b);
    panel = await openEffects(a);
    await panel
      .getByRole("radio", { name: "Private studio.png", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await warm(b);
    panel = await openEffects(a);
    await panel
      .getByRole("button", {
        name: "Remove background Private studio.png",
        exact: true,
      })
      .click();
    await green(b);
    await expect(
      panel.getByRole("radio", { name: "None", exact: true }),
    ).toBeChecked();
    await expect(
      panel.getByRole("radio", { name: "Private studio.png", exact: true }),
    ).toHaveCount(0);
    await a
      .getByRole("region", { name: "Call area" })
      .screenshot({ path: "docs/evidence/background-effects-desktop.png" });
    expect(
      (
        await new AxeBuilder({ page: a })
          .include(".media-call-window")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await a.setViewportSize({ width: 390, height: 844 });
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      a.getByRole("button", { name: "Leave call", exact: true }),
    ).toBeInViewport();
    expect(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await a
      .getByRole("region", { name: "Call area" })
      .screenshot({ path: "docs/evidence/background-effects-mobile.png" });
    await a.getByRole("button", { name: "Leave call", exact: true }).click();
    await expect
      .poll(() =>
        a.evaluate(() =>
          (
            window as unknown as { effectTracks: MediaStreamTrack[] }
          ).effectTracks.every((t) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
  } finally {
    if (call) {
      await alice.request.post(`${base}/${call}/end`, { headers, data: {} });
      await bob.request.post(`${base}/${call}/end`, { headers, data: {} });
      await sam.request.post(`${base}/${call}/end`, { headers, data: {} });
    }
    await browser.close();
  }
});

test("prejoin preferences restore without camera activation; uploads validate and unsupported effects stay disabled", async () => {
  test.setTimeout(120000);
  const browser = await chromium.launch({ channel: "chrome", args }),
    alice = await browser.newContext({ permissions: ["microphone", "camera"] }),
    bob = await browser.newContext({ permissions: ["microphone", "camera"] }),
    a = await alice.newPage(),
    b = await bob.newPage();
  let call = "";
  try {
    await login(alice, "alice@acme.test");
    await login(bob, "bob@acme.test");
    const made = await alice.request.post(
      `${api}/v1/organizations/${org}/instant-meetings`,
      {
        headers,
        data: {
          clientId: randomUUID(),
          title: `Background restore ${Date.now()}`,
          mode: "audio",
          userIds: [bobId],
        },
      },
    );
    expect(made.status()).toBe(200);
    call = (await made.json()).id;
    const url = `http://localhost:3101/?org=${org}&call=${call}`;
    await a.goto(url);
    await a
      .getByRole("button", { name: "Background effects", exact: true })
      .click();
    let panel = a.getByRole("region", {
      name: "Background effects",
      exact: true,
    });
    await panel
      .getByRole("radio", { name: "Concord indigo", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Apply background", exact: true })
      .click();
    await expect(panel).not.toBeVisible();
    await expect(a.locator("video")).toHaveCount(0);
    await a.reload();
    await expect(
      a.getByRole("checkbox", { name: "Enable camera when joining" }),
    ).not.toBeChecked();
    await a
      .getByRole("button", { name: "Background effects", exact: true })
      .click();
    panel = a.getByRole("region", { name: "Background effects", exact: true });
    await expect(
      panel.getByRole("radio", { name: "Concord indigo", exact: true }),
    ).toBeChecked();
    const small = await a.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 10;
      c.height = 10;
      return Array.from(
        new Uint8Array(
          await (
            await new Promise<Blob>((resolve) =>
              c.toBlob((b) => resolve(b!), "image/png"),
            )
          ).arrayBuffer(),
        ),
      );
    });
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "too-small.png",
      mimeType: "image/png",
      buffer: Buffer.from(small),
    });
    await expect(panel.getByRole("alert")).toContainText("at least 320");
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(panel.getByRole("alert")).toContainText("no larger than 5 MB");
    await panel.getByLabel("Upload image", { exact: true }).setInputFiles({
      name: "corrupt.png",
      mimeType: "image/png",
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
    });
    await expect(panel.getByRole("alert")).toContainText(
      "could not be decoded",
    );
    await panel
      .getByRole("button", { name: "Cancel background changes", exact: true })
      .click();
    await a
      .getByRole("checkbox", { name: "Enable camera when joining" })
      .check();
    await a.getByRole("button", { name: "Join call", exact: true }).click();
    await b.goto(`http://localhost:3101/?org=${org}`);
    await b
      .getByRole("button", { name: "Answer with audio", exact: true })
      .click();
    await indigo(b);
    await expect(b.getByLabel("Local camera", { exact: true })).toHaveCount(0);
    await settings(a);
    await a.getByText("Connected device selection", { exact: true }).click();
    const camera = a.getByRole("combobox", { name: "Camera", exact: true });
    const ids = await camera
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
      );
    expect(ids.length).toBeGreaterThan(0);
    await camera.selectOption(ids[0]);
    await indigo(b);
    await b.evaluate(() => {
      Object.defineProperty(window, "OffscreenCanvas", {
        value: undefined,
        configurable: true,
      });
    });
    const unsupported = await openEffects(b);
    await expect(
      unsupported.getByRole("radio", { name: "Blur", exact: true }),
    ).toBeDisabled();
    await expect(
      unsupported.getByRole("radio", { name: "None", exact: true }),
    ).toBeEnabled();
    await expect(
      unsupported
        .getByRole("status")
        .filter({ hasText: "Effects are unavailable" }),
    ).toBeVisible();
    await expect(b.getByLabel("Local camera", { exact: true })).toHaveCount(0);
    await a
      .getByRole("button", { name: "End call for everyone", exact: true })
      .click();
    await a
      .getByRole("button", { name: "Confirm end meeting", exact: true })
      .click();
    await expect(
      b.getByRole("heading", { name: "Call ended", exact: true }),
    ).toBeVisible();
    await a
      .getByRole("button", { name: "Close call", exact: true })
      .click();
  } finally {
    if (call)
      await alice.request.post(`${base}/${call}/end`, { headers, data: {} });
    await browser.close();
  }
});

test("model initialization and unavailable preference storage fail closed while audio stays connected", async () => {
  test.setTimeout(120000);
  const browser = await chromium.launch({ channel: "chrome", args });
  try {
    for (const fault of ["model", "storage"]) {
      const alice = await browser.newContext({
          permissions: ["microphone", "camera"],
        }),
        bob = await browser.newContext({
          permissions: ["microphone", "camera"],
        }),
        a = await alice.newPage(),
        b = await bob.newPage();
      let call = "";
      try {
        await login(alice, "alice@acme.test");
        await login(bob, "bob@acme.test");
        if (fault === "storage")
          await a.addInitScript(() => {
            const open = indexedDB.open.bind(indexedDB);
            Object.assign(window, {
              restoreBackgroundStore: () => {
                indexedDB.open = open;
              },
            });
            indexedDB.open = () => {
              throw new Error("Storage blocked");
            };
          });
        const made = await alice.request.post(
          `${api}/v1/organizations/${org}/instant-meetings`,
          {
            headers,
            data: {
              clientId: randomUUID(),
              title: `Background ${fault} fault ${Date.now()}`,
              mode: "video",
              userIds: [bobId],
            },
          },
        );
        expect(made.status()).toBe(200);
        call = (await made.json()).id;
        await a.goto(`http://localhost:3101/?org=${org}&call=${call}`);
        if (fault === "model") {
          await a
            .getByRole("button", { name: "Background effects", exact: true })
            .click();
          const panel = a.getByRole("region", {
            name: "Background effects",
            exact: true,
          });
          await panel
            .getByRole("radio", { name: "Concord indigo", exact: true })
            .click();
          await panel
            .getByRole("button", { name: "Apply background", exact: true })
            .click();
          await a.route("**/media/selfie_segmenter.tflite", (r) =>
            r.fulfill({ status: 503, body: "Unavailable" }),
          );
        }
        await a
          .getByRole("checkbox", { name: "Enable camera when joining" })
          .check();
        await a.getByRole("button", { name: "Join call", exact: true }).click();
        await b.goto(`http://localhost:3101/?org=${org}`);
        await b
          .getByRole("button", { name: "Answer with video", exact: true })
          .click();
        await expect(
          a.getByRole("status").filter({ hasText: "Connection: connected" }),
        ).toBeVisible();
        await expect(
          a.getByRole("alert").filter({
            hasText:
              fault === "model"
                ? "Camera stopped to protect"
                : "Saved background is unavailable",
          }),
        ).toBeVisible({ timeout: 20000 });
        await expect(
          a.getByRole("button", { name: "Turn camera on", exact: true }),
        ).toBeEnabled();
        await expect(
          b
            .getByRole("article", { name: "Alice Morgan media" })
            .getByLabel("Remote camera", { exact: true }),
        ).toHaveCount(0);
        await settings(b);
        await b.getByText("Call diagnostics", { exact: true }).click();
        await expect
          .poll(
            async () =>
              Number(await b.getByTestId("media-audio-received").textContent()),
            { timeout: 15000 },
          )
          .toBeGreaterThan(0);
        if (fault === "storage")
          await a.evaluate(() =>
            (
              window as unknown as { restoreBackgroundStore: () => void }
            ).restoreBackgroundStore(),
          );
        else await a.unroute("**/media/selfie_segmenter.tflite");
        const panel = await openEffects(a);
        await panel.getByRole("radio", { name: "None", exact: true }).click();
        await panel
          .getByRole("button", { name: "Apply background", exact: true })
          .click();
        await a
          .getByRole("button", { name: "Turn camera on", exact: true })
          .click();
        await green(b);
      } finally {
        if (call)
          await alice.request.post(`${base}/${call}/end`, {
            headers,
            data: {},
          });
        await alice.close();
        await bob.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test("chat audio/video initiation stays real and deduplicated; answer, decline and cancellation retain call behavior", async () => {
  test.setTimeout(150000);
  const browser = await chromium.launch({ channel: "chrome", args }),
    alice = await browser.newContext({ permissions: ["microphone", "camera"] }),
    bob = await browser.newContext({ permissions: ["microphone", "camera"] }),
    a = await alice.newPage(),
    b = await bob.newPage();
  let call = "";
  try {
    await login(alice, "alice@acme.test");
    await login(bob, "bob@acme.test");
    const created = await alice.request.post(
      `${api}/v1/organizations/${org}/direct-conversation`,
      { headers, data: { userId: bobId } },
    );
    expect(created.status()).toBe(200);
    const channel = (await created.json()).id,
      endpoint = `${api}/v1/organizations/${org}/channels/${channel}/calls`;
    let requests = 0;
    await a.route(endpoint, async (r) => {
      if (r.request().method() === "POST") requests++;
      await r.continue();
    });
    const start = async (mode: "Audio" | "Video") => {
      await a.goto(`http://localhost:3101/?org=${org}&channel=${channel}`);
      const response = a.waitForResponse(
        (r) => r.url() === endpoint && r.request().method() === "POST",
      );
      await a
        .getByRole("button", { name: `${mode} call`, exact: true })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      const result = await response;
      expect(result.status()).toBe(200);
      call = (await result.json()).id;
      return call;
    };
    for (const mode of ["Audio", "Video"] as const) {
      const before = requests;
      await b.goto(`http://localhost:3101/?org=${org}&channel=${channel}`);
      await start(mode);
      await b
        .getByRole("button", {
          name: `Answer with ${mode.toLowerCase()}`,
          exact: true,
        })
        .click();
      for (const p of [a, b]) {
        await expect(
          p.getByRole("status").filter({ hasText: "Connection: connected" }),
        ).toBeVisible({ timeout: 20000 });
        await expect(
          p.getByLabel("Remote camera", { exact: true }),
        ).toHaveCount(mode === "Video" ? 1 : 0, { timeout: 20000 });
        await expect(p.getByLabel("Local camera", { exact: true })).toHaveCount(
          mode === "Video" ? 1 : 0,
        );
      }
      expect(requests - before).toBe(1);
      await settings(b);
      await b.getByText("Call diagnostics", { exact: true }).click();
      await expect
        .poll(
          async () =>
            Number(await b.getByTestId("media-audio-received").textContent()),
          { timeout: 15000 },
        )
        .toBeGreaterThan(0);
      await b
        .getByRole("button", { name: "Mute microphone", exact: true })
        .click();
      await expect(
        a.getByRole("article", { name: "Bob Chen media" }),
      ).toContainText("Microphone muted");
      await b.getByRole("button", { name: "Leave call", exact: true }).click();
      await expect(
        a.getByRole("heading", { name: "Call ended", exact: true }),
      ).toBeVisible({ timeout: 15000 });
    }
    await b.goto(`http://localhost:3101/?org=${org}&channel=${channel}`);
    await start("Audio");
    await expect(
      b.getByRole("button", { name: "Answer with audio", exact: true }),
    ).toBeVisible();
    await a
      .getByRole("button", { name: "Cancel outgoing call", exact: true })
      .click();
    await expect(
      a.getByRole("heading", { name: "Call ended", exact: true }),
    ).toBeVisible();
    await expect(
      b.getByRole("button", { name: "Answer with audio", exact: true }),
    ).toHaveCount(0, { timeout: 10000 });
    await start("Video");
    await b.getByRole("button", { name: "Decline call", exact: true }).click();
    await expect(
      a.getByRole("heading", { name: "Call ended", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    expect(
      (await (await alice.request.get(`${base}/${call}`)).json()).call
        .endReason,
    ).toBe("declined");
  } finally {
    if (call)
      await alice.request.post(`${base}/${call}/end`, { headers, data: {} });
    await browser.close();
  }
});
