import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
const org = randomUUID(),
  owner = randomUUID(),
  attendee = randomUUID(),
  api = "http://localhost:4100/v1",
  base = `${api}/organizations/${org}`,
  headers = { origin: "http://localhost:3101" };
const users = [
  {
    id: owner,
    name: "Calendar organizer",
    email: `calendar-owner-${org}@example.test`,
    role: "owner",
  },
  {
    id: attendee,
    name: "Calendar attendee",
    email: `calendar-attendee-${org}@example.test`,
    role: "member",
  },
];
test.beforeAll(async () => {
  const db = new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
  });
  try {
    await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
      org,
      `Scheduling regression ${org}`,
    ]);
    for (const u of users) {
      await db.query(
        "INSERT INTO users(id,email,name,password_hash) SELECT $1,$2,$3,password_hash FROM users WHERE email=$4",
        [u.id, u.email, u.name, "alice@acme.test"],
      );
      await db.query(
        "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,$3)",
        [org, u.id, u.role],
      );
    }
  } finally {
    await db.end();
  }
});
test.afterAll(async () => {
  const db = new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
  });
  try {
    await db.query("UPDATE memberships SET active=false WHERE org_id=$1", [
      org,
    ]);
    await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
      [owner, attendee],
    ]);
  } finally {
    await db.end();
  }
});
async function login(c: BrowserContext, index = 0) {
  const r = await c.request.post(`${api}/session`, {
    headers,
    data: { email: users[index].email, password: "Development123!" },
  });
  expect(r.status()).toBe(200);
}
async function calendar(p: Page, date: string, view = "day") {
  await p.goto(`/?org=${org}`);
  await p.getByRole("button", { name: "Calendar", exact: true }).click();
  await p.getByLabel("Calendar date", { exact: true }).fill(date);
  await p.getByLabel("Calendar view", { exact: true }).selectOption(view);
}
function event(p: Page, title: string) {
  return p
    .locator(".calendar-time-scroll .calendar-event")
    .filter({ hasText: title })
    .first();
}
async function details(p: Page, title: string) {
  await event(p, title).click();
  return p
    .getByRole("dialog")
    .filter({ has: p.getByRole("heading", { name: title, exact: true }) });
}
async function create(
  c: BrowserContext,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const r = await c.request.post(`${base}/meetings`, {
    headers,
    data: {
      title,
      startsAt: "2034-06-21T10:00:00Z",
      endsAt: "2034-06-21T11:00:00Z",
      timezone: "UTC",
      attendees: [attendee],
      ...extra,
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
async function openEditor(p: Page, title: string) {
  const card = await details(p, title);
  await card.getByRole("button", { name: "Edit meeting", exact: true }).click();
  return p.getByRole("dialog", { name: "Edit meeting", exact: true });
}
test("calendar automatically refreshes organizer edits, attendee removal, re-addition and cancellation", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const a = await browser.newContext(),
    b = await browser.newContext();
  try {
    await login(a);
    await login(b, 1);
    const title = `Calendar update ${randomUUID()}`,
      made = await create(a, title);
    await b.request.patch(`${base}/meetings/${made.id}`, {
      headers,
      data: { response: "accepted" },
    });
    const pa = await a.newPage(),
      pb = await b.newPage();
    await calendar(pa, "2034-06-21");
    await calendar(pb, "2034-06-21");
    const editor = await openEditor(pa, title);
    await editor
      .getByLabel("Meeting title", { exact: true })
      .fill(title + " revised");
    await editor
      .getByLabel("Description", { exact: true })
      .fill("Revised agenda");
    await editor
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(event(pb, title + " revised")).toBeVisible({ timeout: 12000 });
    let card = await details(pb, title + " revised");
    await expect(
      card.getByText("Revised agenda", { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Edit meeting", exact: true }),
    ).toHaveCount(0);
    await pb.keyboard.press("Escape");
    let edit = await openEditor(pa, title + " revised");
    await edit.getByRole("button", {name:"Remove Calendar attendee",exact:true}).click();
    await edit
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    await expect(event(pb, title + " revised")).toHaveCount(0, {
      timeout: 12000,
    });
    expect(
      (await b.request.get(`${base}/meetings/${made.id}/details`)).status(),
    ).toBe(404);
    edit = await openEditor(pa, title + " revised");
    await edit.getByRole("combobox",{name:"Add attendees",exact:true}).fill("Calendar attendee");
    await pa.getByRole("option").filter({hasText:"Calendar attendee"}).click();
    await edit
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(edit).toHaveCount(0);
    await expect(event(pb, title + " revised")).toBeVisible({ timeout: 12000 });
    card = await details(pb, title + " revised");
    await expect(card.getByLabel("RSVP", { exact: true })).toHaveValue(
      "pending",
    );
    await pb.keyboard.press("Escape");
    await a.request.patch(`${base}/meetings/${made.id}`, {
      headers,
      data: { cancelled: true },
    });
    await expect(event(pb, title + " revised")).toHaveClass(/cancelled/, {
      timeout: 12000,
    });
  } finally {
    await a.close();
    await b.close();
  }
});
test("visible calendar range paginates beyond fifty meetings and recovers from a failed page", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const db = new pg.Pool({
        connectionString:
          "postgres://concord:local-development-only@localhost:55432/concord",
      }),
      ids = Array.from({ length: 53 }, () => randomUUID());
    try {
      await db.query(
        "INSERT INTO meetings(id,org_id,title,starts_at,ends_at,timezone,organizer_id) SELECT id,$2,'Paged meeting','2033-06-04T10:00:00Z','2033-06-04T11:00:00Z','UTC',$3 FROM unnest($1::uuid[]) id",
        [ids, org, owner],
      );
    } finally {
      await db.end();
    }
    const p = await c.newPage();
    await calendar(p, "2033-06-04");
    await expect(
      p.locator(".calendar-time-scroll .calendar-event"),
    ).toHaveCount(50);
    await p.route("**/meetings?**afterStart**", (r) => r.abort());
    await p
      .getByRole("button", {
        name: "Load more meetings in this range",
        exact: true,
      })
      .click();
    await expect(
      p.getByRole("button", { name: "Retry calendar", exact: true }),
    ).toBeVisible();
    await p.unroute("**/meetings?**afterStart**");
    await p
      .getByRole("button", { name: "Retry calendar", exact: true })
      .click();
    await expect(
      p.locator(".calendar-time-scroll .calendar-event"),
    ).toHaveCount(53);
    await p
      .getByText("All meetings in this range (53)", { exact: true })
      .click();
    await expect(
      p.locator(".calendar-range-agenda .calendar-event"),
    ).toHaveCount(53);
    await expect(p.locator(".calendar-time-scroll")).not.toBeVisible();
  } finally {
    await c.close();
  }
});
test("scheduling rejects a DST gap and persists an explicitly chosen repeated-time occurrence", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    await calendar(p, "2034-11-05");
    await p
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    const form = p.getByRole("dialog", {
      name: "Schedule a meeting",
      exact: true,
    });
    await form
      .getByLabel("Meeting title", { exact: true })
      .fill("Clock change validation");
    await form
      .getByLabel("Scheduling timezone", { exact: true })
      .fill("America/New_York");
    await form.getByLabel("Starts", { exact: true }).fill("2034-03-12T02:10");
    await form.getByLabel("Ends", { exact: true }).fill("2034-03-12T03:10");
    await form
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    await expect(form.getByRole("alert")).toContainText("does not exist");
    await form.getByLabel("Starts", { exact: true }).fill("2034-11-05T01:10");
    await form.getByLabel("Ends", { exact: true }).fill("2034-11-05T01:40");
    await form
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    await expect(form.getByRole("alert")).toContainText("occurs twice");
    await form
      .getByLabel("Repeated clock time", { exact: true })
      .selectOption("later");
    const saved = p.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/meetings"),
    );
    await form
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    const id = (await (await saved).json()).id;
    const m = (
      await (await c.request.get(`${base}/meetings/${id}/details`)).json()
    ).meeting;
    expect(m.starts_at).toBe("2034-11-05T06:10:00.000Z");
  } finally {
    await c.close();
  }
});
test("weekly series retains local time across DST and edits or cancels all occurrences", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const title = `Weekly series ${randomUUID()}`,
      made = await create(c, title, {
        startsAt: "2034-03-05T15:00:00Z",
        endsAt: "2034-03-05T16:00:00Z",
        timezone: "America/New_York",
        clientId: randomUUID(),
        recurrence: { frequency: "weekly", interval: 1, count: 3 },
      }),
      p = await c.newPage();
    await calendar(p, "2034-03-05");
    const editor = await openEditor(p, title);
    await editor
      .getByLabel("Edit scope", { exact: true })
      .selectOption("series");
    await editor
      .getByLabel("Description", { exact: true })
      .fill("Whole series agenda");
    await editor
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    const rows = (
      await (
        await c.request.get(
          `${base}/meetings?from=2034-03-01T00:00:00Z&to=2034-04-01T00:00:00Z`,
        )
      ).json()
    ).meetings.filter(
      (m: { series_id: string }) => m.series_id === made.seriesId,
    );
    expect(rows.map((m: { starts_at: string }) => m.starts_at)).toEqual([
      "2034-03-05T15:00:00.000Z",
      "2034-03-12T14:00:00.000Z",
      "2034-03-19T14:00:00.000Z",
    ]);
    expect(
      rows.every(
        (m: { description: string }) => m.description === "Whole series agenda",
      ),
    ).toBe(true);
    const card = await details(p, title);
    await card
      .getByRole("button", { name: "Cancel series", exact: true })
      .click();
    await expect(event(p, title)).toHaveClass(/cancelled/);
  } finally {
    await c.close();
  }
});
test("monthly last-day series expands without changing old IDs and reschedules with yearly rules", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const title = `Monthly series ${randomUUID()}`,
      made = await create(c, title, {
        startsAt: "2034-01-31T10:00:00Z",
        endsAt: "2034-01-31T11:00:00Z",
        clientId: randomUUID(),
        recurrence: {
          frequency: "monthly",
          interval: 1,
          count: 4,
          monthDayPolicy: "constrain",
        },
      }),
      p = await c.newPage();
    await calendar(p, "2034-01-31");
    const card = await details(p, title);
    await card
      .getByRole("button", { name: "Reschedule series", exact: true })
      .click();
    const form = p.getByRole("dialog", {
      name: "Reschedule series",
      exact: true,
    });
    await form
      .getByLabel("Total series occurrences", { exact: true })
      .fill("6");
    await form
      .getByRole("button", { name: "Preview occurrences", exact: true })
      .click();
    await expect(
      form.getByRole("region", { name: "Recurrence preview" }).locator("li"),
    ).toHaveCount(6);
    await form
      .getByRole("button", { name: "Save series schedule", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    const rows = (
      await (
        await c.request.get(
          `${base}/meetings?from=2034-01-01T00:00:00Z&to=2035-01-01T00:00:00Z`,
        )
      ).json()
    ).meetings.filter(
      (m: { series_id: string }) => m.series_id === made.seriesId,
    );
    expect(rows.slice(0, 4).map((m: { id: string }) => m.id)).toEqual(
      made.occurrenceIds,
    );
    expect(
      rows.map((m: { starts_at: string }) => m.starts_at.slice(0, 10)),
    ).toEqual([
      "2034-01-31",
      "2034-02-28",
      "2034-03-31",
      "2034-04-30",
      "2034-05-31",
      "2034-06-30",
    ]);
    await (
      await details(p, title)
    )
      .getByRole("button", { name: "Reschedule series", exact: true })
      .click();
    await expect(
      form.getByLabel("Missing month date", { exact: true }),
    ).toHaveValue("constrain");
    await form
      .getByLabel("Series frequency", { exact: true })
      .selectOption("yearly");
    await form
      .getByRole("button", { name: "Save series schedule", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    expect(
      (await (await c.request.get(`${base}/meetings/${made.id}/series`)).json())
        .frequency,
    ).toBe("yearly");
  } finally {
    await c.close();
  }
});
test("upcoming-only edits preserve past occurrence descriptions and invitees", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const now = Date.now(),
      title = `Upcoming series ${randomUUID()}`,
      made = await create(c, title, {
        startsAt: new Date(now - 36 * 3600000).toISOString(),
        endsAt: new Date(now - 35 * 3600000).toISOString(),
        clientId: randomUUID(),
        recurrence: { frequency: "daily", interval: 1, count: 4 },
      }),
      p = await c.newPage();
    await calendar(p, new Date(now).toISOString().slice(0, 10), "week");
    const editor = await openEditor(p, title);
    await editor
      .getByLabel("Edit scope", { exact: true })
      .selectOption("future");
    await editor
      .getByLabel("Description", { exact: true })
      .fill("Future only agenda");
    await editor.getByRole("button", {name:"Remove Calendar attendee",exact:true}).click();
    await editor
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    const rows = (
      await (
        await c.request.get(
          `${base}/meetings?from=${encodeURIComponent(new Date(now - 3 * 86400000).toISOString())}&to=${encodeURIComponent(new Date(now + 3 * 86400000).toISOString())}`,
        )
      ).json()
    ).meetings.filter(
      (m: { series_id: string }) => m.series_id === made.seriesId,
    );
    expect(
      rows
        .slice(0, 2)
        .every(
          (m: { description: string; attendee_ids: string[] }) =>
            m.description === "" && m.attendee_ids.includes(attendee),
        ),
    ).toBe(true);
    expect(
      rows
        .slice(2)
        .every(
          (m: { description: string; attendee_ids: string[] }) =>
            m.description === "Future only agenda" &&
            !m.attendee_ids.includes(attendee),
        ),
    ).toBe(true);
  } finally {
    await c.close();
  }
});
test("personal reminders survive reload and dismissal synchronizes across windows", async ({
  browser,
}) => {
  test.setTimeout(45000);
  const c = await browser.newContext();
  try {
    await login(c);
    const title = `Reminder ${randomUUID()}`,
      now = Date.now();
    const prefs = await (
      await c.request.get(`${api}/notification-settings`)
    ).json();
    await c.request.put(`${api}/notification-settings`, {
      headers,
      data: { ...prefs, quiet_enabled: false },
    });
    const made = await create(c, title, {
        startsAt: new Date(now + 10 * 60000).toISOString(),
        endsAt: new Date(now + 20 * 60000).toISOString(),
        attendees: [],
      }),
      p = await c.newPage();
    await calendar(p, new Date(now).toISOString().slice(0, 10));
    await (
      await details(p, title)
    )
      .getByLabel("In-app reminder", { exact: true })
      .selectOption("15");
    await expect(
      p.getByRole("region", { name: "Meeting reminders" }),
    ).toContainText(title, { timeout: 15000 });
    await p.reload();
    await expect(
      p.getByRole("region", { name: "Meeting reminders" }),
    ).toContainText(title);
    await p.getByRole("button", { name: "Calendar", exact: true }).click();
    await p.getByLabel("Calendar view", { exact: true }).selectOption("day");
    await expect(
      (await details(p, title)).getByLabel("In-app reminder", { exact: true }),
    ).toHaveValue("15");
    await p.keyboard.press("Escape");
    const second = await c.newPage();
    await second.goto(`/?org=${org}`);
    const other = second.getByRole("region", { name: "Meeting reminders" });
    await expect(other).toContainText(title);
    await other
      .getByRole("button", { name: "Dismiss reminder", exact: true })
      .click();
    await expect(other).toHaveCount(0);
    await expect(
      p.getByRole("region", { name: "Meeting reminders" }),
    ).toHaveCount(0, { timeout: 15000 });
    expect(
      (
        await (await c.request.get(`${base}/meeting-reminders`)).json()
      ).items.some((m: { id: string }) => m.id === made.id),
    ).toBe(false);
  } finally {
    await c.close();
  }
});
