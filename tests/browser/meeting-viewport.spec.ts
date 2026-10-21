import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
import { chat, people, settings } from "./call-ui";
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
    email: `viewport-alice-${org}@example.test`,
    name: "Alice Morgan",
    role: "owner",
  },
  {
    id: bobId,
    email: `viewport-bob-${org}@example.test`,
    name: "Bob Chen",
    role: "member",
  },
  {
    id: samId,
    email: `viewport-sam-${org}@example.test`,
    name: "Sam Rivera — International Engineering and Customer Collaboration",
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
      `Meeting viewport verification ${org}`,
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
          email:
            fixtureUsers[
              email === "alice@acme.test"
                ? 0
                : email === "bob@acme.test"
                  ? 1
                  : 2
            ].email,
          password: "Development123!",
        },
      })
    ).status(),
  ).toBe(200);
}

async function fit(p: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      p.evaluate(() => {
        const targets = [
          ".main",
          ".integrated-call",
          ".call-stage",
          ".call-gallery-viewport",
          ".fitted-gallery",
        ];
        const viewport = document
          .querySelector<HTMLElement>(".call-gallery-viewport")!
          .getBoundingClientRect();
        const tiles = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".fitted-gallery > article:not([hidden])",
          ),
        );
        const contained =
          tiles.length > 0 &&
          tiles.every((tile) => {
            const rect = tile.getBoundingClientRect(),
              caption = tile
                .querySelector<HTMLElement>(".call-tile-caption")!
                .getBoundingClientRect();
            return (
              rect.left >= viewport.left - 1 &&
              rect.top >= viewport.top - 1 &&
              rect.right <= viewport.right + 1 &&
              rect.bottom <= viewport.bottom + 1 &&
              caption.bottom <= rect.bottom + 1
            );
          });
        return (
          contained &&
          viewport.height > 50 &&
          targets.every((selector) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            return (
              element.clientHeight > 0 &&
              element.scrollHeight <= element.clientHeight + 2 &&
              element.scrollWidth <= element.clientWidth + 2
            );
          })
        );
      }),
    )
    .toBe(true);
  for (const name of [
    /^(Mute|Unmute) microphone$/,
    /^Turn camera (on|off)$/,
    "Share screen",
    "More options",
    "Leave call",
  ])
    await expect(
      p
        .getByRole("toolbar", { name: "Call controls" })
        .getByRole("button", { name, exact: true }),
    ).toBeInViewport();
  expect(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
}
async function closePanel(p: import("@playwright/test").Page) {
  const close = p.getByRole("button", {
    name: "Close call panel",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}
test("bounded live gallery: viewport matrix, pages, pinning, panels, media continuity and wide/tall sharing", async () => {
  test.setTimeout(180000);
  const browser = await chromium.launch({ channel: "chrome", args });
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({
        permissions: ["camera", "microphone"],
        viewport: { width: 1440, height: 900 },
      }),
    ),
  );
  let call = "";
  try {
    await Promise.all(
      contexts.map((c, i) =>
        login(
          c,
          i === 0
            ? "alice@acme.test"
            : i === 1
              ? "bob@acme.test"
              : "sam@partner.test",
        ),
      ),
    );
    const response = await contexts[0].request.post(
      `${api}/v1/organizations/${org}/instant-meetings`,
      {
        headers,
        data: {
          clientId: randomUUID(),
          title: "Bounded meeting verification",
          mode: "video",
          userIds: [bobId, samId],
        },
      },
    );
    expect(response.status()).toBe(200);
    call = (await response.json()).id;
    const [a, b, c] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    await a.goto(`/?org=${org}&call=${call}`);
    await a
      .getByRole("checkbox", { name: "Enable camera when joining" })
      .check();
    await a.getByRole("button", { name: "Join call", exact: true }).click();
    for (const p of [b, c]) {
      await p.goto(`/?org=${org}`);
      await p
        .getByRole("button", { name: "Answer with video", exact: true })
        .click();
    }
    await expect(a.getByRole("article")).toHaveCount(3);
    await expect
      .poll(() =>
        b
          .getByLabel("Remote camera", { exact: true })
          .first()
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    const localId = await a
      .getByLabel("Local camera", { exact: true })
      .evaluate(
        (v: HTMLVideoElement) =>
          (v.srcObject as MediaStream).getVideoTracks()[0].id,
      );
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1366, 768],
      [1024, 600],
      [834, 1194],
      [1194, 834],
      [390, 844],
      [844, 390],
      [360, 740],
    ]) {
      await a.setViewportSize({ width, height });
      await fit(a);
      await a.screenshot({
        path: `docs/evidence/meeting-fit-${width}x${height}.png`,
      });
      if ([1440, 390, 844].includes(width)) {
        await chat(a);
        await a
          .getByRole("textbox", { name: "Call message", exact: true })
          .fill("Draft survives bounded panels");
        await fit(a);
        await people(a);
        await fit(a);
        await closePanel(a);
        await chat(a);
        await expect(
          a.getByRole("textbox", { name: "Call message", exact: true }),
        ).toHaveValue("Draft survives bounded panels");
        await closePanel(a);
      }
    }
    await a.setViewportSize({ width: 1440, height: 900 });
    await chat(a);
    await chat(b);
    const history = Array.from(
      { length: 40 },
      (_, i) => `Bounded history line ${i + 1}`,
    ).join("\n");
    await a
      .getByRole("textbox", { name: "Call message", exact: true })
      .fill(history);
    await a
      .getByRole("button", { name: "Send call message", exact: true })
      .click();
    await expect(
      b.getByRole("list", { name: "Call messages", exact: true }),
    ).toContainText("Bounded history line 40");
    await expect
      .poll(() =>
        b
          .getByRole("list", { name: "Call messages", exact: true })
          .evaluate((e) => e.scrollHeight > e.clientHeight),
      )
      .toBe(true);
    await closePanel(a);
    await closePanel(b);
    await people(a);
    await a.getByRole("button", { name: "Mute Bob Chen", exact: true }).click();
    await expect(
      b.getByRole("button", { name: "Unmute microphone", exact: true }),
    ).toBeVisible();
    await b
      .getByRole("button", { name: "Unmute microphone", exact: true })
      .click();
    await closePanel(a);
    await a.setViewportSize({ width: 390, height: 844 });
    await a.evaluate(() => {
      Object.defineProperty(window.visualViewport!, "height", {
        value: 430,
        configurable: true,
      });
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() =>
        a
          .locator(".application")
          .evaluate((e) => Math.round(e.getBoundingClientRect().height)),
      )
      .toBe(430);
    await chat(a);
    await fit(a);
    await closePanel(a);
    await a.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, "height");
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });
    await a.setViewportSize({ width: 390, height: 500 });
    await expect(
      a.getByRole("navigation", { name: "Participant pages" }),
    ).toContainText("of 3");
    const seen = new Set<string>();
    while (
      !(await a
        .getByRole("button", { name: "Previous participant page" })
        .isDisabled())
    )
      await a
        .getByRole("button", { name: "Previous participant page" })
        .click();
    for (let i = 0; i < 5; i++) {
      for (const tile of await a.getByRole("article").all())
        seen.add((await tile.getAttribute("aria-label"))!);
      if (
        await a
          .getByRole("button", { name: "Next participant page" })
          .isDisabled()
      )
        break;
      await a.getByRole("button", { name: "Next participant page" }).click();
      await fit(a);
    }
    expect(seen.size).toBe(3);
    await a.getByRole("button", { name: "More options", exact: true }).click();
    await a.getByRole("button", { name: "Raise hand", exact: true }).click();
    await expect(
      a.getByRole("button", { name: "Lower hand", exact: true }),
    ).toBeVisible();
    await a.getByRole("button", { name: "Lower hand", exact: true }).click();
    await a.getByRole("button", { name: "Participants", exact: true }).click();
    await a.keyboard.press("Escape");
    await expect(
      a.getByRole("button", { name: "More options", exact: true }),
    ).toBeFocused();
    while (
      !(await a
        .getByRole("button", { name: "Previous participant page" })
        .isDisabled())
    )
      await a
        .getByRole("button", { name: "Previous participant page" })
        .click();
    while (
      !(await a
        .getByRole("button", { name: "Pin Bob Chen", exact: true })
        .isVisible())
    )
      await a.getByRole("button", { name: "Next participant page" }).click();
    await a.getByRole("button", { name: "Pin Bob Chen", exact: true }).click();
    await expect(a.locator(".featured-tile")).toContainText("Bob Chen");
    await fit(a);
    await a
      .getByRole("button", { name: "Unpin Bob Chen", exact: true })
      .click();
    await a
      .getByRole("combobox", { name: "Meeting layout", exact: true })
      .selectOption("grid");
    await a.setViewportSize({ width: 1440, height: 900 });
    expect(
      await a
        .getByLabel("Local camera", { exact: true })
        .evaluate(
          (v: HTMLVideoElement) =>
            (v.srcObject as MediaStream).getVideoTracks()[0].id,
        ),
    ).toBe(localId);
    await a.getByRole("button", { name: "Share screen", exact: true }).click();
    await expect(
      b.getByRole("region", { name: "Alice Morgan is presenting" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        b
          .getByLabel("Remote screen share", { exact: true })
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      )
      .toBeGreaterThan(0);
    await a
      .getByRole("button", { name: "Stop screen sharing", exact: true })
      .click();
    // A synthetic tall capture is published through the real screen-share permission/SDK path.
    await a.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 1000;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#eeeeee";
      ctx.fillRect(0, 0, 600, 1000);
      ctx.fillStyle = "#222222";
      ctx.font = "32px sans-serif";
      ctx.fillText("Tall shared document", 30, 60);
      const stream = canvas.captureStream(15);
      const timer = setInterval(() => {
        ctx.fillStyle = "#eeeeee";
        ctx.fillRect(0, 80, 600, 920);
        ctx.fillStyle = "#222222";
        ctx.fillText(String(Date.now()), 30, 120);
      }, 60);
      stream
        .getVideoTracks()[0]
        .addEventListener("ended", () => clearInterval(timer));
      navigator.mediaDevices.getDisplayMedia = async () => stream;
      Object.assign(window, { testShare: stream });
    });
    await a.getByRole("button", { name: "Share screen", exact: true }).click();
    await expect
      .poll(() =>
        b
          .getByLabel("Remote screen share", { exact: true })
          .evaluate((v: HTMLVideoElement) => v.videoHeight / v.videoWidth),
      )
      .toBeGreaterThan(1);
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await b.setViewportSize(size);
      const stage = b.locator(".call-stage");
      await expect
        .poll(() =>
          stage.evaluate(
            (e) =>
              e.scrollHeight <= e.clientHeight + 2 &&
              e.scrollWidth <= e.clientWidth + 2,
          ),
        )
        .toBe(true);
      expect(
        await b
          .getByLabel("Remote screen share", { exact: true })
          .evaluate((v) => getComputedStyle(v).objectFit),
      ).toBe("contain");
      await expect(
        b.getByRole("button", { name: "Leave call", exact: true }),
      ).toBeInViewport();
      await b.screenshot({
        path: `docs/evidence/meeting-share-${size.width}x${size.height}.png`,
      });
    }
    await a.evaluate(() => {
      const stream = (window as unknown as { testShare: MediaStream })
        .testShare;
      for (const track of stream.getTracks()) {
        track.stop();
        track.dispatchEvent(new Event("ended"));
      }
    });
    await expect(
      b.getByRole("region", { name: "Alice Morgan is presenting" }),
    ).toHaveCount(0);
    await a.setViewportSize({ width: 1440, height: 900 });
    const aliceRemote = b
      .getByRole("article", { name: "Alice Morgan media", exact: true })
      .getByLabel("Remote camera", { exact: true });
    const framesBefore = await aliceRemote.evaluate(
      (video: HTMLVideoElement) =>
        video.getVideoPlaybackQuality().totalVideoFrames,
    );
    await contexts[0].setOffline(true);
    await expect(
      a
        .getByRole("status")
        .filter({ hasText: "Authorization temporarily unavailable" }),
    ).toBeVisible({ timeout: 12000 });
    await fit(a);
    await contexts[0].setOffline(false);
    await expect(
      a
        .getByRole("status")
        .filter({ hasText: "Authorization temporarily unavailable" }),
    ).toHaveCount(0, { timeout: 12000 });
    await expect
      .poll(
        () =>
          aliceRemote.evaluate(
            (video: HTMLVideoElement) =>
              video.getVideoPlaybackQuality().totalVideoFrames,
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(framesBefore + 10);
    await a.setViewportSize({ width: 640, height: 400 });
    await a.evaluate(() => (document.documentElement.style.fontSize = "125%"));
    await fit(a);
    await a.evaluate(() => (document.documentElement.style.fontSize = ""));
    await a.setViewportSize({ width: 1440, height: 900 });
    await settings(b);
    await b.getByText("Call diagnostics", { exact: true }).click();
    await expect
      .poll(async () =>
        Number(await b.getByTestId("media-audio-received").textContent()),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        Number(await b.getByTestId("media-video-received").textContent()),
      )
      .toBeGreaterThan(0);
    await closePanel(b);
    await c.getByRole("button", { name: "Leave call", exact: true }).click();
    await expect(a.locator(".fitted-gallery > article")).toHaveCount(2);
    await expect(b.locator(".fitted-gallery > article")).toHaveCount(2);
    for (const [width, height] of [
      [1366, 768],
      [390, 844],
      [844, 390],
    ]) {
      await a.setViewportSize({ width, height });
      await fit(a);
      await expect(a.locator(".featured-tile")).toContainText("Bob Chen");
      await a.screenshot({
        path: `docs/evidence/meeting-pair-${width}x${height}.png`,
      });
    }
    await a
      .getByRole("button", { name: "Turn camera off", exact: true })
      .click();
    await b
      .getByRole("button", { name: "Turn camera off", exact: true })
      .click();
    for (const p of [a, b])
      await expect(p.getByLabel("Remote camera", { exact: true })).toHaveCount(
        0,
      );
    for (const [width, height] of [
      [1366, 768],
      [390, 844],
      [844, 390],
    ]) {
      await a.setViewportSize({ width, height });
      await fit(a);
      await expect(a.locator(".audio-only")).toBeVisible();
      await a.screenshot({
        path: `docs/evidence/meeting-avatars-${width}x${height}.png`,
      });
    }
    await a.setViewportSize({ width: 1440, height: 900 });
    await settings(b);
    const audioBefore = Number(
      await b.getByTestId("media-audio-received").textContent(),
    );
    await expect
      .poll(async () =>
        Number(await b.getByTestId("media-audio-received").textContent()),
      )
      .toBeGreaterThan(audioBefore);
    await closePanel(b);
    expect(
      (
        await new AxeBuilder({ page: a })
          .include(".bounded-meeting")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await a
      .getByRole("button", { name: "End call for everyone", exact: true })
      .click();
    await a
      .getByRole("button", { name: "Confirm end meeting", exact: true })
      .click();
    for (const p of [a, b, c])
      await expect(
        p.getByRole("region", { name: "Live call", exact: true }),
      ).toHaveCount(0);
  } finally {
    if (call)
      await contexts[0].request
        .post(`${base}/${call}/end`, { headers, data: {} })
        .catch(() => {});
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await browser.close();
  }
});
