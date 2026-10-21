import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
const org = randomUUID(),
  foreign = randomUUID(),
  api = "http://localhost:4100/v1",
  base = `${api}/organizations/${org}`,
  headers = { origin: "http://localhost:3101" };
const users = Array.from({ length: 28 }, (_, i) => ({
  id: randomUUID(),
  name:
    i === 0
      ? "Picker organizer"
      : i === 1
        ? "Sam Taylor"
        : i === 2
          ? "Sam Taylor"
          : "Picker colleague " + String(i).padStart(2, "0"),
  email: `picker-${i}-${org}@example.test`,
}));
const db = new pg.Pool({
  connectionString:
    "postgres://concord:local-development-only@localhost:55432/concord",
});
test.beforeAll(async () => {
  await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
    org,
    "Attendee picker verification",
  ]);
  for (const u of users) {
    await db.query(
      "INSERT INTO users(id,email,name,title,password_hash) SELECT $1,$2,$3,$4,password_hash FROM users WHERE email=$5",
      [u.id, u.email, u.name, "Employee", "alice@acme.test"],
    );
    await db.query(
      "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'member')",
      [org, u.id],
    );
  }
  await db.query(
    "INSERT INTO organization_people(org_id,user_id,visibility) VALUES($1,$2,'restricted')",
    [org, users[27].id],
  );
  await db.query(
    "UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2",
    [org, users[26].id],
  );
  await db.query("UPDATE users SET disabled=true WHERE id=$1", [users[25].id]);
});
test.afterAll(async () => {
  await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
    users.map((u) => u.id),
  ]);
  await db.query("UPDATE memberships SET active=false WHERE org_id=$1", [org]);
  await db.end();
});
async function login(c: BrowserContext) {
  expect(
    (
      await c.request.post(`${api}/session`, {
        headers,
        data: { email: users[0].email, password: "Development123!" },
      })
    ).status(),
  ).toBe(200);
}
async function schedule(p: Page) {
  await p.goto(`/?org=${org}`);
  await p.getByRole("button", { name: "Calendar", exact: true }).click();
  await p
    .getByRole("button", { name: "Schedule meeting", exact: true })
    .click();
  return p.getByRole("dialog", { name: "Schedule a meeting", exact: true });
}
const data = {
  title: "Picker selected meeting",
  startsAt: "2034-06-21T09:00:00Z",
  endsAt: "2034-06-21T10:00:00Z",
  timezone: "UTC",
  attendees: [],
};
test("search API is tenant-scoped, bounded, literal, private and revalidates submitted membership", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const seen: string[] = [];
    let cursor: { name: string; id: string } | null = null;
    do {
      const q = new URLSearchParams({ q: "Picker colleague" });
      if (cursor) {
        q.set("afterName", cursor.name);
        q.set("afterId", cursor.id);
      }
      const r = await c.request.get(`${base}/attendee-options?${q}`);
      expect(r.status(), await r.text()).toBe(200);
      const b = await r.json();
      expect(b.people.length).toBeLessThanOrEqual(20);
      seen.push(...b.people.map((p: { id: string }) => p.id));
      cursor = b.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(22);
    expect(new Set(seen).size).toBe(seen.length);
    for (const i of [0, 25, 26, 27]) expect(seen).not.toContain(users[i].id);
    const email = await (
      await c.request.get(`${base}/attendee-options?q=${users[1].email}`)
    ).json();
    expect(email.people.map((p: { id: string }) => p.id)).toEqual([
      users[1].id,
    ]);
    expect(
      (await (await c.request.get(`${base}/attendee-options?q=%25`)).json())
        .people,
    ).toEqual([]);
    expect(
      (await (await c.request.get(`${base}/attendee-options`)).json()).people,
    ).toEqual([]);
    expect(
      (
        await c.request.get(
          `${api}/organizations/${foreign}/attendee-options?q=Sam`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await c.request.get(`${base}/attendee-options?q=Sam&admin=true`)
      ).status(),
    ).toBe(400);
    const invalid = [users[25].id, users[26].id, foreign];
    for (const id of invalid) {
      const r = await c.request.post(`${base}/meetings`, {
        headers,
        data: { ...data, attendees: [id] },
      });
      expect(r.status()).toBe(404);
      expect((await r.json()).error).toContain(id);
      const instant = await c.request.post(`${base}/instant-meetings`, {
        headers,
        data: {
          title: "Rejected",
          mode: "audio",
          clientId: randomUUID(),
          userIds: [id],
        },
      });
      expect(instant.status()).toBe(404);
    }
    const resolved = await (
      await c.request.post(`${base}/attendee-options/resolve`, {
        headers,
        data: { ids: [users[1].id, users[27].id, foreign] },
      })
    ).json();
    expect(resolved.people.map((p: { id: string }) => p.id)).toEqual([
      users[1].id,
    ]);
    expect(resolved.unavailableIds).toEqual([foreign]);
  } finally {
    await c.close();
  }
});
test("meeting creation uses keyboard and chips, preserves failures, ignores stale search and sends exact IDs", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage(),
      dialog = await schedule(p),
      input = dialog.getByRole("combobox", {
        name: "Add attendees",
        exact: true,
      }),
      chips = dialog.getByRole("list", { name: "Selected attendees" });
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await input.fill(users[1].email);
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await input.press("Enter");
    await expect(chips).toContainText("Sam Taylor");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await input.fill("Sam Taylor");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await dialog.getByRole("listbox").getByRole("option").click();
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await input.fill("Sam Taylor");
    await expect(
      dialog.getByText("People on this page are already added.", {
        exact: true,
      }),
    ).toBeVisible();
    await input.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await chips
      .getByRole("button", { name: "Remove Sam Taylor" })
      .first()
      .click();
    await expect(chips.getByRole("listitem")).toHaveCount(1);
    await input.fill(users[1].email);
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await input.press("Enter");
    await p.route("**/attendee-options?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") === "failure")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Directory temporarily unavailable" }),
        });
      else await route.continue();
    });
    await input.fill("failure");
    await expect(
      dialog
        .getByRole("alert")
        .filter({ hasText: "Directory temporarily unavailable" }),
    ).toBeVisible();
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await p.unroute("**/attendee-options?*");
    await dialog.getByRole("button", { name: "Retry search" }).click();
    await expect(
      dialog.getByText("No eligible people found.", { exact: true }),
    ).toBeVisible();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await p.route("**/attendee-options?*", async (route) => {
      const response = await route.fetch();
      if (
        new URL(route.request().url()).searchParams.get("q") ===
        "Picker colleague 03"
      ) {
        await gate;
        await route.fulfill({ response }).catch(() => {});
      } else await route.fulfill({ response });
    });
    await input.fill("Picker colleague 03");
    await expect(dialog.getByText("Searching eligible people…")).toBeVisible();
    await p.waitForTimeout(350);
    await input.fill("Picker colleague 04");
    await expect(dialog.getByRole("listbox").getByRole("option")).toContainText(
      "Picker colleague 04",
    );
    release();
    await expect(
      dialog.getByRole("listbox").getByRole("option"),
    ).not.toContainText("Picker colleague 03");
    await p.unroute("**/attendee-options?*");
    await input.fill("Picker colleague");
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      20,
    );
    const firstOption = dialog.getByRole("listbox").getByRole("option").first();
    await input.press("ArrowDown");
    await expect(firstOption).toHaveAttribute("aria-selected", "false");
    await input.press("ArrowUp");
    await expect(firstOption).toHaveAttribute("aria-selected", "true");
    await dialog.getByRole("button", { name: "Next results" }).click();
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      2,
    );
    await dialog.getByRole("button", { name: "Previous results" }).click();
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      20,
    );
    await input.press("Escape");
    await dialog.getByLabel("Meeting title", { exact: true }).fill(data.title);
    await dialog.getByLabel("Starts", { exact: true }).fill("2034-06-21T09:00");
    await dialog.getByLabel("Ends", { exact: true }).fill("2034-06-21T10:00");
    await p.route("**/meetings", async (route) => {
      if (route.request().method() === "POST")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Save temporarily unavailable" }),
        });
      else await route.continue();
    });
    await dialog
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    await expect(
      dialog
        .getByRole("alert")
        .filter({ hasText: "Save temporarily unavailable" }),
    ).toBeVisible();
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await p.unroute("**/meetings");
    const saved = p.waitForResponse(
      (r) => r.url() === `${base}/meetings` && r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    expect(response.request().postDataJSON().attendees.sort()).toEqual(
      [users[1].id, users[2].id].sort(),
    );
    await expect(dialog).toHaveCount(0);
    const id = (await response.json()).id;
    const details = await (
      await c.request.get(`${base}/meetings/${id}/details`)
    ).json();
    expect(details.participants.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([users[1].id, users[2].id]),
    );
  } finally {
    await c.close();
  }
});
test("editing preserves roster, flags lost eligibility and supports mobile touch; instant meeting waits for Create", async ({
  browser,
}) => {
  const c = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  let call = "";
  try {
    await login(c);
    const made = await c.request.post(`${base}/meetings`, {
      headers,
      data: { ...data, title: "Edit picker roster", attendees: [users[3].id] },
    });
    expect(made.status()).toBe(200);
    const id = (await made.json()).id,
      p = await c.newPage();
    await p.goto(`/?org=${org}`);
    await p.getByRole("button", { name: "Calendar", exact: true }).click();
    await p.getByLabel("Calendar date", { exact: true }).fill("2034-06-21");
    await p.getByLabel("Calendar view", { exact: true }).selectOption("day");
    await p
      .getByRole("button", { name: /^Edit picker roster,/ })
      .first()
      .click();
    await p.getByRole("button", { name: "Edit meeting", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "Edit meeting", exact: true }),
      input = dialog.getByRole("combobox", { name: "Add attendees" });
    await expect(
      dialog.getByRole("list", { name: "Selected attendees" }),
    ).toContainText(users[3].name);
    await input.fill(users[4].email);
    await expect(dialog.getByRole("listbox").getByRole("option")).toHaveCount(
      1,
    );
    await dialog.getByRole("listbox").getByRole("option").tap();
    await expect(
      dialog
        .getByRole("list", { name: "Selected attendees" })
        .getByRole("listitem"),
    ).toHaveCount(2);
    await db.query(
      "UPDATE memberships SET active=false WHERE org_id=$1 AND user_id=$2",
      [org, users[3].id],
    );
    await dialog.getByRole("button", { name: "Save meeting changes" }).click();
    await expect(
      dialog.getByRole("alert").filter({ hasText: users[3].id }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Unavailable — remove to continue"),
    ).toBeVisible();
    await dialog.getByRole("button", { name: `Remove ${users[3].name}` }).tap();
    await input.fill("Picker colleague");
    await expect(dialog.getByRole("listbox")).toBeVisible();
    const bounds = await dialog.locator(".attendee-dropdown").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await p.screenshot({ path: "docs/evidence/attendee-picker-mobile.png" });
    const axe = await new AxeBuilder({ page: p })
      .include(".attendee-picker")
      .include(".attendee-dropdown")
      .analyze();
    expect(axe.violations).toEqual([]);
    await input.press("Escape");
    await dialog.getByRole("button", { name: "Save meeting changes" }).tap();
    await expect(dialog).toHaveCount(0);
    const details = await (
      await c.request.get(`${base}/meetings/${id}/details`)
    ).json();
    expect(details.participants.map((p: { id: string }) => p.id)).toContain(
      users[4].id,
    );
    expect(details.participants.map((p: { id: string }) => p.id)).not.toContain(
      users[3].id,
    );
    await p.getByRole("button", { name: "Calls", exact: true }).tap();
    const instant = p.getByRole("region", { name: "Instant meeting" });
    await instant
      .getByRole("combobox", { name: "Add attendees" })
      .fill(users[5].email);
    await p.getByRole("listbox").getByRole("option").tap();
    expect((await c.request.get(`${base}/calls`)).status()).toBe(200);
    let requests = 0;
    p.on("request", (r) => {
      if (r.url().endsWith("/instant-meetings") && r.method() === "POST")
        requests++;
    });
    await expect(
      instant.getByRole("list", { name: "Selected attendees" }),
    ).toContainText(users[5].name);
    expect(requests).toBe(0);
    const sent = p.waitForResponse(
      (r) =>
        r.url().endsWith("/instant-meetings") &&
        r.request().method() === "POST",
    );
    await instant.getByRole("button", { name: "Create instant meeting" }).tap();
    const response = await sent;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON().userIds).toEqual([users[5].id]);
    call = (await response.json()).id;
  } finally {
    if (call)
      await c.request.post(`${base}/calls/${call}/end`, { headers, data: {} });
    await db.query(
      "UPDATE memberships SET active=true WHERE org_id=$1 AND user_id=$2",
      [org, users[3].id],
    );
    await c.close();
  }
});
