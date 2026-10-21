import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
const org = randomUUID(),
  api = "http://localhost:4100/v1",
  base = `${api}/organizations/${org}`,
  headers = { origin: "http://localhost:3101" };
const users = ["owner", "member"].map((role, i) => ({
  id: randomUUID(),
  name: i ? "Jordan Ellis" : "Alex Morgan — Enterprise Collaboration",
  role,
  email: `platform-ux-${i}-${org}@example.test`,
}));
const channels = [
  {
    id: randomUUID(),
    name: "Shared delivery conversation with a long title",
    count: 75,
  },
  { id: randomUUID(), name: "Another working conversation", count: 2 },
];
const db = new pg.Pool({
  connectionString:
    "postgres://concord:local-development-only@localhost:55432/concord",
});
test.beforeAll(async () => {
  await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
    org,
    "Platform UX verification",
  ]);
  for (const u of users) {
    await db.query(
      "INSERT INTO users(id,name,email,password_hash) SELECT $1,$2,$3,password_hash FROM users WHERE email=$4",
      [u.id, u.name, u.email, "alice@acme.test"],
    );
    await db.query(
      "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,$3)",
      [org, u.id, u.role],
    );
  }
  for (const c of channels) {
    await db.query(
      "INSERT INTO channels(id,org_id,name,kind,sequence) VALUES($1,$2,$3,'group',$4)",
      [c.id, org, c.name, c.count],
    );
    for (const u of users)
      await db.query(
        "INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3)",
        [org, c.id, u.id],
      );
    for (let i = 1; i <= c.count; i++)
      await db.query(
        "INSERT INTO messages(id,org_id,channel_id,user_id,client_id,seq,body) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          org,
          c.id,
          users[1].id,
          randomUUID(),
          i,
          `${c.name} — history ${i}\nReview progress and next steps for this milestone.\nAuthorized test-workspace content.`,
        ],
      );
  }
});
test.afterAll(async () => {
  await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
    users.map((u) => u.id),
  ]);
  await db.query("UPDATE memberships SET active=false WHERE org_id=$1", [org]);
  await db.end();
});
async function login(c: BrowserContext, i = 0) {
  expect(
    (
      await c.request.post(`${api}/session`, {
        headers,
        data: { email: users[i].email, password: "Development123!" },
      })
    ).status(),
  ).toBe(200);
}
async function open(p: Page, channel = channels[0].id) {
  await p.goto(`/?org=${org}&channel=${channel}`);
  await expect(
    p.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(p.locator(".message-list .message")).toHaveCount(
    channel === channels[0].id ? 50 : 2,
  );
}
async function remote(c: BrowserContext, body: string) {
  const r = await c.request.post(`${api}/channels/${channels[0].id}/messages`, {
    headers,
    data: { body, clientId: randomUUID() },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id;
}
function distance(p: Page) {
  return p
    .locator(".message-list")
    .evaluate((n) => n.scrollHeight - n.clientHeight - n.scrollTop);
}
test("mobile drawer dismisses consistently and native back/forward preserves drafts and selected sections", async ({
  browser,
}) => {
  const c = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    const toggle = p.getByRole("button", { name: "Toggle conversations" }),
      drawer = p.getByRole("complementary", { name: "Conversations" }),
      input = p.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Keep this draft through section and back navigation");
    await toggle.tap();
    await expect(drawer).toBeVisible();
    await expect(
      p.getByRole("textbox", { name: "Filter conversations" }),
    ).toBeFocused();
    await p.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.tap();
    await p
      .getByRole("button", { name: "Close conversations", exact: true })
      .tap();
    await expect(drawer).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.tap();
    await p
      .getByRole("button", { name: "Dismiss conversations", exact: true })
      .tap({ position: { x: 300, y: 200 }, force: true });
    await expect(drawer).not.toBeVisible();
    await toggle.tap();
    await p.getByRole("button", { name: "Teams", exact: true }).tap();
    await expect(drawer).not.toBeVisible();
    await expect(
      p.getByRole("button", { name: "Teams", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(p).toHaveURL(/view=Teams/);
    await p.getByRole("button", { name: "Settings", exact: true }).tap();
    await p.goBack();
    await expect(
      p.getByRole("heading", { name: "Discover your teams" }),
    ).toBeVisible();
    await p.goBack();
    await expect(input).toHaveValue(
      "Keep this draft through section and back navigation",
    );
    await expect(p.locator(".channel-button.active")).toHaveAttribute(
      "aria-current",
      "page",
    );
    await p.goForward();
    await expect(
      p.getByRole("heading", { name: "Discover your teams" }),
    ).toBeVisible();
    await p.getByRole("button", { name: "Chat", exact: true }).tap();
    await expect(input).toHaveValue(
      "Keep this draft through section and back navigation",
    );
    await expect
      .poll(
        async () =>
          (
            await (
              await c.request.get(`${api}/channels/${channels[0].id}/draft`)
            ).json()
          ).body,
      )
      .toBe("Keep this draft through section and back navigation");
    await p.reload();
    await expect(input).toHaveValue(
      "Keep this draft through section and back navigation",
    );
  } finally {
    await c.close();
  }
});
test("timeline follows latest, protects history readers, deduplicates updates and restores view/prepend anchors", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    await login(a);
    await login(b, 1);
    const p = await a.newPage();
    await open(p);
    const list = p.getByRole("region", { name: "Messages", exact: true });
    await expect.poll(() => distance(p)).toBeLessThan(65);
    await remote(b, "First remote update at latest");
    await expect(list).toContainText("First remote update at latest");
    await expect.poll(() => distance(p)).toBeLessThan(65);
    await list.evaluate((n) => {
      n.scrollTop = 260;
      n.dispatchEvent(new Event("scroll"));
    });
    const top = await list.evaluate((n) => n.scrollTop);
    await remote(b, "Update while reading history");
    await expect(
      p.getByRole("button", { name: "1 new message", exact: true }),
    ).toBeVisible();
    expect(
      Math.abs((await list.evaluate((n) => n.scrollTop)) - top),
    ).toBeLessThan(3);
    await p.getByRole("button", { name: "Teams", exact: true }).click();
    await p.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "1 new message", exact: true }),
    ).toBeVisible();
    expect(
      Math.abs((await list.evaluate((n) => n.scrollTop)) - top),
    ).toBeLessThan(3);
    await p.getByRole("button", { name: "1 new message", exact: true }).click();
    await expect.poll(() => distance(p)).toBeLessThan(3);
    await expect(list).toBeFocused();
    await expect(
      p.getByRole("button", { name: "1 new message", exact: true }),
    ).toHaveCount(0);
    await list.evaluate((n) => {
      n.scrollTop = 0;
      n.dispatchEvent(new Event("scroll"));
    });
    let prependRelease!: () => void;
    const prependGate = new Promise<void>((r) => (prependRelease = r));
    await p.route("**/messages?before=*", async (route) => {
      const response = await route.fetch();
      await prependGate;
      await route.fulfill({ response });
    });
    await p
      .getByRole("button", { name: "Load earlier messages", exact: true })
      .click();
    const anchor = list.locator(".message").first(),
      id = await anchor.getAttribute("id"),
      before = (await anchor.boundingBox())!.y;
    prependRelease();
    await expect(list.locator(".message")).toHaveCount(77);
    expect(
      Math.abs((await p.locator(`#${id}`).boundingBox())!.y - before),
    ).toBeLessThan(4);
    await p.unroute("**/messages?before=*");
    await p.reload();
    await expect(
      p.getByRole("button", { name: "Load earlier messages", exact: true }),
    ).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await p.route("**/messages?before=*", async (route) => {
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await p
      .getByRole("button", { name: "Load earlier messages", exact: true })
      .click();
    await expect(
      p.getByRole("button", { name: "Loading earlier messages…" }),
    ).toBeDisabled();
    await p
      .locator(".sidebar")
      .getByRole("button", { name: channels[1].name, exact: false })
      .click();
    await expect(list.locator(".message")).toHaveCount(2);
    release();
    await expect(list).not.toContainText("Update while reading history");
    await p.unroute("**/messages?before=*");
  } finally {
    await a.close();
    await b.close();
  }
});
test("busy meeting dialogs survive Escape; normal close and context panels restore focus", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const r = await c.request.post(`${base}/meetings`, {
      headers,
      data: {
        title: "Controlled modal meeting",
        startsAt: "2034-06-21T09:00:00Z",
        endsAt: "2034-06-21T10:00:00Z",
        timezone: "UTC",
        attendees: [users[1].id],
      },
    });
    expect(r.status()).toBe(200);
    const meeting = (await r.json()).id,
      p = await c.newPage();
    await open(p);
    await p
      .getByRole("button", { name: "Conversation details", exact: true })
      .click();
    const panel = p.getByRole("complementary", {
      name: "Conversation details",
      exact: true,
    });
    await expect(panel).toBeFocused();
    await p.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(
      p.getByRole("button", { name: "Conversation details", exact: true }),
    ).toBeFocused();
    await p.getByRole("button", { name: "Calendar", exact: true }).click();
    await p.getByLabel("Calendar date", { exact: true }).fill("2034-06-21");
    await p.getByLabel("Calendar view", { exact: true }).selectOption("day");
    await p
      .locator(".calendar-event")
      .filter({ hasText: "Controlled modal meeting" })
      .first()
      .click();
    await p.getByRole("button", { name: "Edit meeting", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "Edit meeting", exact: true });
    await dialog
      .getByLabel("Meeting title", { exact: true })
      .fill("Confirmed controlled modal meeting");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await p.route(`**/meetings/${meeting}/details`, async (route) => {
      if (route.request().method() === "PUT") await gate;
      await route.continue();
    });
    await dialog
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await p.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((n) => (n as HTMLDialogElement).open)).toBe(
      true,
    );
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog).toHaveCount(0);
    expect(
      (
        await (
          await c.request.get(`${base}/meetings/${meeting}/details`)
        ).json()
      ).meeting.title,
    ).toBe("Confirmed controlled modal meeting");
  } finally {
    await c.close();
  }
});
test("short chat layouts, independent context panels and larger text keep the composer usable", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    for (const [width, height] of [
      [1366, 768],
      [390, 844],
      [844, 390],
      [640, 400],
      [320, 568],
    ]) {
      await p.setViewportSize({ width, height });
      await p
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Responsive composer draft");
      await expect
        .poll(() =>
          p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        )
        .toBe(true);
      const rect = await p
        .getByRole("button", { name: "Send message", exact: true })
        .boundingBox();
      expect(rect!.y).toBeGreaterThan(0);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height + 1);
      await p
        .getByRole("button", { name: "Conversation details", exact: true })
        .click();
      const panel = p.getByRole("complementary", {
        name: "Conversation details",
        exact: true,
      });
      await expect(panel).toBeVisible();
      await p
        .getByRole("button", { name: "Send message", exact: true })
        .scrollIntoViewIfNeeded();
      const panelSend = await p
        .getByRole("button", { name: "Send message", exact: true })
        .boundingBox();
      expect(panelSend!.y + panelSend!.height).toBeLessThanOrEqual(height + 1);
      await expect
        .poll(() =>
          p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        )
        .toBe(true);
      await p
        .getByRole("button", {
          name: "Close conversation details",
          exact: true,
        })
        .click();
      await p.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
      );
      await p.screenshot({
        path: `docs/evidence/platform-chat-${width}x${height}.png`,
      });
    }
    await p.setViewportSize({ width: 390, height: 844 });
    await p.getByRole("textbox", { name: "Message", exact: true }).focus();
    await p.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", {
        configurable: true,
        value: 430,
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await expect
      .poll(() =>
        p
          .locator(".application")
          .evaluate((n) => Math.round(n.getBoundingClientRect().height)),
      )
      .toBe(430);
    await expect
      .poll(async () => {
        const box = await p
          .getByRole("textbox", { name: "Message", exact: true })
          .boundingBox();
        return box!.y >= 0 && box!.y + box!.height <= 431;
      })
      .toBe(true);
    const keyboardSend = await p
      .getByRole("button", { name: "Send message", exact: true })
      .boundingBox();
    expect(keyboardSend!.y + keyboardSend!.height).toBeLessThanOrEqual(431);
    await p.screenshot({
      path: "docs/evidence/platform-chat-keyboard-emulation.png",
    });
    await p.evaluate(() => {
      delete (window.visualViewport as unknown as Record<string, unknown>)
        .height;
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await p.setViewportSize({ width: 1366, height: 768 });
    await p.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect
      .poll(() =>
        p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await p
      .getByRole("button", { name: "Send message", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      p.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();
    await p.evaluate(() => {
      document.documentElement.style.zoom = "";
    });
  } finally {
    await c.close();
  }
});
test("core desktop/mobile screens expose selected navigation and pass scoped accessibility checks", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    for (const [width, height] of [
      [1366, 768],
      [390, 844],
    ]) {
      await p.setViewportSize({ width, height });
      for (const section of [
        "Chat",
        "Teams",
        "Calendar",
        "Organization",
        "Activity",
        "Settings",
        "Calls",
      ]) {
        await p.getByRole("button", { name: section, exact: true }).click();
        await expect(
          p.getByRole("button", { name: section, exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect
          .poll(() =>
            p.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        const axe = await new AxeBuilder({ page: p })
          .include("#main")
          .include(".rail")
          .analyze();
        expect(axe.violations, `${section} at ${width}`).toEqual([]);
      }
    }
  } finally {
    await c.close();
  }
});

test("message loading, failed history and retry stay distinct from an empty conversation", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const path = `**/channels/${channels[1].id}/messages`;
    await p.route(path, async (route) => {
      await gate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "History temporarily unavailable" }),
      });
    });
    await p.goto(`/?org=${org}&channel=${channels[1].id}`);
    const status = p.getByRole("region", {
      name: "Conversation history status",
      exact: true,
    });
    await expect(status.getByRole("status")).toHaveText("Loading messages…");
    await expect(status).not.toContainText("No messages yet");
    release();
    await expect(status.getByRole("alert")).toContainText(
      "History temporarily unavailable",
    );
    await p.unroute(path);
    await status.getByRole("button", { name: "Retry messages" }).click();
    await expect(p.locator(".message-list .message")).toHaveCount(2);
    await expect(status.getByRole("alert")).toHaveCount(0);
  } finally {
    await c.close();
  }
});

test("a departing profile card cannot dismiss a newly opened account menu", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    await p
      .getByRole("button", {
        name: "Profile details for Jordan Ellis",
        exact: true,
      })
      .first()
      .hover();
    await expect(
      p.getByRole("dialog", {
        name: "Profile details for Jordan Ellis",
        exact: true,
      }),
    ).toBeVisible();
    await p.mouse.move(25, 20);
    await p.getByRole("button", { name: "Account menu", exact: true }).click();
    const menu = p.getByRole("dialog", { name: "Account menu", exact: true });
    await expect(menu).toBeVisible();
    await p.waitForTimeout(250);
    await expect(menu).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  } finally {
    await c.close();
  }
});
