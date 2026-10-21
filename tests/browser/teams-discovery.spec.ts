import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
const api = "http://localhost:4100/v1",
  org = randomUUID(),
  emptyOrg = randomUUID(),
  headers = { origin: "http://localhost:3101" },
  base = `${api}/organizations/${org}`;
const users = ["owner", "member", "guest"].map((role) => ({
  id: randomUUID(),
  name: `Discovery ${role}`,
  role,
  email: `discovery-${role}-${org}@example.test`,
}));
const teams = Array.from({ length: 18 }, (_, i) => ({
  id: randomUUID(),
  name:
    i === 0
      ? "Design systems"
      : i === 1
        ? "Product & Engineering"
        : i === 2
          ? "International Customer Experience and Engineering Collaboration — Long Team Name"
          : i === 3
            ? "Legacy research"
            : `Workspace team ${String(i).padStart(2, "0")}`,
  archived: i === 3,
}));
const channel = randomUUID(),
  privateChannel = randomUUID();
const db = new pg.Pool({
  connectionString:
    "postgres://concord:local-development-only@localhost:55432/concord",
});
test.beforeAll(async () => {
  for (const id of [org, emptyOrg])
    await db.query("INSERT INTO organizations(id,name) VALUES($1,$2)", [
      id,
      id === org ? "Team discovery verification" : "Empty discovery workspace",
    ]);
  for (const u of users) {
    await db.query(
      "INSERT INTO users(id,name,email,password_hash) SELECT $1,$2,$3,password_hash FROM users WHERE email=$4",
      [u.id, u.name, u.email, "alice@acme.test"],
    );
    for (const id of [org, emptyOrg])
      await db.query(
        "INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,$3)",
        [id, u.id, u.role],
      );
  }
  for (const [i, t] of teams.entries()) {
    await db.query(
      "INSERT INTO teams(id,org_id,name,archived) VALUES($1,$2,$3,$4)",
      [t.id, org, t.name, t.archived],
    );
    await db.query(
      "INSERT INTO team_members(org_id,team_id,user_id,role) VALUES($1,$2,$3,'owner')",
      [org, t.id, users[i < 2 ? 0 : 1].id],
    );
  }
  for (const u of users.slice(1))
    await db.query(
      "INSERT INTO team_members(org_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
      [org, teams[1].id, u.id],
    );
  await db.query(
    "INSERT INTO channels(id,org_id,team_id,name,kind) VALUES($1,$2,$3,'Product updates','standard')",
    [channel, org, teams[1].id],
  );
  await db.query(
    "INSERT INTO channels(id,org_id,team_id,name,kind) VALUES($1,$2,$3,'Design planning','private')",
    [privateChannel, org, teams[0].id],
  );
  await db.query(
    "INSERT INTO channel_members(org_id,channel_id,user_id) VALUES($1,$2,$3)",
    [org, privateChannel, users[0].id],
  );
});
test.afterAll(async () => {
  await db.query("UPDATE users SET disabled=true WHERE id=ANY($1::uuid[])", [
    users.map((u) => u.id),
  ]);
  await db.query(
    "UPDATE memberships SET active=false WHERE org_id=ANY($1::uuid[])",
    [[org, emptyOrg]],
  );
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
async function open(p: Page, workspace = org) {
  const ready = p.waitForResponse(
    (r) =>
      r.url().includes(`/organizations/${workspace}/bootstrap`) &&
      r.status() === 200,
  );
  await p.goto(`/?org=${workspace}`);
  const bootstrap = await (await ready).json();
  await expect(p.locator(".sidebar .team-title")).toHaveCount(
    bootstrap.teams.length,
  );
  await p.getByRole("button", { name: "Teams", exact: true }).click();
  await expect(
    p.getByRole("heading", { name: "Discover your teams" }),
  ).toBeVisible();
}
function card(p: Page, name: string) {
  return p
    .locator(".team-discovery-card")
    .filter({ has: p.getByRole("heading", { name, exact: true }) });
}
test("discovery search, filters, paging, archived separation, management and responsive layouts", async ({
  browser,
}) => {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await login(c);
    const p = await c.newPage();
    await open(p);
    const area = p.locator(".teams-discovery");
    await expect(area.locator(".team-discovery-card")).toHaveCount(12);
    await expect(card(p, "Legacy research")).toHaveCount(0);
    await expect(
      area.getByText("17 teams · Page 1 of 2", { exact: true }),
    ).toBeVisible();
    await area.getByRole("button", { name: "Next teams" }).click();
    await expect(area.locator(".team-discovery-card")).toHaveCount(5);
    await area.getByRole("button", { name: "Previous teams" }).click();
    await area.getByRole("button", { name: /^My teams/ }).click();
    await expect(area.locator(".team-discovery-card")).toHaveCount(2);
    await area.getByRole("button", { name: /^Discover\s/ }).click();
    await expect(card(p, "Design systems")).toHaveCount(0);
    await area.getByRole("button", { name: /^All teams/ }).click();
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("  engineering ");
    await expect(area.locator(".team-discovery-card")).toHaveCount(2);
    await expect(card(p, teams[2].name)).toBeVisible();
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("no such team");
    await expect(
      area.getByRole("heading", { name: "No teams match your search" }),
    ).toBeVisible();
    await area.getByRole("button", { name: "Clear team search" }).click();
    await expect(
      area.getByRole("searchbox", { name: "Search teams" }),
    ).toBeFocused();
    await area.getByRole("button", { name: /^My teams/ }).click();
    const design = card(p, "Design systems");
    await design
      .getByRole("button", { name: "Manage team members", exact: true })
      .click();
    await expect(
      design.getByRole("region", { name: "Team members", exact: true }),
    ).toBeVisible();
    await design
      .getByRole("button", { name: "Manage team ownership", exact: true })
      .click();
    await expect(
      design.getByRole("region", { name: "Team members", exact: true }),
    ).toHaveCount(0);
    await expect(
      design.getByRole("region", { name: "Team ownership", exact: true }),
    ).toBeVisible();
    await design.getByRole("button", { name: "Hide ownership" }).click();
    for (const [width, height] of [
      [1440, 1000],
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
      await p.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(p.locator(".topbar")).toHaveCount(1);
      await p.screenshot({
        path: `docs/evidence/discover-teams-${width}x${height}.png`,
      });
    }
    const axe = await new AxeBuilder({ page: p })
      .include(".teams-discovery")
      .analyze();
    expect(axe.violations).toEqual([]);
    await area.getByRole("button", { name: /^Archived/ }).click();
    await expect(card(p, "Legacy research")).toBeVisible();
    await expect(
      card(p, "Legacy research").getByRole("button", {
        name: "Restore",
        exact: true,
      }),
    ).toBeEnabled();
    await area.getByRole("button", { name: /^My teams/ }).click();
    await card(p, "Product & Engineering")
      .getByRole("button", { name: "Open team", exact: true })
      .click();
    await expect(
      p.getByRole("heading", {
        name: /^Product updates(?: standard)?$/,
        exact: true,
      }),
    ).toBeVisible();
    await p.getByRole("button", { name: "Teams", exact: true }).click();
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Design systems");
    await card(p, "Design systems")
      .getByRole("button", { name: "Open team", exact: true })
      .click();
    await expect(
      p.getByRole("heading", {
        name: /^Design planning(?: private)?$/,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await c.close();
  }
});
test("join/leave have real results, pending locks, recoverable failures and last-owner protection", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c, 1);
    const p = await c.newPage();
    await open(p);
    const area = p.locator(".teams-discovery");
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Design systems");
    const design = card(p, "Design systems");
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    let requests = 0;
    const pattern = `**/teams/${teams[0].id}/join`;
    await p.route(pattern, async (route) => {
      requests++;
      await gate;
      await route.continue();
    });
    await design
      .getByRole("button", { name: "Join team", exact: true })
      .click();
    await expect(
      design.getByRole("button", { name: "Joining…", exact: true }),
    ).toBeDisabled();
    expect(requests).toBe(1);
    resolve();
    await expect(
      design.getByRole("button", { name: "Leave team", exact: true }),
    ).toBeVisible();
    await p.unroute(pattern);
    expect(
      (await (await c.request.get(`${base}/teams`)).json()).teams.find(
        (t: { id: string }) => t.id === teams[0].id,
      ).joined,
    ).toBe(true);
    const leave = `**/teams/${teams[0].id}/leave`;
    await p.route(leave, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Membership temporarily unavailable" }),
      }),
    );
    await design
      .getByRole("button", { name: "Leave team", exact: true })
      .click();
    await expect(design.getByRole("alert")).toContainText(
      "Membership temporarily unavailable",
    );
    await expect(
      design.getByRole("button", { name: "Leave team", exact: true }),
    ).toBeEnabled();
    await p.unroute(leave);
    await design.getByRole("button", { name: "Dismiss error" }).click();
    await design
      .getByRole("button", { name: "Leave team", exact: true })
      .click();
    await expect(
      design.getByRole("button", { name: "Join team", exact: true }),
    ).toBeVisible();
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Workspace team 04");
    const owned = card(p, "Workspace team 04");
    await owned
      .getByRole("button", { name: "Leave team", exact: true })
      .click();
    await expect(owned.getByRole("alert")).toContainText(
      "Transfer team ownership before leaving",
    );
    await expect(
      owned.getByRole("button", { name: "Archive", exact: true }),
    ).toHaveCount(0);
    await open(p);
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Design systems");
    await expect(
      design.getByRole("button", { name: "Join team", exact: true }),
    ).toBeVisible();
  } finally {
    await c.close();
  }
});
test("archive requires explicit confirmation, restores cleanly, guests cannot self-join and creation refreshes the directory", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    g = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
  try {
    await login(a);
    const p = await a.newPage();
    await open(p);
    const area = p.locator(".teams-discovery");
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Design systems");
    const design = card(p, "Design systems");
    await design.getByRole("button", { name: "Archive", exact: true }).click();
    await design.getByRole("button", { name: "Cancel archive" }).click();
    expect(
      (await (await a.request.get(`${base}/teams`)).json()).teams.find(
        (t: { id: string }) => t.id === teams[0].id,
      ).archived,
    ).toBe(false);
    await design.getByRole("button", { name: "Archive", exact: true }).click();
    await design.getByRole("button", { name: "Confirm archive" }).click();
    await expect(design).toHaveCount(0);
    await area.getByRole("button", { name: /^Archived/ }).click();
    await design.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(design).toHaveCount(0);
    await area.getByRole("button", { name: /^All teams/ }).click();
    await expect(design).toBeVisible();
    await area
      .getByRole("button", { name: "Create team", exact: true })
      .click();
    const dialog = p.getByRole("dialog", { name: "Create a team" });
    await expect(dialog).toBeVisible();
    await p.screenshot({ path: "/tmp/discover-create-form.png" });
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("New collaboration team");
    await dialog
      .getByRole("button", { name: "Create team", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await area
      .getByRole("searchbox", { name: "Search teams" })
      .fill("New collaboration team");
    await expect(card(p, "New collaboration team")).toBeVisible();
    await login(g, 2);
    const guest = await g.newPage();
    await open(guest);
    const ga = guest.locator(".teams-discovery");
    await expect(
      ga.getByText("An administrator must add guests to teams.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      ga.getByRole("button", { name: "Create team", exact: true }),
    ).toHaveCount(0);
    await ga
      .getByRole("searchbox", { name: "Search teams" })
      .fill("Design systems");
    await expect(
      card(guest, "Design systems").getByRole("button", {
        name: "Join team",
        exact: true,
      }),
    ).toBeDisabled();
    expect(
      (
        await g.request.post(`${base}/teams/${teams[0].id}/join`, {
          headers,
          data: {},
        })
      ).status(),
    ).toBe(403);
    await ga.getByRole("button", { name: /^My teams/ }).tap();
    await ga.getByRole("button", { name: "Clear team search" }).tap();
    await expect(
      card(guest, "Product & Engineering").getByRole("button", {
        name: "Open team",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await a.close();
    await g.close();
  }
});
test("loading and failure never pretend to be an empty directory; empty workspaces offer a functional entry point", async ({
  browser,
}) => {
  const c = await browser.newContext();
  try {
    await login(c);
    const p = await c.newPage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      pattern = `**/organizations/${org}/teams`;
    await p.route(pattern, async (route) => {
      await gate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Directory temporarily unavailable" }),
      });
    });
    await open(p);
    const area = p.locator(".teams-discovery");
    await expect(area.getByText("Loading your teams…")).toBeVisible();
    await expect(
      area.getByRole("heading", { name: "A space for your next team" }),
    ).toHaveCount(0);
    release();
    await expect(area.getByRole("alert")).toContainText(
      "Directory temporarily unavailable",
    );
    await expect(
      area.getByRole("heading", { name: "A space for your next team" }),
    ).toHaveCount(0);
    await p.unroute(pattern);
    await area.getByRole("button", { name: "Try again" }).click();
    await expect(area.locator(".team-discovery-card")).toHaveCount(12);
    await open(p, emptyOrg);
    await expect(
      area.getByRole("heading", { name: "A space for your next team" }),
    ).toBeVisible();
    await area
      .locator(".teams-empty")
      .getByRole("button", { name: "Create team", exact: true })
      .click();
    await expect(
      p.getByRole("dialog", { name: "Create a team" }),
    ).toBeVisible();
  } finally {
    await c.close();
  }
});
