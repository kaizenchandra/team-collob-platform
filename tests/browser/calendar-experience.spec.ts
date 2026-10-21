import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
const api = "http://localhost:4100/v1",
  org = randomUUID(),
  otherOrg = randomUUID(),
  team = randomUUID(),
  headers = { origin: "http://localhost:3101" };
const users = ["Owner", "Member", "Uninvited", "Other workspace"].map(
  (name, i) => ({
    id: randomUUID(),
    email: `calendar-${i}-${org}@example.test`,
    name,
    org: i === 3 ? otherOrg : org,
    role: i === 0 || i === 3 ? "owner" : "member",
  }),
);
test.beforeAll(async () => {
  const db = new pg.Pool({
    connectionString:
      "postgres://concord:local-development-only@localhost:55432/concord",
  });
  try {
    for (const id of [org, otherOrg])
      await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
        id,
        `Calendar verification ${id}`,
      ]);
    for (const u of users) {
      await db.query(
        "INSERT INTO users(id,email,name,password_hash) SELECT $1,$2,$3,password_hash FROM users WHERE email=$4",
        [u.id, u.email, u.name, "alice@acme.test"],
      );
      await db.query(
        "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,$3)",
        [u.org, u.id, u.role],
      );
    }
    await db.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,$3)", [
      team,
      org,
      "Calendar team",
    ]);
    for (const u of users.slice(0, 2))
      await db.query(
        "INSERT INTO team_members(org_id,team_id,user_id) VALUES($1,$2,$3)",
        [org, team, u.id],
      );
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
    await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
      users.map((u) => u.id),
    ]);
    await db.query(
      "UPDATE memberships SET active=false WHERE org_id=ANY($1::uuid[])",
      [[org, otherOrg]],
    );
  } finally {
    await db.end();
  }
});
async function login(c: BrowserContext, i: number) {
  const r = await c.request.post(`${api}/session`, {
    headers,
    data: { email: users[i].email, password: "Development123!" },
  });
  expect(r.status(), await r.text()).toBe(200);
}
const base = `${api}/organizations/${org}`;
const date = "2034-06-21";
async function create(c: BrowserContext, patch: Record<string, unknown> = {}) {
  const r = await c.request.post(`${base}/meetings`, {
    headers,
    data: {
      title: "Planning conversation",
      description: "Review milestones <script>never executes</script>",
      startsAt: `${date}T09:00:00Z`,
      endsAt: `${date}T10:00:00Z`,
      timezone: "UTC",
      attendees: [users[1].id],
      ...patch,
    },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()).id as string;
}
test("calendar source data, privacy, approvals, availability and recurring occurrences", async ({
  browser,
}) => {
  const contexts = await Promise.all(users.map(() => browser.newContext()));
  try {
    for (let i = 0; i < contexts.length; i++) await login(contexts[i], i);
    const [a, b, c, d] = contexts;
    const id = await create(a);
    expect(
      (
        await c.request.post(`${base}/calendar/availability`, {
          headers,
          data: {
            startsAt: `${date}T09:00:00Z`,
            endsAt: `${date}T10:00:00Z`,
            userIds: [users[1].id],
            excludeMeeting: id,
          },
        })
      ).status(),
    ).toBe(404);
    const clientId = randomUUID();
    const repeated = await Promise.all([
      create(a, { title: "Deduplicated invitation", clientId }),
      create(a, { title: "Deduplicated invitation", clientId }),
    ]);
    expect(repeated[0]).toBe(repeated[1]);
    const changed = await a.request.post(`${base}/meetings`, {
      headers,
      data: {
        title: "Changed retry",
        startsAt: `${date}T09:00:00Z`,
        endsAt: `${date}T10:00:00Z`,
        timezone: "UTC",
        attendees: [],
        clientId,
      },
    });
    expect(changed.status()).toBe(409);

    expect(
      (await c.request.get(`${base}/meetings/${id}/details`)).status(),
    ).toBe(404);
    expect((await d.request.get(`${base}/calendar/settings`)).status()).toBe(
      404,
    );
    expect(
      (
        await c.request.post(`${base}/meetings/${id}/call`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await b.request.post(`${base}/calendar/holidays`, {
          headers,
          data: {
            title: "Unauthorized holiday",
            day: date,
            calendar: "Company",
          },
        })
      ).status(),
    ).toBe(403);
    const settings = await b.request.put(`${base}/calendar/settings`, {
      headers,
      data: {
        timezone: "UTC",
        days: [{ day: 3, start: "09:00", end: "17:00" }],
        holidayCalendar: "Regional office",
      },
    });
    expect(settings.status()).toBe(200);
    const holiday = await a.request.post(`${base}/calendar/holidays`, {
      headers,
      data: {
        title: "Regional observance",
        day: date,
        calendar: "Regional office",
      },
    });
    expect(holiday.status()).toBe(200);
    const leave = await b.request.post(`${base}/calendar/leave`, {
      headers,
      data: { allDay: true, firstDay: date, lastDay: date },
    });
    const leaveId = (await leave.json()).id;
    expect(
      (
        await b.request.patch(`${base}/calendar/leave/${leaveId}`, {
          headers,
          data: { status: "approved" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await a.request.patch(`${base}/calendar/leave/${leaveId}`, {
          headers,
          data: { status: "approved" },
        })
      ).status(),
    ).toBe(200);
    const blocks = await (
      await b.request.get(
        `${base}/calendar/blocks?from=2034-06-21T00:00:00Z&to=2034-06-22T00:00:00Z`,
      )
    ).json();
    expect(blocks.holidays[0].day).toBe(date);
    expect(blocks.leave[0].status).toBe("approved");
    const ownerBlocks = await (
      await a.request.get(
        `${base}/calendar/blocks?from=2034-06-21T00:00:00Z&to=2034-06-22T00:00:00Z`,
      )
    ).json();
    expect(ownerBlocks.holidays).toEqual([]);
    expect(ownerBlocks.leave).toEqual([]);
    const employee = await b.newPage();
    await employee.goto(`/?org=${org}`);
    await employee
      .getByRole("button", { name: "Calendar", exact: true })
      .click();
    await employee.getByLabel("Calendar date", { exact: true }).fill(date);
    await employee
      .getByLabel("Calendar view", { exact: true })
      .selectOption("day");
    await expect(
      employee.locator(".calendar-time-header .calendar-holiday"),
    ).toContainText("Regional observance");
    await expect(
      employee.locator(".calendar-time-header .calendar-leave"),
    ).toContainText("Leave");
    await expect(employee.locator(".calendar-work-label")).toContainText(
      "09:00–17:00",
    );
    await employee.screenshot({
      path: "docs/evidence/calendar-leave-approved.png",
    });
    await employee.close();

    const availability = await (
      await c.request.post(`${base}/calendar/availability`, {
        headers,
        data: {
          startsAt: `${date}T09:00:00Z`,
          endsAt: `${date}T10:00:00Z`,
          userIds: [users[1].id, users[3].id],
        },
      })
    ).json();
    expect(availability.availability[0].reasons).toEqual([
      "Busy",
      "Unavailable",
      "Holiday",
    ]);
    expect(availability.availability[1].status).toBe("unknown");
    expect(JSON.stringify(availability)).not.toContain("Planning conversation");
    expect(JSON.stringify(availability)).not.toContain(id);
    const series = await create(a, {
      title: "DST recurring team meeting",
      teamId: team,
      startsAt: "2034-03-05T15:00:00Z",
      endsAt: "2034-03-05T16:00:00Z",
      timezone: "America/New_York",
      clientId: randomUUID(),
      recurrence: { frequency: "weekly", interval: 1, count: 3 },
    });
    const detail = await (
      await b.request.get(`${base}/meetings/${series}/details`)
    ).json();
    expect(detail.participants).toHaveLength(2);
    const rows = await (
      await b.request.get(
        `${base}/meetings?from=2034-03-01T00:00:00Z&to=2034-04-01T00:00:00Z`,
      )
    ).json();
    expect(
      rows.meetings.filter(
        (m: { title: string }) => m.title === "DST recurring team meeting",
      ),
    ).toHaveLength(3);
    expect(
      (
        await b.request.patch(`${base}/calendar/leave/${leaveId}`, {
          headers,
          data: { status: "cancelled" },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await a.request.patch(`${base}/calendar/leave/${leaveId}`, {
          headers,
          data: { status: "approved" },
        })
      ).status(),
    ).toBe(409);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
test("calendar views, overlapping events, interactive details, scheduling, settings and responsive layout", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const c = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await login(c, 0);
  const p = await c.newPage();
  try {
    for (let i = 0; i < 5; i++)
      await create(c, {
        title: `Calendar design ${i}`,
        teamId: i === 0 ? team : undefined,
      });
    await c.request.post(`${base}/calendar/holidays`, {
      headers,
      data: { title: "Company holiday", day: date, calendar: "Company" },
    });
    const leave = await (
      await c.request.post(`${base}/calendar/leave`, {
        headers,
        data: {
          allDay: false,
          startsAt: `${date}T12:00:00Z`,
          endsAt: `${date}T14:00:00Z`,
        },
      })
    ).json();
    await c.request.patch(`${base}/calendar/leave/${leave.id}`, {
      headers,
      data: { status: "approved" },
    });
    await p.goto(`/?org=${org}`);
    await p.getByRole("button", { name: "Calendar", exact: true }).click();
    await p.getByLabel("Calendar date", { exact: true }).fill(date);
    await p.getByLabel("Calendar view", { exact: true }).selectOption("day");
    const events = p
      .locator(".calendar-time-scroll .calendar-event")
      .filter({ hasText: "Calendar design" });
    await expect(events).toHaveCount(5);
    await expect
      .poll(() =>
        p
          .locator(".main")
          .evaluate((e) => e.scrollHeight <= e.clientHeight + 1),
      )
      .toBe(true);
    await expect(p.locator(".calendar-leave-time")).toHaveCSS("top", "720px");
    await expect(p.locator(".calendar-leave-time")).toHaveCSS(
      "height",
      "120px",
    );
    const boxes = await events.evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.x, right: r.right };
      }),
    );
    expect(new Set(boxes.map((x) => x.x)).size).toBe(5);
    await expect(
      p.getByText("Company holiday", { exact: false }).first(),
    ).toBeVisible();
    await events.filter({ hasText: "Calendar design 0" }).hover();
    const dialog = p.getByRole("dialog", { name: /Calendar design 0/ });
    await expect(dialog).toBeVisible();
    await dialog.hover();
    await expect(
      dialog.getByText("Review milestones <script>never executes</script>", {
        exact: true,
      }),
    ).toBeVisible();
    await dialog.getByText("2 participants", { exact: true }).click();
    await expect(dialog.getByText("Member · pending")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Join meeting", exact: true }),
    ).toBeDisabled();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    await p.screenshot({ path: "docs/evidence/calendar-details-desktop.png" });
    await p.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await events.filter({ hasText: "Calendar design 0" }).click();
    await p.getByRole("button", { name: "Edit meeting", exact: true }).click();
    const editor = p.getByRole("dialog", { name: "Edit meeting", exact: true });
    await editor
      .getByLabel("Meeting title", { exact: true })
      .fill("Calendar design revised");
    await editor
      .getByRole("button", { name: "Save meeting changes", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(
      p
        .locator(".calendar-time-scroll .calendar-event")
        .filter({ hasText: "Calendar design revised" }),
    ).toHaveCount(1);
    const total = await p
      .locator(".calendar-time-scroll .calendar-event")
      .count();
    await p.getByLabel("Calendar view", { exact: true }).selectOption("month");
    await expect(
      p.getByRole("button", { name: /more events/ }).first(),
    ).toBeVisible();
    await p.screenshot({ path: "docs/evidence/calendar-month-desktop.png" });
    await p
      .getByRole("button", { name: /more events/ })
      .first()
      .click();
    await expect(p.locator(".calendar-month .calendar-event")).toHaveCount(
      total,
    );
    await p
      .getByRole("button", { name: "Hours & availability", exact: true })
      .click();
    const settings = p.getByRole("dialog", {
      name: "Hours & availability",
      exact: true,
    });
    await settings
      .getByLabel("Working timezone", { exact: true })
      .fill("Asia/Kolkata");
    await settings
      .getByRole("button", { name: "Save working hours", exact: true })
      .click();
    await expect(
      settings.getByText("Working hours saved.", { exact: true }),
    ).toBeVisible();
    await p.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(p.locator(".calendar-legend")).toContainText("Asia/Kolkata");
    await p.getByLabel("Calendar view", { exact: true }).selectOption("week");
    await p
      .getByRole("button", {
        name: "Schedule 2034-06-21 11:00 Asia/Kolkata",
        exact: true,
      })
      .click();
    const form = p.getByRole("dialog", {
      name: "Schedule a meeting",
      exact: true,
    });
    await expect(form.getByLabel("Starts", { exact: true })).toHaveValue(
      "2034-06-21T11:00",
    );
    await form
      .getByLabel("Meeting title", { exact: true })
      .fill("Selected time meeting");
    await form
      .getByLabel("Meeting agenda", { exact: true })
      .fill("Calendar slot agenda");
    await form
      .getByRole("button", { name: "Schedule meeting", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    for (const [width, height] of [
      [1366, 768],
      [834, 1194],
      [390, 844],
    ]) {
      await p.setViewportSize({ width, height });
      await expect
        .poll(() =>
          p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        )
        .toBe(true);
      await p.screenshot({
        path: `docs/evidence/calendar-${width}x${height}.png`,
      });
    }
    await expect(p.locator(".calendar-mobile-agenda")).toBeVisible();
    const touchEvent = p
      .locator(".calendar-mobile-agenda .calendar-event")
      .first();
    await touchEvent.click();
    const mobileDetails = p.locator(".profile-popover");
    await expect(mobileDetails).toBeVisible();
    await mobileDetails
      .getByRole("button", { name: "Join meeting", exact: true })
      .scrollIntoViewIfNeeded();
    const mobileBox = await mobileDetails.boundingBox();
    expect(mobileBox!.x + mobileBox!.width).toBeLessThanOrEqual(390);
    expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);
    await p.screenshot({ path: "docs/evidence/calendar-details-mobile.png" });
    await p.keyboard.press("Escape");
    await expect(mobileDetails).toHaveCount(0);
    await touchEvent.focus();
    await touchEvent.press("Enter");
    await expect(mobileDetails).toBeVisible();
    await p
      .getByRole("heading", { name: "Your calendar", exact: true })
      .click();
    await expect(mobileDetails).toHaveCount(0);

    await p.getByRole("button", { name: "Calls", exact: true }).click();
    await p.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(p.getByLabel("Calendar date", { exact: true })).toHaveValue(
      date,
    );
    await expect(p.getByLabel("Calendar view", { exact: true })).toHaveValue(
      "week",
    );
  } finally {
    await c.close();
  }
});
test("calendar Join resolves one live room, preserves the session and enforces termination and roster access", async () => {
  test.setTimeout(100000);
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--host-resolver-rules=MAP localhost 127.0.0.1",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-swiftshader",
    ],
  });
  const cs = await Promise.all(
    [0, 1, 2].map(() =>
      browser.newContext({
        permissions: ["camera", "microphone"],
        viewport: { width: 1366, height: 768 },
      }),
    ),
  );
  let call = "";
  try {
    for (let i = 0; i < 3; i++) await login(cs[i], i);
    const now = Date.now(),
      id = await create(cs[0], {
        title: "Join live calendar meeting",
        startsAt: new Date(now - 60000).toISOString(),
        endsAt: new Date(now + 3600000).toISOString(),
      });
    // Older calendar records can have an implicit organizer without an attendee row.
    const legacyDb = new pg.Pool({
      connectionString:
        "postgres://concord:local-development-only@localhost:55432/concord",
    });
    try {
      await legacyDb.query(
        "DELETE FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2",
        [id, users[0].id],
      );
    } finally {
      await legacyDb.end();
    }
    const opens = await Promise.all(
      cs
        .slice(0, 2)
        .map((c) =>
          c.request.post(`${base}/meetings/${id}/call`, { headers, data: {} }),
        ),
    );
    const targets = await Promise.all(
      opens.map(async (r) => {
        expect(r.status(), await r.text()).toBe(200);
        return r.json();
      }),
    );
    expect(targets[0].id).toBe(targets[1].id);
    call = targets[0].id;
    const cleanupDb = new pg.Pool({
      connectionString:
        "postgres://concord:local-development-only@localhost:55432/concord",
    });
    try {
      await cleanupDb.query(
        "UPDATE media_calls SET created_at=now()-interval '3 minutes' WHERE id=$1",
        [call],
      );
    } finally {
      await cleanupDb.end();
    }
    // Observe a full reconciliation interval: unused device setup must not consume the meeting.
    await new Promise((resolve) => setTimeout(resolve, 6500));
    const prepared = await cs[0].request.post(`${base}/meetings/${id}/call`, {
      headers,
      data: {},
    });
    expect(prepared.status(), await prepared.text()).toBe(200);
    expect((await prepared.json()).id).toBe(call);

    const pages = await Promise.all(cs.slice(0, 2).map((c) => c.newPage()));
    for (const p of pages) {
      await p.goto(`/?org=${org}`);
      await p.getByRole("button", { name: "Calendar", exact: true }).click();
      await p.getByLabel("Calendar view", { exact: true }).selectOption("day");
      const event = p
        .locator(".calendar-time-scroll .calendar-event")
        .filter({ hasText: "Join live calendar meeting" });
      await event.click();
      await p
        .getByRole("button", { name: "Join meeting", exact: true })
        .click();
      await p
        .getByRole("checkbox", { name: "Enable camera when joining" })
        .check();
      await p.getByRole("button", { name: "Join call", exact: true }).click();
      await expect(
        p.getByRole("toolbar", { name: "Call controls" }),
      ).toBeVisible();
    }
    for (const p of pages)
      await expect
        .poll(() =>
          p
            .locator("video")
            .evaluateAll(
              (nodes) =>
                nodes.filter((v) => (v as HTMLVideoElement).videoWidth > 0)
                  .length,
            ),
        )
        .toBeGreaterThanOrEqual(2);
    for (const p of pages)
      await expect
        .poll(() =>
          p.locator("audio").evaluateAll(
            (nodes) =>
              nodes.filter((n) => {
                const a = n as HTMLAudioElement;
                return (
                  a.srcObject instanceof MediaStream &&
                  a.srcObject
                    .getAudioTracks()
                    .some((t) => t.readyState === "live") &&
                  !a.paused &&
                  a.currentTime > 0
                );
              }).length,
          ),
        )
        .toBeGreaterThanOrEqual(1);
    const grants = await (
      await cs[0].request.get(`${base}/calls/${call}`)
    ).json();
    expect(grants.participants).toHaveLength(2);
    await pages[0]
      .getByRole("button", { name: "Calendar", exact: true })
      .click();
    await pages[0]
      .locator(".calendar-time-scroll .calendar-event")
      .filter({ hasText: "Join live calendar meeting" })
      .click();
    await pages[0]
      .getByRole("button", { name: "Join meeting", exact: true })
      .click();
    await expect(
      pages[0].getByRole("toolbar", { name: "Call controls" }),
    ).toBeVisible();
    expect(
      (
        await (await cs[0].request.get(`${base}/calls/${call}`)).json()
      ).participants.map((g: { id: string }) => g.id),
    ).toEqual(grants.participants.map((g: { id: string }) => g.id));
    expect(
      (
        await cs[2].request.post(`${base}/calls/${call}/join`, {
          headers,
          data: { clientId: randomUUID(), recordingConsent: false },
        })
      ).status(),
    ).toBe(404);
    const detail = await cs[0].request.get(`${base}/meetings/${id}/details`);
    const m = (await detail.json()).meeting;
    await cs[0].request.put(`${base}/meetings/${id}/details`, {
      headers,
      data: {
        revision: m.revision,
        title: m.title,
        description: m.description,
        startsAt: m.starts_at,
        endsAt: m.ends_at,
        timezone: m.timezone,
        attendees: [],
      },
    });
    expect((await cs[1].request.get(`${base}/calls/${call}`)).status()).toBe(
      404,
    );
    expect(
      (
        await cs[1].request.post(`${base}/calls/${call}/join`, {
          headers,
          data: { clientId: randomUUID(), recordingConsent: false },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await cs[0].request.post(`${base}/calls/${call}/end`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await cs[0].request.post(`${base}/meetings/${id}/call`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await cs[0].request.post(
          `${base}/channels/${targets[0].channelId}/calls`,
          { headers, data: { clientId: randomUUID(), mode: "video" } },
        )
      ).status(),
    ).toBe(409);
    await expect
      .poll(() =>
        pages[0]
          .locator("video")
          .evaluateAll(
            (nodes) =>
              nodes.filter(
                (v) =>
                  (v as HTMLVideoElement).srcObject &&
                  ((v as HTMLVideoElement).srcObject as MediaStream)
                    .getTracks()
                    .some((t) => t.readyState === "live"),
              ).length,
          ),
      )
      .toBe(0);
  } finally {
    if (call)
      await cs[0].request
        .post(`${base}/calls/${call}/end`, { headers, data: {} })
        .catch(() => {});
    await browser.close();
  }
});
