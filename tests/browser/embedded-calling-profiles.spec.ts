import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
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
    email: `embedded-alice-${org}@example.test`,
    name: "Alice Morgan",
    role: "owner",
  },
  {
    id: bobId,
    email: `embedded-bob-${org}@example.test`,
    name: "Bob Chen",
    role: "member",
  },
  {
    id: samId,
    email: `embedded-sam-${org}@example.test`,
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
      `Embedded calling verification ${org}`,
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

test("embedded group media survives navigation, panels and dock controls; host termination releases devices", async () => {
  test.setTimeout(100000);
  const browser = await chromium.launch({ channel: "chrome", args });
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({
        permissions: ["camera", "microphone"],
        viewport: { width: 1280, height: 800 },
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
    const made = await contexts[0].request.post(
      `${api}/v1/organizations/${org}/instant-meetings`,
      {
        headers,
        data: {
          clientId: randomUUID(),
          title: "Embedded group verification",
          mode: "video",
          userIds: [bobId, samId],
        },
      },
    );
    expect(made.status()).toBe(200);
    call = (await made.json()).id;
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    let popups = 0;
    pages.forEach((p) => p.on("popup", () => popups++));
    await pages[0].goto(`/?org=${org}&call=${call}`);
    await pages[0]
      .getByRole("checkbox", { name: "Enable camera when joining" })
      .check();
    await pages[0]
      .getByRole("button", { name: "Join call", exact: true })
      .click();
    for (const p of pages.slice(1)) {
      await p.goto(`/?org=${org}`);
      await p
        .getByRole("button", { name: "Answer with video", exact: true })
        .click();
    }
    for (const p of pages) {
      await expect(
        p.getByRole("region", { name: "Call area", exact: true }),
      ).toBeVisible();
      await expect(
        p.getByRole("navigation", { name: "Main navigation" }),
      ).toBeVisible();
      await expect(p.getByRole("dialog", { name: "Call window" })).toHaveCount(
        0,
      );
      await expect
        .poll(() => p.getByLabel("Remote camera", { exact: true }).count(), {
          timeout: 15000,
        })
        .toBe(2);
      await expect
        .poll(() =>
          p
            .getByLabel("Remote camera", { exact: true })
            .first()
            .evaluate((v: HTMLVideoElement) => v.videoWidth),
        )
        .toBeGreaterThan(0);
    }
    const a = pages[0],
      b = pages[1],
      track = await a
        .getByLabel("Local camera", { exact: true })
        .evaluate(
          (v: HTMLVideoElement) =>
            (v.srcObject as MediaStream).getVideoTracks()[0].id,
        );
    await a
      .getByRole("button", {
        name: "Profile details for Bob Chen",
        exact: true,
      })
      .hover();
    await a
      .getByRole("button", {
        name: "Profile details for Sam Rivera",
        exact: true,
      })
      .hover();
    const samCard = a.getByRole("dialog", {
      name: "Profile details for Sam Rivera",
      exact: true,
    });
    await expect(samCard).toContainText(fixtureUsers[2].email);
    await expect(
      a.getByRole("dialog", {
        name: "Profile details for Bob Chen",
        exact: true,
      }),
    ).toHaveCount(0);
    await samCard.hover();
    await a.screenshot({ path: "docs/evidence/profile-card-desktop.png" });
    await a.keyboard.press("Escape");
    await a.getByRole("button", { name: "Participants", exact: true }).click();
    await expect(
      a.getByRole("heading", { name: "Participants", exact: true }),
    ).toBeVisible();
    await a.getByRole("button", { name: "Call chat", exact: true }).click();
    await expect(
      a.getByRole("heading", { name: "Call chat", exact: true }),
    ).toBeVisible();
    await a
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Teams", exact: true })
      .click();
    const dock = a.getByRole("region", { name: "Active call dock" });
    await expect(dock).toBeVisible();
    await expect(
      a.getByRole("region", { name: "Call area", exact: true }),
    ).not.toBeVisible();
    await dock
      .getByRole("button", { name: "Mute microphone", exact: true })
      .click();
    await expect(
      b.getByRole("article", { name: "Alice Morgan media" }),
    ).toContainText("Microphone muted");
    await dock
      .getByRole("button", { name: "Unmute microphone", exact: true })
      .click();
    await expect(
      b.getByRole("article", { name: "Alice Morgan media" }),
    ).toContainText("Microphone on");
    await a
      .getByRole("textbox", { name: "Search this workspace", exact: true })
      .fill("embedded");
    await a
      .getByRole("textbox", { name: "Search this workspace", exact: true })
      .press("Enter");
    await expect(
      a.getByRole("region", { name: "Workspace search results" }),
    ).toBeVisible();
    await dock.getByRole("button", { name: "Return to call" }).click();
    await expect(
      a.getByRole("region", { name: "Workspace search results" }),
    ).toHaveCount(0);
    expect(
      await a
        .getByLabel("Local camera", { exact: true })
        .evaluate(
          (v: HTMLVideoElement) =>
            (v.srcObject as MediaStream).getVideoTracks()[0].id,
        ),
    ).toBe(track);
    await a
      .getByRole("button", { name: "Close call panel", exact: true })
      .click();
    await a.screenshot({ path: "docs/evidence/embedded-call-desktop.png" });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect(
      a.getByRole("button", { name: "Leave call", exact: true }),
    ).toBeInViewport();
    expect(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await a
      .getByRole("button", {
        name: "Profile details for Bob Chen",
        exact: true,
      })
      .click();
    const mobileCard = a.getByRole("dialog", {
      name: "Profile details for Bob Chen",
      exact: true,
    });
    await expect(mobileCard).toBeVisible();
    const cardBounds = await mobileCard.boundingBox(),
      toolbarBounds = await a
        .getByRole("toolbar", { name: "Call controls", exact: true })
        .boundingBox();
    expect(cardBounds!.y + cardBounds!.height).toBeLessThanOrEqual(
      toolbarBounds!.y,
    );
    await a.keyboard.press("Escape");
    await a.screenshot({ path: "docs/evidence/embedded-call-mobile.png" });
    await a.setViewportSize({ width: 1280, height: 800 });
    expect(popups).toBe(0);
    await a
      .getByRole("button", { name: "End call for everyone", exact: true })
      .click();
    await a
      .getByRole("button", { name: "Confirm end meeting", exact: true })
      .click();
    for (const p of pages)
      await expect(
        p.getByRole("region", { name: "Live call", exact: true }),
      ).toHaveCount(0);
  } finally {
    if (call)
      await contexts[0].request
        .post(`${base}/${call}/end`, { headers, data: {} })
        .catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
  }
});
test("profile cards and account menu support hover, pointer bridge, keyboard, dismissal, theme and authorized actions", async () => {
  test.setTimeout(60000);
  const browser = await chromium.launch({ channel: "chrome", args });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  });
  try {
    await login(context, "alice@acme.test");
    const p = await context.newPage();
    await p.goto(`/?org=${org}`);
    const account = p.getByRole("button", {
        name: "Account menu",
        exact: true,
      }),
      menu = p.getByRole("dialog", { name: "Account menu", exact: true });
    await account.hover();
    await expect(menu).toBeVisible();
    await menu.hover();
    await expect(menu).toContainText(fixtureUsers[0].email);
    await expect(
      p.getByRole("heading", { name: "Profile & preferences" }),
    ).toHaveCount(0);
    await p.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
    await account.focus();
    await p.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("button", { name: "Profile & account settings" }),
    ).toBeFocused();
    await menu.getByLabel("Theme", { exact: true }).selectOption("dark");
    await expect
      .poll(() => p.locator("html").getAttribute("data-theme"))
      .toBe("dark");
    await menu.getByLabel("Theme", { exact: true }).selectOption("light");
    await expect
      .poll(() => p.locator("html").getAttribute("data-theme"))
      .toBe("light");
    await p.keyboard.press("Escape");
    await expect(account).toBeFocused();
    // Create an authorized conversation, then use its real participant identity in the header.
    const dm = await context.request.post(
      `${api}/v1/organizations/${org}/direct-conversation`,
      { headers, data: { userId: bobId } },
    );
    expect(dm.status()).toBe(200);
    await p.goto(`/?org=${org}&channel=${(await dm.json()).id}`);
    const bob = p
        .getByRole("button", {
          name: "Profile details for Bob Chen",
          exact: true,
        })
        .first(),
      card = p.getByRole("dialog", {
        name: "Profile details for Bob Chen",
        exact: true,
      });
    await bob.hover();
    await expect(card).toBeVisible();
    await card.hover();
    await expect(card).toContainText(fixtureUsers[1].email);
    await card
      .getByRole("button", { name: "View profile", exact: true })
      .click();
    await expect(card).toContainText("Workspace role");
    await p.keyboard.press("Escape");
    await expect(card).not.toBeVisible();
    await bob.focus();
    await p.keyboard.press("Enter");
    await expect(
      card.getByRole("link", { name: fixtureUsers[1].email, exact: true }),
    ).toBeFocused();
    await p.keyboard.press("Tab");
    await expect(
      card.getByRole("button", { name: "Message", exact: true }),
    ).toBeFocused();
    await p.mouse.click(500, 100);
    await expect(card).not.toBeVisible();
    await bob.click();
    await card.getByRole("button", { name: "Message", exact: true }).click();
    await expect(card).not.toBeVisible();
    await bob.hover();
    await account.hover();
    await expect(menu).toBeVisible();
    await expect(card).not.toBeVisible();
    await expect(menu).toContainText(fixtureUsers[0].email);
    expect(
      (
        await new AxeBuilder({ page: p })
          .include(".profile-popover")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await p.keyboard.press("Escape");
    await p.setViewportSize({ width: 390, height: 844 });
    await account.tap();
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await p.screenshot({ path: "docs/evidence/account-menu-mobile.png" });
    await p.keyboard.press("Escape");
    await p.setViewportSize({ width: 1280, height: 800 });
    for (const mode of ["audio", "video"] as const) {
      await bob.click();
      await card
        .getByRole("button", {
          name: mode === "audio" ? "Audio call" : "Video call",
          exact: true,
        })
        .click();
      await expect(
        p.getByRole("region", { name: "Call area", exact: true }),
      ).toBeVisible();
      await expect(
        p.getByRole("status").filter({ hasText: "Connection: connected" }),
      ).toBeVisible();
      const calls = (await (await context.request.get(base)).json()).calls;
      const current = calls.find(
        (c: { ended_at: string | null }) => !c.ended_at,
      );
      expect(current).toBeTruthy();
      const details = await (
        await context.request.get(`${base}/${current.id}`)
      ).json();
      expect(details.call.mode).toBe(mode);
      expect(
        details.invitations.some(
          (i: { user_id: string }) => i.user_id === bobId,
        ),
      ).toBe(true);
      expect(
        details.invitations.some(
          (i: { user_id: string }) => i.user_id === samId,
        ),
      ).toBe(false);
      await p
        .getByRole("button", { name: "Cancel outgoing call", exact: true })
        .click();
      await expect(
        p.getByRole("region", { name: "Live call", exact: true }),
      ).toHaveCount(0);
      await p
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("button", { name: "Chat", exact: true })
        .click();
    }
    await account.click();
    await menu
      .getByRole("button", { name: "Profile & account settings", exact: true })
      .click();
    await expect(
      p.getByRole("heading", { name: "Profile & preferences", exact: true }),
    ).toBeVisible();
    await expect(menu).not.toBeVisible();
    await account.click();
    await menu
      .getByLabel("Account availability", { exact: true })
      .selectOption("away");
    await expect(
      menu.getByLabel("Account availability", { exact: true }),
    ).toHaveValue("away");
    await menu.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});

test("group audio stays compact, receives real audio, permits independent leave and stops capture on termination", async () => {
  test.setTimeout(60000);
  const browser = await chromium.launch({ channel: "chrome", args });
  const contexts = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({ permissions: ["microphone", "camera"] }),
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
    const made = await contexts[0].request.post(
      `${api}/v1/organizations/${org}/instant-meetings`,
      {
        headers,
        data: {
          clientId: randomUUID(),
          title: "Embedded audio group",
          mode: "audio",
          userIds: [bobId, samId],
        },
      },
    );
    expect(made.status()).toBe(200);
    call = (await made.json()).id;
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (const p of pages)
      await p.addInitScript(() => {
        const tracks: MediaStreamTrack[] = [];
        Object.assign(window, { callTestTracks: tracks });
        const original = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await original(constraints);
          tracks.push(...stream.getTracks());
          return stream;
        };
      });
    await pages[0].goto(`/?org=${org}&call=${call}`);
    await pages[0]
      .getByRole("button", { name: "Join call", exact: true })
      .click();
    for (const p of pages.slice(1)) {
      await p.goto(`/?org=${org}`);
      await p
        .getByRole("button", { name: "Answer with audio", exact: true })
        .click();
    }
    for (const p of pages) {
      await expect(p.getByRole("article")).toHaveCount(3);
      await expect(p.locator(".audio-only")).toBeVisible();
      await expect(p.locator("video")).toHaveCount(0);
    }
    const [a, b, c] = pages;
    await b
      .getByRole("button", { name: "Device settings", exact: true })
      .click();
    await b.getByText("Call diagnostics", { exact: true }).click();
    await expect
      .poll(async () =>
        Number(await b.getByTestId("media-audio-received").textContent()),
      )
      .toBeGreaterThan(0);
    await b
      .getByRole("button", { name: "Close call panel", exact: true })
      .click();
    await c.getByRole("button", { name: "Leave call", exact: true }).click();
    await expect(a.getByRole("article")).toHaveCount(2);
    await expect(b.getByRole("article")).toHaveCount(2);
    await b
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Teams", exact: true })
      .click();
    await expect(
      b.getByRole("region", { name: "Active call dock" }),
    ).toBeVisible();
    await a
      .getByRole("button", { name: "End call for everyone", exact: true })
      .click();
    await a
      .getByRole("button", { name: "Confirm end meeting", exact: true })
      .click();
    await expect(
      b.getByRole("complementary", { name: "Call status" }),
    ).toContainText("The meeting ended");
    await expect(
      b.getByRole("region", { name: "Active call dock" }),
    ).toHaveCount(0);
    await b
      .getByRole("button", { name: "View call details", exact: true })
      .click();
    await expect(
      b.getByRole("heading", { name: "Call ended", exact: true }),
    ).toBeVisible();
    for (const p of pages)
      await expect
        .poll(() =>
          p.evaluate(() =>
            (
              window as unknown as { callTestTracks: MediaStreamTrack[] }
            ).callTestTracks.every((t) => t.readyState === "ended"),
          ),
        )
        .toBe(true);
  } finally {
    if (call)
      await contexts[0].request
        .post(`${base}/${call}/end`, { headers, data: {} })
        .catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
    await browser.close();
  }
});
